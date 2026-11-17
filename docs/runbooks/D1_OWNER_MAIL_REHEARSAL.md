# Owner-only native mail rehearsal

This optional staging path exercises the existing notice planner and native Apps
Script `MailApp` provider. It sends only to the verified automation owner. The
operational `notification_intents` rows remain suppressed, with their original
routing, hashes and receipts unchanged. There is no operational staging sender,
historical replay, paid mail service or production binding.

This implementation is locally tested. Installing it does not establish live
Google delivery or production notification parity. A normal `MailApp` return
means API acceptance; it does not prove inbox delivery.

## Bindings and isolation

Apply migration `0013_owner_mail_rehearsal.sql` through the normal reviewed staging
migration process. It adds separate `owner_mail_cases`, `owner_mail_attempts` and
`owner_mail_audit` tables. It never changes the operational mail ledger.

The Worker requires all three trusted environment bindings:

- `OWNER_MAIL_REHEARSAL_ENABLED`: exactly `true` during the reviewed rehearsal.
- `OWNER_MAIL_REHEARSAL_EMAIL`: the lowercase automation owner's email.
- `OWNER_MAIL_REHEARSAL_PRINCIPAL`: its explicitly configured D1 principal.

Keep these bindings in private deployment configuration, not source control. The
principal must remain active and hold Wing `notifications.manage`; preparing or
claiming a new case also uses the scoped frontend read authority. A request cannot
supply routing or choose another owner. Staging, current generation and current
permissions are checked again at every operation. Revocation prevents completion
until authority is restored; preserve the checkpoint rather than starting over.

This path has its own explicit gates. General D1 `accepting_commands=0` does not
disable an already reviewed owner rehearsal. Use the owner-mail pause and Worker
enable binding to stop it. This permits an isolated provider test while normal
staging intake stays paused.

## Native private configuration

Create two separate owner-only JSON files in the automation owner's My Drive:
a configuration and a checkpoint. Do not put them in a shared drive, share them
with cadets, or reuse a Forms/input/transport/state file. Both files and the root
configuration, if used, are verified against the effective Google account on each
invocation. Content changes are checked before checkpoint writes, including
concurrent changes that preserve or advance Drive metadata.

Initial checkpoint:

```json
{"version":1,"environment":"staging","generation":1}
```

Configuration, with private placeholders replaced through the existing private
configuration tooling:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "enabled": false,
  "resourceReview": "OWNER_ONLY_MAIL_REHEARSAL_REVIEWED",
  "principalId": "automation-principal",
  "workerId": "owner-mail-worker",
  "stateFileId": "PRIVATE_CHECKPOINT_FILE_ID"
}
```

Set `SHAMROCK_V3_OWNER_MAIL_CONFIG` to the JSON string
`{"version":1,"configFileId":"PRIVATE_CONFIGURATION_FILE_ID"}` in Script
Properties or the owner-private root configuration. `SHAMROCK_V3_OWNER_MAIL_PAUSED`
defaults to paused unless its value is exactly `false`. Setup fingerprints bind
the configuration, owner, Worker origin and bridge key ID. Changing these requires
setup again. There are no recipient fields in this configuration.

The staging manifest includes
`https://www.googleapis.com/auth/script.send_mail`. The account holder must approve
Google's renewed consent before native `MailApp` can run. The primary staging pause
entry point also pauses owner mail. No separate timer is installed: the existing
scheduled staging flush discovers optional owner-mail controls and work.

## One reviewed message

Every control is supplied in the private configuration as `controlRequest`:

```json
{
  "requestId": "owner-mail-control-1",
  "sequence": 1,
  "action": "setup",
  "stateSha256": "SHA256_OF_CURRENT_CANONICAL_CHECKPOINT"
}
```

Canonical checkpoint JSON recursively sorts object keys, preserves array order,
and uses compact `JSON.stringify` output. Hash those UTF-8 bytes with SHA-256.
Use a new request ID and strictly increasing sequence for each new control. Keep
the exact control after an ambiguous response; replay is idempotent. A consumed
resume cannot undo a later manual pause. An interrupted prepare retains its
control hash so it can finish after advancing the private checkpoint.

1. Keep the Google configuration disabled and paused. Review the exact Worker,
   database, owner and principal bindings, enable the Worker rehearsal binding,
   and submit `setup`. Run `shamrockV3OwnerMailControl` or allow one existing timer
   tick. Setup verifies the owner binding and stays paused.
