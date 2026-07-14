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
| Excusals | Excusals Backend, Excusals Management workbook, Excusal Form | Form submit trigger, edit trigger, backend menu actions | Active |
| Live menu progress | Backend/admin workbook | Every SHAMROCK menu action | Active |
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

Cadet rank and cadet leadership role live on Directory. A Leadership refresh replaces every Directory-backed Leadership row, then republishes only active cadets with current command/advisor roles: wing commander, deputy wing commander, operations group commander/deputy, canonical operational squadron commanders, flight commanders, deputy flight commanders, and senior/deputy GMC advisor. Squadron commander routing is limited to Blue and Gold; Mission Support and Abroad are not squadron-command routing roles. This removes stale former leaders while preserving cadre/manual contacts that do not originate in Directory. Leadership sorts non-cadet ranks and honorifics above cadet ranks before applying command hierarchy and name tiebreakers. Leadership does not store separate flight/squadron columns; unit routing comes from role names such as `Alpha Flight Commander` or `Blue Squadron Commander`.
The frontend and backend Directory v2 order starts with `Last Name`, `First Name`, `Year`, `Flight`, `Sqdn`, `Rank`, `Role`, then `University` and the remaining contact/academic fields. Rows use the canonical senior-to-junior display order, with AS500 below AS300 and above AS250 and AF Civ below AS100. AF Civ may be paired with any class year and does not receive a cadet rank. Legacy Directory `source` and freeform Directory `notes` columns are not part of the v2 baseline. Frontend `Year` and `Photo Link` columns are 100 px. `Photo Link` cells render authoritative Google Drive URLs/file IDs as file smart chips; formatting-only actions preserve existing chips without rewriting their visible filename labels.

Rows marked `Inactive`, `Commissioned`, or `Dropped` in `Flight Path` stay in Directory Backend for recordkeeping but are excluded from frontend Directory, derived Leadership, Attendance, and form cadet choices.

### Operator Entry Points

- Backend/admin workbook Directory Backend edits.
- Directory Form submissions.
- Backend SHAMROCK menu sync and repair actions. Sync Directory also refreshes the frontend Data Legend dependency, updates existing Directory Form choice questions in place—including the current dorm list—and reapplies archive-style cell validation without creating typed table columns.

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
- Confirm the frontend Data Legend includes `cadet_rank_options`, non-cadet `rank_options`, and `honorific_options`; Directory controlled columns use the same cell-validation presentation as the newest Directory archive; Directory `Rank` is strict cadet-rank validation with plain-text display; Leadership `Rank` accepts cadet ranks, non-cadet ranks, and honorifics with plain-text display; and Directory `Email` is free text with no stale dropdown.
- Confirm frontend Directory `Photo Link` values backed by Google Drive file URLs display as file chips, formatting does not replace them with filename text, and both `Year` and `Photo Link` remain 100 px.
- Confirm the Directory Form Dorm question matches the canonical Data Legend dorm list without creating a replacement question or response column.
- Confirm Directory, Leadership, Attendance, and Data Legend are real Google Sheets tables, not only visually formatted ranges, and their table column types remain unset.
- Confirm `Inactive`, `Commissioned`, and `Dropped` rows are absent from operational frontend views.
- Confirm a Directory-backed cadet who becomes non-operational or loses an eligible role is removed from Leadership Backend and the frontend Leadership view on the next refresh.
- If the row has a Leadership-eligible role, confirm Leadership reflects rank, role, email, and phone from Directory; phone values should display as `+1 (###) ###-####`, and flight/squadron commander role names should include the unit name.
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
- Current core frontend sheets are copied, locked, and hidden with term labels. Copied table objects are renamed to match the archive sheet names, such as `Spring 2026 Directory`.
- Archive term labels are derived from the new target term, not the current Events Backend contents. For example, transferring into `2026-Fall` archives the current frontend tabs as `Spring 2026 Leadership`, `Spring 2026 Directory`, and `Spring 2026 Attendance`.
- Backend rollback archives are copied, locked, hidden, and registered for deletion after seven days.
- Attendance/Excusals operational logs plus Directory/Excusals response rows are cleared only after archive creation and confirmation. Attendance raw responses are instead preserved as a hidden timestamped tab when the Attendance Form is rebuilt and relinked.
- After final confirmation, the workflow records phase progress and can resume after an Apps Script timeout. Directory changes are calculated from the rollback archive snapshot so AS-year advancement is not applied twice.
- Transitions clear Directory role, flight, and squadron assignments. Academic-year transitions mark listed dropped cadets as `Dropped`, mark only original AS400s as `Commissioned` unless overridden, advance remaining cadet AS years once, leave AF Civ unchanged, and reset cadet rank from the resulting AS year.

