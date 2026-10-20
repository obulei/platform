import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  admissions,
  appointments,
  beds,
  clinicalNotes,
  invoices,
  labOrders,
  patients,
  prescriptions,
  staff,
  wards
} from '../db/schema/index.js';
import {
  authenticate,
  facilityDb,
  CLINICAL_ROLES,
  PATIENT_RECORD_READ,
  PATIENT_RECORD_WRITE
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

type PatientRow = typeof patients.$inferSelect;

const demographics = z.object({
  givenName: z.string().min(1).max(120),
  familyName: z.string().min(1).max(120),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.').nullish(),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  bloodGroup: z.string().max(8).nullish(),
  phone: z.string().max(40).nullish(),
  email: z.string().email().nullish(),
  address: z.string().max(400).nullish(),
  allergies: z.string().max(1000).nullish(),
  chronicConditions: z.string().max(1000).nullish(),
  emergencyContactName: z.string().max(160).nullish(),
  emergencyContactPhone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish()
});

const createSchema = demographics.extend({
  status: z.enum(['active', 'inactive', 'deceased']).default('active')
});

function toDto(row: PatientRow) {
  return {
    id: row.id,
    mrn: row.mrn,
    givenName: row.givenName,
    familyName: row.familyName,
    fullName: `${row.givenName} ${row.familyName}`,
    birthDate: row.birthDate,
    gender: row.gender,
    bloodGroup: row.bloodGroup,
    phone: row.phone,
    email: row.email,
    address: row.address,
    allergies: row.allergies,
    chronicConditions: row.chronicConditions,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt
  };
}

export function ageFromBirthDate(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

const idParam = z.object({ id: z.string().uuid() });

export async function patientRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate(PATIENT_RECORD_READ));

  app.get('/api/patients', async (request) => {
    const db = facilityDb(request);
    const query = z
      .object({
        q: z.string().max(120).optional(),
        status: z.enum(['active', 'inactive', 'deceased']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.status) filters.push(eq(patients.status, query.status));
    if (query.q) {
      const term = `%${query.q}%`;
      filters.push(
        or(
          ilike(patients.givenName, term),
          ilike(patients.familyName, term),
          ilike(patients.mrn, term),
          ilike(patients.phone, term)
        )!
      );
    }
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select()
      .from(patients)
      .where(where)
      .orderBy(desc(patients.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.select({ total: count() }).from(patients).where(where);

    return {
      items: rows.map((row) => ({ ...toDto(row), age: ageFromBirthDate(row.birthDate) })),
      total: Number(total),
      offset: query.offset,
      limit: query.limit
    };
  });

  app.get('/api/patients/:id', async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);
    const [row] = await db.select().from(patients).where(eq(patients.id, id)).limit(1);
    if (!row) throw notFound('Patient');

    const [openAdmission] = await db
      .select({
        id: admissions.id,
        wardId: admissions.wardId,
        wardName: wards.name,
        bedLabel: beds.label,
        complaint: admissions.admittingComplaint
      })
      .from(admissions)
      .leftJoin(wards, eq(admissions.wardId, wards.id))
      .leftJoin(beds, eq(admissions.bedId, beds.id))
      .where(and(eq(admissions.patientId, id), sql`${admissions.dischargedAt} is null`))
      .limit(1);

    const [{ visits }] = await db
      .select({ visits: count() })
      .from(appointments)
      .where(and(eq(appointments.patientId, id), eq(appointments.status, 'completed')));

    return {
      ...toDto(row),
      age: ageFromBirthDate(row.birthDate),
      completedVisits: Number(visits),
      openAdmission: openAdmission ?? null
    };
  });

  /**
   * Longitudinal record. Clinical free-text is attached only for care roles;
   * reception and billing get the administrative skeleton of the same timeline.
   */
  app.get('/api/patients/:id/history', async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);
    const [patient] = await db.select().from(patients).where(eq(patients.id, id)).limit(1);
    if (!patient) throw notFound('Patient');

    const canSeeClinical = CLINICAL_ROLES.includes(request.currentUser!.role);

    const [appointmentRows, admissionRows, prescriptionRows, labOrderRows, invoiceRows, noteRows] =
      await Promise.all([
        db
          .select({
            id: appointments.id,
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            status: appointments.status,
            reason: appointments.reason,
            clinician: staff.fullName
          })
          .from(appointments)
          .leftJoin(staff, eq(appointments.staffId, staff.id))
          .where(eq(appointments.patientId, id))
          .orderBy(desc(appointments.startsAt))
          .limit(40),
        db
          .select({
            id: admissions.id,
            admittedAt: admissions.admittedAt,
            dischargedAt: admissions.dischargedAt,
            status: admissions.status,
            complaint: admissions.admittingComplaint,
            diagnosis: admissions.diagnosis,
            wardName: wards.name
          })
          .from(admissions)
          .leftJoin(wards, eq(admissions.wardId, wards.id))
          .where(eq(admissions.patientId, id))
          .orderBy(desc(admissions.admittedAt))
          .limit(40),
        db
          .select({
            id: prescriptions.id,
            createdAt: prescriptions.createdAt,
            status: prescriptions.status,
            prescriber: staff.fullName
          })
          .from(prescriptions)
          .leftJoin(staff, eq(prescriptions.prescriberId, staff.id))
          .where(eq(prescriptions.patientId, id))
          .orderBy(desc(prescriptions.createdAt))
          .limit(40),
        db
          .select({
            id: labOrders.id,
            orderedAt: labOrders.orderedAt,
            status: labOrders.status,
            priority: labOrders.priority,
            orderedBy: staff.fullName
          })
          .from(labOrders)
          .leftJoin(staff, eq(labOrders.orderingStaffId, staff.id))
          .where(eq(labOrders.patientId, id))
          .orderBy(desc(labOrders.orderedAt))
          .limit(40),
        db
          .select({
            id: invoices.id,
            number: invoices.number,
            status: invoices.status,
            createdAt: invoices.createdAt
          })
          .from(invoices)
          .where(eq(invoices.patientId, id))
          .orderBy(desc(invoices.createdAt))
          .limit(40),
        canSeeClinical
          ? db
              .select({
                id: clinicalNotes.id,
                createdAt: clinicalNotes.createdAt,
                type: clinicalNotes.type,
                content: clinicalNotes.content,
                author: staff.fullName
              })
              .from(clinicalNotes)
              .leftJoin(staff, eq(clinicalNotes.staffId, staff.id))
              .where(eq(clinicalNotes.patientId, id))
              .orderBy(desc(clinicalNotes.createdAt))
              .limit(60)
          : Promise.resolve([] as { id: string }[])
      ]);

    return {
      patient: { ...toDto(patient), age: ageFromBirthDate(patient.birthDate) },
      appointments: appointmentRows,
      admissions: admissionRows,
      prescriptions: prescriptionRows,
      labOrders: labOrderRows,
      invoices: invoiceRows,
      clinicalNotes: noteRows
    };
  });

  app.post('/api/patients', async (request) => {
    const db = facilityDb(request);
    const body = createSchema.parse(request.body);
    const [row] = await db
      .insert(patients)
      .values({ ...body, createdBy: request.currentUser!.id })
      .returning();

    await audit(request, {
      action: 'patient.created',
      entity: 'patient',
      entityId: row.id,
      data: { mrn: row.mrn, name: `${row.givenName} ${row.familyName}` }
    });
    return toDto(row);
  });

  app.patch('/api/patients/:id', async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);
    const body = demographics
      .extend({ status: z.enum(['active', 'inactive', 'deceased']).optional() })
      .partial()
      .parse(request.body);

    const [row] = await db
      .update(patients)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(patients.id, id))
      .returning();
    if (!row) throw notFound('Patient');

    await audit(request, {
      action: 'patient.updated',
      entity: 'patient',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return toDto(row);
  });
}
