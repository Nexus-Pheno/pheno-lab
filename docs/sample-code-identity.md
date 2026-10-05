# Permanent sample codes — September 30 feedback revision

Michael approved implementation, GitHub publication and server deployment on October 5, 2026.
Historical relabeling and measurement ownership corrections remain separate review items.

## Behavior

- Issue a simulator code once. Reassigning staff, changing team order, completing or archiving an experiment never changes it.
- New experiment prefixes retain the original issuer's full employee number and use A–Z, AA–AZ, BA, etc. Never wrap employee numbers with modulo 100 and never fall back to an occupied Z.
- Codes may exceed five characters: `23AA01` and `123AA100` are valid. The substrate editor supports the existing server limit of 198.
- Preserve existing sample IDs, notes, serial aliases, executions, manual/instrument results and printed QR destinations when applying a plan. Update groups in place and add new physical samples separately.
- Do not shrink away issued samples or samples with recorded work. Keep the batch and place unused samples in Extras or Trash / problem.
- Store substrate count, material and assignments alongside groups/variables so reopening the plan preserves its layout.

## Reservations and legacy compatibility

`SampleCodeReservation` is an append-only organization-scoped ledger. Canonical PREFIX and SAMPLE keys prevent case/zero-padding collisions and remain after experiment/sample purge. Allocation uses the organization row lock inside an interactive transaction plus the ledger primary key. No production env/service/storage changes are needed.

The expand-only migrations create a nullable experiment prefix and a new ledger. They copy available simulator-shaped codes from every historical sample, alias and scan into reservations, without changing labels or measurement associations. Where existing samples or previously linked scans claim the same code for different samples, a safety marker blocks automatic future matching. Existing matched scans stay attached; ambiguous delayed uploads require explicit manual review.

A legacy experiment keeps its existing labels. If it lacks a stored immutable prefix, newly added samples receive a fresh reserved prefix; old samples are not renumbered to force consistency. Codes removed before all surviving records/audits were created cannot be reconstructed from absent evidence.

An alias edit cannot remove the permanent simulator code or transfer an already reserved code to another sample. Full experiment/sample serials and the existing stable E-number aliases remain supported.

Both GiantForce and LightSky fixture exports cover expanded labels; LightSky's full-serial/summary-code fallback supports multi-letter prefixes. This verifies parser and matching compatibility, not a physical operator trial on the two instruments.

## Verification and operations

Run the repository verify, schema drift, PostgreSQL integration and browser E2E gates. Dedicated sample-identity coverage includes staff changes, grouping, manual captures/results, late uploads, concurrent allocation, AA/100+ codes, purge/restore, canonical collisions and organization isolation.

Read-only production inventory:

```bash
# Use the existing production environment, with no credential output.
node --conditions=react-server node_modules/tsx/dist/cli.mjs scripts/audit-sample-identities.ts
```

Deploy through the existing `deploy/README.md` release flow after merging green CI to main. Both migrations are additive and retain compatibility with the previous release. During the migration/code-switch window, stop the existing Web service so the previous allocator cannot issue codes after the historical snapshot. The existing deploy script restarts it; no new service/config is introduced. Confirm authenticated readiness, release version, HTTPS and label/scan pages.

Do not guess a historical scan's rightful experiment, rewrite issued labels or run bulk repair as part of deployment. The October 5 pre-release audit found 183 distinct currently duplicated codes and 48 historical serials linked to multiple samples; these are pre-release observations, not a post-release acceptance claim.