### Validation

- Confirm archived frontend tabs exist, are hidden, use the previous term label, and have matching table names.
- Confirm Events Backend contains the new term, expected training weeks, and Mando/LLAB/Secondary/POC events.
- Confirm Directory marks dropped/commissioned cadets inactive, applies AS-year overrides when applicable, clears role/flight/squadron, and resets default ranks.
- Confirm Leadership reflects Directory roles plus cadre/manual contacts.
- Confirm Attendance matrix and both Attendance/Excusals forms were rebuilt from the new Events Backend.

## Attendance

### Purpose

Attendance records form submissions in backend logs and derives the frontend attendance matrix from attendance events, excusals, and directory state.
The v2 code set is `P`, `T`, `A`, `R`, `D`, `U`, `E`, `ES`, `MED`, and `N/A`.
AS500 is a GMC year. AS500 cadets are excluded from POC Third Hour form groups and receive `N/A` for POC Third Hour in the matrix unless an explicit attendance entry exists. AF Civ is neither GMC nor POC and is also excluded from POC Third Hour groups. Year-grouped lists place AS500 below AS300 and above AS250, with AF Civ below AS100.

### Operator Entry Points

- Attendance Form submit trigger.
- Backend SHAMROCK menu actions for rebuilds, formatting, and bulk fills.
- Events Backend definitions.

### Data Touched

- Attendance Backend.
- Events Backend.
- Frontend Attendance.
- Current Attendance Form Responses tab and preserved hidden response archives when an operator performs a structural form rebuild.
- Data Legend attendance codes.

### Safeguards

- Normal Directory/Event refreshes update existing Attendance Form questions and choices in place, avoiding full-form question recreation and repeated linked-sheet columns. Within each cadet subsection, the questions are restored to the canonical senior-to-junior AS-year order. Question labels use forms such as `Cadets (Delta) AS400 (Mando)` and `Cadets (Delta) AF Civ (Mando)`, without a duplicated `AS` prefix.
- The explicit `Rebuild Attendance Form (archive responses)` action briefly closes the form, preserves the existing linked response tab as a hidden timestamped archive, links a fresh clean response tab, verifies that it has no duplicate header names, and restores the prior open/closed state.
- Historical raw response tabs are preserved rather than merged or pruned in place. Attendance Backend remains the operational attendance log.

### Validation

- Submit a controlled attendance response.
- Confirm the response is appended to Attendance Backend.
- Rebuild attendance and confirm the frontend matrix updates deterministically.
- Confirm AS500 cadets are counted as GMC, are absent from POC Third Hour choices, receive `N/A` for POC Third Hour when no entry exists, and sort between AS300 and AS250.
- Confirm AF Civ is available in AS-year dropdowns, remains outside GMC/POC counts and POC Third Hour choices, accepts any class year, and sorts below AS100.
- Confirm each Attendance Form cadet subsection follows the canonical senior-to-junior AS-year order and question labels do not contain duplicated prefixes such as `AS AS400` or `AS AF Civ`.
- Confirm attendance codes use the same validation presentation as the newest Attendance archive, validate against Data Legend options, and leave frontend table column types unset.
- Confirm visible Attendance headers are left-aligned, event headers wrap, event/code cells use Plain text display with bold text, and `Overall`/`LLAB` percentage values are bold.
- Confirm `Overall` and `LLAB` use the archive-style red-at-80%, amber-at-90%, and green-at-100% summary gradient.
- Confirm stale blank rows are removed from the frontend matrix after cadets are removed or marked non-operational.
- Run `Debug Attendance response columns` and confirm the current response tab reports no duplicate header names. After a structural rebuild, confirm the prior response tab is hidden and the new visible tab is named `Attendance Form Responses`.

