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

The local suite exercises strict validation, two-Flight transfer authority, version conflicts, receipt replay, grant/source/principal revocation, concurrent delivery, audit rollback, retained inactive profiles, manual and Directory-linked Leadership, event cancellation, snapshots and leased refresh effects. Tests use fictional records and local D1. Hosted quotas, actual Google triggers, non-owner editing, historical roster imports, term-transition orchestration, notification delivery and complete frontend parity require separate integration evidence before production cutover.

## Corrections, event rosters and shared command identity

Version 3 was normalized before its first hosted application on November 6: `command_registry` owns globally unique command IDs, identifies their administrative/operational ledger, and is the foreign-key target for `admin_effects`. Version 3 backfills existing operational command IDs. All new handlers register their command atomically. A correction has one operational receipt and one operational audit record; it is not mirrored into the administrative ledger. As with every migration, the reviewed file hash must match the first applied release. Do not edit an already-applied migration to adopt this change.

Migration `0004_corrections_and_rosters.sql` adds append-only attendance corrections and versioned event rosters. `attendance.correct` uses `/v1/admin/commands` with the same envelope and this payload:

```ts
{
  personId, eventId,
  expectedBaseVersion, expectedEventVersion,
  code, // one established attendance code, or null for an explicit clear
  reason
}
```

`expectedBaseVersion` is the server-issued maximum committed operational audit sequence for that cadet/event pair, considering presence observations, excusal request/decision state and prior corrections. It is a causal version token, not a count of edits or a request-local version. The snapshot supplies `attendanceVersions`; a pair absent from that array has version zero by contract. `expectedEventVersion` is the displayed event's `version` and also identifies its frozen roster. A new request, decision, observation, correction or changed event version makes an older draft conflict. The caller must retain both versions from when the edit began; it must not replace them with current versions to force an old edit through.

The actor needs an explicit `attendance.correct` grant for the event roster's captured Flight, or Wing authority. An editor's current Flight or role label does not supply this grant. The event must have a saved roster containing the target cadet. Historical cancelled/archived events may be corrected by an authorized actor; this does not reactivate the event. A clear is new evidence with `code: null`; it does not delete the original presence observation or the excusal request. The reporting policy decides the displayed result using the shared causal order.

Every correction atomically saves its registry entry, operational receipt, audit, evidence and one `frontend.refresh` effect. Existing attendance and excusal handlers now also queue a `frontend.refresh` effect while retaining their prior projection jobs. The same snapshot/publisher can therefore observe Form submissions, approvals and spreadsheet corrections without waiting for a Directory change.

`event.upsert` now requires `eligiblePersonIds`: zero to 500 explicit, unique stable IDs. An empty list means an explicitly empty roster; it does not mean unknown or all cadets. The initial capture requires reviewed Directory profiles and active membership in a selected Flight. Each accepted event version saves a roster revision. Retained members retain their captured names, AS year, Flight, Flight Path and DOB; editing event notes after a Directory transfer cannot silently rewrite historical membership. Newly added members are captured from their current Directory profiles. Removing a member never deletes their evidence; reporting can flag evidence outside the revised eligibility. Selecting who is eligible remains an explicit operational decision; this implementation does not infer it from today's Flight membership or an arbitrary `expectedGroup` label.

Snapshot events now include `eligiblePersonIds`, and snapshot corrections include the same causal `order` as observations/requests. Legacy events without a capture have `eligiblePersonIds: null` and an `EVENTS_MISSING_ROSTER` diagnostic. Populate a reviewed roster rather than publishing an invented one.

Directory commands also retain a profile snapshot in the term marked current at the time. Once the catalog advances, later Directory changes do not update the prior term. `terms[].roster` contains captured members, including inactive or commissioned people. For the current frontend matrix, use active current Directory profiles; for historical matrices, use the saved term roster. Missing historical imports remain explicit gaps; this mechanism does not recover past rosters from today's Directory.

Additional snapshot bounds are 10,000 correction facts, 25,000 nonzero attendance-version pairs and 10,000 term-roster records. They are independent of the existing observation/request bounds. The local tests cover correction replay, explicit clear, original-presence preservation, request/decision races, stale event versions, old Flight authority, event-roster history, audit rollback and late grant revocation. Actual Google edit capture and publication require a separate staging rehearsal.

Leadership snapshots distinguish `contactVersion` (the `leadership.upsert` command version), `profileVersion` (the linked Directory command version, or null for manual contacts), and `publicationVersion` (a monotonic display token). A linked display token is the sum of the two owning versions; it must never be submitted as an expected command version. Linked name/rank/role/email/phone remain Directory-owned and can be edited through Directory. A Directory change advances the displayed Leadership token even when its office/reporting details are unchanged. Synthetic linked contact IDs use a bounded SHA-256 identity, so a maximum-length person ID remains valid and stable in Sheets bindings.

### Coalescing verified frontend refreshes

A `frontend.refresh` claim atomically captures the current operational and administrative audit maxima in its leased row. These watermarks never advance when the claim is projected again. The public claim/project/ack payloads are unchanged; clients do not choose or submit the watermarks. Project refuses a snapshot whose revision is below either captured watermark.

After the consumer verifies publication, ACK completes its leased effect and pending `frontend.refresh` effects whose originating registry ledger has an audit ID at or below that ledger's captured watermark. All updates occur in one guarded transaction. `completed_by_effect_id` records which claimed publication covered each completed effect. A burst of Directory, Leadership and attendance commands can therefore be represented by one verified global frontend publication instead of many identical full-sheet updates.

This relies on the existing contract that all `frontend.refresh` effects publish the same coherent frontend snapshot, every originating command saves its audit/effect atomically, and the adapter only acknowledges a verified publication belonging to the same effect ID and claim token. A cached publication is safe because it was projected at or above the immutable claim floor. A later projection may contain newer commands, but ACK remains conservative: commands committed after the claim stay pending for another publication. Coverage uses registry ledger and audit IDs, never creation timestamps, a current watermark at ACK time, or an unconditional drain of pending work.

`forms.refresh` effects are not coalesced. Wrong, revoked, expired, fenced or already-completed claims retain the existing conflict behavior; an ambiguous successful ACK still requires reconciliation rather than blind retry. The watermark/completion columns were included in version 3 before its first hosted application on November 6. That migration is now applied and immutable; subsequent changes require another migration.

Local regressions cover both audit streams, commands arriving after the claim, a cached older publication, unchanged claim watermarks after reprojection, no Forms coalescing, stale snapshot rejection, wrong/fenced/repeated acknowledgements and rollback when the final claimed-row completion fails.

Directory-derived Leadership uses the supported source role inclusion rules. Only exact Blue/Gold Squadron Commander assignments (or the shorthand Squadron Commander with an operational Squadron assignment) generate a Squadron commander contact. Mission Support and Abroad Squadron Commander titles do not become operational commander contacts. Existing manual Leadership contacts remain explicit records. Rendering a contact does not itself authorize an account.

The optional [trusted role-permission policy](D1_ROLE_PERMISSIONS.md) adds explicit permission-manager authorization and publisher-attested native fencing for privilege-bearing Directory/Leadership changes. Harmless edits retain current derived authority in the same D1 transaction. This policy starts disabled; private host integration and named-account provider rehearsal are separate enablement gates.
