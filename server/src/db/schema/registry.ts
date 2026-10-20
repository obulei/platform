import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Facility registry. Unlike every table in `schema/index.ts`, these rows live in
 * `public` and are shared by the whole deployment: they are how a request's
 * facility claim is turned into the Postgres schema it may touch. Nothing
 * clinical belongs here.
 *
 * This file is deliberately absent from `drizzle.config.ts`. Registry DDL is
 * hand-written in `migrations/registry/` so that generated tenant DDL stays
 * free of shared objects.
 */

export const facilityStatus = pgEnum('facility_status', ['active', 'suspended']);

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());

export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercase URL identity, e.g. `acme-clinic`. Immutable once handed to a clinic. */
    slug: text('slug').notNull(),
    /** Name shown to that clinic's staff; their own branding work starts here. */
    name: text('name').notNull(),
    /**
     * Postgres schema holding this facility's tables. Derived from the slug by
     * provisioning and validated on every use — it is the only place a schema
     * name is read from, so no request can name a schema itself.
     */
    schemaName: text('schema_name').notNull(),
    /**
     * Presentation, not clinical data — see `migrations/registry/0002_facility_branding.sql`.
     * An empty value means "derive it", never "show nothing", so a hospital created
     * by the console before anyone set these still renders correctly.
     */
    mark: text('mark').notNull().default(''),
    tagline: text('tagline').notNull().default(''),
    /** `#rgb` or `#rrggbb`, applied as a CSS custom property on the client. */
    accent: text('accent').notNull().default(''),
    reportCaption: text('report_caption').notNull().default(''),
    reportFootnote: text('report_footnote').notNull().default(''),
    status: facilityStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    uniqueIndex('facilities_slug_key').on(t.slug),
    uniqueIndex('facilities_schema_name_key').on(t.schemaName)
  ]
);

export type Facility = typeof facilities.$inferSelect;
