import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  numeric
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  admissionStatus,
  appointmentStatus,
  bedStatus,
  invoiceItemCategory,
  invoiceStatus,
  labOrderStatus,
  labPriority,
  labResultFlag,
  medicineForm,
  noteType,
  patientStatus,
  paymentMethod,
  personGender,
  prescriptionStatus,
  specimenType,
  staffRole,
  stockMovementReason,
  wardUnitType
} from './enums.js';

export * from './enums.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });

/* ------------------------------------------------------------------ *
 * People: staff (also the login identity) and patients
 * ------------------------------------------------------------------ */

export const staff = pgTable(
  'staff',
  {
    id: id(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    phone: text('phone'),
    department: text('department'),
    specialty: text('specialty'),
    consultationFee: money('consultation_fee').notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('staff_email_key').on(sql`lower(${t.email})`)]
);

/**
 * Role grants. A person can hold several roles; a session activates one of
 * them. This table is the only source of authorisation truth — `staff.role`
 * was dropped so a stale column can never disagree with a grant.
 */
export const staffRoles = pgTable(
  'staff_roles',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    role: staffRole('role').notNull(),
    grantedAt: createdAt(),
    grantedBy: uuid('granted_by').references(() => staff.id, { onDelete: 'set null' })
  },
  (t) => [primaryKey({ columns: [t.staffId, t.role] }), index('staff_roles_role_idx').on(t.role)]
);

export const patients = pgTable(
  'patients',
  {
    id: id(),
    mrn: text('mrn')
      .notNull()
      .default(sql`('MRN-' || lpad(nextval('patient_mrn_seq')::text, 6, '0'))`),
    givenName: text('given_name').notNull(),
    familyName: text('family_name').notNull(),
    birthDate: date('birth_date'),
    gender: personGender('gender'),
    bloodGroup: text('blood_group'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    allergies: text('allergies'),
    chronicConditions: text('chronic_conditions'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    status: patientStatus('status').notNull().default('active'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('patients_mrn_key').on(t.mrn),
    index('patients_name_idx').on(t.familyName, t.givenName),
    index('patients_status_idx').on(t.status)
  ]
);

/* ------------------------------------------------------------------ *
 * Outpatient scheduling
 * ------------------------------------------------------------------ */

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: appointmentStatus('status').notNull().default('scheduled'),
    reason: text('reason').notNull(),
    notes: text('notes'),
    fee: money('fee'),
    createdBy: uuid('created_by').references(() => staff.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('appointments_starts_at_idx').on(t.startsAt),
    index('appointments_staff_idx').on(t.staffId, t.startsAt),
    index('appointments_patient_idx').on(t.patientId, t.startsAt),
    index('appointments_status_idx').on(t.status)
  ]
);

/* ------------------------------------------------------------------ *
 * Inpatient: wards, beds, admissions
 * ------------------------------------------------------------------ */

export const wards = pgTable('wards', {
  id: id(),
  name: text('name').notNull(),
  unitType: wardUnitType('unit_type').notNull().default('general'),
  floor: smallint('floor').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const beds = pgTable(
  'beds',
  {
    id: id(),
    wardId: uuid('ward_id')
      .notNull()
      .references(() => wards.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    status: bedStatus('status').notNull().default('available'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('beds_ward_label_key').on(t.wardId, t.label)]
);

export const admissions = pgTable(
  'admissions',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    wardId: uuid('ward_id')
      .notNull()
      .references(() => wards.id, { onDelete: 'restrict' }),
    bedId: uuid('bed_id').references(() => beds.id, { onDelete: 'restrict' }),
    attendingStaffId: uuid('attending_staff_id').references(() => staff.id, {
      onDelete: 'set null'
    }),
    status: admissionStatus('status').notNull().default('admitted'),
    admittingComplaint: text('admitting_complaint').notNull(),
    diagnosis: text('diagnosis'),
    dischargeSummary: text('discharge_summary'),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull().defaultNow(),
    dischargedAt: timestamp('discharged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('admissions_patient_idx').on(t.patientId, t.status),
    index('admissions_status_idx').on(t.status),
    // Guarded by partial unique indexes applied in advanced DDL:
    //   one open admission per bed, one open admission per patient.
    index('admissions_bed_idx').on(t.bedId)
  ]
);

export const clinicalNotes = pgTable(
  'clinical_notes',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'cascade'
    }),
    type: noteType('type').notNull().default('progress'),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('clinical_notes_patient_idx').on(t.patientId, t.createdAt),
    index('clinical_notes_admission_idx').on(t.admissionId)
  ]
);

/**
 * Signed clinical report: the doctor's answer to an encounter in one printable
 * document. Attached to an outpatient appointment or an admission, or free
 * standing on the patient record.
 */
export const clinicalReports = pgTable(
  'clinical_reports',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    findings: text('findings').notNull(),
    diagnosis: text('diagnosis').notNull(),
    plan: text('plan'),
    advice: text('advice'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('clinical_reports_patient_idx').on(t.patientId, t.createdAt),
    index('clinical_reports_appointment_idx').on(t.appointmentId),
    index('clinical_reports_admission_idx').on(t.admissionId)
  ]
);

export const vitalsRecords = pgTable(
  'vitals_records',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'cascade' }),
    recordedBy: uuid('recorded_by').references(() => staff.id, { onDelete: 'set null' }),
    temperatureC: numeric('temperature_c', { precision: 4, scale: 1 }),
    pulse: smallint('pulse'),
    respiratoryRate: smallint('respiratory_rate'),
    spo2: smallint('spo2'),
    bpSystolic: smallint('bp_systolic'),
    bpDiastolic: smallint('bp_diastolic'),
    weightKg: numeric('weight_kg', { precision: 5, scale: 1 }),
    heightCm: numeric('height_cm', { precision: 5, scale: 1 }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt()
  },
  (t) => [index('vitals_patient_idx').on(t.patientId, t.recordedAt)]
);

/* ------------------------------------------------------------------ *
 * Pharmacy
 * ------------------------------------------------------------------ */

export const medicines = pgTable(
  'medicines',
  {
    id: id(),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    form: medicineForm('form').notNull().default('tablet'),
    strength: text('strength').notNull(),
    unit: text('unit').notNull().default('unit'),
    price: money('price').notNull().default('0'),
    stock: integer('stock').notNull().default(0),
    reorderLevel: integer('reorder_level').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index('medicines_name_idx').on(t.name), index('medicines_stock_idx').on(t.stock)]
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    medicineId: uuid('medicine_id')
      .notNull()
      .references(() => medicines.id, { onDelete: 'cascade' }),
    quantityChange: integer('quantity_change').notNull(),
    reason: stockMovementReason('reason').notNull(),
    reference: text('reference'),
    performedBy: uuid('performed_by').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt()
  },
  (t) => [index('stock_movements_medicine_idx').on(t.medicineId, t.createdAt)]
);

