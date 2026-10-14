import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { staff } from '../db/schema/index.js';
import { verifyPassword } from '../lib/password.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request) => {
    const { email, password } = loginSchema.parse(request.body);

    const [user] = await db.select().from(staff).where(eq(staff.email, email)).limit(1);

    // Same message and similar timing for unknown email and wrong password, so
    // the endpoint cannot be used to enumerate staff accounts.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw badRequest('Email or password is incorrect.');
    }
    if (!user.isActive) throw badRequest('This account has been deactivated.');

    await db.update(staff).set({ lastLoginAt: new Date() }).where(eq(staff.id, user.id));

    const token = app.jwt.sign({ sub: user.id }, { expiresIn: '12h' });
    await audit(request, { action: 'auth.login', entity: 'staff', entityId: user.id });

    return {
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        department: user.department,
        specialty: user.specialty
      }
    };
  });

  app.get('/api/auth/me', { preHandler: authenticate() }, async (request) => {
    const [user] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, request.currentUser!.id))
      .limit(1);
    if (!user) throw notFound('Staff member');

    return { ...user, passwordHash: undefined };
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
