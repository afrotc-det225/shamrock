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
- Attendance roster and event refreshes must update existing Form items in place. They may add only a newly required roster question; they must not delete and recreate the full form.
- A structural Attendance Form rebuild must temporarily stop responses, preserve the prior linked response tab as a hidden archive, rebuild the form, create and verify a fresh linked response tab, and restore the form's prior accepting-responses state. It must not merge or delete historical response columns in place.
- The newly linked response tab is created asynchronously outside the running Apps Script execution. Discovery, renaming, and header verification must use fresh Sheets API metadata keyed by `sheetId`; `SpreadsheetApp.getSheets()` is not authoritative for this post-link phase because its sheet list can remain stale for the rest of the execution. If the tab is not immediately available, SHAMROCK must persist finalization state and resume through a one-time continuation trigger without rebuilding or archiving again.

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

- Directory and Events are maintained in the backend and propagated forward to the frontend. Excusals are maintained in Excusals Backend and the separate Excusals Management workbook.
- Attendance is derived from backend logs and decisions.

### 4.3 Cadre & Leadership Ownership
Default ownership model:
- Directory Backend is the source of truth for cadet rank and cadet leadership roles.
- Leadership Backend preserves non-cadet/cadre/manual leadership contacts and receives derived cadet leadership rows from Directory Backend only for command/advisor roles: wing commander, deputy wing commander, operations group commander/deputy, canonical operational squadron commanders, flight commanders, deputy flight commanders, and senior/deputy GMC advisor. Squadron commander classification is limited to the non-Abroad values in `Arrays.SQUADRONS` (currently Blue and Gold); titles such as Mission Support Squadron Commander are not squadron-command routing roles.
- Every Leadership row whose identity exists in Directory Backend is replaceable derived state. A refresh removes those prior rows first, then republishes only operationally active cadets with a currently eligible role; commissioned, dropped, inactive, or reassigned cadets must not survive as stale manual rows.
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
- Active Excusals Management squadron tabs use native Google Sheets tables named `<Squadron> Excusals`, with the same green header and white/gray banding as frontend Directory.
- Table column types must remain `None` / `COLUMN_TYPE_UNSPECIFIED`. Controlled values are enforced with normal cell-level data validation rules, not Sheets Table dropdown column types.
- Frontend formatting must never delete Sheets Table objects as part of normal formatting. It updates existing table objects in place, explicitly resets every table column to `COLUMN_TYPE_UNSPECIFIED`, and then applies validation through Sheets API cell-level `setDataValidation` or validation-only `copyPaste` requests. Do not use `Range.setDataValidation(...)` across a table body because Google Sheets can promote that rule into a typed table dropdown column.
- Directory and Attendance validation repair should copy validation-only metadata from the newest matching `Spring YYYY ...` or `Fall YYYY ...` frontend archive when available. This preserves the proven archive presentation, including the validation UI/color treatment. A fresh environment with no archive falls back to equivalent strict Data Legend-backed `ONE_OF_RANGE` rules through the Sheets API.
- Frontend table creation/update also applies Sheets API cell-format requests for the Fall 2025-style visible table treatment: dark header row, clipped middle-aligned text, and white/light banded body rows. This is not conditional formatting or legacy row banding.
- New Google Sheets tables are created with a minimal `addTable` request, then read back to obtain Google’s generated numeric `tableId`, and finally configured through `updateTable`. Do not include row-style or column-property payloads in the initial `addTable` request; Google can return an internal error for that combined creation shape.
- Table creation/update and visual style requests use retry/backoff. The visible fallback may still be applied for diagnostics, but a missing real table is a formatting failure and must not be reported as success.
- Frontend formatting temporarily clears SHAMROCK-managed protections before table creation/update and always reapplies protections in a `finally` path, including after a table or formatting failure.
- Directory `Rank` uses the cadet-only `CADET_RANKS` list. Leadership `Rank` accepts the adjacent Data Legend `CADET_RANKS`, non-cadet `RANKS`, and `HONORIFICS` ranges. Rank validations are strict range validations with plain-text display, not visible dropdown arrows/chips.
- Directory `Photo Link` uses Google Sheets file smart chips when the authoritative backend value is a Google Drive file URL or Drive file ID.
- Directory frontend sync writes ordinary columns separately from `Photo Link`, applies file chips only from the authoritative backend URL/file ID through the Sheets API, and then leaves the table column type unset. Formatting-only actions must never republish `Photo Link` from the visible chip label because Sheets exposes that label as plain text rather than the source file URI.
- The standard frontend Directory `Year` width is 100 px. The standard `Photo Link` width remains 100 px.
- Frontend Attendance code entry is represented by strict Data Legend-backed validation and normal spreadsheet formatting, not conditional-format color rules or Sheets Table dropdown column types.
- Frontend Attendance `Overall` and `LLAB` percentages use the archive baseline gradient: red at 80%, amber at 90%, and green at 100%. This summary gradient is separate from attendance-code validation.

