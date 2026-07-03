# SHAMROCK Operator Feature Catalog

This is the operator-facing feature catalog for SHAMROCK. Keep it concise, current, and free of secrets, raw IDs, personal emails, phone numbers, and cadet data.

Use this file to answer: what does the feature do, where does an operator use it, what data does it touch, and how can it be validated after a change?

Internal architecture rules live in `docs/system/SYSTEM_SPEC.md`. Deployment and recovery procedures live in `docs/runbooks/OPERATOR_RUNBOOK.md`.

## Feature Index

| Feature | Primary Surfaces | Entry Points | Status |
| --- | --- | --- | --- |
| Setup and repair | Backend/admin workbook, frontend/main workbook, forms, triggers | Backend SHAMROCK menu, `setup` Apps Script function | Active |
| Semester/year transition | Backend/admin workbook, frontend/main workbook, forms, triggers | Backend SHAMROCK menu, v2 transition actions | Active |
| Directory sync | Directory Backend, frontend Directory, Directory Form | Backend SHAMROCK menu, form submit trigger, periodic reconciliation | Active |
| Attendance | Attendance Backend, frontend Attendance, Attendance Form, Events Backend | Form submit trigger, backend menu actions | Active |
| Excusals | Excusals Backend, Excusals Management workbook, frontend Excusals, Excusal Form | Form submit trigger, edit trigger, backend menu actions | Active |
| Audit logging | Audit Backend, Apps Script logs | Menu action wrappers, service calls | Active |
| Formatting and protections | Frontend/main workbook, backend/admin workbook | Setup and maintenance menu actions | Active |

## Setup And Repair

### Purpose

Setup keeps an existing SHAMROCK environment aligned with the supported workbook/form structure. It can also provision a fresh environment, but day-to-day use is repair and verification.

### Operator Entry Points

- Backend/admin workbook: SHAMROCK menu.
- Apps Script editor: `setup` global function when menu access is unavailable.

The frontend/main workbook intentionally does not expose admin menus.

### Data Touched

- Main/frontend workbook tabs.
- Admin/backend workbook tabs.
- Attendance, Excusal, and Directory forms.
- Script Properties for environment-specific resource IDs and feature flags.
- Installable triggers.

### Safeguards

- Setup is intended to be idempotent and safe to re-run.
- Setup should repair missing tabs, headers, validations, protections, form destinations, and triggers.
- Resource IDs are stored in Script Properties, not source code.
- Menu actions write structured logs and auditable rows when they mutate state.

### Validation

- Open the backend/admin workbook and confirm SHAMROCK menus load.
- Open the frontend/main workbook and confirm admin menus do not load.
- Run setup once and confirm completion without duplicate tabs or duplicate form items.
- Confirm required forms collect verified responder email.
- Confirm Audit Backend receives paired `started` and `ok` rows for a harmless menu action such as menu help.

## Directory

### Purpose

Directory is the authoritative roster source for cadets and drives attendance, leadership lookups, form choices, and frontend display.

Cadet rank and cadet leadership role live on Directory. The Leadership view is derived from active Directory rows only for command/advisor roles: flight commanders, squadron commanders, operations group commander/deputy, wing commander/deputy wing commander, and senior/deputy GMC advisor. Cadre/manual leadership contacts are preserved.
The frontend and backend Directory v2 order starts with `Last Name`, `First Name`, `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, then `University` and the remaining contact/academic fields. Legacy Directory `source` and freeform Directory `notes` columns are not part of the v2 baseline.

Rows marked `Inactive`, `Commissioned`, or `Dropped` in `Flight Path` stay in Directory Backend for recordkeeping but are excluded from frontend Directory, derived Leadership, Attendance, and form cadet choices.

### Operator Entry Points

- Backend/admin workbook Directory Backend edits.
- Directory Form submissions.
- Backend SHAMROCK menu sync and repair actions. Sync Directory also refreshes the frontend Data Legend dependency and reapplies v2 dropdown validation rules.

### Data Touched

- Directory Backend.
- Frontend Directory.
- Leadership Backend and frontend Leadership for cadets with assigned roles.
- Attendance matrix rebuild inputs.
- Form choice regeneration inputs.

### Validation

- Add or update a test-safe directory row in the backend.
- Run the directory sync action.
- Confirm the frontend Directory reflects the backend.
- Confirm the frontend Directory column order starts `Last Name`, `First Name`, `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, `University`.
- Confirm the frontend Data Legend includes `cadet_rank_options` and non-cadet `rank_options`, Directory `Rank` is a cadet-rank dropdown, Leadership `Rank` accepts both rank columns, and Directory `Email` is free text with no stale dropdown.
- Confirm `Inactive`, `Commissioned`, and `Dropped` rows are absent from operational frontend views.
- If the row has a Leadership-eligible role, confirm Leadership reflects rank, role, flight/squadron, email, and phone from Directory.
- Confirm attendance/form rebuild actions use active cadets only.

## Semester And Academic Year Transition

