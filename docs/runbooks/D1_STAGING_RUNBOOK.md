# Isolated D1 staging setup

This procedure applies only to the fictional staging prototype. It does not deploy the current Apps Script project or authorize production data migration. Read the [prototype runbook](D1_PROTOTYPE_RUNBOOK.md) first. Keep account/database IDs and secret values out of Git, terminal output and release manifests.

Observed on 2026-11-05: source `5e1057f4a13c45960e70844724aa5261e49f422e` is deployed to the isolated Cloudflare Worker and Google staging script. The owner-account rehearsal exercised real Google Forms, a sheet decision, D1 persistence and Google projection publication with fictional records. The Worker is fenced at `accepting_commands=0` and both staging Forms are closed. The operator confirmed `shamrockV3StagingPause`, and its completed execution was independently observed in the staging editor; Script Properties were not directly read back. A separate [production account handoff](ACCOUNT_HANDOFF_RUNBOOK.md) transferred six private resources and the 11 existing automations to the project account, preserving production source and resource bindings. This did not migrate production to D1 or reopen staging. The private operations repository holds the detailed release record.

## Verified live Google checkpoint

The operator linked the staging script to its standard Google Cloud project and completed Import and Setup. Headers were verified on all four journal/output tabs. The two uploaded script files still exactly match the deployed release; the rehearsal did not modify their source.

| Live check | Observed result |
|---|---|
| Attendance Form | One complete report covering two fictional people committed. The selected member was recorded as `P`; the nonselected member's observed code remained blank. |
| Duplicate delivery | Resending the identical saved command payload from that native response returned its original receipt and added no command. This was not a second Form submission with a new response ID. |
| Excusal Form | A new request committed as `Submitted`, requested outcome `E`, version `1`. Existing observed `P` remained intact. |
| Spreadsheet decision | An owner-account edit of `D3` to `Denied` acted on a **preseeded request**, advancing it from version `2` to `3`. Its audit evidence was `google-edit`. The input's frozen base version `2` and entered value remained intact. |
| Journal and publication | All three Google journal entries reached `committed` on attempt `1`; the three Google projection jobs were acknowledged as done. Output and cursor revision reached `9`. |
| Final database | Nine commands, nine audit records and nine completed jobs, with zero unfinished jobs. Integrity checks passed and the foreign-key check reported no violations. The first six jobs were completed by earlier test clients; the latest three exercised Google publication. |

The decision input's `draft_state` still reads `Queued: Denied` after the accepted decision. This is an unreconciled UI status, not a requirement to preserve. Use the command receipt and protected recorded result/version to establish completion until draft-status reconciliation is implemented.

This checkpoint validates the narrow owner-account path. Cross-domain `e.user`, authenticated confirmation for an unknown editor, dynamic input slots for newly submitted requests, concurrent human edits, failure recovery and full feature parity remain unfinished. The new excusal submission and the decision on the preseeded request were separate checks.

## Prepare a reviewed release

From a clean, committed public checkout whose checks have passed:

```sh
npm run check
node scripts/prepare-v3-release.mjs --environment staging --generation 1
node scripts/prepare-v3-release.mjs --environment staging --generation 1 --verify
```

The helper rebuilds the Worker and Google adapter from that commit and writes ignored `.build/v3-release/` artifacts. Format 2 includes each ordered SQL source under `migrations/`; previously recorded format-1 releases remain historical rollback artifacts, not current upgrade plans. The manifest records the source commit, checksums, migration version, environment, generation and runtime compatibility date. The metadata template contains placeholders; it never contains a real database ID or signing secret. `--verify` checks the prepared files without rebuilding or deploying them. To verify an older release, use its recorded source checkout; verification intentionally rejects a different current commit. Local emulator tests and the cloud runtime may have different compatibility dates; real staging validation is required.

Deployment is through the connected Cloudflare API in this phase. No paid subscription, custom domain, extra storage service or GitHub deployment feature is needed for this procedure. API resource creation does not itself verify an account's billing subscriptions. If the OAuth connection lacks billing access, report that limit instead of claiming the account's plan was verified.

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

Prepare two private, explicitly named staging workbooks and two staging Forms containing only fictional data. The journal workbook contains separate command-journal and projection-cursor tabs. The operator workbook contains attendance results, recorded excusal results and a separate decision-input tab. The four journal/output tabs begin empty for the initializer; decision input uses the exact headers and fixed target slots in the [adapter contract](../../apps/google-adapter/README.md). Never bind these names to production by guessing or create replacements for missing configured resources.

Protect each output tab as a whole sheet, with no unprotected ranges and no ordinary protection editors. Protect decision metadata and permit only its draft-decision cells as inputs. Configure Forms to collect `VERIFIED` emails and restrict edit access to the automation owner. Keep them unpublished until a controlled rehearsal. Validate native Apps Script item IDs against the configured item roles; a REST item ID's textual encoding is not sufficient evidence.

Store configuration, identity enrollment and immutable choice catalogs in Script Properties as documented in the adapter README. Keep the HMAC key in its own concealed Script Property and the password vault. Actual identities and provider resource IDs belong in private runtime configuration, never either repository. Enroll test operators against fictional D1 principals; this is not permission to copy production rosters into staging.

Run `shamrockV3StagingSetup` manually as the automation account, granting the staging runtime consent. Setup verifies existing resources, initializes the journal and outputs and reconciles its versioned triggers. It remains paused. Confirm both the host and projection setup receipts before running `shamrockV3StagingResume`. The Worker also remains fenced until explicitly enabled for the rehearsal. Submit a real test response after setup, verify the D1 receipt and protected sheet output, test repeated delivery, and then pause both sides again. Record native identity, protection and publication evidence separately from mock-test results.

Do not migrate production automation as part of this rehearsal. Use the [account handoff runbook](ACCOUNT_HANDOFF_RUNBOOK.md) for its existing resources, old-owner trigger inventory, controlled replacement and recovery.
