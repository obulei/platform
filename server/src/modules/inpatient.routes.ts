import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  admissions,
  bedStatus,
  beds,
  clinicalNotes,
  noteType,
  patients,
  staff,
  vitalsRecords,
  wardUnitType,
  wards
} from '../db/schema/index.js';
import { authenticate, CLINICAL_ROLES, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { moneyOrNull, round2 } from '../lib/serialize.js';

const idParam = z.object({ id: z.string().uuid() });
const patientIdParam = z.object({ patientId: z.string().uuid() });

const ADMIN_ONLY = [ROLES.admin];
const ADMIN_NURSE = [ROLES.admin, ROLES.nurse];
const ADMISSION_WRITE = [ROLES.admin, ROLES.doctor, ROLES.nurse];
const ADMISSION_CREATE = [ROLES.admin, ROLES.doctor, ROLES.nurse, ROLES.reception];
const VITALS_WRITE = [ROLES.admin, ROLES.nurse, ROLES.doctor];

/* ------------------------------------------------------------------ *
 * Body schemas
 * ------------------------------------------------------------------ */

const wardSchema = z.object({
  name: z.string().min(1).max(80),
  unitType: z.enum(wardUnitType.enumValues).optional(),
  floor: z.number().int().min(-5).max(50).optional(),
  isActive: z.boolean().optional()
});

const bedSchema = z.object({
  label: z.string().min(1).max(20),
  status: z.enum(bedStatus.enumValues).default('available')
});

const admissionCreateSchema = z.object({
  patientId: z.string().uuid(),
  wardId: z.string().uuid(),
  bedId: z.string().uuid().optional(),
  attendingStaffId: z.string().uuid().optional(),
  admittingComplaint: z.string().min(3).max(500),
  diagnosis: z.string().max(1000).optional()
});

const admissionUpdateSchema = z.object({
  wardId: z.string().uuid().optional(),
  bedId: z.string().uuid().nullable().optional(),
  admittingComplaint: z.string().min(3).max(500).optional(),
  diagnosis: z.string().max(1000).nullable().optional()
});

const dischargeSchema = z.object({
  dischargeSummary: z.string().max(4000).nullish(),
  diagnosis: z.string().max(1000).nullish()
});

const noteSchema = z.object({
  type: z.enum(noteType.enumValues).default('progress'),
  content: z.string().min(3).max(8000)
});

// Every vital is optional; recordedAt/admissionId do not count as a reading.
const vitalsSchema = z.object({
  temperatureC: z.number().optional(),
  pulse: z.number().int().optional(),
  respiratoryRate: z.number().int().optional(),
  spo2: z.number().int().optional(),
  bpSystolic: z.number().int().optional(),
  bpDiastolic: z.number().int().optional(),
  weightKg: z.number().optional(),
  heightCm: z.number().optional(),
  recordedAt: z.coerce.date().optional(),
  admissionId: z.string().uuid().optional()
});

// Ranges guard against fat-finger errors (e.g. 370 instead of 37.0) silently
// corrupting a clinical record. Each bound is inclusive.
const VITAL_RANGES = {
  temperatureC: { min: 25, max: 45, label: 'Temperature (°C)' },
  pulse: { min: 10, max: 300, label: 'Pulse' },
  respiratoryRate: { min: 5, max: 80, label: 'Respiratory rate' },
  spo2: { min: 0, max: 100, label: 'SpO₂ (%)' },
  bpSystolic: { min: 40, max: 300, label: 'Systolic BP' },
  bpDiastolic: { min: 20, max: 200, label: 'Diastolic BP' },
  weightKg: { min: 0.5, max: 400, label: 'Weight (kg)' },
  heightCm: { min: 20, max: 272, label: 'Height (cm)' }
} as const;

type VitalKey = keyof typeof VITAL_RANGES;
const VITAL_KEYS = Object.keys(VITAL_RANGES) as VitalKey[];

/* ------------------------------------------------------------------ *
 * Mappers
 * ------------------------------------------------------------------ */

interface VitalRow {
  id: string;
  patientId: string;
  admissionId: string | null;
  temperatureC: string | null;
  pulse: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  weightKg: string | null;
  heightCm: string | null;
  recordedAt: Date;
  recordedBy: string | null;
  recordedByName?: string | null;
}

function toVitalsDto(row: VitalRow) {
  return {
    id: row.id,
    patientId: row.patientId,
    admissionId: row.admissionId,
    recordedBy: row.recordedBy,
    recordedByName: row.recordedByName ?? null,
    temperatureC: moneyOrNull(row.temperatureC),
    pulse: row.pulse,
    respiratoryRate: row.respiratoryRate,
    spo2: row.spo2,
    bpSystolic: row.bpSystolic,
    bpDiastolic: row.bpDiastolic,
    weightKg: moneyOrNull(row.weightKg),
    heightCm: moneyOrNull(row.heightCm),
    recordedAt: row.recordedAt
  };
}

/** Admissions joined with the display names callers expect. */
function admissionSelect() {
  return db
    .select({
      id: admissions.id,
      patientId: admissions.patientId,
      patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
      patientMrn: patients.mrn,
      wardId: admissions.wardId,
      wardName: wards.name,
      bedId: admissions.bedId,
      bedLabel: beds.label,
      attendingStaffId: admissions.attendingStaffId,
      attendingName: staff.fullName,
      status: admissions.status,
      admittingComplaint: admissions.admittingComplaint,
      diagnosis: admissions.diagnosis,
      dischargeSummary: admissions.dischargeSummary,
      admittedAt: admissions.admittedAt,
      dischargedAt: admissions.dischargedAt
    })
    .from(admissions)
    .innerJoin(patients, eq(admissions.patientId, patients.id))
    .leftJoin(wards, eq(admissions.wardId, wards.id))
    .leftJoin(beds, eq(admissions.bedId, beds.id))
    .leftJoin(staff, eq(admissions.attendingStaffId, staff.id));
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export async function inpatientRoutes(app: FastifyInstance) {
  // Any authenticated staff member can read the inpatient layout; clinical
  // free-text is tightened per-route below.
  app.addHook('preHandler', authenticate());

  /* ---------------------------- Wards & beds ---------------------------- */

  app.get('/api/wards', async () => {
    // Occupancy is derived from open admissions (dischargedAt is null), never
    // from a stored flag: a bed counts as occupied only while an admission row
    // still holds it. One left join yields one row per bed, so the conditional
    // counts below stay correct.
    const rows = await db
      .select({
        id: wards.id,
        name: wards.name,
        unitType: wards.unitType,
        floor: wards.floor,
        isActive: wards.isActive,
        totalBeds: sql<number>`count(${beds.id})`,
        occupiedBeds: sql<number>`count(distinct ${admissions.id})`,
        maintenanceBeds: sql<number>`count(${beds.id}) filter (where ${beds.status} = 'maintenance')`,
        availableBeds: sql<number>`count(${beds.id}) filter (where ${beds.status} = 'available' and ${admissions.id} is null)`
      })
      .from(wards)
      .leftJoin(beds, eq(beds.wardId, wards.id))
      .leftJoin(
        admissions,
        and(eq(admissions.bedId, beds.id), isNull(admissions.dischargedAt))
      )
      .groupBy(wards.id)
      .orderBy(asc(wards.name));

    return rows.map((row) => {
      const totalBeds = Number(row.totalBeds);
      const occupiedBeds = Number(row.occupiedBeds);
      return {
        id: row.id,
        name: row.name,
        unitType: row.unitType,
        floor: row.floor,
        isActive: row.isActive,
        totalBeds,
        occupiedBeds,
        maintenanceBeds: Number(row.maintenanceBeds),
        availableBeds: Number(row.availableBeds),
        occupancyRate: totalBeds ? round2((occupiedBeds / totalBeds) * 100) : 0
      };
    });
  });

  app.get('/api/wards/:id/beds', async (request) => {
    const { id } = idParam.parse(request.params);

    const [ward] = await db.select({ id: wards.id }).from(wards).where(eq(wards.id, id)).limit(1);
    if (!ward) throw notFound('Ward');

    const rows = await db
      .select({
        id: beds.id,
        label: beds.label,
        status: beds.status,
        admissionId: admissions.id,
        admittedAt: admissions.admittedAt,
        patientId: admissions.patientId,
        patientMrn: patients.mrn,
        patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
        attendingName: staff.fullName
      })
      .from(beds)
      .leftJoin(
        admissions,
        and(eq(admissions.bedId, beds.id), isNull(admissions.dischargedAt))
      )
      .leftJoin(patients, eq(admissions.patientId, patients.id))
      .leftJoin(staff, eq(admissions.attendingStaffId, staff.id))
      .where(eq(beds.wardId, id))
      .orderBy(asc(beds.label));

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      occupied: row.admissionId !== null,
      admissionId: row.admissionId,
      admittedAt: row.admittedAt,
      patient: row.admissionId
        ? { id: row.patientId, mrn: row.patientMrn, name: row.patientName }
        : null,
      attendingName: row.attendingName
    }));
  });

  app.post('/api/wards', { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const body = wardSchema.parse(request.body);
    const [row] = await db.insert(wards).values(body).returning();

    await audit(request, {
      action: 'ward.created',
      entity: 'ward',
      entityId: row.id,
      data: { name: row.name, unitType: row.unitType }
    });
    return row;
  });

  app.patch('/api/wards/:id', { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = wardSchema.partial().parse(request.body);

    const [row] = await db
      .update(wards)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(wards.id, id))
      .returning();
    if (!row) throw notFound('Ward');

    await audit(request, {
      action: 'ward.updated',
      entity: 'ward',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return row;
  });

  app.post(
    '/api/wards/:id/beds',
    { preHandler: authenticate(ADMIN_NURSE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = bedSchema.parse(request.body);

      const [ward] = await db
        .select({ id: wards.id })
        .from(wards)
        .where(eq(wards.id, id))
        .limit(1);
      if (!ward) throw badRequest('Select a valid ward.');

      // beds_ward_label_key rejects a duplicate label in the same ward.
      const [row] = await db.insert(beds).values({ ...body, wardId: id }).returning();

      await audit(request, {
        action: 'bed.created',
        entity: 'bed',
        entityId: row.id,
        data: { wardId: id, label: row.label }
      });
      return row;
    }
  );

  app.patch('/api/beds/:id', { preHandler: authenticate(ADMIN_NURSE) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = bedSchema.partial().parse(request.body);

    const [row] = await db
      .update(beds)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(beds.id, id))
      .returning();
    if (!row) throw notFound('Bed');

    await audit(request, {
      action: 'bed.updated',
      entity: 'bed',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return row;
  });

  /* ---------------------------- Admissions ---------------------------- */

  app.get('/api/admissions', async (request) => {
    const query = z
      .object({
        status: z.enum(['admitted', 'discharged']).optional(),
        wardId: z.string().uuid().optional(),
        patientId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.status) filters.push(eq(admissions.status, query.status));
    if (query.wardId) filters.push(eq(admissions.wardId, query.wardId));
    if (query.patientId) filters.push(eq(admissions.patientId, query.patientId));
    const where = filters.length ? and(...filters) : undefined;

    const items = await admissionSelect()
      .where(where)
      .orderBy(desc(admissions.admittedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(admissions)
      .where(where);

    return { items, total: Number(total) };
  });

  // The census: every still-open admission, newest first.
  app.get('/api/admissions/current', async () => {
    return admissionSelect()
      .where(isNull(admissions.dischargedAt))
      .orderBy(desc(admissions.admittedAt));
  });

  app.get('/api/admissions/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const [admission] = await admissionSelect().where(eq(admissions.id, id)).limit(1);
    if (!admission) throw notFound('Admission');

    const canSeeClinical = CLINICAL_ROLES.includes(request.currentUser!.role);
    if (!canSeeClinical) return admission;

    const [notes, vitals] = await Promise.all([
      db
        .select({
          id: clinicalNotes.id,
          type: clinicalNotes.type,
          content: clinicalNotes.content,
          createdAt: clinicalNotes.createdAt,
          authorId: clinicalNotes.staffId,
          author: staff.fullName
        })
        .from(clinicalNotes)
        .leftJoin(staff, eq(clinicalNotes.staffId, staff.id))
        .where(eq(clinicalNotes.admissionId, id))
        .orderBy(desc(clinicalNotes.createdAt)),
      db
        .select({
          id: vitalsRecords.id,
          patientId: vitalsRecords.patientId,
          admissionId: vitalsRecords.admissionId,
          temperatureC: vitalsRecords.temperatureC,
          pulse: vitalsRecords.pulse,
          respiratoryRate: vitalsRecords.respiratoryRate,
          spo2: vitalsRecords.spo2,
          bpSystolic: vitalsRecords.bpSystolic,
          bpDiastolic: vitalsRecords.bpDiastolic,
          weightKg: vitalsRecords.weightKg,
          heightCm: vitalsRecords.heightCm,
          recordedAt: vitalsRecords.recordedAt,
          recordedBy: vitalsRecords.recordedBy,
          recordedByName: staff.fullName
        })
        .from(vitalsRecords)
        .leftJoin(staff, eq(vitalsRecords.recordedBy, staff.id))
        .where(eq(vitalsRecords.admissionId, id))
        .orderBy(desc(vitalsRecords.recordedAt))
    ]);

    return { ...admission, notes, vitals: vitals.map(toVitalsDto) };
  });

  app.post(
    '/api/admissions',
    { preHandler: authenticate(ADMISSION_CREATE) },
    async (request) => {
      const body = admissionCreateSchema.parse(request.body);

      const [patient] = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, body.patientId))
        .limit(1);
      if (!patient) throw badRequest('Select a valid patient.');

      const [ward] = await db
        .select({ id: wards.id })
        .from(wards)
        .where(eq(wards.id, body.wardId))
        .limit(1);
      if (!ward) throw badRequest('Select a valid ward.');

      if (body.bedId) {
        const [bed] = await db
          .select({ id: beds.id, wardId: beds.wardId, status: beds.status })
          .from(beds)
          .where(eq(beds.id, body.bedId))
          .limit(1);
        if (!bed) throw badRequest('Select a valid bed.');
        if (bed.wardId !== body.wardId) {
          throw badRequest('That bed does not belong to the selected ward.');
        }
        if (bed.status === 'maintenance') {
          throw badRequest('That bed is under maintenance and cannot be assigned.');
        }
      }

      // One open admission per bed / per patient is enforced by the partial
      // unique indexes; the insert still relies on them so two stations cannot
      // both win. This pre-check only picks the accurate message, because when
      // both indexes are violated Postgres reports the bed one first.
      const alreadyOpen = await db
        .select({ id: admissions.id })
        .from(admissions)
        .where(and(eq(admissions.patientId, body.patientId), isNull(admissions.dischargedAt)))
        .limit(1);
      if (alreadyOpen.length) {
        throw conflict(
          'This patient is already admitted. Discharge them before a new admission.'
        );
      }

      const [row] = await db
        .insert(admissions)
        .values({
          patientId: body.patientId,
          wardId: body.wardId,
          bedId: body.bedId ?? null,
          attendingStaffId: body.attendingStaffId ?? null,
          admittingComplaint: body.admittingComplaint,
          diagnosis: body.diagnosis ?? null,
          createdBy: request.currentUser!.id
        })
        .returning();

      await audit(request, {
        action: 'admission.created',
        entity: 'admission',
        entityId: row.id,
        data: {
          patientId: row.patientId,
          wardId: row.wardId,
          bedId: row.bedId,
          admittedAt: row.admittedAt.toISOString()
        }
      });
      return row;
    }
  );

  app.patch('/api/admissions/:id', { preHandler: authenticate(ADMISSION_WRITE) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = admissionUpdateSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(admissions)
      .where(eq(admissions.id, id))
      .limit(1);
    if (!existing) throw notFound('Admission');

    const updates: Partial<typeof admissions.$inferInsert> = { updatedAt: new Date() };
    if (body.admittingComplaint !== undefined) updates.admittingComplaint = body.admittingComplaint;
    if (body.diagnosis !== undefined) updates.diagnosis = body.diagnosis;

    const isTransfer = body.wardId !== undefined || body.bedId !== undefined;
    if (isTransfer) {
      if (existing.dischargedAt) {
        throw badRequest('A discharged admission cannot be transferred.');
      }
      const targetWardId = body.wardId ?? existing.wardId;

      const [ward] = await db
        .select({ id: wards.id })
        .from(wards)
        .where(eq(wards.id, targetWardId))
        .limit(1);
      if (!ward) throw badRequest('Select a valid ward.');

      // The effective bed (the newly requested one, or the one already held)
      // must sit in the target ward — this forces ward and bed to move together.
      const effectiveBedId = body.bedId !== undefined ? body.bedId : existing.bedId;
      if (effectiveBedId) {
        const [bed] = await db
          .select({ id: beds.id, wardId: beds.wardId, status: beds.status })
          .from(beds)
          .where(eq(beds.id, effectiveBedId))
          .limit(1);
        if (!bed) throw badRequest('Select a valid bed.');
        if (bed.wardId !== targetWardId) {
          throw badRequest('That bed does not belong to the selected ward.');
        }
        if (bed.status === 'maintenance') {
          throw badRequest('That bed is under maintenance and cannot be assigned.');
        }
      }

      updates.wardId = targetWardId;
      if (body.bedId !== undefined) updates.bedId = body.bedId;
    }

    // Moving onto a bed already held by another open admission trips
    // admissions_one_open_per_bed → a 409, no pre-check.
    const [row] = await db
      .update(admissions)
      .set(updates)
      .where(eq(admissions.id, id))
      .returning();
    if (!row) throw notFound('Admission');

    const bedChanged = updates.bedId !== undefined && updates.bedId !== existing.bedId;
    await audit(request, {
      action: bedChanged ? 'admission.transferred' : 'admission.updated',
      entity: 'admission',
      entityId: id,
      data: {
        from: { wardId: existing.wardId, bedId: existing.bedId },
        to: { wardId: row.wardId, bedId: row.bedId }
      }
    });
    return row;
  });

  app.post(
    '/api/admissions/:id/discharge',
    { preHandler: authenticate(ADMISSION_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = dischargeSchema.parse(request.body);

      const [existing] = await db
        .select()
        .from(admissions)
        .where(eq(admissions.id, id))
        .limit(1);
      if (!existing) throw notFound('Admission');
      if (existing.dischargedAt || existing.status === 'discharged') {
        throw badRequest('This patient is already discharged.');
      }

      const updates: Partial<typeof admissions.$inferInsert> = {
        status: 'discharged',
        dischargedAt: new Date(),
        updatedAt: new Date()
      };
      if (body.dischargeSummary !== undefined) updates.dischargeSummary = body.dischargeSummary;
      if (body.diagnosis !== undefined) updates.diagnosis = body.diagnosis;

      // Setting dischargedAt clears the row from both partial unique indexes,
      // freeing the bed and the patient for the next admission.
      const [row] = await db
        .update(admissions)
        .set(updates)
        .where(eq(admissions.id, id))
        .returning();

      await audit(request, {
        action: 'admission.discharged',
        entity: 'admission',
        entityId: id,
        data: { patientId: row.patientId, dischargedAt: row.dischargedAt?.toISOString() }
      });
      return row;
    }
  );

  /* ---------------------------- Clinical notes ---------------------------- */

  app.post(
    '/api/admissions/:id/notes',
    { preHandler: authenticate(CLINICAL_ROLES) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = noteSchema.parse(request.body);

      const [admission] = await db
        .select({ patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, id))
        .limit(1);
      if (!admission) throw notFound('Admission');

      const [row] = await db
        .insert(clinicalNotes)
        .values({
          patientId: admission.patientId,
          staffId: request.currentUser!.id,
          admissionId: id,
          type: body.type,
          content: body.content
        })
        .returning();

      await audit(request, {
        action: 'note.created',
        entity: 'clinical_note',
        entityId: row.id,
        data: { admissionId: id, patientId: admission.patientId, type: row.type }
      });
      return {
        ...row,
        author: request.currentUser!.fullName
      };
    }
  );

  app.get('/api/notes/recent', { preHandler: authenticate(CLINICAL_ROLES) }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(20) })
      .parse(request.query);

    return db
      .select({
        id: clinicalNotes.id,
        type: clinicalNotes.type,
        content: clinicalNotes.content,
        createdAt: clinicalNotes.createdAt,
        patientId: clinicalNotes.patientId,
        patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
        patientMrn: patients.mrn,
        admissionId: clinicalNotes.admissionId,
        author: staff.fullName
      })
      .from(clinicalNotes)
      .innerJoin(patients, eq(clinicalNotes.patientId, patients.id))
      .leftJoin(staff, eq(clinicalNotes.staffId, staff.id))
      .orderBy(desc(clinicalNotes.createdAt))
      .limit(query.limit);
  });

  app.get(
    '/api/patients/:patientId/notes',
    { preHandler: authenticate(CLINICAL_ROLES) },
    async (request) => {
      const { patientId } = patientIdParam.parse(request.params);

      return db
        .select({
          id: clinicalNotes.id,
          type: clinicalNotes.type,
          content: clinicalNotes.content,
          createdAt: clinicalNotes.createdAt,
          admissionId: clinicalNotes.admissionId,
          authorId: clinicalNotes.staffId,
          author: staff.fullName
        })
        .from(clinicalNotes)
        .leftJoin(staff, eq(clinicalNotes.staffId, staff.id))
        .where(eq(clinicalNotes.patientId, patientId))
        .orderBy(desc(clinicalNotes.createdAt));
    }
  );

  app.get(
    '/api/patients/:patientId/vitals',
    { preHandler: authenticate(CLINICAL_ROLES) },
    async (request) => {
      const { patientId } = patientIdParam.parse(request.params);

      const rows = await db
        .select({
          id: vitalsRecords.id,
          patientId: vitalsRecords.patientId,
          admissionId: vitalsRecords.admissionId,
          temperatureC: vitalsRecords.temperatureC,
          pulse: vitalsRecords.pulse,
          respiratoryRate: vitalsRecords.respiratoryRate,
          spo2: vitalsRecords.spo2,
          bpSystolic: vitalsRecords.bpSystolic,
          bpDiastolic: vitalsRecords.bpDiastolic,
          weightKg: vitalsRecords.weightKg,
          heightCm: vitalsRecords.heightCm,
          recordedAt: vitalsRecords.recordedAt,
          recordedBy: vitalsRecords.recordedBy,
          recordedByName: staff.fullName
        })
        .from(vitalsRecords)
        .leftJoin(staff, eq(vitalsRecords.recordedBy, staff.id))
        .where(eq(vitalsRecords.patientId, patientId))
        .orderBy(desc(vitalsRecords.recordedAt));

      return rows.map(toVitalsDto);
    }
  );

  app.post(
    '/api/patients/:patientId/vitals',
    { preHandler: authenticate(VITALS_WRITE) },
    async (request) => {
      const { patientId } = patientIdParam.parse(request.params);
      const body = vitalsSchema.parse(request.body);

      const [patient] = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, patientId))
        .limit(1);
      if (!patient) throw badRequest('Select a valid patient.');

      const provided = VITAL_KEYS.filter((key) => body[key] !== undefined);
      if (provided.length === 0) {
        throw badRequest('Record at least one vital sign.');
      }

      for (const key of provided) {
        const value = body[key] as number;
        const { min, max, label } = VITAL_RANGES[key];
        if (value < min || value > max) {
          throw badRequest(`${label} must be between ${min} and ${max}.`);
        }
      }

      const [row] = await db
        .insert(vitalsRecords)
        .values({
          patientId,
          admissionId: body.admissionId ?? null,
          recordedBy: request.currentUser!.id,
          recordedAt: body.recordedAt ?? undefined,
          // NUMERIC columns are written as strings; the smallint columns take numbers.
          temperatureC: body.temperatureC !== undefined ? String(body.temperatureC) : undefined,
          weightKg: body.weightKg !== undefined ? String(body.weightKg) : undefined,
          heightCm: body.heightCm !== undefined ? String(body.heightCm) : undefined,
          pulse: body.pulse,
          respiratoryRate: body.respiratoryRate,
          spo2: body.spo2,
          bpSystolic: body.bpSystolic,
          bpDiastolic: body.bpDiastolic
        })
        .returning();

      await audit(request, {
        action: 'vitals.recorded',
        entity: 'vitals_record',
        entityId: row.id,
        data: { patientId, fields: provided }
      });
      return toVitalsDto(row);
    }
  );
}
