// Frontend onEdit handling for Directory edits with audit and backend sync.

namespace FrontendEditService {
  type AllowedField =
    | 'as_year'
    | 'flight'
    | 'squadron'
    | 'university'
    | 'phone'
    | 'dorm'
    | 'cip_broad_area'
    | 'cip_code'
    | 'desired_assigned_afsc'
    | 'home_town'
    | 'home_state'
    | 'class_year'
    | 'dob'
    | 'flight_path_status'
    | 'notes';

  const ALLOWED_FIELDS: AllowedField[] = [
    'as_year',
    'flight',
    'squadron',
    'university',
    'phone',
    'dorm',
    'cip_broad_area',
    'cip_code',
    'desired_assigned_afsc',
    'home_town',
    'home_state',
    'class_year',
    'dob',
    'flight_path_status',
    'notes',
  ];

  function getAllowedEditors(): string[] {
    try {
      return Config.getCommaSeparatedScriptProperty(Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS} for edit gate: ${err}`);
      return [];
    }
  }

  function actorEmail(): string {
    try {
      const active = Session.getActiveUser().getEmail();
      if (active) return active.toLowerCase();
    } catch (err) {
      Log.warn(`Unable to read active user email during onEdit: ${err}`);
    }
    return '';
  }

  function allowedFieldFromHeader(header: string): AllowedField | null {
    const key = String(header || '').trim().toLowerCase();
    return (ALLOWED_FIELDS as string[]).includes(key) ? (key as AllowedField) : null;
  }

  function findBackendRowIndex(table: SheetUtils.TableData, predicate: (row: any) => boolean): number {
    for (let i = 0; i < table.rows.length; i++) {
      if (predicate(table.rows[i])) return i;
    }
    return -1;
  }

  export function logAuditEntry(params: {
    backendId: string;
    targetRange: string;
    targetKey: string;
    header: string;
    oldValue: string;
    newValue: string;
    targetSheet?: string;
    targetTable?: string;
    role?: string;
    source?: string;
    action?: string;
    result?: string;
  }) {
    AuditService.log({
      backendId: params.backendId,
      action: params.action || 'edit',
      result: params.result || 'ok',
      role: params.role || 'frontend_editor',
      targetSheet: params.targetSheet || 'Directory',
      targetTable: params.targetTable || 'directory',
      targetKey: params.targetKey,
      targetRange: params.targetRange,
      field: params.header,
      oldValue: params.oldValue,
      newValue: params.newValue,
      source: params.source || 'onFrontendEdit',
      version: 'v2',
    });
  }

  function applyDirectoryEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    const sheet = range?.getSheet();
    if (!sheet || sheet.getName() !== 'Directory') return;

    const row = range.getRow();
    const col = range.getColumn();
    if (row < 3) return; // headers

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const header = headers[col - 1];
    const allowedField = allowedFieldFromHeader(header);
    if (!allowedField) return;

    const newValue = String(e?.value ?? range.getValue() ?? '');

    const backendId = Config.getBackendId();
    const backendSheet = SheetUtils.getSheet(backendId, 'Directory Backend');
    if (!backendSheet) {
      Log.warn('Backend Directory sheet missing; cannot mirror frontend edit');
      return;
    }

    const table = SheetUtils.readTable(backendSheet);
    const emailIdx = table.headers.indexOf('email');
    const lastIdx = table.headers.indexOf('last_name');
    const firstIdx = table.headers.indexOf('first_name');

    const rowValues = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
    const email = emailIdx >= 0 ? String(rowValues[headers.indexOf('email')] || '').toLowerCase() : '';
    const last = lastIdx >= 0 ? String(rowValues[headers.indexOf('last_name')] || '').toLowerCase() : '';
    const first = firstIdx >= 0 ? String(rowValues[headers.indexOf('first_name')] || '').toLowerCase() : '';

    const matchIdx = findBackendRowIndex(table, (r) => {
      const rEmail = String(r['email'] || '').toLowerCase();
      if (email && rEmail === email) return true;
      return String(r['last_name'] || '').toLowerCase() === last && String(r['first_name'] || '').toLowerCase() === first;
    });

    if (matchIdx < 0) {
      Log.warn(`No backend Directory match for edit row=${row} email=${email}`);
      return;
    }

    const backendHeaders = table.headers;
    const backendColIdx = backendHeaders.indexOf(allowedField);
    if (backendColIdx < 0) return;

    const oldValue = String(table.rows[matchIdx][allowedField] || '');
    if (oldValue === newValue) return;

    backendSheet.getRange(matchIdx + 3, backendColIdx + 1).setValue(newValue);

    const targetKey = email || `${last},${first}`;
    logAuditEntry({
      backendId,
      targetRange: `${sheet.getName()}!${range.getA1Notation()}`,
      targetKey,
      header: allowedField,
      oldValue,
      newValue,
      targetSheet: 'Directory',
      targetTable: 'directory',
      role: 'frontend_editor',
      source: 'onFrontendEdit',
    });

    const rebuildAttendanceMatrix = DirectoryService.shouldRebuildAttendanceMatrixForField(allowedField);
    const rebuildAttendanceForm = DirectoryService.shouldRebuildAttendanceFormForField(allowedField);

    // Propagate directory-derived artifacts after backend update.
    Log.info(`[Directory] ${targetKey} ${allowedField} updated: \"${oldValue}\" -> \"${newValue}\"`);
    SetupService.refreshDirectoryArtifacts({ rebuildAttendanceMatrix, rebuildAttendanceForm });
  }

  function applyLeadershipEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    const sheet = range?.getSheet();
    if (!sheet || sheet.getName() !== 'Leadership') return;

    const row = range.getRow();
    const col = range.getColumn();
    if (row < 3) return; // headers live on rows 1/2

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const header = headers[col - 1];
    if (!header) return;

    const newValue = String(e?.value ?? range.getValue() ?? '');

    const backendId = Config.getBackendId();
    const backendSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!backendSheet) {
      Log.warn('Backend Leadership sheet missing; cannot mirror frontend edit');
      return;
    }

