# Paused staging data refresh

Schema 19 adds a separate Directory contact-email table. The staging incremental planner preserves that table. Verify contact-email overrides separately when reconciling the final Directory snapshot.

Use `scripts/lib/import-refresh.mjs` after the initial private import. The initial importer and operational-adoption initializer require an empty destination and must not be replayed against an existing rehearsal. This workflow has no production target or Google mutation client.

## Prepare and review

1. Finish or preserve any running native History publication. Its pinned snapshot IDs remain immutable. Keep Google frontend/input/Form/permission publishers paused during a canonical refresh; a pending publication must not apply stale command bindings.
2. Export the exact staging database to an ignored private directory and retain its SHA-256. Capture current production resources read-only using the private import workflow. Recheck Drive versions and actual Form-response content immediately before application; recapture any changed source. A coherent capture is optimistic evidence, not a production writer lock.
3. Compare the capture against the retained source occurrences and canonical rows. Review concrete changes, ambiguous rows, source locators and source versions. Supply the planner with complete before/after rows, an append-only evidence ledger, explicit review and the immutable source commit. Record the exact migration ledger for the supported schema version, staging generation, administration revision and backup hash.
4. Preserve existing person, event, baseline, request and contact IDs. Contacts in the initial importer were keyed by source position: match retained linked contacts by canonical person ID, and manual contacts by exact unique name/email identity before allocating a new ID. A moved source row must never retarget an existing contact.
5. Increment changed profile/contact/request/event versions. A changed event gets a new audited event command and a copy of its retained frozen roster at the new event version. For each changed or new attendance baseline, reference a source occurrence from this refresh. Completion advances the edit token on those cells, so a spreadsheet draft created before the change must be reviewed again. Unchanged baselines keep their original evidence and token.
6. Rehearse every batch against the exact local backup. Check interrupted execution, repeated batches, stale-row rollback, exact readback, foreign keys, unchanged canonical keys and all previous raw evidence. Obtain a fresh account-wide free-tier sample and reserve headroom for subsequent permission reconciliation and spreadsheet publication. Do not upgrade a plan to make an import fit.

The private plan is deliberately explicit. `createIncrementalImportPlan` accepts `before`, reviewed `desired` rows, append-only `evidence`, `context` and `review`; it does not discover production files or infer operational decisions. Store its execution hash alongside the review. The tracked helper rejects unsupported tables, retargeted baseline/request/contact identities, incorrect version increments, changed schema and non-staging targets.

### Offline interruption rehearsal

Use the exact native backup and immutable execution plan before submitting a new refresh. Both input files must be owned by the current user, private (`0600`) and outside source control. The output directory must be new and, if inside a repository, ignored by Git.

```sh
node scripts/rehearse-import-refresh.mjs \
  --source-sql /private/path/staging-backup.sql \
  --plan /private/path/refresh-execution.private.json \
  --out-dir /private/path/new-refresh-fault-rehearsal
```

This command makes no provider calls and requires no credentials. It first checks the backup hash, execution hash, staging generation and exact migration ledger. It restores a fresh private temporary SQLite database; it cannot accept an existing database target. At every SQL statement boundary in initialization, every evidence batch and finalization, a separate process executes that prefix in a transaction and is killed with `SIGKILL` before commit. Reopening must recover every table, `sqlite_sequence` and the durable resume checkpoint exactly. After each complete commit it reopens, checks the pending receipt list and repeats the identical batch to simulate a lost committed response.

Finalization requires exact evidence readback first. Completion requires exact canonical readback, integrity/foreign-key checks, one refresh audit and no operational commands. Restricted SQL execution blocks filesystem attachment, schema changes, extension loading and gate changes. Temporary raw records and journals are removed on completion or a handled failure; the private output contains only aggregate proof and hashes. If the rehearsal itself is forcibly terminated, its `shamrock-refresh-faults-*` temporary directory remains private and can be removed after that process exits.

Passing this rehearsal establishes local SQLite transaction recovery for these exact bytes. It does **not** establish hosted D1 availability, current production-source freshness, Google permissions or native spreadsheet behavior. A frozen plan still needs the source/destination freshness and free-tier checks below before hosted application. Never change the frozen source or plan merely to make a rehearsal pass.

## Apply the reviewed plan

Use the existing staging API transport with explicit account/database bindings. `assertIncrementalImportTarget` must match the observed target and approved execution hash before any write.

