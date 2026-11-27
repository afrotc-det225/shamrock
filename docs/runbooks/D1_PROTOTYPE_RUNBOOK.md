# D1 prototype: development and handoff

For a production transition that retains the existing Google bookmarks, use the [in-place adoption rehearsal and cutover order](D1_PRODUCTION_CUTOVER.md).

Status: isolated local, Cloudflare and Google staging implementation, not a production replacement. The current source includes native Forms and spreadsheet workflows, real-data import/reconciliation tools, bounded current/historical reporting, reviewed operational administration, and independently gated maintenance consumers. Production remains on the supported `src/` Apps Script system. No D1 cutover is authorized by these capabilities or the staging results below.

Use the private operations record and live readback to establish each deployment's source, schema, bindings, gates and completed rehearsals. The dated milestones in this document retain their original evidence; their release pins, test counts and pause observations are not assertions about the current deployment. Authorized real-data staging uses a separate private dataset and suppresses operational recipients; fictional smoke fixtures remain separate.

The organization's private [SHAMROCK operations repository](https://github.com/afrotc-det225/shamrock-ops) holds the handoff guide and release evidence. The shared project GitHub account has verified organization-owner and repository-admin access; the production Google account handoff is complete. Successor access to the password vault still needs a custodian rehearsal. Actual staging bindings live in provider settings, outside either repository; no GitHub deployment workflow has been added.

Read the [redesign plan](../plans/D1_REDESIGN_AND_MIGRATION.md), [current-system audit](../plans/D1_CURRENT_SYSTEM_AUDIT.md) and [feature-parity matrix](../plans/D1_FEATURE_PARITY_MATRIX.md) for the full migration scope. The matrix describes proposed acceptance evidence; it is not a list of implemented tests.

