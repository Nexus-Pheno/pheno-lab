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

## Preset visibility and publication

The Library's Presets section separates public presets, the current user's personal
presets, and publication reviews. Managers/admins create, edit and delete public
presets. Technicians save personal presets from the workflow designer and can edit,
delete and apply only their own personal copies. Both process-step and characterization
presets follow these rules. Public deletion never changes settings already copied into
an experiment.

Technicians submit an immutable personal snapshot for manager/admin review. Approval
creates a public preset or replaces its linked public version; rejection requires a
note and keeps the public version unchanged. Editing or deleting a pending personal
copy withdraws that submission. Editing an approved personal copy leaves the old public
version available until another approval. Deleting a personal copy preserves the public
version and its review history. The original author can open a new personal revision
from the public list. Review requests and decisions create in-app notifications and
transactional audit events.

Personal presets and review snapshots use separate tables; existing `Preset` rows
remain public. The additive `20261124000000_preset_publication` migration does not
reclassify historical presets or rewrite experiment settings. Designer, capture-choice
and Library reads include personal presets only for their owner; delegated research
readers continue to read public presets only. Concurrent writes use version checks and
an organization-scoped transaction lock. If a public configuration changes after a
revision was submitted, approval fails; reject the obsolete request or edit and resubmit
the personal copy after checking the new public settings.

Reverting application code does not remove these new tables or their data. Older code
continues to read the unchanged public table; private drafts remain stored separately.
Apply this migration in production only as part of an explicitly authorized release.

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

Prompt version 5 and the panel use a result-first reading order: observed result
and practical judgment, the concrete question that could change that judgment,
then the next controlled experiment. Short separate sentences replace combined
result/caveat/disclaimer clauses. General methods are not repeated per group;
the recorded purpose and generation details are available once in the panel's
collapsed context section. Important local limitations stay with the relevant
decision, and possible mechanisms remain distinct from observations. Draft,
stale-source and researcher-review controls remain visible. This is a writing
contract, not a ban on uncertainty words or a relaxation of evidence checks.

The prompt uses natural metric names, restricts a proposed test's expected
outcome to the factors it actually changes or measures, and treats a failed
repeat as a result not reproduced rather than proof of its cause. The payload
explicitly distinguishes privacy-withheld details from an explicit source
status reporting absent records. The privacy projection is unchanged. A small
English-prose check rejects stray Chinese text through the existing generation
failure path, preserving the earlier summary without retrying or approving it.
Exact supplied material, condition or group names may appear quoted in English;
group IDs themselves are excluded from the prose check. This lexical check is
not a translation-quality or scientific-validity certification. Outcome branches
must judge mean, highest PCE and device spread separately: loss of a mean benefit
does not establish loss of the highest-device signal. A failed common-solvent
material comparison applies to that common context; original material–solvent
interactions and preparation differences remain unresolved. Bilingual examples
and a final field-by-field self-check reinforce those limits without changing
the schema, failure guard or researcher-review requirement.

