import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { publicDb } from '../db/client.js';
import { patients, staff, staffRoles } from '../db/schema/index.js';
import { facilities, type Facility } from '../db/schema/registry.js';
import { platformAdmins } from '../db/schema/platform.js';
import {
  createAdministrator,
  createFacility,
  createPlatformAdmin,
  findPlatformAdminByEmail,
  findPlatformAdminById
} from '../db/provision.js';
import { tenantDb, type TenantDb } from '../db/tenant.js';
import { FACILITY_SLUG, FACILITY_SLUG_HINT } from '../db/tenant-ddl.js';
import { authenticatePlatform, ROLES } from '../lib/auth.js';
import { brandingEdit } from '../lib/branding.js';
import { DECOY_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../lib/password.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * The platform operator's API: open a hospital, hand it its first administrator,
 * suspend it. Nothing here reads a patient. The identity behind these routes is a
 * `platform_admins` row, which is not staff and holds no clinical role, so a
 * platform token is refused by every clinic route and a clinic token is refused by
 * every route here.
 *
 * This is the only module that uses `publicDb`. Registry rows are the deployment's
 * own bookkeeping; clinical data is reached through a facility handle, and a
 * hospital's staff, patients and ledger are read here only as counts.
 */

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

const administratorSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the administrator name.').max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
});

const createFacilitySchema = z.object({
  slug: z.string().trim().toLowerCase().regex(FACILITY_SLUG, FACILITY_SLUG_HINT),
  name: z.string().trim().min(2, 'Enter the hospital name.').max(120),
  administrator: administratorSchema
});

const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

/**
 * Everything the operator may change about a hospital that already exists: its
 * name and the five branding columns. Each field is optional, so a form that
 * changes only the colour cannot clear the tagline it never sent.
 */
const facilityEditSchema = brandingEdit
  .extend({ name: z.string().trim().min(2, 'Enter the hospital name.').max(120).optional() })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Send a name or at least one branding field.'
  });

/** An operator editing a hospital's administrator: name, whether it can sign in, or both. */
const administratorEditSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter the administrator name.').max(120).optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => value.fullName !== undefined || value.isActive !== undefined, {
    message: 'Send a name, an active flag, or both.'
  });

const passwordSchema = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
});

/** A platform operator adding another of their own kind. */
const operatorSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the operator name.').max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
});

/** Only the fields an operator may ever see about another operator. */
const operatorDto = (row: typeof platformAdmins.$inferSelect) => ({
  id: row.id,
  fullName: row.fullName,
  email: row.email,
  createdAt: row.createdAt,
  lastLoginAt: row.lastLoginAt
});

/** A slug is a lookup key here, never SQL text — but it must still be shaped like one. */
function readSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!FACILITY_SLUG.test(slug)) throw badRequest(FACILITY_SLUG_HINT);
  return slug;
}

/**
 * Registry row by slug, whatever its status. `findFacilityBySlug` hides suspended
 * hospitals because their staff must not sign in; the operator needs to see them in
 * order to bring one back.
 */
async function facilityBySlug(slug: string): Promise<Facility | null> {
  const [row] = await publicDb.select().from(facilities).where(eq(facilities.slug, slug)).limit(1);
  return row ?? null;
}

/**
 * One hospital as the operator sees it: identity, whether it is open, and how much
 * lives inside it. Counts come from the facility's own schema, so an empty hospital
 * reports zeros rather than another clinic's numbers.
 */
async function facilityCard(facility: Facility) {
  const db = tenantDb(facility).db;
  const [staffTotal] = await db.select({ total: count() }).from(staff);
  const [patientTotal] = await db.select({ total: count() }).from(patients);
  const administrators = await db
    .select({ id: staff.id, fullName: staff.fullName, email: staff.email, isActive: staff.isActive })
    .from(staffRoles)
    .innerJoin(staff, eq(staff.id, staffRoles.staffId))
    .where(eq(staffRoles.role, ROLES.admin))
    .orderBy(staff.email);

  return {
    id: facility.id,
    slug: facility.slug,
    name: facility.name,
    branding: {
      mark: facility.mark,
      tagline: facility.tagline,
      accent: facility.accent,
      reportCaption: facility.reportCaption,
      reportFootnote: facility.reportFootnote
    },
    status: facility.status,
    createdAt: facility.createdAt,
    staffCount: staffTotal.total,
    patientCount: patientTotal.total,
    administrators,
    activeAdministratorCount: administrators.filter((row) => row.isActive).length
  };
}

/**
 * One administrator row of one hospital, and the assurance that it really is an
 * administrator. Everything else on the Staff table belongs to that hospital's own
 * administrators, reached through `/api/staff` with a hospital session — the
 * operator who opens hospitals does not get to rename a nurse.
 */