## Excusals

### Purpose

Excusals capture cadet requests, route decisions through backend/management sheets, update attendance effects, and send appropriate notifications.
Requests use a requested outcome of `P`, `T`, `E`, `ES`, or `MED`; pending requests show as `R` in Attendance until leadership records a decision.
The Excusals Form's `Excusal Details` section explains every attendance code and identifies `P`, `T`, `E`, `ES`, and `MED` as the available requested outcomes.
The separate management workbook has one active tab for each operational squadron. Blue and Gold squadron commanders are editors, while canonical flight commanders and deputy flight commanders are viewers. On an active squadron tab, SHAMROCK protects the headers and request details; only that squadron commander's Decision cells are editable. Active tabs use native Google Sheets tables with the same green-header and white/gray-banded styling as frontend Directory. Decision dropdowns are backed by the workbook's hidden protected Data Legend and selected decisions are color-coded. The requested-outcome column is displayed as `Type` and its codes are centered.

### Operator Entry Points

- Excusal Form submit trigger.
- Excusals Backend decision edits.
- Excusals Management workbook edit trigger.
- Backend SHAMROCK menu actions for cleanup, backfill, sync, and repair.
- Semester and academic-year transitions, which archive the prior term's management tabs into the restricted admin workbook, clear the active queues, and refresh access from current Leadership assignments.

### Data Touched

- Excusals Backend.
- Excusals Management workbook.
- Attendance Backend/frontend Attendance.
- Audit Backend.

### Validation

- Submit a controlled excusal request.
- Confirm the `Excusal Details` section displays the attendance-code explanations and the allowed requested outcomes.
- Confirm it appears in Excusals Backend and management surfaces.
- Record a decision and confirm attendance effect updates.
- Confirm a squadron commander can edit only Decision cells on their squadron tab, while flight commanders/deputies have view-only workbook access.
- Confirm Blue/Gold tabs are native Sheets tables, the hidden management Data Legend supplies the strict Decision dropdown, and Approved/Denied/Withdrawn/Superseded selections display their managed colors.
- After a transition, confirm prior management rows are in hidden, locked term archives in the admin workbook and active Blue/Gold management tabs are empty with access derived from the new Leadership assignments.
- Confirm denied pre-event requests show `D`, denied post-event absences show `U`, and approved medical requests show `MED`.
- Confirm related audit rows are written.

### Flight leadership notifications

- At approximately 5:00 AM each day, SHAMROCK checks Events Backend. It sends a flight-level attendance-status message only when an active Mando PT or LLAB event occurs that day; no semester event means no message.
- Each applicable flight commander receives the event notice, with the deputy copied. Event `flight_scope` limits recipients when it names specific flights.
- The notice lists approved `E`, `ES`, and `MED` outcomes and undecided excusal requests separately. Flights with neither still receive an explicit all-clear message.
- At approximately 5:00 PM Sunday, SHAMROCK closes out the preceding Sunday-through-Saturday training week only when that week contained an active event. Every applicable operational flight receives either its `A`/`U` discrepancies or an explicit perfect-attendance result.
- Trigger installation uses one daily event-aware dispatcher and one Sunday closeout trigger; it does not install fixed Mando PT or LLAB weekday schedules.

