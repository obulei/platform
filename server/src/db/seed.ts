import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../env.js';
import { publicClient, publicDb } from './client.js';
import { closeTenantPools, tenantDb } from './tenant.js';
import { facilities } from './schema/registry.js';
import {
  admissions,
  appointments,
  beds,
  clinicalNotes,
  invoices,
  invoiceItems,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  medicines,
  patients,
  prescriptions,
  prescriptionItems,
  staff,
  staffRoles,
  stockMovements,
  vitalsRecords,
  wards
} from './schema/index.js';
import type { Role } from '../lib/auth.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../lib/password.js';

/**
 * Seeds a clinic with enough realistic data to exercise every screen.
 *
 * There is no default password. Only the administrator row is a usable login:
 * its password comes from `SEED_ADMIN_PASSWORD`, or is generated here and
 * printed once. Every other staff row exists so seeded appointments, notes and
 * results have real authors — those are inserted inactive, with a hash over
 * discarded random bytes, so nothing can be guessed or sign-in-tested against
 * them. An administrator activates one later from the staff screen and gives it
 * a password through the reset action.
 *
 * Idempotent: it stops when the database already holds staff, unless --force.
 */

const ADMIN_EMAIL = 'admin@clinic.test';

const STAFF_SEED: {
  fullName: string;
  email: string;
  roles: Role[];
  department?: string;
  specialty?: string;
  fee?: string;
}[] = [
  { fullName: 'Amara Okonkwo', email: ADMIN_EMAIL, roles: ['admin'], department: 'Administration' },
  { fullName: 'Grace Mbeki', email: 'reception@clinic.test', roles: ['reception'], department: 'Front Desk' },
  { fullName: 'Dr. Samuel Adeyemi', email: 'doctor@clinic.test', roles: ['doctor'], department: 'Internal Medicine', specialty: 'Internal Medicine', fee: '25.00' },
  { fullName: 'Dr. Leila Haddad', email: 'pediatrics@clinic.test', roles: ['doctor'], department: 'Pediatrics', specialty: 'Pediatrics', fee: '30.00' },
  { fullName: 'Dr. Kwame Mensah', email: 'surgery@clinic.test', roles: ['doctor'], department: 'Surgery', specialty: 'General Surgery', fee: '45.00' },
  { fullName: 'Nurse Fatima Bello', email: 'nurse@clinic.test', roles: ['nurse'], department: 'General Ward' },
  { fullName: 'Pharmacist Tunde Ayodele', email: 'pharmacy@clinic.test', roles: ['pharmacist'], department: 'Pharmacy' },
  { fullName: 'Lab Tech Joy Wanjiru', email: 'lab@clinic.test', roles: ['lab_technician'], department: 'Laboratory' },
  { fullName: 'Biller Dennis Mwangi', email: 'billing@clinic.test', roles: ['billing'], department: 'Accounts' }
];

const WARDS = [
  { name: 'General Male', unitType: 'general' as const, floor: 1, beds: 6 },
  { name: 'General Female', unitType: 'general' as const, floor: 1, beds: 6 },
  { name: 'Maternity', unitType: 'maternity' as const, floor: 2, beds: 4 },
  { name: 'Pediatric', unitType: 'pediatric' as const, floor: 2, beds: 4 },
  { name: 'Intensive Care', unitType: 'icu' as const, floor: 3, beds: 4 },
  { name: 'Surgical Recovery', unitType: 'surgical' as const, floor: 3, beds: 3 },
  { name: 'Isolation', unitType: 'isolation' as const, floor: 4, beds: 2 }
];

