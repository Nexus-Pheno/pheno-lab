# Pheno Lab Data Platform

Internal web platform for capturing perovskite solar cell experiments — a card-based
Experiment Designer for admins/managers plus (Phase 3) a mobile capture portal for
lab technicians. See `../PLAN.md` for the full project plan.

## Stack

Next.js 16 (App Router, TypeScript) · Tailwind 4 (Pheno design tokens) · PostgreSQL + Prisma 6 · pnpm

## Run locally

```bash
pnpm install
createdb pheno_lab                      # requires local PostgreSQL
npx prisma migrate dev                  # apply schema
npx prisma db seed                      # demo data + accounts
pnpm dev                                # or: pnpm build && pnpm start -p 3457
```

Configuration lives in `.env` (`DATABASE_URL`, `SESSION_SECRET`).

## Seeded accounts (Pheno organization)

| Role | Email | Password | Access |
|---|---|---|---|
| Admin | mike@ultiprice.com | `pheno2026` | all org experiments, grants access, controls org |
| Manager | manager@pheno.lab | `lab2026` | creates experiments; sees own + ones they're involved in |
| Technician | tech@pheno.lab | `lab2026` | read-only, only experiments they're assigned to |

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
- `uploads/` — equipment photos and feedback screenshots (served via `/api/files/<name>`, auth required)
- `src/lib/i18n/` — EN/ZH dictionary and providers; language is per-user (profile page), English default
- `/` — homepage board: kanban ⇄ list views with search, create, duplicate; technicians see their assigned tasks
- `/experiments/[id]/capture` — Phase 3 capture portal: per-sample planned-vs-actual step capture, environment conditions, notes/flags/photos, and characterization result entry (the one place technicians write)
- `/profile` — account settings, password change, language, stats, and bug/feedback reporting
- `/feedback` + `/api/feedback-export` — admin-only feedback inbox with JSON export for agents
- `src/lib/actions/` — server actions (all mutations, admin-gated server-side)
- `src/components/designer/` — the three-pane Experiment Designer
- `src/app/(app)/` — experiment list, designer, library pages
- `public/brand/` — official Pheno logo assets (do not modify; see brand rules)

## Security & backups

- Sessions are signed JWTs in httpOnly cookies; passwords are bcrypt-hashed;
  every mutation re-checks role and organization server-side; uploads are
  auth-gated and type/size-validated.
- Registration is OTP-based (`/register`) and restricted to the organization's
  allowed email domains (Users page). New accounts start as Technician;
  deactivated accounts cannot sign in. OTP codes appear in the server log and
  the admin Users page until SMTP is configured.
- Backups: `scripts/backup.sh` writes gzipped `pg_dump` snapshots to `backups/`
  (last 30 kept). A daily 03:00 launchd job is installed
  (`~/Library/LaunchAgents/com.pheno.lab-backup.plist`, log: /tmp/pheno-lab-backup.log).
  Admins can also trigger and inspect backups at `/system`, which shows the
  database host, size, largest tables, uploads size, and disk usage.
- Storage migration: point `DATABASE_URL` at a new PostgreSQL host (NAS/cloud)
  and restore the latest backup (`gunzip -c backup.sql.gz | psql <new-url>`).

## Sample ID schema

Experiments are auto-coded `EXP-YYYY-NNN` (per-year counter). Samples are `S1…Sn`
within an experiment; the full sample ID is `EXP-YYYY-NNN-Sn`.
