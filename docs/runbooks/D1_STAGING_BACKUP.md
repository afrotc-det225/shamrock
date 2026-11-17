# Staging backup, restore proof and support report

`node scripts/staging-backup.mjs --help` is the checked-in successor workflow for a paused staging D1 backup. It uses the existing Cloudflare account, Google Drive and 1Password. It does not create a database, change schema or records, enable billing, delete retained backups, or restore anything into a hosted database. Production remains outside this command's scope.

The runner uses Node's built-in SQLite support and the repository's migration verifier. It supports every exact known migration prefix through the current checked-in migration directory; schema versions are not hardcoded. Unknown schema, unpaused control, a mismatched generation, integrity errors or foreign-key failures stop capture.

For connected-plugin access without a separate local Cloudflare token, use the [hosted restore rehearsal](D1_HOSTED_RESTORE.md) and its offline native-export verifier.

## Private setup

Keep configuration, pause evidence, exports and journals in an owner-private directory outside Git or under an ignored directory. Directories must have mode 0700 and files mode 0600, belong to the current operator, and not be symlinks. The tool never overwrites a prior export. Choose a new capture directory for each backup.

The runtime JSON configuration has this shape. Replace placeholders only in the private copy:

```json
{
  "version": 1,
  "environment": "staging",
  "generation": 1,
  "rollbackSourceCommit": "DEPLOYED_WORKER_SOURCE_COMMIT",
  "cloudflare": {
    "accountId": "ACCOUNT_ID",
    "databaseId": "STAGING_DATABASE_ID",
    "tokenReference": "op://SHARED_VAULT/BACKUP_TOKEN/password"
  },
  "destination": {
    "folderId": "OWNER_PRIVATE_BACKUP_FOLDER_ID",
    "ownerEmail": "owner@example.invalid",
    "gcloudConfiguration": "automation"
  }
}
```

`op read` retrieves the Cloudflare token only into process memory. Use a token scoped to the intended account and the D1 permissions required for query/export. No token or environment file belongs in Git. Drive upload uses the explicitly named existing Google CLI configuration/account; that account needs Drive access. The runner does not start consent or change the default CLI account. An unavailable/unlocked vault or expired Google consent stops with a sanitized error.

Prepare a separate private pause attestation after verifying that staging Google intake, dispatch, publication and mail are paused and staging Forms closed. It contains `environment:'staging'`, the intended `generation`, `adaptersPaused:true`, `sourceCommit` matching the deployed rollback source, and current UTC `verifiedAt`. Capture and recovery review require an attestation less than 15 minutes old. This is an explicit operator attestation about Google; the backup tool itself verifies D1's paused control and does not claim to inspect Apps Script's private flags.

## Capture and prove the restore

```sh
node scripts/staging-backup.mjs capture \
  --config PRIVATE_CONFIG \
  --pause-evidence PRIVATE_PAUSE_ATTESTATION \
  --private-dir NEW_PRIVATE_CAPTURE_DIRECTORY
```

Commit the owning backup/migration code first. Capture verifies the migration ledger, complete schema and paused state, then reads application tables and SQLite sequence state through bounded keyset pages. Wide row fingerprints use bounded JSON fragments within D1’s 32-argument SQL function limit. Each row hash includes SQLite value types and exact hexadecimal text/blob bytes, preserving Unicode, embedded NUL and integer precision. Per-table hashes are independent of insertion order and detect missing, changed or duplicate rows. No raw record appears in progress output.

The native [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) creates a SQL download. Export can temporarily make the selected staging database unavailable; the runner polls its returned bookmark until completion, then downloads without forwarding the API credential. It restores the SQL into fresh local SQLite, verifies exact schema/ledger/control, integrity, foreign keys and every table hash, and compares the hosted source again after export. The CLI also restores the same SQL to a fresh private `restored.sqlite` file and repeats the proof. A concurrent source change fails the backup instead of certifying mixed state. The supported [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) supplies read-usage counters when available.

Private artifacts are `backup.sql`, `restored.sqlite`, `capture.json`, `preflight.json`, `pause-evidence.json`, and `recovery-candidate.json`. The candidate has `reviewed:false`; the successful local restore establishes `restoreVerified:true`. This proves an isolated local restore of the hosted export. It does **not** establish a hosted D1 restore or native spreadsheet recovery; those remain separate rehearsal steps.

