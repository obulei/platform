-- Deployment-wide registry. Applied to `public` on every migration.
--
-- Hand-written rather than drizzle-generated, and deliberately absent from
-- drizzle.config.ts: these tables must never be copied into a facility schema,
-- because they are what maps a facility to the schema it is allowed to touch.
-- The `facility_status` enum is created from the schema definitions (see
-- sharedTypeStatements in tenant-ddl.ts), so it exists before this runs.

create table if not exists facilities (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"schema_name" text NOT NULL,
	"status" "public"."facility_status" NOT NULL DEFAULT 'active',
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint
create unique index if not exists "facilities_slug_key" on "facilities" ("slug");

--> statement-breakpoint
create unique index if not exists "facilities_schema_name_key" on "facilities" ("schema_name");
