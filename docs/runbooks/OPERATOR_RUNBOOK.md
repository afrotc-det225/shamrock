# SHAMROCK Operator Runbook (Internal)

This runbook describes how operators and developers deploy, operate, repair, and troubleshoot the established SHAMROCK system.

- Audience: operators and developers.
- Scope: operational procedures and safety checks.
- Non-goal: implementation details.

## 1. Roles
- End users: interact via frontend sheets and forms; no direct table editing.
- Operators/admins: run menu actions, review backend sheets, approve/deny excusals.

## 2. Environments and Resource Model
Recommended environment separation:
- Development environment: used for testing new changes.
- Production environment: authoritative operational environment.

Each environment consists of:
- Frontend workbook
- Backend workbook
- Attendance form
- Excusals form

IDs and resource references:
- Store environment-specific IDs in a configuration mechanism designed not to leak secrets.
- Use the current v2 Script Property names shown by the SHAMROCK menu. Retired property names are not migrated automatically.
- Public docs must never include raw IDs.

## 3. Setup And Repair
Setup is a safe, repeatable repair process for an existing environment and can also provision a fresh environment when needed.

Operator expectations:
- Running setup multiple times should never create duplicates.
- Running setup should repair missing tabs, missing headers, missing validations, or missing triggers.

Setup outputs to verify:
- Frontend workbook contains the expected tabs and formatting.
- Backend workbook contains the expected tabs and formatting.
- Forms exist and require verified responder emails.
- Custom menus appear in the backend/admin workbook.
- Admin menus do not appear in the frontend/main workbook.
- Triggers exist and are correctly bound.

## 4. Deployment Model
Deployment is performed from the local repository using clasp.

Operational principles:
- Treat deployment as a controlled change: develop, validate, commit, push to GitHub, deploy, then validate production.
- Avoid deploying directly from the Apps Script editor.
- The git history is the edit log for Apps Script source changes. Every production deployment should correspond to a committed and pushed repository state.

Standard deployment workflow:
1. Develop the code and documentation change locally.
2. Run `npm run build`.
3. Run `git diff --check`.
4. Review changed files for secrets, raw IDs, personal data, and local-only files.
5. Commit the change with a clear message.
6. Push the branch to GitHub.
7. Merge to `main` when approved or requested.
8. Deploy production SHAMROCK from the committed repository state with `npm run push`.
9. Run post-deploy validation and record the result in the PR, final response, or follow-up notes.

Do not deploy:
- Uncommitted local changes.
- A change that failed local validation.
- A change whose target Apps Script project is ambiguous.
- A change that has not been approved/requested for production.

Post-deploy validation checklist:
- Open the backend/admin workbook and confirm the SHAMROCK category menus load.
- Open the frontend/main workbook and confirm the SHAMROCK menu does not load.
- Confirm that setup actions remain idempotent (re-run once).
- Submit a test attendance form response and confirm it is recorded in Attendance Backend.
- Submit a test excusal request and confirm it appears in Excusals Backend.
- Change an excusal decision and confirm derived attendance updates.
- Run a harmless menu action, such as Show menu help, and confirm Audit Backend has matching `started` and `ok` rows with the same `run_id`.