`support.json` is a whitelisted summary containing schema/source versions, aggregate table/row counts, SQL size, query count and restore kind. It omits resource IDs, accounts, record values, per-row hashes, raw errors, secrets and signed URLs. Share only this report when raw operational records are unnecessary. The other artifacts remain private.

## Verify owner-private hosted custody

After reviewing the capture, use its printed `captureSha256`:

```sh
node scripts/staging-backup.mjs upload \
  --config PRIVATE_CONFIG \
  --private-dir PRIVATE_CAPTURE_DIRECTORY \
  --review-sha CAPTURE_SHA256
```

Upload requires a My Drive folder owned solely by the expected automation account, with exactly that owner's permission. Shared drives, domain/link access, additional editors/readers and ambiguous permissions are rejected. The runner allocates a [Drive file ID](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds), journals it before upload, and uses a resumable binary SQL upload. Google documents that [retries with a pre-generated ID](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files) avoid duplicate files after an uncertain response. Re-run the same command and directory after interruption; it checks the same file identity rather than allocating another backup.

Successful custody requires the expected owner, exact parent, owner-only ACL, byte count, content hash tag and SHA-256 of the downloaded file. It rechecks the parent and file permissions after download. The private `drive-upload.json` records the file ID, resumable session URL and verified state. Treat that session URL as private. The runner saves the session before sending bytes and checks Google’s acknowledged offset before resuming a partial upload. An expired session fails with `BACKUP_DRIVE_SESSION_UNAVAILABLE`; retain its journal and inspect the same allocated file before planning a separate upload. Never erase the journal to force a retry. It does not modify sharing to make a bad destination appear safe, overwrite different content, or delete a questionable upload. Storage exhaustion fails normally; the runner never purchases capacity or attaches paid storage.

## Produce the migration recovery record

After reviewing the proof and re-verifying paused Google state, run:

```sh
node scripts/staging-backup.mjs review-recovery \
  --config PRIVATE_CONFIG \
  --pause-evidence FRESH_PRIVATE_PAUSE_ATTESTATION \
  --private-dir PRIVATE_CAPTURE_DIRECTORY \
  --review-sha CAPTURE_SHA256
```

Review validates the immutable capture and SQL hashes, checks the candidate against the captured proof, and rereads current D1 table hashes/schema/paused control. A changed source requires a new backup. It writes `recovery-reviewed.json` with the exact existing migration-helper contract: `environment`, `generation`, `fromVersion`, `evidenceSha256`, `backupSha256`, `rollbackSourceCommit`, `reviewed`, `restoreVerified`, and `adaptersPaused`. Use it with `preflight.json` in the guarded [staging migration procedure](D1_STAGING_RUNBOOK.md#upgrade-a-paused-staging-database). This review does not apply an upgrade or restore.

The capture folder has an exclusive local lock. A normal error releases the lock and retains evidence. After a process crash, `recover-lock --private-dir PRIVATE_CAPTURE_DIRECTORY` removes only a lock owned by a confirmed-dead process on the same computer; an active or foreign-host lock requires investigation. Re-run upload with the same journal. Start a new capture directory after an interrupted capture; do not reinterpret partial artifacts as verified.

## Bounds and rehearsal evidence

The reviewed limits are 128 MiB of SQL, 32 rows per query, 10,000 read queries per capture/review and 1,000,000 rows per table. These are fail-closed tool bounds, not increased D1 or frontend limits. Actual row-read counters and request counts are saved privately. Run backups before a schema change or term transition and retain them according to a separately reviewed policy; this tool does not create an automatic schedule or destructive retention. Existing Drive capacity and D1 daily query allowances still apply.

Local regressions cover current and older migration prefixes, exact typed rows/sequence state, corrupted or raced sources, unpaused/unknown schema, unsafe SQL rejection, private ACLs, corrupt download readback, polling credentials, lost upload acknowledgements and partial-byte upload resumption. A private rehearsal also restored the existing schema 13 real-data export twice with exact table hashes and clean foreign keys. No provider write or upload was performed by these implementation tests. Before relying on hosted custody, run capture/upload against the intended paused staging resources and retain the actual result.
