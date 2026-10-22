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

Status is derived on read rather than persisted, so clearing a result, adding an
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
notification backfill. No new scheduled job, external group notice, migration or
production data change is required by this code.

Tests cover the pure policy, real PostgreSQL scopes and regrouping, and bilingual
desktop/mobile browser states. All fixtures use synthetic data.
