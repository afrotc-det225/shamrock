// Admin utilities: export/import backend tables as CSV via Drive.

namespace AdminService {
  type Category = 'directory' | 'events' | 'attendance' | 'excusals' | 'data_legend' | 'cadre';
  type Location = 'backend' | 'frontend';

  interface CategoryInfo {
    sheetName: string;
    description: string;
    location: Location;
  }

  const CATEGORY_MAP: Record<Category, CategoryInfo> = {
    directory: { sheetName: 'Directory Backend', description: 'Cadet directory source of truth', location: 'backend' },
    events: { sheetName: 'Events Backend', description: 'Events definitions', location: 'backend' },
    attendance: { sheetName: 'Attendance Backend', description: 'Attendance submission log', location: 'backend' },
    excusals: { sheetName: 'Excusals Backend', description: 'Excusals workflow log', location: 'backend' },
    data_legend: { sheetName: 'Data Legend', description: 'Validation option ranges', location: 'backend' },
    cadre: { sheetName: 'Leadership Backend', description: 'Leadership contact list', location: 'backend' },
  };

  const CATEGORY_PROMPT = Object.keys(CATEGORY_MAP).join('/');

  function normalizeHeader(raw: any): string {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function buildRowMap(headers: string[], row: string[]): Record<string, string> {
    const map: Record<string, string> = {};
    headers.forEach((h, idx) => {
      map[h] = String(row[idx] || '').trim();
    });
    return map;
  }

  function coalesce(map: Record<string, string>, keys: string[]): string {
    for (const key of keys) {
      const val = map[key];
      if (val) return val;
    }
    return '';
  }

  function normalizePhone(raw: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }

  function composeNotes(map: Record<string, string>): string {
    const parts = [map['notes'], map['status'] ? `Status: ${map['status']}` : '', map['created_at'] ? `Created: ${map['created_at']}` : '', map['updated_at'] ? `Updated: ${map['updated_at']}` : ''];
    return parts.filter(Boolean).join(' | ');
  }

  function getUi(): GoogleAppsScript.Base.Ui | null {
    try {
      return SpreadsheetApp.getUi();
    } catch {
      return null;
    }
  }

  function alertOrLog(message: string) {
    const ui = getUi();
    if (ui) ui.alert(message);
    Log.info(message);
  }

  function resolveSpreadsheetId(info: CategoryInfo): string | null {
    const key = info.location === 'backend' ? Config.PROPERTY_KEYS.ADMIN_SPREADSHEET_ID : Config.PROPERTY_KEYS.MAIN_SPREADSHEET_ID;
    return Config.getScriptProperty(key);
  }

  function requireSpreadsheetId(info: CategoryInfo): string | null {
    const id = resolveSpreadsheetId(info);
    if (id) return id;
    const msg = `${info.location === 'backend' ? 'Backend' : 'Frontend'} sheet ID not set. Run setup first.`;
    getUi()?.alert(msg);
    Log.warn(msg);
    return null;
  }

  function escapeCsvCell(value: any): string {
    const s = String(value ?? '');
    if (/["]|,|\n|\r/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function toCsv(headers: string[], rows: Record<string, any>[]): string {
    const lines: string[] = [];
    lines.push(headers.map(escapeCsvCell).join(','));
    rows.forEach((r) => {
      lines.push(headers.map((h) => escapeCsvCell(r[h])).join(','));
    });
    return lines.join('\n');
  }

  function parseCsvToObjects(csv: string, expectedHeaders: string[]): Record<string, any>[] {
    const parsed = Utilities.parseCsv(csv).map((r) => r.map((c) => String(c ?? '').trim()));
    const rows = parsed.filter((r) => r.some((cell) => cell));
    if (!rows.length) return [];

    const normalize = (h: string) => normalizeHeader(h);
    const headerRow = rows[0].map((h) => String(h || '').trim());
    const normalizedHeaderRow = headerRow.map(normalize);
    const normalizedExpected = expectedHeaders.map(normalize);

    const exactMismatch = headerRow.length !== expectedHeaders.length || headerRow.some((h, i) => h !== expectedHeaders[i]);
    const normalizedMismatch =
      normalizedHeaderRow.length !== normalizedExpected.length || normalizedHeaderRow.some((h, i) => h !== normalizedExpected[i]);

    if (exactMismatch && normalizedMismatch) {
      throw new Error('Header mismatch between CSV and target sheet.');
    }

    // If normalized matches but exact differs (e.g., "Reports To" vs "reports_to"), map columns by normalized header.
    const indexByNormalized = new Map<string, number>();
    normalizedHeaderRow.forEach((h, idx) => {
      if (!indexByNormalized.has(h)) indexByNormalized.set(h, idx);
    });

    return rows.slice(1).map((row) => {
      const obj: Record<string, any> = {};
      expectedHeaders.forEach((h) => {
        const idx = exactMismatch ? indexByNormalized.get(normalize(h)) ?? -1 : expectedHeaders.indexOf(h);
        obj[h] = idx >= 0 ? row[idx] ?? '' : '';
      });
      return obj;
    });
  }

  function validateCategory(val: string | null | undefined): Category | null {
    if (!val) return null;
    const normalized = val.trim().toLowerCase();
    return (CATEGORY_MAP as any)[normalized] ? (normalized as Category) : null;
  }

  function resolveCategory(label: string, provided?: string): Category | null {
    const direct = validateCategory(provided);
    if (direct) return direct;

    const ui = getUi();
    if (!ui) {
      Log.warn(`No UI available to prompt for category (${label}). Pass a category string or run from a spreadsheet-bound context.`);
      return null;
    }

    const response = ui.prompt(`${label} (${CATEGORY_PROMPT})`, 'directory', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return null;
    const val = validateCategory(response.getResponseText());
    if (!val) {
      ui.alert(`Invalid category. Use one of: ${CATEGORY_PROMPT}`);
      return null;
    }
    return val;
  }

  // JSON import/export removed; CSV-only flow below.

  function resolveCadetCsvFileId(fileIdInput?: string): string {
    if (fileIdInput && fileIdInput.trim()) return fileIdInput.trim();

    const ui = getUi();
    if (!ui) {
      Log.warn('No UI available. Run import from the Sheets menu.');
      return '';
    }

    const resp = ui.prompt('Import cadet CSV', 'Paste the Drive file ID for the cadet CSV.', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return '';
    return resp.getResponseText().trim();
  }

  export function importCadetCsv(fileIdInput?: string): void {
    const backendId = Config.getBackendId();
 
    const fileId = resolveCadetCsvFileId(fileIdInput);
    if (!fileId) return;

    let fileName = 'cadet_csv';
    let content = '';
    try {
      const file = DriveApp.getFileById(fileId);
      fileName = file.getName();
      content = file.getBlob().getDataAsString();
    } catch (err) {
      getUi()?.alert(`Unable to read file: ${err}`);
      Log.warn(`Unable to read file: ${err}`);
      return;
    }

    let rows: string[][] = [];
    try {
      rows = Utilities.parseCsv(content).map((r) => r.map((c) => String(c || '').trim()));
    } catch (err) {
      getUi()?.alert(`Failed to parse CSV: ${err}`);
      Log.warn(`Failed to parse CSV: ${err}`);
      return;
    }

    rows = rows.filter((r) => r.some((cell) => cell));
    const headerRowIndex = rows.findIndex((r) => {
      const normalized = r.map(normalizeHeader);
      return normalized.includes('last_name') && normalized.includes('first_name');
    });

    if (headerRowIndex === -1) {
      getUi()?.alert('No header row found (need at least last_name and first_name).');
      Log.warn('No header row found (need at least last_name and first_name).');
      return;
    }

    const headers = rows[headerRowIndex].map(normalizeHeader);
    const dataRows = rows
      .slice(headerRowIndex + 1)
      .filter((r) => {
        const normalized = r.map(normalizeHeader);
        if (normalized.includes('last_name') && normalized.includes('first_name')) return false; // skip secondary header rows
        return r.some((cell) => cell);
      });

    const records = dataRows
      .map((row) => buildRowMap(headers, row))
      .map((rowMap) => {
        const notes = composeNotes(rowMap);
        return {
          source: `cadet_csv:${fileName}`,
          last_name: coalesce(rowMap, ['last_name']),
          first_name: coalesce(rowMap, ['first_name']),
          as_year: coalesce(rowMap, ['as_year']),
          class_year: coalesce(rowMap, ['graduation_year', 'class_year']),
          flight: coalesce(rowMap, ['flight']),
          squadron: coalesce(rowMap, ['squadron']),
          university: coalesce(rowMap, ['university']),
          email: coalesce(rowMap, ['cadet_email', 'university_email', 'email']),
          phone: normalizePhone(coalesce(rowMap, ['phone', 'phone_number'])),
          dorm: coalesce(rowMap, ['dorm']),
          home_town: coalesce(rowMap, ['home_town']),
          home_state: coalesce(rowMap, ['home_state']),
          dob: coalesce(rowMap, ['dob', 'date_of_birth']),
          cip_broad_area: coalesce(rowMap, ['cip_broad', 'cip_broad_area']),
          cip_code: coalesce(rowMap, ['cip_code']),
          desired_assigned_afsc: coalesce(rowMap, ['afsc', 'desired_assigned_afsc']),
          flight_path_status: coalesce(rowMap, ['flight_path_status']),
          photo_link: coalesce(rowMap, ['photo_url', 'photo_link']),
          notes,
        };
      })
      .filter((row) => row.last_name || row.first_name || row.email);

    const backendSheet = SheetUtils.getSheet(backendId, CATEGORY_MAP.directory.sheetName);
    if (!backendSheet) {
      getUi()?.alert('Directory Backend sheet not found. Run setup first.');
      Log.warn('Directory Backend sheet not found. Run setup first.');
      return;
    }

    SheetUtils.writeTable(backendSheet, records);
    const msg = `Cadet CSV import complete. Rows written: ${records.length}`;
    getUi()?.alert(msg);
    Log.info(msg);
  }

  export function exportCategoryCsv(categoryInput?: string): void {
    const category = resolveCategory('Export which category (CSV)?', categoryInput);
    if (!category) return;
    const info = CATEGORY_MAP[category];
    const spreadsheetId = requireSpreadsheetId(info);
    if (!spreadsheetId) throw new Error(`${info.location === 'backend' ? 'Backend' : 'Frontend'} sheet ID not set. Run setup first.`);
    const sheet = SheetUtils.getSheet(spreadsheetId, info.sheetName);
    const locationLabel = info.location === 'backend' ? 'backend' : 'frontend';
    if (!sheet) {
      alertOrLog(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
      throw new Error(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
    }

    const data = SheetUtils.readTable(sheet);
    const csv = toCsv(data.headers, data.rows);
    const file = DriveApp.createFile(`shamrock-${category}-${new Date().toISOString()}.csv`, csv, 'text/csv');
    alertOrLog(`CSV export complete. File created: ${file.getName()} (ID: ${file.getId()})`);
  }

  export function importCategoryCsv(fileIdInput?: string, categoryInput?: string): void {
    const category = resolveCategory('Import which category (CSV)?', categoryInput);
    if (!category) return;
    const ui = getUi();
    const fileId = (() => {
      if (fileIdInput) return fileIdInput.trim();
      if (ui) {
        const idResp = ui.prompt('Enter Drive File ID of the CSV export', '', ui.ButtonSet.OK_CANCEL);
        if (idResp.getSelectedButton() !== ui.Button.OK) return '';
        return idResp.getResponseText().trim();
      }
      Log.warn('No UI available to prompt for file ID. Run this import from the Sheets menu.');
      return '';
    })();
    if (!fileId) return;

    const info = CATEGORY_MAP[category];
    const spreadsheetId = requireSpreadsheetId(info);
    if (!spreadsheetId) throw new Error(`${info.location === 'backend' ? 'Backend' : 'Frontend'} sheet ID not set. Run setup first.`);
    const sheet = SheetUtils.getSheet(spreadsheetId, info.sheetName);
    const locationLabel = info.location === 'backend' ? 'backend' : 'frontend';
    if (!sheet) {
      alertOrLog(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
      throw new Error(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
    }

    let content = '';
    try {
      content = DriveApp.getFileById(fileId).getBlob().getDataAsString();
    } catch (err) {
      alertOrLog(`Unable to read file: ${err}`);
      throw err;
    }

    const expectedHeaders = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map((h) => String(h || '').trim());

    let rows: Record<string, any>[] = [];
    try {
      rows = parseCsvToObjects(content, expectedHeaders);
    } catch (err) {
      alertOrLog(String(err));
      throw err;
    }

    if (category === 'events') {
      const existing = SheetUtils.readTable(sheet).rows;
      const toKey = (row: Record<string, any>) => {
        const eventId = String(row['event_id'] || '').trim();
        if (eventId) return `id:${eventId.toLowerCase()}`;
        const name = String(row['display_name'] || row['attendance_column_label'] || '').trim();
        return name ? `name:${name.toLowerCase()}` : '';
      };

      const merged = new Map<string, Record<string, any>>();
      existing.forEach((row) => {
        const key = toKey(row);
        if (key) merged.set(key, row);
      });
      rows.forEach((row) => {
        const key = toKey(row);
        if (key) merged.set(key, row);
        else merged.set(`row:${merged.size}`, row);
      });

      const mergedRows = Array.from(merged.values());
      mergedRows.sort((a, b) => {
        const aRaw = String(a['start_datetime'] || '');
        const bRaw = String(b['start_datetime'] || '');
        const aTime = aRaw ? new Date(aRaw).getTime() : Number.NaN;
        const bTime = bRaw ? new Date(bRaw).getTime() : Number.NaN;
        const aValid = Number.isFinite(aTime);
        const bValid = Number.isFinite(bTime);
        if (aValid && bValid) return aTime - bTime;
        if (aValid) return -1;
        if (bValid) return 1;
        return aRaw.localeCompare(bRaw, undefined, { sensitivity: 'base' });
      });

      SheetUtils.writeTable(sheet, mergedRows);
    } else {
      SheetUtils.writeTable(sheet, rows);
    }
    if (info.location === 'backend') {
      // Keep frontend view in sync for mapped backend tables (e.g., Leadership).
      SyncService.syncByBackendSheetName(info.sheetName);
    }
    if (category === 'events') {
      try {
        SetupService.refreshEventsArtifacts();
      } catch (err) {
        Log.warn(`Unable to refresh events artifacts after CSV import: ${err}`);
        throw err;
      }
    }

    alertOrLog(`CSV import complete into ${info.sheetName}. Rows written: ${rows.length}`);
  }

  // Convenience wrappers for common requests
  export function exportEventsCsv(): void {
    exportCategoryCsv('events');
  }

  export function importEventsCsv(fileId?: string): void {
    importCategoryCsv(fileId, 'events');
    // Script-driven writes do not reliably trigger spreadsheet onEdit, so refresh the attendance form event list explicitly.
    SetupService.refreshEventsArtifacts();
  }

  export function exportAttendanceCsv(): void {
    exportCategoryCsv('attendance');
  }

  export function importAttendanceCsv(fileId?: string): void {
    importCategoryCsv(fileId, 'attendance');
  }

  export function exportLeadershipCsv(): void {
    exportCategoryCsv('cadre');
  }

  export function importLeadershipCsv(fileIdInput?: string): void {
    importCategoryCsv(fileIdInput, 'cadre');
  }

  export function exportCadetsCsv(): void {
    exportCategoryCsv('directory');
  }

  export function importCadetsCsv(fileIdInput?: string): void {
    importCategoryCsv(fileIdInput, 'directory');
  }
}
