# Forms map

Every data-entry form in the client, where its fields live, and how far a change
has to reach. Open this next to the file you are editing in VS Code.

## How a form is built

A form is one React component, four layers deep:

1. **Fields** — `<Field label="…" hint="…" required>` wrapping `<Input>` /
   `<Select>` / `<Textarea>`, inside a `<Modal title="…">`. All in one JSX block.
2. **State** — the component holding the values sits directly above the modal it
   renders (named `*Modal`, `*Form`, or `ProfileFields`). Most use one `useState`
   per field; the patient forms use a typed object (`DemographicsForm`).
3. **Submit** — an `api('/api/…', { method: 'POST', body: JSON.stringify({ … }) })`
   call in that component's submit handler.
4. **Server** — a zod schema in `server/src/modules/<area>.routes.ts` validates the
   body, then a Drizzle table in `server/src/db/schema/index.ts` stores it.

## Changing a label, hint, order, or required flag

Layer 1 and 2 only. Save the file, Vite hot-reloads, the form updates in place —
no restart, no migration.

- Label, hint, placeholder: edit the props on `<Field>` / `<Input>`.
- Required star and browser validation: `required` on `<Field>` (label) **and**
  on the `<Input>` (enforcement) are two separate props — change both.
- Two-column forms: `className="form-span-2"` on a `<Field>` widens it; removing
  it returns the field to one column.
- Reordering: move the whole `<Field>…</Field>` block. Nothing keys off position.

Careful: dropping `required` client-side does **not** make the server accept an
empty value if its zod schema says `.min(1)` — check layer 4 before making a
field optional for real.

## The forms

