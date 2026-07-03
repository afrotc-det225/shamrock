// Frontend protections: lock headers, key columns, and scoped editors.

namespace ProtectionService {
  interface ProtectionOptions {
    warningOnly?: boolean;
    editors?: string[];
  }

  function openFrontend(frontendId: string): GoogleAppsScript.Spreadsheet.Spreadsheet | null {
    if (!frontendId) return null;
    try {
      return SpreadsheetApp.openById(frontendId);
    } catch (err) {
      Log.warn(`Unable to open frontend spreadsheet ${frontendId}: ${err}`);
      return null;
    }
  }

  function normalizeEditors(editors: string[]): string[] {
    return Array.from(new Set(editors.map((e) => (e || '').trim()).filter(Boolean)));
  }

  function ensureRangeProtection(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    range: GoogleAppsScript.Spreadsheet.Range,
    description: string,
    opts: ProtectionOptions = {},
  ) {
    // Remove any prior protection with the same description to avoid stacking duplicates.
    sheet
      .getProtections(SpreadsheetApp.ProtectionType.RANGE)
      .filter((p) => p.getDescription && p.getDescription() === description)
      .forEach((p) => p.remove());

    const protection = range.protect().setDescription(description);
    protection.setWarningOnly(Boolean(opts.warningOnly));
    const editors = normalizeEditors(opts.editors || []);
    if (!protection.isWarningOnly()) {
      try {
        if (protection.canDomainEdit && protection.canDomainEdit()) {
          try {
            protection.setDomainEdit(false);
          } catch (err) {
            Log.warn(`Unable to disable domain edit for ${description}: ${err}`);
          }
        }
        const currentEditors = (() => {
          try {
            return protection.getEditors();
          } catch {
            return [];
          }
        })();

        // If an allowlist is provided, ensure only those editors are on the list; otherwise remove all extra editors for owner-only.
        if (editors.length) {
          try {
            const desired = new Set(editors.map((e) => e.toLowerCase()));
            const remove = currentEditors.filter((u) => {
              const email = (u as any)?.getEmail?.() || '';
              return email && !desired.has(email.toLowerCase());
            });
            if (remove.length) {
              try {
                protection.removeEditors(remove as any);
              } catch (err) {
                Log.warn(`Unable to prune editors for ${description}: ${err}`);
              }
            }
            protection.addEditors(editors);
          } catch (err) {
            Log.warn(`Unable to add editors to protection ${description}: ${err}`);
          }
        } else if (currentEditors.length) {
          try {
            protection.removeEditors(currentEditors as any);
          } catch (err) {
            Log.warn(`Unable to remove editors for ${description}: ${err}`);
          }
        }
      } catch (err) {
        Log.warn(`Unable to configure editors for ${description}: ${err}`);
      }
    }
    return protection;
  }

