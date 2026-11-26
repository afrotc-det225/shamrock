# Recovering missed manual Attendance edits

This procedure applies to the current Apps Script system. It does not deploy the D1 redesign. Preparing a report is read-only; deploying code, appending corrections and refreshing production require a separate approved execution window.

## Failure and durable fix

The former frontend edit handler read only the first row, column and value of an edited range. A multi-cadet or multi-event paste could therefore appear correct in the frontend while only its top-left cell reached Attendance Backend. A rebuild replays that backend log and can replace the other manual values with older records.

The corrected `onFrontendEdit` path clips edits to Attendance data cells, resolves each cadet and current event, and persists the complete correction batch before mirroring it. It rejects stale/ambiguous event headers and identities rather than selecting a positional substitute. Each cell has its own attendance submission and audit entry, linked by a shared operation ID. Bulk prior values are unknown, not invented; the audit metadata records that distinction. Explicit blank values are durable clears.

The backend mirror resolves targets once and sends sparse value updates in one Sheets API batch. It does not rewrite frontend cells that already contain the human edit. A failed mirror leaves the saved attendance records available for replay. Inspect the log before retrying an uncertain append; a failed provider response does not prove that nothing was saved. Manual submission IDs include the audit operation ID so the saved batch can be located even when the append response was lost before individual audits were written.

Manual attendance writes, attendance form commits, matrix rebuilds, initial excusal attendance effects and weekly closeout participate in the shared script lock. Existing excusal decision handlers already use that lock. The lock coordinates script executions, not human edits, sorts or external API writes. Do not run legacy bulk-fill or historical-response repair tools concurrently with incident recovery.

## Snapshot before repair

Do not refresh the restored frontend, rebuild its matrix, run Directory reconciliation that rebuilds Attendance, or restore/reset any other workbook while the incident evidence is being prepared.

Capture immutable, private copies of:

- The trusted restored Attendance grid, including both header rows, cadet identities, event labels, intentional blank cells, formulas and formatting metadata.
- Current Events Backend and Directory Backend.
- Complete Attendance Backend records in physical sheet row order, with original row numbers and submission timestamps/IDs. Replay uses row order, not timestamp sorting.
- Relevant Audit Backend rows, original row numbers and timestamps; retain the broader audit history to detect later manual edits.
- Excusals Backend and current decisions, both Forms' question/choice metadata, and the current deployed Apps Script source/version.

Record provenance and capture times with explicit timezone offsets. Confirm that the restored snapshot, Directory, Events and log belong to the same operational semester; a matching name alone does not establish semester membership. Preserve source fingerprints. Never commit these exports, report contents, cadet names or resource IDs. Use a private ignored directory under `.build/`, restricted to the operator, with input/report files readable only by that operator.

Pause alone is insufficient: it does not stop Forms submissions or scheduled closeout. Plan a quiet window, account for pending triggers and new submissions, and prevent human attendance edits/sorts during approved repair. Do not change these production controls as part of preparing the dry run.

## Offline dry run

Run:

```sh
node scripts/rehearse-attendance-recovery.cjs \
  --input .build/attendance-recovery/input.private.json \
  --output .build/attendance-recovery/report.private.json
```

The output path must be new. The CLI rejects shared-readable inputs and non-ignored paths, makes no provider calls, has no apply mode, and prints only aggregate counts and the input fingerprint. Its private report contains reviewable cell-level proposals, not an executable repair.

The JSON input contract is `formatVersion: 1`, with:

- `snapshot`: `trusted: true`, a provenance description, an ISO `capturedAt` with timezone, machine `headers`, and rectangular `rows` starting at the first data row. Preserve blanks as empty strings.
- `events` and `directory`: arrays of row objects keyed by their existing machine headers.
- `attendanceLog`: original records plus `row`, strictly increasing physical sheet row numbers. Do not sort by timestamp or discard blank attendance effects.
- `audit`: audit records plus original `row` numbers. Timestamps must be ISO values with timezones; uncertain or unparseable timing remains a review issue.
- `evidence`: an array, possibly empty, of reviewed historical cell maps. Each item supplies `auditRow`, `anchorSubmissionId`, provenance `{reviewed: true, kind: "historical-cell-map", reference: "..."}`, and `cells` with historical `row`, `column`, `last_name`, `first_name`, `event` and `value`. See the synthetic recovery tests for a complete example.