const MEDICINES = [
  { name: 'Paracetamol 500mg', genericName: 'Acetaminophen', form: 'tablet' as const, strength: '500mg', unit: 'tablet', price: '0.15', stock: 480, reorderLevel: 100 },
  { name: 'Amoxicillin 250mg', genericName: 'Amoxicillin', form: 'capsule' as const, strength: '250mg', unit: 'capsule', price: '0.40', stock: 220, reorderLevel: 80 },
  { name: 'Artemether/Lumefantrine', genericName: 'Co-artem', form: 'tablet' as const, strength: '20/120mg', unit: 'tablet', price: '1.10', stock: 60, reorderLevel: 70 },
  { name: 'Ceftriaxone 1g', genericName: 'Ceftriaxone', form: 'injection' as const, strength: '1g', unit: 'vial', price: '4.50', stock: 45, reorderLevel: 20 },
  { name: 'Oral Rehydration Salts', genericName: 'ORS', form: 'syrup' as const, strength: '20g sachet', unit: 'sachet', price: '0.65', stock: 300, reorderLevel: 60 },
  { name: 'Ibuprofen 400mg', genericName: 'Ibuprofen', form: 'tablet' as const, strength: '400mg', unit: 'tablet', price: '0.20', stock: 150, reorderLevel: 90 },
  { name: 'Insulin Glargine', genericName: 'Glargine', form: 'injection' as const, strength: '100IU/ml', unit: 'pen', price: '18.00', stock: 12, reorderLevel: 15 },
  { name: 'Salbutamol Inhaler', genericName: 'Salbutamol', form: 'inhaler' as const, strength: '100mcg', unit: 'inhaler', price: '6.20', stock: 28, reorderLevel: 10 },
  { name: 'Metronidazole 400mg', genericName: 'Metronidazole', form: 'tablet' as const, strength: '400mg', unit: 'tablet', price: '0.30', stock: 190, reorderLevel: 60 },
  { name: 'Amlodipine 5mg', genericName: 'Amlodipine', form: 'tablet' as const, strength: '5mg', unit: 'tablet', price: '0.35', stock: 8, reorderLevel: 40 }
];

const LAB_TESTS = [
  { code: 'FBC', name: 'Full Blood Count', specimen: 'blood' as const, unit: '', refLow: null, refHigh: null, refText: 'Age and sex specific', price: '12.00' },
  { code: 'HGB', name: 'Haemoglobin', specimen: 'blood' as const, unit: 'g/dL', refLow: '12.0', refHigh: '16.0', refText: null, price: '4.00' },
  { code: 'MAL', name: 'Malaria Rapid Test', specimen: 'blood' as const, unit: '', refLow: null, refHigh: null, refText: 'Negative', price: '3.50' },
  { code: 'GLU', name: 'Fasting Blood Glucose', specimen: 'blood' as const, unit: 'mmol/L', refLow: '3.9', refHigh: '6.1', refText: null, price: '3.00' },
  { code: 'URXA', name: 'Urinalysis', specimen: 'urine' as const, unit: '', refLow: null, refHigh: null, refText: 'No abnormalities', price: '5.00' },
  { code: 'CRP', name: 'C-Reactive Protein', specimen: 'blood' as const, unit: 'mg/L', refLow: '0', refHigh: '5', refText: null, price: '9.00' },
  { code: 'WIDAL', name: 'Widal Test', specimen: 'blood' as const, unit: '', refLow: null, refHigh: null, refText: 'Negative below 1:80', price: '7.50' }
];

