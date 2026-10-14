import { pgClient } from './client.js';

/**
 * Constraints that Drizzle's table DSL cannot express: exclusion constraints,
 * partial unique indexes and CHECK guards. Every statement is idempotent so
 * this can run on every migration.
 */
export async function applyAdvancedConstraints(): Promise<void> {
  const statements = [
    `create extension if not exists btree_gist`,

    // Human-readable identifiers are assigned by the database, never the app,
    // so concurrent inserts cannot produce a duplicate MRN or invoice number.
    `create sequence if not exists patient_mrn_seq start 1 increment 1`,
    `create sequence if not exists invoice_number_seq start 1 increment 1`,

    // A clinician cannot be double-booked while a booking is still live.
    `alter table appointments drop constraint if exists appointments_no_staff_overlap`,
    `alter table appointments add constraint appointments_no_staff_overlap
       exclude using gist (
         staff_id with =,
         tstzrange(starts_at, ends_at) with &&
       )
       where (status in ('scheduled', 'confirmed'))`,

    // A patient cannot hold two live bookings at the same instant either.
    `alter table appointments drop constraint if exists appointments_no_patient_overlap`,
    `alter table appointments add constraint appointments_no_patient_overlap
       exclude using gist (
         patient_id with =,
         tstzrange(starts_at, ends_at) with &&
       )
       where (status in ('scheduled', 'confirmed'))`,

    `alter table appointments drop constraint if exists appointments_time_order`,
    `alter table appointments add constraint appointments_time_order
       check (ends_at > starts_at)`,

    // Exactly one open admission per bed and per patient. Discharging clears
    // the row from the index, so beds and patients free up automatically.
    `create unique index if not exists admissions_one_open_per_bed
       on admissions (bed_id)
       where discharged_at is null and bed_id is not null`,
    `create unique index if not exists admissions_one_open_per_patient
       on admissions (patient_id)
       where discharged_at is null`,

    `alter table admissions drop constraint if exists admissions_discharge_order`,
    `alter table admissions add constraint admissions_discharge_order
       check (discharged_at is null or discharged_at > admitted_at)`,

    `alter table invoice_items drop constraint if exists invoice_items_amounts`,
    `alter table invoice_items add constraint invoice_items_amounts
       check (quantity > 0 and unit_price >= 0)`,

    `alter table payments drop constraint if exists payments_positive`,
    `alter table payments add constraint payments_positive check (amount > 0)`,

    `alter table stock_movements drop constraint if exists stock_movement_nonzero`,
    `alter table stock_movements add constraint stock_movement_nonzero
       check (quantity_change <> 0)`,

    `alter table medicines drop constraint if exists medicines_stock_non_negative`,
    `alter table medicines add constraint medicines_stock_non_negative
       check (stock >= 0)`,

    `alter table prescription_items drop constraint if exists prescription_items_quantity`,
    `alter table prescription_items add constraint prescription_items_quantity
       check (quantity > 0 and dispensed_quantity >= 0 and dispensed_quantity <= quantity)`,

    `alter table lab_results drop constraint if exists lab_results_value_present`,
    `alter table lab_results add constraint lab_results_value_present
       check (value_numeric is not null or value_text is not null)`
  ];

  // This file re-runs on every migration, and Postgres reports each object that
  // is already in place as a NOTICE ("… already exists, skipping"). postgres.js
  // surfaces those on the console, where they read like failures — so drop the
  // message floor to warnings for this connection.
  await pgClient.unsafe(`set client_min_messages to warning`);

  for (const statement of statements) {
    await pgClient.unsafe(statement);
  }
}
