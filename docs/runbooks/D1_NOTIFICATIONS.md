# D1 notification rules and delivery boundary

`packages/domain/src/notifications.ts` supplies deterministic notification intents
and the delivery state machine. It does not send mail. Current production Gmail
triggers remain unchanged; the new staging runtime must suppress outbound mail.

The versioned policy carries forward the operational schedule in
`src/services/setup.ts`: event-day notices from 05:00 and Sunday
review from 17:00, in `America/Indiana/Indianapolis`. Daily notices cover active
Mando PT and LLAB events on that local day. Sunday reviews cover the previous
Sunday through Saturday and include active events in the flight's explicit
scope. Cancelled, inactive and archived events do not generate notices. Flights
marked nonoperational, such as Abroad in the existing configuration, are excluded.

Routing preserves the existing command relationships. Flight notices go to the
flight commander with the deputy copied; if the commander is missing, the deputy
is the primary recipient. An absent recipient becomes a visible blocked intent.
New excusal requests go to the squadron commander, with the cadet copied and as
reply-to. Decisions go to the cadet, with the squadron commander copied and as
reply-to. Missing squadron routing is blocked, without an invented fallback
address. The automation identifies itself as SHAMROCK Automations rather than
signing as a human commander.

Messages distinguish approved excusals, pending requests, recorded A/U and
attendance not yet established. A denial or a missing request never establishes
an absence. The [explicit Sunday closeout policy](D1_SUNDAY_CLOSEOUT.md) separately
records automatic A/U finalization before its final summary. A preliminary weekly
review does not assign U or describe an incomplete
record as perfect attendance. Final absence adjudication is a separate authorized
operation with its own evidence and audit history.

## Durable delivery requirements

Each intent has a deterministic key based on policy, event/flight/local day or
the flight's training-week window. An excusal key includes request identity and
the recorded decision version. Retries must reuse the key; content changes or a
new scheduler invocation must not create another send for the same intended
notice. Local date calculations account for daylight saving changes.

The delivery state machine is `queued → sending → sent`. Persist `sending`
before invoking the mail provider. A proven no-send result may return to queued;
an unknown result or crash around delivery becomes `uncertain`. It cannot be
retried automatically. A quota check before sending can block delivery until
reviewed recovery. This makes uncertainty visible without claiming exactly-once
Gmail delivery.

`staging`, `shadow`, `import` and `replay` produce terminal suppressed intents.
Resuming the application cannot release old test or import mail. Do not implement
suppression solely as a temporary global pause flag. Actual recipients and
message bodies belong in private provider storage, never source control or logs.

Before enabling a live sender, the host must persist intents, recheck current
recipient routing/authority, enforce the generation and delivery fence, record
attempts, expose blocked/uncertain work to the operator and prove crash recovery.
The pure planner and its tests do not establish these provider behaviors. No
external email service, paid queue, AI API or subscription is introduced.

Validation: `npm run build:v3` and
`node --test tests/v3/notifications.test.mjs` cover routing, schedule windows,
DST, cancellation, missing recipients, replay suppression, factual wording and
the uncertain-delivery boundary using fictional addresses.

## Isolated durable foundation (migration 0005)

The Worker now exposes signed `POST /v1/admin/notifications/plan` and `/status` endpoints. This is a suppressed staging foundation, not an enabled mail service. There is no enabled hosted sender, Gmail credential, paid queue or external email transport binding. Migration 0006 adds the local-only signed delivery protocol described below. The current production notification triggers remain separate.

Planning uses the standard command envelope with `operation: 'notifications.plan'` and this strict payload:

```ts
{ kind: 'scheduled' | 'excusal', asOf: 'canonical UTC timestamp', requestId: null | 'stable request ID' }
```

Scheduled planning requires `requestId: null`; excusal planning requires the explicit request ID. The actor needs Wing `notifications.manage` and `frontend.read`, an active principal, a registered sheet/test source, and the current generation with command processing resumed. Receipts use the shared command registry, administrative ledger and audit. Receipt retries recheck current authority. There is no accepted recipient-address or delivery-mode parameter. A caller cannot turn staging plans into live mail by supplying `mode: live`.

The planner reads one coherent, bounded frontend snapshot. Flight and Squadron recipients come from active Leadership records with the established exact named commander/deputy roles. Missing, ambiguous or malformed routing is retained as a missing-recipient issue. Excusal content comes from the recorded request and decision, never a caller-supplied email address, outcome or reason. The final atomic batch rechecks authorization, source, generation/fence and the snapshot's audit revisions before saving the receipt, audit and intents. A changed snapshot, exhausted ledger bound or failed write rolls everything back.

All HTTP-planned intents are persisted as terminal `suppressed`, including when the request reaches a local Worker. Stable policy keys deduplicate repeated schedules and request versions; a later command or resume cannot release an old staging notice. Content and recipients remain private D1 data. New plans do not overwrite a previously saved intent for the same key.

`/status` takes `{environment, generation, principalId}` and requires Wing `notifications.manage`. It reports state totals, attempt totals and at most 50 attention records, with `moreAttention` when additional records exist. It exposes no message body or recipient address and reports `deliveryEnabled: false`. Status remains readable while processing is paused.

Migration `0005_notification_ledger.sql` adds private intent, attempt and delivery-event tables plus a delivery control record defaulting to suppressed with a zero recipient budget. The default ledger limit is 1,000 intents; the reviewed configurable range stops at 10,000. Planning is bounded to 100 intents and one megabyte of serialized content per command. Reaching a bound stops the plan rather than silently dropping notices or purging history. Retention/export and operational scheduling of these calls remain separate work.

