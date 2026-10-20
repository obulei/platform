# Hospital Management System

A role-based hospital system for day-to-day clinic operation: patient registry, appointments,
inpatient wards and beds, pharmacy, laboratory, billing and signed clinical reports — with an
append-only audit trail.

Built for real use rather than a demo: the database, not the UI, is the authority on the rules that
matter (who is double-booked, which bed is taken, how much stock and money is left).

## Stack

| Layer | Choice |
| --- | --- |
| API | Node 20+, Fastify 5, Zod validation, `@fastify/jwt` |
| Database | Postgres 15, Drizzle ORM + drizzle-kit, `postgres.js` driver |
| Client | React 18, Vite 5, react-router 6, plain CSS design system |
| Auth | `crypto.scrypt` password hashes, 12-hour JWTs, 7 roles, several grants per person |

Monorepo with npm workspaces: `server/` and `client/`. Drizzle is installed at the workspace root so
`drizzle-kit` and `drizzle-orm` resolve to the same copy.

## Getting started

```bash
cp env.example .env          # then set a real JWT_SECRET: openssl rand -hex 32
./start.sh                   # Postgres + migrations + seed-if-empty + API + client
./stop.sh                    # stop the app (add --db to stop Postgres too)
```

`start.sh` loads the Node version pinned in `.nvmrc` (a system Node older than
20.17 cannot run the pinned npm), starts Postgres through Docker Compose,
applies migrations, seeds only when the database holds no staff yet, and leaves
both servers running in the background with logs in `.run/`. Re-running it is
safe.

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the API, so
no CORS setup is needed in development.

### Manual equivalent

```bash
docker compose up -d db
npm install
npm run db:migrate                            # schema + constraints + sequences
npm run db:seed                               # demo clinic (see accounts below)
npm run dev                                   # API :8080, client :5173
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run db:generate`
(after editing `server/src/db/schema/`).

Every data-entry form — where its fields live and how far a change reaches — is
mapped in [FORMS.md](FORMS.md).

### Database volume

`docker-compose.yml` fixes the project name to `hms` and marks the `hms_pgdata`
volume `external`, so `docker compose down` cannot delete clinic data. On a
fresh machine create the volume first (`docker volume create hms_pgdata`) or
drop those lines to let Compose manage its own.

### Sign-in and seeded logins

Sign-in takes three things: the **hospital code**, the work email and the password.
The code is a facility's slug — `cyber-hospitals` for the first clinic, named by
`FIRST_FACILITY_SLUG` before the first migration runs — because the same email
address can exist at two hospitals and a session must open exactly one of them.
The browser remembers the last code used, so staff type it once per machine.

There is no shared or default password anywhere in this repository. The seed
creates exactly one account that can sign in — `admin@clinic.test` — and its
password is either `SEED_ADMIN_PASSWORD` from `.env` or a generated one printed
once in the seed's final output. Copy it from that output; it is not stored
anywhere else.

The other eight staff rows (reception, three doctors, nurse, pharmacist, lab
technician, billing clerk) exist only so the seeded appointments, notes, results
and prescriptions have real authors. They are inserted inactive, hashed over
random bytes that are immediately discarded, so no password can open them. To let
one of them work for real, activate it on the Staff screen, tick the roles it
should hold, and set a password with `POST /api/staff/:id/reset-password` — all
administrator-only, all audited.

Every route that sets a password — a hospital's first administrator, a further
administrator, an operator, a staff account, an administrator reset and a
self-service change — applies one rule from one place: `passwordField` in
`server/src/lib/password.ts`. Ten characters that are not spaces, and no space at
either end. A bare length counter would hash twelve spaces happily, and the clinic
would then meet a wrong-password answer every time it typed what the form had
accepted. Sign-in itself checks nothing about a password's shape: an account created
before this rule must still open, and a login form is not where to explain policy.
`client/src/password.ts` mirrors the wording, so the field objects before the
request goes out and the server's answer reads the same as the hint above it.

The seed stops when the database holds any staff at all. `--force` re-runs it
against a populated database and adds a second cohort.

## Several hospitals on one deployment

One codebase, one Postgres cluster, one schema per hospital. `public.facilities` is the
registry — slug, display name, schema name, status — and every clinical table lives in
`f_<slug>` alongside that hospital's own `patient_mrn_seq` and `invoice_number_seq`, so
MRNs and invoice numbers start again at 1 for each clinic instead of being handed out
across the platform. Shared enums stay in `public`: a status means the same thing at
every hospital.