The existing organization provider receives a reduced, privacy-filtered payload.
Private molecular notation and full formulation payloads are withheld. Weekly
reporting reads the same deterministic evidence and may reuse only a current,
reviewed interpretation using the same comparison selection; it still requires
independent numerical, scientific and privacy review. See the read-only operator
[evidence export](src/modules/reports/README.md#shared-experiment-evidence-for-the-reporting-workflow).

## DOE test plans

Applying a test plan resolves each variable to its process, selected equipment
and device layer together. Configured steps in another scope are preserved;
a uniquely compatible unassigned step may be completed, or a missing scoped
step is added. Multiple matches or duplicate parameter targets reject the whole
application and keep the editor draft. Reapplying/moving variables reconciles
old variations within their previous scope in the same audited transaction.
Replacing populated values (including removal of old grouped/material parameters)
requires an authorized, server-generated difference preview and explicit confirmation.
The dialog identifies the step, equipment, layer, and current/proposed group values;
cancelling retains the draft. Consent is tied to the actor, plan and locked flow
snapshot. Intervening edits refresh the preview and require renewed consent.
Unchanged values and new/empty targets do not prompt for an overwrite. Preview
requests roll back all provisional writes, including missing scoped steps.

## Read-only research access for external agents

An organization administrator can open **Profile → Research agent access** on a personal device, download the standalone Python 3.9+ client, and issue a named key for 1, 7 or 30 days. Supply the script to Codex, Claude Code or another shell-capable agent. Configure its key separately on an approved research machine. Research access includes proprietary recipes and the contents of scientific attachments. Select **Include published reports** or **Include private molecular definitions** only when that workspace is approved to receive them. Each requires the issuer's existing grant. Credentials for the browser, database, instrument bridge and storage stay with their original systems.

```sh
python3 pheno_lab.py configure
python3 pheno_lab.py catalog
python3 pheno_lab.py list experiments --all --out experiments.jsonl
python3 pheno_lab.py list results --experiment EXPERIMENT_ID --all
python3 pheno_lab.py get evidence EXPERIMENT_ID
python3 pheno_lab.py get report REPORT_ID --out report.html
```

For unattended use, inject `PHENO_LAB_TOKEN` with a secret manager or point `PHENO_LAB_TOKEN_FILE` at an owner-only key file. Provide the script and the research question in the agent prompt. Keep the key out of prompts and version control. Revoking a key stops subsequent reads. Data already downloaded stays in the recipient's workspace.

The same interface accepts authenticated `GET /api/research/v1` requests with an `Authorization: Bearer …` header. `resource=catalog` lists the available collections and detail requests. Collections use `limit` (1–100) and `after`; pass back `nextCursor` until it is null. Search experiments by name or code with `--q`; the same filter searches names in the material, project and recipe collections and both report titles. Use `experiment` to narrow experiment-linked collections to an exact experiment ID. Use `resource=evidence|report|curve|attachment|original&id=…` for individual records. Attachment and original downloads require an explicit local output file. Reports return the complete published HTML.

The client reads live pages. Record IDs, request timestamps and evidence source hashes with your analysis. Use `evidence` for the app's accepted-device comparison. Use `results`, `scans` and `curve` to inspect captured records and individual sweeps; multiple sweeps can belong to one physical device. Join `steps` (planned settings), `executions` (captured actuals), `runs` and `samples` by their IDs. Record run status and distinguish draft interpretations from measured results. The catalog covers real research and excludes recycled/test experiments. The API supplies research data only; it exposes no account-management, messaging, arbitrary-query or write commands.

## One-off characterization records

Authorized members open **Characterizations** from the navigation or their profile. Search a method by its Chinese or English name or acronym. Choose library materials or describe an unregistered material in the notes. An optional measurement date records when the measurement happened. The server records the upload date separately. Save multiple originals, including native instrument formats, spreadsheets, images and ZIP folders. Each file travels in verifiable 2 MiB parts and can be just under 2 GiB. Interrupted uploads remain private drafts and can resume from the portal with the original files. Saved records retain the original notes. AI extraction is labelled separately and can be retried.

The research reader has a separate opt-in key scope for these records. With a scoped key, use `python3 pheno_lab.py list filmStudies --q KPFM` or `python3 pheno_lab.py get filmStudyFile FILE_ID --out original.spm`. For a local MCP client configure a stdio server with command `python3` and arguments `["/absolute/path/to/pheno_lab.py", "mcp"]`. The same private reader key is used. Tools search by method, material, notes or file name and download verified originals to a private local folder. File formats are retained as supplied; an instrument-specific decoder may be needed. See the [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

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

A copied experiment can resize its substrate batch while it is still an
unstarted draft. Copy provenance is checked against the audit trail, not its
title. Any run, characterization result, JV measurement, testing request or
recorded transition out of draft disables this exception. Changing the count
replaces only that copy's provisional sample batch, returns all substrates to
Extras and issues new QR IDs, short handles and simulator codes. The original
experiment, plan variables and group settings remain intact. Reapplying the
same count preserves identities and allows grouping as usual.

Print replacement labels after resizing. Old simulator-code reservations remain
occupied, and old QR IDs no longer resolve. Since the full experiment code plus
an S-number cannot distinguish the retired batch from the replacement, automatic
instrument matching rejects that form for a rebuilt batch; use the new simulator
codes. Other experiments retain their existing matching behavior. Resizing and
its audit event commit together; no production data backfill is needed.

每周科研报告使用后台运行脚本。生产排程、归档恢复、五位接收人的复核和切换步骤见 [部署手册](deploy/README.md#每周研发报告独立于-mac-的服务端任务)。

The release checks include `pnpm run test:weekly-report` (Python 3.11+ and the bundled RDKit). These offline tests cover evidence selection, scientific checks, rendering and delivery safeguards.
