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

The server stores the exact normalized plan hash and an immutable capture descriptor hash. The assembled snapshot hash is recorded separately after the native archive verifies all source pages and protected output. Existing whole-JSON snapshots keep their original hashes. Cancellation is allowed before acceptance; it does not change people or
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
worker and transition identity. It receives an immutable capture descriptor and its hash with a bounded lease. The native consumer reads the descriptor’s frozen pages, verifies each hash and reconstructs the source snapshot before any archive write. Existing whole-JSON claims retain their earlier response shape. A stable transition binding must identify the
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
including after lease expiry. The native Google host below implements the provider with an explicitly bound
private workbook. Local provider tests are not evidence of live Google behavior.
Hidden tabs alone are not private storage.

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

The confirmed Sunday policy automatically finalizes blanks as A and unresolved
denials as U at 17:00 Indianapolis, including missing Flight reports. The
[separate closeout workflow](D1_SUNDAY_CLOSEOUT.md) preserves presence and pending
requests, records causal corrections and must finish before term preparation or
acceptance. Transition commands themselves do not manufacture attendance facts.

## Native staging maintenance host

The optional `SHAMROCK_V3_MAINTENANCE_CONFIG` is a JSON string in the existing
private configuration file. It stays file-owned, rather than being copied into
Script Properties. Import pauses intake, frontend publication and maintenance;
resuming either of the other consumers does not resume maintenance. The existing
flush invokes suppressed notification planning only when maintenance is enabled.
No additional trigger, Google file, MailApp binding or mail OAuth scope is created.

The strict binding contains `version: 1`, `environment: 'staging'`, the current
`generation`, `enabled`, optional `closeoutEnabled` (default false), the exact review marker
`EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING`, `principalId`, `workerId`,
`sourceResource`, `stateFileId`, `archiveSpreadsheetId` and `archiveExpectedTitle`.
The resources must already exist, be separate from current frontends and transport
storage, and belong only to the executing automation account with owner-only
permissions. The title must identify staging. The state JSON starts with
`{version:1, environment:'staging', generation:CURRENT_GENERATION}`. Keep actual
bindings outside Git. The archive is a private operations workbook, not an extra
visible tab in the normal Main or Excusals frontend.

Versioned entry points:

- `shamrockV3StagingMaintenancePause()` and `MaintenanceResume()` control only this
  consumer. Resume validates all resource bindings and sharing; it does not open
  Forms, resume D1 or enable mail.
- `shamrockV3StagingNotificationsPlan()` runs the bounded suppressed planner.
- `shamrockV3StagingTransitionCommand({commandId,operation,payload})` signs the
  reviewed command. It requires the actual active Google user to be the intended
  automation account; a scheduled trigger's effective identity is insufficient.
- `shamrockV3StagingTransitionArchive(transitionId)` advances one saved chunk.
  Repeat the same invocation while its state is `continuing` or `verifying`.
  No acceptance or completion command is silently invoked.

Each transition has deterministic Directory, Leadership, Attendance, Excusals and
recovery tabs in the archive workbook. Each uses a native Table, stable machine
headers, display headers and a strict whole-sheet protection. The recovery tab
is hidden for presentation, while owner-only file sharing supplies privacy.
The values come from the frozen D1 snapshot, not from a possibly lagging frontend.
Recovery rows retain the exact JSON plus snapshot/plan hashes, frozen local date
and reporting-policy version. Photos archive their URI as a literal value; active
file chips, validation and editable inputs are not duplicated into historical
values-only tables. Existing history is never deleted.

The writer handles at most 50 ordinary rows or ten recovery rows per call and
persists its cursor under the ScriptLock. Read-back is independently resumable
with the same bounds, inspects `userEnteredValue` and rejects formulas. It pins
the archive's Drive revision across verification and rechecks all Tables,
protections and complete ACLs. Revision drift stops for review, not automatic
rewriting. Drive files are not technically immutable: the owner can still change
them, so the checks detect drift rather than claiming an unchangeable provider.
An ambiguous write reuses the same tab identity and chunk. A lost ACK retries
verification without writing a second archive. Checkpoint storage has a 2-MB bound
and each provider request is bounded; oversized snapshots stop without truncation.

