import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import {
  admissions,
  appointments,
  invoiceItems,
  invoices,
  labOrderItems,
  labOrders,
  labTests,
  medicines,
  patients,
  payments,
  prescriptionItems,
  prescriptions,
  staff,
  wards
} from '../db/schema/index.js';
import { invoiceItemCategory, invoiceStatus, paymentMethod } from '../db/schema/enums.js';
import {
  authenticate,
  CLINICAL_ROLES,
  ROLES,
  facilityDb,
  type TenantDb
} from '../lib/auth.js';
import type { Role } from '../lib/auth.js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { money, moneyOrNull, round2, totalOf } from '../lib/serialize.js';

type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
type ItemCategory = (typeof invoiceItemCategory.enumValues)[number];

// Both the root database and a `db.transaction` handle extend PgDatabase, so
// helpers accept that base type and can run either on a live transaction or on
// the default connection. Using the base (not `typeof db`) avoids the extra
// `$client`/`rollback` members that differ between the two.
type Executor = PgDatabase<any, any, any>;

/**
 * Placeholder per-day bed tariffs. These hard-coded rates stand in for a future
 * configurable tariff table (per ward, per unit type, dated); until that exists
 * ICU/coronary beds are charged a flat premium and every other unit a general rate.
 */
const ICU_DAILY_TARIFF = 150;
const GENERAL_DAILY_TARIFF = 40;
const MS_PER_DAY = 86_400_000;

const READ_ROLES: Role[] = [ROLES.admin, ROLES.billing, ROLES.reception, ...CLINICAL_ROLES];
const WRITE_ROLES: Role[] = [ROLES.admin, ROLES.billing, ROLES.reception];
const VOID_ROLES: Role[] = [ROLES.admin, ROLES.billing];

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const paymentParam = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() });

interface Totals {
  subtotal: number;
  paid: number;
  balanceDue: number;
}

/**
 * Compute the money for an invoice from raw item/payment rows. Line totals are
 * rounded individually then summed via totalOf, so no string math or float drift
 * (0.1 + 0.2 style) can leak into a response.
 */
function computeTotals(
  items: { quantity: string | number; unitPrice: string | number }[],
  paidRows: { amount: string | number }[]
): Totals {
  const subtotal = totalOf(items.map((item) => round2(money(item.quantity) * money(item.unitPrice))));
  const paid = totalOf(paidRows.map((row) => money(row.amount)));
  return { subtotal, paid, balanceDue: round2(subtotal - paid) };
}

/**
 * Reloads items + payments, derives the honest status and writes it back. Status
 * is never trusted from the client; a void invoice is terminal and keeps its
 * void flag (and its payments) untouched. Returns the recomputed totals.
 */
async function recomputeInvoiceStatus(db: TenantDb, invoiceId: string, tx?: Executor): Promise<Totals & { status: InvoiceStatus }> {
  const exec = tx ?? db;

  const [invoice] = await exec
    .select({ id: invoices.id, status: invoices.status, issuedAt: invoices.issuedAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice) throw notFound('Invoice');

  const itemRows = await exec
    .select({ quantity: invoiceItems.quantity, unitPrice: invoiceItems.unitPrice })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId));
  const paidRows = await exec
    .select({ amount: payments.amount })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId));

  const totals = computeTotals(itemRows, paidRows);

  // Void is an explicit, terminal decision — never silently recomputed away.
  if (invoice.status === 'void') return { ...totals, status: 'void' };

  let derived: InvoiceStatus;
  if (!invoice.issuedAt) {
    derived = 'draft';
  } else if (totals.subtotal > 0 && totals.paid >= totals.subtotal) {
    derived = 'paid';
  } else if (totals.paid > 0) {
    derived = 'partial';
  } else {
    derived = 'issued';
  }

  await exec
    .update(invoices)
    .set({ status: derived, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));

  return { ...totals, status: derived };
}

/**
 * Loads an invoice for editing. Billable items and header fields may only change
 * while the invoice is a draft, or issued with zero payments; once money lands
 * the ledger is frozen (payments must be reversed first). Void is terminal.
 */
