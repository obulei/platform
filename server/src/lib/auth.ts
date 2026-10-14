import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { staff } from '../db/schema/index.js';
import type { staffRole } from '../db/schema/enums.js';

export type Role = (typeof staffRole.enumValues)[number];

export interface CurrentUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Named `currentUser` rather than `user` because @fastify/jwt already
    // declares `user` with an incompatible type.
    currentUser?: CurrentUser;
  }
}

/**
 * Roles are assigned explicitly per route. Nothing is readable by default:
 * clinical free-text is limited to care roles, money to billing-side roles.
 */
export const ROLES = {
  admin: 'admin',
  reception: 'reception',
  doctor: 'doctor',
  nurse: 'nurse',
  pharmacist: 'pharmacist',
  labTech: 'lab_technician',
  billing: 'billing'
} as const satisfies Record<string, Role>;

export const CLINICAL_ROLES: Role[] = [ROLES.doctor, ROLES.nurse, ROLES.admin];
export const PATIENT_RECORD_READ: Role[] = [
  ROLES.admin,
  ROLES.reception,
  ROLES.doctor,
  ROLES.nurse,
  ROLES.pharmacist,
  ROLES.labTech,
  ROLES.billing
];
export const PATIENT_RECORD_WRITE: Role[] = [ROLES.admin, ROLES.reception];

export async function resolveUser(request: FastifyRequest): Promise<CurrentUser | null> {
  if (request.currentUser) return request.currentUser;

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  let payload: { sub: string };
  try {
    payload = await request.jwtVerify<{ sub: string }>();
  } catch {
    return null;
  }

  const [row] = await db
    .select({ id: staff.id, fullName: staff.fullName, email: staff.email, role: staff.role, isActive: staff.isActive })
    .from(staff)
    .where(eq(staff.id, payload.sub))
    .limit(1);

  // Re-read every request so a deactivated account stops working immediately
  // rather than at token expiry.
  if (!row || !row.isActive) return null;

  request.currentUser = { id: row.id, fullName: row.fullName, email: row.email, role: row.role };
  return request.currentUser;
}

export function authenticate(allow: Role[] | 'any' = 'any') {
  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    const user = await resolveUser(request);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Sign in required.' });
    }
    if (allow !== 'any' && !allow.includes(user.role)) {
      return reply
        .status(403)
        .send({ error: 'forbidden', message: `Your role (${user.role}) may not perform this action.` });
    }
    request.currentUser = user;
  };
}