    const table = SheetUtils.readTable(backendSheet);
    const backendHeaders = table.headers.map((h) => String(h || '').trim());
    const backendColIdx = backendHeaders.findIndex((h) => h.toLowerCase() === header.toLowerCase());
    if (backendColIdx < 0) return;

    const rowValues = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
    const normalize = (v: any) => String(v || '').toLowerCase();
    const emailIdx = headers.findIndex((h) => h.toLowerCase() === 'email');
    const lastIdx = headers.findIndex((h) => h.toLowerCase() === 'last_name');
    const firstIdx = headers.findIndex((h) => h.toLowerCase() === 'first_name');
    const email = emailIdx >= 0 ? normalize(rowValues[emailIdx]) : '';
    const last = lastIdx >= 0 ? normalize(rowValues[lastIdx]) : '';
    const first = firstIdx >= 0 ? normalize(rowValues[firstIdx]) : '';

    const matchIdx = findBackendRowIndex(table, (r) => {
      const rEmail = normalize(r['email']);
      if (email && rEmail === email) return true;
      return normalize(r['last_name']) === last && normalize(r['first_name']) === first;
    });

    if (matchIdx < 0) {
      Log.warn(`No backend Leadership match for edit row=${row} email=${email}`);
      return false;
    }

    const oldValue = String(table.rows[matchIdx][backendHeaders[backendColIdx]] || '');
    if (oldValue === newValue) return;

    backendSheet.getRange(matchIdx + 3, backendColIdx + 1).setValue(newValue);

    const targetKey = email || (last && first ? `${last},${first}` : `${sheet.getName()}!R${row}C${col}`);
    logAuditEntry({
      backendId,
      targetRange: `${sheet.getName()}!${range.getA1Notation()}`,
      targetKey,
      header,
      oldValue,
      newValue,
      targetSheet: 'Leadership',
      targetTable: 'leadership',
      role: 'frontend_editor',
      source: 'onFrontendEdit',
      action: 'edit',
    });
    Log.info(`[Leadership] ${targetKey} ${header} updated: \"${oldValue}\" -> \"${newValue}\"`);

