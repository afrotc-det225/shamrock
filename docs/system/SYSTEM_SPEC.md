# SHAMROCK System Specification (Internal)

This document is the canonical, internal specification for the current SHAMROCK Google Sheets + Google Forms system.

- Audience: developers and AI agents working in this repository.
- Scope: system-wide invariants and architecture rules that all features must follow.
- Non-goal: this is not an implementation guide and should not contain code.

If a feature document conflicts with this spec, this spec wins.

## 1. System Summary
SHAMROCK is an Apps Script system (TypeScript, V8 runtime) that provisions and operates a multi-workbook HR/accountability solution.

- Primary surfaces:
  - A Frontend Google Sheet workbook used by end users.
  - A Backend Google Sheet workbook used as the source of truth.
  - Google Forms (Attendance, Excusals) used for controlled data entry.
- Interaction model:
  - End users do not edit tables directly; edits flow through forms and scripted operations.
  - Admins operate the system via custom menus and controlled backend edits.

## 2. Supported Baseline
The checked-in source and this documentation describe the supported SHAMROCK v2 baseline.

- Current schemas, script properties, menu actions, and service boundaries are authoritative.
- Historical CSV layouts, retired property names, and one-off migration paths are not automatically supported.
- CSV imports require the current row-1 machine headers exactly.
- Compatibility code may remain only when it supports active production data or a documented operator workflow.
- When a feature establishes a new baseline, obsolete compatibility checks should be removed or clearly quarantined.
- If old and new behavior must coexist, version the Apps Script entry points or workflow labels explicitly.

## 3. Provisioning Model (Idempotent Ensure-Exists)
Provisioning must be safe to re-run.

Definition:
- “Ensure-exists” means every setup function must be able to run multiple times and converge the environment toward the desired state.

Provisioning responsibilities:
- Create or locate required workbooks.
- Create or locate required tabs within each workbook.
- Ensure table headers exist in row 1 (machine-friendly stable header identifiers).
- Ensure the visible display header row (row 2) is set and can be edited without breaking logic.
- Ensure named ranges needed for validation are present.
- Ensure formatting and sheet protections exist (see UX standards).
- Create or locate required forms and ensure key settings (verified responder emails).
- Create or locate triggers and ensure menu entries exist.

Idempotency rules:
- Do not duplicate sheets, named ranges, triggers, or form items when re-run.
- Prefer deterministic resource naming.
- Where a resource exists but differs from desired state, setup should update it.
- Setup must avoid destructive operations unless explicitly invoked by an admin “reset” action.

## 4. Ownership and Source of Truth
### 4.1 Frontend Workbook
The frontend workbook is the user-facing UI layer.

- It contains locked tabs and “presentation-first” formatting.
- It mirrors authoritative data from the backend.

Edits:
- Direct edits to core data tables should be prevented with sheet protections.
- Exceptions (if needed) must be explicit and documented in the relevant feature entry.

### 4.2 Backend Workbook
The backend workbook is authoritative.

- Directory, Events, Excusals are maintained in the backend and propagated forward to the frontend.
- Attendance is derived from backend logs and decisions.

### 4.3 Cadre & Leadership Ownership
Default ownership model:
- Directory Backend is the source of truth for cadet rank and cadet leadership roles.
- Leadership Backend preserves non-cadet/cadre/manual leadership contacts and receives derived cadet leadership rows from Directory Backend only for command/advisor roles: wing commander, deputy wing commander, operations group commander/deputy, squadron commanders, flight commanders, deputy flight commanders, and senior/deputy GMC advisor.
- Leadership rows sort non-cadet ranks and honorifics above cadet ranks, then by command hierarchy: wing commander, deputy wing commander, operations group, squadron commanders, flight commanders, deputy flight commanders, then advisor roles and remaining manual rows.
- Leadership does not store separate `flight` or `squadron` columns. Flight and squadron commander routing derives unit ownership from role names such as `Alpha Flight Commander`, `Alpha Deputy Flight Commander`, or `Blue Squadron Commander`.
- Frontend contains a read-only mirror.

Rationale:
- Centralizes authority and reduces accidental edits.
- Keeps “who should be notified” consistent with system automation.
- Avoids duplicating cadet contact details across Directory and Leadership.

If later requirements indicate a better model, the chosen model must still preserve an authoritative source and a deterministic sync path.

## 5. Schema and Table Rules
### 5.1 Header-Driven Schema (No Hardcoded Columns)
All table logic must be header-driven.

