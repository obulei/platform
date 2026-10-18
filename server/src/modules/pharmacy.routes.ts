import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  medicines,
  patients,
  prescriptionItems,
  prescriptions,
  staff,
  staffRoles,
  stockMovements,
  medicineForm,
  prescriptionStatus,
  stockMovementReason
} from '../db/schema/index.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { money } from '../lib/serialize.js';

type MedicineRow = typeof medicines.$inferSelect;

const PHARMACY_WRITE = [ROLES.admin, ROLES.pharmacist];
const PRESCRIBERS = [ROLES.admin, ROLES.doctor];
const QUEUE_ROLES = [ROLES.admin, ROLES.pharmacist, ROLES.doctor, ROLES.nurse];

const formEnum = z.enum(medicineForm.enumValues);
const reasonEnum = z.enum(stockMovementReason.enumValues);
const statusEnum = z.enum(prescriptionStatus.enumValues);

const idParam = z.object({ id: z.string().uuid() });

const createMedicineSchema = z.object({
  name: z.string().min(1).max(160),
  genericName: z.string().max(160).nullish(),
  form: formEnum,
  strength: z.string().min(1).max(40),
  unit: z.string().min(1).max(24).default('unit'),
  price: z.number().min(0),
  stock: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(0)
});

/**
 * Stock is intentionally absent: a medicine's quantity only ever changes
 * through audited stock movements. `stock` supplied by a client is stripped by
 * this schema and therefore never applied.
 */
const updateMedicineSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  genericName: z.string().max(160).nullable().optional(),
  form: formEnum.optional(),
  strength: z.string().min(1).max(40).optional(),
  unit: z.string().min(1).max(24).optional(),
  price: z.number().min(0).optional(),
  reorderLevel: z.number().int().min(0).optional(),
  isActive: z.boolean().optional()
});

const adjustStockSchema = z.object({
  quantityChange: z.number().int().refine((value) => value !== 0, 'Stock change must be non-zero.'),
  reason: reasonEnum,
  reference: z.string().max(120).nullish(),
  note: z.string().max(500).nullish()
});

const createPrescriptionSchema = z.object({
  patientId: z.string().uuid(),
  admissionId: z.string().uuid().nullish(),
  appointmentId: z.string().uuid().nullish(),
  notes: z.string().max(1000).nullish(),
  items: z
    .array(
      z.object({
        medicineId: z.string().uuid(),
        dosage: z.string().min(1).max(80),
        frequency: z.string().min(1).max(80),
        durationDays: z.number().int().min(1).max(365),
        quantity: z.number().int().min(1),
        instructions: z.string().max(300).nullish()
      })
    )
    .min(1)
    .max(30)
});

const dispenseSchema = z.object({
  items: z
    .array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1) }))
    .min(1)
    .max(30)
});

function toMedicineDto(row: MedicineRow) {
  const stock = Number(row.stock);
  const reorderLevel = Number(row.reorderLevel);
  return {
    id: row.id,
    name: row.name,
    genericName: row.genericName,
    form: row.form,
    strength: row.strength,
    unit: row.unit,
    price: money(row.price),
    stock,
    reorderLevel,
    isActive: row.isActive,
    isLowStock: stock <= reorderLevel
  };
}

