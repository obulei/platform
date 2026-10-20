import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import type { Role } from '../lib/auth.js';
import { publicDb } from './client.js';
import { staff, staffRoles } from './schema/index.js';
import { facilities, type Facility } from './schema/registry.js';
import { platformAdmins, type PlatformAdminRow } from './schema/platform.js';
import { migrateFacilitySchema, tenantSchemaNameFor } from './tenant-ddl.js';
import { tenantDb } from './tenant.js';

/**
 * Provisioning a hospital: a registry row plus the schema that row points at.
 * Everything else a clinic customises later through its own admin screens.
 */

export async function createFacility(input: { slug: string; name: string }): Promise<Facility> {
  const schemaName = tenantSchemaNameFor(input.slug);

  const clash = await publicDb.select().from(facilities).where(eq(facilities.slug, input.slug));
  if (clash.length > 0) throw new Error(`A facility already uses the slug "${input.slug}".`);

  // Schema first, registry row second: a row that names a missing schema would
  // fail every request for that clinic, while an unclaimed schema claims nobody.
  // Re-running this for the same slug rebuilds in place, so a crashed run is
  // finished by running it again rather than by cleaning up by hand.
  await migrateFacilitySchema(schemaName);

  const [row] = await publicDb
    .insert(facilities)
    .values({ slug: input.slug, name: input.name, schemaName })
    .returning();

  return row;
}

/**
 * An administrator inside one hospital. Written here, in the shared layer,
 * because a facility with no staff row has no way to make its own — and because
 * this is the only place a person can be made an administrator from outside that
 * hospital. The password is hashed and never returned.
 */
export async function createAdministrator(
  facility: Facility,
  input: { fullName: string; email: string; password: string; roles?: Role[] }
): Promise<string> {
  const db = tenantDb(facility).db;
  const roles = input.roles ?? ['admin'];
  const [created] = await db
    .insert(staff)
    .values({
      fullName: input.fullName,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      isActive: true
    })
    .returning({ id: staff.id });

  await db.insert(staffRoles).values(roles.map((role) => ({ staffId: created.id, role, grantedBy: created.id })));
  return created.id;
}

/** Applies pending tenant migrations to every registered facility. */
export async function upgradeAllFacilities(): Promise<Array<{ slug: string; applied: string[] }>> {
  const rows = await publicDb.select().from(facilities).orderBy(facilities.slug);
  const results = [];
  for (const facility of rows) {
    results.push({ slug: facility.slug, applied: await migrateFacilitySchema(facility.schemaName) });
  }
  return results;
}

/**
 * Registry lookup for the platform guard. Returns null rather than throwing so
 * the caller can answer 401 — a deleted platform account must stop working at
 * once instead of falling back to whoever signs in next.
 */
export async function findPlatformAdminById(id: string): Promise<PlatformAdminRow | null> {
  const [row] = await publicDb.select().from(platformAdmins).where(eq(platformAdmins.id, id)).limit(1);
  return row ?? null;
}

/**
 * Platform administrator lookup for sign-in. Matched case-insensitively, the way
 * staff emails are, so a person cannot be locked out by how they capitalised
 * their address.
 */
export async function findPlatformAdminByEmail(email: string): Promise<PlatformAdminRow | null> {
  const [row] = await publicDb
    .select()
    .from(platformAdmins)
    .where(sql`lower(${platformAdmins.email}) = lower(${email})`)
    .limit(1);
  return row ?? null;
}

/**
 * The platform account itself. Kept apart from hospital staff: it can create
 * hospitals but holds no clinical role in any of them, so it can never read a
 * patient record.
 */
export async function createPlatformAdmin(input: {
  fullName: string;
  email: string;
  password: string;
}): Promise<PlatformAdminRow> {
  const existing = await findPlatformAdminByEmail(input.email);
  if (existing) throw new Error(`A platform administrator already uses ${input.email}.`);

  const [row] = await publicDb
    .insert(platformAdmins)
    .values({ fullName: input.fullName, email: input.email, passwordHash: await hashPassword(input.password) })
    .returning();
  return row;
}
