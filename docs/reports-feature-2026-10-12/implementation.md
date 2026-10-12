# Reports section / 报告功能

Requested on 2026-10-12: a bilingual material/process analysis report, a separate report list with generation dates, complete report viewer, and in-app notifications to four designated managers. Regular organization members see locked catalogue metadata; complete content requires an explicit manager grant. The existing testing-only account boundary is retained.

The feature uses the current Next.js modular monolith, existing private COS adapter, organization scope and transactional audits. The additive migration creates an immutable report metadata table and a default-false user grant. Existing scientific tables and roles are unchanged. The viewer uses private/no-store responses, integrity checks, hashed inline assets and an opaque-origin sandbox.

报告列表显示标题和生成日期；普通成员看到锁定提示，完整内容仅限明确获授权的管理人员。现有测试专用账号仍仅限测试流程。报告使用现有私有对象存储、组织隔离及事务审计，完整 HTML 通过隔离查看器呈现。

Local verification: full `pnpm run verify`, guarded database prepare/drift and 99 integration tests, 23 browser tests. Local PostgreSQL is 17.10; CI uses the repository's PostgreSQL 18 test service. Production release/publication status must be recorded only after live verification.

The scientific report is a confidential derived artifact stored outside Git. Its calculations distinguish sample and batch replication, primary reverse scans, current ERROR/EXTRA exclusions and descriptive associations. The report does not claim a validated causal/predictive model, stability findings or certified efficiency.
