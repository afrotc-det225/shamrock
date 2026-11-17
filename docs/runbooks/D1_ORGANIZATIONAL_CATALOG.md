# Flight and Squadron catalog administration

Migration 0015 adds reviewed catalog commands and immutable submitted Excusal
ownership. This is isolated staging code; it does not authorize production
migration. Apply the migration and matching Worker/Google adapter release while
paused, with the usual tested backup, exact migration ledger and provider checks.

## Read, prepare and apply

`POST /v1/admin/catalog` uses the signed bridge with
`{environment,generation,principalId}`. It requires current Wing
`directory.manage` authority and returns a coherent audit revision, Flights,
Squadrons and their catalog versions. Existing imported catalog rows start at
version 1. A new stable ID uses expected version 0. Retired Flight IDs remain in
the returned catalog as versioned tombstones.

The pure `prepareCatalogCommand` helper in
`packages/domain/src/organizational-catalog.ts` prepares a normal audited command
from that captured catalog, the configured actor/source envelope and one explicit
change. No person, Flight or Squadron is identified by a sheet row number or a
label match. The supported command payloads are:

```ts
// POST /v1/admin/commands
{ operation: 'flight.upsert', payload: {
  flightId, label, squadronId, active, expectedVersion, reason
} }
{ operation: 'squadron.upsert', payload: {
  squadronId, label, expectedVersion, reason
} }
```

Use the ordinary command envelope, current staging generation and registered
source. Review the exact command in an owner-private file before submission.
When role permissions are enabled, route the reviewed file through the existing
private permission control request (`action: 'command'`, `commandFileId`,
`commandSha256`, `stateSha256`, monotonic `requestId`). See
[D1_ROLE_PERMISSIONS.md](D1_ROLE_PERMISSIONS.md). The native host normalizes catalog
commands with `parseCatalogCommand` before hashing, closes and reads back the
actual Google edit protections, and attests the exact command/policy revision.
It then commits the command and publishes the resulting permission policy.
A direct CLI write without that fence returns `PERMISSION_FENCE_REQUIRED`.

Every create, rename or reparent requires Wing Directory management. With trusted
permissions enabled, it also requires current explicit permission-manager
membership and the native fence. An ordinary Flight Directory manager cannot
reshape the hierarchy. Current principal/source/generation and versions are
rechecked in the same transaction as the catalog, receipt, audit, permission
policy and refresh jobs. Retry an interrupted command with its original ID and
body; never increase its expected version automatically. Replays recheck current
authority and return the same receipt without duplicate effects.

## Change behavior

- A Flight can move between existing Squadrons without changing its stable ID,
  people, submitted requests, original observations or captured event rosters.
  Current Directory/Leadership scope follows the new hierarchy. Future managed
  events receive a coalesced roster-refresh request; started events retain their
  captures. Publication waits for pending future roster work to finish or receive
  explicit review.
- A Flight rename updates its current label and roster token. Exact canonical
  current `Flight Commander` / `Deputy Flight Commander` titles prefixed by the old
  Flight label follow the new label in that Flight's Directory profiles and
  matching manual Leadership contacts; optional `Cadet` prefixes are preserved.
  Changed profile/contact versions advance, and the catalog audit lists each
  before/after role label. Generic role titles and arbitrary prose remain intact.
- A Squadron can be created or renamed without reassigning its Flights. Blue and
  Gold are the existing operational queue/policy names and cannot be renamed by
  this generic command. Changing those names requires a coordinated operational
  policy and presentation change. Creating a catalog Squadron does not turn it
  into an operational Blue/Gold decision queue.
- Retirement is allowed only for an unreferenced Flight. Directory profiles,
  memberships, event selections, requests, explicit grants, retained event/term
  captures and other foreign-key references block it. No cascade deletes evidence.
  The retired stable ID, last catalog value, audit and version remain available;
  a reviewed reactivation uses that retained version. Squadron deletion is not
  supported.

The catalog permits at most 50 active Flights, 20 Squadrons and 1,000 returned
Flight identities including retirement tombstones. Labels are bounded, trimmed
and case-insensitively unique within their echelon. Each command queues the normal
Main/Excusals and Forms refreshes. Canonical label changes do not create attendance
facts or send mail.

## Submitted Excusal ownership

The legacy handler saved the submitted Squadron on the request. The redesigned
request now retains the same responsibility independently of later Directory or
catalog changes. Each accepted submission atomically captures its Flight ID,
Squadron ID, Flight/Squadron labels and capture provenance. Decisions never change
that capture.

Migration backfill first matches an unambiguous retained adopted legacy
`record.squadron` to the catalog and preserves its original Flight label. Those
rows are labeled `legacy-source`. Otherwise it records the hierarchy observed at
migration and explicitly labels it `observed-migration`; this is not a claim about
an unavailable original historical label. New responses are labeled `submission`.
Original import rows and source evidence are never rewritten. Review aggregate
counts by provenance and any observed fallbacks before a hosted release.

Blue/Gold publication, decision authorization and notification routing all use
this captured Squadron. After Alpha moves from Blue to Gold, a previously
submitted Blue request remains on Blue, editable by the current trusted Blue
commander; a new request belongs to Gold. Current explicit grants retain their
explicit authority. Cadet reassignment does not manufacture a new requester or
silently move a submitted queue item. Multiple simultaneous active memberships
still require review.

Delayed notification tasks retain their original version, status and reason;
only immutable captured scope is joined from the canonical request. This includes
tasks created before migration 0015. Messages go to the current trusted commander
of the captured Squadron. Owner-only rehearsal uses the same routing validation.
A missing capture in a current v15 snapshot fails closed instead of choosing the
cadet's current Squadron. Older retained snapshot artifacts without these fields
use their already-frozen catalog; they are not reinterpreted with a new live one.

Historical source reports remain the original label evidence. Catalog operations
do not rewrite event-version/person/Flight identities or retained semester/archive
snapshots. Current Directory labels are intentionally current catalog values.

## Verification and recovery

Before using a hosted catalog command, verify the migration ledger, scope row
count, provenance counts, absence of unresolved mapping diagnostics and exact
private native permission binding. Review the command and any canonical role
label changes. After acceptance verify its audit/receipt, derived policy revision,
future roster queue, Forms choices, current Directory/Leadership labels and
Main/Excusals publication readback, including the protected Data Legend source choices and existing native dropdown types. The [catalog publisher](D1_FRONTEND_PUBLICATION.md#dynamic-flight-and-squadron-choices) updates those choices programmatically through the normal fenced refresh. For a reparent rehearsal, submit one request
before and one after; verify distinct original queues, decision permissions and
notification recipes. Keep mail suppressed unless the separate reviewed owner
rehearsal is active.

If a publication or permission update is interrupted, retain its private
checkpoint and provider fence, then use the existing reviewed recovery workflow.
Do not undo catalog rows directly or recreate commands to force a retry. A failed
D1 assertion/audit rolls back the entire catalog batch. A provider failure after
commit leaves durable pending work and the saved receipt.

Focused tests include stable identity/version conflicts, retirement restrictions,
revocation/audit rollback, role-title changes, future roster refresh, old/new
Squadron authorization, exact legacy-source/fallback backfill, delayed messages and
missing-capture failure. The enabled fenced catalog fixture uses 36 prepared D1
statements, below the repository's reviewed 50-statement comparison limit. This
is local SQL evidence, not hosted CPU or daily billing evidence. No paid service
or additional provider resource is required by these commands.
