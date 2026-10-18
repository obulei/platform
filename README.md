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

### Seeded logins

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

The seed stops when the database holds any staff at all. `--force` re-runs it
against a populated database and adds a second cohort.

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
  db/schema/        tables + enums (one file, exported through index.ts)
  db/advanced.ts    constraints and indexes applied after each migration
  db/migrate.ts     sequences → drizzle migrate → advanced constraints
  db/seed.ts        demo clinic
  lib/              auth, RBAC, password, audit, errors, money serialisation
  modules/          auth, staff, patients, appointments, inpatient, pharmacy,
                    lab, billing, reports, dashboard, audit
client/src/
  api.ts            fetch wrapper: bearer token, ApiError, 401 → sign-in
  auth.tsx          session context, active-role switching, can(user, roles)
  roles.ts          the seven role names, labels and badge tones in one place
  layout.tsx        role-filtered sidebar and route visibility rule
  components.tsx    shared form/table/badge/modal primitives
  reports.tsx       report form, printable document and list (used by two pages)
  pages/            one screen per area
```

## Before going live

1. Set `JWT_SECRET` to a long random value and keep `.env` out of version control.
2. Sign in as the seeded administrator, change that password (`POST /api/auth/change-password`),
   then create the clinic's real staff accounts from the Staff screen. The seeded author rows
   cannot sign in and need no cleanup — delete them if you want the demo history gone.

One consequence of that choice: `/api/staff/bookable` only lists active clinicians, so on a
freshly seeded database the appointment and admission pickers are empty until you activate a
doctor or nurse on the Staff screen.
3. Put the API behind TLS and set `APP_ORIGIN` to the real client origin.
4. Replace the hard-coded per-day bed tariffs in `server/src/modules/billing.routes.ts`
   (`ICU_DAILY_TARIFF`, `GENERAL_DAILY_TARIFF`) with a tariff table — ICU and coronary beds are
   currently charged a flat premium and everything else a general rate.
5. Arrange Postgres backups. The audit log is append-only but has no retention policy yet.
   A dump into a directory git ignores, as the handover did, is enough to start:
   `docker exec hms-postgres pg_dump -U hms hms > "$(mkdir -p .run && echo .run)/backup.dump"`.

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
