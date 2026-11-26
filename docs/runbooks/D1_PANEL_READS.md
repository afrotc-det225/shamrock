# Scoped administration panel reads

The isolated Worker provides `POST /v1/admin/panel/page` for the new administration
panel. This is a separate read policy. It does not change current spreadsheet
sharing, Leadership's Wing-wide Attendance permissions, the Google publisher, or
Blue/Gold approval authority. No migration or provider permission change is
required to deploy the routes. Explicit panel commands use the existing audited
D1 mutation flows.

## Authority and server integration

The panel server signs this route using the existing bridge and supplies the
principal mapped from its verified Google session. Never accept a principal ID,
Flight list, role, `fullSnapshot` flag or decision permission from browser JSON.
The bridge signature authenticates that server; it is not independent evidence of
the human account. Use the existing verified identity binding.

The Worker obtains panel scope from current trusted Directory/Leadership
membership, named account bindings and the Flight/Squadron catalog:

- A Flight Commander or Deputy Flight Commander reads the assigned Flight. A
  Directory assignment must agree with its exact canonical Flight role. A manual
  trusted Leadership contact must name one unambiguous Flight. Inactive contacts,
  source/version drift and ambiguous catalog labels fail closed.
- A recognized Blue/Gold Squadron Commander reads their current Flights and any
  retained request they remain authorized to decide. The latter includes a
  request captured for their Squadron before a Flight moved elsewhere. Duplicate
  Squadron commanders receive no derived decision scope.
- Explicit Flight `frontend.read` grants remain scoped read grants. Neither
  explicit nor derived `attendance.report` grants establish panel read access.
  This prevents an attendance submitter from acquiring access to excuse reasons.
- Explicit Wing `frontend.read` allows the existing complete administration read
  flow. An active explicit permission manager also qualifies if the principal
  currently has Wing `frontend.read`. Permission-manager authority alone does
  not manufacture a data-read grant.
- An explicit `excusal.decide` grant permits only the requests authorized by that
  grant unless another source establishes wider read scope.

The returned `access.capabilities.fullSnapshot` controls whether the panel server
may use its existing full snapshot/catalog flow. A scoped session must stay on
the panel route. **Enforce this in the server proxy, not just in the browser.**
Existing `/v1/admin/snapshot/page`, `/v1/admin/snapshot`, catalog and history
readers intentionally retain their broader spreadsheet/administrative authority;
they are not a fallback for a scoped panel session. Never return a whole Wing
snapshot and filter it in client JavaScript. UI integration must test that a
scoped session cannot request an alternate full-data route.

`requests[].canDecide` uses the same SQL authorization predicate as
`excusal.decide`: explicit decision grants retain their explicit Flight scope;
derived Squadron commanders use the request's captured Squadron. Flight
command never implies approval. These flags describe current authority, not a
promise of command acceptance; the existing command route still checks identity,
current grants, version, source and all operational preconditions.

## Bounded read contract

Each signed JSON request has exactly these fields:

```json
{
  "environment": "staging",
  "generation": 1,
  "principalId": "verified-session-principal",
  "section": "manifest",
  "offset": 0,
  "revision": null
}
```

All responses have:

```text
contractVersion: "panel-pages-v1"
environment: "local" | "staging"
generation: number
section: requested section
revision: { operations, administration, access }
scope: { termId, currentTermId }
access: {
  mode: "wing" | "scoped",
  flightIds: string[],
  capabilities: {
    fullSnapshot: boolean,
    attendanceReportFlightIds: string[],
    attendanceCorrectionFlightIds: string[]
  }
}
```

`revision.access` is a SHA-256 fingerprint bound to the principal, current
authority evidence, permission policy, catalog and term. It does not expose the
underlying named email bindings. A `manifest` adds `sections: [{section,count}]`.
For each data section, begin at offset zero with the **entire** manifest revision,
then follow `nextOffset` until null. A data page adds `{offset,nextOffset,rows}`.
Finish with `section:"verify"`, offset zero and the same revision; it returns
`verified:true`. Check response contract, scope, revision, section, counts and
offsets before replacing the displayed state. Preserve unsent drafts separately.

`409 SNAPSHOT_CHANGED` invalidates the whole read. Fetch a new manifest and retry
within a bounded budget. `403 NOT_AUTHORIZED` removes the session's operational
view. Role, assignment, named-account, grant, manager or catalog changes invalidate
paging even when there is no new operational audit row. The Worker reads authority
again in the same D1 transaction as each data page and discards the result if it
changed after scope resolution. Reads work while command intake is paused; they
never enable processing. Active imports or pending event-roster refreshes fail
closed rather than returning a partial state.