Isolation is enforced by the database rather than by a `WHERE` clause. Each hospital
gets a pool whose connections open with `-csearch_path=f_<slug>,public -crole=f_<slug>`,
so every query runs as that hospital's `nologin` role. The role is a **grantee, not an
owner**: the schema and its tables belong to the login that migrates them, while
`f_<slug>` holds `usage` on `public` (to name the shared enum types) and on its own
schema, plus read/write on its own schema's tables, sequences and functions — and
nothing else, not even `public.facilities`. Reaching another hospital therefore fails
with `permission denied for schema f_other_clinic` even when the name is spelled out in
full, and the role cannot create or drop a table either: it does DML inside one schema
or nothing. Which hospital a request belongs to comes from the `facility` claim in its
token — fixed when the person signs in — so there is no parameter a client can send to
aim a session at a different clinic. `server/src/db/tenant.ts` holds the pools,
`tenant-ddl.ts` the DDL, `provision.ts` the creating.

### Adding a hospital

Hospitals are added by a **platform administrator**: a separate identity from clinic
staff, stored in `public.platform_admins`, with its own sign-in at `/platform`. The first
one is made from a shell, because the screens that need it are the screens it protects:

```
npm run platform:admin --workspace server -- --name "Moses Obulei" --email ops@cyber.org
```

The password comes from `PLATFORM_ADMIN_PASSWORD` or is generated and printed once.

That account signs in at `/platform` and runs the deployment from there: add a hospital
with its first administrator, set one's name and identity, suspend or reactivate one, and
manage that hospital's *administrators only* — add, rename, deactivate, or set a new
password for one who lost it. Everything else inside a hospital (its staff, role grants,
wards, tariffs, patients) is managed by that hospital's own administrators on its own
screens; the console has no route to a nurse's account, and refuses one if asked.

A hospital needs its first administrator at creation because everything else is managed
inside it, and a hospital with no staff row has no way to make one. Two guards keep that
true: the console will not deactivate the last administrator who can sign in, and will not
remove the last operator, because a deployment nobody can sign in to is a deployment nobody
can fix.

Renaming changes the display name only. The address a hospital signs in at is never
renamed: it names that hospital's schema and its database role, and every staff member has
it memorised.

Sign-in is forgiving about which of the two a person types. `POST /api/auth/login` matches
the address case-insensitively and also accepts a hospital's display name, so Merid's staff
reach their clinic with `soroti`, `Merid` or `MERID`. A name two hospitals share opens
neither — the answer is the ordinary unknown-hospital one — so this cannot be used to probe
the registry, and an address always works whatever other clinics are called.

### What a hospital calls itself

A hospital's own wording — the letter in the brand square, the line under its name, its
accent colour, and the two sentences printed on a clinical report — is data, not code.
Five columns on its registry row (`mark`, `tagline`, `accent`, `report_caption`,
`report_footnote`, added by `migrations/registry/0002_facility_branding.sql`) hold it, and
it travels with the session, so `client/src/branding.ts` only supplies the defaults for a
hospital nobody has styled yet.

Two screens write those five fields through one validator (`server/src/lib/branding.ts`):
the operator's **Identity** dialog on `/platform`, and the hospital's own **Hospital
identity** screen at `/settings`, which only its administrators can open. Each writes the
registry row named by its caller's own token, never one chosen from the request body, so a
hospital can style itself and nobody else. Every field is optional: a save that omits a
line leaves it alone, and a blank line puts the default back. `accent` is restricted to
`#rgb` or `#rrggbb` because the client hands it to CSS as `--brand`, and the stylesheet
mixes its pale and dark shades from it — one field recolours buttons, links, the brand
square and the report rules. A hospital's own save lands in its own `audit_log`
(`settings.branding_updated`), because the request was bound to that schema before it
wrote anything.

Renaming stays the operator's job alone: the name is also an address staff may type, and
two hospitals sharing a name makes that address ambiguous.

A platform token carries `scope: platform` and names no facility; a staff token names a
facility and carries no scope. Each guard accepts only its own kind, so the operator who
creates hospitals cannot read a patient record and a hospital administrator cannot reach
`/api/platform`. Platform actions go to the server log rather than to an `audit_log`,
because a hospital's audit trail belongs to that hospital alone.

