# D1 administrative commands

This is an isolated local/staging implementation. It has not changed production, moved production records, or connected the Google operator interface. Use the [staging release workflow](D1_STAGING_RUNBOOK.md) for a reviewed, paused upgrade; do not run the production Apps Script push command.

## Scope and command contract

Migration `0003_administration.sql` adds typed Directory profiles, explicit Flight-to-Squadron relationships, terms, Leadership contacts, event details, administrative grants, receipts, before/after audit history, membership history and refresh effects. Existing attendance/excusal tables and their command DTO remain intact.

The signed Worker endpoint `POST /v1/admin/commands` accepts the envelope already used by SHAMROCK: `commandId`, `contractVersion: 1`, `environment`, `generation`, `actor`, `source`, `operation`, `payload`. The exact exported types and strict parser are in `packages/domain/src/admin.ts`. Sources must be registered `sheet` or `test` bindings. An authenticated bridge is required, and it must establish the human principal; a role label or the script owner's email is not identity evidence. This endpoint does not yet provide Directory Form self-service.

| Operation | Payload and behavior | Current authority |
| --- | --- | --- |
| `directory.upsert` | Stable `personId`, `expectedVersion`, `flightId`, and all 18 profile fields. Flight and Squadron labels derive from the canonical hierarchy. Preserves historical evidence and prior membership rows; records the previous/new Flight and operational state. | `directory.manage`, either Wing or every affected Flight. A transfer requires both Flight scopes. A profile with no Flight requires Wing authority. |
| `leadership.upsert` | Stable `contactId`, `expectedVersion`, `personId`, `profile`, `reportsTo`, `officePhone`, `officeLocation`, `active`. A manual/cadre contact has `personId: null` and a profile; a Directory-linked contact has a stable person ID and `profile: null`. Existing linked identity cannot be reassigned. | Wing `leadership.manage`. |
| `event.upsert` | Stable `eventId`, `expectedVersion`, `termId`, type, training week/order, display/column labels, expected group, explicit Flight IDs, status, UTC start/end pair, location and notes. Cancellation changes status without deleting evidence. An established event cannot change term. | Wing `events.manage`. |

An expected version of zero creates a detail/profile record or explicitly hydrates an existing legacy identity that has no new detail row. Every accepted change increments the entity version. Unknown fields, unsupported AS years or Flight Path values, malformed dates, duplicate Flight selections and contradictory active/no-Flight records fail validation. The operationally inactive values remain `Inactive`, `Commissioned`, and `Dropped`. Third Hour is retired and cannot be created through the new event command.

The Directory carries the existing name, AS year, rank, role, university, email, phone, dorm, CIP broad area/code, AFSC, hometown/state, class year, DOB, Flight Path and photo-link fields. Email changes do not create a new person or transfer principal authority. Email uniqueness is checked for nonblank Directory emails, while stable person IDs remain authoritative. HTTPS photo references are supported as values; fetching photos and producing native file chips belong to the Google adapter.

The current Leadership derivation recognizes the established Wing, operations group, Squadron and Flight commander/deputy, senior GMC advisor and deputy GMC advisor roles. It adds Flight/Squadron names where the current source does so. These are display rules, never access grants. Active qualifying Directory cadets appear automatically in the snapshot; manual/cadre contacts survive refreshes. Linked office/reporting details remain independently versioned. Rank/role sorting, phone display normalization and exact visual parity belong to the publisher and require their own checks.

## Atomicity, authority and recovery

