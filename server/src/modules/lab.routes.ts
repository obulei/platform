import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  admissions,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  patients,
  staff,
  wards
} from '../db/schema/index.js';
import { labOrderStatus, labPriority, labResultFlag, specimenType } from '../db/schema/enums.js';
import { authenticate, CLINICAL_ROLES, ROLES, type Role } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { money, moneyOrNull } from '../lib/serialize.js';

type OrderStatus = (typeof labOrderStatus.enumValues)[number];
type Priority = (typeof labPriority.enumValues)[number];
type Flag = (typeof labResultFlag.enumValues)[number];

// Kept as the inferred tuple (not widened to `readonly OrderStatus[]`) so it can
// feed `z.enum()`, which needs a non-empty tuple.
const ORDER_STATUSES = labOrderStatus.enumValues;
const BENCH_STATUSES: OrderStatus[] = ORDER_STATUSES.filter(
  (status) => status !== 'completed' && status !== 'cancelled'
);

/** Catalogue maintenance: the lab owns its tests, a doctor may add one clinically. */
const CATALOGUE_ROLES: Role[] = [ROLES.admin, ROLES.labTech, ROLES.doctor];
/** The bench queue is read by everyone who handles a specimen or a request. */
const WORKLIST_ROLES: Role[] = [ROLES.admin, ROLES.labTech, ROLES.doctor, ROLES.nurse];
/** Anyone who can order care can raise a lab request, plus reception. */
const ORDER_CREATE_ROLES: Role[] = [...CLINICAL_ROLES, ROLES.reception];
const STATUS_ROLES: Role[] = [ROLES.admin, ROLES.labTech, ROLES.nurse, ROLES.doctor];
/** Resulting and closing an order is a laboratory/clinician act — never nursing. */
const RESULT_ROLES: Role[] = [ROLES.admin, ROLES.labTech, ROLES.doctor];
const VERIFY_ROLES: Role[] = [ROLES.admin, ROLES.doctor];
/** Closing a request for good is a laboratory/clinician decision. */
const CANCEL_ROLES: Role[] = [ROLES.admin, ROLES.labTech, ROLES.doctor];

/**
 * Forward-only workflow. `cancelled` is reachable from any live stage but never
 * from `completed`, and no stage can be rewound through this endpoint.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['collected', 'cancelled'],
  collected: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

const upperCode = (value: string) => value.trim().toUpperCase();

const testCreateSchema = z.object({
  code: z.string().trim().min(2).max(20).transform(upperCode),
  name: z.string().trim().min(2).max(160),
  specimen: z.enum(specimenType.enumValues).default('blood'),
  unit: z.string().trim().max(24).nullish(),
  referenceLow: z.coerce.number().nullish(),
  referenceHigh: z.coerce.number().nullish(),
  referenceText: z.string().trim().max(80).nullish(),
  price: z.coerce.number().min(0).default(0)
});

const testPatchSchema = z.object({
  code: z.string().trim().min(2).max(20).transform(upperCode).optional(),
  name: z.string().trim().min(2).max(160).optional(),
  specimen: z.enum(specimenType.enumValues).optional(),
  unit: z.string().trim().max(24).nullish(),
  referenceLow: z.coerce.number().nullish(),
  referenceHigh: z.coerce.number().nullish(),
  referenceText: z.string().trim().max(80).nullish(),
  price: z.coerce.number().min(0).optional(),
  isActive: z.boolean().optional()
});

const orderCreateSchema = z.object({
  patientId: z.string().uuid(),
  testIds: z.array(z.string().uuid()).min(1).max(20),
  priority: z.enum(['routine', 'urgent']).default('routine'),
  notes: z.string().trim().max(1000).nullish(),
  admissionId: z.string().uuid().nullish()
});

const statusSchema = z.object({ status: z.enum(ORDER_STATUSES) });
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

const resultSchema = z
  .object({
    valueNumeric: z.coerce.number().nullish(),
    valueText: z.string().trim().max(300).nullish(),
    unit: z.string().trim().max(24).nullish(),
    comment: z.string().trim().max(500).nullish(),
    flag: z.enum(labResultFlag.enumValues).optional()
  })
  .refine(
    (value) =>
      (value.valueNumeric !== null && value.valueNumeric !== undefined) ||
      (typeof value.valueText === 'string' && value.valueText.length > 0),
    { message: 'Enter a numeric value or a text value for this test.' }
  );

const idParam = z.object({ id: z.string().uuid() });
const itemIdParam = z.object({ itemId: z.string().uuid() });

/** numeric() columns arrive as strings from postgres.js and go back out as strings. */
function numericForDb(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : String(value);
}

