# Pheno Lab Data Platform

Internal web platform for capturing perovskite solar cell experiments — a card-based
Experiment Designer for admins/managers plus (Phase 3) a mobile capture portal for
lab technicians. See `../PLAN.md` for the full project plan.

Before agent-assisted development, read [`../AGENTS.md`](../AGENTS.md) and the current
[`development standards`](../docs/development-standards.md). Production changes must follow the single
[`deployment manual`](deploy/README.md); the first real deployment is recorded in the
[`production deployment log`](../docs/pheno-lab-production-deployment-log-2026-08-25.md).
Bulk PostgreSQL or file imports are separate production changes and must follow the
[`data import rules`](../docs/data-import-rules.md).

## Stack

Next.js 16 (App Router, TypeScript) · Tailwind 4 (Pheno design tokens) · PostgreSQL + Prisma 6 · pnpm

## Run locally

```bash
pnpm install
docker compose up -d                    # PostgreSQL 18 on 55432, test DB on 55433
pnpm prisma migrate dev                 # apply schema
pnpm prisma db seed                     # demo data + accounts
pnpm dev                                # or: pnpm build && pnpm start -p 3457
```

Copy `.env.example` to `.env` and provide a test/development PostgreSQL URL plus
independent secrets. Runtime configuration is validated before the server
accepts traffic.

`compose.yaml` runs only the databases — the Next.js process stays on the host
for the fastest hot reload. If you already run PostgreSQL 18 locally, skip
Compose and point `DATABASE_URL` at it instead.

Integration tests need the second database and refuse to run against the
development one:

```bash
TEST_DATABASE_URL="postgresql://pheno:test_only@127.0.0.1:55433/pheno_lab_test" \
  pnpm test:integration
```

## Seeded accounts (Pheno organization)

| Role       | Email              | Password    | Access                                                   |
| ---------- | ------------------ | ----------- | -------------------------------------------------------- |
| Admin      | mike@ultiprice.com | `pheno2026` | all org experiments, grants access, controls org         |
| Manager    | manager@pheno.lab  | `lab2026`   | creates experiments; sees own + ones they're involved in |
| Technician | tech@pheno.lab     | `lab2026`   | read-only, only experiments they're assigned to          |

Change these before deploying to the lab server. All data (experiments, presets,
equipment, materials, environments, labels, users) is scoped per organization;
new organizations can be added later without schema changes.

## Structure

- `prisma/schema.prisma` — full data model. Process is the overarching library
  layer: equipment (with its own parameter definitions, photo, and location
  preset) and materials belong to a process. Environments are presets with
  per-environment tracked conditions. Experiments hold samples/variation groups,
  a test plan (variable → process → groups + control), steps + parameter
  variations, characterizations; run/execution tables ready for the Phase 3 portal.
- `src/modules/` — application/domain services for accounts, authorization,
  audit, experiments, runs, ingest, instruments, library, organizations,
  exports, files, workflow, and system operations
- `src/infrastructure/` — validated server configuration and object-storage adapters
- external `UPLOAD_DIR` — capture images and instrument originals; never place production files in a release directory
- `src/lib/i18n/` — EN/ZH dictionary and providers; language is per-user (profile page), English default
- `/` — homepage board: kanban ⇄ list views with search, create, duplicate; technicians see their assigned tasks
- `/experiments/[id]/capture` — Phase 3 capture portal: per-sample planned-vs-actual step capture, environment conditions, notes/flags/photos, and characterization result entry (the one place technicians write)
- `/profile` — account settings, password change, language, stats, and bug/feedback reporting
- `/feedback` + `/api/feedback-export` — admin-only feedback inbox with JSON export for agents
- `src/lib/actions/` — framework adapters for remaining Server Actions; critical authorization and ingest rules live in modules
- `src/components/designer/` — the three-pane Experiment Designer
- `src/app/(app)/` — experiment list, designer, library pages
- `public/brand/` — official Pheno logo assets (do not modify; see brand rules)

## Security & backups

- Sessions are signed JWTs in httpOnly cookies; passwords are bcrypt-hashed;
  every mutation re-checks role and organization server-side; uploads are
  auth-gated and type/size-validated.
- Registration is OTP-based (`/register`) and restricted to the organization's
  allowed email domains (Users page). New accounts start as Technician;
  deactivated accounts cannot sign in. OTP codes are never written to logs;
  until SMTP is configured, an admin can retrieve pending codes from the Users
  page.
- Backups: local development can use `scripts/backup.sh` and `BACKUP_DIR`.
  Production sets `BACKUP_MODE=external`; backup and restore jobs run on the
  independent PostgreSQL server, while `/system` reports that external mode
  instead of writing database dumps to the application CVM.
- Ubuntu/systemd deployment, immutable releases, health checks, and rollback are
  documented in [`deploy/README.md`](deploy/README.md). The longer-term modular
  monolith and COS plan lives in [`../docs/architecture-refactor.md`](../docs/architecture-refactor.md).

## Sample ID schema

Experiments use `YYYY-ORG-USER-SEQ`; samples are `S1…Sn` within an experiment.
The app also assigns short instrument handles such as `E7-S5` and preserves
normalized aliases for existing lab naming schemes.
