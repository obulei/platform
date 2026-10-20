import { count, eq } from 'drizzle-orm';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { publicClient, publicDb } from './client.js';
import { facilities } from './schema/registry.js';
import {
  ensureFacilitySchema,
  markFacilityMigrated,
  relocatePublicTablesToSchema,
  sharedTypeStatements,
  tenantSchemaNameFor,
  withSchemaConnection
} from './tenant-ddl.js';
import { createFacility, upgradeAllFacilities } from './provision.js';

const here = dirname(fileURLToPath(import.meta.url));
const registryFolder = resolve(here, 'migrations/registry');

/**
 * Migration order matters:
 *
 * 1. shared enum types in `public`, generated from the schema definitions so
 *    they cannot drift from `schema/enums.ts`
 * 2. the facility registry in `public`
 * 3. the one-time move of pre-tenancy tables into the first facility's schema
 * 4. the first facility, when this is a brand-new database
 * 5. every registered facility schema, brought up to the current DDL
 */
async function main() {
  await publicClient.unsafe(`set client_min_messages to warning`);

  for (const statement of sharedTypeStatements()) {
    await publicClient.unsafe(statement);
  }
  console.log('shared types ensured');

  for (const file of (await readdir(registryFolder)).filter((name) => name.endsWith('.sql')).sort()) {
    const contents = await readFile(resolve(registryFolder, file), 'utf8');
    const statements = contents
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await publicClient.unsafe(statement);
    }
    console.log(`registry ${file} applied`);
  }

  const adopted = await adoptLegacyPublicTables();
  if (!adopted) await ensureFirstFacility();

  const upgraded = await upgradeAllFacilities();
  for (const { slug, applied } of upgraded) {
    console.log(applied.length ? `${slug}: applied ${applied.join(', ')}` : `${slug}: up to date`);
  }

  await publicClient.end();
}

/**
 * A database created before tenancy has its clinical tables sitting in `public`.
 * They are moved into the first hospital's schema rather than copied or dropped,
 * so an existing clinic keeps its patients, ledger and audit trail unchanged.
 */
async function adoptLegacyPublicTables(): Promise<boolean> {
  const [legacy] = await publicClient`
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'patients' and c.relkind = 'r'`;
  if (!legacy) return false;

  const slug = env.firstFacilitySlug;
  const schemaName = tenantSchemaNameFor(slug);

  const [existing] = await publicDb.select().from(facilities).where(eq(facilities.slug, slug));
  if (!existing) {
    await publicDb
      .insert(facilities)
      .values({ slug, name: env.firstFacilityName, schemaName });
  }

  const moved = await withSchemaConnection(schemaName, async (sql) => {
    await ensureFacilitySchema(sql, schemaName, { sequences: false });
    return relocatePublicTablesToSchema(sql, schemaName);
  });

  // The moved tables already carry this DDL, so the ledger is stamped rather than
  // replayed — replaying it would collide with what has just arrived.
  await markFacilityMigrated(schemaName);

  console.log(`${slug}: moved out of public -> ${schemaName}: ${moved.join(', ') || 'nothing to move'}`);
  return true;
}

/**
 * A fresh database holds no facility and no legacy tables, which would leave
 * `db:seed` and sign-in with nowhere to land. The clinic named in the
 * environment becomes the first tenant, so an install needs one command.
 */
async function ensureFirstFacility(): Promise<void> {
  const [{ total }] = await publicDb.select({ total: count() }).from(facilities);
  if (total > 0) return;

  const facility = await createFacility({
    slug: env.firstFacilitySlug,
    name: env.firstFacilityName
  });
  console.log(`${facility.slug}: new install, created ${facility.schemaName}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