const PATIENTS = [
  { givenName: 'Chidi', familyName: 'Eze', birthDate: '1985-04-12', gender: 'male' as const, phone: '+234 803 111 2233', bloodGroup: 'O+', allergies: 'Penicillin', chronic: 'Hypertension', address: '14 Umuahia Road' },
  { givenName: 'Aisha', familyName: 'Bello', birthDate: '1992-09-30', gender: 'female' as const, phone: '+234 805 442 9911', bloodGroup: 'A+', allergies: null, chronic: null, address: '8 Barkly Street' },
  { givenName: 'Kofi', familyName: 'Asante', birthDate: '2016-01-22', gender: 'male' as const, phone: '+233 24 555 0182', bloodGroup: null, allergies: 'Peanuts', chronic: 'Asthma', address: '22 Cantonments Road' },
  { givenName: 'Nia', familyName: 'Mwangi', birthDate: '1978-07-05', gender: 'female' as const, phone: '+254 712 330 441', bloodGroup: 'B+', allergies: null, chronic: 'Type 2 diabetes', address: '5 Kilimani Drive' },
  { givenName: 'Sena', familyName: 'Adeyemi', birthDate: '2001-11-17', gender: 'other' as const, phone: '+234 813 776 2020', bloodGroup: 'AB+', allergies: 'Sulfa drugs', chronic: null, address: '31 Ikoyi Crescent' },
  { givenName: 'Halima', familyName: 'Yakubu', birthDate: '1958-02-09', gender: 'female' as const, phone: '+234 706 218 9090', bloodGroup: 'O-', allergies: null, chronic: 'Heart failure', address: '7 Sabon Gari' },
  { givenName: 'Tomas', familyName: 'Neves', birthDate: '1990-06-25', gender: 'male' as const, phone: '+244 923 118 447', bloodGroup: 'A-', allergies: null, chronic: null, address: '12 Luanda Sul' }
];

function startOfDay(date: Date, addDays = 0): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() + addDays);
  return copy;
}

/**
 * base64url draws uniformly from its alphabet, so no rejection loop is needed to
 * keep the password unbiased. The suffix only guarantees the character classes a
 * person expects to type.
 */
