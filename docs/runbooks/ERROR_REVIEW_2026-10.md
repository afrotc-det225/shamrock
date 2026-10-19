# October 2026 Error Review

Review date: October 18, 2026. Requested scope: the past few months, interpreted as July 1 through October 18.

## Evidence and limits

- Read all 2,985 existing Audit Backend data rows, including 1,733 dated July–October. Found 26 failed actions, dated July 2–August 30; no later failed rows were present. This does not prove trigger executions were error-free because some trigger handlers swallowed errors without recording failed audit entries.
- Compared all deployed Apps Script JavaScript files with the compiled repository baseline at `43038b8`; they matched before this change.
- Checked GitHub issues and the connected mailbox for Apps Script failure summaries; neither supplied additional failure records.
- Cloud Logging could not be read through clasp because no GCP project ID is configured. The Apps Script process-list API rejected the available credential scopes. Therefore a complete execution-level error history was not available.
- Inspected 1,276 Attendance Backend records, 396 excusal requests, 312 management rows, current event definitions, and both 90-cadet attendance matrices. No raw operational records, IDs, or personal data are included in this report or committed tests.

## Recorded failures

| Failure family | Count | Assessment |
| --- | ---: | --- |
| Typed-table operations | 14 | Current source already includes native table handling, unspecified column types, and cell-level validation. Historical failures cannot be replayed locally against Google services. |
| Linked response-tab discovery | 2 | Current source already uses fresh metadata and saved continuation state. Existing raw response archives remain preserved. |
| Protected photo-chip writes | 3 | Subsequent source includes backend-admin frontend protections and separate chip writes. Google permission behavior still requires an owner/admin smoke test after deployment. |
| Stale Directory validation | 1 | Current source includes validation clearing/retry during table writes. |
| Legend/Dashboard source reads | 2 | Current source includes batched reads and SpreadsheetApp fallback. |
| Form inaccessible/missing | 2 | Access/resource configuration errors; no evidence justifies replacing the configured form or its response history. Validate access using the automation owner's account. |
| Form roster refresh | 1 | Fixed ordering to use fresh item snapshots and bounded retries without recreating questions. |
| Management permission failure | 1 | Found sharing removed non-commander administrators. Preserve backend administrators in workbook and range access; fail visibly on access errors and never replace an inaccessible configured workbook. Existing denied access may first require its owner to restore permissions. |

## Additional verified defects fixed

- Pause with a reason stored JSON while the reader recognized only the literal `true`. Pause/resume now honors the saved object and reports persistence failures.
- Full attendance replay converted explicit blank effects into `P`, unlike incremental updates. Both paths now preserve blank.
- Incremental attendance assumed identical frontend/backend row and column order. It now matches frontend event headers and cadet identities independently.
- Form trigger setup returned early when any matching form ID existed, leaving duplicate, stale, or wrong-event triggers. It now retains exactly one correct form-submit trigger.
- Backend multi-column Directory edits inspected only the first column. They now inspect every edited field for dependent refreshes.
- Periodic Directory reconciliation called a nonexistent sync mapping (`Directory`) and skipped Leadership/form refresh. It now uses the supported Directory-artifact refresh workflow.
- Backend-edit and periodic reconciliation exceptions now produce failed audit entries and failed executions instead of silent success.
- Excusal attendance repair could overwrite later attendance reports, manual corrections, or newly pending requests with an older decision. It now preserves those newer independent records and reports the preservation count.
- Management edit handling now resolves actual machine headers and reports an empty backend explicitly rather than requesting a zero/negative-height range.

## Live data correction

Three withdrawn requests had explicit blank attendance effects but displayed `P` in both derived matrices. Restored the three affected cells in each matrix (six cells total) from the authoritative logs. Readback confirmed blanks, unchanged validation/formatting, and correctly recalculated overall attendance percentages. Audit Backend contains verified paired start/completion entries under action `attendance_matrix_repair`. No decision, attendance-submission, excusal, or historical response rows were rewritten, and no notifications were sent.

Ten apparent differences from older approved excusals were attributable to newer attendance records or a newly pending request. These were preserved. Current management decisions matched their backend decisions.

One old malformed Attendance Backend row targets a non-event header value and has no effect on the current matrix. It remains in the immutable log; it was not converted into an invented attendance record.

Native browser visual verification was unavailable because the browser connection closed. Cell-level readback verified all changed values, validation rules, and formatting.

## Validation and release status

- `npm run build`, `npm test` (20 regression cases), and `git diff --check` pass.
- The initial 15-case regression suite produced 14 failures against the original source, confirming it detects the original defects.
- Tests use synthetic data and Apps Script IO doubles. They do not substitute for Google Forms, sharing, trigger, and live-progress smoke tests.
- Source changes are prepared on `dev`; production code has not been deployed as part of this review.
- Until the blank-replay fix is deployed, a production Attendance rebuild can recreate the three incorrect Present values. Avoid historical excusal reconciliation until the newer-record preservation fix is deployed.
- After approved deployment, follow the October regression checks in `OPERATOR_RUNBOOK.md`, verify form-trigger uniqueness, and validate management sharing as the workbook owner. Do not resend historical emails during recovery.

Rollback: retain the audited data corrections, revert only the source change that causes a verified regression, and deploy the reviewed revert through the normal approval process. Do not delete raw responses or backend logs. Reverting the blank-replay fix reintroduces the risk described above.