async function administratorOf(db: TenantDb, staffId: string) {
  const [person] = await db
    .select({ id: staff.id, fullName: staff.fullName, email: staff.email, isActive: staff.isActive })
    .from(staff)
    .where(eq(staff.id, staffId))
    .limit(1);
  if (!person) throw notFound('Administrator');

  const [grant] = await db
    .select({ role: staffRoles.role })
    .from(staffRoles)
    .where(and(eq(staffRoles.staffId, staffId), eq(staffRoles.role, ROLES.admin)))
    .limit(1);
  if (!grant) {
    throw badRequest(
      'That account is not an administrator of this hospital. Manage it from the hospital’s Staff screen.'
    );
  }
  return person;
}

/** A staff id arrives as a path parameter, so it has to be one before it reaches SQL. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readStaffId(raw: string): string {
  if (!UUID.test(raw)) throw badRequest('An identifier is not valid.');
  return raw;
}

/**
 * How many administrators could still sign in at this hospital. Switching an
 * account off is reversible, but switching off the last one is not something a
 * clinic notices until nobody can reach its Staff screen — so it is refused here
 * rather than left as the operator's problem to discover.
 */
async function activeAdministratorCount(db: TenantDb): Promise<number> {
  const rows = await db
    .select({ id: staff.id, isActive: staff.isActive })
    .from(staffRoles)
    .innerJoin(staff, eq(staff.id, staffRoles.staffId))
    .where(eq(staffRoles.role, ROLES.admin));
  return rows.filter((row) => row.isActive).length;
}

/** The hospital named in the path, whether or not it is open. */
async function facilityFromParams(request: FastifyRequest): Promise<Facility> {
  const facility = await facilityBySlug(readSlug((request.params as { slug: string }).slug));
  if (!facility) throw notFound('Hospital');
  return facility;
}

