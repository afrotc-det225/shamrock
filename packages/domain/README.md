# Isolated D1 domain prototype

This module is part of the local/staging implementation described in
[the redesign plan](../../docs/plans/D1_REDESIGN_AND_MIGRATION.md). It is not
imported by the live Apps Script source and does not change production behavior.

It currently supports three versioned commands:

- `attendance.report`: records the covered roster snapshot, complete/partial
  declaration and selected present observations. Even a complete report does not
  automatically infer absence; absence/credit policy is a later approved layer.
- `excusal.submit`: records a request independently of actual attendance.
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

All clocks and IDs are supplied by the application, making domain results
deterministic. Interactive reports are limited to 500 covered members and 4,000
reason characters; larger workflows need deliberate chunking rather than silent
truncation. Known legacy values remain vocabulary, not an invented attendance
credit policy.

Validation lives in `tests/v3/domain.test.mjs`; compile the v3 packages before
running it. The suite tests observation/adjudication separation, exact scope,
zero-attendee completion, immutable snapshots, optimistic versions, strict
validation and deterministic timestamps with fictional fixtures.
