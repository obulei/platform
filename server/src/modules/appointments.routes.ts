import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appointments, patients, staff } from '../db/schema/index.js';
import type { appointmentStatus } from '../db/schema/enums.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { money, moneyOrNull } from '../lib/serialize.js';

type Status = (typeof appointmentStatus.enumValues)[number];

const WRITE_ROLES = [ROLES.admin, ROLES.reception, ROLES.doctor, ROLES.nurse];

const createSchema = z
  .object({
    patientId: z.string().uuid(),
    staffId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().min(3).max(300),
    notes: z.string().max(1000).nullish(),
    status: z.enum(['scheduled', 'confirmed']).default('scheduled')
  })
  .refine((value) => value.endsAt.getTime() - value.startsAt.getTime() >= 5 * 60_000, {
    message: 'Appointments must be at least 5 minutes long.',
    path: ['endsAt']
  })
  .refine((value) => value.endsAt.getTime() - value.startsAt.getTime() <= 12 * 60 * 60_000, {
    message: 'Appointments may not exceed 12 hours.',
    path: ['endsAt']
  });

const toDto = (row: typeof appointments.$inferSelect & { patientName?: string; clinicianName?: string; clinicianSpecialty?: string }) => ({
  id: row.id,
  patientId: row.patientId,
  staffId: row.staffId,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
  reason: row.reason,
  notes: row.notes,
  fee: moneyOrNull(row.fee),
  patientName: row.patientName,
  clinicianName: row.clinicianName,
  clinicianSpecialty: row.clinicianSpecialty
});