## Live Menu Progress

### Purpose

Every backend SHAMROCK menu action opens a modeless live-progress window instead of leaving the operator with only Google's generic `Running script` notice. The window presents the current plain-language stage, a short explanation, an operator hint, elapsed time, stage count when the workflow has meaningful phases, and a compact activity history.

### Operator Behavior

- The selected action starts from the progress window and continues server-side.
- Confirmation and data-entry prompts are reflected as `Waiting for you`; answer the prompt in the spreadsheet to continue.
- Long workflows report real milestones. Percentages are stage-based and do not claim row-by-row precision when the underlying Google API does not expose it.
- Meaningful execution milestones—such as synced row counts, restored photo chips, table readiness, completed formatting phases and durations, and recoverable warnings—are distilled into operator-safe activity entries; full technical details remain in Apps Script logs.
- Closing the progress window does not cancel the action.
- Live updates use one non-overlapping polling chain: approximately every eight seconds while work is active and every twenty seconds while waiting for operator input. The server action's own completion response terminates polling immediately, even if a final progress read would fail. Closing or hiding the window disposes or pauses the chain, repeated connection failures back off sharply, and an absolute request/lifetime limit prevents an abandoned Google-hosted dialog frame from polling indefinitely.
- Success, cancellation, background continuation, and failure are terminal states. Failures include the run ID needed to locate the matching Audit Backend and technical-log entries.
- Installable triggers and form-submit automations do not open an interactive window because no operator is waiting in a spreadsheet UI; they continue to use technical and audit logging.

### Validation

- Run `Show menu help` and confirm the live-progress window advances from preparation to completion.
- Run an action with confirmation and confirm the window shows `Waiting for you` until the spreadsheet prompt is answered.
- Confirm the action still writes matching `started` and terminal Audit Backend rows with the same `run_id`.
- Close the progress window during a harmless longer action and confirm the server-side action still completes.
- After completion and after closing with either Close or the title-bar X, confirm Apps Script executions do not continue accumulating `getShamrockProgress` calls.

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

Dashboard is the single frontend home page. It combines end-user guidance with quick actions, roster and attendance metrics, current-versus-historical charts, and a full birthday calendar. Birthday rows are grouped by Sunday-through-Saturday week for the current year and use alternating group backgrounds; duplicate last names gain a first initial in the display label. The retired FAQ tab is removed rather than maintained as a separate reading surface.

The Dashboard displays the original `System for Headcount & Accountability of Manpower, Readiness, Oversight, and Cadet Keeping` tagline. Its first two rows remain visible and unfrozen, the current-attendance-by-flight chart excludes Abroad, the two chart rows are contiguous without unused spacer bands, and rebuilds trim the page after the final generated content row.

The visible frontend is limited to Dashboard, Leadership, Directory, and Attendance. Applying frontend protections fully locks and hides Data Legend, Dashboard Data, and every term-named Leadership/Directory/Attendance archive. Dashboard Data is ordered immediately after Data Legend. Chart values are mirrored beneath the chart overlays before Dashboard Data is hidden, and the graphics use native Sheets chart specifications with explicit source and axis settings.

Accounts explicitly added as editors of the backend/admin workbook are treated as SHAMROCK administrators when frontend protections are applied. Those accounts are added to every managed frontend cell and sheet protection. Leadership-derived editors keep their narrower Leadership and Attendance-event access, and `MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS` remains available for exceptional additional accounts.

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
- Confirm every explicit backend/admin workbook editor can edit protected frontend ranges, while non-admin access remains limited to its Leadership/Attendance scope.
- Confirm dropdowns point to Data Legend ranges.
- Confirm any intentionally manual formatting limitations are documented in the runbook.

## Maintaining This Catalog

When a feature changes, update only the sections that help an operator use, validate, or troubleshoot the system. Avoid copying implementation details that are already clearer in code or internal docs.
