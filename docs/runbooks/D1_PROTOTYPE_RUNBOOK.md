# D1 prototype: development and handoff

Status: isolated local and Cloudflare staging implementation, not a production replacement. The staging Worker/D1 passed a fictional API smoke test on 2026-11-05 and was left paused. The existing `src/`, Forms, Sheets, triggers and Apps Script deployment remain the supported operational system. Creating a shared Google/GitHub/Cloudflare account does not migrate existing resource ownership or install replacement Google automation.

The organization's private [SHAMROCK operations repository](https://github.com/afrotc-det225/shamrock-ops) now holds the handoff guide and placeholder configuration. The shared project GitHub account has verified repository admin access. This does not establish organization-owner status or Google/Cloudflare permissions; no live bindings or deployment workflows have been added.

Read the [redesign plan](../plans/D1_REDESIGN_AND_MIGRATION.md), [current-system audit](../plans/D1_CURRENT_SYSTEM_AUDIT.md) and [feature-parity matrix](../plans/D1_FEATURE_PARITY_MATRIX.md) for the full migration scope. The matrix describes proposed acceptance evidence; it is not a list of implemented tests.

## Run it locally

Use Node.js 26 and npm 11, matching the initial validated environment. No Google sign-in, Cloudflare account, GitHub subscription, AI service, `.env` file or production export is needed for these commands:

