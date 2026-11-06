# Isolated D1 domain prototype

This module is part of the local/staging implementation described in
[the redesign plan](../../docs/plans/D1_REDESIGN_AND_MIGRATION.md). It is not
imported by the live Apps Script source and does not change production behavior.

It currently supports four commands under envelope contract version 1:

- `attendance.report`: records the covered roster snapshot, complete/partial
  declaration and selected present observations. Even a complete report does not
  automatically infer absence; absence/credit policy is a later approved layer.
- `excusal.submit`: records a request independently of actual attendance.
- `excusal.submitMany`: expands one native submission into 1–25 event requests,
  each with an explicit stable child `requestId`. Events and child IDs must be
  unique. Canonical event ordering makes selection order irrelevant to retries;
  child IDs must be based on source and event identity, never array position.
- `excusal.decide`: applies an explicit decision to the expected request version,
  retaining original submission data and recording decision attribution.

`parseCommand` rejects unsupported fields, missing identity/source evidence,
invalid values, duplicate/out-of-scope targets and production environments.
Runtime validation does **not** authenticate an asserted principal or establish
permissions: the Worker must authenticate the adapter, resolve current grants,
validate all referenced database entities, and verify current roster versions.
Likewise, the decision reducer's version check must be reasserted atomically in
the database transaction; a preceding read alone is insufficient.

The returned attendance view keeps `observedCode`, `requestStatus`, and
`approvedOutcome` separate. It does not calculate percentages, apply automatic
unexcused status, restore stale prior cells, or decide conflicts between multiple
independent requests. Those policies require explicit later implementation.

Commands use caller-persisted IDs and source form/sheet revision identities.
These pure functions neither deduplicate deliveries nor save history: persistence
must atomically commit the command receipt, domain records, audit event and
pending projection work. Full decision revisions belong in that history; the
returned request is only its current snapshot.

The Worker requires migration `0002_multi_event_excusals.sql`. A multi-event
submission commits every child, one parent receipt/audit and each event's
projection job in one D1 transaction. Its receipt result is `{ requests }` in
canonical event order. Every event must be active and in the person's single
current unit, and the actor needs the current `excusal.submit` capability there.
The existing single-event operation remains supported; neither changing between
the operations nor increasing a native Form revision may duplicate a response.
Changed attendance/excusal Form content requires a future explicit correction
workflow. SQL migration rejects conflicting existing identities rather than
deleting or merging records. Receipt reads and projection revisions use every
recorded event scope, including scopes backfilled for older accepted commands.
Submission retries also retain the original unit boundary: a membership move
cannot use a new unit's grant to retrieve an old unit's receipt. Deliberate
membership-transfer and historical-access workflows remain separate work.

All clocks and IDs are supplied by the application, making domain results
deterministic. Interactive reports are limited to 500 covered members and 4,000
reason characters; larger workflows need deliberate chunking rather than silent
truncation. Known legacy values remain vocabulary, not an invented attendance
credit policy.

Validation lives in `tests/v3/domain.test.mjs`; compile the v3 packages before
running it. The suite tests observation/adjudication separation, exact scope,
zero-attendee completion, immutable snapshots, optimistic versions, strict
validation and deterministic timestamps with fictional fixtures.