**Full release acceptance remains unfinished.** The native frontend now covers Directory, Leadership, Attendance, Dashboard and Blue/Gold Excusals with production-style Tables, filters, compact sizing, validation, native file chips, charts and cell protections. The early [projection presentation layer](D1_PRESENTATION_RUNBOOK.md) is a retained technical rehearsal surface, not the current Main interface. The [presentation release gate](../plans/D1_REDESIGN_AND_MIGRATION.md#presentation-quality-is-a-release-gate) still requires current rendered and interaction evidence. Legacy dynamic slots preserve complete-row sort identity; the newer [native input runtime](D1_NATIVE_INPUT.md) uses protected physical bindings and verified confirmation when edit evidence is insufficient. Non-owner FilterView coordinates, denied physical moves and direct native trigger delivery require provider rehearsals before direct edit parity can be claimed.

## Current implementation and evidence boundary

| Capability in source | Current contract and remaining provider proof |
| --- | --- |
| Forms and Directory | Verified enrollment activates automatically; personal updates, manager review, actual photo URI checks, immutable choices and additive Attendance sections are implemented. Rehearse ordinary cadet accounts, branching and interrupted updates in the bound Google Forms. |
| Main and Blue/Gold | Keyed publication, pending-edit retention, exact command/receipt delivery, verified confirmation and specific cell protections are implemented. Establish direct native editing, sort/filter targeting and role turnover with real non-owner accounts; an API write is not an edit-trigger test. |
| Reporting/history | D1-derived Overall/LLAB, birthdays and Dashboard summaries use active-term reads; prior native terms and literal retained source reports have separate bounded readers. The private historical publisher retains unresolved source identities visibly. Verify complete hosted/native publication and retained values for the current dataset. |
| Administration | Reviewed CSV import/export, explicit bulk Attendance selectors, future event roster policies and resumable semester preparation are implemented. Every operational apply needs exact plan/version review and visible publication readback. |
| Notifications and recovery | Deterministic routing, duplicate prevention, automatic missing-report Sunday closeout, reviewed lease recovery and private archive/retention mechanisms are implemented. The optional MailApp rehearsal targets only the verified owner; operational recipients remain suppressed. Hosted failure, archive/restore and successor rehearsals must cover the final release. |

See [managed Forms](D1_MANAGED_FORMS.md), [native input](D1_NATIVE_INPUT.md),
[role permissions](D1_ROLE_PERMISSIONS.md), [paged reads](D1_PAGED_READS.md),
[historical reports](D1_HISTORY_REPORTS.md), [operational administration](D1_OPERATIONAL_ADMIN.md)
and [owner-only mail rehearsal](D1_OWNER_MAIL_REHEARSAL.md). These are implementation
contracts, not a replacement for the private acceptance record. In particular,
source tests do not prove hosted CPU limits, ordinary-account native behavior,
provider mail delivery, durable recovery or successor access.

## Verified live staging boundary

**Historical milestone 1, source `5e1057f4a13c45960e70844724aa5261e49f422e`:** the operator linked the staging script to its standard Google Cloud project and completed Import and Setup. Real attendance and excusal Form submissions committed through the Google journal into D1 and published back to protected Sheets. A complete two-person attendance report recorded only the selected member as `P`; the other observed code stayed blank. Redelivery of the identical saved native-response payload returned the original receipt without another command. The new excusal request remained `Submitted/E` at version `1`, preserving the existing `P` observation.

A separate owner-account `D3` edit denied a **preseeded** request at base version `2`, producing recorded version `3` with `google-edit` audit evidence. Its frozen input base and entered `Denied` value were preserved. At that release, the draft status incorrectly remained `Queued: Denied` after commit. Milestone 2 implements receipt-driven status reconciliation and verified `Committed: Denied` on its new dynamic-slot path. The retained historical fixed-slot tab was not reinterpreted or migrated. A queued label alone never establishes completion.

The three Google journal entries committed on their first attempts and their three projection jobs completed. Combined with earlier synthetic API smoke tests, that checkpoint held nine commands, nine audit records and nine completed jobs, with no unfinished jobs; output/cursor revision was `9` and integrity checks passed. The two uploaded script files matched that release. The host pause completed and was observed in the staging editor at the end of that rehearsal; this historical observation does not establish the pause after a later rehearsal. See the [staging checkpoints](D1_STAGING_RUNBOOK.md#verified-live-google-checkpoint) for the precise evidence and subsequent results.

This historical milestone did not establish full workflow parity. Authenticated confirmation and broader failure/recovery mechanisms have since been implemented; cross-domain editor evidence and the final integrated native behaviors still require explicit provider evidence. Newly submitted requests now have live-published dynamic slots and a verified owner-account decision retry; the exact original contention overlap was not reproduced after the fix. The OAuth **Testing** seven-day authorization caveat also remains a long-term automation consideration; see the [staging authorization guidance](D1_STAGING_RUNBOOK.md#standalone-google-staging-adapter).

For ongoing CSV imports/exports and reviewed bulk Attendance corrections, use the
[operational administration tools](D1_OPERATIONAL_ADMIN.md); these are separate
from the one-time migration loader and preserve original history.

## Run it locally

Use Node.js 26 and npm 11, matching the initial validated environment. No Google sign-in, Cloudflare account, GitHub subscription, AI service, `.env` file or production export is needed for these commands:

```sh
npm ci
npm run check
npm run demo:v3
npm run capacity:v3
```

`check` builds and tests the current Apps Script source, then builds and tests the isolated v3 packages. `demo:v3` creates a temporary local D1 database, runs a fictional attendance/excusal scenario through the actual bundled Worker and Google adapter contracts, prints the results and disposes the database. It does not contact Google or a Cloudflare deployment. npm installation requires network access; the scenario itself does not.

The demonstration verifies:

1. A Form response maps immutable choices and a verified test principal into a signed attendance command.
2. Repeating the same command returns its original receipt, without duplicate observations or audit records.
3. A single-event excusal request and a spreadsheet decision produce an approved request while the original `P` observation remains intact.
4. An edit based on an old request version receives a conflict; a tampered signature is rejected; missing editor identity leaves a draft awaiting confirmation.
5. The adapter claims current projections and acknowledges their publication to an in-memory output port. Publishing recorded decisions preserves a pending draft and its original base version.

The result should show three committed commands, three audit entries, one attendance report, one presence observation, one decision and three completed projection jobs. The second fictional member has no observed code; the prototype does not infer an absence from nonselection. No live Google rendering is exercised by this demonstration.

If npm blocks dependency installation scripts, inspect its reported packages and approve only the esbuild/workerd versions recorded in `package.json`; never disable installation-script protections globally. The dependency lock includes temporary patch overrides for Miniflare's `undici` and `sharp` dependencies. Reassess these when upgrading Miniflare, run the entire local suite and `npm audit`, and remove the overrides when the upstream dependency graph no longer needs them.

## Second implementation milestone

This slice adds atomic multi-event excusals, projection-created spreadsheet decision slots, receipt-driven draft delivery status, and versioned staging schema upgrades. The version 2 migration and multi-event intake have now passed an isolated live rehearsal using source `23edbfabcde2b16f8b5cb894fd4b4ea814bb0cd1`. These results do not establish full feature parity.

One real Google Form response saved one parent command with two event-specific child requests, one audit record and two publication jobs. Google publication populated dynamic decision slots for the new requests and completed both jobs. All nine previous command receipts were preserved, leaving ten commands, ten audit records and eleven completed jobs. The migration's exact schema/hash ledger, paused control and integrity checks passed. Before the upgrade, the actual SQL export was restored and checked in disposable **in-memory SQLite**; no hosted D1 or Time Travel restore was tested.

A native sheet decision attempted while a scheduled flush held the adapter lock failed before creating a database command. Fix `6202646bf68d94f0c7e64916d6f646aca16bff5e` adds bounded waiting and attempts a visible retry note for capture contention, while retaining the original event identity and payload. Its 199-test suite passed (31 current-system regressions and 168 v3 tests), and the two uploaded Google files were verified against that release. The live retry committed `Denied` with `google-edit` audit evidence and displayed `Committed: Denied`. This did not reproduce the exact earlier contention overlap.

Publication initially received a non-200 Google API response; the HTTP status was not exposed by that release, so the cause remains unknown. The adapter retained the claim, and a scheduled flush completed publication before the lease expired. A subsequent manual flush was a no-op. The new immutable version 2 slot was appended while the original version 1 row, frozen input and original `P` observation were preserved. Final totals were eleven commands, eleven audit records and twelve completed jobs, with no unfinished jobs; all five Google journal entries were committed. D1 integrity and foreign-key checks passed, its fence was verified, and the Google host pause completed at 20:46 local time. See the [staging checkpoint](D1_STAGING_RUNBOOK.md#milestone-2-migration-and-multi-event-intake) for the release split and evidence limits.

Diagnostic-only follow-up `9ca5ce2` adds safe HTTP-status reporting without changing claim or retry behavior. Its full local suite passed 201 tests (31 current-system regressions and 170 v3 tests). The live outcomes above were tested on `6202646`; later deployment verification and the final release pin belong in the private operations record.

`excusal.submitMany` saves one native submission with up to 25 explicit event/request children, one receipt/audit and a publication job for each event. Child identity does not depend on selection order. One invalid event, collision or failed write rolls back the entire command. Each child can then receive its own version-checked decision. Original attendance evidence remains separate. The single-event command remains supported with its corresponding Form binding.

Projection-mode decision inputs append a protected slot for each request/version. Existing slots, captured payloads and draft cells are retained. Complete-row sorting preserves protected origin/context metadata and saved drafts; partial row moves fail identity verification and require review. Journal reconciliation displays committed, conflict, rejected or attention states instead of leaving completed decisions labelled queued. A bounded slot allocation can stop with a visible capacity error; it never deletes old drafts to make room. See the [adapter contract](../../apps/google-adapter/README.md) for configuring a new staging tab; do not reinterpret an existing fixed-slot tab as the new schema.

The release tools now support ordered additive migrations with a hash ledger, exact schema and paused-generation guards, recovery evidence and one atomic version upgrade at a time. They refuse unexplained schema drift and never enable command processing. This is staging tooling, not an automatic rollback or production migration engine.

### Free-tier capacity evidence

`npm run capacity:v3` executes the real bundled Worker handler against disposable local D1 with 500 fictional people, a 25-event excusal, a decision and 27 publication jobs. It reports database calls, SQL/parameter maxima and local row counters without printing SQL values, identities or credentials. It performs no cloud requests or account changes. The harness runs the handler in Node and SQL in Miniflare; it does **not** measure hosted Worker CPU, Google runtime or actual billing.

The test found and removed a correlated roster scan: the 500-person attendance fixture fell from 130,769 to 7,019 locally counted rows read. Its regression budget is below 20,000 local rows read. The measured fixture requests use at most five D1 calls each; a transactional batch counts as one call. Future features must keep these checks and add representative hosted measurements, retries, scheduled work and a multi-year retention forecast before cutover.

Comparison limits were checked on 2026-11-05: [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) allows 100,000 requests/day and 10 ms CPU per invocation; [D1 Free pricing](https://developers.cloudflare.com/d1/platform/pricing/) includes 5 million rows read/day and 100,000 rows written/day. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) include 50 queries per invocation, 100 bound parameters per statement and 500 MB per database. Index writes count toward usage. These are provider limits, not reserved application capacity or a promise of permanent pricing. No paid service, subscription upgrade or GitHub paid feature is introduced. The SHAMROCK dashboard was verified on 2026-11-05 to show **Free — $0 — Current plan**, and the D1 page showed the corresponding hard limits. This closes the earlier account-plan evidence gap; the OAuth billing endpoint itself remains unavailable. No subscription was changed.

## Code map and build separation

| Location | Responsibility |
|---|---|
| `src/` | Current Apps Script production code; existing namespace build |
| `packages/domain/src/index.ts` | Pure versioned command validation and attendance/excusal rules |
| `apps/worker/src/index.ts` | Signed HTTP operations, authorization, D1 persistence and projection jobs |
| `database/migrations/` | Ordered isolated SQL schema and additive migrations; no environment credentials or real records |
| `apps/google-adapter/src/index.ts` | Form mapping, frozen decision drafts, command journal and publication contracts |
| `apps/google-adapter/src/apps-script.ts` | Google service ports for signing, transport, Sheets journal and locks |
| `apps/google-adapter/src/staging-host.ts` | Paused staging intake, native source identity and versioned trigger setup |
| `apps/google-adapter/src/native-runtime.ts` | Live Google ACL/protection checks, literal Sheets API writes and private projection claims |
| `apps/google-adapter/src/projection.ts` | Stable keyed projection publication and read-back before job acknowledgement |
| `tests/v3/` | Domain, adapter, actual local D1 and cross-component regression tests |
| `scripts/lib/v3-local-scenario.mjs` | Reusable fictional integration scenario |

`npm run build:v3` uses TypeScript and esbuild. It writes ignored `.build/v3/` modules and `.build/v3-artifacts/worker.mjs`, `GoogleAdapter.js`, `appsscript.json`, and a checksum manifest marked `productionReady: false`. The Google artifact exposes versioned top-level staging entry points. Loading it performs no Google IO; explicit setup validates bindings and installs only the configured staging triggers, paused by default. It is separate from `dist/`; `npm run push` remains the existing production Apps Script deployment command and must not be used to install this prototype.

The local emulator uses its own pinned workerd release and a supported compatibility date. Local success does not establish production CPU time, real Google quotas, actual D1 daily usage or account entitlements. The [staging runbook](D1_STAGING_RUNBOOK.md) describes committed release preparation, an atomic initial migration, API provisioning, the fictional cloud smoke and the separate live Google rehearsal. The Google consumer is configured only for the isolated staging resources; no production replacement has been deployed.

## Operational terminology

Use **Flight** for attendance reporting scope. Flights belong to squadrons within the wing. Operator-facing Sheets, Forms and instructions use the actual echelon—Flight, Squadron or Wing—not the generic label “Unit.” The Directory hierarchy, Blue/Gold queues, reporting and authorization use explicit Flight/Squadron mappings; an individual attendance command still has one Flight scope.

Existing `unit_id`, `unit_label`, `unitId` and related schema/API keys are internal compatibility names. They remain stable for saved commands, claims, projections and migration history; this presentation correction does not rewrite those identities or payloads.

## Implemented contract

Only `local` and `staging` environments are accepted. Both application configuration and the SQL control row must agree on the environment and generation, and the control row must allow commands. Unknown actors, revoked grants, unregistered sources, stale roster versions and stale decision versions fail closed.

The operational command family includes `attendance.report`, `excusal.submit`, `excusal.submitMany` and `excusal.decide`. [Administrative commands](D1_ADMIN_COMMANDS.md), verified Directory self-service, corrections, permissions, reviewed roster policies and transitions have separate validated routes and audit contracts. The Worker commits the command receipt, domain records, audit event and pending projection job together in one D1 batch. A failed assertion or later write rolls the batch back. Source identity and command identity prevent duplicate processing. Retrying uses the original frozen payload and ID; changing the payload under that ID is a conflict.

The prototype's trust boundary is the private standalone Google adapter. Its HMAC authenticates that adapter; it does not independently prove which human edited a sheet. The adapter must obtain human identity from trusted Google evidence and map it to an enrolled principal. It must never invent an editor from the trigger owner, a typed email, or a missing `e.user`. Current database grants are checked again when processing the command. The signing key must not be available to ordinary spreadsheet editors.

HTTP paths:

- `GET /health`: minimal configured-handler response, not a database readiness or complete system-health check.
- `POST /v1/commands`: submit a supported command.
- `GET /v1/commands/<commandId>?principalId=<principalId>`: retrieve a receipt for its currently authorized original actor.
- `POST /v1/jobs/claim`, `/v1/jobs/project`, `/v1/jobs/ack`: claim projection work, read its current facts and acknowledge the current claim.

All paths except health require a key ID, timestamp and HMAC-SHA256 signature over the HTTP method, path/query, timestamp and SHA-256 digest of the exact body. Replay tolerance is five minutes; command deduplication is independent of the signature timestamp. A fresh signature never gives an old payload a new command ID. Requests and responses must not be logged with personal data or signing material.

Complete attendance reports assert the entire active Flight roster at the referenced roster version; partial reports may cover a subset. Stored covered rosters and selected members are explicit. Presence evidence remains append-only; the implemented `attendance.correct` operation can supersede a mistaken `P` while retaining its original evidence. Excusal requests remain independent of observed attendance. [Reporting rules](D1_REPORTING_RULES.md), [recipient planning](D1_NOTIFICATIONS.md) and [Sunday closeout](D1_SUNDAY_CLOSEOUT.md) document the extracted operational policies, including automatic closeout when a Flight report is missing.

This prototype requires exactly one active flight membership per cadet in an affected scope. Commands and projections reject ambiguous memberships. Directory commands implement Flight reassignment and name changes with versioned membership/profile history and refresh effects. Reviewed future-event policies coalesce relevant changes before advertising new eligibility. Simultaneous active memberships remain rejected; direct database edits are not a supported Directory workflow.

Interactive reports have a 500-member domain limit and a 64 KiB Worker request limit. The Google journal additionally bounds payload characters and retained entries, so some large-ID reports can reach a lower limit. Oversized workflows need a designed batch protocol; input is never silently truncated. Attendance writes use SQL JSON input sets and bounded statements rather than a query per person. This addresses per-request query growth, but quota and CPU headroom still need measurement in staging.

## Retry and publication behavior

The operational Worker returns `503 SERVICE_LIMIT_REACHED` with `Retry-After`
until the next midnight UTC when D1 reports its explicit daily row read/write
limit. It does not retry or log the provider error. This classification happens
before the raw error is sanitized, so the panel can pause automatic reads without
confusing database capacity with Google sign-in. Storage limits, SQL failures and
transient connection errors are not classified as daily exhaustion. See
[Cloudflare's D1 error reference](https://developers.cloudflare.com/d1/observability/debug-d1/).
Other unexpected record-read failures use loading guidance; mutation failures
retain receipt-check guidance. A quota response is not proof that an earlier
step of a resumable operation did not commit: retain the saved command ID and
reconcile its receipt before retrying after capacity returns.

The Google journal persists a command before dispatch. A timeout retains the same command for retry with a fresh signature. Conflicts and authorization failures become visible states requiring attention. Journal capacity exhaustion does not delete unsent work. Only trusted script maintainers may edit the journal workbook. The newer Forms/input journals support [reviewed private retention](D1_PRIVATE_RETENTION.md) of verified terminal work while retaining pending/conflicting entries. The original projection journal is a separate bounded transport and must not be cleared as if it used that compactor; deployment and live recovery evidence remain separate checks.

Projection jobs serialize by event/flight. An adapter must claim a job, fetch current D1 facts, write only the designated output cells, verify the published state and then acknowledge its claim. A receipt's `pendingEffects` flag describes the state at acceptance time; it is not a live indicator of whether the sheet has caught up.

The current prototype deliberately does not reclaim an expired Google-publication lease automatically: an older Google request might still finish and overwrite newer output. A lost claim response or expired lease can therefore block that resource pending operator review. Normal publication/readback passed the narrow historical rehearsal. An [explicit effect recovery operation](D1_FRONTEND_RUNTIME.md#explicit-programmatic-recovery) now renews only the reviewed retained claim; it does not automatically reclaim expired leases. Current backlog and live failure exercises still need release-specific evidence. Do not clear leased rows or acknowledge uncertain output merely to make the queue look healthy.

## Historical engineering checkpoint

### November 6 engineering checkpoint

The normal Main and Excusals staging workbooks now use the intended operational
canvas: a compact Dashboard, six resolved actions, calculated Overall/LLAB
percentages, four visible Main tabs and Blue/Gold decision tabs. Test disclaimers
and inactive preview buttons have been removed from the user-facing sheets.
The environment remains identifiable in the file titles.

The [protection model](D1_PROTECTION_MODEL.md) passed 19 real non-owner API probes,
including role revocation while workbook editing permission remained. Fresh
presentation read-back verified all 570 validation cells, 16 fictional photo
file chips, five native Tables, four charts and unchanged private sharing.
These checks establish native cell permissions and presentation; they do not
establish delivery of edits from the replacement Main/Blue/Gold sheets to D1.

A fresh version 2 staging export was restored into a separate hosted D1 database.
Every record matched the paused source across all 21 tables; `quick_check` passed
and `foreign_key_check` returned no violations. The source database was unchanged.
This demonstrates hosted restoration of the fictional checkpoint, not recovery
after an unknown production write or successor access to recovery material.

The detached restore then passed guarded upgrades through schema version 5.
The source staging database subsequently passed the same upgrades with fresh
export/restore evidence at each step. Every original business/control record
and original migration entry was preserved; the shared registry contains the
12 original commands. Both databases remain paused at generation 1, with
integrity checks passing and notifications suppressed with a zero-recipient
budget. Migrations 1–5 have now been applied and must not be edited.

The staging Worker from `cd7ffad` and Google adapter from `34a157c` were uploaded
and read back exactly. The native publisher remains disabled: initializing its
private baselines and completing signed live publication are still pending.
Local checks passed 370 tests, including 31 current-system regressions and 339
prototype tests. No new Main or Blue/Gold edit-command capture is claimed.

The initial compact Attendance layout was superseded after measuring production
directly: uniform 75-pixel event/percentage columns, 115-pixel name columns,
21-pixel rows, 10-point body text and 5-point wrapped event headers. The same
layout applies to new rows/events without resizing existing cells. Native colors,
validation, Tables, saved views and cell protections remain separate preserved
metadata. See the private release evidence for the live read-back checkpoint.

New source modules cover [administrative commands and corrections](D1_ADMIN_COMMANDS.md),
[attendance and birthday reporting](D1_REPORTING_RULES.md),
[notification planning](D1_NOTIFICATIONS.md),
[owner-only native mail rehearsal](D1_OWNER_MAIL_REHEARSAL.md),
[keyed frontend publication](D1_FRONTEND_PUBLICATION.md) and its
[Google runtime](D1_FRONTEND_RUNTIME.md). Source completion, local tests and
hosted deployment are separate evidence. Check the private release record for
the actual deployed Worker, schema and Google source before resuming anything.

## Remaining integrated release checks

1. Keep each isolated environment paused between controlled rehearsals and record fresh source/schema/gate readback. Test ordinary cadet and leadership identities, specific allowed/denied cells and role revocation; verify native triggers separately from API permissions.
2. Rehearse successor access to the organization, provider accounts, password vault and private recovery files. Validate the OAuth authorization arrangement over time. An existing production account handoff is not proof that another custodian can recover the D1 system.
3. Extend hosted restoration to the final schema and real-data staging checkpoint, including pending work, accepted writes, secret rotation and exact post-restore comparisons. Retain historical restore evidence without treating it as proof for later schemas.
4. Exercise immutable target binding through FilterView sorting, delayed handlers, missing identity, verified confirmation, simultaneous edits and publication. The confirmation implementation exists; direct non-owner native editing needs its own evidence.
5. Complete current-dataset end-to-end Form, matrix, Blue/Gold, Directory/photo, event/choice, reporting/history, archive and transition checks. Confirm pending edits and native Tables/styles/protections survive interruption and recovery.
6. Measure hosted Worker CPU, database reads/writes/storage, Google quotas and repeated daily/weekly work. Verify owner-only mail API acceptance and inbox receipt separately while keeping operational recipient delivery suppressed.

Current production account succession is a separate workstream. Follow the [account handoff runbook](ACCOUNT_HANDOFF_RUNBOOK.md); adding editor access or transferring file ownership does not transfer installable triggers.

Before migration/cutover, close every feature-parity acceptance gate against the integrated release, not just individual modules. Private real-data capture, occurrence reconciliation, operational adoption and retained history are supported staging workflows; their evidence does not authorize replaying old human actions, sending historical notifications or moving production authority. Current source limits and any unresolved operational ambiguities must remain explicit in the acceptance record.

Operational policy questions and approval to host the applicable records on Cloudflare remain production gates in the redesign plan. Use fictional data for destructive/failure fixtures and the separately authorized private real-data staging dataset for import and presentation parity; keep production unchanged while resolving those gates. Ordinary attendance processing and spreadsheet filtering will not depend on AI availability or any maintainer's chat history.

Future roster policy and operator create/update helpers are documented in
[reviewed future event rosters](D1_EVENT_ROSTERS.md).

Audited Flight/Squadron catalog changes and submitted Excusal ownership are described in [D1_ORGANIZATIONAL_CATALOG.md](D1_ORGANIZATIONAL_CATALOG.md).
