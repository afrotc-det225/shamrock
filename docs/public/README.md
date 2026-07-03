# Public Documentation

Operational, shareable notes for the SHAMROCK Sheets/Forms system. Keep this file free of secrets (no raw sheet/form IDs, emails, or personal data). Use it to record how each feature works for day-to-day users and operators.

This file is the public-facing feature catalog. System-wide invariants and architectural rules live in internal documentation.

## How to add a feature entry
1) Copy the template in `../templates/FEATURE_PUBLIC_DOC_TEMPLATE.md`.
2) Paste it as a new section in this file.
3) Fill in all placeholders, replacing any sensitive values with friendly names or instructions on where to find them.
4) Include validation steps so non-developers can confirm behavior after deployments.

Recommended workflow for AI agents:
- Confirm invariants in `docs/system/SYSTEM_SPEC.md`.
- Follow the checklist in `docs/ai/FEATURE_CHANGE_CHECKLIST.md`.

## Feature catalog
Maintain a simple index of features here so operators can find the right section quickly.

Index columns:
- Feature name
- Surfaces (frontend tabs, backend tabs, forms)
- Entry points (menus, triggers)
- Status
- Section link

No features documented yet.

---

## Setup / Provisioning
- **Owner/POC**: Engineering
- **Status**: active
- **Last updated**: 2025-12-31

### Overview
Runs an idempotent "ensure-exists" setup that creates/ensures the frontend workbook, backend workbook, required tabs, and the Attendance/Excusal forms. Safe to re-run; avoids duplicates.

### User entry points
- Custom menu in backend/admin sheets: SHAMROCK → category submenu → action.
- Script editor (for admins): run global function `setup`.

### Data touched
- Workbooks: SHAMROCK Frontend, SHAMROCK Backend.
- Tabs ensured (frontend): FAQs, Dashboard, Leadership, Directory, Attendance, Events, Excusals, Data Legend.
- Tabs ensured (backend): Directory Backend, Leadership Backend, Events Backend, Excusals Backend, Attendance Backend, Audit Backend, Data Legend.
- Forms ensured:
	- SHAMROCK Attendance Form
	- SHAMROCK Excusal Form
	- SHAMROCK Directory Form (collects responder email; allows response editing)

### Workflow (happy path)
1) Operator runs setup via menu or `setup` function.
2) Script ensures (creates if missing) the two workbooks and stores their IDs in Script Properties.
3) Script ensures required tabs exist and backfills row 1 (machine headers) and row 2 (display headers) if empty.
4) Script ensures the Attendance and Excusal forms exist and collect verified responder emails.
5) Operator sees a completion alert summarizing counts.

What setup auto-runs
- Applies frontend formatting/validations (Directory/Leadership/Attendance/Data Legend/FAQs) and creates Sheets “tables” for those tabs.
- Syncs Data Legend from canonical arrays to frontend; syncs Directory from backend; rebuilds the Attendance matrix.
- Normalizes form response sheets, trims Attendance response columns, reapplies Attendance Backend formatting.
- Installs onOpen/onEdit triggers for backend admin menus and sync; sets up form submit triggers.

### Error handling and safeguards
- Idempotent: rerun setup to repair missing resources; it will not intentionally duplicate tabs/forms.
- If a stored ID is invalid, setup recreates the resource and updates Script Properties.
- Avoid manual renames of tabs to preserve matching; if renamed, rerun setup to recreate missing tabs.
- Logging: menu actions write INFO/WARN/ERROR messages with a `menu:<run_id>` prefix to Apps Script logs.
- Audit: menu actions append start and completion/failure/cancel rows to Audit Backend using the same `run_id`; failures include error message/stack and metadata where available.

### Deployment / configuration
- Requires Apps Script authorization to create sheets/forms and manage properties.
- No secrets are stored; resource IDs are saved in Script Properties (environment-specific).

### Validation checklist
- After running setup, confirm the SHAMROCK menu appears in the backend/admin workbook and does not appear in the frontend/main workbook.
- Open the frontend workbook and verify the listed tabs exist with two header rows.
- Open the backend workbook and verify its tabs exist with two header rows.
- Open both forms and confirm email collection is enabled and login is required.

### Known limits / open questions
- Apps Script cannot create or modify Google Sheets “Formatted tables” (typed columns). If you want to use them, you must create/maintain them manually in the Sheets UI (see checklist below).
- Attendance/Excusal form questions are placeholders; real questions will be added later.
- The built-in Forms “email a copy of my responses” setting may not be controllable via Apps Script; if needed, a submission-trigger email receipt will be implemented.
- Apps Script often returns a blank `getActiveUser()` for cross-domain/consumer editors. To avoid misattributing edits to the script owner, SHAMROCK does not fall back to `getEffectiveUser()`. Admin menu visibility is controlled by access to the backend/admin workbook, not by active-user email. Main workbook edit allowlists only apply when `MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS` is populated and the active user email is available.

Notes
- Some Google Forms features (notably File upload items and certain login requirements) may not be supported by Apps Script in some environments; setup will log warnings and continue.

### Manual formatted-table setup (Sheets UI)
Some UI table behaviors are not reliably automated by setup. After running `setup` once and letting formatting run, do the following in the Google Sheets UI:

1) **Convert each sheet to a Table (UI)**
- On each of: Leadership, Directory, Attendance, Data Legend
- Click an empty cell, then Select all (Cmd+A), then convert to a Table using the Sheets UI (Insert → Table, or your preferred hotkey).
- Google Sheets may auto-insert a blank row 2 during this process. If it does, immediately click Undo (bottom-left toast) so the sheet keeps the intended two header rows (machine row 1, display row 2) and data starting at row 3.

