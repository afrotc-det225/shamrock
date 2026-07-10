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

    const headerRow = rows[0].map((h) => String(h || '').trim());
    const exactMismatch = headerRow.length !== expectedHeaders.length || headerRow.some((h, i) => h !== expectedHeaders[i]);
    if (exactMismatch) throw new Error('Header mismatch between CSV and target sheet. v2 imports require exact machine headers.');

    return rows.slice(1).map((row) => {
      const obj: Record<string, any> = {};
      expectedHeaders.forEach((h) => {
        const idx = expectedHeaders.indexOf(h);
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

  export function exportCategoryCsv(categoryInput?: string): void {
    const category = resolveCategory('Export which category (CSV)?', categoryInput);
    if (!category) return;
    const info = CATEGORY_MAP[category];
    ProgressService.report({
      title: `Reading ${info.sheetName}`,
      detail: info.description,
      hint: 'This export reads data only; it does not change the workbook.',
      percent: 30,
      step: 1,
      totalSteps: 3,
    });
    const spreadsheetId = requireSpreadsheetId(info);
    if (!spreadsheetId) throw new Error(`${info.location === 'backend' ? 'Backend' : 'Frontend'} sheet ID not set. Run setup first.`);
    const sheet = SheetUtils.getSheet(spreadsheetId, info.sheetName);
    const locationLabel = info.location === 'backend' ? 'backend' : 'frontend';
    if (!sheet) {
      alertOrLog(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
      throw new Error(`Sheet ${info.sheetName} not found in ${locationLabel}.`);
    }

    const data = SheetUtils.readTable(sheet);
    ProgressService.report({
      title: 'Building the CSV file',
      detail: `Converting ${data.rows.length} row(s) using the current machine headers.`,
      percent: 65,
      step: 2,
      totalSteps: 3,
    });
    const csv = toCsv(data.headers, data.rows);
    const file = DriveApp.createFile(`shamrock-${category}-${new Date().toISOString()}.csv`, csv, 'text/csv');
    ProgressService.report({
      title: 'Saving the export in Drive',
      detail: `Created ${file.getName()} with ${data.rows.length} data row(s).`,
      percent: 92,
      step: 3,
      totalSteps: 3,
    });
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
    ProgressService.report({
      title: 'Opening the selected CSV',
      detail: `Reading the file for ${info.sheetName}.`,
      hint: 'No sheet rows are changed until the file structure passes validation.',
      percent: 25,
      step: 1,
      totalSteps: 4,
    });
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

    ProgressService.report({
      title: 'Validating the CSV structure',
      detail: 'Comparing the file headers with the current supported sheet schema.',
      percent: 45,
      step: 2,
      totalSteps: 4,
    });
    let rows: Record<string, any>[] = [];
    try {
      rows = parseCsvToObjects(content, expectedHeaders);
    } catch (err) {
      alertOrLog(String(err));
      throw err;
    }

    ProgressService.report({
      title: `Writing ${rows.length} imported row(s)`,
      detail: category === 'events'
        ? 'Merging matching events and preserving a chronological order.'
        : `Replacing the current ${info.sheetName} data rows with the validated import.`,
      percent: 65,
      step: 3,
      totalSteps: 4,
    });
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

    ProgressService.report({
      title: 'Imported data and dependent views are ready',
      detail: `${info.sheetName} is saved and its supported derived frontend updates have finished.`,
      percent: 90,
      step: 4,
      totalSteps: 4,
    });
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
