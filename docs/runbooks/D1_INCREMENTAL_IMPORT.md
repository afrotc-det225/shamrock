# Paused staging data refresh

Use `scripts/lib/import-refresh.mjs` after the initial private import. The initial importer and operational-adoption initializer require an empty destination and must not be replayed against an existing rehearsal. This workflow has no production target or Google mutation client.

## Prepare and review

1. Finish or preserve any running native History publication. Its pinned snapshot IDs remain immutable. Keep Google frontend/input/Form/permission publishers paused during a canonical refresh; a pending publication must not apply stale command bindings.
2. Export the exact staging database to an ignored private directory and retain its SHA-256. Capture current production resources read-only using the private import workflow. Recheck Drive versions and actual Form-response content immediately before application; recapture any changed source. A coherent capture is optimistic evidence, not a production writer lock.
3. Compare the capture against the retained source occurrences and canonical rows. Review concrete changes, ambiguous rows, source locators and source versions. Supply the planner with complete before/after rows, an append-only evidence ledger, explicit review and the immutable source commit. Record the exact schema-16 migration ledger, staging generation, administration revision and backup hash.
4. Preserve existing person, event, baseline, request and contact IDs. Contacts in the initial importer were keyed by source position: match retained linked contacts by canonical person ID, and manual contacts by exact unique name/email identity before allocating a new ID. A moved source row must never retarget an existing contact.
5. Increment changed profile/contact/request/event versions. A changed event gets a new audited event command and a copy of its retained frozen roster at the new event version. Baselines remain imported effective state; historical submissions, actors, approvals and notification jobs are not fabricated.
6. Rehearse every batch against the exact local backup. Check interrupted execution, repeated batches, stale-row rollback, exact readback, foreign keys, unchanged canonical keys and all previous raw evidence. Obtain a fresh account-wide free-tier sample and reserve headroom for subsequent permission reconciliation and spreadsheet publication. Do not upgrade a plan to make an import fit.

The private plan is deliberately explicit. `createIncrementalImportPlan` accepts `before`, reviewed `desired` rows, append-only `evidence`, `context` and `review`; it does not discover production files or infer operational decisions. Store its execution hash alongside the review. The tracked helper rejects unsupported tables, retargeted baseline/request/contact identities, incorrect version increments, changed schema and non-staging targets.

## Apply the reviewed plan

Use the existing staging API transport with explicit account/database bindings. `assertIncrementalImportTarget` must match the observed target and approved execution hash before any write.

- Run `initialize`, then the pending `steps` returned by `inspectIncrementalImportResume`. Each evidence step is an atomic, bounded, idempotent batch; a lost response can be inspected or safely retried using the same immutable plan. Do not regenerate timestamps or hashes during a resume.
- Run `verifyIncrementalImport(plan, {readBatch, phase: 'evidence'})` and require `verified: true` **before** finalization. This compares actual raw values, not just stored fingerprints or counts. It uses indexed primary-key reads of the selected rows.
- Execute the complete `finish` array as **one transaction**. It checks staging pause, suppressed mail, no operational commands/effects, the exact migration ledger, administration revision, completed evidence receipts and each affected before-row. It then applies the canonical delta and audit together. Any failed condition rolls back the whole swap.
- Require `verifyIncrementalImport(plan, {readBatch})` to pass after completion. Inspect exact selected values and the single refresh audit. Full database integrity and unchanged-table comparisons belong in the local backup rehearsal; avoid remote full-table scans merely to reproduce those checks.
- If role policy is enabled, issue the supported permissions command with no added/revoked accounts and the current expected policy version after the refresh. It recomputes derived grants from updated profiles/Leadership. Keep its Google permission publication paused until the resulting reviewed plan is ready. Never infer a verified principal from a typed Form respondent email.
- Publish the updated staging projections through their normal resumable workflows. Preserve native binding IDs, pending edits, filter views, protections and spreadsheet formatting. Verify current event labels, roster versions, selected attendance cells and request routing before allowing a rehearsal edit.

The estimator uses conservative index-write allowances. Canonical patch SQL is driven by at most 100 JSON rows with an indexed primary-key target lookup; it does not scan the whole attendance matrix for each changed cell. Evidence reads and writes are bounded per chunk. The execution receipt increases the administration revision, invalidating cached frontend snapshots without periodic polling.

## Resume after a free-tier quota stop

A D1 quota response is a storage availability failure, not evidence that a Google account lacks permission. Do not bootstrap another account, weaken authorization, repeatedly retry large reads or upgrade the plan to get past it. Keep production unchanged and preserve the staging checkpoints.

If no import batch has been applied, freeze the coherent source snapshot and local rehearsal as a dated review artifact. After the daily UTC quota reset, obtain fresh account-wide usage, recheck source Drive versions and actual Form responses, and observe the exact staging generation, migration ledger, permission policy and administration revision. A changed source requires a new coherent capture; a changed destination requires a new backup. Regenerate and rehearse the plan from those inputs before approving its new execution hash. A locally passing earlier plan is not a claim that its sources are still current.

If evidence batches have already been applied, inspect the saved immutable execution plan and durable receipts first. Resume that exact reviewed plan only while its fences still hold; do not regenerate its timestamps, replace its source snapshot or replay initialization from a different plan. Require indexed evidence readback before the final atomic swap. Recheck remaining daily read/write headroom before advancing to another batch, verification phase or native publication. Current production edits belong in a subsequent reviewed refresh, with all earlier evidence retained.

## Retained predecessor attendance

`scripts/lib/import-predecessor.mjs` supports the specific original human-header Attendance format: Year, Last Name, First Name, University Email Address, Flight, Total, LLAB, then training-week event columns. It retains the original typed cells and formulas. Metadata explicitly declares the first data row and identity-column mapping; the email column is never displayed as an identity field in a historical report.

The original Fall 2025 formula credits some pending, denied and tardy codes differently from later SHAMROCK. The reader recognizes the entire saved formula, preserves its historical policy and reports saved percentages separately from current rules. Unknown or modified formulas remain unavailable for recalculation rather than being guessed. Old event columns keep snapshot identities and never inherit current event eligibility. Conflicting names on an email remain visible unresolved rows.

Retained source copies remain separate reports, including older and newer captures of the current workbook. Operational request history selects the most recent completed source adoption for each request while retaining all earlier raw evidence. An active History publication pinned to an older catalog can finish unchanged; a subsequent publication can include the new reports.