- Run `initialize`, then the pending `steps` returned by `inspectIncrementalImportResume`. Each evidence step is an atomic, bounded, idempotent batch; a lost response can be inspected or safely retried using the same immutable plan. Do not regenerate timestamps or hashes during a resume.
- Run `verifyIncrementalImport(plan, {readBatch, phase: 'evidence'})` and require `verified: true` **before** finalization. This compares actual raw values, not just stored fingerprints or counts. It uses indexed primary-key reads of the selected rows.
- Execute the complete `finish` array as **one transaction**. It checks staging pause, suppressed mail, no operational commands/effects, the exact migration ledger, administration revision, completed evidence receipts and each affected before-row. It then applies the canonical delta and audit together. Any failed condition rolls back the whole swap.
- Require `verifyIncrementalImport(plan, {readBatch})` to pass after completion. Inspect exact selected values and the single refresh audit. Full database integrity and unchanged-table comparisons belong in the local backup rehearsal; avoid remote full-table scans merely to reproduce those checks.
- For an enabled role policy, compare its source revision, the computed policy, effective memberships and grants, and pending publication jobs against the pre-import snapshot. If a profile, Leadership, or other policy input changed, use the supported permissions command with the current version to recompute grants before reopening edits. Preserve the existing account bindings and operational Squadrons. If those comparisons are identical, retain the existing policy version and any pending publication. Keep Google sharing fenced until its own reviewed publication is ready. Verified identity must come from the provider.
- Publish the updated staging projections through their normal resumable workflows. Preserve native binding IDs, pending edits, filter views, protections and spreadsheet formatting. Verify current event labels, roster versions, selected attendance cells and request routing before allowing a rehearsal edit.

For a repaired attendance import, compare every current cell by cadet and event ID and compare both percentages per cadet. Resolve every displayed R against its latest request. Check scoped N/A entries against the reviewed event and roster, including crosstown assignments. Read both native Forms back and resolve their actual choice tokens against the saved edition. Confirm that cancelled events are absent and retained events still lead to the intended branch. Comparing the Attendance Table's format, validation, notes, filters and dimensions before and after publication also detects writes that copied a neighboring cell's styling. Keep row-level evidence in restricted storage and record aggregate results for handoff.

The estimator uses conservative index-write allowances. Canonical patch SQL is driven by at most 100 JSON rows with an indexed primary-key target lookup; it does not scan the whole attendance matrix for each changed cell. Evidence reads and writes are bounded per chunk. The execution receipt increases the administration revision, invalidating cached frontend snapshots without periodic polling.

## Resume after a free-tier quota stop

A D1 quota response is a storage availability failure, not evidence that a Google account lacks permission. Do not bootstrap another account, weaken authorization, repeatedly retry large reads or upgrade the plan to get past it. Keep production unchanged and preserve the staging checkpoints.

If no import batch has been applied, freeze the coherent source snapshot and local rehearsal as a dated review artifact. After the daily UTC quota reset, obtain fresh account-wide usage, recheck source Drive versions and actual Form responses, and observe the exact staging generation, migration ledger, permission policy and administration revision. A changed source requires a new coherent capture; a changed destination requires a new backup. Regenerate and rehearse the plan from those inputs before approving its new execution hash. A locally passing earlier plan is not a claim that its sources are still current.

If evidence batches have already been applied, inspect the saved immutable execution plan and durable receipts first. Resume that exact reviewed plan only while its fences still hold; do not regenerate its timestamps, replace its source snapshot or replay initialization from a different plan. Require indexed evidence readback before the final atomic swap. Recheck remaining daily read/write headroom before advancing to another batch, verification phase or native publication. Current production edits belong in a subsequent reviewed refresh, with all earlier evidence retained.

## Retained predecessor attendance

`scripts/lib/import-predecessor.mjs` supports the specific original human-header Attendance format: Year, Last Name, First Name, University Email Address, Flight, Total, LLAB, then training-week event columns. It retains the original typed cells and formulas. Metadata explicitly declares the first data row and identity-column mapping; the email column is never displayed as an identity field in a historical report.

The original Fall 2025 formula credits some pending, denied and tardy codes differently from later SHAMROCK. The reader recognizes the entire saved formula, preserves its historical policy and reports saved percentages separately from current rules. Unknown or modified formulas remain unavailable for recalculation rather than being guessed. Old event columns keep snapshot identities and never inherit current event eligibility. Conflicting names on an email remain visible unresolved rows.

Retained source copies remain separate reports, including older and newer captures of the current workbook. Operational request history selects the most recent completed source adoption for each request while retaining all earlier raw evidence. An active History publication pinned to an older catalog can finish unchanged; a subsequent publication can include the new reports.
