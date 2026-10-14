# Hospital Management System

A role-based hospital system for day-to-day clinic operation: patient registry, appointments,
inpatient wards and beds, pharmacy, laboratory and billing — with an append-only audit trail.

Built for real use rather than a demo: the database, not the UI, is the authority on the rules that
matter (who is double-booked, which bed is taken, how much stock and money is left).

## Stack

| Layer | Choice |
| --- | --- |
| API | Node 20+, Fastify 5, Zod validation, `@fastify/jwt` |
| Database | Postgres 15, Drizzle ORM + drizzle-kit, `postgres.js` driver |
| Client | React 18, Vite 5, react-router 6, plain CSS design system |
| Auth | `crypto.scrypt` password hashes, 12-hour JWTs, 7 roles |

Monorepo with npm workspaces: `server/` and `client/`. Drizzle is installed at the workspace root so
`drizzle-kit` and `drizzle-orm` resolve to the same copy.

## Getting started

```bash
docker compose up -d                            # Postgres 15 on 127.0.0.1:5433
cp env.example .env                             # then set a real JWT_SECRET
npm install
npm run db:migrate                              # schema + constraints + sequences
npm run db:seed                                 # demo clinic (see accounts below)
npm run dev                                     # API :8080, client :5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the API, so no CORS setup is
needed in development.

Other scripts: `npm run typecheck`, `npm run build`, `npm run db:generate` (after editing
`server/src/db/schema/`).

### Demo accounts

Seeded with password `Clinic#2026` for every account:

`admin@clinic.test` · `reception@clinic.test` · `doctor@clinic.test` · `pediatrics@clinic.test` ·
`surgery@clinic.test` · `nurse@clinic.test` · `pharmacy@clinic.test` · `lab@clinic.test` ·
`billing@clinic.test`

The seed is idempotent — it stops if an administrator already exists. Pass `--force` to re-run
against a populated database.

## Roles

| Role | Can do |
| --- | --- |
| admin | Everything, including staff accounts, ward/bed setup and the audit trail |
| reception | Register/edit patients, book appointments, admit, raise and settle bills |
| doctor | Clinical notes, vitals, prescriptions, lab orders, results review |
| nurse | Vitals, notes, admissions/transfers/discharges, bed status |
| pharmacist | Stock, adjustments, dispensing |
| lab_technician | Collect specimens, enter results, test catalogue |
| billing | Invoices, payments, voids |

Reads of operational data are open to any signed-in role; writes and clinical free-text are
restricted per route. The client mirrors the server's rules — a screen hidden in the sidebar is also
blocked by route, and the API rejects the request regardless.

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
server/src/
  db/schema/        tables + enums (one file, exported through index.ts)
  db/advanced.ts    constraints and indexes applied after each migration
  db/migrate.ts     sequences → drizzle migrate → advanced constraints
  db/seed.ts        demo clinic
  lib/              auth, RBAC, password, audit, errors, money serialisation
  modules/          auth, staff, patients, appointments, inpatient, pharmacy,
                    lab, billing, dashboard, audit
client/src/
  api.ts            fetch wrapper: bearer token, ApiError, 401 → sign-in
  auth.tsx          session context + can(user, roles)
  layout.tsx        role-filtered sidebar and route visibility rule
  components.tsx    shared form/table/badge/modal primitives
  pages/            one screen per area
```

## Before going live

1. Set `JWT_SECRET` to a long random value and keep `.env` out of version control.
2. Create real staff accounts and remove or disable the seeded demo logins.
3. Put the API behind TLS and set `APP_ORIGIN` to the real client origin.
4. Replace the hard-coded per-day bed tariffs in `server/src/modules/billing.routes.ts`
   (`ICU_DAILY_TARIFF`, `GENERAL_DAILY_TARIFF`) with a tariff table — ICU and coronary beds are
   currently charged a flat premium and everything else a general rate.
5. Arrange Postgres backups. The audit log is append-only but has no retention policy yet.
