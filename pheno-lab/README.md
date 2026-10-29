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
- `/experiments/[id]/results` — measured comparison, grouped plots and current FF/PCE/Voc/Jsc analysis. Analysis and plots use one accepted representative per physical device and characterization, with complete metric vectors. Named conditions distinguish planned settings, recorded actuals, retrospective entries and missing execution. The analysis reference can differ explicitly from the plan control without rewriting the design. Group means and control differences are descriptive, not causal or significance claims. The former single-experiment `/report` route redirects here after authorization; weekly `/reports` is separate.
- `/profile` — account settings, password change, language, stats, and bug/feedback reporting
- `/feedback` + `/api/feedback-export` — admin-only feedback inbox with JSON export for agents
- `src/lib/actions/` — framework adapters for remaining Server Actions; critical authorization and ingest rules live in modules
- `src/components/designer/` — the three-pane Experiment Designer
- `src/app/(app)/` — experiment list, designer, library pages
- `public/brand/` — official Pheno logo assets (do not modify; see brand rules)

## Experiment result interpretation

The Results page and Designer share a bilingual AI interpretation panel, including
interim results during IN_LAB. It separates practical material/process potential
from repeatability confidence and keeps AI drafts separate from scientist conclusions.
A highest-PCE gain of +0.5 absolute percentage points is an exploratory internal
screening reference under comparable conditions, not significance or a rejection rule.
Purpose-specific component metrics and original non-JV objectives remain necessary.

After committed result entry or matched JV results, a persisted marker coalesces
updates over a 60-second quiet period. The existing rematch worker resumes bounded
automatic work after interruption; no additional service or schedule is introduced.
Manual generation remains available. Provider failure preserves deterministic
results and prior summaries. Source fingerprints, policy/prompt versions, fresh
permissions and generation tokens prevent stale responses from replacing current
evidence. Authorized editors can mark only the current source version reviewed.

On the official DeepSeek endpoint, result interpretation explicitly requests final
JSON with low reasoning effort, a 12,000-token total budget and a 110-second
timeout, below the existing three-minute stale-run lease. Blank or token-truncated
final answers remain failures; reasoning text is never used or saved. Other
providers and other chat features retain their existing request behavior. The
tiny official DeepSeek connection check disables thinking only for its probe.
The prompt also distinguishes a shared carrier from a changed factor,
applies the screening reference to the highest-PCE difference, and prioritizes
fixed-condition repetition when a promising result has wide device-to-device
spread. Missing recorded objectives remain explicitly plan-implied comparisons.

Prompt version 3 and the panel use a result-first reading order: observed result
and practical judgment, the concrete question that could change that judgment,
then the next controlled experiment. Short separate sentences replace combined
result/caveat/disclaimer clauses. General methods are not repeated per group;
the recorded purpose and generation details are available once in the panel's
collapsed context section. Important local limitations stay with the relevant
decision, and possible mechanisms remain distinct from observations. Draft,
stale-source and researcher-review controls remain visible. This is a writing
contract, not a ban on uncertainty words or a relaxation of evidence checks.