async function assertEditableInvoice(db: TenantDb, invoiceId: string, tx?: Executor) {
  const exec = tx ?? db;
  const [invoice] = await exec.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'void') throw badRequest('This invoice is void and can no longer be changed.');

  const [{ paid }] = await exec
    .select({ paid: count() })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId));
  if (Number(paid) > 0) {
    throw badRequest('Remove the payments before changing billable items.');
  }
  return invoice;
}

/** Full invoice view: header + line items (with lineTotal) + payments + totals. */
async function buildInvoiceDetail(db: TenantDb, invoiceId: string) {
  const [header] = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      patientId: invoices.patientId,
      admissionId: invoices.admissionId,
      notes: invoices.notes,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
      createdAt: invoices.createdAt,
      createdBy: invoices.createdBy,
      patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
      patientMrn: patients.mrn
    })
    .from(invoices)
    .leftJoin(patients, eq(invoices.patientId, patients.id))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!header) throw notFound('Invoice');

  const itemRows = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.createdAt));

  const paymentRows = await db
    .select({
      id: payments.id,
      amount: payments.amount,
      method: payments.method,
      reference: payments.reference,
      paidAt: payments.paidAt,
      receivedBy: payments.receivedBy,
      receiverName: staff.fullName
    })
    .from(payments)
    .leftJoin(staff, eq(payments.receivedBy, staff.id))
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(desc(payments.paidAt));

  const totals = computeTotals(itemRows, paymentRows);
  const now = new Date();
  const isOverdue =
    (header.status === 'issued' || header.status === 'partial') &&
    header.dueAt !== null &&
    header.dueAt < now;

  return {
    ...header,
    items: itemRows.map((item) => ({
      id: item.id,
      description: item.description,
      category: item.category,
      quantity: money(item.quantity),
      unitPrice: money(item.unitPrice),
      lineTotal: round2(money(item.quantity) * money(item.unitPrice)),
      referenceId: item.referenceId,
      createdAt: item.createdAt
    })),
    payments: paymentRows.map((row) => ({
      id: row.id,
      amount: money(row.amount),
      method: row.method,
      reference: row.reference,
      paidAt: row.paidAt,
      receivedBy: row.receivedBy,
      receiverName: row.receiverName
    })),
    subtotal: totals.subtotal,
    paid: totals.paid,
    balanceDue: totals.balanceDue,
    isOverdue
  };
}

const itemInput = z.object({
  description: z.string().min(2).max(200),
  category: z.enum(invoiceItemCategory.enumValues),
  quantity: z.coerce.number().positive().max(10_000),
  unitPrice: z.coerce.number().min(0),
  referenceId: z.string().uuid().nullish()
});

const createInvoiceSchema = z.object({
  patientId: z.string().uuid(),
  admissionId: z.string().uuid().nullish(),
  notes: z.string().max(1000).nullish(),
  dueAt: z.coerce.date().nullish(),
  items: z.array(itemInput).min(1).max(100)
});

const addItemsSchema = z.union([itemInput, z.array(itemInput).min(1).max(100)]);

const patchInvoiceSchema = z
  .object({
    notes: z.string().max(1000).nullish(),
    dueAt: z.coerce.date().nullish(),
    admissionId: z.string().uuid().nullish()
  })
  .partial();

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(paymentMethod.enumValues),
  reference: z.string().max(120).nullish(),
  paidAt: z.coerce.date().nullish()
});

const voidSchema = z.object({ reason: z.string().min(3).max(300) });

const encounterSchema = z
  .object({
    appointmentId: z.string().uuid().optional(),
    admissionId: z.string().uuid().optional()
  })
  .refine((value) => Boolean(value.appointmentId) !== Boolean(value.admissionId), {
    message: 'Provide exactly one of appointmentId or admissionId.'
  });

interface DraftLine {
  description: string;
  category: ItemCategory;
  quantity: number;
  unitPrice: number;
  referenceId: string | null;
}

/** Zero-value lines are dropped so the invoice never carries empty charges. */
function pushBillable(lines: DraftLine[], line: DraftLine) {
  const total = round2(line.quantity * line.unitPrice);
  if (total > 0) lines.push({ ...line, unitPrice: round2(line.unitPrice) });
}

