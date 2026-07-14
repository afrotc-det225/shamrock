// Attendance matrix builder: projects directory + events + attendance log into backend and frontend matrices.

namespace AttendanceService {
  interface CadetKey {
    last: string;
    first: string;
  }

  interface EventDef {
    name: string; // display_name
    eventId: string;
    eventType: string;
    expectedGroup: string;
  }

  const ATTENDANCE_SCHEMA = Schemas.getTabSchema('Attendance');
  const FALLBACK_MACHINE_HEADERS = [
    'last_name',
    'first_name',
    'as_year',
    'flight',
    'squadron',
    'overall_attendance_pct',
    'llab_attendance_pct',
  ];
  const FALLBACK_DISPLAY_HEADERS = [
    'Last Name',
    'First Name',
    'Year',
    'Flight',
    'Sqdn',
    'Overall',
    'LLAB',
  ];
  const ATTENDANCE_MACHINE_HEADERS = ATTENDANCE_SCHEMA?.machineHeaders || FALLBACK_MACHINE_HEADERS;
  const ATTENDANCE_DISPLAY_HEADERS = ATTENDANCE_SCHEMA?.displayHeaders || FALLBACK_DISPLAY_HEADERS;
  const ATT_HEADER_OVERALL = ATTENDANCE_MACHINE_HEADERS.find((h) => h === 'overall_attendance_pct') || 'overall_attendance_pct';
  const ATT_HEADER_LLAB = ATTENDANCE_MACHINE_HEADERS.find((h) => h === 'llab_attendance_pct') || 'llab_attendance_pct';
  const SUMMARY_HEADERS = [ATT_HEADER_OVERALL, ATT_HEADER_LLAB];
  const SUMMARY_HEADER_SET = new Set<string>(SUMMARY_HEADERS);
  const BASE_HEADERS = ATTENDANCE_MACHINE_HEADERS.filter((h) => !SUMMARY_HEADER_SET.has(h));
  const ATT_HEADER_LAST = BASE_HEADERS.find((h) => h === 'last_name') || 'last_name';
  const ATT_HEADER_FIRST = BASE_HEADERS.find((h) => h === 'first_name') || 'first_name';
  const CREDIT_CODES = new Set(['P', 'T', 'E', 'ES', 'MED']);
  const CREDIT_PATTERNS = ['P', 'T', 'E', 'ES', 'MED'];
  const TOTAL_PATTERNS = ['P', 'T', 'A', 'U', 'E', 'ES', 'MED'];

  function ensureMatrixSheet(spreadsheetId: string, name: string): GoogleAppsScript.Spreadsheet.Sheet | null {
    if (!spreadsheetId) return null;
    const ss = SpreadsheetApp.openById(spreadsheetId);
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    return sheet;
  }

  function readDirectory(): any[] {
    const backendId = Config.getBackendId();
    const sheet = SheetUtils.getSheet(backendId, 'Directory Backend');
    if (!sheet) return [];
    return SheetUtils.readTable(sheet).rows.filter((row) => {
      const hasIdentity = ['last_name', 'first_name', 'email'].some((h) => String(row[h] || '').trim());
      return hasIdentity && DirectoryService.isOperationallyActiveCadet(row);
    });
  }

  function readEvents(): EventDef[] {
    const backendId = Config.getBackendId();
    const sheet = SheetUtils.getSheet(backendId, 'Events Backend');
    if (!sheet) return [];
    return SheetUtils.readTable(sheet)
      .rows
      .map((r) => ({
        name: r['display_name'] || r['attendance_column_label'] || r['event_id'] || '',
        eventId: r['event_id'] || r['display_name'] || '',
        eventType: String(r['event_type'] || '').toLowerCase(),
        expectedGroup: String(r['expected_group'] || '').toLowerCase(),
      }))
      .filter((e) => e.name);
  }

  function readAttendanceLog(): any[] {
    const backendId = Config.getBackendId();
    const sheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
    if (!sheet) return [];
    return SheetUtils.readTable(sheet).rows;
  }

  function colToLetter(col: number): string {
    let n = col;
    let s = '';
    while (n > 0) {
      const rem = ((n - 1) % 26) + 1;
      s = String.fromCharCode(64 + rem) + s;
      n = Math.floor((n - rem) / 26);
    }
    return s;
  }