const testDto = (row: typeof labTests.$inferSelect) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  specimen: row.specimen,
  unit: row.unit,
  referenceLow: moneyOrNull(row.referenceLow),
  referenceHigh: moneyOrNull(row.referenceHigh),
  referenceText: row.referenceText,
  price: money(row.price),
  isActive: row.isActive,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

/**
 * Flag rules, in the order they are applied:
 *  - a numeric value against the test's reference bounds (inclusive on both
 *    sides, and each bound checked independently when only one is defined);
 *  - anything without a numeric value, or without bounds, defaults to 'normal';
 *  - an explicit client flag always wins, and is reported as `manual`.
 */
function computeFlag(
  valueNumeric: number | null,
  referenceLow: number | null,
  referenceHigh: number | null
): Flag {
  if (valueNumeric === null) return 'normal';
  if (referenceLow === null && referenceHigh === null) return 'normal';
  if (referenceLow !== null && valueNumeric < referenceLow) return 'abnormal';
  if (referenceHigh !== null && valueNumeric > referenceHigh) return 'abnormal';
  return 'normal';
}

const orderSelect = () =>
  db
    .select({
      order: labOrders,
      patientName: sql<string>`(${patients.givenName} || ' ' || ${patients.familyName})`,
      patientMrn: patients.mrn,
      orderingStaffName: staff.fullName,
      wardName: wards.name,
      // Correlated subqueries rather than a join + GROUP BY: paging stays exact
      // and an order with no items still appears in the list.
      testCount: sql<number>`(select count(*)::int from lab_order_items loi where loi.lab_order_id = ${labOrders.id})`,
      testNames: sql<string | null>`(select string_agg(t.name, ', ' order by t.name) from lab_order_items loi2 join lab_tests t on t.id = loi2.lab_test_id where loi2.lab_order_id = ${labOrders.id})`
    })
    .from(labOrders)
    .innerJoin(patients, eq(labOrders.patientId, patients.id))
    .innerJoin(staff, eq(labOrders.orderingStaffId, staff.id))
    .leftJoin(admissions, eq(labOrders.admissionId, admissions.id))
    .leftJoin(wards, eq(admissions.wardId, wards.id));

function mapOrder(row: {
  order: typeof labOrders.$inferSelect;
  patientName: string;
  patientMrn: string;
  orderingStaffName: string;
  wardName: string | null;
  testCount: number;
  testNames: string | null;
}) {
  return {
    id: row.order.id,
    patientId: row.order.patientId,
    patientName: row.patientName,
    patientMrn: row.patientMrn,
    admissionId: row.order.admissionId,
    wardName: row.wardName,
    orderingStaffId: row.order.orderingStaffId,
    orderingStaffName: row.orderingStaffName,
    status: row.order.status,
    priority: row.order.priority,
    notes: row.order.notes,
    orderedAt: row.order.orderedAt,
    collectedAt: row.order.collectedAt,
    completedAt: row.order.completedAt,
    testCount: Number(row.testCount),
    testNames: row.testNames ?? ''
  };
}

const itemSelect = () =>
  db
    .select({
      id: labOrderItems.id,
      labOrderId: labOrderItems.labOrderId,
      testId: labTests.id,
      testCode: labTests.code,
      testName: labTests.name,
      specimen: labTests.specimen,
      testUnit: labTests.unit,
      referenceLow: labTests.referenceLow,
      referenceHigh: labTests.referenceHigh,
      referenceText: labTests.referenceText,
      price: labTests.price,
      resultId: labResults.id,
      valueNumeric: labResults.valueNumeric,
      valueText: labResults.valueText,
      resultUnit: labResults.unit,
      flag: labResults.flag,
      comment: labResults.comment,
      resultedAt: labResults.resultedAt,
      resultedByName: sql<string | null>`(select s.full_name from staff s where s.id = ${labResults.resultedBy})`,
      verifiedByName: sql<string | null>`(select s2.full_name from staff s2 where s2.id = ${labResults.verifiedBy})`
    })
    .from(labOrderItems)
    .innerJoin(labTests, eq(labOrderItems.labTestId, labTests.id))
    .leftJoin(labResults, eq(labResults.labOrderItemId, labOrderItems.id));

