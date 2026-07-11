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

  function configureProtectionEditors(
    protection: GoogleAppsScript.Spreadsheet.Protection,
    description: string,
    editors: string[],
  ) {
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

      if (editors.length) {
        try {
          const desired = new Set(editors.map((e) => e.toLowerCase()));
          const remove = currentEditors.filter((u) => {
            const email = (u as any)?.getEmail?.() || '';
            return email && !desired.has(email.toLowerCase());
          });
          if (remove.length) protection.removeEditors(remove as any);
          protection.addEditors(editors);
        } catch (err) {
          Log.warn(`Unable to set editors for protection ${description}: ${err}`);
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
      configureProtectionEditors(protection, description, editors);
    }
    return protection;
  }

  function ensureSheetProtection(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    description: string,
    editors: string[] = [],
  ) {
    sheet
      .getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .filter((protection) => protection.getDescription?.() === description)
      .forEach((protection) => protection.remove());
    const protection = sheet.protect().setDescription(description);
    protection.setWarningOnly(false);
    configureProtectionEditors(protection, description, normalizeEditors(editors));
    return protection;
  }

  function protectEntireManagedSheet(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    description: string,
  ) {
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => protection.remove());
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => protection.remove());
    ensureSheetProtection(sheet, description);
  }

  function getMainWorkbookAllowedEditors(): string[] {
    try {
      return Config.getCommaSeparatedScriptProperty(Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.MAIN_WORKBOOK_ALLOWED_EDITOR_EMAILS} property: ${err}`);
      return [];
    }
  }

  const FRONTEND_ARCHIVE_PATTERN = /^(?:(?:Spring|Fall) \d{4} (?:Leadership|Directory|Attendance)(?: \d+)?|Archive (?:Leadership|Directory|Attendance)(?: \d+)?)$/;
  const DASHBOARD_HELPER_SHEET = 'Dashboard Data';
  const LEGACY_DASHBOARD_HELPER_SHEET = '_Dashboard Data';

  function isFrontendArchiveSheetName(name: string): boolean {
    return FRONTEND_ARCHIVE_PATTERN.test(String(name || '').trim());
  }

  function isManagedHiddenFrontendSheetName(name: string): boolean {
    return name === 'Data Legend'
      || name === DASHBOARD_HELPER_SHEET
      || name === LEGACY_DASHBOARD_HELPER_SHEET
      || isFrontendArchiveSheetName(name);
  }

  function organizeHiddenFrontendSheets(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    let dashboardData = ss.getSheetByName(DASHBOARD_HELPER_SHEET);
    const legacyDashboardData = ss.getSheetByName(LEGACY_DASHBOARD_HELPER_SHEET);
    if (!dashboardData && legacyDashboardData) {
      legacyDashboardData.setName(DASHBOARD_HELPER_SHEET);
      dashboardData = legacyDashboardData;
      Log.info(`Renamed ${LEGACY_DASHBOARD_HELPER_SHEET} to ${DASHBOARD_HELPER_SHEET}.`);
    } else if (dashboardData && legacyDashboardData) {
      Log.warn(`Both ${DASHBOARD_HELPER_SHEET} and ${LEGACY_DASHBOARD_HELPER_SHEET} exist; hiding both until Dashboard rebuild removes the legacy duplicate.`);
    }

    const desiredOrder = ['Dashboard', 'Leadership', 'Directory', 'Attendance', 'Data Legend', DASHBOARD_HELPER_SHEET];
    let temporarilyShown = 0;
    let position = 1;
    desiredOrder.forEach((name) => {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      if (sheet.isSheetHidden()) {
        sheet.showSheet();
        temporarilyShown++;
      }
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(position++);
    });

    const dashboard = ss.getSheetByName('Dashboard');
    if (dashboard) ss.setActiveSheet(dashboard);
    const hiddenTargets = ss.getSheets().filter((sheet) => isManagedHiddenFrontendSheetName(sheet.getName()));
    hiddenTargets.forEach((sheet) => {
      if (!sheet.isSheetHidden()) sheet.hideSheet();
    });
    return {
      archives: hiddenTargets.filter((sheet) => isFrontendArchiveSheetName(sheet.getName())),
      supportSheets: hiddenTargets.filter((sheet) => !isFrontendArchiveSheetName(sheet.getName())),
      temporarilyShown,
    };
  }

  function protectFirstTwoRows(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    ss.getSheets().forEach((sheet) => {
      const name = sheet.getName();
      if (name === 'Dashboard' || isManagedHiddenFrontendSheetName(name)) return; // handled separately
      try {
        const lastCol = Math.max(1, sheet.getLastColumn());
        const range = sheet.getRange(1, 1, 2, lastCol);
        ensureRangeProtection(sheet, range, `${sheet.getName()}:header_rows`, { warningOnly: false, editors });
      } catch (err) {
        Log.warn(`Skipping header-row protection on ${sheet.getName()}: ${err}`);
      }
    });
  }

  function protectDashboard(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, editors: string[] = []) {
    const sheet = ss.getSheetByName('Dashboard');
    if (!sheet) return;
    const lastRow = Math.max(50, sheet.getMaxRows());
    // Protect the generated birthday table (headers + data) in columns A:E.
    const birthdayRange = sheet.getRange(50, 1, lastRow - 49, 5);
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

  function protectDataLegend(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return;
    protectEntireManagedSheet(sheet, 'Data Legend:all');
  }

  function protectDashboardData(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    [DASHBOARD_HELPER_SHEET, LEGACY_DASHBOARD_HELPER_SHEET].forEach((name) => {
      const sheet = ss.getSheetByName(name);
      if (sheet) protectEntireManagedSheet(sheet, `${name}:all`);
    });
  }

  function protectArchives(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const archives = ss.getSheets().filter((sheet) => isFrontendArchiveSheetName(sheet.getName()));
    archives.forEach((sheet) => protectEntireManagedSheet(sheet, `SHAMROCK archive: ${sheet.getName()}`));
    return archives.length;
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

    let archiveCount = 0;
    let supportSheetCount = 0;
    runProtectionStep('organize hidden sheets', () => {
      const organized = organizeHiddenFrontendSheets(ss);
      archiveCount = organized.archives.length;
      supportSheetCount = organized.supportSheets.length;
    });

    // Only broaden protections for Leadership and Attendance (allowlist). Directory warning stays open; others remain owner-only.
    runProtectionStep('header_rows', () => protectFirstTwoRows(ss));
    runProtectionStep('Dashboard:birthdays', () => protectDashboard(ss));
    runProtectionStep('Leadership:all', () => protectLeadership(ss, allowedEditors));
    runProtectionStep('Data Legend:all', () => protectDataLegend(ss));
    runProtectionStep('Dashboard Data:all', () => protectDashboardData(ss));
    runProtectionStep('frontend archives', () => {
      archiveCount = protectArchives(ss);
    });
    runProtectionStep('Directory protections', () => protectDirectory(ss)); // name lock stays owner-only; warning is warning-only (open)
    runProtectionStep('Attendance protections', () => protectAttendance(ss, allowedEditors));
    ProgressService.report({
      title: 'Archive and support sheets secured',
      detail: `Locked and hid ${archiveCount} archive sheet(s) and ${supportSheetCount} support sheet(s).`,
      hint: 'Dashboard, Leadership, Directory, and Attendance remain the visible working tabs.',
    });
    Log.info(`Frontend protections secured archives=${archiveCount} supportSheets=${supportSheetCount}.`);
  }

  export function clearManagedFrontendProtections(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;

    const managedDescriptions = new Set([
      'FAQs:all', // retired surface; retained here so its old protection can be removed before sheet deletion
      'Dashboard:birthdays',
      'Leadership:all',
      'Data Legend:all',
      'Dashboard Data:all',
      '_Dashboard Data:all',
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
