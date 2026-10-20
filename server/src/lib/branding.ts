import { z } from 'zod';
import type { Facility } from '../db/schema/registry.js';

/**
 * The branding one hospital owns, in one place, because two very different
 * screens edit the same five registry columns: the operator's console and each
 * hospital's own Settings screen. Both must reject the same things — the accent
 * in particular becomes a CSS custom property in the browser, so anything that
 * is not a plain hex colour is refused here rather than sanitized downstream.
 *
 * Every field is optional on write, which is what makes a partial edit safe: a
 * console rename that sends no `mark` leaves the hospital's mark alone instead
 * of clearing it. An empty string is a deliberate "use the default", and the
 * client falls back to a derived value (`client/src/branding.ts`) for anything
 * it receives empty.
 */
const mark = z.string().trim().max(2, 'Use one or two characters for the brand mark.');
const tagline = z.string().trim().max(60, 'Keep the tagline under 60 characters.');
const reportCaption = z.string().trim().max(80, 'Keep the report heading under 80 characters.');
const reportFootnote = z.string().trim().max(160, 'Keep the report footnote under 160 characters.');
const accent = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .refine(
    (value) => value === '' || /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(value),
    'Use a hex colour like #12628f, or leave it empty for the default.'
  );

export const brandingFields = z.object({ mark, tagline, accent, reportCaption, reportFootnote });

/** The five columns, each optional — spread straight into a `set({ … })`. */
export const brandingEdit = brandingFields.partial();

export type BrandingEdit = z.infer<typeof brandingEdit>;

/**
 * The hospital block a session carries: identity plus the wording it owns.
 * Called with the registry row the request was bound to, which `authenticate()`
 * always sets — the branding travels with the token's facility claim, never with
 * anything the client sends.
 */
export function sessionFacility(facility: Facility) {
  return {
    id: facility.id,
    slug: facility.slug,
    name: facility.name,
    mark: facility.mark,
    tagline: facility.tagline,
    accent: facility.accent,
    reportCaption: facility.reportCaption,
    reportFootnote: facility.reportFootnote
  };
}

export type SessionFacility = ReturnType<typeof sessionFacility>;