2. Plan a **new** suppressed notice using the existing notification planner,
   or complete the current Sunday closeout to produce its actual closeout notice. Review
   its current content and routing through private tooling. Imports do not produce
   send cases. A source and its planning time must be less than 24 hours old, unblocked,
   suppressed and exactly match the current scoped D1 facts and recipients.
3. Submit `prepare` with `caseId`, `noticeId` and `payloadHash` in addition to the
   control fields. Use a new case ID and the exact reviewed source hash. The
   Worker freezes an owner-only message and returns a review hash. The native
   checkpoint retains that review and stays paused.
4. Set configuration `enabled` to `true`. Submit a new `resume` control bound to
   the resulting checkpoint hash, then run `shamrockV3OwnerMailControl`. This
   validates the exact setup and Worker review. Run `shamrockV3OwnerMailFlush` or
   allow one timer tick. It can send at most this single reviewed case.
5. Read `shamrockV3OwnerMailStatus`, the private checkpoint and the separate D1
   receipt. Verify the owner's inbox separately when testing delivery. Terminal
   completion pauses the native sender. Run `shamrockV3OwnerMailPause` and disable
   the private configuration and Worker enable binding between rehearsals.

The message has one `To` address: the verified owner. It has no CC or Reply-To.
Its subject begins `[STAGING REHEARSAL]` and its body identifies the owner-only
rehearsal. The native host rejects a signed claim containing different recipients
before calling `MailApp`. Private state retains the reviewed message and claim;
it may contain real operational content and must stay private.

## Duplicate prevention and recovery

A source notice can create only one case. A case can have only one attempt. Exact
prepare, claim and result retries return their original review, claim or receipt,
including concurrent retries. A changed case binding or consumer is rejected.
There are at most three attempts per detachment local day across this database,
including no-send and uncertain results, and at most 100 retained cases. The
bounds do not automatically discard audit evidence or reset uncertain cases.

A prepared case expires after one hour. A claim expires after ten minutes; the
native host does not begin a provider call with 30 seconds or less remaining.
It checks the current `MailApp` recipient quota before calling the provider and
records `dispatching` durably **before** that call. It never dispatches a retained
`dispatching` checkpoint again.

- `sent`: `MailApp` returned normally before the lease expired and D1 saved that
  result. Keep the original receipt; it is API acceptance evidence only.
- `not-sent`: the native quota check established that no provider call was made.
  This case remains terminal.
- `uncertain`: the send result was lost, the process restarted after dispatch,
  the provider threw, or the attempt expired. Do not resend this case. A late
  success report cannot change it to `sent`.

A lost claim response reuses its deterministic claim ID. A lost completion ACK
retries only the saved result, without calling the provider again. Signed
`POST /v1/admin/notifications/rehearsal/recover` can terminalize an expired retained
attempt using its original principal, worker ID, attempt ID and claim token.
It cannot requeue it. Keep both D1 and Drive evidence; do not delete a checkpoint
or mint another source to evade uncertainty or daily limits.

The signed routes are `prepare`, `claim`, `complete`, `status` and `recover` under
`/v1/admin/notifications/rehearsal/`. They use the existing bridge HMAC contract and
strict request fields. Preparation and claim revalidate through the bounded
notification context reader, not a whole-history frontend snapshot. Completed
Sunday closeout recipes use their exact retained event set and current routing;
wrong policy, generation, current term or an incomplete closeout is rejected.

## Local checks and remaining live evidence

`owner-mail-worker.test.mjs` exercises routing substitution, original-ledger
preservation, strict inputs, current routing changes, generation and authority
fences, expiry, recovery, concurrent retries and the daily budget against migrated
D1/SQLite. `owner-mail-native.test.mjs` exercises the real native host with provider
fakes, including dispatch journaling, lost ACKs, interrupted controls, broad Drive
sharing, changed owner, quota exhaustion and uncertain provider results. Scheduler
checks keep an unconfigured sender idle without extra URL Fetch calls.

Renewed owner consent, actual owner-only delivery, inbox observation and the
post-rehearsal hosted pause/readback remain live acceptance work. None of these
local results authorize production delivery or account cutover.

Scoped notification, completed-closeout revalidation and owner-mail claims inherit the shared pending event roster fence. If eligibility refresh work is outstanding, they return `EVENT_ROSTERS_PENDING` without creating a delivery attempt. Closeout preparation and processing also wait; an aged unresolved roster job must be reviewed before automatic attendance facts can be written.
