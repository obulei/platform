import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../env.js';
import * as tenantSchema from './schema/index.js';
import { facilities, type Facility } from './schema/registry.js';
import { publicDb } from './client.js';

/**
 * One Postgres schema per facility, and one connection pool per facility.
 *
 * A pool is opened with `options=-csearch_path=<schema>,public -crole=<schema>` in
 * its connection string, so every physical connection it makes — including ones
 * created after an idle eviction — resolves unqualified table names inside exactly
 * one facility's schema, keeps shared enum types in `public` visible, and runs as
 * the role granted rights over only that facility. The alternative of issuing
 * `SET search_path` on a shared pool was measured and rejected: a session-scoped
 * set survives its transaction and is handed to the next borrower, which would
 * read another hospital's patients.
 */

/** Only names provisioning can produce. Anything else is refused, never interpolated. */
const TENANT_SCHEMA_NAME = /^f_[a-z0-9][a-z0-9_]{0,58}$/;

/**
 * Pools are small because they multiply with tenants: with seven facilities this
 * caps the deployment at 28 connections. Raise it per facility if a clinic grows.
 */
const POOL_MAX = Number(process.env.TENANT_POOL_MAX ?? 4);

const openPools = new Map<string, TenantHandle>();

function buildDrizzle(client: postgres.Sql) {
  return drizzle(client, { schema: tenantSchema });
}

/** The clinical query handle, bound to exactly one facility schema. */
export type TenantDb = ReturnType<typeof buildDrizzle>;

export type TenantHandle = {
  db: TenantDb;
  /** Raw client, for DDL and for code that must not carry an ORM layer. */
  client: postgres.Sql;
  schemaName: string;
};

function buildPool(schemaName: string): TenantHandle {
  const separator = env.databaseUrl.includes('?') ? '&' : '?';
  // Two startup parameters, measured to survive reconnects: `search_path` makes
  // unqualified names resolve inside one facility, `role` makes reaching any other
  // facility's schema a permission error even when spelled out in full.
  const connectionString = `${env.databaseUrl}${separator}options=-csearch_path%3D${schemaName},public%20-crole%3D${schemaName}`;
  const client = postgres(connectionString, { max: POOL_MAX, idle_timeout: 20 });
  return { client, db: drizzle(client, { schema: tenantSchema }), schemaName };
}

/**
 * The handle for a facility row. `facility` must come from the registry, not
 * from a request body — the schema name is validated but never trusted from a
 * caller, so that a compromised token cannot name a schema.
 */
export function tenantDb(facility: Facility): TenantHandle {
  const schemaName = facility.schemaName;
  if (!TENANT_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Facility ${facility.slug} names an unsafe schema (${schemaName}).`);
  }
  const existing = openPools.get(schemaName);
  if (existing) return existing;
  const handle = buildPool(schemaName);
  openPools.set(schemaName, handle);
  return handle;
}

/** Active facilities only: a suspended clinic's staff cannot sign in. */
export async function findFacilityBySlug(slug: string): Promise<Facility | null> {
  const [row] = await publicDb
    .select()
    .from(facilities)
    .where(eq(facilities.slug, slug))
    .limit(1);
  return row?.status === 'active' ? row : null;
}

/**
 * Sign-in lookup, lenient about what a person remembers. The address works in any
 * capitalisation — it is stored lowercase, so folding the input cannot make two
 * hospitals collide — and a hospital's display name works while exactly one
 * hospital has that name.
 *
 * An address is what provisioning hands out and never renames, but staff are told
 * their clinic's name, so a sign-in that only accepted the address silently turns
 * into a support call every time. A shared display name answers as if nobody
 * matched rather than picking one: this endpoint must not be able to list
 * facilities or hint which of two same-named clinics is which.
 */
export async function findFacilityByAddress(input: string): Promise<Facility | null> {
  const wanted = input.trim().toLowerCase();

  const [bySlug] = await publicDb
    .select()
    .from(facilities)
    .where(sql`lower(${facilities.slug}) = ${wanted}`)
    .limit(1);
  if (bySlug) return bySlug.status === 'active' ? bySlug : null;

  const sameName = await publicDb
    .select()
    .from(facilities)
    .where(and(sql`lower(${facilities.name}) = ${wanted}`, eq(facilities.status, 'active')));
  return sameName.length === 1 ? sameName[0] : null;
}

/**
 * Registry lookup for the auth hook. Returns null rather than throwing so the
 * caller can answer 401: a token minted before a facility was deleted or
 * suspended must stop working immediately, not fall back to another schema.
 */
export async function findFacilityById(id: string): Promise<Facility | null> {
  const [row] = await publicDb
    .select()
    .from(facilities)
    .where(eq(facilities.id, id))
    .limit(1);
  return row?.status === 'active' ? row : null;
}

export async function listFacilities(): Promise<Facility[]> {
  return publicDb.select().from(facilities).orderBy(facilities.name);
}

/** Used by shutdown and by tests; live pools are otherwise reused for the process lifetime. */
export async function closeTenantPools(): Promise<void> {
  const handles = [...openPools.values()];
  openPools.clear();
  await Promise.all(handles.map((handle) => handle.client.end()));
}
