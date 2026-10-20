import type { SessionUser } from './api';

/**
 * Identity shown *before* anyone has signed in to a hospital. Once a session
 * exists, every screen reads that hospital's own wording from its registry row,
 * so nothing here may name one clinic: several hospitals share this build, and a
 * sign-in card or a printed report carrying the wrong clinic's name is worse than
 * carrying none. Each hospital's own text is edited from its Settings screen, and
 * by the operator's console — never in this file.
 */
export const CLINIC = {
  name: 'Hospital system',
  tagline: 'Hospital system',
  mark: 'H'
} as const;

/** The letter shown in the brand square when a hospital has typed no mark of its own. */
export function markFor(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || CLINIC.mark;
}

/** Everything a screen needs to know about whose hospital it is showing. */
export interface Brand {
  name: string;
  mark: string;
  tagline: string;
  /** Already validated by the API. Empty means "keep the stylesheet's colour". */
  accent: string;
  reportCaption: string;
  reportFootnote: string;
}

/**
 * One session resolved into branding. Anything the hospital left empty falls back
 * to a derived value or to the shared default, so a hospital the console added and
 * nobody has styled yet still looks complete rather than blank.
 */
export function brandFor(user: SessionUser | null): Brand {
  const facility = user?.facility;
  const name = facility?.name ?? CLINIC.name;
  return {
    name,
    mark: facility?.mark || markFor(name),
    tagline: facility?.tagline || CLINIC.tagline,
    accent: facility?.accent ?? '',
    reportCaption: facility?.reportCaption || 'Clinical report',
    reportFootnote:
      facility?.reportFootnote ||
      `Issued from the ${name} record. Every read and edit of this document is logged in the audit trail.`
  };
}