  function getMainWorkbookAllowedEditors(): string[] {
    try {
      return Config.getCommaSeparatedScriptProperty(Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS} property: ${err}`);
      return [];
    }
  }

  function protectFirstTwoRows(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    ss.getSheets().forEach((sheet) => {
      const name = sheet.getName();
      if (name === 'FAQs' || name === 'Dashboard') return; // handled separately
      const lastCol = Math.max(1, sheet.getLastColumn(), sheet.getMaxColumns());
      const range = sheet.getRange(1, 1, 2, lastCol);
      ensureRangeProtection(sheet, range, `${sheet.getName()}:header_rows`, { warningOnly: false, editors });
    });
  }

  function protectFaqs(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('FAQs');
    if (!sheet) return;
    const range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    ensureRangeProtection(sheet, range, 'FAQs:all', { warningOnly: false, editors });
  }

  function protectDashboard(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Dashboard');
    if (!sheet) return;
    const lastRow = Math.max(3, sheet.getMaxRows());
    // Protect birthdays block (headers + data) in columns I:M
    const birthdayRange = sheet.getRange(3, 9, lastRow - 2, 5);
    ensureRangeProtection(sheet, birthdayRange, 'Dashboard:birthdays', { warningOnly: false, editors });
  }

  function getLeadershipEmails(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): string[] {
    const viaSheetsApi = getLeadershipEmailsViaSheetsApi(ss);
    if (viaSheetsApi) return viaSheetsApi;

    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return [];
    try {
      const lastRow = sheet.getLastRow();
      if (lastRow < 3) return [];
      // Find the machine header 'email' to avoid hardcoded offsets.
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim().toLowerCase());
      const emailColIdx = headers.indexOf('email');
      if (emailColIdx < 0) return [];
      const values = sheet.getRange(3, emailColIdx + 1, lastRow - 2, 1).getValues().map((r) => String(r[0] || '').trim());
      // Filter out obvious non-email entries (e.g., roles accidentally stored here).
      const emails = values.filter((v) => v.includes('@'));
      return normalizeEditors(emails);
    } catch (err) {
      Log.warn(`Unable to read Leadership emails for protections: ${err}`);
      return [];
    }
  }

  function getLeadershipEmailsViaSheetsApi(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): string[] | null {
    const valuesService = (globalThis as any).Sheets?.Spreadsheets?.Values;
    if (!valuesService?.get) return null;
    try {
      const response = valuesService.get(ss.getId(), 'Leadership!1:1000', {
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      const rows = (response?.values || []) as unknown[][];
      if (rows.length < 3) return [];
      const headers = (rows[0] || []).map((h) => String(h || '').trim().toLowerCase());
      const emailColIdx = headers.indexOf('email');
      if (emailColIdx < 0) return [];
      const emails = rows
        .slice(2)
        .map((row) => String(row[emailColIdx] || '').trim())
        .filter((v) => v.includes('@'));
      return normalizeEditors(emails);
    } catch (err) {
      Log.warn(`Unable to read Leadership emails with Sheets API for protections: ${err}`);
      return null;
    }
  }

  function runProtectionStep(label: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      Log.warn(`Skipping frontend protection step ${label}: ${err}`);
    }
  }

  function protectLeadership(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;
    const range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    ensureRangeProtection(sheet, range, 'Leadership:all', { warningOnly: false, editors });
  }

  function protectDataLegend(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return;
    const range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    ensureRangeProtection(sheet, range, 'Data Legend:all', { warningOnly: false, editors });
  }

  function protectDirectory(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;
    // Clear any prior sheet-level protections to avoid overlapping "except" scopes.
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => p.remove());
    const lastRow = Math.max(3, sheet.getMaxRows());
    const lastCol = Math.max(1, sheet.getMaxColumns());

    // Lock last/first name columns for data rows only (row 3+).
    const dataRowCount = Math.max(1, lastRow - 2);
    const nameRange = sheet.getRange(3, 1, dataRowCount, 2);
    ensureRangeProtection(sheet, nameRange, 'Directory:last_first_locked', { warningOnly: false, editors });

    // Warn-only on header rows across visible columns (A1:S2 or to last column if narrower).
    const warnCols = Math.min(lastCol, 19); // Column S = 19
    const warnRange = sheet.getRange(1, 1, dataRowCount, warnCols);
    ensureRangeProtection(sheet, warnRange, 'Directory:warn_rest', { warningOnly: true, editors });
  }

  function protectAttendance(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;
    // Clear any prior sheet protections to prevent stale "except" scopes.
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => p.remove());
    const lastRow = Math.max(3, sheet.getMaxRows());
    const lastCol = Math.max(1, sheet.getLastColumn(), sheet.getMaxColumns());

    // Lock columns A:G (Last Name through LLAB) across all rows.
    const fixedRange = sheet.getRange(1, 1, lastRow, Math.min(lastCol, 7));
    // Owner-only for fixed columns (A:G)
    ensureRangeProtection(sheet, fixedRange, 'Attendance:fixed_cols', { warningOnly: false });

    // Event columns (H+): protect rows 3+ but allow leadership emails to edit.
    const eventsStartCol = 8;
    if (lastCol >= eventsStartCol) {
      const eventsRange = sheet.getRange(3, eventsStartCol, lastRow - 2, lastCol - eventsStartCol + 1);
      ensureRangeProtection(sheet, eventsRange, 'Attendance:event_cols_with_leadership', {
        warningOnly: false,
        editors,
      });
    }
  }

  export function applyFrontendProtections(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;

    const allowedEditors = normalizeEditors([
      ...getMainWorkbookAllowedEditors(),
      ...getLeadershipEmails(ss),
    ]);

    // Only broaden protections for FAQs, Leadership, and Attendance (allowlist). Directory warning stays open; others remain owner-only.
    runProtectionStep('header_rows', () => protectFirstTwoRows(ss));
    runProtectionStep('FAQs:all', () => protectFaqs(ss, allowedEditors));
    runProtectionStep('Dashboard:birthdays', () => protectDashboard(ss));
    runProtectionStep('Leadership:all', () => protectLeadership(ss, allowedEditors));
    runProtectionStep('Data Legend:all', () => protectDataLegend(ss));
    runProtectionStep('Directory protections', () => protectDirectory(ss)); // name lock stays owner-only; warning is warning-only (open)
    runProtectionStep('Attendance protections', () => protectAttendance(ss, allowedEditors));
  }

  export function clearManagedFrontendProtections(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;

    const managedDescriptions = new Set([
      'FAQs:all',
      'Dashboard:birthdays',
      'Leadership:all',
      'Data Legend:all',
      'Directory:last_first_locked',
      'Directory:warn_rest',
      'Directory headers (auto)',
      'Attendance:fixed_cols',
      'Attendance:event_cols_with_leadership',
    ]);

    ss.getSheets().forEach((sheet) => {
      sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => {
        const description = protection.getDescription?.() || '';
        if (managedDescriptions.has(description) || description.endsWith(':header_rows')) {
          try {
            protection.remove();
          } catch (err) {
            Log.warn(`Unable to remove managed protection ${description}: ${err}`);
          }
        }
      });

      sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => {
        const description = protection.getDescription?.() || '';
        if (!description || managedDescriptions.has(description)) {
          try {
            protection.remove();
          } catch (err) {
            Log.warn(`Unable to remove managed sheet protection ${description}: ${err}`);
          }
        }
      });
    });
  }
}
