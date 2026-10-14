import {
  pgEnum
} from 'drizzle-orm/pg-core';

export const staffRole = pgEnum('staff_role', [
  'admin',
  'reception',
  'doctor',
  'nurse',
  'pharmacist',
  'lab_technician',
  'billing'
]);

export const personGender = pgEnum('person_gender', ['male', 'female', 'other']);

export const patientStatus = pgEnum('patient_status', ['active', 'inactive', 'deceased']);

export const wardUnitType = pgEnum('ward_unit_type', [
  'general',
  'icu',
  'coronary',
  'maternity',
  'pediatric',
  'surgical',
  'emergency',
  'isolation'
]);

export const bedStatus = pgEnum('bed_status', ['available', 'maintenance']);

export const admissionStatus = pgEnum('admission_status', ['admitted', 'discharged']);

export const appointmentStatus = pgEnum('appointment_status', [
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no_show'
]);

export const noteType = pgEnum('note_type', [
  'progress',
  'consultation',
  'nursing',
  'procedure',
  'discharge'
]);

export const medicineForm = pgEnum('medicine_form', [
  'tablet',
  'capsule',
  'syrup',
  'injection',
  'ointment',
  'drops',
  'inhaler',
  'other'
]);

export const stockMovementReason = pgEnum('stock_movement_reason', [
  'purchase',
  'dispense',
  'adjustment',
  'return',
  'wastage'
]);

export const prescriptionStatus = pgEnum('prescription_status', [
  'pending',
  'partially_dispensed',
  'dispensed',
  'cancelled'
]);

export const specimenType = pgEnum('specimen_type', [
  'blood',
  'urine',
  'stool',
  'sputum',
  'swab',
  'tissue',
  'other'
]);

export const labOrderStatus = pgEnum('lab_order_status', [
  'pending',
  'collected',
  'in_progress',
  'completed',
  'cancelled'
]);

export const labPriority = pgEnum('lab_priority', ['routine', 'urgent']);

export const labResultFlag = pgEnum('lab_result_flag', ['normal', 'abnormal', 'critical']);

export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'partial', 'paid', 'void']);

export const invoiceItemCategory = pgEnum('invoice_item_category', [
  'consultation',
  'ward',
  'medicine',
  'lab',
  'procedure',
  'other'
]);

export const paymentMethod = pgEnum('payment_method', [
  'cash',
  'card',
  'mobile_money',
  'insurance',
  'bank_transfer'
]);
