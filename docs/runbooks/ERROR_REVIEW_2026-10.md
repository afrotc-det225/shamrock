# October 2026 Error Review

Review date: October 18, 2026. Requested scope: the past few months, interpreted as July 1 through October 18.

## Evidence and limits

- Read all 2,985 existing Audit Backend data rows, including 1,733 dated July–October. Found 26 failed actions, dated July 2–August 30; no later failed rows were present. This does not prove trigger executions were error-free because some trigger handlers swallowed errors without recording failed audit entries.
- Compared all deployed Apps Script JavaScript files with the compiled repository baseline at `43038b8`; they matched before this change.
- Checked GitHub issues and the connected mailbox for Apps Script failure summaries; neither supplied additional failure records.
- Cloud Logging could not be read through clasp because no GCP project ID is configured. The Apps Script process-list API rejected the available credential scopes. After browser sign-in, the execution page exposed the last seven days: one attendance responder-email timeout and three zero-duration scheduled-run failures, in addition to the deployment-check API failure described below. One scheduled failure reported Google storage `INTERNAL`; the other two had no available logs. A complete execution-level history for July–October was not available.
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
- The newly accessible October 16 attendance failure occurred while reading the responder email, before any backend write. Transient read failures now receive at most three attempts; permission errors fail immediately. Only the read is retried, so recovery does not duplicate writes or notifications.

## Live data correction

Three withdrawn requests had explicit blank attendance effects but displayed `P` in both derived matrices. Restored the three affected cells in each matrix (six cells total) from the authoritative logs. Readback confirmed blanks, unchanged validation/formatting, and correctly recalculated overall attendance percentages. Audit Backend contains verified paired start/completion entries under action `attendance_matrix_repair`. No decision, attendance-submission, excusal, or historical response rows were rewritten, and no notifications were sent.

Ten apparent differences from older approved excusals were attributable to newer attendance records or a newly pending request. These were preserved. Current management decisions matched their backend decisions.

One old malformed Attendance Backend row targets a non-event header value and has no effect on the current matrix. It remains in the immutable log; it was not converted into an invented attendance record.

Native browser visual verification was unavailable because the browser connection closed. Cell-level readback verified all changed values, validation rules, and formatting.

After deployment and browser sign-in, live no-email reconciliation checked 307 management decisions and 305 authoritative attendance effects, preserved 62 newer attendance records, repaired three saved excusal-effect fields, and rebuilt both matrices. It found no missing backend matches or attendance effects requiring new log entries. The three withdrawal blanks in each matrix survived the rebuild.

The October 16 responder-email timeout left one preserved attendance response unprocessed. Its four cadet selections were checked against the effective logs: one was already Present, two had later automated closeout Absence entries, and one retained an older excusal. Appended one recovered attendance log with the original response timestamp and all four selections; corrected the three affected entries to Present in both matrices. Readback confirmed the appended record, all six corrected cells, unchanged formatting/validation, and the six earlier withdrawal blanks. Paired `attendance_response_recovery` audit entries document the repair. No notifications were sent.

## Validation and release status

- `npm run build`, `npm test` (23 regression cases), and `git diff --check` pass.
- The initial 15-case regression suite produced 14 failures against the original source, confirming it detects the original defects.
- The three responder-read regression cases produced two failures and one permission-error pass against the pre-retry source; all three pass with the follow-up fix.
- Tests use synthetic data and Apps Script IO doubles. They do not substitute for Google Forms, sharing, trigger, and live-progress smoke tests.
- After explicit approval, merged source commit `a5d41d0` into `main`, pushed `main` to GitHub, and deployed through `npm run push` on October 18, 2026, at approximately 8:00 PM Central.
- Before deployment, verified that production still matched the reviewed baseline; no intervening remote edits were overwritten. After deployment, downloaded the project and verified all 27 files, including the manifest, against the committed source's build output with no differences.
- Post-deployment workbook readback confirmed all six corrected attendance cells remained blank. The frontend cells retained their formatting and strict Data Legend-backed dropdown validation.
- A command-line attempt to run the no-op `onFrontendOpen` returned Google's storage `NOT_FOUND` error without a script stack. Browser execution subsequently succeeded: Show menu help displayed live progress and completed; no-email excusal reconciliation and the full Attendance rebuild completed.
- The project trigger page showed 11 triggers, including exactly one form-submit trigger for each of the three form handlers, the management edit trigger, and the supported scheduled handlers. All belong to a different account from the signed-in admin; they were inspected without replacing their ownership.
- Follow-up source commit `c1f4546` was pushed to `dev` and `main` and deployed at approximately 8:11 PM Central. Downloaded production again and verified all 27 files against its build output with no differences. The working source, regression tests, and operator instructions are synchronized with this deployment.
- Verified paired started/completed Audit Backend rows for Show menu help, excusal reconciliation, and both attendance repairs. No synthetic submissions or historical notification emails were sent during validation.
- Management sharing remains the outstanding owner-level repair: two existing backend administrators still lack management editor access. The university admin's live sharing action failed visibly and recorded a failed audit row. The owner's deployment credential could read the permission list, but Google rejected its first attempted sharing write because the app lacks write authorization for that workbook; no permissions changed. That attempt also has paired started/failed audit entries. Sign in as the management workbook owner, run `Share management spreadsheet`, and verify backend admins and protected ranges. Do not replace the workbook or reinstall another account's triggers to work around access.
- Forms question-refresh repetition and fault injection remain local regression coverage; no structural form rebuild or synthetic production submission was performed. Google's seven-day execution view and the longer workbook audit do not establish that every execution over the requested months was observable.

Rollback: retain the audited data corrections, revert only the source change that causes a verified regression, and deploy the reviewed revert through the normal approval process. Do not delete raw responses or backend logs. Reverting the blank-replay fix can recreate incorrect Present values when attendance is rebuilt.
