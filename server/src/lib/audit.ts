import type { FastifyRequest } from 'fastify';
import { auditLog } from '../db/schema/index.js';
import { facilityDb } from './auth.js';

/**
 * Append-only record of who changed what, written into the caller's own
 * facility schema so each hospital keeps its own trail. Called from each
 * mutation after the write succeeds, so the trail reflects committed effects
 * rather than attempts. A failed audit write must not roll back a clinical
 * action, hence the catch.
 */
export async function audit(
  request: FastifyRequest,
  entry: {
    action: string;
    entity: string;
    entityId?: string | null;
    data?: Record<string, unknown> | null;
  }
): Promise<void> {
  try {
    await facilityDb(request)
      .insert(auditLog)
      .values({
      staffId: request.currentUser?.id ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      method: request.method,
      path: request.url.split('?')[0],
      data: entry.data ?? null
    });
  } catch (error) {
    request.log.error({ err: error }, 'audit write failed');
  }
}
