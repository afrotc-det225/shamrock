# Hosted restore rehearsal without a local API token

The connected Cloudflare plugin can authorize native export/import requests. `scripts/staging-restore-plan.mjs` performs the local inspection, comparison and plan preparation without credentials, environment files or provider calls. It reuses the checked-in backup verifier for exact typed row hashes, schema/ledger/control, integrity and foreign keys. The ordinary [backup runner](D1_STAGING_BACKUP.md) remains available when a scoped API token is accessible.

This procedure replaces the contents of an existing, explicitly disposable **staging restore database**. Keep the source database and Google adapters paused throughout. The target must have no Worker or Pages binding. Never use a production database, an operational staging database, a newly assumed target, or an account chosen from its display name alone.

## Preserve and inspect both databases

1. Select the authorized plugin account explicitly. Read the complete database and Worker inventories, every Worker's D1 settings, and Pages production/preview bindings. Record the exact source and target UUID/name, account ID, current generation and inventory time privately. The target name must contain `restore`; a name alone is insufficient proof that it is disposable.
2. Read the source and target's complete schema, ordered migration ledger and `system_control` using the existing migration preflight queries. Require paused staging, matching generation and exact known schemas. Capture native exports of **both** source and old target before preparing any destructive operation. Keep SQL, signed URLs and the evidence private.
3. Use the plugin [export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) with `output_format:'polling'` and normal D1 compatibility. Continue with the returned bookmark until complete. Download the resulting signed URL locally over HTTPS, without forwarding any API credential. Export temporarily blocks that selected database; perform it only while paused. Do not use `sqlite3_cli_only`, which is not a D1 import format.
4. Inspect the files independently:

```sh
node scripts/staging-restore-plan.mjs inspect \
  --source-sql PRIVATE_NATIVE_EXPORT --generation 1 \
  --out-dir NEW_PRIVATE_INSPECTION_DIRECTORY
```

Files must be mode 0600, owner-held regular files. Output directories are new mode 0700 directories outside Git or under an ignored path. Inspection proves the supplied SQL's local restoration; it does not certify which hosted database supplied an untrusted file. Bind each file to its actual plugin export response and live preflight evidence.

## Prepare a concrete reset and import

Create a private route JSON with these fields:

```json
{
  "formatVersion": 1,
  "environment": "staging",
  "generation": 1,
  "observedAt": "FRESH_UTC_TIME",
  "disposableTarget": true,
  "accountId": "ACCOUNT_ID",
  "source": {"uuid": "SOURCE_UUID", "name": "SOURCE_NAME"},
  "target": {"uuid": "RESTORE_UUID", "name": "shamrock-staging-restore-NAME"},
  "sourceSqlSha256": "SOURCE_EXPORT_SHA256",
  "targetSqlSha256": "OLD_TARGET_EXPORT_SHA256",
  "sourceEvidenceSha256": "LIVE_SOURCE_MIGRATION_EVIDENCE_HASH",
  "targetEvidenceSha256": "LIVE_TARGET_MIGRATION_EVIDENCE_HASH",
  "inventoryComplete": true,
  "workerBindings": [{"name": "WORKER_NAME", "databaseIds": ["BOUND_D1_UUID"]}],
  "pagesBindings": []
}
```

Use `migrationEvidenceHash(inventory,ledger,controls)` from `scripts/lib/v3-migrations.mjs` for the live evidence hashes. Include every Worker. Each Pages entry represents a project with the union of production and preview D1 UUIDs. The route is an explicit observation record, not a provider-signed credential; retain the API responses behind it. A stale observation, bound target, mismatched export/evidence hash or non-current source schema prevents planning.

```sh
node scripts/staging-restore-plan.mjs prepare \
  --source-sql PRIVATE_SOURCE_EXPORT --target-sql PRIVATE_OLD_TARGET_EXPORT \
  --route PRIVATE_ROUTE_JSON --generation 1 --out-dir NEW_PRIVATE_PLAN_DIRECTORY
```