2) **Rename the tables (UI)**
- Rename each table to something stable and obvious (recommended: `Leadership`, `Directory`, `Attendance`, `Data Legend`).
- This is UI-only and helps operators; scripts do not depend on your table names.

3) **Style as desired (UI)**
- Apply table colors, typed columns, and any additional formatting you want.
- If you want to preserve your look, you may set script property `DISABLE_MAIN_WORKBOOK_FORMATTING=true` (menu: SHAMROCK → Toggle Frontend Formatting), then re-run SHAMROCK → Reapply Frontend Protections.

### Fresh install / startup steps
Follow this order to stand up a brand-new environment:

1) Clone the repo

```bash
git clone https://github.com/declanhuggins/shamrock.git
```

2) Install dependencies

```bash
cd shamrock
npm install
```

3) Authenticate `clasp` to your Google account

```bash
clasp login
```

4) Create a new Apps Script project (standalone)

```bash
npm run create
```

5) Open the Apps Script project in the browser

```bash
Created new script: https://script.google.com...
└─ appsscript.json
Cloned one file..
```

6) Push the local build output to Apps Script

```bash
npm run push
```

7) Enable the Sheets Advanced Service (UI)
- In the Apps Script editor (browser): left sidebar → **Services** → **+** → add **Google Sheets API**.
- This exposes the `Sheets` advanced service used for table creation/formatting. No gcloud/clasp command needed.

8) Pull the project from Apps Script

```bash
npm run pull
```

- This syncs any Apps Script-side changes after enabling the Advanced Service.

9) Provision everything (first run)
- In the Apps Script editor, run the function in `index.js` called `setup`.
- Approve all scopes when prompted (Sheets, Forms, Drive, Gmail). Click `Review permissions`, select your account, clikc `Advanced`, and then `Go to Shamrock (unsafe)`. Select `Select all` and then `Continue`.
- Run `setup` one more time after auth so it can finish cleanly.

10) Share the backend/admin workbook with admins
- The SHAMROCK menu appears only in the backend/admin workbook. Anyone with access to that workbook gets the menu on open.
- Optional: in the Apps Script editor, Project Settings → Script properties → add `MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS` only if you want main workbook edit processing to require known active-user emails.

11) Confirm the Sheets UI entry point
- Open the generated backend/admin spreadsheet.
- Use SHAMROCK → “Run setup (ensure-exists)” and confirm it completes.

### Script properties
Setup creates and maintains these script properties. Legacy names from older SHAMROCK versions are automatically migrated during setup.

- `MAIN_SPREADSHEET_ID`: Google Sheet ID for the main user-facing workbook.
- `ADMIN_SPREADSHEET_ID`: Google Sheet ID for the admin/source-of-truth workbook.
- `ATTENDANCE_FORM_ID`: Google Form ID for attendance submissions.
- `EXCUSAL_REQUEST_FORM_ID`: Google Form ID for cadet excusal requests.
- `CADET_DIRECTORY_FORM_ID`: Google Form ID for cadet directory updates.
- `EXCUSAL_MANAGEMENT_SPREADSHEET_ID`: Google Sheet ID for the excusal decision management workbook.
- `MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS`: comma-separated emails allowed to edit protected areas in the main workbook, in addition to leadership-derived editors.
- `DISABLE_MAIN_WORKBOOK_FORMATTING`: set to `true` to stop SHAMROCK from applying visual formatting to the main workbook.
- `DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS`: set to `true` to stop SHAMROCK from changing main workbook column widths.
- `AUTOMATIONS_PAUSED`: internal pause flag set by the SHAMROCK Pause automations menu action.

12) Apply required form settings (manual in Forms UI)
- Directory Form: Settings → Responses → “Send responders a copy of their response” = Always; “Allow response editing” = On.
- Attendance Form: “Send responders a copy” = Off; “Allow response editing” = Off.
- Excusal Form: “Send responders a copy” = Off; “Allow response editing” = Off.
- Ensure “Collect email addresses” remains On for all forms (setup sets this).

### Migrating to a new script or forms
If you need to move to a fresh Apps Script project or new Forms (e.g., to fix broken destinations):

1) Export data from the old environment
- In the existing frontend spreadsheet: SHAMROCK → “Export category (backend)”.
- Export each category you care about (at minimum: `directory`, `events`, `excusals`, `data_legend`).
- Optional: also export Directory as CSV using the canonical cadet CSV format.

2) Create a new Apps Script project
- If you’re doing this on a new machine, authenticate first:

```bash
clasp login
```

- Create the new project:

```bash
clasp create
```

- Push code:

```bash
npm run push
```

- Open the project:

```bash
clasp open
```

3) Re-run provisioning in the new project
- In the Apps Script editor, run `setup`.
- Approve scopes, then run `setup` one more time.

4) Re-import data into the new backend
- In the new frontend spreadsheet: SHAMROCK → “Import category (backend)” and import each JSON export.
- If you exported Directory as CSV, use SHAMROCK → “Import cadet CSV -> Directory Backend”.

5) Validate + cutover
- Verify each Form’s response destination is the new backend workbook.
- Verify the backend has these response sheet names:
	- Attendance Form Responses
	- Excusal Form Responses
	- Directory Form Responses
- Swap any shared links/bookmarks to point to the new forms/workbooks.
- Re-apply the form settings noted in step 9 (Form Settings → Responses) after migration.
