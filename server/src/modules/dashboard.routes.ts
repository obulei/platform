import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  admissions,
  appointments,
  auditLog,
  beds,
  invoices,
  invoiceItems,
  labOrders,
  medicines,
  patients,
  payments,
  prescriptions,
  staff,
  staffRoles
} from '../db/schema/index.js';
import {
  authenticate,
  ROLES,
  facilityDb
} from '../lib/auth.js';

/* postgres.js returns NUMERIC and COUNT(...) as strings; every value that
 * crosses into arithmetic or into JSON as a number is coerced here. */
function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** A local calendar day as a half-open [start, end) window. */
function dayWindow(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

/** YYYY-MM-DD in server local time — the default the manager's "today" means. */
function localDateStr(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const dateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.').optional()
});

export async function dashboardRoutes(app: FastifyInstance) {
  // Any signed-in role can see the operational snapshot — it exposes counts and
  // staff names, never patient free-text or clinical detail.
  app.addHook('preHandler', authenticate());

  app.get('/api/dashboard', async (request) => {
    const db = facilityDb(request);
    const { date } = dateSchema.parse(request.query);
    const isoDay = date ?? localDateStr(new Date());
    const { start: dayStart, end: dayEnd } = dayWindow(isoDay);

    const [
      apptAgg,
      newPatientsAgg,
      admissionsAgg,
      dischargesAgg,
      bedAgg,
      labAgg,
      pendingRxAgg,
      lowStockAgg,
      draftInvoiceAgg,
      itemsAgg,
      paymentsAgg,
      doctors,
      recentActivity
    ] = await Promise.all([
      // Every day-of-appointment count in one grouped scan over the day window.
      db
        .select({
          appointments: count(appointments.id),
          completed: sql<number>`count(*) filter (where ${appointments.status} = 'completed')::int`,
          cancelled: sql<number>`count(*) filter (where ${appointments.status} = 'cancelled')::int`,
          noShows: sql<number>`count(*) filter (where ${appointments.status} = 'no_show')::int`
        })
        .from(appointments)
        .where(and(gte(appointments.startsAt, dayStart), lt(appointments.startsAt, dayEnd))),
      db
        .select({ c: count() })
        .from(patients)
        .where(and(gte(patients.createdAt, dayStart), lt(patients.createdAt, dayEnd))),
      db
        .select({ c: count() })
        .from(admissions)
        .where(and(gte(admissions.admittedAt, dayStart), lt(admissions.admittedAt, dayEnd))),
      db
        .select({ c: count() })
        .from(admissions)
        .where(
          // postgres.js will not bind a Date in a raw sql fragment, so the
          // window is passed as an ISO string and cast by Postgres.
          sql`${admissions.dischargedAt} is not null and ${admissions.dischargedAt} >= ${dayStart.toISOString()} and ${admissions.dischargedAt} < ${dayEnd.toISOString()}`
        ),
      // Occupancy comes from OPEN admissions, not from beds.status: a bed counts
      // as occupied only while an admission on it has no discharge. The join is
      // safe because admissions_one_open_per_bed caps each bed at one open row.
      // (A correlated EXISTS would not work — Drizzle emits ${beds.id} unqualified
      // as "id", which Postgres then resolves to the *inner* admissions row.)
      db
        .select({
          total: count(beds.id),
          occupied: sql<number>`count(${admissions.id})::int`,
          maintenance: sql<number>`count(*) filter (where ${beds.status} = 'maintenance')::int`,
          available: sql<number>`count(*) filter (where ${admissions.id} is null and ${beds.status} <> 'maintenance')::int`
        })
        .from(beds)
        .leftJoin(admissions, and(isNull(admissions.dischargedAt), eq(admissions.bedId, beds.id))),
      // Pending (not completed/cancelled) and urgent lab orders — one scan.
      db
        .select({
          pending: sql<number>`count(*) filter (where ${labOrders.status} = 'pending')::int`,
          urgent: sql<number>`count(*) filter (where ${labOrders.priority} = 'urgent' and ${labOrders.status} not in ('completed','cancelled'))::int`
        })
        .from(labOrders),
      db
        .select({ c: count() })
        .from(prescriptions)
        .where(eq(prescriptions.status, 'pending')),
      db
        .select({ c: count() })
        .from(medicines)
        .where(and(eq(medicines.isActive, true), sql`${medicines.stock} <= ${medicines.reorderLevel}`)),
      db
        .select({ c: count() })
        .from(invoices)
        .where(eq(invoices.status, 'draft')),
      // Outstanding balance = (issued/partial item subtotals) - (their payments),
      // each a single aggregate over invoices joined on status, summed once.
      db
        .select({ total: sql<string>`coalesce(sum(${invoiceItems.quantity} * ${invoiceItems.unitPrice}), 0)::text` })
        .from(invoiceItems)
        .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
        .where(inArray(invoices.status, ['issued', 'partial'])),
      db
        .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(inArray(invoices.status, ['issued', 'partial'])),
      db
        .select({ id: staff.id, fullName: staff.fullName, specialty: staff.specialty })
        .from(staff)
        .where(
          and(
            eq(staff.isActive, true),
            inArray(
              staff.id,
              db.select({ id: staffRoles.staffId }).from(staffRoles).where(eq(staffRoles.role, ROLES.doctor))
            )
          )
        )
        .orderBy(asc(staff.fullName)),
      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entity: auditLog.entity,
          staffName: staff.fullName,
          createdAt: auditLog.createdAt
        })
        .from(auditLog)
        .leftJoin(staff, eq(auditLog.staffId, staff.id))
        .orderBy(desc(auditLog.createdAt))
        .limit(10)
    ]);

    const bedTotal = num(bedAgg[0]?.total);
    const bedOccupied = num(bedAgg[0]?.occupied);
    const bedMaintenance = num(bedAgg[0]?.maintenance);
    const available = num(bedAgg[0]?.available);
    const rate = bedTotal > 0 ? round1((bedOccupied / bedTotal) * 100) : 0;

    // Per-clinician bookings for the day: ids only, so a manager can see busy vs idle.
    const doctorIds = doctors.map((doctor) => doctor.id);
    let clinicianAppointmentRows: { staffId: string; id: string }[] = [];
    if (doctorIds.length) {
      clinicianAppointmentRows = await db
        .select({ staffId: appointments.staffId, id: appointments.id })
        .from(appointments)
        .where(
          and(
            inArray(appointments.staffId, doctorIds),
            gte(appointments.startsAt, dayStart),
            lt(appointments.startsAt, dayEnd)
          )
        )
        .orderBy(appointments.startsAt);
    }
    const idsByDoctor = new Map<string, string[]>();
    for (const row of clinicianAppointmentRows) {
      const list = idsByDoctor.get(row.staffId);
      if (list) list.push(row.id);
      else idsByDoctor.set(row.staffId, [row.id]);
    }

    return {
      today: {
        date: isoDay,
        appointments: num(apptAgg[0]?.appointments),
        completed: num(apptAgg[0]?.completed),
        cancelled: num(apptAgg[0]?.cancelled),
        noShows: num(apptAgg[0]?.noShows),
        newPatients: num(newPatientsAgg[0]?.c),
        admissions: num(admissionsAgg[0]?.c),
        discharges: num(dischargesAgg[0]?.c)
      },
      occupancy: {
        beds: bedTotal,
        occupied: bedOccupied,
        available,
        maintenance: bedMaintenance,
        rate
      },
      workload: {
        pendingLabOrders: num(labAgg[0]?.pending),
        urgentLabOrders: num(labAgg[0]?.urgent),
        pendingPrescriptions: num(pendingRxAgg[0]?.c),
        lowStockMedicines: num(lowStockAgg[0]?.c),
        draftInvoices: num(draftInvoiceAgg[0]?.c),
        unpaidInvoiceTotal: round1(num(itemsAgg[0]?.total) - num(paymentsAgg[0]?.total))
      },
      byClinician: doctors.map((doctor) => {
        const appointmentIds = idsByDoctor.get(doctor.id) ?? [];
        return {
          id: doctor.id,
          fullName: doctor.fullName,
          specialty: doctor.specialty,
          booked: appointmentIds.length,
          appointmentIds
        };
      }),
      recentActivity: recentActivity.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entity,
        staffName: row.staffName,
        createdAt: row.createdAt
      }))
    };
  });

  /**
   * Bed-days occupied vs total capacity for the last N days (oldest first), so
   * a trend chart can be drawn. A bed counts as occupied on a day when an
   * admission overlapped that day (open at admission start, still open, or
   * discharged on/after the day start). Three queries regardless of N:
   *   1) a generate_series day spine LEFT JOINed to overlapping admissions,
   *   2) the bed count as the flat capacity denominator.
   */
  app.get('/api/dashboard/occupancy-history', async (request) => {
    const db = facilityDb(request);
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(30).default(7) })
      .parse(request.query);

    const { start: todayStart } = dayWindow(localDateStr(new Date()));
    const windowStart = new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60_000);

    // Drizzle would render ${admissions.admittedAt} as "admissions"."admitted_at",
    // which Postgres rejects once the table is aliased to `a` below.
    const dayRows = (await db.execute(sql`
      select to_char(d, 'YYYY-MM-DD') as date, count(a.id)::int as occupied
      from generate_series(${windowStart.toISOString()}::timestamptz, ${todayStart.toISOString()}::timestamptz, interval '1 day') as d
      left join ${admissions} a
        on a.admitted_at < (d + interval '1 day')
        and (a.discharged_at is null or a.discharged_at >= d)
      group by d
      order by d
    `)) as unknown as { date: string; occupied: number | string }[];

    const [{ total: capacity }] = await db.select({ total: count(beds.id) }).from(beds);
    const capacityNum = num(capacity);

    return {
      days,
      capacity: capacityNum,
      items: dayRows.map((row) => ({
        date: row.date,
        occupied: num(row.occupied),
        capacity: capacityNum
      }))
    };
  });
}