- Row 1 contains machine-friendly stable column identifiers.
- Row 2 contains display headers for the user-facing table UI.
- Data rows start at row 3.
- Column positions must never be assumed.
- Code must locate columns by row-1 header values.

Display headers:
- Row 2 is the visible header row under the current baseline.
- The two-row model is retained in v2 because setup, sync, formatting, protections, Apps Script table operations, and form-response processing all depend on stable machine headers plus operator-friendly display labels.
- If this two-row model is changed, the replacement must be justified, documented, and migrated consistently across setup, sync, formatting, and form-response logic.

Hidden helper columns:
- Additional hidden columns may be appended for internal computation.
- Hidden columns must be documented (purpose, source, and whether user-editable).

### 5.2 Normalization Rules
General normalization:
- Trim leading/trailing whitespace on user input.
- Normalize emails consistently (case and whitespace).
- Preserve valid name casing where possible (support names like “ben Yosef”).

### 5.3 Data Validation Strategy
Cell-level dropdown validations must be driven from the Data Legend tab(s) using ranges, not inlined lists.

- The Data Legend acts as the canonical option registry.
- Validations in other sheets reference Data Legend ranges.
- Frontend primary sheets use Google Sheets Table objects through the Sheets API advanced service. They must not rely on ordinary `applyRowBanding()` ranges as a substitute for Tables.
- Active frontend table names must match the sheet display names: `Directory`, `Leadership`, `Attendance`, and `Data Legend`.
- Table column types must remain `None` / `COLUMN_TYPE_UNSPECIFIED`. Controlled values are enforced with normal cell-level data validation rules, not Sheets Table dropdown column types.
- Frontend formatting must snapshot each primary table range, delete existing Sheets Table objects, restore the grid if the API clears table contents, apply normal cell-level data validation, recreate the Sheets Table objects without column types, and reapply validation as a safety pass. This prevents typed table columns from blocking validation writes while keeping the final workbook as real Google Sheets Tables.
- Frontend table creation/update also applies Sheets API cell-format requests for the Fall 2025-style visible table treatment: dark header row, clipped middle-aligned text, and white/light banded body rows. This is not conditional formatting or legacy row banding.
- Table creation/update is split into table object recreation and visual style requests with retry/backoff. If Sheets returns a transient internal error for Table object creation, SHAMROCK still applies the visible table-style fallback and logs the table-object failure for retry.
- Frontend formatting temporarily clears SHAMROCK-managed protections before table creation/update, then reapplies protections after the Sheets API table and style requests complete. Protected ranges must not prevent table repair.
- Directory `Rank` uses the cadet-only `CADET_RANKS` list. Leadership `Rank` accepts the adjacent Data Legend `CADET_RANKS`, non-cadet `RANKS`, and `HONORIFICS` ranges. Rank validations are strict range validations with plain-text display, not visible dropdown arrows/chips.
- Frontend Attendance code entry is represented by strict Data Legend-backed validation and normal spreadsheet formatting, not conditional-format color rules or Sheets Table dropdown column types.

Canonical option sets:
- The authoritative lists for dropdowns (AS years, flights, universities, dorms, CIP broad areas, AFSC options, attendance codes, etc.) are recorded in `docs/system/DATA_LEGEND_RANGES.md`.
- The Data Legend sheet(s) in each workbook must reflect these lists via stable named ranges.

## 6. Security and Access
### 6.1 Google Forms Identity
All system forms must require verified responder emails.

- Responder email is treated as the primary identity key.
- Any secondary identity fields (name) are used for human readability and additional matching but not as the sole identifier.

### 6.2 Sheet Protections
- Frontend: core tabs protected; editing reserved for scripts.
- Backend: protected with tighter editor set.

### 6.3 Secrets and IDs
- Never commit secrets.
- Avoid committing raw workbook/form IDs in public docs.
- IDs are configuration, not code logic.

## 7. Core Surfaces
This section describes the current operational shape of the system so feature work stays consistent.

