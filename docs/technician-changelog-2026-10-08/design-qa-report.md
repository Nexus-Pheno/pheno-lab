# Design QA Report — October 8 technician usability update

## Project Decision

- Project: Pheno Lab; implementation and offline technician response, 2026-10-08.
- Owner brand: `pheno`.
- Product archetype: live laboratory execution, expressed through a technician report.
- Primary user: technician who supplied the October 8 feedback.
- Repeated job: understand the released changes and verify them in the laboratory.
- Dominant product object: two feedback-to-change records with actual test screenshots and acceptance steps.
- Signature composition: numbered change ledger, before/after comparison, allocation totals, screen evidence, acceptance checklist.
- Primary action: review in Chinese or English and print if useful.
- Shell mode: `document`.
- Canonical frame: standalone report exception. A workbench would obstruct reading, forwarding and printing this document.
- Architecture pattern: one self-contained offline HTML file. The production link opens only when clicked; the report submits no data.

## Application Architecture

| Pane | Role | Min/default/max | Scroll owner | Collapse mode | Persists |
|---|---|---|---|---|---|
| Document | Changes, evidence and acceptance checklist | 288px content at 320px / maximum outer width 1120px | Document | Comparisons and illustration rows stack on compact screens | Language preference when storage is available |
| Screenshot viewer | Inspect embedded screenshot at original resolution | Viewport minus 24px / natural image dimensions | Bounded viewer | Native modal overlay | None |

- Reading area receives all usable content width; no resize or multi-pane workspace controls apply.
- Body owns document scrolling. Only the optional enlarged screenshot viewer owns internal scrolling.
- Language buttons, print action and figure buttons retain usable touch targets at every viewport.
- Checklist ticks survive language changes in the open page and are not submitted or stored.
- Medium screens retain comparison columns; compact screens stack them and use two-column count summaries.
- Screenshot dialog opens, closes with Escape, and returns keyboard focus to its trigger.

## Sources Used

- Design-language files: canonical Pheno SZKL design system and `use-pheno-szkl-design/references/pheno.md`, selection matrix and relevant whitepaper sections.
- Token file: `/Users/michael/Documents/Michael Overall/Pheno SZKL Design System/tokens/pheno.tokens.json`; colors generated from this file.
- Approved logo asset ID: `pheno.wordmark.primary`.
- Approved logo: canonical `public/brand/pheno-logo.png`, embedded unchanged on white.
- Logo SHA256: `2aaecb9751e4d8f01467161bc70ddb82f4ce3ab818247a3bdd2d54bba14f5cea`.
- Web assets: approved 16/32/48 favicon images and Apple touch icon embedded. This offline report is not an installable app; no PWA manifest applies.
- Feedback: `实验系统使用便捷性优化建议（2026-10-08）.docx`, including five embedded screen images.
- Current implementation and test-environment screenshots govern change claims. The older October 5 report was retained unchanged.
- Plan-editor evidence capture temporarily expands to 1440×1800 to show the entire editor inside its parent scroll pane; interactions and save/reopen checks run at the declared browser test sizes.

## Product States

| State | Status | Evidence or note |
|---|---|---|
| Default/populated | implemented | Both implemented changes and three embedded test screenshots |
| Empty | implemented in app | Empty groups remain editable; history no-match message verified |
| Loading/syncing | implemented in app | Copy buttons disabled while a copy is pending; static report needs no loading state |
| Error/recovery | implemented in app | Copy failure message allows retry; optional unselected equipment now normalizes to absent |
| Disabled | implemented | History page controls disable at boundaries and during copy |
| Permission denied | not applicable to report | Application server permissions and picker eligibility retained; existing database authorization regression suite passed |
| Offline/partial | implemented | File works with browser offline, zero external requests; all assets embedded |
| Draft/reviewed/approved | implemented | Production release 20261008-001 and release checks complete; technician acceptance pending explicitly distinguished |

## Responsive And Language Review

| Viewport | English | Chinese | Overflow/overlap | Primary action visible | Screenshot |
|---|---|---|---|---|---|
| 1440×900 | pass | pass | none | yes | `qa/en-1440-top.png`, `qa/zh-1440-top.png` and full images |
| 1024×768 | pass | pass | none | yes | `qa/en-1024-top.png`, `qa/zh-1024-top.png` and full images |
| 390×844 | pass | pass | none | yes | `qa/en-390-top.png`, `qa/zh-390-top.png` and full images |
| 320×700 | pass | pass | none | yes | `qa/en-320-top.png`, `qa/zh-320-top.png` and full images |