export async function pharmacyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  /* ----------------------------- Catalogue reads ----------------------------- */

  app.get('/api/medicines', async (request) => {
    const query = z
      .object({
        q: z.string().max(160).optional(),
        form: formEnum.optional(),
        lowStock: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.q) {
      const term = `%${query.q}%`;
      filters.push(or(ilike(medicines.name, term), ilike(medicines.genericName, term))!);
    }
    if (query.form) filters.push(eq(medicines.form, query.form));
    if (query.lowStock === 'true') {
      filters.push(sql`${medicines.stock} <= ${medicines.reorderLevel}`);
    }
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select()
      .from(medicines)
      .where(where)
      .orderBy(asc(medicines.name))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.select({ total: count() }).from(medicines).where(where);

    return {
      items: rows.map(toMedicineDto),
      total: Number(total),
      offset: query.offset,
      limit: query.limit
    };
  });

  /**
   * Dashboard warning feed: every active medicine at or below its reorder
   * point, worst (most deficient) first.
   */
  app.get('/api/medicines/low-stock', async () => {
    const rows = await db
      .select()
      .from(medicines)
      .where(and(eq(medicines.isActive, true), sql`${medicines.stock} <= ${medicines.reorderLevel}`))
      .orderBy(asc(sql`${medicines.stock} - ${medicines.reorderLevel}`));
    return { items: rows.map(toMedicineDto), total: rows.length };
  });

  app.get('/api/medicines/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const [row] = await db.select().from(medicines).where(eq(medicines.id, id)).limit(1);
    if (!row) throw notFound('Medicine');

    const movements = await db
      .select({
        id: stockMovements.id,
        quantityChange: stockMovements.quantityChange,
        reason: stockMovements.reason,
        reference: stockMovements.reference,
        createdAt: stockMovements.createdAt,
        performedByName: staff.fullName,
        // An account can hold several roles, so the trail shows all of them.
        performedByRole:
          sql<string>`(select string_agg(sr.role::text, ', ') from staff_roles sr where sr.staff_id = ${staff.id})`
      })
      .from(stockMovements)
      .leftJoin(staff, eq(stockMovements.performedBy, staff.id))
      .where(eq(stockMovements.medicineId, id))
      .orderBy(desc(stockMovements.createdAt))
      .limit(20);

    return {
      ...toMedicineDto(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      recentMovements: movements
    };
  });

  /* ----------------------------- Catalogue writes ---------------------------- */

  app.post('/api/medicines', { preHandler: authenticate(PHARMACY_WRITE) }, async (request) => {
    const body = createMedicineSchema.parse(request.body);

    const [row] = await db
      .insert(medicines)
      .values({
        name: body.name,
        genericName: body.genericName ?? null,
        form: body.form,
        strength: body.strength,
        unit: body.unit,
        price: String(body.price),
        stock: body.stock,
        reorderLevel: body.reorderLevel
      })
      .returning();

    // Opening stock is itself a movement so the ledger reconciles to the shelf.
    if (body.stock > 0) {
      await db.insert(stockMovements).values({
        medicineId: row.id,
        quantityChange: body.stock,
        reason: 'purchase',
        reference: 'Opening balance',
        performedBy: request.currentUser!.id
      });
    }

    await audit(request, {
      action: 'medicine.created',
      entity: 'medicine',
      entityId: row.id,
      data: { name: row.name, stock: body.stock, price: body.price }
    });
    return toMedicineDto(row);
  });

  app.patch('/api/medicines/:id', { preHandler: authenticate(PHARMACY_WRITE) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = updateMedicineSchema.parse(request.body);

    const updates: Partial<typeof medicines.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.genericName !== undefined) updates.genericName = body.genericName ?? null;
    if (body.form !== undefined) updates.form = body.form;
    if (body.strength !== undefined) updates.strength = body.strength;
    if (body.unit !== undefined) updates.unit = body.unit;
    if (body.price !== undefined) updates.price = String(body.price);
    if (body.reorderLevel !== undefined) updates.reorderLevel = body.reorderLevel;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const [row] = await db
      .update(medicines)
      .set(updates)
      .where(eq(medicines.id, id))
      .returning();
    if (!row) throw notFound('Medicine');

    await audit(request, {
      action: 'medicine.updated',
      entity: 'medicine',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return toMedicineDto(row);
  });

  /**
   * Adjusts stock through the guarded-update pattern: the decrement/increment
   * and its non-negative guard live in a single statement, so two pharmacists
   * adjusting the same medicine concurrently can never lose an update or drive
   * stock below zero. The movement row is written in the same transaction.
   */
  app.post(
    '/api/medicines/:id/adjust-stock',
    { preHandler: authenticate(PHARMACY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = adjustStockSchema.parse(request.body);

      const [existing] = await db
        .select({ id: medicines.id, name: medicines.name })
        .from(medicines)
        .where(eq(medicines.id, id))
        .limit(1);
      if (!existing) throw notFound('Medicine');

      const change = body.quantityChange;
      const shortfall = Math.abs(change);

      const newStock = await db.transaction(async (tx) => {
        const guards = [eq(medicines.id, id)];
        if (change < 0) guards.push(sql`${medicines.stock} >= ${shortfall}`);

        const [updated] = await tx
          .update(medicines)
          .set({ stock: sql`${medicines.stock} + ${change}`, updatedAt: new Date() })
          .where(and(...guards))
          .returning({ stock: medicines.stock });

        if (!updated) {
          throw conflict(`Insufficient stock for ${existing.name}. Only ${shortfall - 1} or fewer available.`);
        }

        await tx.insert(stockMovements).values({
          medicineId: id,
          quantityChange: change,
          reason: body.reason,
          reference: body.reference ?? null,
          performedBy: request.currentUser!.id
        });

        return Number(updated.stock);
      });

      await audit(request, {
        action: 'medicine.stock_adjusted',
        entity: 'medicine',
        entityId: id,
        data: { quantityChange: change, reason: body.reason, newStock, note: body.note ?? null }
      });
      return { id, stock: newStock };
    }
  );

  /* ------------------------------ Prescriptions ------------------------------ */

  app.get('/api/prescriptions', async (request) => {
    const query = z
      .object({
        status: statusEnum.optional(),
        patientId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.status) filters.push(eq(prescriptions.status, query.status));
    if (query.patientId) filters.push(eq(prescriptions.patientId, query.patientId));
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select({
        id: prescriptions.id,
        patientId: prescriptions.patientId,
        patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
        patientMrn: patients.mrn,
        prescriberName: staff.fullName,
        status: prescriptions.status,
        notes: prescriptions.notes,
        createdAt: prescriptions.createdAt,
        itemCount: sql<number>`(select count(*)::int from prescription_items pi where pi.prescription_id = ${prescriptions.id})`,
        totalQuantity: sql<number>`(select coalesce(sum(pi.quantity), 0)::int from prescription_items pi where pi.prescription_id = ${prescriptions.id})`
      })
      .from(prescriptions)
      .innerJoin(patients, eq(prescriptions.patientId, patients.id))
      .innerJoin(staff, eq(prescriptions.prescriberId, staff.id))
      .where(where)
      .orderBy(desc(prescriptions.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.select({ total: count() }).from(prescriptions).where(where);

    return {
      items: rows.map((row) => ({
        ...row,
        itemCount: Number(row.itemCount),
        totalQuantity: Number(row.totalQuantity)
      })),
      total: Number(total),
      offset: query.offset,
      limit: query.limit
    };
  });

  app.get('/api/prescriptions/:id', async (request) => {
    const { id } = idParam.parse(request.params);

    const [header] = await db
      .select({
        id: prescriptions.id,
        patientId: prescriptions.patientId,
        patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
        patientMrn: patients.mrn,
        prescriberId: prescriptions.prescriberId,
        prescriberName: staff.fullName,
        admissionId: prescriptions.admissionId,
        appointmentId: prescriptions.appointmentId,
        status: prescriptions.status,
        notes: prescriptions.notes,
        createdAt: prescriptions.createdAt,
        updatedAt: prescriptions.updatedAt
      })
      .from(prescriptions)
      .innerJoin(patients, eq(prescriptions.patientId, patients.id))
      .innerJoin(staff, eq(prescriptions.prescriberId, staff.id))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!header) throw notFound('Prescription');

    // Join the live medicine row so the pharmacist sees shortages before dispensing.
    const items = await db
      .select({
        id: prescriptionItems.id,
        medicineId: prescriptionItems.medicineId,
        medicineName: medicines.name,
        genericName: medicines.genericName,
        form: medicines.form,
        strength: medicines.strength,
        unit: medicines.unit,
        dosage: prescriptionItems.dosage,
        frequency: prescriptionItems.frequency,
        durationDays: prescriptionItems.durationDays,
        quantity: prescriptionItems.quantity,
        dispensedQuantity: prescriptionItems.dispensedQuantity,
        instructions: prescriptionItems.instructions,
        currentStock: medicines.stock,
        remaining: sql<number>`${prescriptionItems.quantity} - ${prescriptionItems.dispensedQuantity}`
      })
      .from(prescriptionItems)
      .innerJoin(medicines, eq(prescriptionItems.medicineId, medicines.id))
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(prescriptionItems.createdAt);

    return {
      ...header,
      items: items.map((item) => ({
        ...item,
        currentStock: Number(item.currentStock),
        remaining: Number(item.remaining)
      }))
    };
  });

  app.post('/api/prescriptions', { preHandler: authenticate(PRESCRIBERS) }, async (request) => {
    const body = createPrescriptionSchema.parse(request.body);

    const medicineIds = [...new Set(body.items.map((item) => item.medicineId))];
    const found = await db
      .select({ id: medicines.id, name: medicines.name, isActive: medicines.isActive })
      .from(medicines)
      .where(inArray(medicines.id, medicineIds));
    const byId = new Map(found.map((m) => [m.id, m]));

    const blocked: string[] = [];
    for (const medicineId of medicineIds) {
      const match = byId.get(medicineId);
      if (!match) blocked.push(`unknown medicine (${medicineId})`);
      else if (!match.isActive) blocked.push(`${match.name} (inactive)`);
    }
    if (blocked.length) {
      throw badRequest(`Cannot prescribe: ${blocked.join(', ')}.`);
    }

    const created = await db.transaction(async (tx) => {
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          patientId: body.patientId,
          admissionId: body.admissionId ?? null,
          appointmentId: body.appointmentId ?? null,
          prescriberId: request.currentUser!.id,
          notes: body.notes ?? null
        })
        .returning();

      await tx.insert(prescriptionItems).values(
        body.items.map((item) => ({
          prescriptionId: rx.id,
          medicineId: item.medicineId,
          dosage: item.dosage,
          frequency: item.frequency,
          durationDays: item.durationDays,
          quantity: item.quantity,
          instructions: item.instructions ?? null
        }))
      );
      return rx;
    });

    await audit(request, {
      action: 'prescription.created',
      entity: 'prescription',
      entityId: created.id,
      data: { patientId: created.patientId, itemCount: body.items.length }
    });
    return { id: created.id, status: created.status, itemCount: body.items.length };
  });

  app.post('/api/prescriptions/:id/cancel', { preHandler: authenticate(PRESCRIBERS) }, async (request) => {
    const { id } = idParam.parse(request.params);

    const [existing] = await db
      .select({ id: prescriptions.id, status: prescriptions.status })
      .from(prescriptions)
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!existing) throw notFound('Prescription');
    if (existing.status === 'cancelled') throw badRequest('This prescription is already cancelled.');

    const [{ dispensed }] = await db
      .select({ dispensed: sql<number>`coalesce(sum(${prescriptionItems.dispensedQuantity}), 0)::int` })
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id));
    if (Number(dispensed) > 0) {
      throw badRequest('Dispensed items cannot be cancelled. Use a stock return adjustment instead.');
    }

    const [row] = await db
      .update(prescriptions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(prescriptions.id, id))
      .returning({ id: prescriptions.id, status: prescriptions.status });

    await audit(request, {
      action: 'prescription.cancelled',
      entity: 'prescription',
      entityId: id,
      data: { from: existing.status, to: 'cancelled' }
    });
    return row;
  });

  /**
   * Dispensing is fully atomic: every guarded stock decrement, its matching
   * movement row, and the per-item dispensed-quantity increment run in one
   * transaction. If any medicine is short, the whole dispensing rolls back so
   * stock and the prescription never drift apart.
   */
  app.post(
    '/api/prescriptions/:id/dispense',
    { preHandler: authenticate(PHARMACY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = dispenseSchema.parse(request.body);

      const [rx] = await db
        .select({ id: prescriptions.id, status: prescriptions.status })
        .from(prescriptions)
        .where(eq(prescriptions.id, id))
        .limit(1);
      if (!rx) throw notFound('Prescription');
      if (rx.status === 'cancelled') throw badRequest('A cancelled prescription cannot be dispensed.');

      await db.transaction(async (tx) => {
        for (const line of body.items) {
          const [item] = await tx
            .select({
              id: prescriptionItems.id,
              prescriptionId: prescriptionItems.prescriptionId,
              medicineId: prescriptionItems.medicineId,
              medicineName: medicines.name,
              quantity: prescriptionItems.quantity,
              dispensedQuantity: prescriptionItems.dispensedQuantity
            })
            .from(prescriptionItems)
            .innerJoin(medicines, eq(prescriptionItems.medicineId, medicines.id))
            .where(eq(prescriptionItems.id, line.itemId))
            .limit(1);
          if (!item) throw notFound('Prescription item');
          if (item.prescriptionId !== id) {
            throw badRequest('A dispensed item does not belong to this prescription.');
          }

          const remaining = Number(item.quantity) - Number(item.dispensedQuantity);
          if (line.quantity > remaining) {
            throw badRequest(
              `Cannot dispense ${line.quantity} of ${item.medicineName}; only ${remaining} remaining.`
            );
          }

          // Guarded decrement: stock >= quantity is checked inside the UPDATE.
          const [updated] = await tx
            .update(medicines)
            .set({ stock: sql`${medicines.stock} - ${line.quantity}`, updatedAt: new Date() })
            .where(and(eq(medicines.id, item.medicineId), sql`${medicines.stock} >= ${line.quantity}`))
            .returning({ id: medicines.id });
          if (!updated) {
            throw conflict(`Insufficient stock for ${item.medicineName}.`);
          }

          await tx.insert(stockMovements).values({
            medicineId: item.medicineId,
            quantityChange: -line.quantity,
            reason: 'dispense',
            reference: id,
            performedBy: request.currentUser!.id
          });

          // Increment dispensed quantity, guarded so it can never exceed quantity.
          const [incremented] = await tx
            .update(prescriptionItems)
            .set({ dispensedQuantity: sql`${prescriptionItems.dispensedQuantity} + ${line.quantity}` })
            .where(
              and(
                eq(prescriptionItems.id, item.id),
                sql`${prescriptionItems.dispensedQuantity} + ${line.quantity} <= ${prescriptionItems.quantity}`
              )
            )
            .returning({ id: prescriptionItems.id });
          if (!incremented) {
            throw badRequest(`Cannot dispense more of ${item.medicineName} than prescribed.`);
          }
        }
      });

      const snapshot = await db
        .select({ quantity: prescriptionItems.quantity, dispensedQuantity: prescriptionItems.dispensedQuantity })
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));
      const fullyDispensed = snapshot.every(
        (item) => Number(item.dispensedQuantity) >= Number(item.quantity)
      );
      const nextStatus = fullyDispensed ? 'dispensed' : 'partially_dispensed';

      await db
        .update(prescriptions)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(prescriptions.id, id));

      await audit(request, {
        action: 'prescription.dispensed',
        entity: 'prescription',
        entityId: id,
        data: { itemCount: body.items.length, status: nextStatus }
      });
      return { id, status: nextStatus, dispensedLines: body.items.length };
    }
  );

  /** Oldest-first work queue for the pharmacy counter. */
  app.get(
    '/api/pharmacy/queue',
    { preHandler: authenticate(QUEUE_ROLES) },
    async () => {
      const rows = await db
        .select({
          id: prescriptions.id,
          patientId: prescriptions.patientId,
          patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
          patientMrn: patients.mrn,
          prescriberName: staff.fullName,
          status: prescriptions.status,
          createdAt: prescriptions.createdAt,
          itemCount: sql<number>`(select count(*)::int from prescription_items pi where pi.prescription_id = ${prescriptions.id})`,
          remainingQuantity: sql<number>`(select coalesce(sum(pi.quantity - pi.dispensed_quantity), 0)::int from prescription_items pi where pi.prescription_id = ${prescriptions.id})`
        })
        .from(prescriptions)
        .innerJoin(patients, eq(prescriptions.patientId, patients.id))
        .innerJoin(staff, eq(prescriptions.prescriberId, staff.id))
        .where(sql`${prescriptions.status} in ('pending', 'partially_dispensed')`)
        .orderBy(asc(prescriptions.createdAt));

      return rows.map((row) => ({
        ...row,
        itemCount: Number(row.itemCount),
        remainingQuantity: Number(row.remainingQuantity)
      }));
    }
  );
}