const selectWithNames = () =>
  db
    .select({
      appointment: appointments,
      patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
      patientMrn: patients.mrn,
      clinicianName: staff.fullName,
      clinicianSpecialty: staff.specialty
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(staff, eq(appointments.staffId, staff.id));

export async function appointmentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  app.get('/api/appointments', async (request) => {
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        staffId: z.string().uuid().optional(),
        patientId: z.string().uuid().optional(),
        status: z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200)
      })
      .parse(request.query);

    const filters = [];
    if (query.date) {
      const dayStart = new Date(`${query.date}T00:00:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
      filters.push(gte(appointments.startsAt, dayStart), lt(appointments.startsAt, dayEnd));
    } else {
      if (query.from) filters.push(gte(appointments.startsAt, query.from));
      if (query.to) filters.push(lt(appointments.startsAt, query.to));
    }
    if (query.staffId) filters.push(eq(appointments.staffId, query.staffId));
    if (query.patientId) filters.push(eq(appointments.patientId, query.patientId));
    if (query.status) filters.push(eq(appointments.status, query.status));

    const where = filters.length ? and(...filters) : undefined;
    const rows = await selectWithNames()
      .where(where)
      .orderBy(asc(appointments.startsAt))
      .limit(query.limit);

    return rows.map((row) => ({ ...toDto(row.appointment), patientMrn: row.patientMrn, patientName: row.patientName, clinicianName: row.clinicianName, clinicianSpecialty: row.clinicianSpecialty }));
  });

  /** Bookings for one clinician on one day — the data behind the day board. */
  app.get('/api/appointments/schedule', async (request) => {
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        staffId: z.string().uuid().optional()
      })
      .parse(request.query);

    const dayStart = new Date(`${query.date}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

    const clinicians = await db
      .select({
        id: staff.id,
        fullName: staff.fullName,
        specialty: staff.specialty,
        consultationFee: staff.consultationFee,
        booked: count(appointments.id)
      })
      .from(staff)
      .leftJoin(
        appointments,
        and(
          eq(appointments.staffId, staff.id),
          gte(appointments.startsAt, dayStart),
          lt(appointments.startsAt, dayEnd),
          sql`${appointments.status} in ('scheduled','confirmed')`
        )
      )
      .where(
        and(
          eq(staff.isActive, true),
          query.staffId ? eq(staff.id, query.staffId) : undefined,
          query.staffId ? undefined : or(eq(staff.role, ROLES.doctor), eq(staff.role, ROLES.nurse))
        )
      )
      .groupBy(staff.id);

    return clinicians.map((row) => ({
      ...row,
      consultationFee: money(row.consultationFee),
      booked: Number(row.booked)
    }));
  });

  app.get('/api/appointments/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await selectWithNames().where(eq(appointments.id, id)).limit(1);
    if (!row) throw notFound('Appointment');
    return toDto(row.appointment);
  });

  app.post('/api/appointments', { preHandler: authenticate(WRITE_ROLES) }, async (request) => {
    const body = createSchema.parse(request.body);

    const [patient] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, body.patientId))
      .limit(1);
    if (!patient) throw badRequest('Select a valid patient.');

    const [clinician] = await db
      .select({ id: staff.id, role: staff.role, isActive: staff.isActive, fee: staff.consultationFee })
      .from(staff)
      .where(eq(staff.id, body.staffId))
      .limit(1);
    if (!clinician || !clinician.isActive) throw badRequest('Select an active clinician.');

    // Overlaps are resolved by the database exclusion constraint, not a
    // pre-check, so two clerks cannot book the same slot simultaneously.
    const [row] = await db
      .insert(appointments)
      .values({
        patientId: body.patientId,
        staffId: body.staffId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        reason: body.reason,
        notes: body.notes ?? null,
        status: body.status,
        fee: clinician.fee,
        createdBy: request.currentUser!.id
      })
      .returning();

    await audit(request, {
      action: 'appointment.created',
      entity: 'appointment',
      entityId: row.id,
      data: { patientId: row.patientId, staffId: row.staffId, startsAt: row.startsAt.toISOString() }
    });
    return toDto(row);
  });

  const statusSchema = z.object({
    status: z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']),
    cancelReason: z.string().max(300).nullish()
  });

  app.patch('/api/appointments/:id/status', { preHandler: authenticate(WRITE_ROLES) }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = statusSchema.parse(request.body);

    const [existing] = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
    if (!existing) throw notFound('Appointment');
    if (existing.status === 'cancelled') throw badRequest('This appointment is already cancelled.');

    const closing = body.status === 'cancelled' || body.status === 'no_show';
    const [row] = await db
      .update(appointments)
      .set({
        status: body.status,
        cancelledAt: closing ? new Date() : existing.cancelledAt,
        cancelReason: closing ? (body.cancelReason ?? null) : existing.cancelReason,
        updatedAt: new Date()
      })
      .where(eq(appointments.id, id))
      .returning();

    await audit(request, {
      action: `appointment.${body.status}`,
      entity: 'appointment',
      entityId: id,
      data: { from: existing.status, to: body.status }
    });
    return toDto(row);
  });

  const rescheduleSchema = z
    .object({ startsAt: z.coerce.date(), endsAt: z.coerce.date(), staffId: z.string().uuid().optional() })
    .refine((v) => v.endsAt > v.startsAt, { message: 'End time must be after the start time.' });

  app.patch('/api/appointments/:id', { preHandler: authenticate(WRITE_ROLES) }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = rescheduleSchema.parse(request.body);

    const updates: Partial<typeof appointments.$inferInsert> = {
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      updatedAt: new Date()
    };
    if (body.staffId) updates.staffId = body.staffId;

    const [row] = await db
      .update(appointments)
      .set(updates)
      .where(and(eq(appointments.id, id), isNull(appointments.cancelledAt)))
      .returning();
    if (!row) throw badRequest('Only open appointments can be rescheduled.');

    await audit(request, {
      action: 'appointment.rescheduled',
      entity: 'appointment',
      entityId: id,
      data: { startsAt: row.startsAt.toISOString(), staffId: row.staffId }
    });
    return toDto(row);
  });
}

export type { Status };
