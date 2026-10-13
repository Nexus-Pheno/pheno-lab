# Editable chemical upload review and 5 MB workbooks

Michael requested editing and selecting/removing uploaded rows on the review page before import, and increasing the XLSX upload limit from 2 MB to 5 MB, on 2026-10-13.

Names and SMILES are editable in the preview. Row checkboxes, Select all, Remove selected and Reset review operate only on the draft. Editing SMILES clears its old graph; Validate changes regenerates graphs and checks all remaining rows before Import becomes available. Category changes preserve the draft and require revalidation. Empty drafts cannot be imported. Committed previews are read-only; later changes use the existing material editor.

The source workbook remains byte-for-byte intact. The private immutable import manifest retains original Excel row numbers, the reviewed input values and one bounded edit/exclusion plan. Source/category/review digests bind confirmation and idempotent replay. Original no-edit clients and batch manifests remain compatible. Unknown, duplicated or overlapping source-row references are rejected. Audit payloads contain only counts and hashes, without SMILES.

The file limit is 5 MiB (displayed as 5 MB), with bounded ZIP entry size, expansion and worksheet allocation. There is no material-row quota. The existing multipart endpoint additionally bounds review JSON; no new proxy configuration or environment variable is required. Existing server authorization, source/image readback, atomic transaction, audit rollback and shared-library identity checks remain active.

Local verification passed:

- Full repository verify: formatting, lint, architecture/deployment boundaries, TypeScript, 239 unit tests and production build.
- 121 guarded real-PostgreSQL integration tests, including corrected/excluded rows, unchanged existing records, linking without duplicates, immutable source readback, stale/forged review rejection, exact replay, legacy replay and rollback on audit failure.
- Nine affected Chromium browser tests, including a valid XLSX larger than 2 MB, editing/removing/revalidating and importing the remaining rows, downloading the unchanged source, category changes that retain edits, and English/Chinese Select all/remove/reset behavior at desktop/tablet/phone widths.
- Workbook parsing accepts 101/1,001/5,001 rows and a native XLSX above 2 MB; files above 5 MiB and unsafe workbook structures are rejected.
- Revised blank template instructions were rendered and visually inspected. The offline bilingual Bruce guide passed eight viewport cases. The compatible sheet names and two-column headers are unchanged.

Production evidence will be appended only after the canonical release and preview-only live verification. Synthetic materials are imported only into the protected test database, never production. Human acceptance is separate from these checks.
