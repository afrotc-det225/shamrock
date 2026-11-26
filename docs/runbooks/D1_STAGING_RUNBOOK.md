# Isolated D1 staging setup

This procedure applies to isolated staging resources: the fictional rehearsal environment and the separately authorized private real-data staging environment. It does not deploy the current production Apps Script project, change production authority or authorize a D1 cutover. Read the [prototype runbook](D1_PROTOTYPE_RUNBOOK.md) first. Keep account/database IDs and secret values out of Git, terminal output and release manifests.

For an independent real-data Apps Script host using only the full native workbooks and managed Forms, follow the [native-only bootstrap](D1_NATIVE_BOOTSTRAP.md). Keep the earlier fictional transport fixture separate; it does not need to be rebound or reset.

After owner consent expires, run `shamrockV3StagingAuthorizePublication` in the staging Apps Script editor. Approve the publication permissions and run again if Google interrupts the execution for consent. The function reads staging configuration metadata and verifies ownership. It leaves Forms intake, workbook sharing, notifications and D1 writes under their existing controls.

Historical checkpoint, 2026-11-06: the fictional staging database has schema versions 1–5, Worker source `cd7ffadbc20c5d7ccdf8d04b49c8c8d752895783`, and Google source `34a157c0dec854070a75940bd006367976433119`. Each hosted source was read back exactly. Migration rehearsal on a detached hosted restore preceded the source upgrades; fresh exports restored locally at every checkpoint and preserved all original business records. D1 remains fenced, notifications suppressed and both Forms closed. The optional native frontend publisher is deployed but disabled, with private baseline initialization and signed live publication still pending. See the [engineering checkpoint](D1_PROTOTYPE_RUNBOOK.md#november-6-engineering-checkpoint) and private operations record for the current state and acceptance gaps. All 27 production source files remain unchanged; production has not migrated to D1.

The historical November 5 owner-account rehearsal below completed a decision after a full-row sort and verified publication. It ended with twelve commands, twelve audits and thirteen completed jobs, with none unfinished. The Google host was paused and its retained claim cleared normally. A separate [production account handoff](ACCOUNT_HANDOFF_RUNBOOK.md) transferred the existing resources and automations to the project account. Historical release pins below describe their individual rehearsals, not the latest deployed staging source.

## Current capabilities and deployment boundary

Current source includes native Main/Blue/Gold publication and input capture,
managed Attendance/Excusals/Directory Forms, verified Directory self-service,
D1-derived reports, bounded historical publication, reviewed future rosters,
operational CSV/bulk tools, permissions, closeout and term transitions. Optional
native mail tests target only the verified automation owner. The staging manifest
includes the Drive write and mail scopes needed by those explicitly gated hosts.
Their availability in a build does not establish that they are enabled or tested
on a particular deployment.

Check the private operations record and live readback for the current source,
migration ledger, configuration, permissions and pause state. The November 5/6
milestones below preserve dated evidence, including their original release pins
and limits. They are not a current deployment inventory. Continue to require
ordinary-account native edit/filter/trigger tests, exact real-data comparison and
history readback, hosted recovery/transition exercises, measured provider budgets,
owner-only mail acceptance/delivery and a successor rehearsal before cutover.

Use [managed Forms](D1_MANAGED_FORMS.md), [native spreadsheet input](D1_NATIVE_INPUT.md),
[frontend publication](D1_FRONTEND_RUNTIME.md), [role permissions](D1_ROLE_PERMISSIONS.md),
[history](D1_HISTORY_REPORTS.md), [owner-only mail](D1_OWNER_MAIL_REHEARSAL.md)
and [operational administration](D1_OPERATIONAL_ADMIN.md) for their current bindings.
The original technical journal/projection setup later in this runbook remains a
separate fixture, not the final visible Main/Blue/Gold interface.

### Sign-in availability during a database outage

The staging web panel now keeps its Google identity bindings, login invitations,
OAuth state, sessions and proposal/View as coordination in one private
SQLite-backed Durable Object. Cadet records, operational permissions and domain
audit receipts remain in D1. Successful sign-in does not grant operational access:
each records request and change must still pass the D1 permission checks.

When D1 is unavailable, a verified session displays “You're signed in” with a
records-unavailable message and Sign out. Writable controls are inaccessible;
existing editor drafts stay mounted privately for recovery. A daily-limit response
pauses records requests until the provider's retry time; other transient outages
use a bounded retry delay. There is no database polling from the sign-in page and
no fallback to stale permission data. Existing lazy reads and View as read-only
fences remain in effect.

The control store uses the Workers Free SQLite Durable Object allowance, which is
separate from D1's daily read allowance. Its own limits can still stop sign-in.
Do not upgrade billing or introduce paid storage to bypass a rehearsal limit.
Follow the [hosted panel setup and control-store migration](../../apps/admin/hosted/README.md)
for the reviewed one-time transfer, fresh session-cookie boundary, private access
maintenance, rollback and retained legacy database. Editing archived D1 login
tables after migration **does not change sign-in authority**.

### Snapshot read budgets

Measure D1 **rows read**, not only request counts or Worker CPU, when rehearsing
full roster publication and scoped panel reads. A bounded page can still scan an
entire semester before SQLite sorts and applies its limit. Current roster pages
order by the current-event join key so the existing roster index can stream rows.
Scoped panel manifests reuse Flight, person, visible-request and event scopes
inside the same data transaction; their count plans retain the same membership,
current-version and completed-import conditions as the returned pages. Page
queries keep their streaming plans, and both authority reads still fence every
scoped response. No cross-user cache or new provider storage is introduced.

The November 17 local D1 rehearsal using an isolated real-data export measured
8,697 roster-query reads before the change versus 586 on the first page, 1,122 on
the second and 4,467 on the final page afterward. Offset pagination still costs
more on later pages. The scoped manifest fell from 42,003 to 27,668 reads for the
full Flight set, 11,484 to 7,013 for one Flight, and 15,532 to 1,989 for a
request-only scope. Returned rows and counts were identical. These are local
query measurements, not live daily capacity or a production acceptance result.
Repeat the provider usage check after staging deployment, account for exports
and integrity rehearsals separately, and avoid repeated full snapshots when the
manifest revision has not changed. A completed native History publication returns
before making D1 history requests; an unfinished publication retains its cursor
and continues one bounded page per invocation.

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

At this milestone, cross-domain `e.user`, authenticated confirmation, broader concurrency/failure recovery, hosted restore, provider capacity and full feature parity had not been established. Later source adds confirmation and recovery mechanisms, and later dated evidence records a hosted fictional restore; the milestone itself proves neither. Production source remained unchanged throughout this staging work.

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

This owner-only sort/edit milestone did not establish full attendance matrices, Directory/Leadership presentation, Dashboard charts, term transitions, non-owner access, cross-domain identity, capacity, hosted restoration or concurrency before the edit handler's first identity read. Current implementations and later evidence must be assessed separately against those release gates.

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
2. For a fresh fictional environment, create one D1 database named `shamrock-staging`, using the Eastern North America placement hint and disabled read replication. A real-data comparison needs its own explicitly reviewed private staging database, Worker and recovery record; do not mix it with the fictional reset/smoke fixture. A placement hint is not a data-residency guarantee. Record actual bindings in provider configuration, not the repository.
3. Verify the account's current free `workers.dev` subdomain and the exact staging Worker binding before upload; use `shamrock-staging` for the fictional host. Never assume a stored origin survived an account subdomain rename. Update reviewed private bindings and configuration hashes/checkpoints deliberately; keep production routes and Google files unchanged.
4. Keep `BRIDGE_SECRET` in a concealed 1Password item for recovery and a Worker `secret_text` binding at runtime. The initial item is titled **SHAMROCK staging bridge** and belongs alongside the new project account credentials. Verify that designated custodians can access the vault before handoff; a private vault is not automatically shared with successors.

The plugin can create resources and upload the already built module using the Cloudflare REST API. Discover the current endpoint schemas before execution. Never print an upload request containing the secret. Do not invent CLI commands or add deployment credentials to an artifact.

## Apply the initial migration safely

`migration-plan.json` contains API-ready preflight queries, the bootstrap batch and expected schema signatures. Read the schema first; read the ledger/control only if their tables exist. The helper classifies a truly empty database as ready to bootstrap, a complete matching migration as a no-op, an exact older schema as an upgrade candidate, and any partial/unknown schema or hash mismatch as requiring review.

Apply the complete `bootstrap.batch` in a single D1 REST query request. The first assertion rejects an unexpected schema inside that transaction. The batch creates the application schema, a migration ledger and `system_control` with `accepting_commands=0`. Inspect every result, then verify the ledger hash, complete schema, staging generation, `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Do not mask an incomplete migration with `CREATE TABLE IF NOT EXISTS` or manually mark a failed migration complete.

The original bootstrap creates version 1. Apply every migration required by the selected committed release using the upgrade procedure below, or use the guarded current-schema fresh-database helper described at the end. Never deploy a Worker against an older incompatible schema.

## Upgrade a paused staging database

1. Pause Google intake, journal dispatch and publication; close the staging Forms and verify D1 `accepting_commands=0` for the intended generation. Capture the currently deployed Worker/Google source and configuration for recovery. Never use production bindings.
2. Use the checked-in [staging backup runner](D1_STAGING_BACKUP.md) to export the intended paused staging database into restricted ignored storage and record its SHA-256. It supports fictional and approved real-data staging databases, with exact local restore proof, optional owner-private Drive custody, and recovery records bound to fresh source evidence. Restore it into an isolated database and verify schema, migration history, counts, `quick_check`, foreign keys and paused control. Record exactly which restore environment was tested. A file's existence is not restore evidence.
3. Save fresh preflight arrays under exactly `inventory`, `ledger` and `controls`. The queries are in the release plan. Use `migrationEvidenceHash` from `scripts/lib/v3-migrations.mjs` to bind the recovery record to this preflight. Recovery fields are `environment`, `generation`, `fromVersion`, `evidenceSha256`, `backupSha256`, `rollbackSourceCommit`, `reviewed: true`, `restoreVerified: true`, and `adaptersPaused: true`. These attestations require actual evidence; the helper does not verify backup contents or pause Google for you.
4. Prepare the next version's reviewed API batch without applying it:

```sh
node scripts/prepare-v3-migration.mjs --environment staging --generation 1 \
  --evidence .build/staging-preflight.json --recovery .build/staging-recovery.json \
  --out .build/staging-upgrade.json
```

5. Check the selected account/database, manifest and every statement. Submit the emitted `batch` as **one transactional D1 API request**. Do not split it into separate calls. Exact schema/ledger/control assertions run inside that transaction before additive DDL/backfill; a mismatch or failed write rolls the batch back. The helper supports bounded additive migrations and backfills only into newly created tables, not arbitrary repairs.
6. Re-read schema, ledger and paused control; inspect every API result and both integrity checks. After an ambiguous response, classify fresh state before retrying. Repeat for another version only with new preflight/recovery evidence. Matching latest state is a no-op.
7. Upload compatible committed Worker/Google artifacts while still paused, then run the bounded rehearsal appropriate to that dataset. Use fictional records for destructive/failure fixtures and explicitly approved private real-data comparisons for parity. Never infer data rollback from reverting application code. Prefer a reviewed forward fix; restore only while fenced and with no accepted writes omitted, then revalidate schema, generation and code compatibility.

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

Set the manifest's compatibility date; do not add cron triggers or Google credentials to the Worker. Keep operational notification delivery suppressed. The optional owner-only mail rehearsal has separate reviewed Worker bindings and native gates documented in its runbook. Keep persisted request logging disabled for this prototype. Enable only the staging Worker's `workers.dev` route, with preview URLs disabled. Verify its module/configuration after upload and verify `/health` and rejection of an unsigned mutation. Health alone does not prove D1 works.

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

The current staging manifest requests Forms read/write and response access, spreadsheets, Drive access, outbound requests, trigger management, the executing account's email and `script.send_mail`. Drive writes support private checkpoints, recovery/retention artifacts and credential delivery cleanup. The mail scope supports the separately gated owner-only `MailApp` rehearsal; granting consent does not enable operational recipients. The native runtimes read current Drive ACLs and Sheets protections instead of trusting saved assertions. Keep the standalone script, signing material and private journals/checkpoints accessible only to the automation owner; frontend sharing uses explicit reviewed ordinary-user lists.

Google CLI authorization and Apps Script runtime authorization are distinct. A successful clasp login does not authorize installed triggers or prove that a shared OAuth client's Google Cloud project enables the required APIs. If an API returns `SERVICE_DISABLED` for that shared client, do not attempt to change Google's project. Use a project-owned standard Google Cloud project for staging and enable only the necessary free Google Workspace APIs. Keep billing unlinked. Never change production's associated Google Cloud project to solve a staging login problem. The default/standard project choice, consent configuration and API enablement must be verified on the actual staging project before recording setup as successful.

External OAuth apps left in **Testing** have test-user authorizations that expire after seven days; offline refresh tokens expire too. The basic profile/email exception does not cover this manifest's Forms, Sheets and Drive scopes. Plan reauthorization during staging and review the production consent publishing/verification configuration before unattended operation. This rehearsal did not test beyond seven days or establish an exact Apps Script trigger-expiry schedule. See [Google's app audience documentation](https://support.google.com/cloud/answer/15549945?hl=en).

For the original fictional journal/projection fixture, prepare two private, explicitly named staging workbooks and two fictional staging Forms. The journal workbook contains separate command-journal and projection-cursor tabs. The operator workbook contains attendance results, recorded excusal results and a separate decision-input tab. The four journal/output tabs begin empty for the initializer. Use the exact headers and configured decision mode in the [adapter contract](../../apps/google-adapter/README.md): milestone 1 used fixed targets; milestone 2 uses a new tab with projection-created request/version slots. Retain an old fixed-slot tab and its drafts rather than reinterpreting them as the new schema. Never bind these names to production by guessing or create replacements for missing configured resources.

Protect each output tab as a whole sheet, with no unprotected ranges and no ordinary protection editors. Protect decision metadata and permit only its draft-decision cells as inputs. Configure Forms to collect `VERIFIED` emails and restrict edit access to the automation owner. Keep them unpublished until a controlled rehearsal. Validate native Apps Script item IDs against the configured item roles; a REST item ID's textual encoding is not sufficient evidence.

The original projection host keeps its compact bindings and enrolled choices in Script Properties. Current frontend, managed Forms, native input, permission, maintenance, History and owner-mail hosts read reviewed owner-private configuration/checkpoint files; the [configuration import and credential controls](D1_HISTORY_REPORTS.md#bounded-native-history-workbook) keep secrets in named Script Properties and pause optional runtimes. Keep recovery keys in the shared password vault. Actual identities and provider resource IDs belong in private runtime configuration, never either repository. Use fictional D1 principals for the original smoke fixture. Authorized real-data staging follows the separate [private capture/import](D1_IMPORT_PARITY.md) and [operational adoption](D1_OPERATIONAL_ADOPTION.md) workflows. Later data updates use the [paused incremental refresh](D1_INCREMENTAL_IMPORT.md); they must not replay initialization, replace native bindings or discard previous source evidence. The import must not fabricate old actors, revive old submissions or notify operational recipients.

For that original fixture, run `shamrockV3StagingSetup` manually as the automation account, granting the current staging runtime consent. Setup verifies existing resources, initializes the journal and outputs and reconciles its versioned triggers. It remains paused. Confirm both the host and projection setup receipts before running `shamrockV3StagingResume`. The Worker also remains fenced until explicitly enabled for the rehearsal. Submit a real test response after setup, verify the D1 receipt and protected sheet output, test repeated delivery, and then pause both sides again. Record native identity, protection and publication evidence separately from mock-test results.

The full native workflow binds existing isolated Main and Excusals workbooks plus Attendance, Excusals and Directory Forms through their respective runbooks. Each consumer has its own reviewed setup, pause/resume and checkpoint contracts; resuming the legacy projection host does not implicitly enable them. Keep technical transports and private history/archive books out of the ordinary frontend tabs.

Do not migrate production automation as part of this rehearsal. Use the [account handoff runbook](ACCOUNT_HANDOFF_RUNBOOK.md) for its existing resources, old-owner trigger inventory, controlled replacement and recovery.

For a newly created, empty isolated database, `createFreshDatabaseBatch(plan)` in
`scripts/lib/v3-migrations.mjs` installs the exact current schema and ordered ledger
in one guarded transaction, leaving commands paused. Its explicit review bound is
160 statements / 512 KiB. The transaction refuses any existing application object,
including an older SHAMROCK database. It is only initial provisioning; existing
staging databases still require the versioned backup/restore upgrade procedure.

### Stored Wing Attendance and Semester views

Bind `WING_MATRICES` on the real-data staging backend to a dedicated private Workers KV namespace. Use a separate namespace for each database, including detached rehearsal copies. Give the panel access through its existing signed backend binding. The namespace contains cadet data and must stay private. No scheduled refresh or paid service is required.

After a successful Wing authorization, a cold viewer can reuse a compiled projection for the current term and primary database bookmark. Attendance and Semester use separate keys. A first build, an expired entry or an unavailable store falls back to the ordinary fenced D1 read. Exact hits do not rewrite KV. Entries expire seven days after writing. A recent Attendance base can accept up to 64 consecutive same-term corrections after a second authority check. Other changes require a fresh capture. The Semester projection includes just the roster planning fields, flights, term and schedule inputs. The next-semester suggestion accepts both imported year-first labels and season-first display labels. Receipts and transition operations keep their existing authorization and validation paths.

For a rehearsal, compare the full payload from a fresh cache origin with a separate D1 rebuild. Check cold and repeat visits, then apply a correction or clear to a detached copy and repeat the comparison. On the November real-data fixture a stored cold visit to either view read 34 D1 rows and an edge hit read zero. An initial Attendance build read 11,416 rows and an initial Semester build read 289. These counts cover the backend browse request. Login, authorization bootstrap, receipts and operator commands can make additional requests. Failed or delayed KV writes can cause another build. Monitor KV operations alongside D1 reads. [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)

System opens the current operator’s saved changes and runs catalog checks on demand. Its tab-usage table counts browser API calls, receipt requests and measured D1 rows for the last minute and since opening the tab. A failed, pending or uninstrumented request is counted as unmeasured. Sessions and receipt storage use the panel control Durable Object. The D1 count includes the access checks made around a receipt read.

On an edge miss the staging backend can reuse a private signed read for the same request body, route, environment, generation, bridge identity and current primary bookmark. Entries expire after one day. A first-time access check reads its authority inputs in one D1 transaction and compares primary bookmarks before returning it. Paths without a bookmark retain their original double check. A write makes earlier entries unreachable.

### Investigating a D1 daily read limit

Use the account-wide D1 rows-read metric for the UTC quota day. Break it down by database and hour, then use Query Insights to group expensive SQL by minute. Record query shapes, counts and timestamps without bound parameters or personal data. Insights and account usage can report different totals. Use Insights to locate expensive work and D1 response metadata to measure a specific request. The System page counts only the current tab. Native publication, rehearsal scripts, backup verification and other clients use the same account allowance.

On November 26 the account reported 5,280,835 reads, of which 5,180,938 were on real-data staging. Two baseline paging patterns clustered within six minutes. Another burst ran the full snapshot count 44 times in a single minute. These coincided with staging rehearsals and panel testing. The telemetry does not identify an individual requester. Reproduce heavy queries against the restored private SQLite export or local D1 first. For hosted verification, use a bounded read-only sample and record the cache source and row count. A zero-read repeat from the same client is insufficient evidence for a new client.

The baseline continuation is the final delivered person and event pair. Use it with the same semester and revision. Explicit semester selection follows the same indexed continuation as the current semester. Full snapshot counts have an exact-bookmark response cache on the signed read route. Native publication keeps its own lease checks. Wing catalog cache entries hold only shared table data, and each caller must independently qualify for full Wing access. A fully empty shared store still requires compiling the roster once.
