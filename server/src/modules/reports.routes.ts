import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  admissions,
  appointments,
  beds,
  clinicalReports,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  medicines,
  patients,
  prescriptionItems,
  prescriptions,
  staff,
  vitalsRecords,
  wards
} from '../db/schema/index.js';
import {
  authenticate,
  CLINICAL_ROLES,
  PATIENT_RECORD_READ,
  ROLES,
  facilityDb
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { moneyOrNull } from '../lib/serialize.js';
import { ageFromBirthDate } from './patients.routes.js';

/**
 * A report is the document a doctor signs, so authoring follows the same rule
 * as prescribing. Reading the body follows the clinical-note rule: care roles
 * only. Anyone who may read the patient record sees the index of titles.
 */
const REPORT_AUTHORS = [ROLES.admin, ROLES.doctor];

const idParam = z.object({ id: z.string().uuid() });

const reportFields = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().nullish(),
  admissionId: z.string().uuid().nullish(),
  title: z.string().min(3).max(160),
  findings: z.string().min(3).max(8000),
  diagnosis: z.string().min(2).max(600),
  plan: z.string().max(6000).nullish(),
  advice: z.string().max(6000).nullish()
});

/** One report speaks for one encounter, so the two ids are mutually exclusive. */
const notBothEncounters = (value: { appointmentId?: string | null; admissionId?: string | null }) =>
  !(value.appointmentId && value.admissionId);

const createSchema = reportFields.refine(notBothEncounters, {
  message: 'Attach this report to one encounter: an appointment or an admission, not both.',
  path: ['appointmentId']
});

const updateSchema = reportFields
  .omit({ patientId: true })
  .partial()
  .refine(notBothEncounters, {
    message: 'Attach this report to one encounter: an appointment or an admission, not both.',
    path: ['appointmentId']
  });

type ReportRow = typeof clinicalReports.$inferSelect;

