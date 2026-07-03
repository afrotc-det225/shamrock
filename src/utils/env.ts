// Environment helpers for accessing script properties and required sheets.

namespace Config {
  function requireProperty(key: string, resourceLabel: string): string {
    const value = getScriptProperty(key);
    if (!value) {
      const msg = `${resourceLabel} script property '${key}' is missing; run setup to populate it.`;
      Log.error(msg);
      throw new Error(msg);
    }
    return value;
  }

  export function getBackendId(): string {
    return requireProperty(PROPERTY_KEYS.ADMIN_SPREADSHEET_ID, 'Admin workbook ID');
  }

  export function getFrontendId(): string {
    return requireProperty(PROPERTY_KEYS.MAIN_SPREADSHEET_ID, 'Main workbook ID');
  }

  function getSheetOrThrow(spreadsheetId: string, sheetName: string, context: string) {
    let ss: GoogleAppsScript.Spreadsheet.Spreadsheet;
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (err) {
      const msg = `${context}: unable to open spreadsheet ${spreadsheetId}: ${err}`;
      Log.error(msg);
      throw new Error(msg);
    }
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      const msg = `${context}: sheet '${sheetName}' missing in spreadsheet ${spreadsheetId}`;
      Log.error(msg);
      throw new Error(msg);
    }
    return sheet;
  }

  export function getBackendSheet(sheetName: string) {
    return getSheetOrThrow(getBackendId(), sheetName, 'Backend');
  }

  export function getFrontendSheet(sheetName: string) {
    return getSheetOrThrow(getFrontendId(), sheetName, 'Frontend');
  }
}
