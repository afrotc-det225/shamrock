# Isolated D1 staging setup

This procedure applies only to the fictional staging prototype. It does not deploy the current Apps Script project or authorize production data migration. Read the [prototype runbook](D1_PROTOTYPE_RUNBOOK.md) first. Keep account/database IDs and secret values out of Git, terminal output and release manifests.

Latest verified checkpoint, 2026-11-06: the fictional staging database has schema versions 1–5, Worker source `cd7ffadbc20c5d7ccdf8d04b49c8c8d752895783`, and Google source `34a157c0dec854070a75940bd006367976433119`. Each hosted source was read back exactly. Migration rehearsal on a detached hosted restore preceded the source upgrades; fresh exports restored locally at every checkpoint and preserved all original business records. D1 remains fenced, notifications suppressed and both Forms closed. The optional native frontend publisher is deployed but disabled, with private baseline initialization and signed live publication still pending. See the [engineering checkpoint](D1_PROTOTYPE_RUNBOOK.md#november-6-engineering-checkpoint) and private operations record for the current state and acceptance gaps. All 27 production source files remain unchanged; production has not migrated to D1.

The historical November 5 owner-account rehearsal below completed a decision after a full-row sort and verified publication. It ended with twelve commands, twelve audits and thirteen completed jobs, with none unfinished. The Google host was paused and its retained claim cleared normally. A separate [production account handoff](ACCOUNT_HANDOFF_RUNBOOK.md) transferred the existing resources and automations to the project account. Historical release pins below describe their individual rehearsals, not the latest deployed staging source.

## Verified live Google checkpoint

**Historical milestone 1, source `5e1057f4a13c45960e70844724aa5261e49f422e`:** the operator linked the staging script to its standard Google Cloud project and completed Import and Setup. Headers were verified on all four journal/output tabs. The two uploaded script files exactly matched that release; the rehearsal did not modify their source.

| Live check | Observed result |
|---|---|
| Attendance Form | One complete report covering two fictional people committed. The selected member was recorded as `P`; the nonselected member's observed code remained blank. |
| Duplicate delivery | Resending the identical saved command payload from that native response returned its original receipt and added no command. This was not a second Form submission with a new response ID. |
| Excusal Form | A new request committed as `Submitted`, requested outcome `E`, version `1`. Existing observed `P` remained intact. |
| Spreadsheet decision | An owner-account edit of `D3` to `Denied` acted on a **preseeded request**, advancing it from version `2` to `3`. Its audit evidence was `google-edit`. The input's frozen base version `2` and entered value remained intact. |
| Journal and publication | All three Google journal entries reached `committed` on attempt `1`; the three Google projection jobs were acknowledged as done. Output and cursor revision reached `9`. |
| Final database | Nine commands, nine audit records and nine completed jobs, with zero unfinished jobs. Integrity checks passed and the foreign-key check reported no violations. The first six jobs were completed by earlier test clients; the latest three exercised Google publication. |

At this historical checkpoint, the decision input's `draft_state` incorrectly remained `Queued: Denied` after the accepted decision. Milestone 2 implements receipt-driven status reconciliation and verified `Committed: Denied` on its new dynamic-slot path. The retained historical fixed-slot tab was not migrated. Use the command receipt and protected recorded result/version to establish completion, never a queued label alone.

The operator confirmed `shamrockV3StagingPause`, and its completed execution was independently observed in the staging editor at the end of milestone 1; Script Properties were not directly read back. This checkpoint validated the narrow owner-account path. The new excusal submission and the decision on the preseeded request were separate checks.

## Milestone 2: migration and multi-event intake

The following evidence belongs to the subsequent version 2 rehearsal, not the historical first slice:

| Check | Observed result |
|---|---|
| Recovery preparation | The actual pre-upgrade SQL export restored successfully into disposable in-memory SQLite. The nine commands, nine audit records and nine jobs, paused control, schema/ledger and integrity were checked. This was not a hosted D1 or Time Travel restore. |
| Versioned migration | Migration `0002_multi_event_excusals.sql` applied while staging was fenced. Exact schema and ordered hash ledger matched the reviewed release; the nine existing command/event scopes were backfilled. Integrity and foreign-key checks passed. |
| Deployed release | Cloudflare and the two Google script files used source `23edbfabcde2b16f8b5cb894fd4b4ea814bb0cd1`. The new decision-input tab was configured separately; the old fixed-slot tab was retained. |
| Multi-event Form | One real Google response committed one parent command, two event-specific child requests, one audit record and two projection jobs. Both jobs completed through Google publication. |
| New decision slots | The protected dynamic input table received slots for the new requests. Publication did not require manually preseeded request targets. |
| Preserved history | All nine previous receipts were retained. After the new submission, totals were ten commands, ten audit records and eleven completed jobs. |
| Native decision contention | A decision edit overlapped a scheduled flush and could not obtain the adapter lock. That failed edit created no database command; its selected input was retained. |
| Reviewed fix | Commit `6202646bf68d94f0c7e64916d6f646aca16bff5e` passed 199 local tests: 31 current-system regressions and 168 v3 tests. Both Google files matched the uploaded artifact. The existing Cloudflare Worker module was unchanged. |
| Live decision retry | The native `D3` edit committed `Denied` as the eleventh command and audit record, with `google-edit` evidence. The protected draft state became `Committed: Denied`. The exact initial lock-contention overlap was not reproduced. |
| Publication recovery | The first publication attempt received a non-200 Google API response; its exact status and cause are unknown. The durable claim was retained. A scheduled flush began at 20:44:08 local and completed the job at 20:44:26, before its 20:52:58 lease expiry. A manual flush at 20:45:42–48 was subsequent and made no changes. |
| Preserved decision input | A new immutable version 2 slot was appended at row 8. The original version 1 row 3 and its frozen input remained intact, as did the original `P` observation. |
| Final database and journal | Eleven commands, eleven audit records and twelve completed jobs, with zero unfinished jobs. All five Google journal entries were committed. Integrity passed and the foreign-key check found no violations. |
| Stop state after milestone 2 | D1 is fenced at `accepting_commands=0`. The Google host pause ran at 20:46:19–20 local and was observed complete. Final read-back verified both Forms unpublished and not accepting responses, with `VERIFIED` email collection unchanged. |

The contention fix freezes the native edit evidence before a bounded lock wait, rechecks the target after acquisition, and distinguishes durable capture with deferred delivery from an edit that was never captured. A capture timeout preserves the input and attempts a retry note; it does not claim the decision was accepted. See the [adapter contract](../../apps/google-adapter/README.md) for the bounds and note limitations. Local overlap tests and the successful live decision retry are separate evidence; no live recurrence of the original timing overlap or HTTP 429 diagnosis was established.

Diagnostic-only follow-up `9ca5ce2` adds safe HTTP-status reporting and passed 201 local tests (31 current-system regressions and 170 v3 tests). It does not change claim or retry behavior and was not the source of the live results above. Record its deployment verification separately; it cannot recover the previously masked HTTP status.

Cross-domain `e.user`, authenticated confirmation for an unknown editor, broader concurrency/failure recovery, hosted restore, provider capacity and full feature parity remain incomplete. Production source remained unchanged throughout this staging work.

## Milestone 3: native spreadsheet presentation

The three existing staging surfaces now use the production SHAMROCK visual baseline: real native Tables, green headers, alternating rows, Roboto text, readable wrapped labels, semantic colors, hidden technical fields and a protected Data Legend. This is the presentation framework for attendance observations, recorded excusals and dynamic decisions, not full frontend feature parity. See the [presentation runbook](D1_PRESENTATION_RUNBOOK.md).

The deployed Google adapter is `d152ec6a852a22a44a5eb4017317e8ebd2acea62`; its two source files were read back exactly. The reviewed release manifest SHA-256 is `0ad329913d1cf59da5bd9576efd4a9de669e4660ea3f78f71874d8ccbc956a3c`. Full local validation passed 234 tests: 31 current-system regressions and 203 prototype tests. The Worker module, D1 schema and production runtime were not changed.

- Setup appended two identity/context columns to the existing 14-column dynamic input and two readable labels to recorded output, preserving every original cell and draft. No workbook or existing tab was replaced.
- Two paused presentation repairs retained all three native Table IDs, existing view IDs, rule counts, four original protection sets and all prior cells/drafts. API verification and Google-rendered inspection confirmed the native structures, styling and strict dropdowns.
- The native Ready for decision filter view displayed five of the six initial rows. A complete-row sort was then performed through the Sheets API; all sixteen fields and context digests remained aligned for all six slots. This does not claim the sort was invoked through the native menu.
- A real native dropdown edit on the sorted current request committed Approved with `google-edit` evidence, advancing that request from version 2 to 3. Its original draft/context remained bound to version 2, and a new protected version 3 slot appeared at row 9. All unrelated existing drafts/contexts, the historical fixed input, original attendance observations, protections and Table/view identities were preserved.
- The first publication retained its claim because exact explicit-format verification rejected Google's inherited Table header colors and omitted redundant text formats. The deployed follow-up verifies effective header colors and guarded literal text normalization while still rejecting wrong formats, missing numeric formats, damaged styles and weakened validation. It adds no formatting writes or API requests.

The first retry after the formatting fix exceeded the original lease at 23:12:35 local. An overlapping scheduled flush also finished before explicit recovery. With Forms closed, the Google host paused, D1 fenced and no active executions observed, the operator compared the saved claim, native binding fingerprint and database identity, then extended only the same claim's expiry in D1 and Script Properties. The guarded database update preserved job/token/worker/scope; reload verified all other private properties unchanged. This was a manual isolated reconciliation, not an automatic expired-lease recovery feature. No claim was deleted and no job was forced complete.

The normal retry ran at 23:22:10–24 local and acknowledged the retained job at 04:22:23.833 UTC on November 6. It cleared its own saved claim without repeating the decision or appending a duplicate slot. Final read-back verified twelve commands, twelve audits, thirteen completed jobs, six committed Google journal entries and seven valid decision slots. Presentation verification returned ready with no issues; all unrelated original drafts, contexts, observations, protections and Table/view IDs remained intact. The host pause completed at 23:22:49 local, D1 was fenced again, both Forms remained unpublished/closed with verified email collection, and fresh Script Properties read-back confirmed paused state, claim removal and preservation of every other property. D1 `quick_check` returned `ok` and `foreign_key_check` found no violations. No paid service or production write was introduced.

Full attendance matrices, Directory/Leadership presentation, Dashboard charts, term transitions, non-owner access, cross-domain identity, capacity, hosted restoration and concurrency before the edit handler's first identity read remain release gates. The owner-only sort/edit rehearsal does not establish those behaviors.

## Prepare a reviewed release

From a clean, committed public checkout whose checks have passed:

```sh
npm run check
node scripts/prepare-v3-release.mjs --environment staging --generation 1
node scripts/prepare-v3-release.mjs --environment staging --generation 1 --verify
```

The helper rebuilds the Worker and Google adapter from that commit and writes ignored `.build/v3-release/` artifacts. Format 2 includes each ordered SQL source under `migrations/`; previously recorded format-1 releases remain historical rollback artifacts, not current upgrade plans. The manifest records the source commit, checksums, migration version, environment, generation and runtime compatibility date. The metadata template contains placeholders; it never contains a real database ID or signing secret. `--verify` checks the prepared files without rebuilding or deploying them. To verify an older release, use its recorded source checkout; verification intentionally rejects a different current commit. Local emulator tests and the cloud runtime may have different compatibility dates; real staging validation is required.

Deployment is through the connected Cloudflare API in this phase. No paid subscription, custom domain, extra storage service or GitHub deployment feature is needed for this procedure. On 2026-11-05, the actual Cloudflare dashboard showed Workers **Free**, **$0**, marked **Current plan**; D1 free-tier limits were also checked. No subscription was changed. The connected OAuth credential could not read billing subscriptions, so dashboard evidence supplies that verification. Account plan verification does not establish hosted CPU, daily workload or Google quota headroom.

## Provision only the intended staging account

1. Authenticate the explicitly selected SHAMROCK Cloudflare connection. List accounts and verify the intended identity before writes. List existing Workers/databases and reuse only an identified staging resource; never silently adopt or overwrite an unfamiliar resource.
2. Create one D1 database named `shamrock-staging`, using the Eastern North America placement hint and disabled read replication. A placement hint is not a data-residency guarantee. Record actual bindings in provider configuration, not the repository.
3. Ensure the account's free `workers.dev` subdomain exists. Upload only the staging Worker under `shamrock-staging`; no production routes or Google files change.
4. Keep `BRIDGE_SECRET` in a concealed 1Password item for recovery and a Worker `secret_text` binding at runtime. The initial item is titled **SHAMROCK staging bridge** and belongs alongside the new project account credentials. Verify that designated custodians can access the vault before handoff; a private vault is not automatically shared with successors.

The plugin can create resources and upload the already built module using the Cloudflare REST API. Discover the current endpoint schemas before execution. Never print an upload request containing the secret. Do not invent CLI commands or add deployment credentials to an artifact.

## Apply the initial migration safely

`migration-plan.json` contains API-ready preflight queries, the bootstrap batch and expected schema signatures. Read the schema first; read the ledger/control only if their tables exist. The helper classifies a truly empty database as ready to bootstrap, a complete matching migration as a no-op, an exact older schema as an upgrade candidate, and any partial/unknown schema or hash mismatch as requiring review.

Apply the complete `bootstrap.batch` in a single D1 REST query request. The first assertion rejects an unexpected schema inside that transaction. The batch creates the application schema, a migration ledger and `system_control` with `accepting_commands=0`. Inspect every result, then verify the ledger hash, complete schema, staging generation, `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Do not mask an incomplete migration with `CREATE TABLE IF NOT EXISTS` or manually mark a failed migration complete.

For a new database, bootstrap creates version 1. Apply any remaining versions using the same upgrade procedure below; do not deploy a Worker requiring version 2 against version 1.

## Upgrade a paused staging database

1. Pause Google intake, journal dispatch and publication; close the staging Forms and verify D1 `accepting_commands=0` for the intended generation. Capture the currently deployed Worker/Google source and configuration for recovery. Never use production bindings.
2. Export the existing fictional staging database into restricted ignored storage and record its SHA-256. Restore it into an isolated database and verify schema, migration history, counts, `quick_check`, foreign keys and paused control. Record exactly which restore environment was tested. A file's existence is not restore evidence.
3. Save fresh preflight arrays under exactly `inventory`, `ledger` and `controls`. The queries are in the release plan. Use `migrationEvidenceHash` from `scripts/lib/v3-migrations.mjs` to bind the recovery record to this preflight. Recovery fields are `environment`, `generation`, `fromVersion`, `evidenceSha256`, `backupSha256`, `rollbackSourceCommit`, `reviewed: true`, `restoreVerified: true`, and `adaptersPaused: true`. These attestations require actual evidence; the helper does not verify backup contents or pause Google for you.
4. Prepare the next version's reviewed API batch without applying it:

```sh
node scripts/prepare-v3-migration.mjs --environment staging --generation 1 \
  --evidence .build/staging-preflight.json --recovery .build/staging-recovery.json \
  --out .build/staging-upgrade.json
```

5. Check the selected account/database, manifest and every statement. Submit the emitted `batch` as **one transactional D1 API request**. Do not split it into separate calls. Exact schema/ledger/control assertions run inside that transaction before additive DDL/backfill; a mismatch or failed write rolls the batch back. The helper supports bounded additive migrations and backfills only into newly created tables, not arbitrary repairs.
6. Re-read schema, ledger and paused control; inspect every API result and both integrity checks. After an ambiguous response, classify fresh state before retrying. Repeat for another version only with new preflight/recovery evidence. Matching latest state is a no-op.
7. Upload compatible committed Worker/Google artifacts while still paused, then run a bounded fictional rehearsal. Never infer data rollback from reverting application code. Prefer a reviewed forward fix; restore only while fenced and with no accepted writes omitted, then revalidate schema, generation and code compatibility.

**Version 2 compatibility:** the older Worker does not populate the new command/event scope table. Do not reopen processing after a code-only rollback to that Worker against version 2. Keep processing fenced until a compatible forward fix, or a reviewed restoration of both the pre-upgrade schema/data and matching code with no accepted writes omitted.

The offline helper refuses unknown schema, historical hash changes, missing recovery evidence, active command processing, a different generation and production environments. It never contacts a provider, enables commands or performs an automatic restore.

Upload the manifest's `worker.mjs` as an ES module with these runtime bindings:

| Binding | Value source |
|---|---|
| `DB` | The verified staging D1 database, using a `d1` binding's `database_id` field |
| `ENVIRONMENT` | `staging` |
| `GENERATION` | The manifest's positive generation |
| `BRIDGE_KEY_ID` | The identifier associated with the staging credential |
| `BRIDGE_SECRET` | The concealed staging credential, using `secret_text` |

Set the manifest's compatibility date; do not add cron triggers, Google credentials or notification delivery. Keep persisted request logging disabled for this prototype. Enable only the staging Worker's `workers.dev` route, with preview URLs disabled. Verify its module/configuration after upload and verify `/health` and rejection of an unsigned mutation. Health alone does not prove D1 works.

## Fictional cloud smoke test

This fixture is for a controlled staging database with no unrelated commands, leases or operators. Its two cadets, one event, principals, grants and source binding are fictional. `database/fixtures/staging-smoke.sql` refuses a nonempty or unfenced database; apply its statements together in one atomic API batch. It does not install anything in Google.

After checking the deployed bindings and fixture, temporarily enable `system_control.accepting_commands` for the staging generation. Pipe the credential directly from the password manager into the smoke command's stdin. Supply only the non-secret origin, key ID and generation as options:

```text
<password-manager command that outputs only the staging key> |
  node scripts/smoke-v3-staging.mjs --origin=https://<staging-host> --key-id=<staging-key-id> --generation=1
```

Do not place the key in command arguments, a committed file, a shell history entry or a printed environment dump. The smoke command creates three synthetic commands, repeats attendance delivery, checks a stale decision, fetches current projections and acknowledges three jobs to its own test consumer. It does not claim that any Google sheet was published. A fresh run uses fresh IDs; investigate an interrupted run before retrying rather than assuming it made no writes.

When the smoke completes or fails, set `accepting_commands=0` again, verify the fence with a signed mutation and inspect the database. A successful first run leaves three commands, three audit entries, one presence observation, one approved request at version 2 and three completed jobs. Preserve that fictional evidence for debugging or remove it only through a reviewed staging reset. Never point the fixture/reset at live records.

Record the source commit, hashes, migration verification, Worker configuration, synthetic result and final paused state in the private operations repository. Record live Google publication separately from test-client acknowledgements, then expand identity, concurrency and recovery validation before production. A passing smoke test is not full feature parity or a capacity certification.

## Standalone Google staging adapter

Use a separate standalone Apps Script project owned by the project automation account. Keep its local clasp binding under ignored `.build/google-staging/`; always specify both that binding and the named automation-account profile. The root `.clasp.json` continues to identify production. Upload only the committed release's `GoogleAdapter.js` and `appsscript.json`; do not copy the production `dist/` files into staging.

The staging manifest requests Forms metadata/response access, spreadsheets, read-only Drive metadata/content, outbound requests, trigger management and the executing account's email. It requests no mail sending scope. The native runtime reads current Drive ACLs and Sheets protections instead of trusting a saved assertion. The standalone script and its private journal must be accessible only to the automation owner in this first rehearsal.

Google CLI authorization and Apps Script runtime authorization are distinct. A successful clasp login does not authorize installed triggers or prove that a shared OAuth client's Google Cloud project enables the required APIs. If an API returns `SERVICE_DISABLED` for that shared client, do not attempt to change Google's project. Use a project-owned standard Google Cloud project for staging and enable only the necessary free Google Workspace APIs. Keep billing unlinked. Never change production's associated Google Cloud project to solve a staging login problem. The default/standard project choice, consent configuration and API enablement must be verified on the actual staging project before recording setup as successful.

External OAuth apps left in **Testing** have test-user authorizations that expire after seven days; offline refresh tokens expire too. The basic profile/email exception does not cover this manifest's Forms, Sheets and Drive scopes. Plan reauthorization during staging and review the production consent publishing/verification configuration before unattended operation. This rehearsal did not test beyond seven days or establish an exact Apps Script trigger-expiry schedule. See [Google's app audience documentation](https://support.google.com/cloud/answer/15549945?hl=en).

Prepare two private, explicitly named staging workbooks and two staging Forms containing only fictional data. The journal workbook contains separate command-journal and projection-cursor tabs. The operator workbook contains attendance results, recorded excusal results and a separate decision-input tab. The four journal/output tabs begin empty for the initializer. Use the exact headers and configured decision mode in the [adapter contract](../../apps/google-adapter/README.md): milestone 1 used fixed targets; milestone 2 uses a new tab with projection-created request/version slots. Retain an old fixed-slot tab and its drafts rather than reinterpreting them as the new schema. Never bind these names to production by guessing or create replacements for missing configured resources.

Protect each output tab as a whole sheet, with no unprotected ranges and no ordinary protection editors. Protect decision metadata and permit only its draft-decision cells as inputs. Configure Forms to collect `VERIFIED` emails and restrict edit access to the automation owner. Keep them unpublished until a controlled rehearsal. Validate native Apps Script item IDs against the configured item roles; a REST item ID's textual encoding is not sufficient evidence.

Store configuration, identity enrollment and immutable choice catalogs in Script Properties as documented in the adapter README. Keep the HMAC key in its own concealed Script Property and the password vault. Actual identities and provider resource IDs belong in private runtime configuration, never either repository. Enroll test operators against fictional D1 principals; this is not permission to copy production rosters into staging.

Run `shamrockV3StagingSetup` manually as the automation account, granting the staging runtime consent. Setup verifies existing resources, initializes the journal and outputs and reconciles its versioned triggers. It remains paused. Confirm both the host and projection setup receipts before running `shamrockV3StagingResume`. The Worker also remains fenced until explicitly enabled for the rehearsal. Submit a real test response after setup, verify the D1 receipt and protected sheet output, test repeated delivery, and then pause both sides again. Record native identity, protection and publication evidence separately from mock-test results.

Do not migrate production automation as part of this rehearsal. Use the [account handoff runbook](ACCOUNT_HANDOFF_RUNBOOK.md) for its existing resources, old-owner trigger inventory, controlled replacement and recovery.

For a newly created, empty isolated database, `createFreshDatabaseBatch(plan)` in
`scripts/lib/v3-migrations.mjs` installs the exact current schema and ordered ledger
in one guarded transaction, leaving commands paused. Its explicit review bound is
128 statements / 512 KiB. The transaction refuses any existing application object,
including an older SHAMROCK database. It is only initial provisioning; existing
staging databases still require the versioned backup/restore upgrade procedure.
