import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { staff } from '../db/schema/index.js';
import { staffRole } from '../db/schema/enums.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../lib/password.js';
import { money } from '../lib/serialize.js';

type StaffRow = typeof staff.$inferSelect;

const ALL_ROLES = staffRole.enumValues;

const dto = (row: StaffRow) => ({
  id: row.id,
  fullName: row.fullName,
  email: row.email,
  role: row.role,
  phone: row.phone,
  department: row.department,
  specialty: row.specialty,
  consultationFee: money(row.consultationFee),
  isActive: row.isActive,
  lastLoginAt: row.lastLoginAt,
  createdAt: row.createdAt
});

const profileFields = z.object({
  fullName: z.string().min(2).max(160),
  email: z.string().email().max(200),
  role: z.enum(ALL_ROLES),
  phone: z.string().max(40).nullish(),
  department: z.string().max(120).nullish(),
  specialty: z.string().max(120).nullish(),
  consultationFee: z.coerce.number().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true)
});

const createSchema = profileFields.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
});

export async function staffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  app.get('/api/staff', async (request) => {
    const query = z
      .object({
        role: z.enum(ALL_ROLES).optional(),
        active: z.enum(['true', 'false']).optional()
      })
      .parse(request.query);

    const filters = [];
    if (query.role) filters.push(eq(staff.role, query.role));
    if (query.active) filters.push(eq(staff.isActive, query.active === 'true'));

    const rows = await db
      .select()
      .from(staff)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(staff.fullName));

    return rows.map(dto);
  });

  /** Clinicians available for booking, for dropdowns across the app. */
  app.get('/api/staff/bookable', async (request) => {
    const query = z.object({ role: z.enum(['doctor', 'nurse']).optional() }).parse(request.query);

    const rows = await db
      .select({
        id: staff.id,
        fullName: staff.fullName,
        role: staff.role,
        specialty: staff.specialty,
        department: staff.department,
        consultationFee: staff.consultationFee
      })
      .from(staff)
      .where(
        and(
          eq(staff.isActive, true),
          query.role
            ? eq(staff.role, query.role)
            : or(eq(staff.role, ROLES.doctor), eq(staff.role, ROLES.nurse))
        )
      )
      .orderBy(asc(staff.fullName));

    return rows.map((row) => ({ ...row, consultationFee: money(row.consultationFee) }));
  });

  app.post('/api/staff', { preHandler: authenticate([ROLES.admin]) }, async (request) => {
    const body = createSchema.parse(request.body);

    const [duplicate] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, body.email))
      .limit(1);
    if (duplicate) throw badRequest('A staff account with that email already exists.');

    const [row] = await db
      .insert(staff)
      .values({
        fullName: body.fullName,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        phone: body.phone ?? null,
        department: body.department ?? null,
        specialty: body.specialty ?? null,
        consultationFee: String(body.consultationFee),
        isActive: body.isActive
      })
      .returning();

    await audit(request, {
      action: 'staff.created',
      entity: 'staff',
      entityId: row.id,
      data: { role: row.role, email: row.email }
    });
    return dto(row);
  });

  app.patch('/api/staff/:id', { preHandler: authenticate([ROLES.admin]) }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = profileFields.partial().parse(request.body);

    const [existing] = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
    if (!existing) throw notFound('Staff member');

    if (existing.id === request.currentUser!.id && body.isActive === false) {
      throw badRequest('You cannot deactivate your own account.');
    }

    // Never leave the system without a way back in.
    if (existing.role === ROLES.admin && (body.role || body.isActive === false)) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(staff)
        .where(and(eq(staff.role, ROLES.admin), eq(staff.isActive, true), ne(staff.id, id)));
      if (Number(total) === 0) throw badRequest('At least one active administrator must remain.');
    }

    if (body.email && body.email !== existing.email) {
      const [clash] = await db.select({ id: staff.id }).from(staff).where(eq(staff.email, body.email)).limit(1);
      if (clash) throw badRequest('That email is already in use.');
    }

    const [row] = await db
      .update(staff)
      .set({
        ...body,
        consultationFee:
          body.consultationFee === undefined ? undefined : String(body.consultationFee),
        updatedAt: new Date()
      })
      .where(eq(staff.id, id))
      .returning();

    await audit(request, {
      action: 'staff.updated',
      entity: 'staff',
      entityId: id,
      data: { fields: Object.keys(body) }
    });
    return dto(row);
  });

  const resetSchema = z.object({
    newPassword: z.string().min(MIN_PASSWORD_LENGTH),
    adminPassword: z.string().min(1)
  });

  app.post(
    '/api/staff/:id/reset-password',
    { preHandler: authenticate([ROLES.admin]) },
    async (request, reply) => {
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