| Form | Component | Modal JSX | POST/PATCH endpoint | Server schema | Table |
|---|---|---|---|---|---|
| Staff sign in (and role choice) | `LoginPage.tsx:9` | form `:46` | `POST /api/auth/login` | `auth.routes.ts:27` | `staff:50`, `staffRoles:74` |
| Register patient | `PatientsPage.tsx:296` | `:333` | `POST /api/patients` | `patients.routes.ts:28` | `patients:72` |
| Edit patient details | `PatientDetailPage.tsx:1023` | `:1059` | `PATCH /api/patients/:id` | `patients.routes.ts:28` | `patients:72` |
| New appointment | `AppointmentsPage.tsx:607` | `:672` | `POST /api/appointments` | `appointments.routes.ts:16` | `appointments:108` |
| New appointment (from patient) | `PatientDetailPage.tsx:1169` | `:1238` | `POST /api/appointments` | `appointments.routes.ts:16` | `appointments:108` |
| Admit to ward | `WardsPage.tsx:327` | `:472` | `POST /api/admissions` | `inpatient.routes.ts:47` | `admissions:167` |
| Discharge patient | `WardsPage.tsx:1100` | `:1135` | `POST /api/admissions/:id/discharge` | `inpatient.routes.ts:63` | `admissions:167` |
| Clinical note (ward panel) | `WardsPage.tsx:656` | inline, api call `:738` | `POST /api/admissions/:id/notes` | `inpatient.routes.ts:68` | `clinicalNotes:200` |
| Clinical note (patient page) | `PatientDetailPage.tsx:715` | api call `:752` | `POST /api/admissions/:id/notes` | `inpatient.routes.ts:68` | `clinicalNotes:200` |
| Clinical report (sign) | `reports.tsx:216` | `:338` | `POST /api/reports` | `reports.routes.ts:37`, `:52` | `clinicalReports:245` |
| Clinical report (amend) | `reports.tsx:216` given `reportId` | `:338` | `PATCH /api/reports/:id` | `reports.routes.ts:37`, `:57` | `clinicalReports:245` |
| Vitals (ward panel) | `WardsPage.tsx:656` | inline, api call `:775` | `POST /api/patients/:patientId/vitals` | `inpatient.routes.ts:74` | `vitalsRecords:225` |
| Admission detail edits | `WardsPage.tsx:656` | `:848`, api call `:797` | `PATCH /api/admissions/:id` | `inpatient.routes.ts:56` | `admissions:167` |
| Add / edit medicine | `PharmacyPage.tsx:421` | `:507` | `POST /api/medicines`, `PATCH /api/medicines/:id` | `pharmacy.routes.ts:33`, `:49` | `medicines:252` |
| Adjust stock | `PharmacyPage.tsx:608` | `:663` | `POST /api/medicines/:id/adjust-stock` | `pharmacy.routes.ts:60` | `stockMovements:271` |
| New prescription | `PharmacyPage.tsx:1187` | `:1259` | `POST /api/prescriptions` | `pharmacy.routes.ts:67` | `prescriptions:287` |
| Dispense | `PharmacyPage.tsx:856` | `:972` | `POST /api/prescriptions/:id/dispense` | `pharmacy.routes.ts:87` | `prescriptionItems:312` |
| New lab order | `LabPage.tsx:301` | `:395` | `POST /api/lab/orders` | `lab.routes.ts:82` | `labOrders:356` |
| Result entry | `LabPage.tsx:494` | inside `:666` | `POST /api/lab/items/:itemId/result` | `lab.routes.ts:93` | `labResults:400` |
| Lab test catalogue | `LabPage.tsx:1296` | `:1364` | `POST /api/lab/tests`, `PATCH /api/lab/tests/:id` | `lab.routes.ts:59`, `:70` | `labTests:337` |
| New invoice | `BillingPage.tsx:522` | `:591` | `POST /api/invoices` | `billing.routes.ts:232` | `invoices:424` |
| Invoice line item | `BillingPage.tsx:243` | `:306` | `POST /api/invoices/:id/items` | `billing.routes.ts:224` | `invoiceItems:449` |
| Record payment | `BillingPage.tsx:354` | `:404` | `POST /api/invoices/:id/payments` | `billing.routes.ts:250` | `payments:466` |
| Void invoice | `BillingPage.tsx:446` | `:484` | `POST /api/invoices/:id/void` | `billing.routes.ts:257` | `invoices:424` |
| Bill an encounter | `BillingPage.tsx:685` | `:756` | `POST /api/invoices/from-encounter` | `billing.routes.ts:259` | `invoices:424` |
| Add staff member | `StaffPage.tsx:202` | `:241` | `POST /api/staff` | `staff.routes.ts:57`, `:68` | `staff:50`, `staffRoles:74` |
| Edit staff member and role grants | `StaffPage.tsx:275` | `:363` | `PATCH /api/staff/:id` | `staff.routes.ts:57` | `staff:50`, `staffRoles:74` |
| Platform sign in | `PlatformLoginPage.tsx:11` | form `:35` | `POST /api/platform/login` | `platform.routes.ts:34` | `platformAdmins` (`schema/platform.ts:15`) |
| Add hospital + first administrator | `PlatformHospitalsPage.tsx:61` | `:433` | `POST /api/platform/facilities` | `platform.routes.ts:45` (nests `:39`) | `facilities` (`schema/registry.ts:21`), `staff` + `staffRoles` in the new schema |
| Hospital identity — by the operator | `PlatformHospitalsPage.tsx:61` | `:517` | `PATCH /api/platform/facilities/:slug` | `platform.routes.ts:58`, fields from `lib/branding.ts:30` | `facilities:21` in `public` |
| Hospital identity — by the hospital | `SettingsPage.tsx:18` | inline, fields `:95`, save `:49` | `GET` + `PATCH /api/settings` | `settings.routes.ts:39` → `lib/branding.ts:33` | `facilities:21` in `public` |
| Add administrator to a hospital | `PlatformHospitalsPage.tsx:61` | form `:673` | `POST /api/platform/facilities/:slug/administrators` | `platform.routes.ts:39` | `staff:50`, `staffRoles:74` in that hospital's schema |
| Rename or deactivate an administrator | `PlatformHospitalsPage.tsx:61` | form `:624` | `PATCH /api/platform/facilities/:slug/administrators/:staffId` | `platform.routes.ts:65` | `staff:50` |
| Set an administrator's password | `PlatformHospitalsPage.tsx:61` | form `:642` | `POST /api/platform/facilities/:slug/administrators/:staffId/reset-password` | `platform.routes.ts:74` | `staff:50` |
| Add platform operator | `PlatformOperatorsPage.tsx:22` | `:207` | `POST /api/platform/operators` | `platform.routes.ts:77` | `platformAdmins` (`schema/platform.ts:15`) |

