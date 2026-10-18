CREATE TABLE "clinical_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"admission_id" uuid,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"findings" text NOT NULL,
	"diagnosis" text NOT NULL,
	"plan" text,
	"advice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"staff_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	CONSTRAINT "staff_roles_staff_id_role_pk" PRIMARY KEY("staff_id","role")
);
--> statement-breakpoint
DROP INDEX "staff_role_idx";--> statement-breakpoint
-- Carried over by hand: every account keeps the authorisation it had before
-- roles became grants, and staff.role must go so the two can never disagree.
INSERT INTO "staff_roles" ("staff_id", "role")
	SELECT "id", "role" FROM "staff"
	ON CONFLICT ("staff_id", "role") DO NOTHING;--> statement-breakpoint
ALTER TABLE "clinical_reports" ADD CONSTRAINT "clinical_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_reports" ADD CONSTRAINT "clinical_reports_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_reports" ADD CONSTRAINT "clinical_reports_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_reports" ADD CONSTRAINT "clinical_reports_author_id_staff_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_staff_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_reports_patient_idx" ON "clinical_reports" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "clinical_reports_appointment_idx" ON "clinical_reports" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "clinical_reports_admission_idx" ON "clinical_reports" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "staff_roles_role_idx" ON "staff_roles" USING btree ("role");--> statement-breakpoint
ALTER TABLE "staff" DROP COLUMN "role";