Sections, in manifest order:

| Section | Returned information |
| --- | --- |
| `people` | Active current members of scoped Flights: `personId`, profile `version`, `flightId`, `lastName`, `firstName`, `rank`, `asYear`, `flightPathStatus` |
| `flights` | Scoped Flight ID/label, current Squadron ID and roster version |
| `squadrons` | Squadron ID/label for scoped Flights or visible retained requests |
| `terms` | Current term ID, label, sort order and current marker |
| `events` | Current-term event/version, type, week, labels, expected group, status, schedule/location and roster-presence marker; no private notes |
| `eventRosters` | Current event-roster pairs for scoped people |
| `eventFlights` | Current-term event/Flight pairs within scope |
| `observations`, `corrections`, `legacyBaselines` | Existing ordered attendance-fact shapes restricted to scoped people and events |
| `requests` | Visible request/version, event/person/Flight IDs, display name, captured scope, existing ordered status/outcome fields, submitted/updated/decided timestamps, request/decision reasons and `canDecide` |

Requests are visible when they belong to a scoped Flight, concern a current
member of that Flight, or the caller can decide them. A retained request concerning
someone outside today's roster supplies only `personDisplayName`; it does not
expose that person's Directory record or other Attendance. `requests` omits
submitter/decider principal IDs. People omit emails, phone numbers, birthdays,
photos, addresses and unrelated Directory fields. There is no Leadership contact
section. Scoped Events include assigned events and events referenced by visible
requests. No client-provided scope or term selector is accepted.

The pure helpers in `packages/domain/src/panel-read.ts` provide the tested
conversion for the panel. `assemblePanelSnapshotPages(manifest,pages,verified)`
checks page identity/order/counts, attaches event eligibility, derives Attendance
pair versions and returns a `PanelSnapshot` with `contractVersion:"panel-snapshot-v1"`.
It retains the minimal display fields, raw attendance facts, `requests[].canDecide`,
`scope`, `access`, `environment`, `generation` and complete revision. It does not
create private Directory fields or a Leadership list. Use `personDisplayName`
when a retained request concerns a person outside the current scoped roster.

To calculate the same Overall/LLAB credit and cell precedence as Sheets:

```ts
const snapshot = assemblePanelSnapshotPages(manifest, pages, verified);
const reporting = buildFrontendReporting(
  panelSnapshotToReportingInput(snapshot, detachmentCalendarDate)
);
```

`buildFrontendReporting` comes from `packages/domain/src/frontend-reporting.ts`.
The conversion supplies null birthdays to this calculation input as an explicit
redaction; the panel does not gain Birthday data. Request-only people remain in
the queue but are excluded from Attendance calculations. Events needed by scoped
people's current-term roster or evidence are retained after a Flight assignment
change, even if the event's Flight list belongs to their former Flight.

This is not a complete `FrontendSnapshot` for the existing Google publisher or
`snapshotToFrontendReportingInput`. Use the panel helper rather than casting or
filling missing private profile fields. This contract covers the active term and its active
roster. Full historical administration remains on the explicit full-read flow;
scoped historical roster authority needs its own reviewed contract before use.

## Targeted authorization and atomic panel commands

`POST /v1/admin/panel/authorize` avoids downloading a manifest or request pages to
check one proposed action. The signed server request has exactly
`{environment,generation,principalId,operation,target}`. Only these operations and
target shapes are accepted:

| Operation | Target | Successful `current` fields |
| --- | --- | --- |
| `excusal.decide` | `{requestId}` | `expectedVersion`, `status`, `requestedOutcome`, `reason`, `decisionReason` |
| `attendance.correct` | `{personId,eventId}` | `expectedBaseVersion`, `expectedEventVersion`, `flightId` |

The successful response is
`{contractVersion:"panel-authorization-v1",environment,generation,allowed:true,operation,target,current}`.
The exported domain type is `PanelAuthorization`. Unknown, unrelated or
unauthorized targets return `403 NOT_AUTHORIZED` without target data. The
decision response omits actor identities, source payloads and unrelated profile
information. A permission change during the read returns `409 SNAPSHOT_CHANGED`.
Intake may be paused while this read succeeds; `allowed` establishes current
panel scope and capability only, not complete command validation or future
acceptance.

Use `POST /v1/admin/panel/commands` for scoped panel applies and exact replay. It
accepts the existing complete `excusal.decide` or `attendance.correct` command
envelope and returns the ordinary command receipt envelope. Decision results are
restricted to `{requestId,version,status,decision}`; saved source payloads and
submitter/decider identities are never exposed by this scoped route. Correction
results retain `{personId,eventId,version,code}`. The server supplies the
verified actor and registered source. No caller-supplied guard, Flight scope,
permission result or new operation family is accepted.

