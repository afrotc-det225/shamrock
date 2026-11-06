# Reviewed term transitions in isolated D1

Migration `0006_transition_and_delivery_workflows.sql` adds resumable semester
and academic-year preparation. It changes neither current production entry
points nor applied migrations 1–5. The implementation has local D1 and adapter
port tests; it has not run against Google or a hosted database. Keep the staging
host and notifications suppressed until a separate reviewed integration run.

## Operational policy and review

Both transition kinds preserve people and assignments by default. The caller
supplies explicit source and target terms, a review reason, a validated schedule
and only the person changes actually approved. Each change carries the person's
current Directory version and complete proposed AS year, rank, role, Flight and
Flight Path status. A missing person in the change list is preserved.

`suggestAcademicProgression` carries forward the production mapping only as a
review suggestion: AS100→AS200, AS150→AS250, AS200/250→AS300 and AS300→AS400.
Inactive, dropped, commissioned and exceptional years are preserved. AS400 does
not automatically become Commissioned. No automatic assignment clear occurs.
The source defaults are `src/services/transition.ts`; they are not regulatory
proof. Explicitly review commissioning, rank, assignment and exceptional-status
changes before accepting a proposal.

The schedule has no silent weekday/week-count defaults. Supply a real first
Sunday, first training week, 1–20 weeks, and separate Mando/LLAB weekday, hour,
minute and duration. Training weeks stay within 1–99. Local wall times use
`America/Indiana/Indianapolis`; nonexistent or ambiguous DST times are rejected.
Each week produces Mando PT, Secondary PT and LLAB in that order. Secondary
covers Sunday 00:00 through Saturday 23:59. These preserve the current source's
three-event convention, with all mapped Flights and an explicit eligible roster
of operational cadets. Preview those generated scopes and dates before approval.
One-off events remain separate reviewed event commands.

## Commands and authority

All routes are signed POST JSON operations using the existing bridge protocol.
A current principal must have an active entry in `transition_authorities`.
This narrow grant is independent of ordinary roster/event editing. Preparation
also requires the existing Wing `frontend.read` grant to obtain the coherent
source snapshot. Commands recheck registered source, principal, generation and
command fence atomically. No API grants its own transition permission.

`/v1/admin/transitions/commands` uses the standard command envelope and one of:

- `transition.prepare`, payload `{plan}`. The plan includes `transitionId`,
  `kind: 'semester' | 'academic-year'`, `sourceTermId`,
  `targetTerm: {termId,label,sortOrder}`, `policyVersion: 'explicit-term-review-v1'`,
  `reviewReason`, `people` and `schedule`.
- `transition.accept`, `transition.cancel` or `transition.complete`, payload
  `{transitionId,expectedVersion,planHash}` from the reviewed status/receipt.

The server stores the exact normalized plan hash and a coherent source snapshot
hash. Cancellation is allowed before acceptance; it does not change people or
the current term. Changing an already frozen proposal requires cancellation and
a new transition identity. Receipts are idempotent and recheck current authority.
Global command registry and source uniqueness prevent cross-family collisions.

`/v1/admin/transitions/status` takes
`{environment,generation,principalId,transitionId}` and returns the plan, version,
state, archive status and refresh dependencies. It stays readable while paused.
Do not infer completion from a command's original `pendingEffects` receipt.

## Durable workflow and archive contract

States are `proposed → archiving → ready → publishing → complete`; unaccepted
states may become `cancelled`. Only one unfinished proposal may be prepared at
a time, and active leases on existing publication jobs block preparation or
acceptance. New commands after the snapshot invalidate acceptance; cancel and
prepare a fresh proposal instead of applying stale people/event state.

The private archive consumer claims
`/v1/admin/transitions/archive/claim` with environment, generation, principal,
worker and transition identity. It receives the immutable source snapshot and
its hash with a bounded lease. A stable transition binding must identify the
same archive on retry. An expired archive claim may be renewed because every
write is constrained to that same immutable snapshot; the archive provider must
never overwrite a different hash or create duplicate files after an unknown
creation result. This is different from mutable frontend publication leases.

The injected `TransitionArchivePorts` provider performs bounded writes and
returns either a durable continuation or final completion. It must verify a
private, protected, values-only archive against the hash. Only then may the
consumer ACK with the original claim and proof. The Worker records the principal,
worker, hash and archive receipt. A continuation or failed protection/read-back
never advances the workflow. Lost ACKs reconcile the verified stored completion,
including after lease expiry. The current implementation provides the provider
contract and consumer; a native Google archive binding is still required and
must pass real ACL/content checks. Hidden tabs alone are not private storage.

Acceptance rechecks archive completion and the exact reviewed source revisions,
then atomically changes the current term, applies only explicit person changes,
keeps previous membership and profile history, saves old/new term rosters and
creates the reviewed events and immutable event rosters. It closes old-event
intake without deleting old attendance, requests, decisions or event history.
Manual Leadership contacts remain intact. Generated events receive individual
registered child receipts/audits in the same transaction, preserving event-roster
command identity. Any failed write rolls back the entire acceptance.

The accepted workflow remains `publishing`. It enqueues one `frontend.refresh`
and one `forms.refresh` effect. `transition.complete` succeeds only after both
normal consumers have verified their work and marked those exact effects done.
A Form rebuild continuation is never a completion receipt. Retrying does not
advance AS years or recreate events a second time. There is no automatic purge
of archives or history; a retention/cleanup policy is separate from this flow.

## Bounds and recovery

Plans cover at most 500 explicit changes and 60 generated events; the existing
64-KiB HTTP request bound also applies. Large plans must be reduced to a reviewed
supported scope, not split into independently accepted transitions. Snapshots
are bounded to 1.5 MB. Mutations use set-based JSON SQL rather than one query per
person/event. A 60-event acceptance measured 30 prepared statements locally, below the 50-query per-invocation budget. This does not measure hosted CPU, daily rows or sustained capacity; record those before activation.

A failed archive retains its continuation and stable source hash. A stale plan
requires a new reviewed preparation. An accepted transition has no automatic
rollback: preserve its receipt/history, keep operational inputs fenced if its
publication fails, and resume the same normal consumers. Reverting code alone
does not restore a prior term. A reviewed data restore requires a verified backup
and proof that accepted writes are not discarded.

Weekly blank→absence or denied→unexcused finalization, its deadline and its
responsible reviewer remain operational policy questions. Neither transitions
nor notification planning invent those attendance facts.