function itemDto(row: {
  id: string;
  labOrderId: string;
  testId: string;
  testCode: string;
  testName: string;
  specimen: (typeof specimenType.enumValues)[number];
  testUnit: string | null;
  referenceLow: string | null;
  referenceHigh: string | null;
  referenceText: string | null;
  price: string;
  resultId: string | null;
  valueNumeric: string | null;
  valueText: string | null;
  resultUnit: string | null;
  flag: Flag | null;
  comment: string | null;
  resultedAt: Date | null;
  resultedByName: string | null;
  verifiedByName: string | null;
}) {
  return {
    id: row.id,
    labOrderId: row.labOrderId,
    test: {
      id: row.testId,
      code: row.testCode,
      name: row.testName,
      specimen: row.specimen,
      unit: row.testUnit,
      referenceLow: moneyOrNull(row.referenceLow),
      referenceHigh: moneyOrNull(row.referenceHigh),
      referenceText: row.referenceText,
      price: money(row.price)
    },
    result: row.resultId
      ? {
          id: row.resultId,
          valueNumeric: moneyOrNull(row.valueNumeric),
          valueText: row.valueText,
          unit: row.resultUnit,
          flag: row.flag,
          comment: row.comment,
          resultedAt: row.resultedAt,
          resultedByName: row.resultedByName,
          verifiedByName: row.verifiedByName
        }
      : null
  };
}

async function loadOrderDetail(id: string) {
  const [row] = await orderSelect().where(eq(labOrders.id, id)).limit(1);
  if (!row) throw notFound('Lab order');

  const itemRows = await itemSelect()
    .where(eq(labOrderItems.labOrderId, id))
    .orderBy(asc(labTests.name));

  return { ...mapOrder(row), items: itemRows.map(itemDto) };
}

/** Total resultable items versus items carrying a result — used to gate completion. */
async function resultCoverage(labOrderId: string) {
  const [items] = await db
    .select({ total: count() })
    .from(labOrderItems)
    .where(eq(labOrderItems.labOrderId, labOrderId));
  const [resulted] = await db
    .select({ total: count() })
    .from(labOrderItems)
    .innerJoin(labResults, eq(labResults.labOrderItemId, labOrderItems.id))
    .where(eq(labOrderItems.labOrderId, labOrderId));
  return { items: Number(items.total), resulted: Number(resulted.total) };
}