A single D1 batch rechecks current authority, source registration, environment/generation, the pause fence, entity version and relevant membership topology, then saves the mutation, receipt, audit and refresh effects. A failed assertion, audit insertion or later effect insertion rolls the whole command back. This uses the documented [D1 batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Repeat the exact command to recover a lost response. An identical retry returns the saved receipt without adding effects. Reusing the command ID with different input, across the operational/administrative ledgers, or reusing its source identity for a new command returns a conflict. Receipt retrieval is `GET /v1/admin/commands/<commandId>?principalId=<principalId>` and rechecks active identity, source, pause/generation and the original scope grants. Revoked authority does not retain receipt access.

A conflict means reload the current record and review the change; do not blindly increment the expected version. Administrative audit records retain before/after data privately in D1. Do not put these records, raw resource bindings or personal data in public GitHub issues or logs.

Directory changes bump the affected Flight roster versions even when only names or other profile fields change, invalidating a stale roster submission. Each Directory or event change queues one `frontend.refresh` and one `forms.refresh` intent; a Leadership change queues only `frontend.refresh`. The implementation uses bounded JSON set operations, not per-cadet database calls. No email is sent by these intents.

## One coherent frontend snapshot

`POST /v1/admin/snapshot` accepts `{environment, generation, principalId}` and requires an active principal with Wing `frontend.read`. Read access works while the mutation fence is paused. One D1 batch reads authorization, data and the revision pair:

```ts
{ operations: number, administration: number }
```

These are the maxima of the independent attendance/excusal and administrative audit streams. Compare both components, not their sum or timestamps. The response contains `people`, `leadership`, `flights`, `squadrons`, `terms`, `events`, `eventFlights`, presence observations, current excusal requests and diagnostics. The full `FrontendSnapshot` interface is exported from `packages/domain/src/admin.ts`. Observation and request `order` use the committed attendance/excusal audit sequence, so the reporting layer can compare facts for the same cadet/event.

Bounds are 500 Directory profiles, 200 Leadership contacts, 50 Flights, 20 Squadrons, 20 terms, 200 detailed events, 10,000 event/Flight associations, 10,000 observations and 5,000 requests. Queries use limit-plus-one and reject an oversized snapshot rather than silently truncating it. These are reviewed implementation bounds, not a claim of hosted free-tier CPU capacity. Historic retention beyond these limits needs a term-scoped snapshot/export design and measurement before cutover.

Missing legacy profiles, event details or Squadron mappings are reported as diagnostics. Do not publish them as a complete frontend. Current membership must not be used to invent historical event eligibility or term roster snapshots; those workflows remain to be implemented. The existing `/v1/jobs/project` response is unchanged for earlier rehearsal/command compatibility and is not the authoritative new frontend contract for Directory changes.

## Refresh-effect delivery

Signed `POST /v1/admin/effects/claim`, `/project` and `/ack` requests use `{environment, generation, principalId, workerId}`; claim also requires `kind: 'frontend.refresh' | 'forms.refresh'`, while project and acknowledgement require `effectId` and `claimToken`. A consumer must claim only the kind it can publish. The principal needs Wing `frontend.read`, and mutation processing must be resumed. Claim returns `{effect}`; project returns `{effect, snapshot}`. The consumer must build the intended Form/spreadsheet updates programmatically from that snapshot and acknowledge only after verification. This release supplies the backend contract, not the Google consumer.

At most one effect of each kind can be leased. Claims have ten-minute leases. Expired leases are retained for operator review rather than stolen while a Google request might still be running. Wrong, expired, revoked or fenced claims cannot publish/acknowledge through the backend. Repeated projection reads return the current coherent snapshot, so a delayed refresh can include later committed work. The publisher must track the revision pair to reject stale publication.

## Bootstrap and validation

The additive migration intentionally does not invent the detachment's Flight/Squadron mapping, term order, principal grants or profile identities. Import those reviewed catalogs while paused through the controlled migration/bootstrap process, using private runtime bindings. Catalog changes currently require a reviewed administrative operation outside this three-command surface; changing them must advance the generation because they are not represented in the snapshot's audit pair. Do not edit catalogs behind an active publisher. This is a remaining operator-workflow gap, not a recommended recurring SQL-maintenance burden.

Run:

```sh
npm run build
npm run build:v3
node --test tests/v3/admin.test.mjs
npm run check
```

The local suite exercises strict validation, two-Flight transfer authority, version conflicts, receipt replay, grant/source/principal revocation, concurrent delivery, audit rollback, retained inactive profiles, manual and Directory-linked Leadership, event cancellation, snapshots and leased refresh effects. Tests use fictional records and local D1. Hosted quotas, actual Google triggers, non-owner editing, historical eligibility, corrections, term transitions, notification delivery and complete frontend parity require separate integration evidence before production cutover.