A historical map must cover every cell in the actual audited range and match the top-left Admin submission anchor. Each historical row must identify one cadet, each column one event, and each cadet/event target must appear once. The anchor must have the same identity, event and value as the audit top-left cell, with a submission timestamp no later than the audit and no more than 60 seconds before it; otherwise the evidence remains unresolved. The map must come from independent retained evidence or explicit operator review, not the current sorted grid. An audit range and its top-left value do not establish every other value or identity in a paste. If that evidence is unavailable, leave the difference for review; do not manufacture it to obtain a proposal.

The planner compares by cadet identity and current canonical event. It excludes removed/canceled/retired event labels rather than recreating them. Same-name collisions, nonoperational roster identities, unknown codes, missing/tied timestamps, unusable audits, inconsistent evidence and later unmapped manual edits are review issues. Later authoritative attendance/excusal records, including explicit clears and records appended later with backdated timestamps, are retained.

The report includes aggregate classifications, source hashes, the attendance log high-watermark, per-proposal expected latest record, evidence issues and a refresh gate. It never grants automatic refresh permission. A mismatch classified as a later authoritative record still needs an operator disposition before the restored frontend is replaced.

## Approved rollout order

1. **Snapshot and rehearse.** Preserve the sources above. Test the committed fix in an isolated workbook through a real spreadsheet paste and clear, including two cadets and two event columns. Check exact log/audit counts, sorted-row targets, interrupted mirror recovery, unchanged unrelated cells and unchanged presentation/protections. Local IO-double tests do not establish Google trigger delivery or production permissions.
2. **Review every difference.** Review proven correction proposals, later-authority dispositions, canceled-event exclusions and ambiguities. Do not copy the restored frontend wholesale. Do not use a blanket Present fill. Do not approve a full refresh while any surviving cadet/event difference remains unexplained or lacks an explicit disposition.
3. **Approve and deploy the fix.** Select the intended committed Apps Script source, confirm the configured production project and trigger owner, build, deploy only after approval, and verify the deployed source. Keep D1 packages and staging bindings separate. Do not install duplicate edit or submission triggers.
4. **Refresh the dry run immediately before writing.** Establish the quiet window. Read the sources again and rerun the planner. Stop and re-review if any source fingerprint, log high-watermark, event definition, identity mapping or expected latest record changed. Approval of an older report is not approval to overwrite later records.
5. **Append only approved corrections.** Preserve original Attendance Backend rows. A separately reviewed repair operation must append explicit Admin correction records, including intentional clears, with stable repair IDs and linked private evidence. Verify each append by readback. On an ambiguous response, reconcile those IDs before retrying; do not append a second copy blindly. This dry-run CLI deliberately performs none of these writes.
6. **Rehearse replay, then refresh non-destructively.** Confirm the proposed final log replay matches all approved surviving cells and dispositions before running `Refresh Events artifacts`. That action rebuilds derived values and refreshes existing Form choices; it must not clear logs, recreate Forms, reset workbooks or run a semester transition. If unexplained differences remain, preserve the restored workbook and defer refresh.
7. **Verify and resume.** Match both matrices by identity/event, verify corrected and unchanged cell counts, intentional blanks, Overall/LLAB totals, native tables, filters, dropdowns, formulas and protected ranges. Confirm removed events are absent and retained events present in **both** Attendance and Excusals Form choices; question IDs and response history must be unchanged. Check the completed audit and pending triggers before restoring normal operations.

## Failure handling and limits

- If the log append fails or its outcome is uncertain, inspect saved submission IDs before any retry. Do not refresh merely because an Apps Script run ended.
- If the log is saved but the backend mirror or audit fails, preserve the log and restored frontend. Repair the derived state only after reviewing the affected batch and other discrepancies.
- Reverting code does not undo durable attendance records. Corrections to an approved repair are new, reviewed append-only records; never delete the original evidence.
- The old range handler cannot reconstruct missing historical identities or multi-cell values. Some historical differences may require an operational decision rather than an automatic repair.
- Google's event object supplies scalar `value`/`oldValue` only for single-cell edits. The range is the source for a paste. See [Apps Script edit events](https://developers.google.com/apps-script/guides/triggers/events#edit) and [ScriptLock semantics](https://developers.google.com/apps-script/reference/lock/lock-service).