### Purpose

The v2 transition workflow prepares SHAMROCK for a new semester or academic year through an operator-guided wizard.

### Operator Entry Points

- Backend/admin workbook: SHAMROCK menu -> Setup & Automations -> Transfer to new semester (v2).
- Backend/admin workbook: SHAMROCK menu -> Setup & Automations -> Transfer to new academic year (v2).

### Data Touched

- Frontend Leadership, Directory, and Attendance archives.
- Backend Leadership, Directory, Events, Attendance, and Excusals archives.
- Directory Backend roster fields.
- Events Backend generated term events.
- Attendance Backend, Excusals Backend, and form response rows.
- Attendance, Excusals, and Directory forms/triggers.

### Safeguards

- The wizard saves a draft after each prompt and does not mutate data until final confirmation.
- Current core frontend sheets are copied, locked, and hidden with term labels.
- Backend rollback archives are copied, locked, hidden, and registered for deletion after seven days.
- Attendance/Excusals logs and response rows are cleared only after archive creation and confirmation.

### Validation

- Confirm archived frontend tabs exist, are hidden, and use the previous term label.
- Confirm Events Backend contains the new term, expected training weeks, and Mando/LLAB/Secondary/POC events.
- Confirm Directory removed dropped/graduated cadets and applied AS-year overrides when applicable.
- Confirm Leadership reflects Directory roles plus cadre/manual contacts.
- Confirm Attendance matrix and both Attendance/Excusals forms were rebuilt from the new Events Backend.

## Attendance

### Purpose

Attendance records form submissions in backend logs and derives the frontend attendance matrix from attendance events, excusals, and directory state.
The v2 code set is `P`, `T`, `A`, `R`, `D`, `U`, `E`, `ES`, `MED`, and `N/A`.

### Operator Entry Points

- Attendance Form submit trigger.
- Backend SHAMROCK menu actions for rebuilds, formatting, and bulk fills.
- Events Backend definitions.

### Data Touched

- Attendance Backend.
- Events Backend.
- Frontend Attendance.
- Data Legend attendance codes.

### Validation

- Submit a controlled attendance response.
- Confirm the response is appended to Attendance Backend.
- Rebuild attendance and confirm the frontend matrix updates deterministically.
- Confirm attendance codes validate against Data Legend options and show as frontend table dropdown columns when the Sheets advanced service is available.
- Confirm stale blank rows are removed from the frontend matrix after cadets are removed or marked non-operational.

## Excusals

### Purpose

Excusals capture cadet requests, route decisions through backend/management sheets, update attendance effects, and send appropriate notifications.
Requests use a requested outcome of `P`, `T`, `E`, `ES`, or `MED`; pending requests show as `R` in Attendance until leadership records a decision.

### Operator Entry Points

- Excusal Form submit trigger.
- Excusals Backend decision edits.
- Excusals Management workbook edit trigger.
- Backend SHAMROCK menu actions for cleanup, backfill, sync, and repair.

### Data Touched

- Excusals Backend.
- Excusals Management workbook.
- Frontend Excusals.
- Attendance Backend/frontend Attendance.
- Audit Backend.

### Validation

- Submit a controlled excusal request.
- Confirm it appears in Excusals Backend and management surfaces.
- Record a decision and confirm attendance effect updates.
- Confirm denied pre-event requests show `D`, denied post-event absences show `U`, and approved medical requests show `MED`.
- Confirm related audit rows are written.

## Audit Logging

### Purpose

Audit logging records operator actions and key automation outcomes so operators can troubleshoot failures and confirm completed work.

### Operator Entry Points

- Automatic through menu action wrappers and service calls.
- Audit Backend review.
- Apps Script execution logs.

### Data Touched

- Audit Backend.
- Apps Script logs.

### Validation

- Run a harmless menu action.
- Confirm Audit Backend has matching rows with the same `run_id`.
- Confirm failures include enough error detail to troubleshoot without exposing unnecessary sensitive data.

## Formatting And Protections

### Purpose

Formatting and protections keep the frontend usable as an interface while preserving backend/source-of-truth workflows.

Dashboard uses compact spreadsheet-native sections for quick links, roster metrics, attendance summary, and birthdays. FAQ uses a one-column mobile-friendly reading layout instead of a single oversized cell.

### Operator Entry Points

- Setup.
- Backend SHAMROCK menu formatting/protection actions.
- Script Properties for disabling main workbook formatting or column width changes when preserving manual UI polish.

### Data Touched

- Frontend/main workbook formatting, validations, hidden helper columns, and protections.
- Backend/admin workbook formatting and protections.

### Validation

- Run the relevant formatting/protection action.
- Confirm frontend core data ranges remain protected.
- Confirm dropdowns point to Data Legend ranges.
- Confirm any intentionally manual formatting limitations are documented in the runbook.

## Maintaining This Catalog

When a feature changes, update only the sections that help an operator use, validate, or troubleshoot the system. Avoid copying implementation details that are already clearer in code or internal docs.
