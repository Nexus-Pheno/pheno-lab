# Chemical Excel uploads without the 100-row quota

Michael requested removal of the chemical-upload row quota on 2026-10-12. The parser and English/Chinese UI, Excel instructions and Bruce guide no longer enforce or describe a 100-material maximum. Existing two-column workbooks remain compatible; file size remains 2 MB.

Workbook safeguards remain separate from material count: ZIP entries/expansion and sparse worksheet allocation are bounded, physical Excel coordinates are checked, and formulas/macros/external references remain rejected. Material lookups and new record/evidence writes use 200-item chunks inside the same audited transaction. Matching an unregistered shared material preserves its identity; category binding, fresh private authorization, source-file integrity and idempotent retry remain enforced. Identical SMILES within one file reuse the locally rendered graph; each imported row retains its own private evidence and original Excel row mapping. Preview images load as they enter the viewport.

Local verification:

- Full verify passed: 235 unit tests, formatting, lint, architecture/deploy checks, TypeScript and production build.
- Guarded real PostgreSQL: 119 integration tests passed, including a 1,001-row import over multiple query/write chunks, existing-record linking, original-file read-back and idempotent replay.
- Parser regressions accept 101, 1,001 and 5,001 rows; unsafe worksheet allocation and files over 2 MB remain rejected.
- Eight affected browser tests passed, including a complete 125-row upload in English desktop/Chinese mobile views, offscreen structure loading, category/identity synchronization and private-access denial.
- Template instructions visually reviewed; updated offline guide passed eight English/Chinese desktop/mobile cases. The unchanged sheet names, two-column headers and blank upload sheet remain compatible.

Production evidence is recorded after deployment in the existing production deployment log and release-evidence directory. Release QA performs preview-only synthetic inputs; it does not import synthetic materials into production.

Production release `20261012-009` passed public/private readiness and live verification. Both approved maintainers previewed 1,001 rows using the older downloaded template. Ten EN/ZH desktop/mobile cases displayed all 125 preview rows and loaded first/last structures; four non-maintainers and anonymous access stayed denied. No synthetic production import occurred. Full Material/private-evidence/category/permission digests and experiment/sample/testing/notification counts matched preflight. The template download matched the revised workbook bytes. The original transient network-error log was redacted; temporary session and protected env-backup files were removed.