The ordinary planning path was measured locally at **25 prepared statements**, including the coherent snapshot and atomic batch; status now uses five, including its bounded pending-task list. A regression requires planning to stay below 50 prepared statements. Set-based inserts keep this count independent of the number of planned notices. This is a query-count check, not a hosted CPU, daily-quota, storage-retention or complete free-tier capacity result.

### Local delivery-state rehearsal

`deliverLocalNotification` and `recoverLocalNotificationAttempts` remain exported local test helpers. Migration 0006 adds explicit signed claim/result/recovery routes that retain the same local-only delivery fence. They reject a staging environment before database access. A local harness must explicitly seed `local-test` mode and queued fictional intents; the API cannot activate that mode or unsuppress a record. Only fictional `.invalid` recipients are accepted, and the harness injects the transport. No real provider integration is included.

Before calling the injected transport, the helper reloads the trusted snapshot and compares routing/content, checks authority and a per-day recipient budget, then atomically saves `sending`, an attempt row and a delivery event. Every attempt counts conservatively against that local budget. A changed route/content blocks the intent; an exhausted budget blocks it without a delivery attempt. A confirmed outcome records `sent`; a proven no-send result records the failed attempt and returns the intent to queued. A thrown, malformed or lost result becomes `uncertain` and is never automatically resent. An expired attempt also becomes uncertain. A late claimed success cannot overwrite that uncertainty or add a false sent event. Failure to persist a result leaves the sending record for explicit recovery.

Local tests cover deterministic suppressed planning, trusted excusal routing, rejected forged delivery/recipient fields, receipt replay and revocation, atomic capacity failure, query count, persist-before-transport, confirmed/no-send outcomes, lost results, expiry/late-result races and quota exhaustion. These tests exercise local D1 with a fictional transport. They do not establish Gmail delivery, scheduled hosted planning, production notification parity or authorization to enable a real sender.

## Committed-version tasks and provider ports (migration 0006)

Every newly accepted excusal submission/decision atomically saves one notification
task per request/version with its frozen request content. Duplicate command
receipt delivery creates no second task. An earlier submission notice cannot
silently become a later decision when processing is delayed. Existing historical
records are not backfilled into the queue. Task identities are bounded hashes;
all newly queued tasks and resulting intents are permanently suppressed in this
isolated implementation, including import/replay work. No API can unsuppress them.

`/v1/admin/notifications/process` takes
`{environment,generation,principalId,sourceKind,sourceResource,taskId}`. It requires
current Wing notification authority and a registered source, reads current trusted
Directory/Leadership routing, and atomically saves the intent/receipt/audit and
marks the frozen task done. Planning uses `registered-automation` audit evidence,
not a fabricated human Google editor. `/status` now includes at most fifty pending
opaque task IDs without recipients or content. A full ledger stops processing
without losing or silently purging pending tasks.

The adapter's `planNotificationWork` uses deterministic commands for canonical
05:00 local daily and 17:00 local Sunday windows and processes at most five tasks
per call. Repeated scheduler ticks reuse the exact same body/key. The optional native maintenance host now supplies a private configuration and
separate pause gate, and the existing scheduled flush calls it when explicitly
enabled. It does not install another scheduler or enable delivery. See the
[native maintenance binding](D1_TRANSITIONS.md#native-staging-maintenance-host).

Signed `/v1/admin/notifications/delivery/claim`, `/complete` and `/recover` routes
exercise the durable delivery protocol only in the local environment with
explicit fixture `local-test` mode and fictional `.invalid` recipients. Staging
returns a suppressed response and never exposes a deliverable message, even if
a caller forges mode fields or a local record exists. Claim accepts a durable
`claimId`; unknown claim responses reuse it instead of leasing another message.
The attempt, quota reservation, message and token persist before provider IO.
Completion names the original attempt/token and records confirmed, known-no-send
or lost-result. Current authority and original worker ownership are required;
results are idempotent and conflicting acknowledgements fail. Pausing new work
does not prevent recording a result for an already issued local attempt.

`flushNotificationDelivery` retains its claim and writes `dispatching` before
invoking the injected provider. A restart from `dispatching` reports uncertain
rather than resending. It saves the provider result before ACK; an unknown ACK
retries that saved result without another provider call. Expiry and lost provider
results never silently requeue. Both D1 and the provider enforce recipient quota.
The dependency-injected MailApp wrapper preserves To/CC/Reply-To and SHAMROCK's
sender name. A normal MailApp return confirms API acceptance, not inbox delivery;
MailApp supplies no message receipt ID. No staging global binds MailApp or adds
mail OAuth scope, so this code sends no actual email during staging or imports.

The protocol/consumer/provider port have local regression tests, including frozen
request versions, retry/uncertainty, suppression, quotas and continuations. The native suppress-only host is implemented and tested through provider fakes.
Live Google installation, real provider delivery, account quotas and operational
notification parity remain separate live acceptance checks. See the
[MailApp API contract](https://developers.google.com/apps-script/reference/mail/mail-app)
and [D1 transactional batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/).


## Confirmed automatic Sunday closeout (migration 0009)

The user confirmed retention of automatic Sunday 17:00 closeout, including when
Flight reports are missing. The [closeout workflow](D1_SUNDAY_CLOSEOUT.md) now
appends policy-versioned A/U corrections in bounded atomic steps, preserving P/T,
pending R and existing approved outcomes. Its final weekly summary is based on
fresh facts after all steps, with the established Flight Commander/deputy routing.
Staging summaries remain terminal suppressed and no actual messages are sent.
Set the private maintenance `closeoutEnabled` flag only for a reviewed rehearsal;
when enabled it replaces the preliminary Sunday review with the closeout's final
summary. It does not change ordinary event-day or excusal task processing.
