// Frontend onEdit handling for Directory edits with audit and backend sync.

namespace FrontendEditService {
  type AllowedField =
    | 'as_year'
    | 'rank'
    | 'role'
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
    | 'flight_path_status';

  const ALLOWED_FIELDS: AllowedField[] = [
    'as_year',
    'rank',
    'role',
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
    const refreshAttendanceForm = DirectoryService.shouldRefreshAttendanceFormForField(allowedField);

    // Propagate directory-derived artifacts after backend update.
    Log.info(`[Directory] ${targetKey} ${allowedField} updated: \"${oldValue}\" -> \"${newValue}\"`);
    SetupService.refreshDirectoryArtifacts({ rebuildAttendanceMatrix, refreshAttendanceForm });
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

  /** Persist every edited cadet/event pair before updating its derived backend view. */
  function applyAttendanceEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    const sheet = range?.getSheet();
    if (!sheet || sheet.getName() !== 'Attendance') return;
    const fixedColumnCount = Schemas.getTabSchema('Attendance')?.machineHeaders?.length || 7;
    const firstRow = Math.max(3, range.getRow());
    const lastRow = Math.min(sheet.getLastRow(), range.getLastRow());
    const firstCol = Math.max(fixedColumnCount + 1, range.getColumn());
    const lastCol = Math.min(sheet.getLastColumn(), range.getLastColumn());
    if (lastRow < firstRow || lastCol < firstCol) return;
    const singleCell = range.getNumRows() === 1 && range.getNumColumns() === 1;
    const normalize = (value: any) => String(value ?? '').trim();
    const key = (last: any, first: any) => JSON.stringify([normalize(last).toLowerCase(), normalize(first).toLowerCase()]);
    const read = () => sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    // Capture before waiting; a lock does not freeze human edits or sorts in Sheets.
    const captured = read();
    const headers = captured[0].map(normalize);
    const lastIdx = headers.indexOf('last_name'), firstIdx = headers.indexOf('first_name');
    const backendId = Config.getBackendId();
    let persisted = false;
    const runId = Utilities.getUuid();
    try {
      AttendanceService.withWriteLock(() => {
        if (PauseService.isPaused()) throw new Error('Attendance edit stopped because automation is paused.');
        if (lastIdx < 0 || firstIdx < 0 || headers.filter(h => h === 'last_name').length !== 1 || headers.filter(h => h === 'first_name').length !== 1)
          throw new Error('Attendance identity headers are missing or ambiguous.');
        const events = SheetUtils.readTable(Config.getBackendSheet('Events Backend')).rows;
        const aliases = new Map<string, Set<string>>();
        const canonicalCounts = new Map<string, number>();
        const excludedCanonicals = new Set<string>();
        events.forEach(event => {
          const canonical = normalize(event['display_name'] || event['attendance_column_label'] || event['event_id']);
          if (!canonical) return;
          const excluded = /third\s*hour/i.test(`${event['event_id'] || ''} ${event['event_type'] || ''} ${canonical}`)
            || ['cancelled', 'canceled', 'inactive', 'archived', 'n/a'].includes(normalize(event['status']).toLowerCase());
          if (excluded) excludedCanonicals.add(canonical);
          canonicalCounts.set(canonical, (canonicalCounts.get(canonical) || 0) + 1);
          [event['event_id'], event['display_name'], event['attendance_column_label']].forEach(alias => {
            const value = normalize(alias).toLowerCase();
            if (!value) return;
            const matches = aliases.get(value) || new Set<string>();
            matches.add(canonical); aliases.set(value, matches);
          });
        });
        const columns = new Map<number, string>();
        for (let col = firstCol; col <= lastCol; col++) {
          const header = headers[col - 1];
          const matches = aliases.get(header.toLowerCase());
          if (!header || !matches || matches.size !== 1)
            throw new Error('Attendance includes a stale or ambiguous event header; no edits were logged.');
          const canonical = Array.from(matches)[0];
          if (excludedCanonicals.has(canonical) || canonicalCounts.get(canonical) !== 1 || headers.slice(fixedColumnCount).filter(h => aliases.get(h.toLowerCase())?.has(canonical)).length !== 1)
            throw new Error('Attendance includes duplicate event columns; no edits were logged.');
          columns.set(col, canonical);
        }
        const identities = new Map<string, number>();
        captured.slice(2).forEach(row => {
          const identity = key(row[lastIdx], row[firstIdx]);
          identities.set(identity, (identities.get(identity) || 0) + 1);
        });
        const logs: Record<string, any>[] = [];
        const audits: AuditService.AuditEntry[] = [];
        let actor = '';
        try { actor = String(e.user?.getEmail() || '').toLowerCase(); } catch { /* Editor identity may be unavailable. */ }
        actor ||= actorEmail() || 'unknown';
        const timestamp = new Date();
        for (let row = firstRow; row <= lastRow; row++) {
          const values = captured[row - 1];
          const last = normalize(values?.[lastIdx]), first = normalize(values?.[firstIdx]);
          if (!last || !first || /[;,=]/.test(last + first) || /\(AS[^)]*\)/i.test(last + first) || identities.get(key(last, first)) !== 1)
            throw new Error('Attendance includes a missing or ambiguous cadet identity; no edits were logged.');
          columns.forEach((event, col) => {
            const value = normalize(values[col - 1]);
            if (value !== '' && !Arrays.ATTENDANCE_CODES.includes(value))
              throw new Error('Attendance includes an unsupported code; no edits were logged.');
            // e.value/oldValue exist only for single-cell edits. Never infer bulk old values.
            if (singleCell && value !== normalize(e.value))
              throw new Error('Attendance changed again before this edit was processed; no edits were logged.');
            const oldValue = singleCell ? normalize(e.oldValue) : '';
            if (singleCell && e.oldValue !== undefined && oldValue === value) return;
            // Retain a batch identity in the durable log even if the append
            // response is lost before the individual audit records are saved.
            const submissionId = `manual-${runId}-${row}-${col}`;
            logs.push({ submission_id: submissionId, submitted_at: timestamp, event,
              attendance_type: value, email: actor, name: 'Admin', flight: '', cadets: `${last}, ${first}` });
            audits.push({ backendId, action: 'edit', result: 'ok', actorEmail: actor,
              role: 'frontend_editor', targetSheet: 'Attendance', targetTable: 'attendance_matrix',
              targetRange: `Attendance!${attendanceColumnLetter(col)}${row}`, targetKey: `${last.toLowerCase()},${first.toLowerCase()}`,
              field: event, oldValue, newValue: value, requestId: submissionId, runId,
              source: 'onFrontendEdit', version: 'v2',
              metadata: { editedRange: range.getA1Notation(), oldValueKnown: singleCell && e.oldValue !== undefined } });
          });
        }
        if (!logs.length) return;
        // Validate every matrix target before appending so a stale matrix cannot silently drop a correction.
        const mirror = AttendanceService.prepareAttendanceLogBatch(logs);
        const current = read();
        if (current.length !== captured.length || JSON.stringify(current[0]) !== JSON.stringify(captured[0]))
          throw new Error('Attendance layout changed while the edit was waiting; no edits were logged.');
        for (let row = firstRow; row <= lastRow; row++) {
          if (key(current[row - 1]?.[lastIdx], current[row - 1]?.[firstIdx]) !== key(captured[row - 1][lastIdx], captured[row - 1][firstIdx])
              || columns.size && Array.from(columns.keys()).some(col => normalize(current[row - 1]?.[col - 1]) !== normalize(captured[row - 1][col - 1])))
            throw new Error('Attendance changed while the edit was waiting; no edits were logged.');
        }
        const logSheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
        if (!logSheet) throw new Error('Attendance Backend is missing; no edits were logged.');
        const logHeaders = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0].map(normalize);
        const required = Schemas.BACKEND_TABS.find(tab => tab.name === 'Attendance Backend')?.machineHeaders || [];
        if (!required.length || required.some(header => logHeaders.filter(h => h === header).length !== 1))
          throw new Error('Attendance Backend headers are incomplete; no edits were logged.');
        const nextRow = Math.max(3, logSheet.getLastRow() + 1);
        const requiredRows = nextRow + logs.length - 1;
        const maxRows = logSheet.getMaxRows();
        if (requiredRows > maxRows) logSheet.insertRowsAfter(maxRows, requiredRows - maxRows);
        logSheet.getRange(nextRow, 1, logs.length, logHeaders.length).setValues(logs.map(log => logHeaders.map(header => log[header] ?? '')));
        SpreadsheetApp.flush();
        persisted = true;
        // Frontend cells already contain the human edits. Never rewrite them from a stale capture.
        try {
          AttendanceService.applyPreparedAttendanceLogBatch(mirror);
        } catch (err) {
          audits.forEach(audit => { audit.result = 'failed'; audit.notes = 'Attendance log saved; derived backend mirror requires repair.'; });
          AuditService.logBatch(audits);
          throw new Error('Attendance edit log was saved, but the derived backend mirror did not finish.');
        }
        if (!AuditService.logBatch(audits)) throw new Error('Attendance edit log was saved, but its audit batch was not confirmed.');
        Log.info(`[Attendance] Saved ${logs.length} manual attendance correction(s).`);
      });
    } catch (err) {
      AuditService.log({ backendId, action: 'edit', result: 'failed', role: 'frontend_editor',
        targetSheet: 'Attendance', targetTable: 'attendance_matrix', targetRange: `Attendance!${range.getA1Notation()}`,
        source: 'onFrontendEdit', runId, notes: persisted ? 'Attendance log saved; verify derived mirror before refreshing.' : 'No completed attendance append was confirmed; inspect the log before retrying.',
        error: err });
      throw err;
    }
  }

  function attendanceColumnLetter(column: number): string {
    let label = '';
    for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
    return label;
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
      if (e?.range?.getSheet()?.getName() === 'Attendance') {
        Log.warn('Frontend attendance edit did not complete; inspect its audit result before retrying.');
        throw err;
      }
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