  function applyAttendanceFormulas(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    rowsCount: number,
    machineHeaders: string[],
    baseLength: number,
  ) {
    const eventsStartCol = baseLength + 1;
    const eventsEndCol = machineHeaders.length;
    if (!sheet || rowsCount <= 0 || eventsEndCol < eventsStartCol) return;

    const overallCol = machineHeaders.indexOf(ATT_HEADER_OVERALL) + 1;
    const llabCol = machineHeaders.indexOf(ATT_HEADER_LLAB) + 1;
    if (overallCol <= 0 || llabCol <= 0) return;
    const startRow = 3;

    const eventsHeaderRange = `$${colToLetter(eventsStartCol)}$1:$${colToLetter(eventsEndCol)}$1`;
    const eventsDataRange = `$${colToLetter(eventsStartCol)}$${startRow}:$${colToLetter(eventsEndCol)}`;

    const overallFormula =
      `=ARRAYFORMULA(IF(ROW(${colToLetter(overallCol)}$${startRow}:${colToLetter(overallCol)})<${startRow},"",` +
      `BYROW(${eventsDataRange},LAMBDA(r,` +
      `LET(` +
      `cred,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${CREDIT_PATTERNS.join('","')}"}))>0,1,0))),` +
      `tot,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${TOTAL_PATTERNS.join('","')}"}))>0,1,0))),` +
      `num,SUM(cred),` +
      `den,SUM(tot),` +
      `IF(den=0,1,num/den)` +
      `)))))`;

    const llabFormula =
      `=ARRAYFORMULA(IF(ROW(${colToLetter(llabCol)}$${startRow}:${colToLetter(llabCol)})<${startRow},"",` +
      `BYROW(${eventsDataRange},LAMBDA(r,` +
      `LET(h,${eventsHeaderRange},` +
      `mask,BYCOL(h,LAMBDA(hd,IF(REGEXMATCH(hd,"(?i)llab"),1,0))),` +
      `cred,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${CREDIT_PATTERNS.join('","')}"}))>0,1,0))),` +
      `tot,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${TOTAL_PATTERNS.join('","')}"}))>0,1,0))),` +
      `num,SUM(mask*cred),` +
      `den,SUM(mask*tot),` +
      `IF(den=0,1,num/den)` +
      `)))))`;

    // Clear existing values in summary columns and apply formulas
    sheet.getRange(startRow, overallCol, rowsCount, 1).clearContent();
    sheet.getRange(startRow, llabCol, rowsCount, 1).clearContent();
    sheet.getRange(startRow, overallCol).setFormula(overallFormula);
    sheet.getRange(startRow, llabCol).setFormula(llabFormula);
  }

  type EventSelector = {
    names?: string[];
    startsWith?: string[];
    endsWith?: string[];
    contains?: string[];
    all?: boolean;
  };

  type CadetSelector = {
    cadets?: string[]; // 'last, first' lowercased
    flights?: string[];
    universities?: string[];
    asYears?: string[];
    includeAbroad?: boolean;
  };

  export function fillEventColumn(opts: {
    eventSelector: EventSelector;
    code: string;
    cadetSelector?: CadetSelector;
    actorEmail?: string;
    actorRole?: string;
  }): number {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    const sheet = SheetUtils.getSheet(backendId, 'Attendance Matrix Backend');
    if (!sheet) throw new Error('Attendance Matrix Backend not found');

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 3 || lastCol < 1) return 0;

    const headers = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map((h) => String(h || '').trim());

    const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');
    const headerLookup = new Map<string, number>();
    headers.forEach((h, i) => headerLookup.set(normalizeHeader(h), i));
    const findHeader = (...keys: string[]): number => {
      for (const k of keys) {
        const idx = headerLookup.get(normalizeHeader(k));
        if (idx !== undefined) return idx;
      }
      return -1;
    };

    const eventCols = new Map<string, number>();
    const eventSelector = opts.eventSelector || {};
    const matchEvent = (name: string): boolean => {
      const n = name.trim();
      if (!n) return false;
      const lc = n.toLowerCase();
      if (eventSelector.all) return true;
      if (eventSelector.names?.some((x) => x.toLowerCase() === lc)) return true;
      if (eventSelector.startsWith?.some((x) => lc.startsWith(x.toLowerCase()))) return true;
      if (eventSelector.endsWith?.some((x) => lc.endsWith(x.toLowerCase()))) return true;
      if (eventSelector.contains?.some((x) => lc.includes(x.toLowerCase()))) return true;
      return false;
    };

    const eventsSection = headers.slice(ATTENDANCE_MACHINE_HEADERS.length); // events after base + summary
    eventsSection.forEach((evName, idx) => {
      if (matchEvent(evName)) {
        eventCols.set(evName, idx + ATTENDANCE_MACHINE_HEADERS.length);
      }
    });

    if (eventCols.size === 0) throw new Error('No matching events found for selector');

    const idx = {
      flight: findHeader('flight'),
      university: findHeader('university', 'school'),
      asYear: findHeader('as_year', 'as year', 'year'),
      last: findHeader('last_name', 'last name', 'last'),
      first: findHeader('first_name', 'first name', 'first'),
    };

    const norm = (v: any) => String(v || '').trim().toLowerCase();

    const directory = readDirectory();
    const dirByName = new Map<string, any>();
    directory.forEach((d) => {
      const key = `${norm(d['last_name'])},${norm(d['first_name'])}`;
      if (key.trim() === ',') return;
      dirByName.set(key, d);
    });

    const data = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
    const cadetSelector: CadetSelector = opts.cadetSelector || {};
    const cadetSet = new Set(
      (cadetSelector.cadets || []).map((c) => {
        const parts = String(c || '').split(',');
        if (parts.length >= 2) return `${norm(parts[0])},${norm(parts.slice(1).join(','))}`;
        return norm(c);
      }),
    );
    const flightSet = new Set((cadetSelector.flights || []).map((f) => f.toLowerCase()));
    const universitySet = new Set((cadetSelector.universities || []).map((u) => u.toLowerCase()));
    const asYearSet = new Set((cadetSelector.asYears || []).map((a) => a.toLowerCase()));

