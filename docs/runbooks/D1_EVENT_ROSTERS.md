# Reviewed future event rosters

Migration `0014_future_event_rosters.sql` adds an explicit future-event policy and
a coalesced refresh queue. It does not change production or delete existing
rosters, attendance, excusals, corrections or imported evidence.

## Operational rules

The existing Attendance Forms exclude the Flight named Abroad from Mando PT,
Secondary PT and LLAB (`src/services/forms.ts`). Crosstown Mando branching changes
who submits the report, rather than the eligible Flight roster. Other events keep
the operator's explicit Flight selection. The D1 planner follows those rules.

New verified Directory respondents activate automatically. A relevant profile or
Flight change queues only enabled, active events whose start is still in the
future and whose selected Flight scope intersects the affected Flights. Changes
to phone, photo and other unrelated contact fields do not rebuild event rosters.
The same queue helper supports catalog changes. Cadets do not need individual
approval after an operator has approved the event's current-membership policy.

The refresh captures current active membership, name, AS year, Flight Path status
and birthday into a new event-roster version. Previous versions and all facts stay
intact. A removal with existing evidence is visible in the preview and audit; the
evidence remains available for reporting review. The policy stores the selected
Flight scope separately from the current operational scope, so a selected Flight
excluded as Abroad is not forgotten if its label later changes.

Started, undated and inactive events cannot be automatically rebased. This also
means a Secondary PT week that has already begun retains its original capture.
Changing an old event's date to a future date does not make its old capture safe to
replace. Ordinary event edits recapture current membership only when both the
original and proposed event start remain future; historical event edits retain
previous captured identity.

## Operator workflow

Use the existing signed bridge protocol and an actual authenticated principal
with current Wing `events.manage`. Read previews may run while D1 is paused;
apply/refresh additionally require command intake and a registered source.

1. Read the coherent frontend catalog and call the pure
   `prepareEventUpsert(snapshot,event,{flightIds},now)` helper from
   `packages/domain/src/event-rosters.ts` to create or edit an event. It derives
   eligible cadet IDs; the operator supplies selected Flights and event details.
   Submit the returned payload through the existing audited `event.upsert` path.
2. For an imported or manually created future event, POST
   `{environment,generation,principalId,eventId,mode:'enable'}` to
   `/v1/admin/event-rosters/preview`. Review its exact before/after capture,
   selected/operational Flights, additions, removals, transfers and evidence
   warnings. This approves the future current-membership policy.
3. Pass the saved preview and exact operator/source identity to
   `eventRosterPreviewCommand(preview,identity)`. Submit the resulting standard
   envelope to `/v1/admin/event-rosters/apply` or `/v1/admin/commands`.
   The payload contains only `eventId`, `mode`, `basisAt` and `previewHash`;
   callers cannot substitute an unchecked membership list.
4. A preview expires after 15 minutes. Semantic changes to its event, roster,
   policy, pending cause or evidence warnings require a fresh preview. Unrelated
   accepted commands do not invalidate a batch of independent event reviews;
   each apply still guards the latest read revisions atomically.
5. Subsequent enrollments/transfers refresh automatically. `mode:'refresh'` can
   review one enabled event explicitly. `mode:'disable'` stops its policy and
   clears retained work without changing its captured roster or history.

Receipts are idempotent, source identities are unique, and all writes, required
audit entries and publication effects commit together. An audit failure or stale
transaction rolls back everything. Automatic audit entries name the real
configured service principal with `policy-automation` evidence and retain the
approving policy plus the initiating Directory/catalog command; they never
attribute an automatic action to an invented human editor.

## Native scheduling and recovery

Enable optional `rosterRefreshEnabled: true` in the reviewed private maintenance
binding, grant its configured principal Wing `events.manage`, register its sheet
source, and resume maintenance **before enabling event policies**. The flag
otherwise defaults to false. Existing private state/archive ownership checks and
pause controls apply. No new trigger, provider service or billing is required.

The existing scheduler calls `/v1/admin/event-rosters/refresh` after Form intake
and before spreadsheet/Form publication. Each Worker request refreshes one event;
one native pass stops after ten events. Continued work returns
`waiting-event-rosters`, retains the hourly reconciliation marker and defers
publication and native input replay. Pending events also reject fresh attendance
and excusal intake. Snapshot publication is fenced, preventing new Form choices
from advertising eligibility against an older capture. Already accepted command
receipts remain replayable.

If an event starts before its queued work completes, the service returns
`review-required`. Inspect its saved scope and prior capture. To preserve the
started event, use a reviewed disable preview/apply; do not alter its timestamp
just to force an automatic refresh. Then review any affected accepted evidence
through normal correction workflows. Revoked service authority or source access
stops writes. Pauses retain all queue entries for a later invocation.

The policy bounds are 50 selected Flights, 500 members and 200 queued events.
Queries read one event's membership and evidence IDs, not the attendance matrix.
A local refresh measured 25 prepared statements; this is not a hosted CPU or
Google quota measurement. Local tests cover enrollment, transfer, stale previews,
several reviewed event enables, Abroad rename recovery, audit rollback,
concurrent receipt replay, revoked authority, native ten-event bounds and
publication deferral. An integrated fixture pairs a refreshed native Form edition
with D1 attendance, the visible matrix and automatic missing-report closeout.
Hosted real-data and ordinary-account rehearsals remain separate release gates.
