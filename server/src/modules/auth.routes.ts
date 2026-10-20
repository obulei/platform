import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { staff } from '../db/schema/index.js';
import { findFacilityByAddress } from '../db/tenant.js';
import { DECOY_HASH, verifyPassword } from '../lib/password.js';
import {
  ALL_ROLES,
  authenticate,
  bindFacility,
  facilityDb,
  grantedRoles,
  ROLES,
  type Role
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, roleRequired } from '../lib/errors.js';
import { sessionFacility, type SessionFacility } from '../lib/branding.js';

/**
 * Sign-in is addressed to one hospital: staff emails are unique inside a
 * facility, not across the platform, so `admin@clinic.test` can exist at two
 * clinics and the address decides which door it opens. `findFacilityByAddress`
 * takes that address in any capitalisation, plus a hospital's display name while
 * no two hospitals share it, because the name is what staff are actually told.
 */
const loginSchema = z.object({
  facility: z.string().trim().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(ALL_ROLES).optional()
});

type StaffRow = typeof staff.$inferSelect;

/** What the client keeps for the session: identity, active role, the choices, and the hospital's own wording. */
const sessionUser = (
  user: StaffRow,
  role: Role,
  roles: Role[],
  facility: SessionFacility
) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  role,
  roles,
  department: user.department,
  specialty: user.specialty,
  facility
});

/**
 * Well-formed but unreachable. A wrong hospital name answers before touching a
 * password, so it is hashed against `DECOY_HASH` instead — the attempt then costs
 * the same scrypt work as a wrong password and stays indistinguishable in timing.
 */
export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request) => {
    const { facility: address, email, password, role } = loginSchema.parse(request.body);

    const facility = await findFacilityByAddress(address);
    // Unknown and suspended hospitals both land here, and the answer is the one
    // an unknown account would get: this endpoint cannot list facilities.
    if (!facility) {
      await verifyPassword(password, DECOY_HASH);
      throw badRequest('Hospital, email or password is incorrect.');
    }

    const db = bindFacility(request, facility);
    const [user] = await db.select().from(staff).where(eq(staff.email, email)).limit(1);

    // Same message and similar timing for unknown email and wrong password, so
    // the endpoint cannot be used to enumerate staff accounts.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw badRequest('Hospital, email or password is incorrect.');
    }
    if (!user.isActive) throw badRequest('This account has been deactivated.');

    const roles = await grantedRoles(db, user.id);
    if (roles.length === 0) {
      throw badRequest('No role has been assigned to this account yet. Ask an administrator.');
    }
    // Only ever a role the account holds: the sign-in choice can narrow what a
    // session may do, never widen it.
    if (role && !roles.includes(role)) throw badRequest('That role is not assigned to this account.');

    const active = role ?? (roles.length === 1 ? roles[0] : undefined);
    if (!active) throw roleRequired(roles);

    await db.update(staff).set({ lastLoginAt: new Date() }).where(eq(staff.id, user.id));

    // The facility id is a claim in the token, not a parameter the client can
    // send later: every request re-opens the schema named here, so a token from
    // one hospital can never be pointed at another.
    const token = app.jwt.sign(
      { sub: user.id, role: active, facility: facility.id },
      { expiresIn: '12h' }
    );
    await audit(request, {
      action: 'auth.login',
      entity: 'staff',
      entityId: user.id,
      data: { role: active }
    });

    return {
      token,
      user: sessionUser(user, active, roles, sessionFacility(facility))
    };
  });

  /** Change which granted role the current session acts as, without signing out. */
  app.post('/api/auth/switch-role', { preHandler: authenticate() }, async (request) => {
    const db = facilityDb(request);
    const { role } = z.object({ role: z.enum(ALL_ROLES) }).parse(request.body);
    const current = request.currentUser!;
    if (!current.roles.includes(role)) throw badRequest('That role is not assigned to your account.');

    const [user] = await db.select().from(staff).where(eq(staff.id, current.id)).limit(1);
    if (!user) throw notFound('Staff member');

    const token = app.jwt.sign(
      { sub: user.id, role, facility: current.facilityId },
      { expiresIn: '12h' }
    );
    await audit(request, {
      action: 'auth.role_switched',
      entity: 'staff',
      entityId: user.id,
      data: { from: current.role, to: role }
    });

    return {
      token,
      user: sessionUser(user, role, current.roles, sessionFacility(request.facility!))
    };
  });

  app.get('/api/auth/me', { preHandler: authenticate() }, async (request) => {
    const db = facilityDb(request);
    const current = request.currentUser!;
    const [user] = await db.select().from(staff).where(eq(staff.id, current.id)).limit(1);
    if (!user) throw notFound('Staff member');

    return {
      ...user,
      passwordHash: undefined,
      roles: current.roles,
      facility: sessionFacility(request.facility!)
    };
  });

  const changeSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10, 'Use at least 10 characters.')
  });

  app.post('/api/auth/change-password', { preHandler: authenticate() }, async (request, reply) => {
    const db = facilityDb(request);
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