    const match = (row: any[]): boolean => {
      const criteriaProvided =
        cadetSet.size > 0 || flightSet.size > 0 || universitySet.size > 0 || asYearSet.size > 0 || cadetSelector.includeAbroad;
      if (!criteriaProvided) return true; // no filters => all cadets

      const cadetKey = idx.last >= 0 && idx.first >= 0 ? `${norm(row[idx.last])},${norm(row[idx.first])}` : '';
      const dirRow = cadetKey ? dirByName.get(cadetKey) : undefined;

      const flightVal = idx.flight >= 0 ? norm(row[idx.flight]) : norm(dirRow?.flight);
      const univVal = idx.university >= 0 ? norm(row[idx.university]) : norm(dirRow?.university);
      const asYearVal = idx.asYear >= 0 ? norm(row[idx.asYear]) : norm(dirRow?.as_year);

      if (cadetSelector.includeAbroad && flightVal === 'abroad') return true;
      if (cadetSet.size && cadetSet.has(cadetKey)) return true;
      if (flightSet.size && flightSet.has(flightVal)) return true;
      if (universitySet.size && universitySet.has(univVal)) return true;
      if (asYearSet.size && asYearSet.has(asYearVal)) return true;

      return false;
    };

    const timestamp = new Date();
    const actor = opts.actorEmail || Session.getActiveUser().getEmail() || 'unknown';
    let totalFilled = 0;