function bootstrapPassword(): string {
  const fromEnv = process.env.SEED_ADMIN_PASSWORD;
  if (fromEnv === undefined || fromEnv === '') return `${randomBytes(18).toString('base64url')}#A9`;
  if (fromEnv.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters, or unset to generate one.`);
  }
  return fromEnv;
}

async function seed() {
  const force = process.argv.includes('--force');

  // Seed data belongs to one hospital: the demo cohort is written into the
  // facility named by FIRST_FACILITY_SLUG, never into `public`.
  const [facility] = await publicDb
    .select()
    .from(facilities)
    .where(eq(facilities.slug, env.firstFacilitySlug))
    .limit(1);
  if (!facility) {
    throw new Error(
      `No facility named "${env.firstFacilitySlug}" in the registry. Run the migrate script first — it creates the hospital and its schema.`
    );
  }
  const db = tenantDb(facility).db;

  const [populated] = await db.select({ total: sql<number>`count(*)::int` }).from(staff);

  if (populated.total > 0 && !force) {
    console.log(
      `Seed skipped: ${facility.name} already holds ${populated.total} staff account(s). Re-run with --force to add a second cohort.`
    );
    await closeTenantPools();
    await publicClient.end();
    return;
  }

  const adminPassword = bootstrapPassword();
  console.log(
    `Seeding ${facility.name} with ${STAFF_SEED.length} staff rows. Only ${ADMIN_EMAIL} will be able to sign in.`
  );

  const staffRows: (typeof staff.$inferSelect)[] = [];
  for (const record of STAFF_SEED) {
    const isAdmin = record.email === ADMIN_EMAIL;
    const [row] = await db
      .insert(staff)
      .values({
        fullName: record.fullName,
        email: record.email,
        // Author-only rows are hashed over bytes that are never kept, so no
        // password — including any that used to live in this file — verifies
        // against them, and they are inserted inactive on top of that.
        passwordHash: await hashPassword(isAdmin ? adminPassword : randomBytes(32).toString('base64url')),
        isActive: isAdmin,
        department: record.department ?? null,
        specialty: record.specialty ?? null,
        consultationFee: record.fee ?? '0.00'
      })
      .returning();
    await db.insert(staffRoles).values(record.roles.map((role) => ({ staffId: row.id, role })));
    staffRows.push(row);
  }

  const rolesByEmail = new Map(STAFF_SEED.map((record) => [record.email, record.roles]));
  /** Seed authors are keyed by their grants, because staff carries no role column. */
  const withRole = (role: Role) =>
    staffRows.filter((row) => rolesByEmail.get(row.email)?.includes(role));
  const byRole = (role: Role) => withRole(role)[0]!;
  const admin = byRole('admin');
  const reception = byRole('reception');
  const doctors = withRole('doctor');
  const nurse = byRole('nurse');
  const pharmacist = byRole('pharmacist');
  const labTech = byRole('lab_technician');

  const patientRows = [];
  for (const record of PATIENTS) {
    const [row] = await db
      .insert(patients)
      .values({
        givenName: record.givenName,
        familyName: record.familyName,
        birthDate: record.birthDate,
        gender: record.gender,
        phone: record.phone,
        bloodGroup: record.bloodGroup,
        allergies: record.allergies,
        chronicConditions: record.chronic,
        address: record.address,
        createdBy: reception.id
      })
      .returning();
    patientRows.push(row);
  }

  const wardRows = [];
  for (const ward of WARDS) {
    const [row] = await db
      .insert(wards)
      .values({ name: ward.name, unitType: ward.unitType, floor: ward.floor })
      .returning();

    for (let index = 1; index <= ward.beds; index += 1) {
      await db.insert(beds).values({
        wardId: row.id,
        label: `${ward.name.slice(0, 3).toUpperCase()}-${String(index).padStart(2, '0')}`,
        // One bed per ward left in maintenance so the board shows all three states.
        status: index === ward.beds && ward.beds > 3 ? 'maintenance' : 'available'
      });
    }
    wardRows.push(row);
  }

  const allBeds = await db.select().from(beds);
  const freeBeds = allBeds.filter((bed) => bed.status === 'available');

  // Opening stock is recorded as a purchase movement so the ledger reconciles.
  {
    for (const record of MEDICINES) {
      const [row] = await db
        .insert(medicines)
        .values({
          name: record.name,
          genericName: record.genericName,
          form: record.form,
          strength: record.strength,
          unit: record.unit,
          price: record.price,
          stock: record.stock,
          reorderLevel: record.reorderLevel
        })
        .returning();

      await db.insert(stockMovements).values({
        medicineId: row.id,
        quantityChange: record.stock,
        reason: 'purchase',
        reference: 'Opening balance',
        performedBy: pharmacist.id
      });
    }
  }
  const labTestRows = [];
  for (const record of LAB_TESTS) {
    const [row] = await db
      .insert(labTests)
      .values({
        code: record.code,
        name: record.name,
        specimen: record.specimen,
        unit: record.unit,
        referenceLow: record.refLow,
        referenceHigh: record.refHigh,
        referenceText: record.refText,
        price: record.price
      })
      .returning();
    labTestRows.push(row);
  }

  // Appointments: three booked slots per doctor today, staggered to avoid the
  // exclusion constraint, plus a couple of tomorrow's bookings.
  const today = startOfDay(new Date());
  const reasons = [
    'Persistent headache',
    'Follow-up: blood pressure',
    'Child vaccination review',
    'Recurring fever since Monday',
    'Diabetes medication review',
    'Chest pain on exertion',
    'Antenatal check',
    'Wound dressing review',
    'Allergy flare-up',
    'Lab results discussion',
    'Abdominal pain',
    'Post-operative check'
  ];

  let reasonCursor = 0;
  let patientCursor = 0;
  for (let dayOffset = 0; dayOffset < 2; dayOffset += 1) {
    for (const [doctorIndex, doctor] of doctors.entries()) {
      for (let slot = 0; slot < 3; slot += 1) {
        const startHour = 9 + slot + doctorIndex;
        if (startHour > 16) continue;
        const startsAt = new Date(today.getTime() + dayOffset * 86_400_000 + startHour * 3_600_000);
        const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
        // Advance per booking: two doctors may run in parallel at the same hour,
        // and the patient-overlap constraint rejects booking one patient twice.
        const patient = patientRows[patientCursor % patientRows.length];
        patientCursor += 1;

        await db.insert(appointments).values({
          patientId: patient.id,
          staffId: doctor.id,
          startsAt,
          endsAt,
          reason: reasons[reasonCursor % reasons.length],
          status: dayOffset === 0 && slot === 0 ? 'confirmed' : 'scheduled',
          fee: doctor.consultationFee,
          createdBy: reception.id
        });
      }
      reasonCursor += 1;
    }
  }

  // Two completed past visits so history and billing screens have substance.
  const pastVisit = await db
    .insert(appointments)
    .values({
      patientId: patientRows[0].id,
      staffId: doctors[0].id,
      startsAt: new Date(today.getTime() - 86_400_000 * 3 + 10 * 3_600_000),
      endsAt: new Date(today.getTime() - 86_400_000 * 3 + 10 * 3_600_000 + 30 * 60_000),
      reason: 'Hypertension review',
      status: 'completed',
      fee: doctors[0].consultationFee,
      createdBy: reception.id
    })
    .returning({ id: appointments.id });

  const admissionTargets = [
    { patient: patientRows[5], ward: wardRows[4], complaint: 'Shortness of breath, suspected cardiac decompensation', diagnosis: 'Congestive heart failure' },
    { patient: patientRows[3], ward: wardRows[0], complaint: 'Severe abdominal pain and vomiting', diagnosis: 'Acute gastroenteritis' },
    { patient: patientRows[2], ward: wardRows[3], complaint: 'Wheezing, asthma exacerbation', diagnosis: 'Acute asthma' }
  ];

  const admissionRows = [];
  for (const [index, target] of admissionTargets.entries()) {
    const bed = freeBeds[index];
    const [row] = await db
      .insert(admissions)
      .values({
        patientId: target.patient.id,
        wardId: target.ward.id,
        bedId: bed.id,
        attendingStaffId: doctors[index % doctors.length].id,
        admittingComplaint: target.complaint,
        diagnosis: target.diagnosis,
        admittedAt: new Date(today.getTime() - (index + 1) * 43_200_000),
        createdBy: nurse.id
      })
      .returning();
    admissionRows.push(row);

    await db.insert(clinicalNotes).values({
      patientId: target.patient.id,
      staffId: nurse.id,
      admissionId: row.id,
      type: 'progress',
      content: `Admitted to ${target.ward.name}. Observations within acceptable limits overnight; continues on current treatment plan.`
    });

    await db.insert(vitalsRecords).values({
      patientId: target.patient.id,
      admissionId: row.id,
      recordedBy: nurse.id,
      temperatureC: '37.4',
      pulse: 88,
      respiratoryRate: 18,
      spo2: 96,
      bpSystolic: 132,
      bpDiastolic: 84,
      weightKg: '68.5',
      heightCm: '171',
      recordedAt: new Date(today.getTime() - 3_600_000)
    });
  }

  // Discharged admission, so the ward board and history show both states.
  const dischargeBed = freeBeds[5];
  const [discharged] = await db
    .insert(admissions)
    .values({
      patientId: patientRows[1].id,
      wardId: wardRows[1].id,
      bedId: dischargeBed.id,
      attendingStaffId: doctors[1].id,
      admittingComplaint: 'Dehydration after two days of diarrhoea',
      diagnosis: 'Acute gastroenteritis, resolved',
      admittedAt: new Date(today.getTime() - 86_400_000 * 6),
      dischargedAt: new Date(today.getTime() - 86_400_000 * 2),
      dischargeSummary: 'Tolerating oral intake, stools formed, discharged with ORS and follow-up in one week.',
      createdBy: nurse.id
    })
    .returning();

  await db.insert(clinicalNotes).values({
    patientId: patientRows[1].id,
    staffId: doctors[1].id,
    admissionId: discharged.id,
    type: 'discharge',
    content: 'Fully rehydrated, afebrile for 48 hours. Discharge advised.'
  });

  const medicineTable = await db.select().from(medicines);
  const findMedicine = (name: string) => medicineTable.find((row) => row.name === name)!;

  const [prescription] = await db
    .insert(prescriptions)
    .values({
      patientId: patientRows[0].id,
      admissionId: admissionRows[0].id,
      prescriberId: doctors[0].id,
      notes: 'Take with food. Complete the full antibiotic course.'
    })
    .returning();

  const prescriptionLines = [
    { medicine: findMedicine('Paracetamol 500mg'), dosage: '2 tablets', frequency: 'Three times daily', durationDays: 5, quantity: 30 },
    { medicine: findMedicine('Amoxicillin 250mg'), dosage: '1 capsule', frequency: 'Three times daily', durationDays: 7, quantity: 21 },
    { medicine: findMedicine('Amlodipine 5mg'), dosage: '1 tablet', frequency: 'Once daily', durationDays: 28, quantity: 28 }
  ];

  for (const [index, line] of prescriptionLines.entries()) {
    const [item] = await db
      .insert(prescriptionItems)
      .values({
        prescriptionId: prescription.id,
        medicineId: line.medicine.id,
        dosage: line.dosage,
        frequency: line.frequency,
        durationDays: line.durationDays,
        quantity: line.quantity
      })
      .returning();

    // First two lines already dispensed, leaving the third pending so the
    // pharmacy queue and the partially-dispensed state are both visible.
    if (index < 2) {
      await db
        .update(medicines)
        .set({ stock: sql`${medicines.stock} - ${line.quantity}` })
        .where(eq(medicines.id, line.medicine.id));
      await db.insert(stockMovements).values({
        medicineId: line.medicine.id,
        quantityChange: -line.quantity,
        reason: 'dispense',
        reference: prescription.id,
        performedBy: pharmacist.id
      });
      await db
        .update(prescriptionItems)
        .set({ dispensedQuantity: line.quantity })
        .where(eq(prescriptionItems.id, item.id));
    }
  }

  await db
    .update(prescriptions)
    .set({ status: 'partially_dispensed' })
    .where(eq(prescriptions.id, prescription.id));

  const secondPrescription = await db
    .insert(prescriptions)
    .values({
      patientId: patientRows[2].id,
      admissionId: admissionRows[2].id,
      prescriberId: doctors[2 % doctors.length].id,
      notes: 'Inhaler technique reviewed with caregiver.'
    })
    .returning({ id: prescriptions.id });

  await db.insert(prescriptionItems).values({
    prescriptionId: secondPrescription[0].id,
    medicineId: findMedicine('Salbutamol Inhaler').id,
    dosage: '2 puffs',
    frequency: 'Every 6 hours as needed',
    durationDays: 14,
    quantity: 2
  });

  const hgb = labTestRows.find((row) => row.code === 'HGB')!;
  const glu = labTestRows.find((row) => row.code === 'GLU')!;
  const mal = labTestRows.find((row) => row.code === 'MAL')!;
  const fbc = labTestRows.find((row) => row.code === 'FBC')!;

  const [completedOrder] = await db
    .insert(labOrders)
    .values({
      patientId: patientRows[5].id,
      admissionId: admissionRows[0].id,
      orderingStaffId: doctors[0].id,
      status: 'completed',
      priority: 'urgent',
      notes: 'Rule out parasitaemia before transfusion.',
      orderedAt: new Date(today.getTime() - 43_200_000),
      collectedAt: new Date(today.getTime() - 40_000_000),
      completedAt: new Date(today.getTime() - 10_000_000)
    })
    .returning();

  const completedItems = [];
  for (const test of [hgb, mal, fbc]) {
    const [item] = await db
      .insert(labOrderItems)
      .values({ labOrderId: completedOrder.id, labTestId: test.id })
      .returning();
    completedItems.push({ item, test });
  }

  await db.insert(labResults).values([
    {
      labOrderItemId: completedItems[0].item.id,
      valueNumeric: '9.4',
      unit: 'g/dL',
      flag: 'abnormal',
      comment: 'Moderate anaemia; correlate with clinical findings.',
      resultedBy: labTech.id,
      verifiedBy: doctors[0].id,
      resultedAt: new Date(today.getTime() - 12_000_000)
    },
    {
      labOrderItemId: completedItems[1].item.id,
      valueText: 'Negative',
      flag: 'normal',
      resultedBy: labTech.id,
      resultedAt: new Date(today.getTime() - 12_000_000)
    },
    {
      labOrderItemId: completedItems[2].item.id,
      valueText: 'Within normal limits',
      flag: 'normal',
      resultedBy: labTech.id,
      resultedAt: new Date(today.getTime() - 11_000_000)
    }
  ]);

  const [pendingOrder] = await db
    .insert(labOrders)
    .values({
      patientId: patientRows[3].id,
      admissionId: admissionRows[1].id,
      orderingStaffId: doctors[1].id,
      status: 'collected',
      priority: 'routine',
      notes: 'Glycaemic control check.',
      orderedAt: new Date(today.getTime() - 7_200_000),
      collectedAt: new Date(today.getTime() - 3_600_000)
    })
    .returning();

  await db.insert(labOrderItems).values({ labOrderId: pendingOrder.id, labTestId: glu.id });

  const [invoice] = await db
    .insert(invoices)
    .values({
      patientId: patientRows[5].id,
      admissionId: admissionRows[0].id,
      status: 'issued',
      notes: 'Three bed-days in ICU plus laboratory work.',
      issuedAt: new Date(today.getTime() - 86_400_000),
      dueAt: new Date(today.getTime() + 86_400_000 * 13),
      createdBy: admin.id
    })
    .returning();

  await db.insert(invoiceItems).values([
    {
      invoiceId: invoice.id,
      description: 'ICU bed charge (2 days)',
      category: 'ward' as const,
      quantity: '2',
      unitPrice: '150.00'
    },
    {
      invoiceId: invoice.id,
      description: 'Full Blood Count, Haemoglobin, Malaria RDT',
      category: 'lab' as const,
      quantity: '1',
      unitPrice: '19.50',
      referenceId: completedOrder.id
    },
    {
      invoiceId: invoice.id,
      description: 'Consultation — Internal Medicine',
      category: 'consultation' as const,
      quantity: '1',
      unitPrice: doctors[0].consultationFee
    }
  ]);

  const draftInvoice = await db
    .insert(invoices)
    .values({
      patientId: patientRows[0].id,
      status: 'draft',
      notes: 'Awaiting pharmacy dispensing before issue.',
      createdBy: admin.id
    })
    .returning({ id: invoices.id, number: invoices.number });

  await db.insert(invoiceItems).values({
    invoiceId: draftInvoice[0].id,
    description: 'Amoxicillin 250mg (21 capsules)',
    category: 'medicine' as const,
    quantity: '21',
    unitPrice: '0.40'
  });

  const counts = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(patients),
    db.select({ c: sql<number>`count(*)::int` }).from(appointments),
    db.select({ c: sql<number>`count(*)::int` }).from(beds),
    db.select({ c: sql<number>`count(*)::int` }).from(medicines)
  ]);

  console.log('Seed complete.');
  console.log(
    `  staff ${STAFF_SEED.length}  patients ${counts[0][0].c}  appointments ${counts[1][0].c}  beds ${counts[2][0].c}  medicines ${counts[3][0].c}`
  );
  console.log(
    `  Sign in at hospital "${facility.slug}" as ${ADMIN_EMAIL}. The other ${STAFF_SEED.length - 1} seeded staff rows are record`
  );
  console.log('  authors only: inactive, with password hashes that were never written down.');
  if (process.env.SEED_ADMIN_PASSWORD) {
    console.log('  Administrator password: the SEED_ADMIN_PASSWORD you supplied (not echoed here).');
  } else {
    // Shown once — nothing else keeps it, so losing it means seeding a clean
    // database again or editing the staff table directly.
    console.log(`  Administrator password: ${adminPassword}`);
  }

  await closeTenantPools();
  await publicClient.end();
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
