import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Role } from './auth.js';

interface PgError {
  code?: string;
  // postgres.js exposes the failing constraint as `constraint_name`; node-pg
  // uses `constraint`. Accept either so the clinic-language message survives a
  // driver change.
  constraint?: string;
  constraint_name?: string;
  detail?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Extra top-level fields the client needs — e.g. the roles to choose from. */
    readonly extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
/** A signed-in person who is allowed to know the route exists but not to act. */
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
/**
 * Sign-in succeeded, but the account holds more than one role and the request
 * did not say which one to activate. The client draws the choice from `roles`.
 */
export const roleRequired = (roles: readonly Role[]) =>
  new HttpError(
    400,
    'role_required',
    'Choose the role you are signing in as.',
    undefined,
    { roles }
  );

const CONSTRAINT_MESSAGES: Record<string, string> = {
  appointments_no_staff_overlap:
    'That clinician is already booked for part of this time. Choose another slot.',
  appointments_no_patient_overlap:
    'This patient already has an appointment overlapping the requested time.',
  admissions_one_open_per_bed: 'That bed is currently occupied by an active admission.',
  admissions_one_open_per_patient:
    'This patient is already admitted. Discharge them before a new admission.',
  staff_email_key: 'Another staff account already uses this email address.',
  beds_ward_label_key: 'That bed label is already used in this ward.',
  lab_tests_code_key: 'A lab test already uses this code.',
  lab_order_items_order_test_key: 'This test is already on the order.'
};

/**
 * Turns Postgres constraint failures into clinic-language messages. The
 * database is the authority on scheduling and bed conflicts, so route handlers
 * rely on these rather than pre-checking (which would race).
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message
    }));
    return new HttpError(
      400,
      'validation_failed',
      issues.map((i) => `${i.field}: ${i.message}`).join(' '),
      issues
    );
  }

  // Drizzle wraps the driver error in DrizzleQueryError; the SQLSTATE we need
  // to classify lives on the cause, not the wrapper.
  const pg = (error as { cause?: PgError } & PgError)?.cause ?? (error as PgError);
  if (!pg?.code) {
    return new HttpError(500, 'internal_error', 'Unexpected server error.');
  }

  const named = pg.constraint ?? pg.constraint_name;

  switch (pg.code) {
    case '23P01': // exclusion constraint → overlapping booking
    case '23505': // unique violation → partial unique index (bed/patient/duplicate)
      return conflict(
        (named && CONSTRAINT_MESSAGES[named]) || 'That record conflicts with an existing one.'
      );
    case '23503':
      return badRequest('A linked record does not exist or is still in use elsewhere.');
    case '23514':
      return badRequest(
        (named && CONSTRAINT_MESSAGES[named]) || 'The values submitted fail a data rule.'
      );
    case '22P02':
      return badRequest('An identifier is not valid.');
    default:
      return new HttpError(500, 'internal_error', 'Unexpected server error.');
  }
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const httpError = toHttpError(error);
    if (httpError.status >= 500) request.log.error({ err: error }, 'request failed');
    return reply
      .status(httpError.status)
      .send({
        error: httpError.code,
        message: httpError.message,
        ...(httpError.details ? { details: httpError.details } : {}),
        ...httpError.extra
      });
  });
}