Local native-host tests cover default pause, active-user identity, owner-only
sharing, ambiguous writes, literal grid read-back, native Tables, resumable
verification, formula injection and revision drift. Live OAuth, Google Table
creation/rendering, permissions, recovery and real-data historical reporting
still require a separately reviewed staging rehearsal before parity is claimed.


Native archive date and percentage columns retain explicit date/percentage number
formats after Table creation. Private checkpoint persistence compares canonical
JSON content before writing and reads back the uploaded content plus fresh
owner/ACL metadata afterward. A delayed metadata-only Drive version increase is
not treated as a conflicting content edit. Changed content still fails before
overwrite. These are content/concurrency checks under the host's ScriptLock,
not a claim that Drive offers atomic version compare-and-swap. The archive's
separate multi-chunk verification still stops on provider revision drift.

## Bounded preparation and frozen page transport

Migration0012 adds an immutable preparation/page journal and transition binding. It does not rewrite earlier proposals, accepted transitions, archived snapshots or hashes.

A new `transition.prepare` command must first complete its bounded capture. Send the same command envelope to `/v1/admin/transitions/prepare/begin`. The response contains `preparation: {commandId,state,sequence}` (or the already committed receipt on an authorized retry). Repeatedly POST `{environment,generation,principalId,commandId,expectedSequence}` to `/v1/admin/transitions/prepare/step`, using the returned sequence until state is `complete`; then submit the original envelope to `/v1/admin/transitions/commands`. The command and reviewed plan remain unchanged throughout.

Each capture invocation freezes one frontend data page, or calculates one training week’s three events after the data pages are complete. It never reads the full attendance snapshot in one Worker invocation. Preparation, source revisions, the registered adapter and current transition authority are rechecked on every write. The final committed transition still requires no competing proposal, publication lease or active closeout. Capture itself creates no operational command, term, event, notice or publication effect. Immutable page receipts make a lost response resumable at the same sequence.

A source change during capture invalidates that draft. Abandon an unconsumed draft through `/v1/admin/transitions/prepare/abandon` with environment, generation, principalId and commandId, review the new source, and use a new command identity. Abandonment retains captured evidence; it cannot erase a consumed transition. Four unfinished drafts per actor and32 total retained preparations bound accidental accumulation. There are at most512 data pages and5MiB of captured page content per preparation; weekly event material is separately bounded to20 pages of256KB. A capacity failure requires explicit retention review, never silent deletion of archived evidence.

New archive claims return `snapshotTransport` with contract version `transition-snapshot-pages-v1`, `descriptorHash`, and initially `snapshotHash: null`. The descriptor binds the coherent frontend manifest, ordered page hashes and final verification. Read each page through `/v1/admin/transitions/archive/page` using the normal claim identity plus `sequence`. This is a read-only, lease-bound operation. The pure `assembleTransitionSnapshot` helper verifies the descriptor and every page, reconstructs the original frontend snapshot and computes `assembledSnapshotHash` over its exact JSON. A descriptor digest is **not** a historical snapshot digest.

The native consumer retains the assembled snapshot and its hash before writes, checks that hash when resuming, and includes both `descriptorHash` and the actual `snapshotHash` in the protected/private/values-only archive ACK. The Worker verifies the descriptor binding and records the adapter-verified assembled hash separately; later retries must use the same hash. Previous whole-JSON archive claims and proofs retain their original behavior.

Final acceptance uses the frozen Directory/term/flight policy catalog and prepared event pages. SQL consumes those prepared event rows directly inside the existing atomic acceptance transaction; the Worker does not deserialize and repeat all historical attendance or event roster IDs. Training schedule rules and daylight-saving validation remain the same. This preserves the old term, its attendance and requests, and creates the new term only after archive verification.

Synthetic and private local real-data rehearsals validate this protocol. Hosted CPU, native chunk assembly and full archive readback must pass separately before claiming a real-data transition ready; local timings include SQLite work and are not a Cloudflare Free-tier CPU measurement.