Suspending is immediate and reversible: sign-in resolves only `active` registry rows and
every request re-reads the registry, so a token minted minutes earlier starts returning
401 without waiting to expire. Nothing is deleted — the schema and its data wait for the
hospital to be reopened. A suspended hospital says so out loud ("PALACE is closed for
sign-in") rather than hiding behind the wrong-password answer, because staff have no way to
reason that out themselves and the obvious next step — resetting the password — fixes nothing.

Everything else a sign-in cannot answer stays deliberately indistinguishable: an unknown
address, a display name two hospitals share, an unknown account and a wrong password all
return the same sentence, so the endpoint cannot list facilities or enumerate staff. What
those four did *not* guess is recorded in the server log instead — `sign-in refused` with
`reason` of `unknown`, `ambiguous`, `hospital_closed`, `unknown_email` or `wrong_password`,
plus the address or hospital typed. That is what turns "the new administrator cannot log in"
into one `grep` rather than a phone call and a password reset.

Three harnesses prove all of this without touching a real database. Each builds a scratch
database, runs the API against it, and drops it again:

```
npx tsx .run/http_platform_e2e.mts     # adding a hospital, isolation, suspension
npx tsx .run/http_admin_crud_e2e.mts   # the new administrator's own CRUD, module by module
npx tsx .run/http_branding_e2e.mts     # both editors of a hospital's identity, and what neither may touch
```

The second one is the answer to "does a hospital created here actually work": its
administrator registers a patient (first MRN is `MRN-000001`, not the next number in the
other clinic's sequence), staff, wards and beds, admissions and vitals, appointments,
prescriptions and dispensing, lab tests through to a countersigned result, invoices and
payments, and a signed report — then `psql` confirms every row landed in `f_<slug>` and that
the older hospital still holds only its own.

## Roles

Roles are **grants**, not a column on the person. `staff_roles` holds one row per
(staff member, role) and an administrator ticks several of them on the Staff
screen, so a nurse who covers the desk at night can hold `nurse` and `reception`.
`staff.role` no longer exists — a grant is the only source of authorisation truth.

| Role | Can do |
| --- | --- |
| admin | Everything, including staff accounts, role grants, ward/bed setup and the audit trail |
| reception | Register/edit patients, book appointments, admit, raise and settle bills |
| doctor | Clinical notes, vitals, prescriptions, lab orders, results review, sign clinical reports |
| nurse | Vitals, notes, admissions/transfers/discharges, bed status |
| pharmacist | Stock, adjustments, dispensing |
| lab_technician | Collect specimens, enter results, test catalogue |
| billing | Invoices, payments, voids |

A session runs as **one** of those grants. At sign-in, an account holding several
roles is asked which one to work as — the dropdown only ever lists that person's
own grants, never the other six; an account with a single role goes straight in.
The sidebar can switch the active role afterwards (`POST /api/auth/switch-role`,
re-signed token, audited) without signing out. Revoking a grant ends any session
using it on the next request, because every request re-reads the staff row and
its grants.

Reads of operational data are open to any signed-in role; writes and clinical free-text are
restricted per route. The client mirrors the server's rules — a screen hidden in the sidebar is also
blocked by route, and the API rejects the request regardless. Client checks use `user.role` (the
active one), never `user.roles`.

## Clinical reports

A doctor (or an administrator) signs a report per encounter: `clinical_reports`
holds the title, findings, diagnosis, plan and advice, attached to **one**
appointment or one admission. `GET /api/reports/:id` assembles the printable
document — the patient, that encounter, its last ten observation sets,
countersigned lab results and the prescriptions written for it — so the printed
page and the database can never disagree. Only the author, or an administrator,
may amend it; the author on the document never changes. The client prints it with
the browser's own print dialog (`@media print` keeps only `.report-doc`), which
also saves it as PDF.

## Where the rules live

`server/src/db/advanced.ts` applies the constraints Drizzle cannot express, and the API deliberately
inserts and lets them fail rather than pre-checking (a pre-check races another station):

- `appointments_no_staff_overlap`, `appointments_no_patient_overlap` — `EXCLUDE USING gist` over
  `tstzrange(starts_at, ends_at)` for live bookings. A double-book returns **409** with a
  clinic-readable message.
- `admissions_one_open_per_bed`, `admissions_one_open_per_patient` — partial unique indexes, so
  discharging frees the bed and the patient with no bookkeeping.
- `medicines_stock_non_negative` plus a guarded `UPDATE … WHERE stock >= :qty` in a transaction, so
  two pharmacists cannot oversubscribe the same shelf.
- MRN (`MRN-000007`) and invoice numbers (`INV-000002`) come from Postgres sequences in column
  defaults, never from the application.
- Occupancy is derived from open admissions, not from `beds.status`; `beds.status` only distinguishes
  `available` from `maintenance`.

Every successful mutation writes an `audit_log` row (who, action, entity, request path). Sign-ins are
logged too.

Money columns are `numeric`, which the driver returns as strings. `server/src/lib/serialize.ts`
converts at the boundary — do not do arithmetic on a raw row value.

## Layout

```
start.sh / stop.sh  one-command dev lifecycle; logs and PIDs in .run/
.nvmrc              Node version the toolchain is known to work on
server/src/
  db/schema/        tables + enums (one file, exported through index.ts);
                    registry.ts and platform.ts are the shared `public` tables
  db/advanced.ts    constraints and indexes applied after each migration
  db/migrate.ts     shared enums → registry SQL → first facility → every schema
  db/tenant.ts      one pool per hospital, opened with its own search_path and role
  db/tenant-ddl.ts  the DDL and constraints each facility schema is kept up to
  db/provision.ts   creating a hospital, its first administrator, a platform account
  db/bootstrap-platform.ts the first platform administrator, from a shell
  db/seed.ts        demo clinic
  lib/              auth, RBAC, password, audit, errors, branding fields, money serialisation
  modules/          auth, staff, patients, appointments, inpatient, pharmacy,
                    lab, billing, reports, dashboard, audit, settings
                    platform.routes.ts and settings.routes.ts are the only modules
                    that write `public`; settings does it for one hospital, to itself
client/src/
  api.ts            fetch wrapper: bearer token, ApiError, 401 → sign-in;
                    platformApi() is the same wrapper over the operator token
  auth.tsx          session context, active-role switching, can(user, roles)
  platform-auth.tsx operator session for /platform
  roles.ts          the seven role names, labels and badge tones in one place
  branding.ts       the defaults shown before anyone signs in, plus brandFor(user),
                    which resolves one session into the wording that hospital owns
  layout.tsx        role-filtered sidebar, route visibility rule, page title, and the
                    hospital's accent set on the document root as --brand
  components.tsx    shared form/table/badge/modal primitives
  reports.tsx       report form, printable document and list (used by two pages)
  pages/            one screen per area; Platform* screens are the operator console,
                    SettingsPage is the hospital editing its own identity
```

## Before going live

1. Set `JWT_SECRET` to a long random value and keep `.env` out of version control.
2. Sign in with your hospital code as the seeded administrator, change that password
   (`POST /api/auth/change-password`), then create the clinic's real staff accounts from the
   Staff screen. The seeded author rows cannot sign in and need no cleanup — delete them if
   you want the demo history gone.

One consequence of that choice: `/api/staff/bookable` only lists active clinicians, so on a
freshly seeded database the appointment and admission pickers are empty until you activate a
doctor or nurse on the Staff screen.
3. Create the platform operator with `PLATFORM_ADMIN_PASSWORD` set to the password you want it
   to have. Sign in at `/platform`, add each real hospital there with its first
   administrator, then open **Operators** and add a second operator for whoever covers for
   you — one account per person, so the bootstrap account is never shared. Operators cannot
   change their own password in the product (re-running the bootstrap on an existing email
   will not do it either), so treat that password like the other deployment secrets; hospital
   administrators do change theirs in the product (`POST /api/auth/change-password`), and the
   console can set a new one for an administrator who lost theirs.
4. Put the API behind TLS and set `APP_ORIGIN` to the real client origin.
5. Replace the hard-coded per-day bed tariffs in `server/src/modules/billing.routes.ts`
   (`ICU_DAILY_TARIFF`, `GENERAL_DAILY_TARIFF`) with a tariff table — ICU and coronary beds are
   currently charged a flat premium and everything else a general rate.
6. Arrange Postgres backups. The audit log is append-only but has no retention policy yet.
   A dump into a directory git ignores, as the handover did, is enough to start:
   `docker exec hms-postgres pg_dump -U hms hms > "$(mkdir -p .run && echo .run)/backup.dump"`.
   Once a deployment holds several hospitals, back each one up on its own schedule so one
   clinic's data can be restored without rolling back the others:
   `docker exec hms-postgres pg_dump -U hms -n f_<slug> hms > .run/<slug>.dump`. The shared
   `public` schema — the registry and the platform administrators — needs dumping too, and
   restoring it is the step that decides which hospitals the API is willing to open at all.

### Remaining `npm audit` findings

`drizzle-orm` (SQL identifier escaping) and `@fastify/jwt` / `fast-jwt` (a set of
critical token-verification bypasses) were upgraded to fixed versions. Two
moderate findings remain, both of which need a major-version jump that has not
been validated against this codebase:

- **vite 5 → 8** — the bundled esbuild lets any web page send requests to a
  running dev server. Only relevant while `./start.sh` has Vite up; the fix is
  to not browse elsewhere while developing, or upgrade and re-test the build.
- **react-router-dom 6 → 7** — open redirect via a backslash in `<Link>` /
  `useNavigate`, and an SSR-only `deserializeErrors()` issue. This app never
  navigates to a user-supplied target and does not render on the server, so
  neither path applies today.

# cyber
