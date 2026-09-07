# Approved roadmap progress — 2026-09-07

This is a development checklist, not deployment authorization or a replacement deployment manual.
The original roadmap is `Pheno-Lab-Roadmap-Plan-20260907.html` at the workspace root.
The later approved conversation decisions expand Batch 2 to include P1 and P2; the historical HTML's older batch grouping does not override them. Earlier feature, ingestion and production history was reviewed to preserve completed work rather than repeat it.

## Batch 2 scope and decisions

- F1: A4 21-up QR sample labels and scan-to-capture. Already merged before this continuation.
- F5: template gallery / start from previous. Existing PR #61 passed CI; its changes are incorporated into the expanded Batch 2 changeset. Do not merge the overlapping PR separately after shipping this changeset.
- P1: anyone creates materials, including the designer popup. Non-stewards suggest edits to existing materials; only a materialAdmin steward can apply them. Stewards edit directly and control categories/archiving. Keep the checkbox; managers are the approved initial stewards.
- P2: add a recipeSteward checkbox. Everyone can create recipes; non-steward creations require approval. Only stewards edit/approve. The creator and stewards can always see contents; recipeAccess holders can see approved contents. Names are visible to the organization. Keep viewing and editing grants separate.
- F3: DingTalk push and an 08:30 morning digest. The group belongs to Pheno 现象创新. Organization-scoped post-commit notices and an aggregate-only digest are implemented locally. Missing webhook or organization slug disables automatic delivery. Digest attempts are at most once per organization/Beijing day, not guaranteed delivery.

## Local implementation and release gates

- P1/P2 services, UI, notifications, intake/designer permission paths and PostgreSQL transaction tests are implemented. Stale material suggestions cannot overwrite newer facts; approvals have transactional audits and in-app notifications.
- F3 integration and digest tests pass against isolated PostgreSQL with only the outbound adapter mocked. No real DingTalk message or supplied webhook is used by verification.
- Local checks pass: `pnpm run verify` (format, lint, architecture, deployment-file checks, TypeScript, 168 unit tests, production-mode Next.js build), 34 PostgreSQL integration tests, 10 Playwright tests, schema drift and `git diff --check`. Browser coverage includes material suggestion/approval, recipe creation/read-only/approval, template-to-draft and existing capture/login flows. Desktop/mobile screenshots were inspected.
- These are pre-release local results on macOS, Node 26.0.0 and PostgreSQL 17.10; the repository's Linux/Node 24/PostgreSQL 18 CI and Linux release artifact still require verification before release. Five pre-existing ESLint warnings remain. The only migrations executed during local verification were on a guarded disposable `_test` database. Verification did not send real group messages or change production.
- Commit and deployment were explicitly requested on 2026-09-07. The release still requires green CI and the existing deployment manual. Initial steward grants, secrets and scheduling retain their separate approval boundaries; a release does not imply they have been activated.
- Read the Batch 2 section in `pheno-lab/deploy/README.md` before release: it includes the two additive migrations, explicit Pheno organization configuration, 08:30 scheduling, best-effort delivery and the permission-semantic risk of rolling pending recipes back to an older application. F1's physical label-paper/camera checks are not claimed by this continuation.

## Other batches (not lost)

Batch 1 was reported shipped by the previous session: rollback anchor, COS database backups, watchdog/email alerts, rematch scheduling, and equipment/facilities grant tightening. This continuation has not independently re-verified the production backup artifacts.

### Batch 3 — quality and self-service

- R4: reliable integration-test infrastructure and CI. Reassess the remaining gap first: Batch 2 now has real PostgreSQL coverage and the existing CI already provisions PostgreSQL 18. Do not create a second test stack merely because the historical roadmap predates these checks.
- R5: password reset using the existing OTP and SMTP infrastructure, with anti-enumeration, rate limits and audit coverage; include the proposed administrator reset entry point in the behavior review.
- F4: experiment comments and @mentions, with experiment membership/access checks and in-app notifications; group delivery must preserve the approved organization and disclosure rules.
- P1 was originally grouped here but was explicitly moved into Batch 2; do not implement it twice.

### Batch 4 — aging, stability and trends

- F2: review sample exports from the double-85, thermal-cycling and UV testers with the operators before building the aging/stability model. Design linked samples/devices, test conditions, periodic measurements and T80/T90 curves first, then obtain design approval.
- F6: laboratory/campaign trends and weekly comparisons alongside this work when sufficient data exists; do not invent missing scientific measurements or reinterpret efficiency metrics.

### No formal Batch 5

The approved handoff defines no numbered Batch 5. Deferred, trigger-driven ideas include R6 save-retry buffering after actual tablet/Wi-Fi failure evidence, plus global search, version history and stock inventory when needed. P2 was also advanced into Batch 2 and is no longer a deferred item.

Preserve the existing archive staging; do not repeat production bootstrap, import, or grant changes as a side effect of development.