Paths are relative to `client/src/pages/` — except the report form, which lives
in `client/src/reports.tsx` because both the patient page and the reports page
render it — plus `server/src/modules/` and `server/src/db/schema/` (all tables
share `index.ts`). Filter bars and pickers (`PatientPicker`, `MedicinePicker`,
tab status selects) are search controls, not data-entry forms; they live in the
same files at the line numbers above.

Suspending or reopening a hospital and removing an operator are single buttons, not
forms — `POST/PATCH` with no fields the operator types, so they have no row here.
Both guard against the one state that would strand the deployment: the last
administrator who can sign in at a hospital cannot be deactivated, and the last
operator cannot be removed.

The two hospital-identity forms edit the same five registry columns and run the same
validator, `brandingFields` in `server/src/lib/branding.ts`. They are the only place
where a hospital's own staff write something that is not clinical data: the mark,
tagline, accent colour and the two printed-report lines sit on the registry row,
which the API picks from the session's facility claim — never from the body. Every
field is optional, so a save that sends one line leaves the other four alone, and a
blank one returns the shared default. An administrator's save is audited inside that
hospital's own `audit_log`, because the request was bound to its schema first.

The console forms are the exception to every other row. They write to
`public`, not to a hospital schema, so their tables sit in `db/schema/registry.ts`
and `db/schema/platform.ts` rather than `db/schema/index.ts`, and they are
recorded in the server log instead of an `audit_log` — a hospital's audit trail
belongs to that hospital alone. Two rules exist once per side of the wire, because
the client cannot import server code: `SLUG` at `PlatformHospitalsPage.tsx:21`
mirrors `FACILITY_SLUG` in `server/src/db/tenant-ddl.ts`, and `passwordProblem` in
`client/src/password.ts` mirrors `passwordField` in `server/src/lib/password.ts`.
The client side is one shared module rather than a constant per page, so every
password field in the app rejects the same two things — fewer than ten characters
that are not spaces, and a space at either end — in the server's own words. Loosen
one side and the other still rejects; change both, and treat the server's answer as
the rule.

## Roles are ticks, and one role is active

Staff roles are a checkbox set (`ProfileFields` at `StaffPage.tsx:111`) saved as
rows in `staffRoles`. The body always sends `roles: string[]`; the server sorts
and de-duplicates it. A session, though, runs as **one** of those grants:
sign-in asks for a choice when the account holds several (`role_required`,
rendered as the dropdown at `LoginPage.tsx:81`), and the sidebar's "Switch role"
control re-signs the token without signing out. Any new field that depends on
what the caller may do should read `user.role` — the active role — never
`user.roles`.

## The printed clinical report

`ReportFormModal` (`client/src/reports.tsx:216`) writes the text a clinician
signs. `ReportDocumentView` (`:558`) renders the same document the server
assembles at `GET /api/reports/:id`: the patient, the encounter it answers, the
ten latest observations, countersigned lab results and the prescriptions written
for that visit or stay. It prints through `@media print` in
`client/src/styles.css`, which hides the app frame and keeps only
`.report-doc` — so the print button cannot produce a page of menus. Editing the
document layout means editing that JSX and the `.report-*` rules beside it.


Most write routes carry a role guard (`preHandler: authenticate(…)`) next to the
path, so a form that saves as administrator can still answer 403 for a nurse or
a pharmacist. Check that argument before assuming a rejected submission is a
field problem.

## Adding or removing a real field

Four layers, in this order:

1. `server/src/db/schema/index.ts` — add the column to the table.
2. `nvm use && npm run db:generate && npm run db:migrate` — creates and applies the
   migration. Make the column nullable, or seed existing rows before making it
   required.
3. `server/src/modules/<area>.routes.ts` — accept it in the zod schema, return it
   in the `toDto`/select mapping, write it in the insert/update.
4. `client/src/pages/<Area>Page.tsx` — state, `<Field>` block, and the body sent
   to `api()`.

Then typecheck both sides with `npm run typecheck` before reloading the browser.

The patient form is the one exception worth knowing: `DemographicsForm` is
declared twice, at `PatientsPage.tsx:58` (register) and
`PatientDetailPage.tsx:164` (edit), so a patient field must be added to both.