export async function platformRoutes(app: FastifyInstance) {
  app.post('/api/platform/login', async (request) => {
    const { email, password } = loginSchema.parse(request.body);
    const admin = await findPlatformAdminByEmail(email);

    // Unknown account and wrong password answer identically, and both cost the same
    // scrypt work, so this endpoint cannot be used to enumerate platform accounts.
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      if (!admin) await verifyPassword(password, DECOY_HASH);
      throw badRequest('Email or password is incorrect.');
    }

    await publicDb
      .update(platformAdmins)
      .set({ lastLoginAt: new Date() })
      .where(eq(platformAdmins.id, admin.id));

    const token = app.jwt.sign({ sub: admin.id, scope: 'platform' }, { expiresIn: '12h' });
    request.log.info({ platformAdminId: admin.id }, 'platform sign-in');

    return {
      token,
      admin: { id: admin.id, fullName: admin.fullName, email: admin.email }
    };
  });

  app.get('/api/platform/me', { preHandler: authenticatePlatform() }, async (request) => {
    const admin = request.platformAdmin!;
    return { id: admin.id, fullName: admin.fullName, email: admin.email };
  });

  app.get('/api/platform/facilities', { preHandler: authenticatePlatform() }, async () => {
    const rows = await publicDb.select().from(facilities).orderBy(facilities.name);
    return { items: await Promise.all(rows.map(facilityCard)), total: rows.length };
  });

  /**
   * Open a hospital and hand it its first administrator in one action, because a
   * hospital with no administrator cannot make one itself: the Staff screen that
   * grants roles lives inside the hospital and needs an administrator to reach it.
   */
  app.post('/api/platform/facilities', { preHandler: authenticatePlatform() }, async (request) => {
    const input = createFacilitySchema.parse(request.body);

    if (await facilityBySlug(input.slug)) {
      throw conflict(`Another hospital already signs in at "${input.slug}". Choose a different address.`);
    }

    const facility = await createFacility({ slug: input.slug, name: input.name });
    const administratorId = await createAdministrator(facility, input.administrator);

    request.log.info(
      { facilityId: facility.id, slug: facility.slug, administratorId },
      'platform: hospital added'
    );

    return { ...(await facilityCard(facility)), administratorId };
  });

  /**
   * Rename a hospital, or change the wording and colour it presents. The address
   * in the path stays put on purpose: it is what staff type to reach their clinic
   * and what the schema and role are named after, so changing it would lock every
   * account out to rename a sign.
   */
  app.patch(
    '/api/platform/facilities/:slug',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const facility = await facilityFromParams(request);
      const patch = facilityEditSchema.parse(request.body);

      const [updated] = await publicDb
        .update(facilities)
        .set(patch)
        .where(eq(facilities.id, facility.id))
        .returning();

      request.log.info(
        { facilityId: facility.id, fields: Object.keys(patch) },
        'platform: hospital details changed'
      );
      return facilityCard(updated);
    }
  );

  /** Another administrator at a hospital that already has one. */
  app.post(
    '/api/platform/facilities/:slug/administrators',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const facility = await facilityFromParams(request);
      const input = administratorSchema.parse(request.body);

      const administratorId = await createAdministrator(facility, input);
      request.log.info({ facilityId: facility.id, administratorId }, 'platform: administrator added');
      return { id: administratorId, email: input.email, fullName: input.fullName };
    }
  );

  /** Rename an administrator, or switch its ability to sign in off and back on. */
  app.patch(
    '/api/platform/facilities/:slug/administrators/:staffId',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const facility = await facilityFromParams(request);
      const db = tenantDb(facility).db;
      const person = await administratorOf(db, readStaffId((request.params as { staffId: string }).staffId));
      const patch = administratorEditSchema.parse(request.body);

      if (patch.isActive === false && person.isActive && (await activeAdministratorCount(db)) <= 1) {
        throw badRequest(
          'This is the only administrator who can sign in at this hospital. Make another one first — ' +
            'otherwise nobody inside the clinic can manage staff, beds or tariffs.'
        );
      }

      const changes: Partial<{ fullName: string; isActive: boolean }> = {};
      if (patch.fullName !== undefined) changes.fullName = patch.fullName;
      if (patch.isActive !== undefined) changes.isActive = patch.isActive;

      const [updated] = await db
        .update(staff)
        .set(changes)
        .where(eq(staff.id, person.id))
        .returning({ id: staff.id, fullName: staff.fullName, email: staff.email, isActive: staff.isActive });

      request.log.info({ facilityId: facility.id, staffId: person.id, ...changes }, 'platform: administrator edited');
      return updated;
    }
  );

  /**
   * A new password for an administrator who lost theirs. The person inside the
   * hospital can do the same for anyone else through the Staff screen; this exists
   * because the operator is the only one who can reach a hospital nobody has
   * signed in to yet. A live session is not cut short — it expires on its own, the
   * same way the clinic's own reset works.
   */
  app.post(
    '/api/platform/facilities/:slug/administrators/:staffId/reset-password',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const facility = await facilityFromParams(request);
      const db = tenantDb(facility).db;
      const person = await administratorOf(db, readStaffId((request.params as { staffId: string }).staffId));
      const { password } = passwordSchema.parse(request.body);

      await db
        .update(staff)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(staff.id, person.id));

      request.log.info({ facilityId: facility.id, staffId: person.id }, 'platform: administrator password reset');
      return { id: person.id, email: person.email, passwordChangedAt: new Date().toISOString() };
    }
  );

  /**
   * Suspend or reopen a hospital. Suspension takes effect on the next request:
   * sign-in looks the facility up by slug and refuses any row that is not active,
   * and the auth hook re-reads the registry on every call, so a token minted
   * minutes earlier stops working without waiting to expire.
   */
  app.patch(
    '/api/platform/facilities/:slug/status',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const facility = await facilityFromParams(request);
      const { status } = statusSchema.parse(request.body);

      const [updated] = await publicDb
        .update(facilities)
        .set({ status })
        .where(eq(facilities.id, facility.id))
        .returning();

      request.log.info({ facilityId: facility.id, status }, 'platform: hospital status changed');
      return facilityCard(updated);
    }
  );

  /**
   * The operators themselves. An account is removed, never deactivated: it holds
   * no clinical role and grants none, so a disabled one would only be a locked door
   * with a name on it. The last operator and the one making the request cannot be
   * removed, because a deployment nobody can sign in to is a deployment nobody can
   * fix.
   */
  app.get('/api/platform/operators', { preHandler: authenticatePlatform() }, async () => {
    const rows = await publicDb.select().from(platformAdmins).orderBy(platformAdmins.createdAt);
    return { items: rows.map(operatorDto), total: rows.length };
  });

  app.post(
    '/api/platform/operators',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const input = operatorSchema.parse(request.body);
      if (await findPlatformAdminByEmail(input.email)) {
        throw conflict(`Another platform operator already uses ${input.email}.`);
      }

      const created = await createPlatformAdmin(input);
      request.log.info({ platformAdminId: created.id }, 'platform: operator added');
      return operatorDto(created);
    }
  );

  app.delete(
    '/api/platform/operators/:id',
    { preHandler: authenticatePlatform() },
    async (request) => {
      const id = readStaffId((request.params as { id: string }).id);
      if (id === request.platformAdmin!.id) {
        throw badRequest('You cannot remove the account you are signed in with.');
      }

      const operator = await findPlatformAdminById(id);
      if (!operator) throw notFound('Platform operator');

      const [{ total }] = await publicDb.select({ total: count() }).from(platformAdmins);
      if (total <= 1) {
        throw badRequest('This is the only platform operator. Add another before removing one.');
      }

      await publicDb.delete(platformAdmins).where(eq(platformAdmins.id, id));
      request.log.info({ platformAdminId: id }, 'platform: operator removed');
      return { removed: id };
    }
  );
}