The existing organization provider receives a reduced, privacy-filtered payload.
Private molecular notation and full formulation payloads are withheld. Weekly
reporting reads the same deterministic evidence and may reuse only a current,
reviewed interpretation using the same comparison selection; it still requires
independent numerical, scientific and privacy review. See the read-only operator
[evidence export](src/modules/reports/README.md#shared-experiment-evidence-for-the-reporting-workflow).

## Security & backups

- Sessions are signed JWTs in httpOnly cookies; passwords are bcrypt-hashed;
  every mutation re-checks role and organization server-side; uploads are
  auth-gated and type/size-validated.
- Registration is OTP-based (`/register`) and restricted to the organization's
  allowed email domains (Users page). New accounts start as Technician;
  deactivated accounts cannot sign in. OTP codes are never written to logs;
  until SMTP is configured, an admin can retrieve pending codes from the Users
  page.
- **Pheno Chemicals** is a separate private row-entry portal for the two explicitly
  approved chemistry maintainers. Names/categories stay available to employees;
  SMILES, canonical definitions, structures and the audited agent export require
  fresh explicit chemistry access. Local RDKit validates and draws structures
  without an external chemistry API or LLM tokens. Open it from Profile.
  Legacy SMILES remains unchanged until an authorized row is saved. See
  [`src/modules/chemicals/README.md`](src/modules/chemicals/README.md).
- An admin can delegate the **Members** responsibility independently of roles.
  Delegates can share the registration link, approve their organization's new
  technicians and create technician accounts. Role changes, other permission
  grants, password resets, OTPs and legacy research ownership remain admin-only.
  Delegates open **Profile → Members** from a personal device. Grants are
  default-deny, checked from the database on each operation and audited.
- A **JV testing only** account has a separate `/testing` workspace
  across the organization's real experiments. Only substrate codes, JV testing
  requirements, explicit testing handoffs/photos and JV scan metrics are exposed.
  Preparation, recipes, full experiments, general files, analysis and scientific
  writes remain inaccessible even through direct routes and actions. Colleagues
  send a testing request from the JV capture stage, selecting ready substrates
  and uploading a photo. In-app delivery is transactional and idempotent; the
  existing optional DingTalk integration sends only a fixed alert after commit.
  Only testing specialists may correct overall request status (completed,
  in progress, or automatic), with a required reason and transactional audit.
  Corrections never change scientific results, apply only to the current request
  batch, and expire on a new submission. Completion notices retain the existing
  creator/assignee/member recipients and once-per-batch delivery rule.
- Approved operator provisioning uses `accounts/provisioning-service.ts`, with
  explicit organization and authorized notification recipients; it never replaces
  an existing account or claims historical research. Temporary credentials are
  encrypted with the existing credential adapter and delivered through private
  in-app notification links. Only the designated active member administrators on
  personal devices may reveal them. Temporary login expires after seven days;
  first sign-in requires a different password. Password change/reset revokes the
  encrypted handoff and invalidates older sessions. No password is stored in
  notification text, audit payloads, logs or release evidence.
- Backups: local development can use `scripts/backup.sh` and `BACKUP_DIR`.
  Production sets `BACKUP_MODE=external`; backup and restore jobs run on the
  independent PostgreSQL server, while `/system` reports that external mode
  instead of writing database dumps to the application CVM.
- Batch 2: templates/start-from-previous copy plans into new drafts without copying runs.
  Everyone can create materials and recipes; material edits by non-stewards require
  approval. Recipe creation by non-stewards is pending; creators and stewards can
  read contents, while `recipeAccess` reads approved contents only. Only
  `recipeSteward` holders (or admins) edit/approve/archive recipes. Intake and
  designer paths enforce the same boundaries. Initial manager grants require
  approved setup; the migration does not silently grant them.
- DingTalk: optional post-commit notices cover access requests, assignments,
  pending registrations, material suggestions and recipe submissions. Both a
  webhook and the approved organization's exact slug are required. Notices omit
  identities and research details; the morning digest includes aggregate counts
  and the highest valid light-scan PCE from the previous Beijing day.
  `scripts/send-morning-digest.ts` is ready for an approved 08:30 scheduler;
  scheduling and production enablement have not been performed by this buildout.
  Configuration, at-most-once digest attempts and rollback caveats are documented
  in [`deploy/README.md`](deploy/README.md).
- Ubuntu/systemd deployment, immutable releases, health checks, and rollback are
  documented in [`deploy/README.md`](deploy/README.md). The longer-term modular
  monolith and COS plan lives in [`../docs/architecture-refactor.md`](../docs/architecture-refactor.md).

## Sample ID schema

Experiments use `YYYY-ORG-USER-SEQ`; samples are `S1…Sn` within an experiment.
The app also assigns short instrument handles such as `E7-S5` and preserves
normalized aliases for existing lab naming schemes.
