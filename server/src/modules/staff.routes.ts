import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { staff, staffRoles } from '../db/schema/index.js';
import {
  ALL_ROLES,
  authenticate,
  facilityDb,
  grantedRoles,
  ROLES,
  type Role,
  type TenantDb
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../lib/password.js';
import { money } from '../lib/serialize.js';

type StaffRow = typeof staff.$inferSelect;

const CLINICIAN_ROLES: Role[] = [ROLES.doctor, ROLES.nurse];

const dto = (row: StaffRow, roles: Role[]) => ({
  id: row.id,
  fullName: row.fullName,
  email: row.email,
  roles,
  phone: row.phone,
  department: row.department,
  specialty: row.specialty,
  consultationFee: money(row.consultationFee),
  isActive: row.isActive,
  lastLoginAt: row.lastLoginAt,
  createdAt: row.createdAt
});

/** Grants for several accounts in one query, keyed by staff id, in enum order. */
async function grantsByStaff(db: TenantDb, ids: string[]): Promise<Map<string, Role[]>> {
  const byId = new Map<string, Role[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byId;

  const rows = await db
    .select({ staffId: staffRoles.staffId, role: staffRoles.role })
    .from(staffRoles)
    .where(inArray(staffRoles.staffId, ids));

  for (const row of rows) byId.get(row.staffId)?.push(row.role);
  for (const roles of byId.values()) roles.sort((a, b) => ALL_ROLES.indexOf(a) - ALL_ROLES.indexOf(b));
  return byId;
}

/** Account ids holding any of these roles, for use as a subquery filter. */
function withRoles(db: TenantDb, roles: Role[]) {
  return db.select({ id: staffRoles.staffId }).from(staffRoles).where(inArray(staffRoles.role, roles));
}

const profileFields = z.object({
  fullName: z.string().min(2).max(160),
  email: z.string().email().max(200),
  roles: z.array(z.enum(ALL_ROLES)).min(1, 'Assign at least one role.'),
  phone: z.string().max(40).nullish(),
  department: z.string().max(120).nullish(),
  specialty: z.string().max(120).nullish(),
  consultationFee: z.coerce.number().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true)
});

const createSchema = profileFields.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
});

/**
 * One grant per role, in enum order, whatever order the payload arrived in —
 * so a response, an audit entry and the sign-in menu always read the same.
 */
const uniqueRoles = (roles: Role[]) =>
  [...new Set(roles)].sort((a, b) => ALL_ROLES.indexOf(a) - ALL_ROLES.indexOf(b));