    // Resync frontend from backend to ensure consistency/formatting.
    try {
      SetupService.syncLeadershipBackendToFrontend();
    } catch (err) {
      Log.warn(`Failed to resync leadership after edit: ${err}`);
    }
  }

  function applyAttendanceEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    const sheet = range?.getSheet();
    if (!sheet || sheet.getName() !== 'Attendance') return;

    const row = range.getRow();
    const col = range.getColumn();
    if (row < 3) return; // headers occupy rows 1/2

    const headerRow1 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const headerRow2 = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const header = headerRow1[col - 1] || headerRow2[col - 1] || '';
    if (!header) return;

    const rowValues = sheet.getRange(row, 1, 1, headerRow1.length).getValues()[0];
    const normalize = (v: any) => String(v || '').toLowerCase();
    const lastIdx = headerRow1.findIndex((h) => h.toLowerCase() === 'last_name');
    const firstIdx = headerRow1.findIndex((h) => h.toLowerCase() === 'first_name');
    const lastRaw = lastIdx >= 0 ? String(rowValues[lastIdx] || '') : '';
    const firstRaw = firstIdx >= 0 ? String(rowValues[firstIdx] || '') : '';
    const last = normalize(lastRaw);
    const first = normalize(firstRaw);
    const targetKey = last && first ? `${last},${first}` : `${sheet.getName()}!R${row}C${col}`;

    const newValue = String(e?.value ?? range.getValue() ?? '');
    const oldValue = String((e as any)?.oldValue ?? '');
    if (newValue === oldValue) return;

    const backendId = Config.getBackendId();
    // Append to Attendance Backend log as an admin submission reflecting the edit.
    try {
      const logSheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
      if (logSheet) {
        const logHeaders = Schemas.BACKEND_TABS.find((t) => t.name === 'Attendance Backend')?.machineHeaders || [];
        const rowObj: Record<string, any> = {};
        logHeaders.forEach((h) => (rowObj[h] = ''));
        rowObj['submission_id'] = Utilities.getUuid();
        rowObj['submitted_at'] = new Date();
        rowObj['event'] = header;
        // Preserve explicit clears; do NOT default to P
        rowObj['attendance_type'] = newValue;
        rowObj['email'] = actorEmail() || 'unknown';
        rowObj['name'] = 'Admin';
        rowObj['flight'] = '';
        rowObj['cadets'] = lastRaw && firstRaw ? `${lastRaw}, ${firstRaw}` : targetKey;

        const values = logHeaders.map((h) => rowObj[h] ?? '');
        const nextRow = Math.max(3, logSheet.getLastRow() + 1);
        logSheet.getRange(nextRow, 1, 1, logHeaders.length).setValues([values]);

        // Incrementally apply the change to backend/front matrices (no full rebuild).
        AttendanceService.applyAttendanceLogEntry(rowObj);
      }
    } catch (err) {
      Log.warn(`Unable to append attendance edit log: ${err}`);
    }

    logAuditEntry({
      backendId,
      targetRange: `${sheet.getName()}!${range.getA1Notation()}`,
      targetKey,
      header,
      oldValue,
      newValue,
      targetSheet: 'Attendance',
      targetTable: 'attendance_matrix',
      role: 'frontend_editor',
      source: 'onFrontendEdit',
      action: 'edit',
    });
    Log.info(`[Attendance] ${targetKey} ${header} updated: \"${oldValue}\" -> \"${newValue}\"`);
  }

  export function onEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    if (PauseService.isPaused()) {
      Log.info('Frontend onEdit is paused; skipping propagation.');
      return;
    }

    try {
      applyDirectoryEdit(e);
      applyLeadershipEdit(e);
      applyAttendanceEdit(e);
    } catch (err) {
      Log.warn(`Frontend onEdit failed: ${err}`);
    }
  }

  export function reconcilePendingDirectoryEdits(): { updated: number; missing: number } {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    const backendSheet = SheetUtils.getSheet(backendId, 'Directory Backend');
    const frontendSheet = SheetUtils.getSheet(frontendId, 'Directory');
    if (!backendSheet || !frontendSheet) return { updated: 0, missing: 0 };

    const backendTable = SheetUtils.readTable(backendSheet);
    const frontendTable = SheetUtils.readTable(frontendSheet);
    const backendHeaders = backendTable.headers;

    const backendLookup = new Map<string, { idx: number; row: any }>();
    backendTable.rows.forEach((row, idx) => {
      const email = String(row['email'] || '').toLowerCase();
      const last = String(row['last_name'] || '').toLowerCase();
      const first = String(row['first_name'] || '').toLowerCase();
      const key = email || (last && first ? `${last},${first}` : '');
      if (key) backendLookup.set(key, { idx, row });
    });

    let updated = 0;
    let missing = 0;

    frontendTable.rows.forEach((row) => {
      const email = String(row['email'] || '').toLowerCase();
      const last = String(row['last_name'] || '').toLowerCase();
      const first = String(row['first_name'] || '').toLowerCase();
      const key = email || (last && first ? `${last},${first}` : '');
      if (!key) return;

      const backendMatch = backendLookup.get(key);
      if (!backendMatch) {
        missing++;
        return;
      }

      ALLOWED_FIELDS.forEach((field) => {
        const backendColIdx = backendHeaders.indexOf(field);
        if (backendColIdx < 0) return;
        const oldValue = String(backendMatch.row[field] || '');
        const newValue = String(row[field] || '');
        if (oldValue === newValue) return;

        backendSheet.getRange(backendMatch.idx + 3, backendColIdx + 1).setValue(newValue);
        logAuditEntry({
          backendId,
          targetRange: 'Directory (batch reconcile)',
          targetKey: key,
          header: field,
          oldValue,
          newValue,
          targetSheet: 'Directory',
          targetTable: 'directory',
          role: 'frontend_reconcile',
          source: 'reconcilePendingDirectoryEdits',
        });
        updated++;
      });
    });

    return { updated, missing };
  }
}
