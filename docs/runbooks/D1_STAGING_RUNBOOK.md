# Isolated D1 staging setup

This procedure applies only to the fictional staging prototype. It does not deploy the current Apps Script project or authorize production data migration. Read the [prototype runbook](D1_PROTOTYPE_RUNBOOK.md) first. Keep account/database IDs and secret values out of Git, terminal output and release manifests.

Observed on 2026-11-05: source `ea258715d890697b389b788c5caffc57eca6cf98` was deployed to isolated staging through the connected API. The initial schema/ledger, integrity checks and fictional cloud smoke passed. Three synthetic commands and their audit entries were recorded, three projection jobs were consumed by the smoke test, and the database was returned to `accepting_commands=0`. A correctly signed mutation was then rejected by the pause fence. Live Google publication was not tested. The private operations repository holds the release record.

## Prepare a reviewed release

From a clean, committed public checkout whose checks have passed:

```sh
npm run check
node scripts/prepare-v3-release.mjs --environment staging --generation 1
node scripts/prepare-v3-release.mjs --environment staging --generation 1 --verify
```

The helper rebuilds the Worker and Google adapter from that commit and writes ignored `.build/v3-release/` artifacts. The manifest records the source commit, checksums, migration version, environment, generation and runtime compatibility date. The metadata template contains placeholders; it never contains a real database ID or signing secret. `--verify` checks the prepared files without rebuilding or deploying them. To verify an older release, use its recorded source checkout; verification intentionally rejects a different current commit. Local emulator tests and the cloud runtime may have different compatibility dates; real staging validation is required.

Deployment is through the connected Cloudflare API in this phase. No paid subscription, custom domain, extra storage service or GitHub deployment feature is needed for this procedure. API resource creation does not itself verify an account's billing subscriptions. If the OAuth connection lacks billing access, report that limit instead of claiming the account's plan was verified.

## Provision only the intended staging account

1. Authenticate the explicitly selected SHAMROCK Cloudflare connection. List accounts and verify the intended identity before writes. List existing Workers/databases and reuse only an identified staging resource; never silently adopt or overwrite an unfamiliar resource.
2. Create one D1 database named `shamrock-staging`, using the Eastern North America placement hint and disabled read replication. A placement hint is not a data-residency guarantee. Record actual bindings in provider configuration, not the repository.
3. Ensure the account's free `workers.dev` subdomain exists. Upload only the staging Worker under `shamrock-staging`; no production routes or Google files change.
4. Keep `BRIDGE_SECRET` in a concealed 1Password item for recovery and a Worker `secret_text` binding at runtime. The initial item is titled **SHAMROCK staging bridge** and belongs alongside the new project account credentials. Verify that designated custodians can access the vault before handoff; a private vault is not automatically shared with successors.

The plugin can create resources and upload the already built module using the Cloudflare REST API. Discover the current endpoint schemas before execution. Never print an upload request containing the secret. Do not invent CLI commands or add deployment credentials to an artifact.

## Apply the initial migration safely

`migration-plan.json` contains API-ready preflight queries, the bootstrap batch and expected schema signatures. Read the schema first; read the ledger/control only if their tables exist. The helper classifies a truly empty database as ready to bootstrap, a complete matching migration as a no-op, and any partial/unknown schema or hash mismatch as requiring review.

Apply the complete `bootstrap.batch` in a single D1 REST query request. The first assertion rejects an unexpected schema inside that transaction. The batch creates the application schema, a migration ledger and `system_control` with `accepting_commands=0`. Inspect every result, then verify the ledger hash, complete schema, staging generation, `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Do not mask an incomplete migration with `CREATE TABLE IF NOT EXISTS` or manually mark a failed migration complete.

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

Record the source commit, hashes, migration verification, Worker configuration, synthetic result and final paused state in the private operations repository. Complete live Google identity checks, real spreadsheet publication and recovery before advancing beyond this stage. A passing smoke test is not full feature parity or a capacity certification.
