# Private retention and historical response lookup

The staging adapter can archive exact Form editions, completed intake and applied input receipts in an automation-owned Drive folder. This is storage maintenance, not a new public frontend or a data deletion policy. No archive object is deleted, shared, overwritten with different content or placed in Git. Unresolved drafts, attempted commands without receipts, conflicts, rejected work and pending publication plans stay in the active journals.

The previous Directory catalog duplicated every complete profile in every edition. With the reviewed 113-profile snapshot, one edition measured 122,978 bytes locally; fewer than 33 such editions fit the old four-million-character catalog cap before the other Forms were counted. The new catalog stores immutable groups of up to 32 profiles and up to 256 references, reusing identical groups across editions. Only the current and incoming editions stay active. Every historical choice token retains its exact Form, edition and original profile/roster/event version. A delayed response resolves the archived edition after a process restart; it never silently adopts today's expected versions.

## Private binding

Add an optional `retention` object to the provider-owned Forms/input configuration:

```json
{"retention":{"version":1,"archiveFolderId":"PRIVATE_FOLDER_ID","indexFileId":"PRIVATE_INDEX_ID"}}
```

Provision an owner-only Drive folder and an `application/json` index inside it. Its initial content is:

```json
{"version":1,"environment":"staging","generation":1,"buckets":{}}
```

Use the actual reviewed generation. Keep the folder/index separate from every live workbook, Form, active journal and configuration file. The existing Drive OAuth scope is sufficient; no additional paid service, environment file or subscription is needed. Missing configuration preserves the existing fail-closed storage limits; it does not silently discard evidence. Enable this binding before a realistic long-running rehearsal.

The native adapter checks the folder and each file's owner, complete permissions, MIME type, parent and bounded size. Only the configured automation owner may have access. Native names are generic and contain no person, response, command or token identifier. Actual object identities remain inside private JSON. Index/checkpoint saves compare exact prior content under the shared ScriptLock and verify new content and metadata; metadata-only Drive version changes do not permit a changed payload.

## Interrupted archival and lookup

Drive IDs are [reserved before file creation](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds). The exact ID, content hash and pending content persist in the index before a [multipart upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads). A failed or ambiguous upload retries that same ID and exact JSON. A different existing object is never replaced. The active journal/catalog shrinks only after complete archive readback. Pending index splits retain the original index until every reserved child verifies, then switch the directory pointer. A restart completes the same split; old shards remain available for recovery.

Token lookups use bounded hash-prefix indexes. A publication batches reference changes per shard rather than writing one Drive file per token. Full shards split into narrower prefixes automatically. Each immutable object is bounded to 256 KB; catalog components are split before archival. Indexes are bounded to 2 MB with normal splitting well below that. The top-level directory is also bounded. Hashes are corruption and identity checks, not a claim that the Google owner cannot edit a file.

Forms intake compaction retains at least 32 recent completed entries and archives at most 32 older committed entries per pass after 128 active entries or 512 KB. It retains the exact native response fingerprint and receipts, so replay of an old completed response returns its prior state without another command. Pending review, conflict and rejection remain discoverable in the active review queue. Reviewed Attendance/Excusal replay preserves original sources and all review receipts; completed-entry compaction archives those receipts unchanged. It never resets attempted commands or updates an old choice to a new edition.

Input compaction requires every command's verified receipt to have already advanced the exact frontend baseline, and its visible status to have been reconciled. Receipt hashes archive before active markers are pruned. Old journal recovery still consults archived hashes and cannot apply the same receipt twice. Completed supersessions preserve their capture-sequence counters, preventing reuse of a cancelled edit identity. Unapplied or uncertain work remains active. The native input host runs this compactor after visible receipt notes reconcile, under the same publication lock and permission fence. Archived confirmations validate their frozen actor and payload, then return the prior terminal status without dispatching. A current provider rehearsal is still required before activation.

## Reviewed volume rollover

Normal shard splitting avoids the former per-semester catalog limit. For a reviewed storage reorganization, provision a fresh private folder/index while paused and add the former binding to `previous` on the new binding:

```json
{"version":1,"archiveFolderId":"NEW_FOLDER_ID","indexFileId":"NEW_INDEX_ID","previous":[{"version":1,"archiveFolderId":"OLD_FOLDER_ID","indexFileId":"OLD_INDEX_ID"}]}
```

Finish pending archive writes/splits, export and hash the old directory and corresponding active checkpoints first. Verify old response/receipt lookup through the new binding before resuming. Lookups search the retained volumes and reject contradictory records; new records go only to the current volume. Do not remove the previous binding or change its generation while old responses, receipts or backups may need it. Up to four previous volumes are supported, after which a reviewed consolidation is required. This is an operational rollover path, not automatic deletion or paid expansion.

Include Drive bytes, file counts, index sizes and actual URL Fetch/trigger time in the free-tier forecast. Initial archival and shard rotation cost more requests than an idle tick. Local tests cover 80 Directory editions, shared profile blocks, exact old-token lookup, batched indexes, interrupted creates/splits, tampering and receipt recovery. Actual Drive creation/ACL/restart behavior, native intake integration and a custodian restore still require isolated hosted proof.