Canonical option sets:
- The authoritative lists for dropdowns (AS years, flights, universities, dorms, CIP broad areas, AFSC options, attendance codes, etc.) are recorded in `docs/system/DATA_LEGEND_RANGES.md`.
- The Data Legend sheet(s) in each workbook must reflect these lists via stable named ranges.
- Existing Directory Form list questions must be refreshed in place from the same canonical arrays during setup and Directory sync. In particular, Dorm must match `DORMS`; do not rebuild the question or create a new linked response column merely to update choices.

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
- Dashboard: the single frontend home page for end-user guidance, quick links, roster and attendance metrics, current-versus-historical charts, and the full birthday calendar. Its visible tagline is `System for Headcount & Accountability of Manpower, Readiness, Oversight, and Cadet Keeping`. Rows 1 and 2 remain visible and unfrozen. The generated sheet ends at the later of row 79 or the final reserved birthday row, with no trailing blank rows. The current-attendance-by-flight chart excludes Abroad. The retired FAQs tab must not be recreated.
- Dashboard birthday rows contain `Last Name`, `First Name`, `Birthday`, `Display`, and `Group`. Display values use `C/Last` for unique last names and `C/F. Last` when a first initial is needed to disambiguate a duplicate last name. Groups are sequential occupied Sunday-through-Saturday birthday weeks in the current calendar year; group parity drives alternating white/gray backgrounds.
- `Dashboard Data`: hidden, fully protected formula-backed helper tab for managed Dashboard charts. It is ordered immediately after `Data Legend`; Dashboard rebuilds may recreate its contents. Renderable chart-source mirrors live beneath the Dashboard chart overlays so hiding the helper cannot blank the graphics. Managed charts are created through native Sheets API chart specifications with explicit header, domain, series, and axis-window settings; do not use the Apps Script embedded-chart builder for these charts.
- Cadre & Leadership: minimal contact directory.
- Directory: cadet directory with AS year, flight, squadron, rank, role, contact, academic, and status fields (sorted by the canonical senior-to-junior display order, then A-Z by last name) with required formatting constraints. AS500 displays below AS300 and above AS250 because it remains a GMC year. The frontend and backend v2 Directory order begins `Last Name`, `First Name`, `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, `University`.
- Attendance: directory-synced cadet rows + event columns with attendance codes and percentage rollups.
- Events: event metadata driving attendance columns and dashboard.
- Excusals are not exposed as a frontend tab; the separate Excusals Management workbook is the commander-facing decision surface.
- Audit/Changelog: append-only log of changes.
- Data Legend: validation option ranges.
- Data Legend, Dashboard Data, and every term-named frontend Leadership/Directory/Attendance archive must be fully protected and hidden whenever frontend protections are applied. The four working tabs remain visible.

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
- Attendance Form Responses is the current raw linked destination. Structural form rebuilds retain its predecessor as a hidden, timestamped `Archived - Attendance Form Responses ...` tab; Attendance Backend remains the operational source used for replay.

Attendance codes:
- `P`, `T`, `E`, `ES`, and `MED` are credit outcomes.
- `A` means absent and unresolved; `U` means final unexcused absence.
- `R` means an attendance exception request is pending.
- `D` means a pre-event request was denied and attendance is still required.
- `N/A` means the cadet was not expected for that event.
- Blank means not yet taken / not applicable yet.

Roster status:
- Directory `Flight Path` values `Inactive`, `Commissioned`, and `Dropped` are non-operational statuses. Rows with those statuses remain in Directory Backend for recordkeeping but are excluded from frontend Directory, derived Leadership, Attendance, and form cadet choices.

Cadet groups and display order:
- GMC years are `AS100`, `AS150`, `AS200`, `AS250`, and `AS500`; AS500 is not eligible for POC Third Hour and receives `N/A` for those events when no explicit attendance log exists.
- POC years are `AS300`, `AS400`, `AS700`, `AS800`, and `AS900`.
- Cadet lists grouped by AS year display in this order: `AS900`, `AS800`, `AS700`, `AS400`, `AS300`, `AS500`, `AS250`, `AS200`, `AS150`, `AS100`.

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
- The Excusals Management workbook uses private link/domain sharing, grants edit access only to canonical operational squadron commanders, and grants view access to canonical flight commanders/deputies. Active tabs protect all fields except the owning squadron commander's Decision cells.
- The management workbook contains its own hidden, fully protected Data Legend because Google Sheets validation cannot reference another workbook. Its `EXCUSAL_DECISIONS` range mirrors the canonical decision array. Decision cells use strict cell-level `ONE_OF_RANGE` validation while table column types remain unset; conditional formatting colors Approved green, Denied red, Withdrawn amber, and Superseded purple.
- Semester/year transitions preserve management history as hidden, locked term-labeled tabs in the restricted backend/admin workbook, then reset active squadron queues and derive management-workbook access from refreshed Leadership assignments.
- Excusal submissions and decisions append request-keyed Audit Backend rows; decision reconsiderations preserve the previous decision from the edit event.

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
- Attendance first and last name columns use `115` width.
- Attendance display headers are left-aligned. Event/code cells use plain-text number format, centered alignment, and bold text; `Overall` and `LLAB` percentage values remain centered, percentage-formatted, and bold.
- Primary frontend table ranges should have cell borders cleared; use table fills, frozen headers, spacing, and selected non-table separators for readability.
- Use smart chips for links where helpful.

## 12. Menus, Triggers, and Operations
Operators should not run scripts from the editor.

- Provide custom menus for user/admin actions.
- Every operator-invoked SHAMROCK menu action must pass through the shared live-progress and audit wrapper. A menu click opens a modeless progress surface, then the client starts the server action asynchronously so progress can be polled while work or spreadsheet prompts are active.
- Live progress state is ephemeral and isolated with the active user's Apps Script cache. It is an operator feedback channel, not an authoritative job queue, security boundary, or replacement for Audit Backend and Apps Script logs.
- Each live-progress window must maintain only one polling chain and at most one in-flight `getShamrockProgress` request. The action endpoint must return the sanitized terminal state and that response must terminate polling directly; action completion must never start or require another loop. Active work polls no faster than approximately every eight seconds, waiting states slow further, and failures use bounded backoff. Close, unload, page-hide, hidden-window, request-count, and lifetime-limit paths must prevent stale callbacks or Google-hosted abandoned frames from scheduling indefinitely.
- Progress messages must use truthful workflow stages, plain-language descriptions, and safe hints. Do not invent row-level percentages when a Google API only exposes stage completion, and do not expose raw resource IDs, emails, personal data, or technical stack details in the progress history.
- The live activity history must expose distilled versions of meaningful technical milestones—such as synced row counts, completed formatting phases and durations, table readiness, cell-validation restoration, retries, and recoverable warnings—through explicit reports or a narrowly allowlisted log translation. Raw log lines are not copied directly into the operator UI.
- Closing the progress surface must not cancel the server action. Success, cancellation, failure, or a saved background continuation must remain visible as distinct terminal outcomes.
- Trigger-driven functions do not open interactive progress UI because they have no waiting spreadsheet operator; they retain structured technical/audit logging.
- Triggers should call stable, explicit entry points.
- Trigger installation must be idempotent.
- Attendance notification timing is driven by Events Backend rather than assumed semester weekdays. A daily 5:00 AM dispatcher sends Mando PT/LLAB status only for active events occurring that day, honors event flight scope, includes approved excusals and pending requests, and sends explicit all-clear results. The Sunday 5:00 PM closeout runs only when the preceding training week contained an active event and sends every applicable operational flight a discrepancy or no-discrepancy result.
- v2 operator workflows that replace earlier behavior must use explicit v2 menu/global names. Current transition entry points are `transferToNewSemesterV2` and `transferToNewAcademicYearV2`.
- Semester/year transitions must be interactive, auditable, archive-before-write, and resumable until the final confirmation.
- After final confirmation, v2 transitions must also be phase-resumable. A retry must continue incomplete phases, not reapply Directory advancement from the already-mutated backend.
- Academic-year Directory advancement is calculated from the archived pre-transition Directory snapshot. It clears role, flight, and squadron assignments; marks listed dropped cadets as `Dropped`; marks original AS400s as `Commissioned` unless overridden; advances remaining AS years once; and resets cadet rank from the resulting AS year.

## 13. Document Policy
- Public docs: explain how features work operationally without sensitive IDs.
- Internal docs: may describe system internals but still must avoid secrets.
- Documentation updates should match the change:
  - Public feature entry when operator-visible behavior changes.
  - This spec when invariants, schemas, or architecture change.
  - Operator runbook when deployment, recovery, or recurring operator steps change.
