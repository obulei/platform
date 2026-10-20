-- Per-hospital branding, held on the registry row.
--
-- These five columns are the only wording a hospital owns outside its name: the
-- letter in the brand square, the line under it, the accent colour, and the two
-- sentences printed on a clinical report. They live in `public` next to `name`
-- rather than in each `f_<slug>` schema so that one console connection edits
-- them, no tenant migration is needed, and a facility's clinical tables stay
-- free of presentation settings.
--
-- Every column defaults to empty. Empty means "the app derives it" — the mark
-- falls back to the first letter of the name, the tagline and report lines to the
-- shared defaults in `client/src/branding.ts`. Adding a hospital therefore adds
-- no wording at all until somebody types some.
--
-- Idempotent because the migration runner replays this folder on every deploy.

alter table "facilities" add column if not exists "mark" text NOT NULL DEFAULT '';

--> statement-breakpoint
alter table "facilities" add column if not exists "tagline" text NOT NULL DEFAULT '';

--> statement-breakpoint
alter table "facilities" add column if not exists "accent" text NOT NULL DEFAULT '';

--> statement-breakpoint
alter table "facilities" add column if not exists "report_caption" text NOT NULL DEFAULT '';

--> statement-breakpoint
alter table "facilities" add column if not exists "report_footnote" text NOT NULL DEFAULT '';