export async function labRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate());

  /* ---------------------------------------------------------------- *
   * Catalogue
   * ---------------------------------------------------------------- */

  app.get('/api/lab/tests', async (request) => {
    const query = z
      .object({ active: z.enum(['true', 'false', 'all']).default('true') })
      .parse(request.query);

    const rows = await db
      .select()
      .from(labTests)
      .where(query.active === 'all' ? undefined : eq(labTests.isActive, query.active === 'true'))
      .orderBy(asc(labTests.name));

    return rows.map(testDto);
  });

  app.post('/api/lab/tests', { preHandler: authenticate(CATALOGUE_ROLES) }, async (request) => {
    const body = testCreateSchema.parse(request.body);

    const [duplicate] = await db
      .select({ id: labTests.id })
      .from(labTests)
      .where(eq(labTests.code, body.code))
      .limit(1);
    if (duplicate) throw badRequest(`Test code ${body.code} already exists.`);

    const [row] = await db
      .insert(labTests)
      .values({
        code: body.code,
        name: body.name,
        specimen: body.specimen,
        unit: body.unit ?? null,
        referenceLow: numericForDb(body.referenceLow) ?? null,
        referenceHigh: numericForDb(body.referenceHigh) ?? null,
        referenceText: body.referenceText ?? null,
        price: String(body.price)
      })
      .returning();

    await audit(request, {
      action: 'lab.test.created',
      entity: 'lab_test',
      entityId: row.id,
      data: { code: row.code, name: row.name, specimen: row.specimen }
    });
    return testDto(row);
  });

  app.patch('/api/lab/tests/:id', { preHandler: authenticate(CATALOGUE_ROLES) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = testPatchSchema.parse(request.body);

    const [existing] = await db.select().from(labTests).where(eq(labTests.id, id)).limit(1);
    if (!existing) throw notFound('Lab test');

    if (body.code && body.code !== existing.code) {
      const [duplicate] = await db
        .select({ id: labTests.id })
        .from(labTests)
        .where(and(eq(labTests.code, body.code), sql`${labTests.id}::text <> ${id}`))
        .limit(1);
      if (duplicate) throw badRequest(`Test code ${body.code} already exists.`);
    }

    const [row] = await db
      .update(labTests)
      .set({
        ...(body.code === undefined ? {} : { code: body.code }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.specimen === undefined ? {} : { specimen: body.specimen }),
        ...(body.unit === undefined ? {} : { unit: body.unit ?? null }),
        ...(body.referenceLow === undefined ? {} : { referenceLow: numericForDb(body.referenceLow)! }),
        ...(body.referenceHigh === undefined ? {} : { referenceHigh: numericForDb(body.referenceHigh)! }),
        ...(body.referenceText === undefined ? {} : { referenceText: body.referenceText ?? null }),
        ...(body.price === undefined ? {} : { price: String(body.price) }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        updatedAt: new Date()
      })
      .where(eq(labTests.id, id))
      .returning();

    await audit(request, {
      action: 'lab.test.updated',
      entity: 'lab_test',
      entityId: id,
      data: { code: row.code, fields: Object.keys(body) }
    });
    return testDto(row);
  });

  /* ---------------------------------------------------------------- *
   * Orders
   * ---------------------------------------------------------------- */

  app.get('/api/lab/orders', async (request) => {
    const query = z
      .object({
        status: z.enum(ORDER_STATUSES).optional(),
        priority: z.enum(labPriority.enumValues).optional(),
        patientId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const filters = [];
    if (query.status) filters.push(eq(labOrders.status, query.status));
    if (query.priority) filters.push(eq(labOrders.priority, query.priority));
    if (query.patientId) filters.push(eq(labOrders.patientId, query.patientId));
    const where = filters.length ? and(...filters) : undefined;

    const rows = await orderSelect()
      .where(where)
      .orderBy(desc(labOrders.orderedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.select({ total: count() }).from(labOrders).where(where);

    return { items: rows.map(mapOrder), total: Number(total) };
  });

  /**
   * The bench queue. Declared before `/api/lab/orders/:id` — Fastify matches
   * the static segment first, but keeping the order literal documents intent.
   */
  app.get('/api/lab/orders/worklist', { preHandler: authenticate(WORKLIST_ROLES) }, async (request) => {
    const query = z
      .object({
        status: z.string().max(200).optional(),
        priority: z.enum(labPriority.enumValues).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200)
      })
      .parse(request.query);

    let statuses: OrderStatus[] = BENCH_STATUSES;
    if (query.status) {
      const requested = query.status
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const unknown = requested.filter(
        (value) => !ORDER_STATUSES.includes(value as OrderStatus)
      );
      if (unknown.length) {
        throw badRequest(
          `Unknown lab order status: ${unknown.join(', ')}. Valid values: ${ORDER_STATUSES.join(', ')}.`
        );
      }
      if (requested.length) statuses = requested as OrderStatus[];
    }

    const rows = await orderSelect()
      .where(
        and(
          inArray(labOrders.status, statuses),
          query.priority ? eq(labOrders.priority, query.priority) : undefined
        )
      )
      .orderBy(
        // Urgent requests jump the queue; within a priority the oldest request wins.
        sql`case when ${labOrders.priority} = 'urgent' then 0 else 1 end asc`,
        asc(labOrders.orderedAt)
      )
      .limit(query.limit);

    return rows.map(mapOrder);
  });

  app.get('/api/lab/orders/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return loadOrderDetail(id);
  });

  app.post('/api/lab/orders', { preHandler: authenticate(ORDER_CREATE_ROLES) }, async (request) => {
    const body = orderCreateSchema.parse(request.body);
    const testIds = [...new Set(body.testIds)];

    const [patient] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, body.patientId))
      .limit(1);
    if (!patient) throw badRequest('Select a valid patient.');

    if (body.admissionId) {
      const [admission] = await db
        .select({ id: admissions.id, patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, body.admissionId))
        .limit(1);
      if (!admission || admission.patientId !== body.patientId) {
        throw badRequest('That admission does not belong to this patient.');
      }
    }

    const found = await db
      .select({ id: labTests.id, code: labTests.code, name: labTests.name, isActive: labTests.isActive })
      .from(labTests)
      .where(inArray(labTests.id, testIds));

    const foundIds = new Set(found.map((test) => test.id));
    const unusable = [
      ...found.filter((test) => !test.isActive).map((test) => test.code),
      ...testIds.filter((id) => !foundIds.has(id))
    ];
    if (unusable.length) {
      throw badRequest(`These tests are not available: ${unusable.join(', ')}.`);
    }

    const created = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(labOrders)
        .values({
          patientId: body.patientId,
          admissionId: body.admissionId ?? null,
          orderingStaffId: request.currentUser!.id,
          status: 'pending',
          priority: body.priority as Priority,
          notes: body.notes ?? null
        })
        .returning();

      const items = await tx
        .insert(labOrderItems)
        .values(testIds.map((labTestId) => ({ labOrderId: order.id, labTestId })))
        .returning();

      return { order, items };
    });

    await audit(request, {
      action: 'lab.order.created',
      entity: 'lab_order',
      entityId: created.order.id,
      data: {
        patientId: created.order.patientId,
        priority: created.order.priority,
        tests: created.items.length
      }
    });
    return loadOrderDetail(created.order.id);
  });

  app.patch(
    '/api/lab/orders/:id/status',
    { preHandler: authenticate(STATUS_ROLES) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = statusSchema.parse(request.body);

      const [existing] = await db.select().from(labOrders).where(eq(labOrders.id, id)).limit(1);
      if (!existing) throw notFound('Lab order');

      if (!TRANSITIONS[existing.status].includes(body.status)) {
        throw badRequest(
          `A ${existing.status} lab order cannot move to ${body.status}. Allowed next: ${
            TRANSITIONS[existing.status].length ? TRANSITIONS[existing.status].join(', ') : 'none'
          }.`
        );
      }

      if (body.status === 'completed') {
        if (!RESULT_ROLES.includes(request.currentUser!.role)) {
          throw badRequest('Only laboratory staff or a clinician may complete a lab order.');
        }
        const { items, resulted } = await resultCoverage(id);
        if (items === 0) throw badRequest('This lab order has no tests to result.');
        if (resulted < items) {
          throw badRequest('Enter a result for every test before completing the order.');
        }
      }

      const updates: Partial<typeof labOrders.$inferInsert> = {
        status: body.status,
        updatedAt: new Date()
      };
      if (body.status === 'collected') updates.collectedAt = new Date();
      if (body.status === 'completed') updates.completedAt = new Date();

      const [row] = await db
        .update(labOrders)
        .set(updates)
        .where(eq(labOrders.id, id))
        .returning();

      await audit(request, {
        action: `lab.order.${body.status}`,
        entity: 'lab_order',
        entityId: id,
        data: { from: existing.status, to: body.status }
      });
      return row;
    }
  );

  app.post(
    '/api/lab/orders/:id/cancel',
    { preHandler: authenticate(CANCEL_ROLES) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = cancelSchema.parse(request.body);

      const [existing] = await db.select().from(labOrders).where(eq(labOrders.id, id)).limit(1);
      if (!existing) throw notFound('Lab order');
      if (existing.status === 'completed') {
        throw badRequest('A completed lab order cannot be cancelled.');
      }
      if (existing.status === 'cancelled') throw badRequest('This lab order is already cancelled.');

      const [row] = await db
        .update(labOrders)
        .set({ status: 'cancelled' as OrderStatus, updatedAt: new Date() })
        .where(eq(labOrders.id, id))
        .returning();

      // lab_orders has no reason column; the reason lives in the audit trail,
      // which is the authority for who cancelled what and why.
      await audit(request, {
        action: 'lab.order.cancelled',
        entity: 'lab_order',
        entityId: id,
        data: { from: existing.status, reason: body.reason }
      });
      return row;
    }
  );

  /* ---------------------------------------------------------------- *
   * Results
   * ---------------------------------------------------------------- */

  app.post(
    '/api/lab/items/:itemId/result',
    { preHandler: authenticate(RESULT_ROLES) },
    async (request) => {
      const { itemId } = itemIdParam.parse(request.params);
      const body = resultSchema.parse(request.body);

      const [item] = await db
        .select({
          id: labOrderItems.id,
          labOrderId: labOrderItems.labOrderId,
          test: labTests
        })
        .from(labOrderItems)
        .innerJoin(labTests, eq(labOrderItems.labTestId, labTests.id))
        .where(eq(labOrderItems.id, itemId))
        .limit(1);
      if (!item) throw notFound('Lab order item');

      const [order] = await db
        .select({ id: labOrders.id, status: labOrders.status })
        .from(labOrders)
        .where(eq(labOrders.id, item.labOrderId))
        .limit(1);
      if (!order) throw notFound('Lab order');
      if (order.status === 'cancelled') {
        throw badRequest('This lab order is cancelled, so its results cannot be entered.');
      }

      const referenceLow = moneyOrNull(item.test.referenceLow);
      const referenceHigh = moneyOrNull(item.test.referenceHigh);
      const valueNumeric =
        body.valueNumeric === null || body.valueNumeric === undefined ? null : body.valueNumeric;

      const computedFlag = computeFlag(valueNumeric, referenceLow, referenceHigh);
      const flag: Flag = body.flag ?? computedFlag;
      const flagSource: 'computed' | 'manual' = body.flag ? 'manual' : 'computed';

      const existingResult = await db
        .select({ id: labResults.id, verifiedBy: labResults.verifiedBy })
        .from(labResults)
        .where(eq(labResults.labOrderItemId, itemId))
        .limit(1);
      const isCorrection = existingResult.length > 0;

      const payload = {
        valueNumeric: numericForDb(valueNumeric)!,
        valueText: body.valueText ?? null,
        unit: body.unit ?? null,
        flag,
        comment: body.comment ?? null,
        resultedBy: request.currentUser!.id,
        resultedAt: new Date()
      };

      const [row] = await db
        .insert(labResults)
        .values({ labOrderItemId: itemId, ...payload })
        .onConflictDoUpdate({
          target: labResults.labOrderItemId,
          // A corrected result overwrites the previous one — that is the intent.
          // Verification is dropped with it, so an amended value is never left
          // carrying a sign-off given to the older figure.
          set: { ...payload, verifiedBy: null }
        })
        .returning();

      const coverage = await resultCoverage(item.labOrderId);
      const allItemsResulted = coverage.items > 0 && coverage.resulted >= coverage.items;

      await audit(request, {
        action: isCorrection ? 'lab.result.corrected' : 'lab.result.recorded',
        entity: 'lab_result',
        entityId: row.id,
        data: {
          labOrderId: item.labOrderId,
          labOrderItemId: itemId,
          testCode: item.test.code,
          valueNumeric: row.valueNumeric,
          valueText: row.valueText,
          unit: row.unit,
          referenceLow,
          referenceHigh,
          flag: row.flag,
          flagSource,
          previousVerified: Boolean(existingResult[0]?.verifiedBy)
        }
      });

      return {
        id: row.id,
        labOrderId: item.labOrderId,
        labOrderItemId: itemId,
        testCode: item.test.code,
        testName: item.test.name,
        valueNumeric: moneyOrNull(row.valueNumeric),
        valueText: row.valueText,
        unit: row.unit,
        flag: row.flag,
        flagSource,
        computedFlag,
        comment: row.comment,
        resultedBy: row.resultedBy,
        resultedAt: row.resultedAt,
        verifiedBy: row.verifiedBy,
        isCorrection,
        allItemsResulted
      };
    }
  );

  app.post('/api/lab/results/:id/verify', { preHandler: authenticate(VERIFY_ROLES) }, async (request) => {
    const { id } = idParam.parse(request.params);

    const [row] = await db
      .update(labResults)
      .set({ verifiedBy: request.currentUser!.id })
      .where(eq(labResults.id, id))
      .returning();
    if (!row) throw notFound('Lab result');

    await audit(request, {
      action: 'lab.result.verified',
      entity: 'lab_result',
      entityId: id,
      data: { flag: row.flag, valueNumeric: row.valueNumeric, valueText: row.valueText }
    });

    return {
      id: row.id,
      labOrderItemId: row.labOrderItemId,
      valueNumeric: moneyOrNull(row.valueNumeric),
      valueText: row.valueText,
      unit: row.unit,
      flag: row.flag,
      comment: row.comment,
      resultedBy: row.resultedBy,
      verifiedBy: row.verifiedBy,
      resultedAt: row.resultedAt
    };
  });
}