The Worker resolves panel authority again internally, captures its trusted
source state and attaches a server-created SQL predicate to the existing core
transaction assertion. That predicate checks the captured authority sources and
the exact target scope **inside the mutation transaction**. Receipt reads also
evaluate it in the same SQL snapshot as the receipt, including ambiguous-write
retries. A Flight assignment change between preflight and commit therefore
rejects the panel correction even when the actor intentionally retains their
broader Wing spreadsheet correction grant. The ordinary Sheets/core routes keep
their existing behavior. No new grants or persistent permission tables are
introduced.

Scoped corrections require the person's active current Flight and the captured
event-roster Flight to be among the caller's correction Flights. A member's
older attendance may remain visible after a transfer while corrections to a
former Flight's captured roster require an appropriately authorized manager.
Scoped decisions require the same existing captured-Squadron permission as the
core decision route and a current-term event. Explicit full-read callers retain
their existing core permission checks and historical authority.

Do not turn an authorization preview into a bearer token, cached permission or
unconditional forward to a broad core command path. The panel server must deny
alternate command **and receipt** paths to scoped sessions and use
`/v1/admin/panel/commands` for exact frozen-command retries. Owner/explicit
full-read flows may continue their existing routes under their current grants.
Keep the expected versions in the reviewed command. The authorization read may
report a newer version; never silently substitute it at apply. A stale review
must be shown again. The scope predicate is intentionally conservative: an
authority-source change can require a retry even if the final scope appears
unchanged. Existing core version, identity, source, intake and idempotency rules
remain authoritative.

## Evidence and remaining acceptance

Administrator account previews use the separate [read-only View-as contract](D1_PANEL_VIEW_AS.md).
They preserve the target's real scope while retaining the actual actor and a
dedicated entry/exit audit. Their BFF mutation fence is a separate integration gate.

Local D1 tests cover real signed route dispatch, Flight/deputy redaction, preserved
Wing spreadsheet reads, explicit owner/manager access, no approval inferred from
Flight command, duplicate Squadron commanders, captured-Squadron reparenting,
immediate revocation, named-account drift, interrupted pagination, concurrent
authority changes, bounded offsets and invalid scope input. Targeted apply tests
also move an actor's Flight immediately before the mutation while retaining
Wing correction authority, revoke scope between preflight and receipt lookup,
move a decision target to an older term before commit, reject changed-payload
replays and preserve stale expected versions. The paged read prepares at
most 19 SQL statements per request, below the Free 50-query invocation limit at
the implementation's established provider baseline; pages are bounded by the
existing 128,000-byte frontend limit and section limits.

No new service, paid tier, account grant or production mutation is introduced by
these source changes. Local tests do not establish hosted CPU/rows-read limits or native
Google-account behavior. Before release, integrate and test the panel server's
alternate-route denial, real named-account Flight/Blue/Gold access and revocation,
and representative hosted request cost. Keep production unchanged until the
complete staging acceptance is approved.


### Cadet workspace and Squadron review

Apply migration 0017 to the isolated operational D1 after verifying a restorable backup and closed input controls. It adds Flight duty and attendance-flag records. The existing panel session store keeps the Google subject binding. Google-managed school registration and Directory self-service share the native enrollment and command handlers. No additional identity provider or recurring background task is required.

For a permission check, enter View as with an active Wing permission manager, select the Blue commander, and compare the pending and completed request IDs against the captured Squadron in D1. Repeat for Gold, confirm the sets are disjoint, open a request’s details, and verify the preview rejects writes. Repeat after exit to confirm that the previous preview is closed. Use a fictional account and event for registration, excusal decisions and Flight duty tests when write gates are open.

The staging panel expects its signed command source to be registered in the operational database. Check the panel’s SOURCE_KIND and SOURCE_RESOURCE bindings against adapter_sources before a write rehearsal. A fresh real-data import may contain only Google sources. With the staging Worker and database binding verified, the following transaction statement registers the configured source on a paused generation-1 staging installation. A previously disabled source stays disabled.

```sql
INSERT INTO adapter_sources (source_kind, resource_key, active)
SELECT 'test', 'admin-staging-web', 1
WHERE EXISTS (
    SELECT 1 FROM system_control
    WHERE singleton = 1 AND environment = 'staging'
      AND generation = 1 AND accepting_commands = 0
)
ON CONFLICT (source_kind, resource_key) DO NOTHING;
```

Read back the source and the command gate together. Source registration supplies no role grants. A submission also requires an open command gate, a verified account, current access and the applicable event or request version.
