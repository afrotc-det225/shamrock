# D1 prototype: development and handoff

Status: isolated local implementation, not a production replacement. The existing `src/`, Forms, Sheets, triggers and Apps Script deployment remain the supported operational system. This prototype contains fictional fixtures only. Creating a shared Google/GitHub/Cloudflare account does not migrate resource ownership or install this code.

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
| `tests/v3/` | Domain, adapter, actual local D1 and cross-component regression tests |
| `scripts/lib/v3-local-scenario.mjs` | Reusable fictional integration scenario |

`npm run build:v3` uses TypeScript and esbuild. It writes ignored `.build/v3/` modules and `.build/v3-artifacts/worker.mjs`, `GoogleAdapter.js`, and a checksum manifest marked `productionReady: false`. The Google artifact exports the `SHAMROCKV3` namespace but registers no trigger. It is separate from `dist/`; `npm run push` remains the existing production Apps Script deployment command and must not be used to install this prototype.

The local emulator uses its own pinned workerd release and a supported compatibility date. Local success does not establish production CPU time, real Google quotas, actual D1 daily usage or account entitlements. There is no deployment configuration or cloud provisioning command in this first slice.

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

Interactive reports have a 500-member domain limit and a 64 KiB Worker request limit. The Google journal additionally bounds payload characters and retained entries, so some large-ID reports can reach a lower limit. Oversized workflows need a designed batch protocol; input is never silently truncated. Attendance writes use SQL JSON input sets and bounded statements rather than a query per person. This addresses per-request query growth, but quota and CPU headroom still need measurement in staging.

## Retry and publication behavior

The Google journal persists a command before dispatch. A timeout retains the same command for retry with a fresh signature. Conflicts and authorization failures become visible states requiring attention. Journal capacity exhaustion does not delete unsent work. Only trusted script maintainers may edit the journal workbook. Terminal-row archival and retention remain future operator procedures.

Projection jobs serialize by event/unit. An adapter must claim a job, fetch current D1 facts, write only the designated output cells, verify the published state and then acknowledge its claim. A receipt's `pendingEffects` flag describes the state at acceptance time; it is not a live indicator of whether the sheet has caught up.

The first slice deliberately does not reclaim an expired Google-publication lease automatically: an older Google request might still finish and overwrite newer output. A lost claim response or expired lease can therefore block that resource pending operator review. A safe recovery operation, visible backlog monitoring and real publication/read-back must be implemented before production. Do not clear leased rows or acknowledge uncertain output merely to make the queue look healthy.

## Remaining work before a staging rehearsal

1. Establish programmatic access to the intended organizational accounts and verify permissions and ownership. Prefer APIs and command-line tools; use interactive login only where the provider requires it. Verify organization ownership separately from membership, Cloudflare access separately from account creation, and Drive ownership separately from sharing.
2. Complete the private operations repository's logical resource bindings, access roles and secret names for the intended staging setup. Store actual signing material in provider secret stores and Script Properties; retain recovery material in the organization's password vault. Neither a private repo nor an `.env` handoff is a secret store.
3. Add versioned, repeatable isolated provisioning and migration tooling, explicit deployment manifests, credential setup, secret rotation and restricted staging bindings. The initial SQL is applied to a fresh disposable database by local fixtures; it is not a general migration runner or an idempotent setup procedure.
4. Wire standalone Apps Script triggers, verify the actual Form email-collection mode and allowed respondents, and test human editor identity across the participating Google accounts. Missing identity needs an authenticated confirmation flow that preserves the frozen target and payload.
5. Implement physical Sheets projections, protections, filter views, draft slots, job consumption and recovery. Test real concurrent edits and sorting, Google API failures, and a round trip through the actual Form and sheet.

Before migration/cutover, complete directory and leadership workflows, corrections, multi-event excusal expansion, notifications, reports/charts, imports/exports, term transitions, backups/restore, diagnostics and the rest of the parity matrix. The current unique source key supports one command per operation and native source revision; a multi-event response needs explicit child identities before multiple request commands can share that response. No production records have been imported or reconciled by this prototype.

Operational policy questions and approval to host the applicable records on Cloudflare remain production gates in the redesign plan. Continue developing engineering mechanisms with fictional data while resolving those gates. Ordinary attendance processing and spreadsheet filtering will not depend on AI availability or any maintainer's chat history.