## 5. Daily Operations
### 5.1 Directory maintenance
- Directory source of truth is maintained in the backend.
- Frontend Directory is a mirror.
- Frontend Directory displays cadet organization before leadership details: `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, then `University` and the remaining fields.
- Directory Backend uses the same v2 column order as the frontend Directory and no longer includes legacy `source` or freeform Directory `notes`.
- Use `Inactive`, `Commissioned`, or `Dropped` in `Flight Path` when a cadet should remain in backend records but be removed from operational frontend, leadership, attendance, and form choices.
- Cadet rank and cadet leadership role are maintained on Directory. Leadership is rebuilt from active Directory rows with a role, while non-cadet/cadre/manual Leadership rows are preserved.
- Sync Directory refreshes the frontend Data Legend first, clears stale frontend Directory dropdown rules, writes the v2 mirror, trims stale blank rows, then reapplies v2 dropdowns and frontend table column types.
- Prefer menu-driven sync/repair actions over ad hoc edits in the frontend.

### 5.2 Event maintenance
- Events are maintained in the backend.
- Frontend Events is a mirror.
- Event changes may require attendance matrix and form choice refreshes.

### 5.3 Attendance processing
- Attendance submissions append to Attendance Backend.
- Frontend Attendance matrix is derived; rebuild is available via admin menu.
- Treat frontend attendance as derived state. Rebuild it instead of manually patching formulas or event columns.

### 5.4 Excusals processing
- Requests append via form.
- Decisions are made in Excusals Backend by authorized staff.
- Decisions drive notifications and attendance effects.
- Use cleanup/backfill actions only when repairing a known data issue.

### 5.5 Audit review
- Review Audit Backend after setup, repair, and bulk operator actions.
- Matching `started` and terminal rows with the same `run_id` indicate a menu action completed, failed, or was cancelled.

### 5.6 Semester and academic-year transition
Use the backend/admin workbook SHAMROCK menu:

- `Transfer to new semester (v2)` when cadet AS years and graduation removal should not run.
- `Transfer to new academic year (v2)` when cadets should advance AS years and graduating/commissioning years should roll off unless explicitly overridden.

Before starting:
- Confirm the backend Directory has current rank, role, AS year, flight, squadron, email, and phone data.
- Prepare dropped cadets as emails or `Last, First` identifiers.
- Prepare non-standard AS-year overrides as `identifier=AS500` or similar.
- Prepare leadership changes as `identifier=Role|Rank`.
- Know the Sunday date for the first generated training week and the weekly Mando PT, LLAB, and POC Third Hour times.

During the wizard:
- The draft is saved after each prompt. Cancelling before final confirmation does not archive or rewrite workbook data.
- The final confirmation is the destructive boundary. After that point, the workflow archives current sheets, updates roster/events, clears current attendance/excusal logs and form responses, rebuilds forms, and reinstalls triggers.

After completion:
- Confirm hidden frontend archives exist for Leadership, Directory, and Attendance using the prior term label.
- Confirm hidden backend rollback archives exist. They are automatically eligible for deletion after seven days.
- Confirm Events Backend has the new term and the expected training-week sequence.
- Confirm Attendance and Excusals forms list only current-term events.
- Run one controlled attendance/excusal validation if this is a production transition.

## 6. Troubleshooting
### 6.1 Menus not appearing
Likely causes:
- Missing or broken onOpen trigger.
- Authorization required for the script.

Operator checks:
- Confirm the script has necessary permissions.
- Re-run “install triggers” / “setup” action.

### 6.2 Form submissions not reflected
Likely causes:
- Missing onFormSubmit trigger.
- Form is not the correct one for the environment.

Operator checks:
- Confirm form settings (verified responder emails).
- Confirm response destination is configured correctly if used.
- Re-run trigger installation.

### 6.3 Data validations not working
Likely causes:
- Data Legend ranges missing or renamed.
- Named ranges missing.
- Sheets advanced service unavailable, which prevents SHAMROCK from applying frontend table column types.
- Data validation can be applied by SHAMROCK from Data Legend ranges. Frontend Attendance code styling is handled by table dropdown columns, not conditional-format color rules.

Operator checks:
- Re-run Sync Directory, Rebuild Attendance Matrix, Apply frontend formatting, or setup to recreate validations and frontend tables.
- Confirm Data Legend is present and populated.
- Confirm the frontend Data Legend includes the v2 `rank_options` column and that Directory `Rank` validates against cadet rank options while `Email` has no dropdown validation.
- Confirm Data Legend order follows the v2 Directory flow: AS year, flight, squadron, rank, university, dorm, academic options, home state, flight path, then attendance codes.

### 6.4 Attendance percentages look wrong
Likely causes:
- Event metadata missing or miscategorized.
- Attendance codes outside the allowed set.

Operator checks:
- Confirm Events Backend definitions.
- Run rebuild/regenerate attendance.

## 7. Safety and Rollback
General rollback principles:
- Prefer disabling triggers and reverting derived views over deleting data.
- Avoid deleting backend logs.
- If an operation is destructive, preserve or export the affected backend state first unless the action is explicitly designed as a permanent cleanup.
- v2 transition backend rollback archives are temporary by design and are deleted after the seven-day rollback window by the archive cleanup trigger.

Emergency actions:
- Disable installable triggers.
- Freeze frontend changes by enforcing protections.
- Re-run provisioning to restore a known-good sheet structure.

## 8. Change Management Expectations
For any operational change:
- Update the public feature entry to describe new operator steps.
- Update the system spec if invariants changed.
- Add a validation checklist.
- Remove stale compatibility notes or migration instructions when the current baseline no longer supports them.
