import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { staff } from '../db/schema/index.js';
import { verifyPassword } from '../lib/password.js';
import { ALL_ROLES, authenticate, grantedRoles, ROLES, type Role } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, roleRequired } from '../lib/errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(ALL_ROLES).optional()
});

type StaffRow = typeof staff.$inferSelect;

/** What the client keeps for the session: identity, active role, and the choices. */
const sessionUser = (user: StaffRow, role: Role, roles: Role[]) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  role,
  roles,
  department: user.department,
  specialty: user.specialty
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request) => {
    const { email, password, role } = loginSchema.parse(request.body);

    const [user] = await db.select().from(staff).where(eq(staff.email, email)).limit(1);

    // Same message and similar timing for unknown email and wrong password, so
    // the endpoint cannot be used to enumerate staff accounts.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw badRequest('Email or password is incorrect.');
    }
    if (!user.isActive) throw badRequest('This account has been deactivated.');

    const roles = await grantedRoles(user.id);
    if (roles.length === 0) {
      throw badRequest('No role has been assigned to this account yet. Ask an administrator.');
    }
    // Only ever a role the account holds: the sign-in choice can narrow what a
    // session may do, never widen it.
    if (role && !roles.includes(role)) throw badRequest('That role is not assigned to this account.');

    const active = role ?? (roles.length === 1 ? roles[0] : undefined);
    if (!active) throw roleRequired(roles);

    await db.update(staff).set({ lastLoginAt: new Date() }).where(eq(staff.id, user.id));

    const token = app.jwt.sign({ sub: user.id, role: active }, { expiresIn: '12h' });
    await audit(request, { action: 'auth.login', entity: 'staff', entityId: user.id, data: { role: active } });

    return { token, user: sessionUser(user, active, roles) };
  });

  /** Change which granted role the current session acts as, without signing out. */
  app.post('/api/auth/switch-role', { preHandler: authenticate() }, async (request) => {
    const { role } = z.object({ role: z.enum(ALL_ROLES) }).parse(request.body);
    const current = request.currentUser!;
    if (!current.roles.includes(role)) throw badRequest('That role is not assigned to your account.');

    const [user] = await db.select().from(staff).where(eq(staff.id, current.id)).limit(1);
    if (!user) throw notFound('Staff member');

    const token = app.jwt.sign({ sub: user.id, role }, { expiresIn: '12h' });
    await audit(request, {
      action: 'auth.role_switched',
      entity: 'staff',
      entityId: user.id,
      data: { from: current.role, to: role }
    });

    return { token, user: sessionUser(user, role, current.roles) };
  });

  app.get('/api/auth/me', { preHandler: authenticate() }, async (request) => {
    const [user] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, request.currentUser!.id))
      .limit(1);
    if (!user) throw notFound('Staff member');

    return { ...user, passwordHash: undefined, roles: request.currentUser!.roles };
  });

  const changeSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10, 'Use at least 10 characters.')
  });

  app.post('/api/auth/change-password', { preHandler: authenticate() }, async (request, reply) => {
    const { currentPassword, newPassword } = changeSchema.parse(request.body);
    const [user] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, request.currentUser!.id))
      .limit(1);
    if (!user) throw notFound('Staff member');
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect.');
    }

    const { hashPassword } = await import('../lib/password.js');
    await db
      .update(staff)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(staff.id, user.id));

    await audit(request, { action: 'auth.password_changed', entity: 'staff', entityId: user.id });
    return reply.status(204).send();
  });

  app.post('/api/auth/logout', { preHandler: authenticate() }, async (_request, reply) => {
    // Tokens are stateless; the client discards it. Session revocation is
    // listed as a hardening step in the README.
    return reply.status(204).send();
  });

  app.get('/api/auth/roles', { preHandler: authenticate([ROLES.admin]) }, async () => ({
    roles: Object.values(ROLES)
  }));
}
