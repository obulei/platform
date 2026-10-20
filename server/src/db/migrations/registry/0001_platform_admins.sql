-- Platform administrators. Applied to `public` on every migration, like the registry.
--
-- Separate from `staff` on purpose: staff rows live inside one hospital's schema, so a
-- platform account cannot be mistaken for clinic staff, cannot be granted a clinical
-- role by accident, and cannot be counted in a clinic's own staff screen. Idempotent
-- because the migration runner replays this folder on every deploy.

create table if not exists platform_admins (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
create unique index if not exists "platform_admins_email_key" on "platform_admins" (lower("email"));
