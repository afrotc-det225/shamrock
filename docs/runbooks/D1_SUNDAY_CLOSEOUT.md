# Automatic Sunday attendance closeout

The confirmed operational policy remains automatic: at Sunday 17:00 in
`America/Indiana/Indianapolis`, close the preceding Sunday–Saturday window even
when a Flight report is missing. Migration 0009 implements this as a versioned,
audited workflow separate from observed attendance and notification delivery.
The policy identifier is `det225-sunday-closeout-v1`. No production deployment,
cutover or real email delivery is established by local tests.

## Attendance policy

The workflow examines active events starting inside that completed week and
cadets on the explicit event roster who appear in the current operational
attendance matrix. Event identity and roster version are frozen when the run
starts. Attendance is read again before each bounded mutation.

- An eligible blank becomes `A` even if no Flight attendance report exists.
- `D` becomes `U`. An imported baseline `D` already represents denied attendance;
  it does not require inventing an excusal request.
- An unresolved denied request makes a blank or existing `A` become `U` when
  that denial is not older than a later explicit attendance correction.
- `P`, `T`, pending `R`, approved outcomes and all other existing codes remain
  unchanged. An explicit later correction remains authoritative. Closeout never
  rewrites an observation or treats an imported baseline as a new observation.
- Ambiguous evidence, a changed event version or missing current roster context
  is retained as `needs-review`; it is not guessed or silently finalized.

The established operational mechanism comes from
`AttendanceService.fillUnexcusedAndNotify` in `src/services/attendance.ts`. The
explicit user decision preserves its automatic deadline and missing-report
behavior. Stable IDs, causal revisions, transaction guards, continuation and
separate delivery records replace incidental implementation limitations.

## Authority and signed API

A principal must be active, explicitly enrolled in `closeout_authorities`, have
Wing `frontend.read` and `notifications.manage`, and use a registered sheet/test
source. Migration does not enroll anyone. This permission authorizes only the
fixed policy, rather than arbitrary caller-selected attendance codes. All writes
require the current environment/generation and the normal command fence.
Status is readable while the fence is paused. Every retry rechecks current
principal, source and grants; a prior receipt does not bypass revocation.

Each signed POST starts with:

```ts
{
  environment: 'staging', generation: CURRENT_GENERATION,
  principalId: PRIVATE_AUTOMATION_PRINCIPAL,
  sourceKind: 'sheet', sourceResource: PRIVATE_MAINTENANCE_SOURCE,
  policyVersion: 'det225-sunday-closeout-v1'
}
```

| Route | Additional fields | Behavior |
|---|---|---|
| `/v1/admin/closeout/status` | none | At most twenty runs, active runs first, with versions and pending/review counts; no cadet or recipient data. |
| `/v1/admin/closeout/prepare` | `asOf` | Canonical UTC instant for Sunday 17:00 Indianapolis; only due windows within eight days can start. Freezes one run for the policy/week/generation. |
| `/v1/admin/closeout/advance` | `closeoutId`, `expectedVersion` | Processes at most fifty frozen cells or completes the final notification step. Repeating a completed version returns its recorded receipt. |

A run progresses through `processing → notifying → complete` or `needs-review`.
Preparation is deduplicated by environment, generation, policy and week. Each
step and each changed person/event cell has a bounded deterministic command ID.
The shared command registry prevents collisions with other command families.

The atomic batch rechecks the run version, actor/source/fence and both coherent
snapshot audit revisions. It appends one causal correction and audit per changed
cell, updates progress, records the administrative step and queues a frontend
refresh together. Any failed statement rolls all of those writes back. A late
report or decision therefore invalidates the entire stale step; retry reloads
current facts before applying anything. Unchanged outcomes receive progress
records without extra attendance commands.

All existing observations, requests, decisions, corrections and imported
provenance remain intact. The parent step's frontend effect covers its atomic
child corrections and is compatible with existing claim-watermark coalescing.
A term transition cannot prepare or accept while a closeout is processing or
notifying. A completed run that needs catalog review is visible as such; it does
not silently rerun against changed rosters or retroactively enroll new people.

## Notifications and native scheduler

After every frozen item resolves, a fresh coherent snapshot supplies the weekly
recipient summary. Flight Commander is To and Deputy Flight Commander is CC,
with the established deputy fallback. Missing or ambiguous Leadership routing is
recorded explicitly. Summaries include existing as well as newly finalized A/U
and identify pending/review records; they do not call incomplete records perfect
attendance. The current Directory/Leadership routing is used, with each record
attached to its frozen event Flight.

The final atomic step records deterministic weekly notification intents and run
completion together. Every intent is terminal `suppressed`, including in a local
HTTP rehearsal. Neither caller input nor a later resume enables these old
messages. No MailApp/Gmail binding is invoked. If content or the notification
ledger exceeds its bound, the run stays `notifying` with the same saved progress.
No pending work is purged to make room.

The optional native maintenance configuration has `closeoutEnabled: true` only
for an explicitly reviewed staging rehearsal. Its default is false. With that
flag, the existing scheduled flush starts the current window after Sunday 17:00
and processes one chunk per invocation. It continues a retained run on subsequent
days. The independent maintenance pause stops the scheduler. The source, account,
resource and generation checks from the
[native maintenance host](D1_TRANSITIONS.md#native-staging-maintenance-host)
still apply.

When closeout is enabled, ordinary scheduled notification planning skips the
preliminary Sunday weekly review; the completed closeout creates the one final
weekly summary. Event-day notices and committed excusal tasks keep their existing
bounded processing. Without closeout enabled, the earlier suppress-only review
planner remains available as an engineering rehearsal, not a claim that Sunday
finalization is active.

## Bounds and verification

A run freezes at most 25,000 cells and 1.5 MB of roster metadata. Each advance
handles at most fifty cells using set-based SQL. The local fifty-cell regression
measured 38 prepared statements, including authorization, snapshot reads and the
atomic batch, below D1 Free's fifty-query invocation limit. This is not a hosted
CPU, daily row-quota or multi-year storage guarantee. Notification content is
bounded to one megabyte and the existing configured ledger capacity.

Tests cover missing reports, blank/D/denial finalization, observed P and corrected
T preservation, pending R, approved outcomes, DST windows, duplicate/concurrent
receipts, continuation, late-presence races, audit rollback, revoked authority,
changed event rosters, terminal suppression and notification-capacity recovery.
Native scheduler tests cover Sunday start and Monday continuation. Real Google
publication, real-data baseline parity and hosted resource measurements remain
separate release evidence. No test authorizes production cutover.