const dto = (row: ReportRow) => ({
  id: row.id,
  patientId: row.patientId,
  appointmentId: row.appointmentId,
  admissionId: row.admissionId,
  authorId: row.authorId,
  title: row.title,
  findings: row.findings,
  diagnosis: row.diagnosis,
  plan: row.plan,
  advice: row.advice,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

/** NUMERIC arrives as a string; the printed chart must not carry that through. */
function vitalView(row: {
  id: string;
  recordedAt: Date;
  recordedBy: string | null;
  temperatureC: string | number | null;
  pulse: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  weightKg: string | number | null;
  heightCm: string | number | null;
}) {
  return {
    ...row,
    temperatureC: moneyOrNull(row.temperatureC),
    weightKg: moneyOrNull(row.weightKg),
    heightCm: moneyOrNull(row.heightCm)
  };
}

/** One prescribed medicine line on the printed document. */
type ReportMedicineItem = {
  id: string;
  medicineName: string;
  genericName: string | null;
  form: string;
  strength: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  instructions: string | null;
};

type ReportPrescription = {
  id: string;
  prescribedAt: Date;
  status: string;
  prescriber: string | null;
  notes: string | null;
  items: ReportMedicineItem[];
};

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  /** Index of reports, newest first. Bodies need a care role. */
  app.get('/api/reports', { preHandler: authenticate(PATIENT_RECORD_READ) }, async (request) => {
    const db = facilityDb(request);
    const query = z
      .object({
        patientId: z.string().uuid().optional(),
        appointmentId: z.string().uuid().optional(),
        admissionId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      })
      .parse(request.query);

    const rows = await db
      .select({
        id: clinicalReports.id,
        patientId: clinicalReports.patientId,
        appointmentId: clinicalReports.appointmentId,
        admissionId: clinicalReports.admissionId,
        title: clinicalReports.title,
        createdAt: clinicalReports.createdAt,
        authorName: staff.fullName,
        givenName: patients.givenName,
        familyName: patients.familyName,
        mrn: patients.mrn
      })
      .from(clinicalReports)
      .leftJoin(staff, eq(clinicalReports.authorId, staff.id))
      .innerJoin(patients, eq(clinicalReports.patientId, patients.id))
      .where(
        and(
          query.patientId ? eq(clinicalReports.patientId, query.patientId) : undefined,
          query.appointmentId ? eq(clinicalReports.appointmentId, query.appointmentId) : undefined,
          query.admissionId ? eq(clinicalReports.admissionId, query.admissionId) : undefined
        )
      )
      .orderBy(desc(clinicalReports.createdAt))
      .limit(query.limit);

    return rows.map((row) => ({
      id: row.id,
      patientId: row.patientId,
      patientName: `${row.givenName} ${row.familyName}`.trim(),
      mrn: row.mrn,
      appointmentId: row.appointmentId,
      admissionId: row.admissionId,
      title: row.title,
      createdAt: row.createdAt,
      authorName: row.authorName
    }));
  });

  /**
   * The whole document in one call, so the printed page and the on-screen
   * report can never disagree: the report, who signed it, the patient, the
   * encounter it answers, and the observations, verified results and
   * prescriptions taken during it.
   */
  app.get('/api/reports/:id', { preHandler: authenticate(CLINICAL_ROLES) }, async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);

    const [report] = await db.select().from(clinicalReports).where(eq(clinicalReports.id, id)).limit(1);
    if (!report) throw notFound('Report');

    const [patientRow] = await db.select().from(patients).where(eq(patients.id, report.patientId)).limit(1);
    if (!patientRow) throw notFound('Patient');

    const [author] = await db
      .select({
        fullName: staff.fullName,
        email: staff.email,
        department: staff.department,
        specialty: staff.specialty
      })
      .from(staff)
      .where(eq(staff.id, report.authorId))
      .limit(1);

    // When the report belongs to an admission, its evidence is that stay's
    // evidence. A clinic visit or a free-standing report covers the record.
    const stayId = report.admissionId ?? null;

    const [appointmentRow, admissionRow, vitalRows, labRows, itemRows] = await Promise.all([
      report.appointmentId
        ? db
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
            .where(eq(appointments.id, report.appointmentId))
            .limit(1)
        : Promise.resolve([]),
      report.admissionId
        ? db
            .select({
              id: admissions.id,
              admittedAt: admissions.admittedAt,
              dischargedAt: admissions.dischargedAt,
              status: admissions.status,
              complaint: admissions.admittingComplaint,
              diagnosis: admissions.diagnosis,
              wardName: wards.name,
              bedLabel: beds.label,
              attending: staff.fullName
            })
            .from(admissions)
            .leftJoin(wards, eq(admissions.wardId, wards.id))
            .leftJoin(beds, eq(admissions.bedId, beds.id))
            .leftJoin(staff, eq(admissions.attendingStaffId, staff.id))
            .where(eq(admissions.id, report.admissionId))
            .limit(1)
        : Promise.resolve([]),
      db
        .select({
          id: vitalsRecords.id,
          recordedAt: vitalsRecords.recordedAt,
          recordedBy: staff.fullName,
          temperatureC: vitalsRecords.temperatureC,
          pulse: vitalsRecords.pulse,
          respiratoryRate: vitalsRecords.respiratoryRate,
          spo2: vitalsRecords.spo2,
          bpSystolic: vitalsRecords.bpSystolic,
          bpDiastolic: vitalsRecords.bpDiastolic,
          weightKg: vitalsRecords.weightKg,
          heightCm: vitalsRecords.heightCm
        })
        .from(vitalsRecords)
        .leftJoin(staff, eq(vitalsRecords.recordedBy, staff.id))
        .where(and(eq(vitalsRecords.patientId, report.patientId), stayId ? eq(vitalsRecords.admissionId, stayId) : undefined))
        .orderBy(desc(vitalsRecords.recordedAt))
        .limit(10),
      db
        .select({
          id: labResults.id,
          valueNumeric: labResults.valueNumeric,
          valueText: labResults.valueText,
          unit: labResults.unit,
          flag: labResults.flag,
          comment: labResults.comment,
          resultedAt: labResults.resultedAt,
          testName: labTests.name,
          testCode: labTests.code,
          referenceText: labTests.referenceText,
          verifiedBy: staff.fullName
        })
        .from(labResults)
        .innerJoin(labOrderItems, eq(labResults.labOrderItemId, labOrderItems.id))
        .innerJoin(labOrders, eq(labOrderItems.labOrderId, labOrders.id))
        .innerJoin(labTests, eq(labOrderItems.labTestId, labTests.id))
        .leftJoin(staff, eq(labResults.verifiedBy, staff.id))
        .where(
          and(
            eq(labOrders.patientId, report.patientId),
            // Only countersigned results belong on a signed report.
            isNotNull(labResults.verifiedBy),
            stayId ? eq(labOrders.admissionId, stayId) : undefined
          )
        )
        .orderBy(desc(labResults.resultedAt))
        .limit(30),
      db
        .select({
          prescriptionId: prescriptions.id,
          prescribedAt: prescriptions.createdAt,
          prescriptionStatus: prescriptions.status,
          prescriber: staff.fullName,
          notes: prescriptions.notes,
          itemId: prescriptionItems.id,
          medicineName: medicines.name,
          genericName: medicines.genericName,
          form: medicines.form,
          strength: medicines.strength,
          dosage: prescriptionItems.dosage,
          frequency: prescriptionItems.frequency,
          durationDays: prescriptionItems.durationDays,
          quantity: prescriptionItems.quantity,
          instructions: prescriptionItems.instructions
        })
        .from(prescriptions)
        .innerJoin(prescriptionItems, eq(prescriptionItems.prescriptionId, prescriptions.id))
        .innerJoin(medicines, eq(prescriptionItems.medicineId, medicines.id))
        .leftJoin(staff, eq(prescriptions.prescriberId, staff.id))
        .where(
          and(
            eq(prescriptions.patientId, report.patientId),
            report.appointmentId ? eq(prescriptions.appointmentId, report.appointmentId) : undefined,
            stayId ? eq(prescriptions.admissionId, stayId) : undefined
          )
        )
        .orderBy(desc(prescriptions.createdAt), desc(prescriptionItems.createdAt))
        .limit(60)
    ]);

    const medicinesByRx = new Map<string, ReportPrescription>();
    for (const row of itemRows) {
      const rx =
        medicinesByRx.get(row.prescriptionId) ??
        {
          id: row.prescriptionId,
          prescribedAt: row.prescribedAt,
          status: row.prescriptionStatus,
          prescriber: row.prescriber,
          notes: row.notes,
          items: []
        };
      rx.items.push({
        id: row.itemId,
        medicineName: row.medicineName,
        genericName: row.genericName,
        form: row.form,
        strength: row.strength,
        dosage: row.dosage,
        frequency: row.frequency,
        durationDays: row.durationDays,
        quantity: row.quantity,
        instructions: row.instructions
      });
      medicinesByRx.set(row.prescriptionId, rx);
    }

    return {
      ...dto(report),
      author: author ?? null,
      patient: {
        id: patientRow.id,
        mrn: patientRow.mrn,
        fullName: `${patientRow.givenName} ${patientRow.familyName}`,
        birthDate: patientRow.birthDate,
        age: ageFromBirthDate(patientRow.birthDate),
        gender: patientRow.gender,
        bloodGroup: patientRow.bloodGroup,
        allergies: patientRow.allergies,
        chronicConditions: patientRow.chronicConditions,
        phone: patientRow.phone
      },
      appointment: appointmentRow[0] ?? null,
      admission: admissionRow[0] ?? null,
      vitals: vitalRows.map(vitalView),
      labResults: labRows.map((row) => ({
        ...row,
        valueNumeric: moneyOrNull(row.valueNumeric)
      })),
      prescriptions: [...medicinesByRx.values()]
    };
  });

  app.post('/api/reports', { preHandler: authenticate(REPORT_AUTHORS) }, async (request) => {
    const db = facilityDb(request);
    const body = createSchema.parse(request.body);

    const [patientRow] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, body.patientId))
      .limit(1);
    if (!patientRow) throw badRequest('Select a valid patient.');

    // Nothing in the schema ties a report to an encounter of the same patient,
    // so the link is checked here rather than trusted from the client.
    if (body.appointmentId) {
      const [row] = await db
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(eq(appointments.id, body.appointmentId))
        .limit(1);
      if (!row) throw badRequest('Appointment not found.');
      if (row.patientId !== body.patientId) throw badRequest('That appointment belongs to another patient.');
    }
    if (body.admissionId) {
      const [row] = await db
        .select({ patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, body.admissionId))
        .limit(1);
      if (!row) throw badRequest('Admission not found.');
      if (row.patientId !== body.patientId) throw badRequest('That admission belongs to another patient.');
    }

    const [row] = await db
      .insert(clinicalReports)
      .values({
        patientId: body.patientId,
        appointmentId: body.appointmentId ?? null,
        admissionId: body.admissionId ?? null,
        authorId: request.currentUser!.id,
        title: body.title,
        findings: body.findings,
        diagnosis: body.diagnosis,
        plan: body.plan ?? null,
        advice: body.advice ?? null
      })
      .returning();

    await audit(request, {
      action: 'report.created',
      entity: 'clinical_report',
      entityId: row.id,
      data: { patientId: row.patientId, diagnosis: row.diagnosis }
    });
    return dto(row);
  });

  app.patch('/api/reports/:id', { preHandler: authenticate(REPORT_AUTHORS) }, async (request) => {
    const db = facilityDb(request);
    const { id } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);

    const [existing] = await db.select().from(clinicalReports).where(eq(clinicalReports.id, id)).limit(1);
    if (!existing) throw notFound('Report');

    // An amended report stays with the clinician who signed the original;
    // administrators may correct a record but never impersonate an author.
    if (existing.authorId !== request.currentUser!.id && request.currentUser!.role !== ROLES.admin) {
      throw forbidden('Only the clinician who signed this report, or an administrator, may amend it.');
    }

    if (body.appointmentId && body.appointmentId !== existing.appointmentId) {
      const [row] = await db
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(eq(appointments.id, body.appointmentId))
        .limit(1);
      if (!row || row.patientId !== existing.patientId) throw badRequest('That appointment belongs to another patient.');
    }
    if (body.admissionId && body.admissionId !== existing.admissionId) {
      const [row] = await db
        .select({ patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, body.admissionId))
        .limit(1);
      if (!row || row.patientId !== existing.patientId) throw badRequest('That admission belongs to another patient.');
    }

    const [row] = await db
      .update(clinicalReports)
      .set({
        ...body,
        appointmentId: body.appointmentId === undefined ? undefined : (body.appointmentId ?? null),
        admissionId: body.admissionId === undefined ? undefined : (body.admissionId ?? null),
        plan: body.plan === undefined ? undefined : (body.plan ?? null),
        advice: body.advice === undefined ? undefined : (body.advice ?? null),
        updatedAt: new Date()
      })
      .where(eq(clinicalReports.id, id))
      .returning();

    await audit(request, {
      action: 'report.updated',
      entity: 'clinical_report',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return dto(row);
  });
}
