import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Platform administrators: the accounts that sign clinics up. Like the facility
 * registry, this table lives in `public` and belongs to no hospital, because its
 * whole job is to act across hospitals. It is deliberately not part of a
 * facility schema, so no clinic's own administrator can read or write it, and no
 * clinical data can be stored here.
 *
 * This file is absent from `drizzle.config.ts`. Its DDL is hand-written in
 * `migrations/registry/0001_platform_admins.sql`, the same way `facilities` is.
 */

export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('platform_admins_email_key').on(sql`lower(${t.email})`)]
);

export type PlatformAdminRow = typeof platformAdmins.$inferSelect;
