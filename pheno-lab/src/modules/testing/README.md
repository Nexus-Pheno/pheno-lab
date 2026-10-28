# JV testing completion

`query.ts` keeps the existing testing-only DTO and authorization scope. It adds
current completion status to the unified experiment request and each historical
submission; no preparation content or capture metrics are exposed by this status.

Completion follows all currently allocated substrates in the experiment, not only
the subset selected in a handoff photo. `ERROR`, `EXTRA`, blank and unassigned
substrates are excluded. At least one eligible substrate and one submitted request
are required. Each submitted run/characterization scope must have a nonempty result
for every eligible substrate. A result from another run/card or a cancelled run
does not complete the request. Repeated submissions retain their existing history.

The pure `completion.ts` policy accepts manual or auto-filled result metrics, with
zero counting as a value and empty placeholders excluded. An instrument result
also requires its backing matched scan to still belong to the same sample/run;
ignored or reassigned scans do not leave a falsely completed request. Saving an
edited result manually sets its provenance to `MANUAL` and clears its scan source.

Automatic status is derived on read, so clearing a result, adding an
allocated substrate or changing group membership updates the label on refresh.
Reading the list/detail does not write notifications, audits or scientific data.

`completion-service.ts` emits the bilingual in-app `testing_completed` notification
to the experiment's current creator, assignee and members, deduplicated by user.
Recipients must still be active, approved, unrestricted users in the organization
who can read the experiment. The system outcome also reaches a recipient who
entered the final result themselves. The link opens authorized experiment results;
notification text contains only the experiment code, with no preparation content.

Manual saves, instrument result refreshes, testing handoffs, regrouping and applied
test plans check completion inside their write transaction. A shared experiment
advisory lock precedes other write locks in these paths. The `testing.completed`
audit receipt identifies the sorted set of submitted request IDs by its hash,
so the same batch is notified once even under concurrent saves or retries. A new
submission starts a new batch. Clearing/re-saving results does not resend the
same batch, while the displayed status still reflects current data. Notifications
and their receipt roll back together with the result/group/plan/handoff write.
Duplicate instrument uploads keep the existing 409 response and recover any
derived result transaction that failed after the raw upload was stored.

Historical completed requests show their live status on read without sending a
notification backfill. No new scheduled job or external group notice is used.

## Manual request-status correction

Only a fresh active, approved `testingOnly` user in the same organization, with
password setup complete, may correct status. Ordinary experiment creators,
assignees, members, managers and admins do not acquire this capability. The
separate `TestingStatusOverride` table stores completed/in-progress status, the
required 1–500 character reason, actor and update time; restoring automatic status
removes the override. The expand-only migration creates this optional table and
enum, leaving scientific tables unchanged and previous application code compatible.

Manual state applies to the overall experiment request, while historical submission
badges keep their automatic status. The UI labels the source, reason, update time
and underlying automatic result explicitly. No scientific records, assignments,
experiment metadata or results are changed. Read DTOs expose no extra preparation
content. Normal scientific read/write authorization remains unchanged.

The override and notifications share the existing completion advisory lock and
request-set hash. A new submitted request invalidates the old override immediately;
a stale browser carrying the earlier hash cannot mark the new batch complete.
Result updates cannot erase a valid manual correction. Manual completion and
restoring a completed automatic state use the existing recipient and receipt
rules; reapplying status to the same batch never sends another completion notice.
The correction, audit and any completion delivery commit or roll back together.

Tests cover the pure policy, real PostgreSQL scopes and regrouping, and bilingual
desktop/mobile browser states. All fixtures use synthetic data.