```sh
npm ci
npm run check
npm run demo:v3
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

## Code map and build separation

| Location | Responsibility |
|---|---|
| `src/` | Current Apps Script production code; existing namespace build |
| `packages/domain/src/index.ts` | Pure versioned command validation and attendance/excusal rules |
| `apps/worker/src/index.ts` | Signed HTTP operations, authorization, D1 persistence and projection jobs |
| `database/migrations/0001_prototype.sql` | Initial isolated SQL schema; no environment credentials or real records |
| `apps/google-adapter/src/index.ts` | Form mapping, frozen decision drafts, command journal and publication contracts |
| `apps/google-adapter/src/apps-script.ts` | Google service ports for signing, transport, Sheets journal and locks |
| `apps/google-adapter/src/staging-host.ts` | Paused staging intake, native source identity and versioned trigger setup |
| `apps/google-adapter/src/native-runtime.ts` | Live Google ACL/protection checks, literal Sheets API writes and private projection claims |
| `apps/google-adapter/src/projection.ts` | Stable keyed projection publication and read-back before job acknowledgement |
| `tests/v3/` | Domain, adapter, actual local D1 and cross-component regression tests |
| `scripts/lib/v3-local-scenario.mjs` | Reusable fictional integration scenario |

`npm run build:v3` uses TypeScript and esbuild. It writes ignored `.build/v3/` modules and `.build/v3-artifacts/worker.mjs`, `GoogleAdapter.js`, `appsscript.json`, and a checksum manifest marked `productionReady: false`. The Google artifact exposes versioned top-level staging entry points. Loading it performs no Google IO; explicit setup validates bindings and installs only the configured staging triggers, paused by default. It is separate from `dist/`; `npm run push` remains the existing production Apps Script deployment command and must not be used to install this prototype.

The local emulator uses its own pinned workerd release and a supported compatibility date. Local success does not establish production CPU time, real Google quotas, actual D1 daily usage or account entitlements. The [staging runbook](D1_STAGING_RUNBOOK.md) describes committed release preparation, an atomic initial migration, API provisioning and the fictional cloud smoke test. No production deployment or live Google consumer is configured.

## Implemented contract

Only `local` and `staging` environments are accepted. Both application configuration and the SQL control row must agree on the environment and generation, and the control row must allow commands. Unknown actors, revoked grants, unregistered sources, stale roster versions and stale decision versions fail closed.

The three commands are `attendance.report`, `excusal.submit` and `excusal.decide`. The Worker commits the command receipt, domain records, audit event and pending projection job together in one D1 batch. A failed assertion or later write rolls the batch back. Source identity and command identity prevent duplicate processing. Retrying uses the original frozen payload and ID; changing the payload under that ID is a conflict.

The prototype's trust boundary is the private standalone Google adapter. Its HMAC authenticates that adapter; it does not independently prove which human edited a sheet. The adapter must obtain human identity from trusted Google evidence and map it to an enrolled principal. It must never invent an editor from the trigger owner, a typed email, or a missing `e.user`. Current database grants are checked again when processing the command. The signing key must not be available to ordinary spreadsheet editors.

HTTP paths:

- `GET /health`: minimal configured-handler response, not a database readiness or complete system-health check.
- `POST /v1/commands`: submit a supported command.
- `GET /v1/commands/<commandId>?principalId=<principalId>`: retrieve a receipt for its currently authorized original actor.
- `POST /v1/jobs/claim`, `/v1/jobs/project`, `/v1/jobs/ack`: claim projection work, read its current facts and acknowledge the current claim.

All paths except health require a key ID, timestamp and HMAC-SHA256 signature over the HTTP method, path/query, timestamp and SHA-256 digest of the exact body. Replay tolerance is five minutes; command deduplication is independent of the signature timestamp. A fresh signature never gives an old payload a new command ID. Requests and responses must not be logged with personal data or signing material.

Complete attendance reports currently assert the entire active unit roster at the referenced roster version; partial reports may cover a subset. The stored covered roster and selected members are explicit. Presence evidence is append-only in this slice. Corrections, including removing a mistaken `P`, require a later explicit correction operation. Excusal requests remain independent of observed attendance. No attendance credit, percentage, final absence or notification-recipient policy is guessed.

This prototype requires exactly one active unit membership per person in an affected scope. Commands and projections reject ambiguous memberships. Membership movement, overlapping units, name changes and event/catalog changes need a reviewed revision and projection-job strategy before they can be supported. The current projection revision advances for the three implemented commands; direct database edits are not a supported directory workflow.

Interactive reports have a 500-member domain limit and a 64 KiB Worker request limit. The Google journal additionally bounds payload characters and retained entries, so some large-ID reports can reach a lower limit. Oversized workflows need a designed batch protocol; input is never silently truncated. Attendance writes use SQL JSON input sets and bounded statements rather than a query per person. This addresses per-request query growth, but quota and CPU headroom still need measurement in staging.

## Retry and publication behavior

The Google journal persists a command before dispatch. A timeout retains the same command for retry with a fresh signature. Conflicts and authorization failures become visible states requiring attention. Journal capacity exhaustion does not delete unsent work. Only trusted script maintainers may edit the journal workbook. Terminal-row archival and retention remain future operator procedures.

Projection jobs serialize by event/unit. An adapter must claim a job, fetch current D1 facts, write only the designated output cells, verify the published state and then acknowledge its claim. A receipt's `pendingEffects` flag describes the state at acceptance time; it is not a live indicator of whether the sheet has caught up.

The first slice deliberately does not reclaim an expired Google-publication lease automatically: an older Google request might still finish and overwrite newer output. A lost claim response or expired lease can therefore block that resource pending operator review. A safe recovery operation, visible backlog monitoring and real publication/read-back must be implemented before production. Do not clear leased rows or acknowledge uncertain output merely to make the queue look healthy.

## Remaining work before a Google staging rehearsal

1. Complete Google programmatic access and verify permissions and ownership. The SHAMROCK Cloudflare plugin connection and private repository admin access have been verified. Prefer APIs and command-line tools; use interactive login only where the provider requires it. Verify organization ownership separately from membership, account billing separately from API access, and Drive ownership separately from sharing.
2. Complete the private operations repository's logical resource bindings, access roles and secret names for the intended staging setup. Store actual signing material in provider secret stores and Script Properties; retain recovery material in the organization's password vault. Neither a private repo nor an `.env` handoff is a secret store.
3. Extend the initial staging release/migration tooling to subsequent schema versions, secret rotation, rollback and successor recovery. The current helper records hashes and the source commit, applies the initial migration atomically to an empty staging database, verifies matching repeat state and stops on unknown schema. It is not a general migration or repair engine.
4. Rehearse the implemented standalone host and native runtime against actual Google Forms and Sheets. Verify email collection, native item IDs, protections, account consent and installed trigger identity. Test human editor identity across the participating accounts. Missing identity still needs an authenticated confirmation flow that preserves the frozen target and payload.
5. Rehearse literal-value publication and read-back, protected fixed draft slots, durable claims, real concurrent edits/sorting and API failures. Full spreadsheet presentation, filter views, automated lease recovery and the complete workflow remain unfinished.

Current production account succession is a separate workstream. Follow the [account handoff runbook](ACCOUNT_HANDOFF_RUNBOOK.md); adding editor access or transferring file ownership does not transfer installable triggers.

Before migration/cutover, complete directory and leadership workflows, corrections, multi-event excusal expansion, notifications, reports/charts, imports/exports, term transitions, backups/restore, diagnostics and the rest of the parity matrix. The current unique source key supports one command per operation and native source revision; a multi-event response needs explicit child identities before multiple request commands can share that response. No production records have been imported or reconciled by this prototype.

Operational policy questions and approval to host the applicable records on Cloudflare remain production gates in the redesign plan. Continue developing engineering mechanisms with fictional data while resolving those gates. Ordinary attendance processing and spreadsheet filtering will not depend on AI availability or any maintainer's chat history.