### 7.1 Frontend Tabs
- FAQs: two-column end-user information.
- Dashboard: links, metrics, charts, rotating upcoming birthdays, rotating “cadets out this week”.
- Cadre & Leadership: minimal contact directory.
- Directory: cadet directory with AS year, flight, squadron, rank, role, contact, academic, and status fields (sorted Z-A by AS year, then A-Z by last name) with required formatting constraints. The frontend and backend v2 Directory order begins `Last Name`, `First Name`, `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, `University`.
- Attendance: directory-synced cadet rows + event columns with attendance codes and percentage rollups.
- Events: event metadata driving attendance columns and dashboard.
- Excusals: public-facing excusal request log.
- Audit/Changelog: append-only log of changes.
- Data Legend: validation option ranges.

### 7.2 Backend Tabs
- Directory Backend: authoritative directory source using the same v2 order as the frontend Directory. It does not include legacy `source` or freeform Directory `notes` columns.
- Events Backend: authoritative events source.
- Excusals Backend: authoritative excusal workflow table.
- Attendance Backend: append-only attendance submission log.
- Audit Backend: authoritative audit log.
- Data Legend: canonical validation ranges.

## 8. Attendance System Model
The attendance system is a replayable pipeline.

- Submissions are recorded as immutable log rows in Attendance Backend.
- The Frontend Attendance matrix is derived by replaying logs plus excusal decisions.
- Rebuild/regenerate is an admin operation and must be deterministic.

Attendance codes:
- `P`, `T`, `E`, `ES`, and `MED` are credit outcomes.
- `A` means absent and unresolved; `U` means final unexcused absence.
- `R` means an attendance exception request is pending.
- `D` means a pre-event request was denied and attendance is still required.
- `N/A` means the cadet was not expected for that event.
- Blank means not yet taken / not applicable yet.

Roster status:
- Directory `Flight Path` values `Inactive`, `Commissioned`, and `Dropped` are non-operational statuses. Rows with those statuses remain in Directory Backend for recordkeeping but are excluded from frontend Directory, derived Leadership, Attendance, and form cadet choices.

Percent metrics:
- LLAB attendance % is based on LLAB event subset.
- Overall attendance % is based on all applicable events.

## 9. Excusal System Model
Excusals are captured via a form and processed via backend decisions.

Workflow summary:
- Cadet submits an attendance exception request with event selection, requested outcome, and reason.
- Backend enriches flight/squadron from Directory.
- Submission records the prior attendance code and marks the matrix `R` while pending.
- Decision is recorded by authorized staff.
- Decision propagates to attendance computation.
- Approved requests apply the requested outcome; denied requests become `D` before the event or `U` after the event unless the prior state proves the cadet attended.
- Notifications are sent to appropriate leadership derived from Cadre & Leadership.

## 10. Audit / Changelog Expectations
Audit logging is required for key data mutations.

- Audit is append-only.
- Record actor identity when available, anonymous actor key, action category/label, what changed, where, old/new values where relevant, result, duration, source, run ID, and structured metadata.
- Menu actions write paired start and completion rows. Failures include error message/stack so copied logs and Audit Backend rows can be debugged later.
- Avoid storing unnecessary sensitive data.

## 11. UX and Formatting Standards
Sheets are part UI, part database. Apply consistent formatting standards.

Required standards:
- Use Google Sheets Table feature for all primary tables.
- Row 1: machine headers (stable identifiers).
- Row 2: display headers.
- Archived frontend transition tables must be renamed to match their archived sheet names, such as `Spring 2026 Directory`.
- Keep Sheets Table column types unset. Prefer Data Legend-backed cell validation, number/date formats, widths, freezes, and protection over conditional formatting for frontend sheets.
- Directory and Leadership shared columns use standard widths: last/first name `115`, year/flight/squadron/rank/class `75`, university/photo link `100`, phone `125`, dorm `150`, DOB `100`, and flight path `125`. Role, email, CIP broad area, AFSC, hometown, and home state fit to data. Directory Year, Rank, and University validations use plain-text display.
- Primary frontend table ranges should have cell borders cleared; use table fills, frozen headers, spacing, and selected non-table separators for readability.
- Use smart chips for links where helpful.

## 12. Menus, Triggers, and Operations
Operators should not run scripts from the editor.

- Provide custom menus for user/admin actions.
- Triggers should call stable, explicit entry points.
- Trigger installation must be idempotent.
- v2 operator workflows that replace earlier behavior must use explicit v2 menu/global names. Current transition entry points are `transferToNewSemesterV2` and `transferToNewAcademicYearV2`.
- Semester/year transitions must be interactive, auditable, archive-before-write, and resumable until the final confirmation.

## 13. Document Policy
- Public docs: explain how features work operationally without sensitive IDs.
- Internal docs: may describe system internals but still must avoid secrets.
- Documentation updates should match the change:
  - Public feature entry when operator-visible behavior changes.
  - This spec when invariants, schemas, or architecture change.
  - Operator runbook when deployment, recovery, or recurring operator steps change.
