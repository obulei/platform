import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { findFacilityById, tenantDb, type TenantDb } from '../db/tenant.js';
import { findPlatformAdminById } from '../db/provision.js';
import { staff, staffRoles } from '../db/schema/index.js';
import { staffRole } from '../db/schema/enums.js';
import type { Facility } from '../db/schema/registry.js';

export type Role = (typeof staffRole.enumValues)[number];

/** Every role the system knows, in enum order. Typed as the enum tuple so zod can use it. */
export const ALL_ROLES = staffRole.enumValues;

/** Drizzle handle bound to one facility's schema. */
export type { TenantDb };

export interface CurrentUser {
  id: string;
  fullName: string;
  email: string;
  /** The role this session signed in as. Must be one of `roles`. */
  role: Role;
  /** Every role the account has been granted. */
  roles: Role[];
  /** Which hospital this session belongs to. Fixed when the token is signed. */
  facilityId: string;
  facilitySlug: string;
  facilityName: string;
}

/** What a session token carries. `role` is the active role, chosen at sign-in. */
export interface TokenPayload {
  sub: string;
  role?: string;
  facility?: string;
  /** Set only on a platform token, which names no facility and holds no clinical role. */
  scope?: 'platform';
}

/** The platform administrator behind a `/api/platform` session. Not clinic staff. */
export interface PlatformAdminSession {
  id: string;
  fullName: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Named `currentUser` rather than `user` because @fastify/jwt already
    // declares `user` with an incompatible type.
    currentUser?: CurrentUser;
    /** Registry row this request was resolved to. */
    facility?: Facility;
    /**
     * Clinical data handle for that facility. Absent until a request is bound to
     * a hospital, which is why routes read it through `facilityDb(request)`.
     */
    db?: TenantDb;
    /** Set only by `authenticatePlatform()`. A hospital session never has it. */
    platformAdmin?: PlatformAdminSession;
  }
}

/**
 * The only supported way for a route to reach clinical data. A route that calls
 * this before `authenticate()` has bound a facility is a coding mistake, so it
 * surfaces as a server error rather than an empty result set.
 */
export function facilityDb(request: FastifyRequest): TenantDb {
  if (!request.db) {
    throw new Error(`No facility bound for ${request.method} ${request.url}.`);
  }
  return request.db;
}

/** Binds a request to one hospital and returns its handle. */
export function bindFacility(request: FastifyRequest, facility: Facility): TenantDb {
  const handle = tenantDb(facility);
  request.facility = facility;
  request.db = handle.db;
  return handle.db;
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
export async function grantedRoles(db: TenantDb, staffId: string): Promise<Role[]> {
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

  // A token without a facility claim — signed before tenancy, or by hand — has no
  // schema it is allowed to open. Refusing it is what stops an old token from
  // being replayed against whichever hospital the deployment happens to default to.
  if (!payload.facility) return null;

  const facility = await findFacilityById(payload.facility);
  if (!facility) return null;
  const db = bindFacility(request, facility);

  const [row] = await db
    .select({ id: staff.id, fullName: staff.fullName, email: staff.email, isActive: staff.isActive })
    .from(staff)
    .where(eq(staff.id, payload.sub))
    .limit(1);

  const roles = row ? await grantedRoles(db, row.id) : [];

  // Staff row and grants are re-read on every request, inside the facility the
  // token names: a deactivated account or a revoked role stops working
  // immediately rather than at token expiry. A token that names no role, or one
  // no longer granted, is refused outright instead of quietly picking a different
  // role for the same person.
  const role = roles.find((candidate) => candidate === payload.role);
  if (!row || !row.isActive || !role) return null;

  request.currentUser = {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    role,
    roles,
    facilityId: facility.id,
    facilitySlug: facility.slug,
    facilityName: facility.name
  };
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

/**
 * The second, separate identity in this system. A platform token says
 * `scope: platform` and names no facility; a staff token names a facility and
 * carries no scope. Each guard accepts only its own kind, so the account that
 * can create hospitals can never open a patient record, and a clinic
 * administrator can never reach the platform routes — there is no token a
 * clinic holds that this would accept.
 */
export async function resolvePlatformAdmin(request: FastifyRequest): Promise<PlatformAdminSession | null> {
  if (request.platformAdmin) return request.platformAdmin;

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  let payload: TokenPayload;
  try {
    payload = await request.jwtVerify<TokenPayload>();
  } catch {
    return null;
  }
  if (payload.scope !== 'platform' || payload.facility) return null;

  const admin = await findPlatformAdminById(payload.sub);
  if (!admin) return null;

  request.platformAdmin = { id: admin.id, fullName: admin.fullName, email: admin.email };
  return request.platformAdmin;
}

export function authenticatePlatform() {
  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    const admin = await resolvePlatformAdmin(request);
    if (!admin) {
      return reply
        .status(401)
        .send({ error: 'unauthorized', message: 'Platform administrator sign-in required.' });
    }
    request.platformAdmin = admin;
  };
}