    Array.from(eventCols.entries()).forEach(([eventName, eventCol]) => {
      let filled = 0;
      const colValues = data.map((row) => {
        if (match(row)) {
          filled += 1;
          return [opts.code];
        }
        return [row[eventCol]];
      });
      totalFilled += filled;

      sheet.getRange(3, eventCol + 1, colValues.length, 1).setValues(colValues);

      if (frontendId) {
        const frontendSheet = SheetUtils.getSheet(frontendId, 'Attendance');
        if (frontendSheet) {
          try {
            frontendSheet.getRange(3, eventCol + 1, colValues.length, 1).setValues(colValues);
          } catch (err) {
            Log.warn(`Failed to mirror fillEventColumn to frontend: ${err}`);
          }
        }
      }

      // Audit per event
      try {
        const cadetNotesParts: string[] = [];
        if (cadetSet.size) cadetNotesParts.push(`cadets=${cadetSet.size}`);
        if (flightSet.size) cadetNotesParts.push(`flights=${Array.from(flightSet).join('|')}`);
        if (universitySet.size) cadetNotesParts.push(`universities=${Array.from(universitySet).join('|')}`);
        if (asYearSet.size) cadetNotesParts.push(`asYears=${Array.from(asYearSet).join('|')}`);
        if (cadetSelector.includeAbroad) cadetNotesParts.push('abroad=true');
        AuditService.log({
          action: 'bulk_fill_attendance',
          result: 'ok',
          actorEmail: actor,
          role: opts.actorRole || 'frontend_editor',
          targetSheet: 'Attendance Matrix Backend',
          targetTable: 'attendance_matrix',
          targetKey: eventName,
          targetRange: `${eventName}`,
          newValue: opts.code,
          notes: cadetNotesParts.join('; '),
          source: 'AttendanceService.fillEventColumn',
          metadata: {
            filled,
            selectedAt: timestamp.toISOString(),
          },
        });
      } catch (err) {
        Log.warn(`Unable to append audit for fillEventColumn: ${err}`);
      }

      // Attendance log per event and cadet
      try {
        const attendanceLogSheet = SheetUtils.getSheet(Config.getBackendId(), 'Attendance Backend');
        if (attendanceLogSheet) {
          const cadetNames = data
            .map((row, i) => {
              if (!(colValues[i][0] === opts.code && match(row))) return '';
              const last = idx.last >= 0 ? String(row[idx.last] || '').trim() : '';
              const first = idx.first >= 0 ? String(row[idx.first] || '').trim() : '';
              if (!last && !first) return '';
              return `${last}, ${first}`.trim();
            })
            .filter(Boolean);

          if (cadetNames.length) {
            const entry = {
              submission_id: `bulk-fill-${eventName}-${timestamp.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
              submitted_at: timestamp,
              event: eventName,
              attendance_type: opts.code,
              email: actor,
              name: 'Bulk Fill Attendance',
              flight: cadetNames.length > 1 ? 'Mixed' : '',
              cadets: cadetNames.join('; '),
            };
            SheetUtils.appendRows(attendanceLogSheet, [entry]);
          }
        }
      } catch (err) {
        Log.warn(`Unable to append attendance log for fillEventColumn: ${err}`);
      }
    });

    return totalFilled;
  }

  function normalizeName(part: string): string {
    return String(part || '').trim().toLowerCase();
  }

  function cadetKey(cadet: any): string {
    return buildKey(cadet[ATT_HEADER_LAST], cadet[ATT_HEADER_FIRST]);
  }

  function buildKey(last: string, first: string): string {
    return `${normalizeName(last)}|${normalizeName(first)}`;
  }

  function parseCadetEntries(cadetField: string): CadetKey[] {
    if (!cadetField) return [];
    return cadetField
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        // Accept "Last, First" or "Last, First=Code" or "Last, First (AS ...)=Code".
        const [namePart] = entry.split('=');
        const cleaned = namePart.replace(/\(AS[^)]*\)/gi, '').trim();
        const [last, first] = cleaned.split(',').map((p) => p.trim());
        return { last: last || '', first: first || '' };
      })
      .filter((k) => k.last || k.first);
  }

  function buildMatrixRows(directory: any[], events: EventDef[], logRows: any[]) {
    const rows = directory.map((d) => {
      const baseRow: any = {};
      BASE_HEADERS.forEach((h) => {
        baseRow[h] = d[h] || '';
      });
      SUMMARY_HEADERS.forEach((h) => {
        baseRow[h] = '';
      });
      return baseRow;
    });

    const keyToIndex = new Map<string, number>();
    rows.forEach((r, idx) => keyToIndex.set(cadetKey(r), idx));

    // Initialize event columns with ''
    rows.forEach((r) => {
      events.forEach((ev) => {
        (r as any)[ev.name] = '';
      });
    });

    logRows.forEach((entry) => {
      const evName = entry['event'] || entry['display_name'] || '';
      if (!evName) return;
      const code = String(entry['attendance_type'] || 'P');
      const cadets = parseCadetEntries(entry['cadets'] || '');
      cadets.forEach((c) => {
        const idx = keyToIndex.get(buildKey(c.last, c.first));
        if (idx === undefined) return;
        const row = rows[idx] as any;
        if (evName in row) {
          row[evName] = code;
        }
      });
    });

    const isPocThirdHour = (ev: EventDef): boolean => {
      if (ev.expectedGroup.includes('poc')) return true;
      if (ev.eventType.includes('third hour')) return true;
      return ev.name.toLowerCase().includes('poc third hour');
    };

    // Auto-fill N/A for GMC cadets, including AS500, for POC Third Hour events when no log entry exists.
    events.forEach((ev) => {
      if (!isPocThirdHour(ev)) return;
      rows.forEach((row: any) => {
        if (!Arrays.isGmcAsYear(row['as_year'])) return;
        if (row[ev.name] === '' || row[ev.name] === null || row[ev.name] === undefined) {
          row[ev.name] = 'N/A';
        }
      });
    });

    return rows;
  }

  function appendAttendanceLogs(logs: Record<string, any>[]) {
    if (!logs.length) return;
    const backendId = Config.getBackendId();
    if (!backendId) return;
    const sheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
    if (!sheet) return;
    SheetUtils.appendRows(sheet, logs);
  }

  /**
   * Apply a single attendance backend log entry to the Attendance Matrix Backend (and mirror to frontend).
   * This lets us process new submissions incrementally without a full rebuild.
   */
  export function applyAttendanceLogEntry(entry: Record<string, any>): boolean {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    if (!backendId) return false;

    const matrixSheet = SheetUtils.getSheet(backendId, 'Attendance Matrix Backend');
    if (!matrixSheet) return false;

    const lastRow = matrixSheet.getLastRow();
    const lastCol = matrixSheet.getLastColumn();
    if (lastRow < 3 || lastCol < 1) return false;

    const headers = matrixSheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map((h) => String(h || '').trim());

    const eventName = String(entry['event'] || '').trim();
    const code = String(entry['attendance_type'] ?? '').trim();
    if (!eventName) return false;

    const eventColIdx = headers.indexOf(eventName);
    const lastIdx = headers.indexOf(ATT_HEADER_LAST);
    const firstIdx = headers.indexOf(ATT_HEADER_FIRST);
    if (eventColIdx < 0 || lastIdx < 0 || firstIdx < 0) return false;

    const data = matrixSheet.getRange(3, 1, lastRow - 2, lastCol).getValues();

    // Build cadet lookup for quick row resolution
    const keyToIndex = new Map<string, number>();
    data.forEach((r, idx) => {
      const key = cadetKey({
        last_name: r[lastIdx],
        first_name: r[firstIdx],
      });
      keyToIndex.set(key, idx);
    });

    const cadets = parseCadetEntries(String(entry['cadets'] || ''));
    if (!cadets.length) return false;

    cadets.forEach((c) => {
      const idx = keyToIndex.get(buildKey(c.last, c.first));
      if (idx === undefined) return;
      data[idx][eventColIdx] = code; // allow blank to clear
    });

    // Write back only the affected event column for efficiency
    const colValues = data.map((row) => [row[eventColIdx]]);
    matrixSheet.getRange(3, eventColIdx + 1, colValues.length, 1).setValues(colValues);

    // Mirror to frontend matrix if available
    if (frontendId) {
      const frontendSheet = SheetUtils.getSheet(frontendId, 'Attendance');
      if (frontendSheet) {
        try {
          frontendSheet.getRange(3, eventColIdx + 1, colValues.length, 1).setValues(colValues);
        } catch (err) {
          Log.warn(`Failed to mirror attendance to frontend: ${err}`);
        }
      }
    }

    return true;
  }

  function writeMatrix(sheet: GoogleAppsScript.Spreadsheet.Sheet, events: EventDef[], rows: any[]) {
    const machineHeaders = [...ATTENDANCE_MACHINE_HEADERS, ...events.map((e) => e.name)];
    const displayHeaders = [...ATTENDANCE_DISPLAY_HEADERS, ...events.map((e) => e.name)];
    const baseLength = ATTENDANCE_MACHINE_HEADERS.length;
    const clearRows = Math.max(1, sheet.getMaxRows());
    const clearCols = Math.max(1, sheet.getMaxColumns());
    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (sheetsService?.batchUpdate) {
      try {
        sheetsService.batchUpdate({
          requests: [{
            setDataValidation: {
              range: {
                sheetId: sheet.getSheetId(),
                startRowIndex: 0,
                endRowIndex: clearRows,
                startColumnIndex: 0,
                endColumnIndex: clearCols,
              },
              filteredRowsIncluded: true,
            },
          }],
        }, sheet.getParent().getId());
      } catch (err) {
        Log.warn(`Unable to clear stale Attendance validation through the Sheets API: ${err}`);
      }
    } else {
      sheet.getRange(1, 1, clearRows, clearCols).clearDataValidations();
    }
    // Preserve the frontend presentation while replacing derived matrix values.
    // The table-aware formatting pass still normalizes the final active range.
    if (sheet.getName() === 'Attendance') sheet.clearContents();
    else sheet.clear();
    if (machineHeaders.length) sheet.getRange(1, 1, 1, machineHeaders.length).setValues([machineHeaders]);
    if (displayHeaders.length) sheet.getRange(2, 1, 1, displayHeaders.length).setValues([displayHeaders]);
    const sortedRows = sortAttendanceRows(rows);
    const data = sortedRows.map((r) => machineHeaders.map((h) => (r as any)[h] ?? ''));
    if (data.length) {
      sheet.getRange(3, 1, data.length, machineHeaders.length).setValues(data);
      applyAttendanceFormulas(sheet, data.length, machineHeaders, baseLength);
    }

    SheetUtils.trimRowsToDataCount(sheet, data.length);
  }

  function sortAttendanceRows(rows: any[]): any[] {
    return rows.slice().sort((a, b) => {
      const asYearCmp = Arrays.compareAsYearsForDisplay(a['as_year'], b['as_year']);
      if (asYearCmp !== 0) return asYearCmp;

      const lastCmp = String(a[ATT_HEADER_LAST] || '').localeCompare(String(b[ATT_HEADER_LAST] || ''), undefined, { sensitivity: 'base' });
      if (lastCmp !== 0) return lastCmp;
      return String(a[ATT_HEADER_FIRST] || '').localeCompare(String(b[ATT_HEADER_FIRST] || ''), undefined, { sensitivity: 'base' });
    });
  }

  export function rebuildMatrix() {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    const directory = readDirectory();
    const events = readEvents();
    const logRows = readAttendanceLog();
    const matrixRows = buildMatrixRows(directory, events, logRows);

    const backendSheet = ensureMatrixSheet(backendId, 'Attendance Matrix Backend');
    const frontendSheet = SheetUtils.getSheet(frontendId, 'Attendance');

    if (backendSheet) writeMatrix(backendSheet, events, matrixRows);
    if (frontendSheet) writeMatrix(frontendSheet, events, matrixRows);
  }

  // Training week runs Sunday -> Saturday
  function startOfWeek(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // Sunday = 0
    d.setDate(d.getDate() - day);
    return d;
  }

  function isActiveScheduledEvent(row: Record<string, any>): boolean {
    const status = String(row['status'] || '').trim().toLowerCase();
    return !['cancelled', 'canceled', 'inactive', 'archived', 'n/a'].includes(status);
  }

  function findNoticeEventsForDay(now: Date) {
    const backendId = Config.getBackendId();
    const sheet = SheetUtils.getSheet(backendId, 'Events Backend');
    if (!sheet) return [];

    const table = SheetUtils.readTable(sheet);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    const matches: Array<{ row: Record<string, any>; colName: string; start: Date; eventType: 'mando' | 'llab' }> = [];
    table.rows.forEach((row) => {
      const type = String(row['event_type'] || '').toLowerCase();
      const eventType = type.includes('mando') ? 'mando' : type.includes('llab') ? 'llab' : null;
      if (!eventType || !isActiveScheduledEvent(row)) return;
      const startRaw = row['start_datetime'];
      if (!startRaw) return;
      const start = new Date(startRaw);
      if (Number.isNaN(start.getTime())) return;
      if (start < dayStart || start >= dayEnd) return;
      const colName = String(row['display_name'] || row['attendance_column_label'] || row['event_id'] || '').trim();
      if (!colName) return;
      matches.push({ row, colName, start, eventType });
    });
    matches.sort((a, b) => a.start.getTime() - b.start.getTime());
    return matches;
  }

  function formatDateTime(date: Date): string {
    const tz = Session.getScriptTimeZone ? Session.getScriptTimeZone() : 'America/Chicago';
    return Utilities.formatDate(date, tz, 'EEE, MMM d h:mm a');
  }

  function isExcusedCode(code: string): boolean {
    const c = code.trim().toUpperCase();
    return c === 'E' || c === 'ES' || c === 'MED';
  }

  function greetingForRecipient(lastName: string): string {
    const hours = new Date().getHours();
    const timeGreeting = hours < 12 ? 'Good morning' : hours < 18 ? 'Good afternoon' : 'Good evening';
    const name = lastName ? `C/${lastName}` : 'Sir/Ma’am';
    return `${timeGreeting} ${name},`;
  }

  const EMAIL_SIGNATURE = 'Very respectfully,\nSHAMROCK Automations';

  function roleMatchesFlight(role: string, target: string): boolean {
    return Arrays.FLIGHTS.some((f) => role.includes(f.toLowerCase()) && target === f.toLowerCase());
  }

  function getFlightCommanderEmail(flight: string): string {
    const backendId = Config.getBackendId();
    if (!backendId) return '';
    const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!leadershipSheet) return '';
    const table = SheetUtils.readTable(leadershipSheet);
    const target = flight.toLowerCase().trim();
    const commander = table.rows.find((row) => {
      const role = String(row['role'] || '').toLowerCase();
      return role.includes('flight commander') && !role.includes('deputy') && roleMatchesFlight(role, target);
    });
    return commander ? String(commander['email'] || '').trim() : '';
  }

  function getDeputyFlightCommanderEmail(flight: string): string {
    const backendId = Config.getBackendId();
    if (!backendId) return '';
    const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!leadershipSheet) return '';
    const table = SheetUtils.readTable(leadershipSheet);
    const target = flight.toLowerCase().trim();
    const deputy = table.rows.find((row) => {
      const role = String(row['role'] || '').toLowerCase();
      return role.includes('deputy') && role.includes('flight commander') && roleMatchesFlight(role, target);
    });
    return deputy ? String(deputy['email'] || '').trim() : '';
  }

  function operationalFlightRecipients(): Array<{ flight: string; to: string; cc: string }> {
    return Arrays.FLIGHTS
      .filter((flight) => flight !== 'Abroad')
      .map((flight) => {
        const commander = getFlightCommanderEmail(flight);
        const deputy = getDeputyFlightCommanderEmail(flight);
        return { flight, to: commander || deputy, cc: commander && deputy ? deputy : '' };
      })
      .filter((recipient) => !!recipient.to);
  }

  function flightIsInEventScope(flight: string, scopeRaw: any): boolean {
    const scope = String(scopeRaw || '').trim().toLowerCase();
    if (!scope || scope === 'all' || scope === 'all cadets') return true;
    return scope
      .split(/[,;/|]+/)
      .map((part) => part.trim().replace(/\s+flight$/, ''))
      .includes(flight.toLowerCase());
  }

  function readPendingRequestsForEvent(eventName: string) {
    const backendId = Config.getBackendId();
    const sheet = SheetUtils.getSheet(backendId, 'Excusals Backend');
    if (!sheet) return new Map<string, Array<{ last: string; first: string; asYear: string; requestedOutcome: string }>>();

    const directoryByEmail = new Map<string, string>();
    readDirectory().forEach((row) => {
      directoryByEmail.set(String(row['email'] || '').trim().toLowerCase(), String(row['as_year'] || '').trim());
    });
    const pendingByFlight = new Map<string, Array<{ last: string; first: string; asYear: string; requestedOutcome: string }>>();
    SheetUtils.readTable(sheet).rows.forEach((row) => {
      if (String(row['event'] || '').trim() !== eventName) return;
      if (String(row['decision'] || '').trim()) return;
      const flight = String(row['flight'] || '').trim();
      if (!flight) return;
      const list = pendingByFlight.get(flight) || [];
      list.push({
        last: String(row['last_name'] || ''),
        first: String(row['first_name'] || ''),
        asYear: directoryByEmail.get(String(row['email'] || '').trim().toLowerCase()) || '',
        requestedOutcome: String(row['requested_outcome'] || 'E').trim().toUpperCase(),
      });
      pendingByFlight.set(flight, list);
    });
    return pendingByFlight;
  }

  function sendEventAttendanceNotice(eventInfo: { row: Record<string, any>; colName: string; start: Date; eventType: 'mando' | 'llab' }) {
    const backendId = Config.getBackendId();
    if (!backendId) {
      Log.warn('Cannot send event attendance notice: backend ID missing');
      return;
    }

    const matrixSheet = SheetUtils.getSheet(backendId, 'Attendance Matrix Backend');
    if (!matrixSheet) {
      Log.warn('Attendance Matrix Backend not found; cannot send event attendance notice');
      return;
    }

    const headers = matrixSheet
      .getRange(1, 1, 1, matrixSheet.getLastColumn())
      .getValues()[0]
      .map((h) => String(h || '').trim());
    const eventColIdx = headers.indexOf(eventInfo.colName);
    if (eventColIdx < 0) {
      Log.warn(`Event column '${eventInfo.colName}' not found in Attendance Matrix; skipping excused summary.`);
      return;
    }

    const table = SheetUtils.readTable(matrixSheet);
    const excusedByFlight = new Map<string, { last: string; first: string; asYear: string }[]>();

    table.rows.forEach((row) => {
      const code = String((row as any)[eventInfo.colName] || '');
      if (!isExcusedCode(code)) return;
      const flight = String((row as any)['flight'] || '').trim();
      if (!flight) return;
      const list = excusedByFlight.get(flight) || [];
      list.push({
        last: String((row as any)['last_name'] || ''),
        first: String((row as any)['first_name'] || ''),
        asYear: String((row as any)['as_year'] || ''),
      });
      excusedByFlight.set(flight, list);
    });

    const pendingByFlight = readPendingRequestsForEvent(eventInfo.colName);
    const friendly = eventInfo.eventType === 'mando' ? 'Mando PT' : 'LLAB';
    const eventLabel = eventInfo.row['display_name'] || eventInfo.row['attendance_column_label'] || eventInfo.row['event_id'];
    const startStr = eventInfo.start ? formatDateTime(eventInfo.start) : 'this week';

    operationalFlightRecipients()
      .filter(({ flight }) => flightIsInEventScope(flight, eventInfo.row['flight_scope']))
      .forEach(({ flight, to, cc }) => {
        const cadets = excusedByFlight.get(flight) || [];
        const pending = pendingByFlight.get(flight) || [];
        const commanderRow = SheetUtils.lookupRowByEmail(Config.getBackendId(), 'Leadership Backend', to);
        const commanderLast = String((commanderRow as any)?.['last_name'] || '');
        const greeting = greetingForRecipient(commanderLast);

        const excusedLines = cadets
          .map((c) => `${c.last}, ${c.first} (${c.asYear || 'AS?'})`)
          .sort();
        const pendingLines = pending
          .map((c) => `${c.last}, ${c.first} (${c.asYear || 'AS?'}) – requested ${c.requestedOutcome}`)
          .sort();
        const sections: string[] = [];
        sections.push(excusedLines.length ? `Approved excusals:\n- ${excusedLines.join('\n- ')}` : 'Approved excusals: none');
        sections.push(pendingLines.length ? `Pending excusal requests:\n- ${pendingLines.join('\n- ')}` : 'Pending excusal requests: none');
        const allClear = excusedLines.length === 0 && pendingLines.length === 0;
        const body = `${greeting}\n\n${friendly} attendance status for ${eventLabel} (${startStr}):\n\n${sections.join('\n\n')}\n\n${allClear ? 'No attendance exceptions are currently recorded; all cadets are expected to be present.' : 'Please account for pending requests when preparing for the event.'}\n\n${EMAIL_SIGNATURE}`;

        const subject = `${friendly} attendance status (${eventLabel})`;
        const emailOpts: GoogleAppsScript.Gmail.GmailAdvancedOptions = { name: 'SHAMROCK Automations' };
        if (cc) emailOpts.cc = cc;
        try {
          GmailApp.sendEmail(to, subject, body, emailOpts);
          Log.info(`Sent ${friendly} attendance notice to flight ${flight}`);
        } catch (err) {
          Log.warn(`Failed to send ${friendly} attendance notice for flight ${flight}: ${err}`);
        }
      });
  }

  export function sendDailyEventAttendanceNotices() {
    const events = findNoticeEventsForDay(new Date());
    if (!events.length) {
      Log.info('No active Mando PT or LLAB event occurs today; no attendance notice is needed.');
      return;
    }
    events.forEach(sendEventAttendanceNotice);
  }

  export function fillUnexcusedAndNotify() {
    const backendId = Config.getBackendId();
    if (!backendId) {
      Log.warn('Cannot fill unexcused: backend ID missing');
      return;
    }

    const matrixSheet = SheetUtils.getSheet(backendId, 'Attendance Matrix Backend');
    if (!matrixSheet) {
      Log.warn('Attendance Matrix Backend not found; cannot fill unexcused');
      return;
    }

    const lastRow = matrixSheet.getLastRow();
    const lastCol = matrixSheet.getLastColumn();
    if (lastRow < 3 || lastCol < 1) return;

    const headers = matrixSheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());
    const baseHeaderIdx = {
      last: headers.indexOf('last_name'),
      first: headers.indexOf('first_name'),
      asYear: headers.indexOf('as_year'),
      flight: headers.indexOf('flight'),
    };

    const today = new Date();
    const weekStart = startOfWeek(today);
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const weekEnd = new Date(lastWeekStart);
    weekEnd.setDate(lastWeekStart.getDate() + 7);

    // Find event columns occurring this training week
    const backendEvents = SheetUtils.getSheet(backendId, 'Events Backend');
    if (!backendEvents) return;
    const eventsTable = SheetUtils.readTable(backendEvents);
    const weekEventsByName = new Map<string, Record<string, any>>();
    eventsTable.rows.forEach((row) => {
      if (!isActiveScheduledEvent(row)) return;
      const startRaw = row['start_datetime'];
      if (!startRaw) return;
      const start = new Date(startRaw);
      if (Number.isNaN(start.getTime())) return;
      if (start < lastWeekStart || start >= weekEnd) return;
      const name = row['display_name'] || row['attendance_column_label'] || row['event_id'];
      if (name) weekEventsByName.set(String(name), row);
    });
    if (weekEventsByName.size === 0) {
      Log.warn('No events found for this training week; skipping unexcused fill.');
      return;
    }

    const eventColIndexes = headers
      .map((h, idx) => ({ h, idx }))
      .filter((p) => weekEventsByName.has(p.h))
      .map((p) => p.idx);

    if (eventColIndexes.length === 0) {
      Log.warn('No matching event columns in Attendance Matrix for this week; skipping unexcused fill.');
      return;
    }

    const data = matrixSheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
    const unexcusedByFlight = new Map<string, { last: string; first: string; asYear: string; event: string }[]>();
    const pendingLogs: Record<string, any>[] = [];

    eventColIndexes.forEach((colIdx) => {
      const colOffset = colIdx; // zero-based in array, but range uses 1-based later
      const scopedEvent = weekEventsByName.get(headers[colIdx]);
      for (let r = 0; r < data.length; r++) {
        const flight = baseHeaderIdx.flight >= 0 ? String(data[r][baseHeaderIdx.flight] || '').trim() : '';
        if (scopedEvent && (!flight || !flightIsInEventScope(flight, scopedEvent['flight_scope']))) continue;
        const cell = String(data[r][colOffset] || '').trim();
        if (cell && cell !== 'D') continue; // Only fill if empty or denied-before-event.
        
        if (!cell) {
          data[r][colOffset] = 'A';
        } else if (cell === 'D') {
          data[r][colOffset] = 'U';
        } else {
          continue;
        }

        // Queue a log entry for this fill so rebuilds stay consistent
        pendingLogs.push({
          submission_id: `fill-attendance-closeout-${Date.now()}-${r}-${colIdx}`,
          submitted_at: new Date(),
          event: headers[colIdx] || '',
          attendance_type: data[r][colOffset],
          email: 'auto-attendance-closeout',
          name: 'Weekly Attendance Closeout',
          flight: baseHeaderIdx.flight >= 0 ? String(data[r][baseHeaderIdx.flight] || '') : '',
          cadets:
            (baseHeaderIdx.last >= 0 ? String(data[r][baseHeaderIdx.last] || '') : '') +
            ', ' +
            (baseHeaderIdx.first >= 0 ? String(data[r][baseHeaderIdx.first] || '') : ''),
        });
        
      }
    });

    // Apply log entries and write back only the event columns we mutated to preserve formulas elsewhere
    if (pendingLogs.length) {
      appendAttendanceLogs(pendingLogs);
      pendingLogs.forEach((log) => applyAttendanceLogEntry(log));
    } else {
      eventColIndexes.forEach((colIdx) => {
        const colValues = data.map((row) => [row[colIdx]]);
        matrixSheet.getRange(3, colIdx + 1, colValues.length, 1).setValues(colValues);
      });
    }

    // Report every unresolved/final unexcused result for the week, including
    // A/U values that already existed before this closeout run.
    eventColIndexes.forEach((colIdx) => {
      for (let r = 0; r < data.length; r++) {
        const code = String(data[r][colIdx] || '').trim().toUpperCase();
        if (code !== 'A' && code !== 'U') continue;
        const flight = baseHeaderIdx.flight >= 0 ? String(data[r][baseHeaderIdx.flight] || '').trim() : '';
        if (!flight) continue;
        const event = weekEventsByName.get(headers[colIdx]);
        if (event && !flightIsInEventScope(flight, event['flight_scope'])) continue;
        const list = unexcusedByFlight.get(flight) || [];
        list.push({
          last: baseHeaderIdx.last >= 0 ? String(data[r][baseHeaderIdx.last] || '') : '',
          first: baseHeaderIdx.first >= 0 ? String(data[r][baseHeaderIdx.first] || '') : '',
          asYear: baseHeaderIdx.asYear >= 0 ? String(data[r][baseHeaderIdx.asYear] || '') : '',
          event: headers[colIdx] || '',
        });
        unexcusedByFlight.set(flight, list);
      }
    });

    const tz = Session.getScriptTimeZone ? Session.getScriptTimeZone() : 'America/Chicago';
    const weekLabel = Utilities.formatDate(lastWeekStart, tz, 'MMM d');

    operationalFlightRecipients()
      .filter(({ flight }) => Array.from(weekEventsByName.values()).some((event) => flightIsInEventScope(flight, event['flight_scope'])))
      .forEach(({ flight, to, cc }) => {
        const items = unexcusedByFlight.get(flight) || [];
        const commanderRow = SheetUtils.lookupRowByEmail(backendId, 'Leadership Backend', to);
        const commanderLast = String((commanderRow as any)?.['last_name'] || '');
        const greeting = greetingForRecipient(commanderLast);

        const lines = items
          .map((i) => `${i.last}, ${i.first} (${i.asYear || 'AS?'}) – ${i.event}`)
          .sort();
        const hasIssues = lines.length > 0;
        const body = hasIssues
          ? `${greeting}\n\nAttendance issues requiring follow-up this week (week of ${weekLabel}):\n- ${lines.join('\n- ')}\n\nA means absent with no resolved request. U means the absence is final unexcused.\n\n${EMAIL_SIGNATURE}`
          : `${greeting}\n\nYour flight has perfect attendance for this week. Well done.\n\n${EMAIL_SIGNATURE}`;

        const subject = hasIssues
          ? `Attendance follow-up – week of ${weekLabel}`
          : `Perfect attendance – week of ${weekLabel}`;

        const emailOpts: GoogleAppsScript.Gmail.GmailAdvancedOptions = { name: 'SHAMROCK Automations' };
        if (cc) emailOpts.cc = cc;
        try {
          GmailApp.sendEmail(to, subject, body, emailOpts);
          Log.info(`Sent weekly attendance closeout to flight ${flight}`);
        } catch (err) {
          Log.warn(`Failed to send weekly attendance closeout for flight ${flight}: ${err}`);
        }
      });
  }
}
