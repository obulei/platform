import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { auditLog, staff } from '../db/schema/index.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

/**
 * The whole module is administrator-only: the audit trail is the compliance
 * record, so reading it is guarded at the module level rather than per route
 * (see the addHook inside auditRoutes).
 */

/** Entities that can appear in the per-record trail; anything else is rejected. */
const ALLOWED_ENTITIES = [
  'patient',
  'staff',
  'appointment',
  'admission',
  'note',
  'clinical_report',
  'prescription',
  'medicine',
  'lab_order',
  'lab_result',
  'invoice',
  'payment'
] as const;
type AllowedEntity = (typeof ALLOWED_ENTITIES)[number];

const EXPORT_CAP = 50_000;
const MAX_WINDOW_MS = 92 * 24 * 60 * 60_000;

/**
 * Wrap every field in double quotes and double any embedded quote, so a comma,
 * newline or quote inside the JSON `data` column can neither shift columns nor
 * let a crafted value forge a row.
 */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

const listSchema = z.object({
  q: z.string().max(200).optional(),
  entity: z.string().max(60).optional(),
  staffId: z.string().uuid().optional(),
  action: z.string().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const trailSelect = () => ({
  id: auditLog.id,
  action: auditLog.action,
  entity: auditLog.entity,
  entityId: auditLog.entityId,
  method: auditLog.method,
  path: auditLog.path,
  data: auditLog.data,
  staffId: auditLog.staffId,
  staffName: staff.fullName,
  staffEmail: staff.email,
  createdAt: auditLog.createdAt
});

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate([ROLES.admin]));

  app.get('/api/audit', async (request) => {
    const query = listSchema.parse(request.query);

    const filters = [];
    if (query.entity) filters.push(eq(auditLog.entity, query.entity));
    if (query.staffId) filters.push(eq(auditLog.staffId, query.staffId));
    // action is matched with ilike so a pattern such as 'appointment.%' works.
    if (query.action) filters.push(ilike(auditLog.action, query.action));
    if (query.from) filters.push(gte(auditLog.createdAt, query.from));
    if (query.to) filters.push(lte(auditLog.createdAt, query.to));
    if (query.q) {
      const term = `%${query.q}%`;
      filters.push(
        or(
          ilike(auditLog.action, term),
          ilike(auditLog.entity, term),
          ilike(auditLog.path, term)
        )!
      );
    }
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select(trailSelect())
      .from(auditLog)
      .leftJoin(staff, eq(auditLog.staffId, staff.id))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.select({ total: count() }).from(auditLog).where(where);

    // Reading the trail is itself logged — but only filters, never the payload.
    await audit(request, {
      action: 'audit.viewed',
      entity: 'audit_log',
      data: {
        filters: {
          q: query.q ?? null,
          entity: query.entity ?? null,
          staffId: query.staffId ?? null,
          action: query.action ?? null,
          from: query.from?.toISOString() ?? null,
          to: query.to?.toISOString() ?? null
        }
      }
    });

    return {
      items: rows,
      total: Number(total),
      offset: query.offset,
      limit: query.limit
    };
  });

  /** The trail for one record, newest first. Not audited, to avoid recursion noise. */
  app.get('/api/audit/entities/:entity/:entityId', async (request) => {
    const { entity, entityId } = z
      .object({ entity: z.string().max(60), entityId: z.string().uuid() })
      .parse(request.params);

    if (!(ALLOWED_ENTITIES as readonly string[]).includes(entity)) {
      throw badRequest('Unknown audit entity.');
    }

    const rows = await db
      .select(trailSelect())
      .from(auditLog)
      .leftJoin(staff, eq(auditLog.staffId, staff.id))
      .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(500);

    return { entity, entityId, items: rows };
  });

  app.get('/api/audit/export', async (request, reply) => {
    const query = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        format: z.enum(['csv']).default('csv')
      })
      .parse(request.query);

    if (Number.isNaN(query.from.getTime()) || Number.isNaN(query.to.getTime())) {
      throw badRequest('from and to must be valid ISO timestamps.');
    }
    if (query.to.getTime() <= query.from.getTime()) {
      throw badRequest('The export window end must be after its start.');
    }
    // Never dump the whole table casually: require a bounded window.
    if (query.to.getTime() - query.from.getTime() > MAX_WINDOW_MS) {
      throw badRequest('The export window may not exceed 92 days.');
    }

    const where = and(gte(auditLog.createdAt, query.from), lte(auditLog.createdAt, query.to));

    // Fetch one extra row to detect the cap without a separate count scan.
    const rows = await db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        staffEmail: staff.email,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        method: auditLog.method,
        path: auditLog.path,
        data: auditLog.data
      })
      .from(auditLog)
      .leftJoin(staff, eq(auditLog.staffId, staff.id))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(EXPORT_CAP + 1);

    const truncated = rows.length > EXPORT_CAP;
    const exportRows = truncated ? rows.slice(0, EXPORT_CAP) : rows;

    const header = ['id', 'created_at', 'staff_email', 'action', 'entity', 'entity_id', 'method', 'path', 'data'];
    const lines: string[] = [header.map(csvEscape).join(',')];
    for (const row of exportRows) {
      lines.push(
        [
          row.id,
          row.createdAt.toISOString(),
          row.staffEmail,
          row.action,
          row.entity,
          row.entityId,
          row.method,
          row.path,
          row.data === null || row.data === undefined ? '' : JSON.stringify(row.data)
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    const csv = `${lines.join('\r\n')}\r\n`;

    await audit(request, {
      action: 'audit.viewed',
      entity: 'audit_log',
      data: {
        filters: { from: query.from.toISOString(), to: query.to.toISOString(), format: query.format },
        export: true,
        rows: exportRows.length,
        truncated
      }
    });

    const fromDay = query.from.toISOString().slice(0, 10);
    const toDay = query.to.toISOString().slice(0, 10);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-${fromDay}-to-${toDay}.csv"`);
    if (truncated) reply.header('X-Truncated', 'true');
    return reply.send(csv);
  });
}

export type { AllowedEntity };