export async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate(READ_ROLES));

  // ---------------------------------------------------------------- GET list
  app.get('/api/invoices', async (request) => {
    const db = facilityDb(request);
    const query = z
      .object({
        status: z.enum(invoiceStatus.enumValues).optional(),
        patientId: z.string().uuid().optional(),
        q: z.string().max(160).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.status) filters.push(eq(invoices.status, query.status));
    if (query.patientId) filters.push(eq(invoices.patientId, query.patientId));
    if (query.from) filters.push(gte(invoices.createdAt, query.from));
    if (query.to) filters.push(lt(invoices.createdAt, query.to));
    if (query.q) {
      const term = `%${query.q}%`;
      filters.push(
        or(
          ilikeNumber(term),
          sql`(${patients.givenName} || ' ' || ${patients.familyName}) ilike ${term}`,
          ilike(patients.mrn, term)
        )!
      );
    }
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        patientId: invoices.patientId,
        patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
        patientMrn: patients.mrn,
        createdAt: invoices.createdAt,
        issuedAt: invoices.issuedAt,
        dueAt: invoices.dueAt
      })
      .from(invoices)
      .leftJoin(patients, eq(invoices.patientId, patients.id))
      .where(where)
      .orderBy(desc(invoices.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    // Totals are computed in JS (never string-summed in SQL) for exactness.
    const invoiceIds = rows.map((row) => row.id);
    const [itemsByInvoice, paysByInvoice] = await loadAggregates(db, invoiceIds);

    const items = rows.map((row) => {
      const totals = computeTotals(itemsByInvoice.get(row.id) ?? [], paysByInvoice.get(row.id) ?? []);
      return {
        ...row,
        itemCount: (itemsByInvoice.get(row.id) ?? []).length,
        subtotal: totals.subtotal,
        paid: totals.paid,
        balanceDue: totals.balanceDue
      };
    });

    const [{ total }] = await db
      .select({ total: count() })
      .from(invoices)
      .leftJoin(patients, eq(invoices.patientId, patients.id))
      .where(where);

    return { items, total: Number(total) };
  });

  // ------------------------------------------------------------- GET summary
  app.get(
    '/api/invoices/summary',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const outstandingRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.status, ['issued', 'partial']));

      const outstandingIds = outstandingRows.map((row) => row.id);
      const [itemsByInvoice, paysByInvoice] = await loadAggregates(db, outstandingIds);

      let outstandingCount = 0;
      const outstandingAmounts: number[] = [];
      const overdueInvoiceIds: string[] = [];
      for (const id of outstandingIds) {
        const totals = computeTotals(itemsByInvoice.get(id) ?? [], paysByInvoice.get(id) ?? []);
        outstandingAmounts.push(Math.max(0, totals.balanceDue));
        outstandingCount += 1;
      }
      const outstandingBalance = round2(totalOf(outstandingAmounts));

      if (outstandingIds.length) {
        const dueRows = await db
          .select({ id: invoices.id, dueAt: invoices.dueAt, status: invoices.status })
          .from(invoices)
          .where(inArray(invoices.id, outstandingIds));
        for (const row of dueRows) {
          if (row.dueAt && row.dueAt < now) overdueInvoiceIds.push(row.id);
        }
      }

      const collect = async (since: Date) => {
        const rows = await db
          .select({ amount: payments.amount })
          .from(payments)
          .where(gte(payments.paidAt, since));
        return totalOf(rows.map((row) => money(row.amount)));
      };

      return {
        outstanding: {
          invoiceCount: outstandingCount,
          balanceDue: outstandingBalance
        },
        collectedToday: await collect(dayStart),
        collectedThisMonth: await collect(monthStart),
        overdueCount: overdueInvoiceIds.length
      };
    }
  );

  // ------------------------------------------------------------- GET detail
  app.get('/api/invoices/:id', async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);
    return buildInvoiceDetail(db, id);
  });

  // ------------------------------------------------------------ POST create
  app.post(
    '/api/invoices',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const body = createInvoiceSchema.parse(request.body);

      const [patient] = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, body.patientId))
        .limit(1);
      if (!patient) throw badRequest('Select a valid patient.');

      const created = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .insert(invoices)
          .values({
            patientId: body.patientId,
            admissionId: body.admissionId ?? null,
            notes: body.notes ?? null,
            dueAt: body.dueAt ?? null,
            status: 'draft',
            createdBy: request.currentUser!.id
          })
          .returning();

        await tx.insert(invoiceItems).values(
          body.items.map((item) => ({
            invoiceId: invoice.id,
            description: item.description,
            category: item.category,
            quantity: String(round2(item.quantity)),
            unitPrice: String(round2(item.unitPrice)),
            referenceId: item.referenceId ?? null
          }))
        );

        const totals = await recomputeInvoiceStatus(db, invoice.id, tx);
        return { invoice, totals };
      });

      await audit(request, {
        action: 'invoice.created',
        entity: 'invoice',
        entityId: created.invoice.id,
        data: {
          number: created.invoice.number,
          patientId: body.patientId,
          itemCount: body.items.length,
          subtotal: created.totals.subtotal
        }
      });

      return buildInvoiceDetail(db, created.invoice.id);
    }
  );

  // ---------------------------------------------------------- POST add items
  app.post(
    '/api/invoices/:id/items',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id } = idParam.parse(request.params);
      const parsed = addItemsSchema.parse(request.body);
      const lines = Array.isArray(parsed) ? parsed : [parsed];

      await db.transaction(async (tx) => {
        await assertEditableInvoice(db, id, tx);
        await tx.insert(invoiceItems).values(
          lines.map((item) => ({
            invoiceId: id,
            description: item.description,
            category: item.category,
            quantity: String(round2(item.quantity)),
            unitPrice: String(round2(item.unitPrice)),
            referenceId: item.referenceId ?? null
          }))
        );
        await recomputeInvoiceStatus(db, id, tx);
      });

      await audit(request, {
        action: 'invoice.items_added',
        entity: 'invoice',
        entityId: id,
        data: { count: lines.length }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // --------------------------------------------------------- PATCH one item
  app.patch(
    '/api/invoices/:id/items/:itemId',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id, itemId } = itemParam.parse(request.params);
      const body = itemInput.partial().parse(request.body);
      if (Object.keys(body).length === 0) throw badRequest('Nothing to update.');

      await db.transaction(async (tx) => {
        await assertEditableInvoice(db, id, tx);
        const [existing] = await tx
          .select({ id: invoiceItems.id })
          .from(invoiceItems)
          .where(and(eq(invoiceItems.id, itemId), eq(invoiceItems.invoiceId, id)))
          .limit(1);
        if (!existing) throw notFound('Invoice item');

        const updates: Partial<typeof invoiceItems.$inferInsert> = {};
        if (body.description !== undefined) updates.description = body.description;
        if (body.category !== undefined) updates.category = body.category;
        if (body.quantity !== undefined) updates.quantity = String(round2(body.quantity));
        if (body.unitPrice !== undefined) updates.unitPrice = String(round2(body.unitPrice));
        if ('referenceId' in body) updates.referenceId = body.referenceId ?? null;

        await tx.update(invoiceItems).set(updates).where(eq(invoiceItems.id, itemId));
        await recomputeInvoiceStatus(db, id, tx);
      });

      await audit(request, {
        action: 'invoice.item_updated',
        entity: 'invoice',
        entityId: id,
        data: { itemId, fields: Object.keys(body) }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // -------------------------------------------------------- DELETE one item
  app.delete(
    '/api/invoices/:id/items/:itemId',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id, itemId } = itemParam.parse(request.params);

      await db.transaction(async (tx) => {
        await assertEditableInvoice(db, id, tx);
        const [existing] = await tx
          .select({ id: invoiceItems.id })
          .from(invoiceItems)
          .where(and(eq(invoiceItems.id, itemId), eq(invoiceItems.invoiceId, id)))
          .limit(1);
        if (!existing) throw notFound('Invoice item');
        await tx.delete(invoiceItems).where(eq(invoiceItems.id, itemId));
        await recomputeInvoiceStatus(db, id, tx);
      });

      await audit(request, {
        action: 'invoice.item_deleted',
        entity: 'invoice',
        entityId: id,
        data: { itemId }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // ---------------------------------------------------------- PATCH header
  app.patch(
    '/api/invoices/:id',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id } = idParam.parse(request.params);
      const body = patchInvoiceSchema.parse(request.body);

      await assertEditableInvoice(db, id);

      const updates: Partial<typeof invoices.$inferInsert> = {};
      if ('notes' in body) updates.notes = body.notes ?? null;
      if ('dueAt' in body) updates.dueAt = body.dueAt ?? null;
      if ('admissionId' in body) updates.admissionId = body.admissionId ?? null;
      updates.updatedAt = new Date();

      await db.update(invoices).set(updates).where(eq(invoices.id, id));
      await recomputeInvoiceStatus(db, id);

      await audit(request, {
        action: 'invoice.updated',
        entity: 'invoice',
        entityId: id,
        data: { fields: Object.keys(body) }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // -------------------------------------------------------------- issue
  app.post(
    '/api/invoices/:id/issue',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id } = idParam.parse(request.params);

      await db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
        if (!invoice) throw notFound('Invoice');
        if (invoice.status === 'void') throw badRequest('A void invoice cannot be issued.');
        if (invoice.issuedAt) throw badRequest('This invoice has already been issued.');

        const [{ itemCount }] = await tx
          .select({ itemCount: count() })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, id));
        if (Number(itemCount) === 0) throw badRequest('Add at least one item before issuing.');

        await tx
          .update(invoices)
          .set({
            issuedAt: new Date(),
            dueAt: invoice.dueAt ?? new Date(Date.now() + 14 * MS_PER_DAY),
            updatedAt: new Date()
          })
          .where(eq(invoices.id, id));

        await recomputeInvoiceStatus(db, id, tx);
      });

      await audit(request, {
        action: 'invoice.issued',
        entity: 'invoice',
        entityId: id
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // ------------------------------------------------------------ payments
  app.post(
    '/api/invoices/:id/payments',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id } = idParam.parse(request.params);
      const body = paymentSchema.parse(request.body);

      const created = await db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
        if (!invoice) throw notFound('Invoice');
        if (invoice.status === 'void') throw badRequest('This invoice is void and cannot accept payments.');
        if (!invoice.issuedAt) throw badRequest('A draft invoice cannot be paid. Issue it first.');

        const itemRows = await tx
          .select({ quantity: invoiceItems.quantity, unitPrice: invoiceItems.unitPrice })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, id));
        const paidRows = await tx
          .select({ amount: payments.amount })
          .from(payments)
          .where(eq(payments.invoiceId, id));
        const totals = computeTotals(itemRows, paidRows);

        if (body.amount > totals.balanceDue) {
          throw badRequest(
            `Payment exceeds the remaining balance. The amount still due is ${totals.balanceDue.toFixed(2)}.`
          );
        }

        const [payment] = await tx
          .insert(payments)
          .values({
            invoiceId: id,
            amount: String(round2(body.amount)),
            method: body.method,
            reference: body.reference ?? null,
            receivedBy: request.currentUser!.id,
            paidAt: body.paidAt ?? new Date()
          })
          .returning();

        const refreshed = await recomputeInvoiceStatus(db, id, tx);
        return { payment, refreshed };
      });

      await audit(request, {
        action: 'invoice.payment_recorded',
        entity: 'payment',
        entityId: created.payment.id,
        data: {
          invoiceId: id,
          amount: money(created.payment.amount),
          method: created.payment.method,
          balanceDue: created.refreshed.balanceDue
        }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // -------------------------------------------------- reverse last payment
  app.delete(
    '/api/invoices/:id/payments/:paymentId',
    { preHandler: authenticate(VOID_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id, paymentId } = paymentParam.parse(request.params);

      const reversed = await db.transaction(async (tx) => {
        const [invoice] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, id)).limit(1);
        if (!invoice) throw notFound('Invoice');

        const [latest] = await tx
          .select({ id: payments.id, amount: payments.amount, method: payments.method })
          .from(payments)
          .where(eq(payments.invoiceId, id))
          .orderBy(desc(payments.paidAt), desc(payments.createdAt))
          .limit(1);
        if (!latest) throw notFound('Payment');
        if (latest.id !== paymentId) {
          throw badRequest('Only the most recent payment can be reversed, to keep the ledger chronological.');
        }

        await tx.delete(payments).where(eq(payments.id, paymentId));
        const refreshed = await recomputeInvoiceStatus(db, id, tx);
        return { latest, refreshed };
      });

      await audit(request, {
        action: 'invoice.payment_reversed',
        entity: 'payment',
        entityId: paymentId,
        data: {
          invoiceId: id,
          amount: money(reversed.latest.amount),
          method: reversed.latest.method,
          balanceDue: reversed.refreshed.balanceDue
        }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // -------------------------------------------------------------- void
  app.post(
    '/api/invoices/:id/void',
    { preHandler: authenticate(VOID_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const { id } = idParam.parse(request.params);
      const body = voidSchema.parse(request.body);

      await db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
        if (!invoice) throw notFound('Invoice');
        if (invoice.status === 'void') throw badRequest('This invoice is already void.');

        const paidRows = await tx
          .select({ amount: payments.amount })
          .from(payments)
          .where(eq(payments.invoiceId, id));
        const paidTotal = totalOf(paidRows.map((row) => money(row.amount)));
        if (paidTotal > 0) {
          throw badRequest(
            'Reverse every payment before voiding this invoice; a refund is a separate transaction and must stay on the ledger.'
          );
        }

        // Payments are intentionally kept — voiding must never delete money.
        await tx
          .update(invoices)
          .set({ status: 'void', notes: sql`coalesce(${invoices.notes} || ' | ', '') || ${'Voided: ' + body.reason}`, updatedAt: new Date() })
          .where(eq(invoices.id, id));
      });

      await audit(request, {
        action: 'invoice.voided',
        entity: 'invoice',
        entityId: id,
        data: { reason: body.reason }
      });
      return buildInvoiceDetail(db, id);
    }
  );

  // ------------------------------------------------------- from encounter
  app.post(
    '/api/invoices/from-encounter',
    { preHandler: authenticate(WRITE_ROLES) },
    async (request) => {
      const db = facilityDb(request);
      const body = encounterSchema.parse(request.body);

      const lines: DraftLine[] = [];
      let patientId: string;
      let admissionId: string | null = null;

      if (body.appointmentId) {
        const [appointment] = await db
          .select({
            id: appointments.id,
            patientId: appointments.patientId,
            fee: appointments.fee,
            startsAt: appointments.startsAt
          })
          .from(appointments)
          .where(eq(appointments.id, body.appointmentId))
          .limit(1);
        if (!appointment) throw notFound('Appointment');
        patientId = appointment.patientId;

        const fee = moneyOrNull(appointment.fee) ?? 0;
        pushBillable(lines, {
          description: 'Consultation',
          category: 'consultation',
          quantity: 1,
          unitPrice: fee,
          referenceId: appointment.id
        });

        const dayStart = new Date(appointment.startsAt);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

        await addLabLines(db, lines, {
          patientId,
          from: dayStart,
          to: dayEnd
        });
        await addPrescriptionLines(db, lines, { appointmentId: appointment.id });

        await refuseIfDraftExists(db, 'referenceId', appointment.id);
      } else {
        const [admission] = await db
          .select({
            id: admissions.id,
            patientId: admissions.patientId,
            wardId: admissions.wardId,
            unitType: wards.unitType,
            wardName: wards.name,
            admittedAt: admissions.admittedAt,
            dischargedAt: admissions.dischargedAt
          })
          .from(admissions)
          .leftJoin(wards, eq(admissions.wardId, wards.id))
          .where(eq(admissions.id, body.admissionId!))
          .limit(1);
        if (!admission) throw notFound('Admission');
        patientId = admission.patientId;
        admissionId = admission.id;

        const end = (admission.dischargedAt ?? new Date()).getTime();
        const days = Math.max(1, Math.ceil((end - admission.admittedAt.getTime()) / MS_PER_DAY));
        const tariff = admission.unitType === 'icu' || admission.unitType === 'coronary' ? ICU_DAILY_TARIFF : GENERAL_DAILY_TARIFF;
        pushBillable(lines, {
          description: `Ward charge — ${admission.wardName ?? 'ward'} (${days} day${days === 1 ? '' : 's'})`,
          category: 'ward',
          quantity: days,
          unitPrice: tariff,
          referenceId: admission.id
        });

        await addLabLines(db, lines, { patientId, admissionId: admission.id });
        await addPrescriptionLines(db, lines, { admissionId: admission.id });

        await refuseIfDraftExists(db, 'admissionId', admission.id);
      }

      if (lines.length === 0) throw badRequest('No billable charges found for this encounter.');

      const created = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .insert(invoices)
          .values({
            patientId,
            admissionId,
            status: 'draft',
            createdBy: request.currentUser!.id
          })
          .returning();

        await tx.insert(invoiceItems).values(
          lines.map((line) => ({
            invoiceId: invoice.id,
            description: line.description,
            category: line.category,
            quantity: String(round2(line.quantity)),
            unitPrice: String(round2(line.unitPrice)),
            referenceId: line.referenceId
          }))
        );

        const totals = await recomputeInvoiceStatus(db, invoice.id, tx);
        return { invoice, totals };
      });

      await audit(request, {
        action: 'invoice.created_from_encounter',
        entity: 'invoice',
        entityId: created.invoice.id,
        data: {
          number: created.invoice.number,
          patientId,
          admissionId,
          appointmentId: body.appointmentId ?? null,
          lineCount: lines.length,
          subtotal: created.totals.subtotal
        }
      });

      return buildInvoiceDetail(db, created.invoice.id);
    }
  );
}

/* ------------------------------------------------------------------ *
 * Shared helpers for the encounter rollup + list aggregation
 * ------------------------------------------------------------------ */

function ilikeNumber(term: string) {
  return ilike(invoices.number, term);
}

/**
 * Loads items + payments for a set of invoices and buckets them by invoice id,
 * so the list endpoints can compute exact totals in JS without a query per row.
 */
async function loadAggregates(db: TenantDb, invoiceIds: string[]): Promise<
  [Map<string, { quantity: string; unitPrice: string }[]>, Map<string, { amount: string }[]>]
> {
  const itemsByInvoice = new Map<string, { quantity: string; unitPrice: string }[]>();
  const paysByInvoice = new Map<string, { amount: string }[]>();
  if (invoiceIds.length === 0) return [itemsByInvoice, paysByInvoice];

  const itemRows = await db
    .select({ invoiceId: invoiceItems.invoiceId, quantity: invoiceItems.quantity, unitPrice: invoiceItems.unitPrice })
    .from(invoiceItems)
    .where(inArray(invoiceItems.invoiceId, invoiceIds));
  for (const row of itemRows) {
    const list = itemsByInvoice.get(row.invoiceId) ?? [];
    list.push({ quantity: row.quantity, unitPrice: row.unitPrice });
    itemsByInvoice.set(row.invoiceId, list);
  }

  const payRows = await db
    .select({ invoiceId: payments.invoiceId, amount: payments.amount })
    .from(payments)
    .where(inArray(payments.invoiceId, invoiceIds));
  for (const row of payRows) {
    const list = paysByInvoice.get(row.invoiceId) ?? [];
    list.push({ amount: row.amount });
    paysByInvoice.set(row.invoiceId, list);
  }

  return [itemsByInvoice, paysByInvoice];
}

/**
 * One 'lab' line per completed order priced at the sum of its tests. Scoped to
 * the encounter: admission-linked orders for an admission, patient + day window
 * for an appointment.
 */
async function addLabLines(db: TenantDb, 
  lines: DraftLine[],
  scope: { patientId: string; admissionId?: string; from?: Date; to?: Date }
) {
  const filters = [eq(labOrders.patientId, scope.patientId), eq(labOrders.status, 'completed')];
  if (scope.admissionId) filters.push(eq(labOrders.admissionId, scope.admissionId));
  if (scope.from) filters.push(gte(labOrders.orderedAt, scope.from));
  if (scope.to) filters.push(lt(labOrders.orderedAt, scope.to));

  const orders = await db
    .select({ id: labOrders.id })
    .from(labOrders)
    .where(and(...filters));
  if (orders.length === 0) return;

  const orderIds = orders.map((order) => order.id);
  const testRows = await db
    .select({ orderId: labOrderItems.labOrderId, price: labTests.price })
    .from(labOrderItems)
    .innerJoin(labTests, eq(labOrderItems.labTestId, labTests.id))
    .where(inArray(labOrderItems.labOrderId, orderIds));

  const priceByOrder = new Map<string, number[]>();
  for (const row of testRows) {
    const arr = priceByOrder.get(row.orderId) ?? [];
    arr.push(money(row.price));
    priceByOrder.set(row.orderId, arr);
  }

  for (const orderId of orderIds) {
    const amount = totalOf(priceByOrder.get(orderId) ?? []);
    pushBillable(lines, {
      description: 'Laboratory tests',
      category: 'lab',
      quantity: 1,
      unitPrice: amount,
      referenceId: orderId
    });
  }
}

/**
 * One 'medicine' line per dispensed prescription at
 * sum(dispensedQuantity * medicine.price).
 */
async function addPrescriptionLines(db: TenantDb, 
  lines: DraftLine[],
  scope: { appointmentId?: string; admissionId?: string }
) {
  const filters: SQLWrapper[] = [
    inArray(prescriptions.status, ['dispensed', 'partially_dispensed']),
    ...(scope.appointmentId ? [eq(prescriptions.appointmentId, scope.appointmentId)] : []),
    ...(scope.admissionId ? [eq(prescriptions.admissionId, scope.admissionId)] : [])
  ];

  const rxRows = await db
    .select({ id: prescriptions.id })
    .from(prescriptions)
    .where(and(...filters));
  if (rxRows.length === 0) return;

  const rxIds = rxRows.map((row) => row.id);
  const itemRows = await db
    .select({
      prescriptionId: prescriptionItems.prescriptionId,
      dispensedQuantity: prescriptionItems.dispensedQuantity,
      price: medicines.price
    })
    .from(prescriptionItems)
    .innerJoin(medicines, eq(prescriptionItems.medicineId, medicines.id))
    .where(inArray(prescriptionItems.prescriptionId, rxIds));

  const amountByRx = new Map<string, number[]>();
  for (const row of itemRows) {
    const arr = amountByRx.get(row.prescriptionId) ?? [];
    arr.push(round2(row.dispensedQuantity * money(row.price)));
    amountByRx.set(row.prescriptionId, arr);
  }

  for (const rxId of rxIds) {
    const amount = totalOf(amountByRx.get(rxId) ?? []);
    pushBillable(lines, {
      description: 'Dispensed medication',
      category: 'medicine',
      quantity: 1,
      unitPrice: amount,
      referenceId: rxId
    });
  }
}

/**
 * Idempotency guard: refuse to build a second draft for an encounter that already
 * has one. For an admission the link is invoices.admissionId; for an appointment
 * (which has no column on invoices) the consultation line carries the appointment
 * id as its referenceId.
 */
async function refuseIfDraftExists(db: TenantDb, mode: 'admissionId' | 'referenceId', encounterId: string) {
  if (mode === 'admissionId') {
    const [existing] = await db
      .select({ number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.admissionId, encounterId), eq(invoices.status, 'draft')))
      .limit(1);
    if (existing) throw badRequest(`A draft invoice for this encounter already exists: ${existing.number}.`);
    return;
  }

  const [existing] = await db
    .select({ number: invoices.number })
    .from(invoices)
    .innerJoin(invoiceItems, eq(invoiceItems.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.status, 'draft'),
        eq(invoiceItems.category, 'consultation'),
        eq(invoiceItems.referenceId, encounterId)
      )
    )
    .limit(1);
  if (existing) throw badRequest(`A draft invoice for this encounter already exists: ${existing.number}.`);
}