export async function staffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  app.get('/api/staff', async (request) => {
    const db = facilityDb(request);
    const query = z
      .object({
        role: z.enum(ALL_ROLES).optional(),
        active: z.enum(['true', 'false']).optional()
      })
      .parse(request.query);

    const filters = [];
    if (query.role) filters.push(inArray(staff.id, withRoles(db, [query.role])));
    if (query.active) filters.push(eq(staff.isActive, query.active === 'true'));

    const rows = await db
      .select()
      .from(staff)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(staff.fullName));

    const grants = await grantsByStaff(db, rows.map((row) => row.id));
    return rows.map((row) => dto(row, grants.get(row.id) ?? []));
  });

  /** Clinicians available for booking, for dropdowns across the app. */
  app.get('/api/staff/bookable', async (request) => {
    const db = facilityDb(request);
    const query = z.object({ role: z.enum(['doctor', 'nurse']).optional() }).parse(request.query);

    const rows = await db
      .select({
        id: staff.id,
        fullName: staff.fullName,
        specialty: staff.specialty,
        department: staff.department,
        consultationFee: staff.consultationFee
      })
      .from(staff)
      .where(
        and(
          eq(staff.isActive, true),
          inArray(staff.id, withRoles(db, query.role ? [query.role] : CLINICIAN_ROLES))
        )
      )
      .orderBy(asc(staff.fullName));

    const grants = await grantsByStaff(db, rows.map((row) => row.id));
    return rows.map((row) => ({
      ...row,
      roles: grants.get(row.id) ?? [],
      consultationFee: money(row.consultationFee)
    }));
  });

  app.post('/api/staff', { preHandler: authenticate([ROLES.admin]) }, async (request) => {
    const db = facilityDb(request);
    const body = createSchema.parse(request.body);
    const roles = uniqueRoles(body.roles);

    const [duplicate] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, body.email))
      .limit(1);
    if (duplicate) throw badRequest('A staff account with that email already exists.');

    const actorId = request.currentUser!.id;
    const [row, grants] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(staff)
        .values({
          fullName: body.fullName,
          email: body.email,
          passwordHash: await hashPassword(body.password),
          phone: body.phone ?? null,
          department: body.department ?? null,
          specialty: body.specialty ?? null,
          consultationFee: String(body.consultationFee),
          isActive: body.isActive
        })
        .returning();
      await tx.insert(staffRoles).values(roles.map((role) => ({ staffId: created.id, role, grantedBy: actorId })));
      return [created, roles] as const;
    });

    await audit(request, {
      action: 'staff.created',
      entity: 'staff',
      entityId: row.id,
      data: { roles: grants, email: row.email }
    });
    return dto(row, grants);
  });

  app.patch('/api/staff/:id', { preHandler: authenticate([ROLES.admin]) }, async (request) => {
    const db = facilityDb(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = profileFields.partial().parse(request.body);

    const [existing] = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
    if (!existing) throw notFound('Staff member');

    if (existing.id === request.currentUser!.id && body.isActive === false) {
      throw badRequest('You cannot deactivate your own account.');
    }

    // Never leave the system without a way back in: losing the admin grant, or
    // going inactive, is only refused when no other active administrator would
    // remain.
    const heldRoles = await grantedRoles(db, id);
    const demotes = body.roles !== undefined && !body.roles.includes(ROLES.admin);
    if (heldRoles.includes(ROLES.admin) && (demotes || body.isActive === false)) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(staff)
        .where(
          and(
            eq(staff.isActive, true),
            inArray(staff.id, withRoles(db, [ROLES.admin])),
            ne(staff.id, id)
          )
        );
      if (Number(total) === 0) throw badRequest('At least one active administrator must remain.');
    }

    if (body.email && body.email !== existing.email) {
      const [clash] = await db.select({ id: staff.id }).from(staff).where(eq(staff.email, body.email)).limit(1);
      if (clash) throw badRequest('That email is already in use.');
    }

    const { roles, ...fields } = body;
    const grants = roles ? uniqueRoles(roles) : undefined;
    const actorId = request.currentUser!.id;

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(staff)
        .set({
          ...fields,
          consultationFee: fields.consultationFee === undefined ? undefined : String(fields.consultationFee),
          updatedAt: new Date()
        })
        .where(eq(staff.id, id))
        .returning();

      // Replacing the whole grant set is what makes a revoked role take effect
      // as soon as the next request is resolved.
      if (grants) {
        await tx.delete(staffRoles).where(eq(staffRoles.staffId, id));
        await tx.insert(staffRoles).values(grants.map((role) => ({ staffId: id, role, grantedBy: actorId })));
      }
      return updated;
    });

    await audit(request, {
      action: 'staff.updated',
      entity: 'staff',
      entityId: id,
      data: { fields: Object.keys(body), roles: grants }
    });
    return dto(row, grants ?? heldRoles);
  });

  const resetSchema = z.object({
    newPassword: z.string().min(MIN_PASSWORD_LENGTH),
    adminPassword: z.string().min(1)
  });

  app.post(
    '/api/staff/:id/reset-password',
    { preHandler: authenticate([ROLES.admin]) },
    async (request, reply) => {
      const db = facilityDb(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = resetSchema.parse(request.body);

      // Changing someone else's password is itself a sensitive action, so the
      // acting administrator re-proves their own credentials first.
      const [actor] = await db.select().from(staff).where(eq(staff.id, request.currentUser!.id)).limit(1);
      if (!actor || !(await verifyPassword(body.adminPassword, actor.passwordHash))) {
        throw badRequest('Your own password is required to reset another account.');
      }

      const [target] = await db.select({ id: staff.id }).from(staff).where(eq(staff.id, id)).limit(1);
      if (!target) throw notFound('Staff member');

      await db
        .update(staff)
        .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
        .where(eq(staff.id, id));

      await audit(request, {
        action: 'staff.password_reset',
        entity: 'staff',
        entityId: id
      });
      return reply.status(204).send();
    }
  );
}