Review `manifest.json`, both inspections, `reset-batch.json`, `reset.plugin.js` and `import.sql`. The manifest binds the source/old-target backups, route evidence, source revision, reset statement count and import SHA-256/MD5. Source and target must differ. No plan command performs a provider write.

`reset.plugin.js` is a **destructive action for separate review and execution**. Immediately before its sole reset request it rechecks account, both database identities, source pause/schema, the complete expected Worker/Pages inventory and absence of target bindings. Its evidence expires after 15 minutes. The one transactional D1 query batch asserts the target's exact schema, ledger, paused generation and table counts, then drops tables in child-before-parent order. An assertion failure rolls that batch back. The old-target export remains the recovery copy. This guard does not compare every old-target row inside the transaction; maintain exclusive administrative access during the rehearsal.

After reset, query the target inventory to confirm it contains only provider/SQLite internal objects. The import file begins with an emptiness assertion, so an unexpectedly populated destination stops before loading source records. Reset and asynchronous import are separate operations; a failure between them leaves the isolated target empty. Keep it unbound, and inspect retained state before planning recovery.

## Import through the existing plugin

The [native import API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/) uses these explicit steps against the reviewed target UUID:

1. POST `{action:'init',etag:manifest.importMd5}`. Retain the returned `filename` and upload URL privately.
2. Upload the exact `import.sql` bytes with HTTPS PUT to that presigned URL, without API authorization headers. Verify a successful response and its content MD5/ETag when returned. This is Cloudflare's native import staging upload; no customer R2 bucket or paid storage setup is needed. If init reports the content already uploaded and omits the URL, retain that provider result and use its same filename.
3. POST `{action:'ingest',etag:manifest.importMd5,filename:RETURNED_FILENAME}`. Save the returned bookmark before further action.
4. Poll `{action:'poll',current_bookmark:BOOKMARK}` until terminal success or failure. Preserve the same bookmark after ambiguous responses. Do not blindly repeat ingest or delete records to clear an error. Save the final bookmark, statement count, duration, rows read/written and resulting database size.

The plugin handles the authenticated API requests; only the presigned byte transfer happens locally. Never print signed URLs or SQL records into a support report.

## Compare the restored result and measure usage

Export the restored target through the plugin and compare its SQL with the original source:

```sh
node scripts/staging-restore-plan.mjs compare \
  --source-sql PRIVATE_SOURCE_EXPORT --restored-sql PRIVATE_RESTORED_EXPORT \
  --generation 1 --out-dir NEW_PRIVATE_COMPARISON_DIRECTORY
```

The comparison requires exact schema/ledger/control, every application-table row and SQLite sequence state, clean integrity/foreign keys and paused commands. SQL serialization order may differ; canonical table hashes must match. Re-export the still-paused source after the exercise and compare it too, establishing that the source did not change while the target was being restored. Retain live target integrity/FK/control reads and binding readback alongside both comparisons. A local match between arbitrary files alone is not hosted restore evidence.

Record SQL byte sizes, source/target database storage before and after, account database count/storage, read-check `rows_read`, reset/import `rows_written`, import duration, request count and export/import bookmarks privately. Current [free limits](https://developers.cloudflare.com/d1/platform/limits/) are ten databases, 500 MB per database and 5 GB total; the published [daily allowances](https://developers.cloudflare.com/d1/platform/pricing/) are five million rows read and 100,000 written. Native import/export is excluded from daily query limits according to the [D1 enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/); ordinary reset and verification queries still count. Reuse the existing target and stop on capacity errors. This procedure never enables billing or raises provider limits.

On completion leave the target unbound and paused. Hosted data restoration does not establish recovery of Google Script Properties, private checkpoints, workbook protections, or a successor's independent account access; those remain the corresponding steps in the [successor rehearsal](D1_SUCCESSOR_REHEARSAL.md).