export const prescriptions = pgTable(
  'prescriptions',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'cascade'
    }),
    prescriberId: uuid('prescriber_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    status: prescriptionStatus('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('prescriptions_patient_idx').on(t.patientId, t.createdAt),
    index('prescriptions_status_idx').on(t.status)
  ]
);

export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: id(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'cascade' }),
    medicineId: uuid('medicine_id')
      .notNull()
      .references(() => medicines.id, { onDelete: 'restrict' }),
    dosage: text('dosage').notNull(),
    frequency: text('frequency').notNull(),
    durationDays: smallint('duration_days').notNull().default(1),
    quantity: integer('quantity').notNull(),
    instructions: text('instructions'),
    dispensedQuantity: integer('dispensed_quantity').notNull().default(0),
    createdAt: createdAt()
  },
  (t) => [index('prescription_items_rx_idx').on(t.prescriptionId)]
);

/* ------------------------------------------------------------------ *
 * Laboratory
 * ------------------------------------------------------------------ */

export const labTests = pgTable(
  'lab_tests',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    specimen: specimenType('specimen').notNull().default('blood'),
    unit: text('unit'),
    referenceLow: numeric('reference_low', { precision: 12, scale: 3 }),
    referenceHigh: numeric('reference_high', { precision: 12, scale: 3 }),
    referenceText: text('reference_text'),
    price: money('price').notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('lab_tests_code_key').on(t.code)]
);

export const labOrders = pgTable(
  'lab_orders',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'cascade' }),
    orderingStaffId: uuid('ordering_staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    status: labOrderStatus('status').notNull().default('pending'),
    priority: labPriority('priority').notNull().default('routine'),
    notes: text('notes'),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull().defaultNow(),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    index('lab_orders_status_idx').on(t.status, t.priority),
    index('lab_orders_patient_idx').on(t.patientId, t.orderedAt)
  ]
);

export const labOrderItems = pgTable(
  'lab_order_items',
  {
    id: id(),
    labOrderId: uuid('lab_order_id')
      .notNull()
      .references(() => labOrders.id, { onDelete: 'cascade' }),
    labTestId: uuid('lab_test_id')
      .notNull()
      .references(() => labTests.id, { onDelete: 'restrict' }),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex('lab_order_items_order_test_key').on(t.labOrderId, t.labTestId),
    index('lab_order_items_order_idx').on(t.labOrderId)
  ]
);

export const labResults = pgTable(
  'lab_results',
  {
    id: id(),
    labOrderItemId: uuid('lab_order_item_id')
      .notNull()
      .references(() => labOrderItems.id, { onDelete: 'cascade' }),
    valueNumeric: numeric('value_numeric', { precision: 14, scale: 4 }),
    valueText: text('value_text'),
    unit: text('unit'),
    flag: labResultFlag('flag').notNull().default('normal'),
    comment: text('comment'),
    resultedBy: uuid('resulted_by').references(() => staff.id, { onDelete: 'set null' }),
    verifiedBy: uuid('verified_by').references(() => staff.id, { onDelete: 'set null' }),
    resultedAt: timestamp('resulted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('lab_results_order_item_key').on(t.labOrderItemId)]
);

/* ------------------------------------------------------------------ *
 * Billing
 * ------------------------------------------------------------------ */

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    number: text('number')
      .notNull()
      .default(sql`('INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0'))`),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    status: invoiceStatus('status').notNull().default('draft'),
    notes: text('notes'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('invoices_number_key').on(t.number),
    index('invoices_patient_idx').on(t.patientId, t.status)
  ]
);

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: id(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    category: invoiceItemCategory('category').notNull().default('other'),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
    unitPrice: money('unit_price').notNull().default('0'),
    referenceId: uuid('reference_id'),
    createdAt: createdAt()
  },
  (t) => [index('invoice_items_invoice_idx').on(t.invoiceId)]
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    amount: money('amount').notNull(),
    method: paymentMethod('method').notNull().default('cash'),
    reference: text('reference'),
    receivedBy: uuid('received_by').references(() => staff.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt()
  },
  (t) => [index('payments_invoice_idx').on(t.invoiceId, t.paidAt)]
);

/* ------------------------------------------------------------------ *
 * Audit trail — written by the API for every successful mutation
 * ------------------------------------------------------------------ */

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    staffId: uuid('staff_id').references(() => staff.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    method: text('method'),
    path: text('path'),
    data: jsonb('data'),
    createdAt: createdAt()
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_entity_idx').on(t.entity, t.entityId),
    index('audit_staff_idx').on(t.staffId, t.createdAt)
  ]
);
