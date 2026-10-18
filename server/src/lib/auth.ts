import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { staff, staffRoles } from '../db/schema/index.js';
import { staffRole } from '../db/schema/enums.js';

export type Role = (typeof staffRole.enumValues)[number];

/** Every role the system knows, in enum order. Typed as the enum tuple so zod can use it. */
export const ALL_ROLES = staffRole.enumValues;

export interface CurrentUser {
  id: string;
  fullName: string;
  email: string;
  /** The role this session signed in as. Must be one of `roles`. */
  role: Role;
  /** Every role the account has been granted. */
  roles: Role[];
}

/** What a session token carries. `role` is the active role, chosen at sign-in. */
export interface TokenPayload {
  sub: string;
  role?: string;
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

/** Roles granted to one person, in `ALL_ROLES` order so menus stay stable. */
export async function grantedRoles(staffId: string): Promise<Role[]> {
  const rows = await db
    .select({ role: staffRoles.role })
    .from(staffRoles)
    .where(eq(staffRoles.staffId, staffId));
  return ALL_ROLES.filter((role) => rows.some((row) => row.role === role));
}

export async function resolveUser(request: FastifyRequest): Promise<CurrentUser | null> {
  if (request.currentUser) return request.currentUser;

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  let payload: TokenPayload;
  try {
    payload = await request.jwtVerify<TokenPayload>();
  } catch {
    return null;
  }

  const [row] = await db
    .select({ id: staff.id, fullName: staff.fullName, email: staff.email, isActive: staff.isActive })
    .from(staff)
    .where(eq(staff.id, payload.sub))
    .limit(1);

  const roles = row ? await grantedRoles(row.id) : [];

  // Staff row and grants are re-read on every request: a deactivated account
  // or a revoked role stops working immediately rather than at token expiry.
  // A token that names no role, or one no longer granted, is refused outright
  // instead of quietly picking a different role for the same person.
  const role = roles.find((candidate) => candidate === payload.role);
  if (!row || !row.isActive || !role) return null;

  request.currentUser = { id: row.id, fullName: row.fullName, email: row.email, role, roles };
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
