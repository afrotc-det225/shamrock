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
an absence. A weekly review does not silently assign U or describe an incomplete
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