All eight combinations were checked automatically for document overflow, image loading, complete translation strings, touch-target height, language switching, checklist, modal, keyboard focus and zero console errors/external requests. Representative top/full views and both four-page A4 print layouts were inspected visually. Print layouts keep the full acceptance checklist and verification section together. The visible screenshots depict synthetic test data in Chinese, explicitly labelled in both languages.

## Accessibility Review

- Keyboard focus: visible outline; screenshot focus restored on Escape.
- Controls: accessible names for language, print, screenshot view/close, and associated checkbox labels.
- Touch targets: minimum 44px button height; checklist labels enlarge the checkbox target.
- Contrast: Pheno deep green used for small signal text, ink for body, approved muted text on white; lime is a controlled border/background signal.
- No chart or status depends solely on color; status and numbers have text labels.
- Reduced-motion setting respected. No decorative animation.
- Chinese is readable without JavaScript; JavaScript enables the complete English toggle and screenshot viewer.

## Technical Verification

- `pnpm run verify`: passed format, lint (0 errors, 4 existing warnings), architecture boundaries, deployment-file checks, TypeScript, 216 unit tests in 33 files and production build.
- `pnpm run test:db:prepare`: passed on a new guarded, loopback `_test` PostgreSQL database.
- `pnpm run test:db:drift`: passed, no difference.
- `pnpm run test:integration`: 83 passed in 21 files. Includes empty-group persistence, regroup counts, concurrent moves, identity/evidence/audit preservation and existing authorization tests.
- `pnpm run e2e`: all 17 passed, including six new technician cases across desktop/tablet/phone plus existing QR, capture and template regressions.
- After improving screenshot framing, the six technician browser cases were rerun and passed. Changed test file formatting and TypeScript passed again.
- `git diff --check`: passed.
- HTML QA: 8 viewport/language combinations passed, all four displayed images loaded, no console errors or external requests. Evidence: `qa/verification.json`.
- A4 print: four pages for each language, visually reviewed. QA PDFs remain internal evidence.
- Share copy is byte-identical to the repository HTML and opens without adjacent files.
- Codex file-open request returned queued; opening is not treated as visual confirmation.

## Production Release Verification

- Michael explicitly approved production deployment and requested checking prior agents and memory. The existing deployment manual, previous deployment thread and shared project records were reviewed before publishing.
- Application PR #90 merged to main `3c8c4326bf815bf07c95c93f165153678ee26d2b`. PR and merged-main CI passed (runs 37764466234 and 37764975805).
- Production repeated the existing full build-release verification, checked the artifact checksum and deployed through the existing release script. Release `20261008-001` started at 18:49 China time on October 8, 2026.
- Current release and APP_VERSION agree; application/Nginx are active, port 3457 remains loopback-only, HTTP redirects to HTTPS, public liveness and authenticated PostgreSQL/private COS readiness passed. Previous release `20261005-001` remains available for rollback. No new migrations were pending; the existing encryption step changed zero legacy credentials.
- Before/after read-only inventory matched for 1,073 experiments, 19,583 samples, 3,877 step executions, 24,263 characterization results, 45,842 attachments and 37,719 J-V measurements. Sample identity fingerprints also matched. No scientific data migration, backfill or live edit was performed.
- Authenticated English/Chinese checks at 1440×900 and 390×844 passed: older-history search among 973 eligible records, no-match state, Escape, and all six planned groups visible including four empty groups. Zero browser errors. The browser allowed GET/HEAD and the source-verified read-only comment-list action only; no scientific write requests were sent. Temporary verification sessions were kept in memory and expired after five minutes.
- The shareable HTML now states the verified release and provides a direct system link. Screenshots remain explicitly labelled synthetic test data. Evidence is limited to aggregate counts and status; no real research screens or credentials are included.
- Release and UI evidence: `production-release-verification.json`, `production-ui-verification.json`.

## Remaining Gaps

- Technician field acceptance remains pending on the released system.
- No schema migration, historical backfill or production scientific-record edit was performed.
- Bulk assignment remains outside this update.

## Recognition Test

The experiment-group and substrate-count ledger, process inspector evidence, experimental identity preservation and technician checklist make this an evidence-led Pheno laboratory report even without its logo. Green marks allocation and verified work; it does not wash the page or imply production approval.
