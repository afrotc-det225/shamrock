// Sheet utilities for header-driven operations.

namespace SheetUtils {
  export interface TableData {
    headers: string[];
    rows: any[];
  }

  export function getSheet(spreadsheetId: string, name: string): GoogleAppsScript.Spreadsheet.Sheet | null {
    try {
      const ss = SpreadsheetApp.openById(spreadsheetId);
      return ss.getSheetByName(name);
    } catch (err) {
      Log.error(`Unable to open sheet ${name} in ${spreadsheetId}: ${err}`);
      return null;
    }
  }

  // Reads table data assuming row 1 = machine headers, row 2 = display headers, data starts at row 3.
  export function readTable(sheet: GoogleAppsScript.Spreadsheet.Sheet): TableData {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());
    if (lastRow < 3) {
      return { headers, rows: [] };
    }
    const values = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
    const rows = values.map((row) => {
      const obj: Record<string, any> = {};
      headers.forEach((h, idx) => {
        obj[h] = row[idx];
      });
      return obj;
    });
    return { headers, rows };
  }

  /**
   * Ensure a sheet's columns match its schema. Reads all data, remaps known columns
   * to the schema order, inserts blanks for missing columns, and writes everything back.
   */
  export function ensureSchemaColumns(sheet: GoogleAppsScript.Spreadsheet.Sheet): string[] {
    const schema = Schemas.getTabSchema(sheet.getName());
    if (!schema?.machineHeaders) return readHeaders(sheet);

    const expected = schema.machineHeaders;
    const display = schema.displayHeaders || expected;
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    const current = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim())
      : [];

    const alreadyMatches = current.length === expected.length && expected.every((h, idx) => current[idx] === h);
    if (alreadyMatches) return current;

    // Remap when columns are missing or when existing columns are in an older order.
    const missing = expected.filter((h) => !current.includes(h));
    const orderChanged = missing.length === 0;
    Log.info(
      orderChanged
        ? `ensureSchemaColumns: ${sheet.getName()} column order differs from schema; remapping to current baseline.`
        : `ensureSchemaColumns: ${sheet.getName()} missing columns: ${missing.join(', ')}`,
    );

    // Read all data (rows 3+)
    const dataRows = lastRow >= 3
      ? sheet.getRange(3, 1, lastRow - 2, lastCol).getValues()
      : [];

    // Build column mapping: for each expected header, find its index in current headers
    const colMap = expected.map((h) => current.indexOf(h)); // -1 means new/missing

    // Remap data rows to new column order
    const newData = dataRows.map((row) =>
      colMap.map((oldIdx) => (oldIdx >= 0 ? row[oldIdx] : ''))
    );

    // Resize sheet to fit new schema
    const maxCols = sheet.getMaxColumns();
    if (maxCols < expected.length) {
      sheet.insertColumnsAfter(maxCols, expected.length - maxCols);
    }

    // Write headers
    sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
    sheet.getRange(2, 1, 1, display.length).setValues([display]);

    // Write remapped data
    if (newData.length > 0) {
      sheet.getRange(3, 1, newData.length, expected.length).setValues(newData);
    }

    // Trim extra columns beyond schema width
    const finalMaxCols = sheet.getMaxColumns();
    if (finalMaxCols > expected.length) {
      sheet.deleteColumns(expected.length + 1, finalMaxCols - expected.length);
    }

    Log.info(
      orderChanged
        ? `ensureSchemaColumns: ${sheet.getName()} updated - remapped columns to schema order.`
        : `ensureSchemaColumns: ${sheet.getName()} updated - added ${missing.length} column(s): ${missing.join(', ')}`,
    );
    return expected.slice();
  }

  function readHeaders(sheet: GoogleAppsScript.Spreadsheet.Sheet): string[] {
    const lastCol = sheet.getLastColumn();
    return lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim())
      : [];
  }

  function restoreHeadersIfMissing(sheet: GoogleAppsScript.Spreadsheet.Sheet): string[] {
    let lastCol = sheet.getLastColumn();
    let headers = sheet.getRange(1, 1, 1, Math.max(1, lastCol)).getValues()[0].map((h) => String(h || '').trim());

    if (headers.every((h) => !h)) {
      const schema = Schemas.getTabSchema(sheet.getName());
      const machine = schema?.machineHeaders || [];
      if (machine.length) {
        const width = machine.length;
        const display = schema?.displayHeaders && schema.displayHeaders.length === width ? schema.displayHeaders : machine;

        const maxCols = sheet.getMaxColumns();
        if (maxCols < width) sheet.insertColumnsAfter(maxCols, width - maxCols);
        else if (maxCols > width) sheet.deleteColumns(width + 1, maxCols - width);

        sheet.getRange(1, 1, 1, width).setValues([machine]);
        sheet.getRange(2, 1, 1, width).setValues([display]);
        Log.warn(`Restored missing headers on ${sheet.getName()} from schema.`);
        lastCol = width;
        headers = machine.slice();
      }
    }

    return headers;
  }

  // Writes table data (array of objects) starting at row 3, preserving existing headers.
  export function writeTable(sheet: GoogleAppsScript.Spreadsheet.Sheet, rows: Record<string, any>[]) {
    const headers = restoreHeadersIfMissing(sheet);
    if (headers.every((h) => !h)) {
      Log.warn(`writeTable called on ${sheet.getName()} with empty headers; skipping write to avoid data/header loss.`);
      return;
    }
    const lastCol = headers.length;
    // Clear existing data rows (row 3 onward)
    const lastRow = sheet.getLastRow();
    if (lastRow >= 3) {
      sheet.getRange(3, 1, lastRow - 2, lastCol).clearContent();
    }
    if (!rows.length) return;
    const output = rows.map((r) => headers.map((h) => r[h] ?? ''));
    sheet.getRange(3, 1, output.length, headers.length).setValues(output);
  }

  // Appends rows to the table starting at the first empty row after header rows.
  export function appendRows(sheet: GoogleAppsScript.Spreadsheet.Sheet, rows: Record<string, any>[]) {
    if (!rows.length) return;
    const headers = restoreHeadersIfMissing(sheet);
    if (headers.every((h) => !h)) {
      Log.warn(`appendRows called on ${sheet.getName()} with empty headers; skipping append to avoid data/header loss.`);
      return;
    }
    const lastCol = headers.length;
    const startRow = Math.max(3, sheet.getLastRow() + 1);
    const output = rows.map((r) => headers.map((h) => r[h] ?? ''));
    sheet.getRange(startRow, 1, output.length, headers.length).setValues(output);
  }

  export function lookupRowByEmail(spreadsheetId: string | null, sheetName: string, email: string): Record<string, any> | null {
    if (!spreadsheetId || !email) return null;
    const sheet = getSheet(spreadsheetId, sheetName);
    if (!sheet) return null;
    const table = readTable(sheet);
    const lower = email.toLowerCase();
    return table.rows.find((r) => String(r['email'] || '').toLowerCase() === lower) || null;
  }
}
