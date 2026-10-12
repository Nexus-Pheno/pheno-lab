# Private lab reports

`LabReport` is an immutable, organization-scoped publication. The list exposes only bilingual titles, ID and generation date to regular full-access members. Reading the HTML requires a fresh explicit `User.reportAccess` grant and a current ADMIN or MANAGER role; administrators have no implicit bypass. Setup-required, testing-only, inactive, pending, and foreign-organization accounts cannot read content. Testing-only accounts cannot list reports.

The operator-only `publishLabReport` service validates approved recipients and writes the complete HTML through the existing private storage adapter. Its transaction grants designated recipients, creates one in-app notice per recipient (including the requester), and records audits. An organization/publication key is serialized and idempotent; conflicting content is rejected. Storage cleanup removes only a newly created, unreferenced object after rollback, preserving it if commit state is unknown. There is no public upload or publication endpoint.

The dedicated content handler verifies scope, current permission, byte length and SHA-256 before returning HTML. Responses are private/no-store. Exact inline script/style hashes and an opaque-origin CSP/iframe sandbox permit the bilingual report controls without app-origin access or network dependencies. External reference links open only after an explicit reader click. Generic attachment routes do not authorize report objects.

## Approved operator publication

Use the existing runtime environment, storage configuration and deployed source. Supply a reviewed JSON document through stdin to `NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/publish-lab-report.ts`; do not stage confidential report content in source/release directories or add another environment file. Required fields: `organizationId`, `publicationKey`, `titleEn`, `titleZh`, ISO `generatedAt`, complete `html`, approved `recipientIds`, and a non-secret `authorizationReference`. Reuse the same key and identical document after an uncertain outcome. Different content requires a new publication key and explicit publication authorization.

This module distributes finished reports. Automated scientific calculations, scheduled generation and experimental execution are not introduced by this feature. Scientific report content and raw inputs remain outside Git.
