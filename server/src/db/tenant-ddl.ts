import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { applyAdvancedConstraints } from './advanced.js';
import * as enums from './schema/enums.js';
import { facilityStatus } from './schema/registry.js';

/**
 * DDL for the two layers of the database:
 *
 * - `public` holds the registry tables and every enum type. Types are shared on
 *   purpose: a status value means the same thing at every hospital, and a type
 *   cannot be moved into a facility schema later without rewriting columns.
 * - one schema per facility (`f_<slug>`) holds the 22 clinical tables, their
 *   indexes, and their own `patient_mrn_seq` / `invoice_number_seq`, so MRN and
 *   invoice numbering restart per hospital instead of being handed out globally.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, 'migrations');

/** Tables, indexes and constraints that belong to exactly one facility. */
export const TENANT_TABLES = [
  'staff',
  'staff_roles',
  'patients',
  'appointments',
  'wards',
  'beds',
  'admissions',
  'clinical_notes',
  'clinical_reports',
  'vitals_records',
  'medicines',
  'stock_movements',
  'prescriptions',
  'prescription_items',
  'lab_tests',
  'lab_orders',
  'lab_order_items',
  'lab_results',
  'invoices',
  'invoice_items',
  'payments',
  'audit_log'
] as const;

export const TENANT_SEQUENCES = ['patient_mrn_seq', 'invoice_number_seq'] as const;

/** Exported so the platform route validates a slug exactly as provisioning does. */
export const FACILITY_SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
export const FACILITY_SLUG_HINT =
  'A hospital address is lowercase letters, digits and single hyphens, 3 to 50 characters, starting and ending with a letter or digit.';
const SCHEMA_NAME = /^f_[a-z0-9][a-z0-9_]{0,58}$/;

/** `acme-clinic` -> `f_acme_clinic`. Hyphens are legal in a slug, not in an unquoted identifier. */
export function tenantSchemaNameFor(slug: string): string {
  if (!FACILITY_SLUG.test(slug)) {
    throw new Error(FACILITY_SLUG_HINT);
  }
  const schemaName = `f_${slug.replace(/-/g, '_')}`;
  if (!SCHEMA_NAME.test(schemaName)) throw new Error(`Slug "${slug}" produces an unusable schema name.`);
  return schemaName;
}

