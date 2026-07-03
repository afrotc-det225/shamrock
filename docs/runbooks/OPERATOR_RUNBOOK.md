# SHAMROCK Operator Runbook (Internal)

This runbook describes how operators (admins) provision, deploy, operate, and troubleshoot SHAMROCK.

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
- Public docs must never include raw IDs.

## 3. Provisioning (Ensure-Exists)
Provisioning is a safe, repeatable process.

Operator expectations:
- Running setup multiple times should never create duplicates.
- Running setup should repair missing tabs, missing headers, missing validations, or missing triggers.

Provisioning outputs to verify:
- Frontend workbook contains the expected tabs and formatting.
- Backend workbook contains the expected tabs and formatting.
- Forms exist and require verified responder emails.
- Custom menus appear in the frontend workbook.
- Triggers exist and are correctly bound.

## 4. Deployment Model
Deployment is performed from the local repository using clasp.

Operational principles:
- Treat deployment as a controlled change: publish, then validate.
- Avoid deploying directly from the Apps Script editor.

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

### 5.2 Event maintenance
- Events are maintained in the backend.
- Frontend Events is a mirror.

### 5.3 Attendance processing
- Attendance submissions append to Attendance Backend.
- Frontend Attendance matrix is derived; rebuild is available via admin menu.

### 5.4 Excusals processing
- Requests append via form.
- Decisions are made in Excusals Backend by authorized staff.
- Decisions drive notifications and attendance effects.

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

Operator checks:
- Re-run setup to recreate validations.
- Confirm Data Legend is present and populated.

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

Emergency actions:
- Disable installable triggers.
- Freeze frontend changes by enforcing protections.
- Re-run provisioning to restore a known-good sheet structure.

## 8. Change Management Expectations
For any operational change:
- Update the public feature entry to describe new operator steps.
- Update the system spec if invariants changed.
- Add a validation checklist.
