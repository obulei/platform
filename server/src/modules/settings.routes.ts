import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { publicDb } from '../db/client.js';
import { facilities } from '../db/schema/registry.js';
import { authenticate, ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { brandingEdit, sessionFacility } from '../lib/branding.js';

const ADMIN_ONLY = [ROLES.admin];

/**
 * A hospital's own identity, editable by its own administrators: the letter in the
 * brand square, the line under the name, the colour of the screens, and the two
 * sentences printed on a clinical report.
 *
 * These rows live in `public`, next to the hospital's name, while everything else
 * in this API writes inside the facility's own schema. That is the one exception,
 * and it is bounded by the token: the row updated here is the one named by the
 * session's facility claim (`current.facilityId`), never one taken from the body,
 * so an administrator styling their own clinic has no way to reach another's. The
 * change is then written to that hospital's own audit trail, like every other edit.
 *
 * The hospital's *name* is deliberately not editable here. It is what staff type to
 * reach their clinic when no address is known, and two hospitals sharing a name
 * makes that address ambiguous — so only the operator, who can see every registry
 * row at once, may change it.
 */
export async function settingsRoutes(app: FastifyInstance) {
  /**
   * Current wording, straight from the registry, so an operator's edit shows up
   * without signing out. `sessionFacility` carries the name and the address too;
   * the Settings screen shows both read-only.
   */
  app.get('/api/settings', { preHandler: authenticate(ADMIN_ONLY) }, async (request) => ({
    facility: sessionFacility(request.facility!)
  }));

  app.patch('/api/settings', { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const current = request.currentUser!;
    const patch = brandingEdit.parse(request.body);
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to change.');

    const [updated] = await publicDb
      .update(facilities)
      .set(patch)
      .where(eq(facilities.id, current.facilityId))
      .returning();
    if (!updated) throw notFound('Hospital');

    await audit(request, {
      action: 'settings.branding_updated',
      entity: 'facility',
      entityId: current.facilityId,
      data: { fields: Object.keys(patch) }
    });

    return sessionFacility(updated);
  });
}