/** Names come only from the registry or from provisioning, so anything else is a bug, not input to sanitize. */
export function assertTenantSchemaName(schemaName: string): void {
  if (!SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Refusing to touch schema "${schemaName}": not a facility schema name.`);
  }
}

type DrizzleEnum = { enumName: string; enumValues: readonly string[] };

const SHARED_ENUMS: DrizzleEnum[] = [
  ...(Object.values(enums) as DrizzleEnum[]),
  facilityStatus as unknown as DrizzleEnum
];

/**
 * Enums are created from the schema definitions rather than from SQL, so the
 * list cannot drift from `schema/enums.ts`. Each is guarded because this runs on
 * every migration.
 */
export function sharedTypeStatements(): string[] {
  return SHARED_ENUMS.map(
    (item) => `do $$ begin
       create type public."${item.enumName}" as enum (${item.enumValues
         .map((value) => `'${value}'`)
         .join(', ')});
     exception when duplicate_object then null; end $$;`
  );
}

/**
 * A one-shot connection pinned to one facility schema, still running as the
 * migration login so it can create and alter. Request handling never uses this;
 * it uses the pooled, role-restricted handle in `tenant.ts`.
 */
export async function withSchemaConnection<T>(
  schemaName: string,
  run: (sql: postgres.Sql) => Promise<T>
): Promise<T> {
  assertTenantSchemaName(schemaName);
  const separator = env.databaseUrl.includes('?') ? '&' : '?';
  const sql = postgres(`${env.databaseUrl}${separator}options=-csearch_path%3D${schemaName},public`, {
    max: 1,
    idle_timeout: 10
  });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * One Postgres role per facility, named exactly like its schema.
 *
 * `search_path` alone only constrains *unqualified* names, so a query that
 * spelled out `f_other_clinic.patients` could still reach across. Connecting as
 * the facility's own role makes that a `permission denied for schema` error
 * instead of a bug waiting to happen. The role is `nologin`: it exists only to
 * be assumed by the migration login through the connection's `role` parameter,
 * so no facility credential exists to leak.
 *
 * Assuming it takes **membership**, which only a superuser holds implicitly: a
 * restricted login can create the role with CREATEROLE and still be refused by
 * `SET ROLE`. That grant is what lets the pooled connections in `tenant.ts` open
 * at all — without it, every request for that hospital dies at connect time with
 * `permission denied to set role`. Postgres 15 lets a CREATEROLE role grant
 * itself membership of any non-superuser role; 16 narrows that to roles it holds
 * the admin option on, which one it created does. For a superuser login the
 * grant changes nothing.
 */
export async function ensureFacilityRole(client: postgres.Sql, schemaName: string): Promise<void> {
  assertTenantSchemaName(schemaName);
  await client.unsafe(`set client_min_messages to warning`);
  await client.unsafe(`do $$ begin
      create role "${schemaName}" nologin;
    exception when duplicate_object then null; end $$;`);
  await client.unsafe(`grant "${schemaName}" to current_user`);
}

/**
 * Re-applied on every migration because tables only ever arrive through a
 * migration: a facility role's rights are exactly its own schema's contents,
 * plus read access to `public` for the shared enum types.
 */
export async function grantFacilityRole(client: postgres.Sql, schemaName: string): Promise<void> {
  assertTenantSchemaName(schemaName);
  await client.unsafe(`set client_min_messages to warning`);
  // USAGE on public is needed to name shared types like `staff_role`. Since
  // PG15 the public schema grants no CREATE to anyone, and the only tables there
  // are the facility registry and the migration ledger — no clinical rows.
  await client.unsafe(`grant usage on schema public to "${schemaName}"`);
  await client.unsafe(`grant usage on schema "${schemaName}" to "${schemaName}"`);
  await client.unsafe(`grant all on all tables in schema "${schemaName}" to "${schemaName}"`);
  await client.unsafe(`grant all on all sequences in schema "${schemaName}" to "${schemaName}"`);
  await client.unsafe(`grant all on all functions in schema "${schemaName}" to "${schemaName}"`);
}

/**
 * Creates the facility schema, its sequences and its migration ledger.
 * Idempotent.
 *
 * `sequences: false` is for the one-time adoption of a pre-tenancy database,
 * where the sequences are about to arrive by moving out of `public` — creating
 * them here first would collide with the move.
 */
export async function ensureFacilitySchema(
  sql: postgres.Sql,
  schemaName: string,
  options: { sequences?: boolean } = {}
): Promise<void> {
  assertTenantSchemaName(schemaName);
  // Before the first statement: "already exists, skipping" arrives as a NOTICE,
  // which postgres.js prints to the console where it reads like a failure.
  await sql.unsafe(`set client_min_messages to warning`);
  await sql.unsafe(`create schema if not exists "${schemaName}"`);
  if (options.sequences !== false) {
    for (const sequence of TENANT_SEQUENCES) {
      await sql.unsafe(`create sequence if not exists "${sequence}" start 1 increment 1`);
    }
  }
  await sql.unsafe(`create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamp with time zone not null default now()
    )`);
}

/**
 * Two rules let the drizzle-generated files stay exactly as they were generated:
 *
 * - `CREATE TYPE` statements are skipped. Those types live in `public`, shared by
 *   every facility, and are created from the schema definitions instead.
 * - `"public".` prefixes are dropped, because Drizzle qualifies foreign key
 *   targets and type references that way. Left alone, a second facility's
 *   `patients.patient_id` foreign key would point at the *first* facility's
 *   table. Unqualified, it resolves through the facility's search_path and can
 *   only ever reference its own schema.
 */
function tenantStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => !/^create\s+type\b/i.test(statement))
    .map((statement) => statement.replaceAll('"public".', ''));
}

/**
 * Applies the generated migration files to one facility schema, recording each
 * file so a re-run is a no-op. A file whose contents changed after it was applied
 * is reported rather than silently replayed — that needs a deliberate decision.
 */
export async function applyTenantMigrations(sql: postgres.Sql, schemaName: string): Promise<string[]> {
  const files = (await readdir(migrationsFolder))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const contents = await readFile(resolve(migrationsFolder, file), 'utf8');
    const checksum = createHash('sha256').update(contents).digest('hex');
    const [row] = await sql`select checksum from schema_migrations where name = ${file}`;

    if (row) {
      if (row.checksum !== checksum) {
        console.warn(
          `Migration ${file} was edited after it was applied to ${schemaName}; skipping. Add a new migration file instead.`
        );
      }
      continue;
    }

    for (const statement of tenantStatements(contents)) {
      await sql.unsafe(statement);
    }
    await sql`insert into schema_migrations (name, checksum) values (${file}, ${checksum})`;
    applied.push(file);
  }

  return applied;
}

/**
 * Full build of one facility: its role, its schema, its tables, the constraints
 * Drizzle cannot express, then the rights its role holds. Runs on every
 * migration, so a facility added earlier picks up tables added later.
 */
export async function migrateFacilitySchema(schemaName: string): Promise<string[]> {
  return withSchemaConnection(schemaName, async (sql) => {
    await ensureFacilityRole(sql, schemaName);
    await ensureFacilitySchema(sql, schemaName);
    const applied = await applyTenantMigrations(sql, schemaName);
    await applyAdvancedConstraints(sql);
    await grantFacilityRole(sql, schemaName);
    return applied;
  });
}

/**
 * Records the generated files as applied for a schema that was built by moving
 * existing tables in from `public`, so the runner does not replay DDL onto it.
 */
export async function markFacilityMigrated(schemaName: string): Promise<void> {
  await withSchemaConnection(schemaName, async (sql) => {
    await ensureFacilitySchema(sql, schemaName);
    const files = (await readdir(migrationsFolder)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const contents = await readFile(resolve(migrationsFolder, file), 'utf8');
      const checksum = createHash('sha256').update(contents).digest('hex');
      await sql`insert into schema_migrations (name, checksum) values (${file}, ${checksum})
        on conflict (name) do update set checksum = excluded.checksum`;
    }
  });
}

/**
 * Moves the pre-tenancy single-clinic tables out of `public` into a facility
 * schema. Sequences travel with the tables because a column default captures the
 * sequence's OID at definition time: relocating the sequence keeps that default
 * pointing at the same object, now visible only to this facility.
 *
 * Runs once, guarded by the caller checking for `public.patients`.
 */
export async function relocatePublicTablesToSchema(
  sql: postgres.Sql,
  schemaName: string
): Promise<string[]> {
  assertTenantSchemaName(schemaName);
  const moved: string[] = [];

  for (const table of TENANT_TABLES) {
    const [exists] = await sql`
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${table} and c.relkind = 'r'`;
    if (!exists) continue;
    await sql.unsafe(`alter table public."${table}" set schema "${schemaName}"`);
    moved.push(table);
  }

  for (const sequence of TENANT_SEQUENCES) {
    const [exists] = await sql`
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${sequence} and c.relkind = 'S'`;
    if (!exists) continue;
    await sql.unsafe(`alter sequence public."${sequence}" set schema "${schemaName}"`);
    moved.push(`sequence ${sequence}`);
  }

  return moved;
}

/** Where a column default's `nextval('…'::regclass)` actually resolves to, per table. */
export async function sequenceBindingReport(
  schemaName: string
): Promise<Array<{ table: string; column: string; default: string }>> {
  return withSchemaConnection(schemaName, async (sql) => {
    const rows = await sql`
      select n.nspname || '.' || c.relname as table_name,
             a.attname as column_name,
             pg_get_expr(d.adbin, d.adrelid) as default_expr
      from pg_attrdef d
      join pg_class c on c.oid = d.adrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = d.adnum
      where n.nspname = ${schemaName} and pg_get_expr(d.adbin, d.adrelid) like '%nextval%'
      order by table_name, column_name`;
    return rows.map((row) => ({
      table: row.table_name as string,
      column: row.column_name as string,
      default: row.default_expr as string
    }));
  });
}
