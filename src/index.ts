// Entry points for SHAMROCK Apps Script.

/** Show a non-blocking toast notification in the spreadsheet. */
function toast(message: string, title?: string, timeoutSeconds?: number) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, title || 'SHAMROCK', timeoutSeconds ?? 5);
  } catch {}
}

class MenuActionCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuActionCancelled';
  }
}

interface MenuActionOptions {
  label: string;
  category: string;
  action: string;
  targetSheet?: string;
  targetTable?: string;
  metadata?: Record<string, any>;
}

function errorDetails(err: any): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function confirmMenuAction(title: string, message: string) {
  const ui = SpreadsheetApp.getUi();
  const result = ui.alert(title, message, ui.ButtonSet.OK_CANCEL);
  if (result !== ui.Button.OK) {
    throw new MenuActionCancelled(`User cancelled "${title}"`);
  }
}

function promptDriveFileId(title: string): string {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(title, 'Enter the Drive file ID for the CSV file to import.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) {
    throw new MenuActionCancelled(`User cancelled "${title}"`);
  }

  const fileId = response.getResponseText().trim();
  if (!fileId) {
    throw new Error(`${title} requires a Drive file ID.`);
  }
  return fileId;
}

/** Wrap every menu action with consistent UI, execution logs, and Audit Backend rows. */
function runMenuAction<T>(opts: MenuActionOptions, fn: () => T): T | undefined {
  const runId = Utilities.getUuid();
  const startedAt = Date.now();
  const actorEmail = AuditService.actorEmail();
  const auditBase = {
    action: opts.action,
    actionLabel: opts.label,
    category: opts.category,
    actorEmail,
    targetSheet: opts.targetSheet,
    targetTable: opts.targetTable,
    source: 'SHAMROCK menu',
    runId,
    metadata: opts.metadata,
    role: 'menu_operator',
  };

  Log.info(`[menu:${runId}] START category="${opts.category}" action="${opts.action}" label="${opts.label}" actor="${actorEmail}"`);
  AuditService.log({ ...auditBase, result: 'started' });
  toast(`${opts.label}...`, 'Starting');

  try {
    const result = fn();
    const durationMs = Date.now() - startedAt;
    Log.info(`[menu:${runId}] OK action="${opts.action}" durationMs=${durationMs}`);
    AuditService.log({ ...auditBase, result: 'ok', durationMs });
    toast(`${opts.label} — done.`, 'Complete', 3);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof MenuActionCancelled) {
      Log.info(`[menu:${runId}] CANCELLED action="${opts.action}" durationMs=${durationMs} reason="${err.message}"`);
      AuditService.log({ ...auditBase, result: 'cancelled', durationMs, reason: err.message });
      toast(`${opts.label} — cancelled.`, 'Cancelled', 3);
      return undefined;
    }

    Log.error(`[menu:${runId}] FAILED action="${opts.action}" durationMs=${durationMs} error="${errorDetails(err)}"`);
    AuditService.log({ ...auditBase, result: 'failed', durationMs, error: err, severity: 'ERROR' });
    toast(`${opts.label} — failed. Check logs.`, 'Error', 10);
    try {
      SpreadsheetApp.getUi().alert(`${opts.label} failed.\n\nRun ID: ${runId}\n\n${errorDetails(err)}`);
    } catch {}
    throw err;
  }
}

function addShamrockMenu() {
  const ui = SpreadsheetApp.getUi();

  ui
    .createMenu('SHAMROCK')
    .addSubMenu(
      ui
        .createMenu('Setup & Automations')
        .addItem('Run setup (ensure-exists)', 'setup')
        .addSeparator()
        .addItem('Transfer to new semester (v2)', 'transferToNewSemesterV2')
        .addItem('Transfer to new academic year (v2)', 'transferToNewAcademicYearV2')
        .addSeparator()
        .addItem('Pause automations', 'pauseAutomations')
        .addItem('Resume automations', 'resumeAutomations')
        .addItem('Reinstall triggers', 'reinstallAllTriggers')
    )
    .addSubMenu(
      ui
        .createMenu('Sync & Refresh')
        .addItem('Sync Directory to frontend', 'syncDirectoryBackendToFrontend')
        .addItem('Sync Leadership to frontend', 'syncLeadershipBackendToFrontend')
        .addItem('Sync Data Legend to frontend', 'syncDataLegendBackendToFrontend')
        .addItem('Sync all mapped tabs', 'syncAllBackendToFrontend')
        .addSeparator()
        .addItem('Refresh Events artifacts', 'refreshEventsArtifacts')
        .addItem('Refresh Data Legend artifacts', 'refreshDataLegendAndFrontend')
        .addItem('Rebuild Dashboard', 'rebuildDashboard')
        .addItem('Rebuild Attendance Matrix', 'rebuildAttendanceMatrix')
        .addItem('Rebuild Attendance Form', 'rebuildAttendanceForm')
        .addItem('Refresh Excusals Form choices', 'refreshExcusalsForm')
    )
    .addSubMenu(
      ui
        .createMenu('Attendance')
        .addItem('Fix Attendance headers', 'fixAttendanceHeaders')
        .addItem('Fill Attendance event cells', 'fillAttendanceEventPrompt')
        .addItem('Debug Attendance response columns', 'debugAttendanceResponseSheet')
    )
    .addSubMenu(
      ui
        .createMenu('Excusals')
        .addItem('Setup management spreadsheet', 'setupExcusalsManagementSpreadsheet')
        .addItem('Share management spreadsheet', 'shareExcusalsManagementSpreadsheet')
        .addItem('Reinitialize management sheets', 'reinitializeExcusalsManagementSheets')
        .addSeparator()
        .addItem('Debug Excusals response columns', 'debugExcusalsResponseColumnsVerbose')
    )
    .addSubMenu(
      ui
        .createMenu('Leadership & Directory')
        .addItem('Add Leadership entry', 'addLeadershipEntry')
        .addItem('Add Deputy Flight Commanders', 'addDeputyFlightCommanders')
        .addItem('Replay latest Directory form response', 'replayLatestDirectoryFormResponse')
    )
    .addSubMenu(
      ui
        .createMenu('Formatting & Protections')
        .addItem('Apply frontend formatting', 'applyFrontendFormatting')
        .addItem('Toggle frontend formatting', 'toggleFrontendFormatting')
        .addItem('Toggle column width formatting', 'toggleFrontendColumnWidths')
        .addItem('Reapply frontend protections', 'reapplyFrontendProtections')
        .addItem('Reorder frontend sheets', 'reorderFrontendSheets')
        .addItem('Reorder backend sheets', 'reorderBackendSheets')
    )
    .addSubMenu(
      ui
        .createMenu('Imports & Exports')
        .addItem('Export Cadets CSV', 'exportCadetsCsv')
        .addItem('Import Cadets CSV', 'importCadetsCsv')
        .addItem('Export Leadership CSV', 'exportLeadershipCsv')
        .addItem('Import Leadership CSV', 'importLeadershipCsv')
        .addItem('Export Events CSV', 'exportEventsCsv')
        .addItem('Import Events CSV', 'importEventsCsv')
        .addItem('Export Attendance CSV', 'exportAttendanceCsv')
        .addItem('Import Attendance CSV', 'importAttendanceCsv')
    )
    .addSubMenu(
      ui
        .createMenu('Maintenance')
        .addItem('Clean up script properties', 'cleanupScriptProperties')
        .addItem('Cleanup expired transition archives', 'cleanupExpiredTransitionArchivesV2')
        .addItem('Dump structure to logs', 'dumpShamrockStructure')
        .addItem('Save structure snapshot to Drive', 'dumpShamrockStructureToDrive')
    )
    .addItem('Show menu help / data flow', 'showMenuHelp')
    .addToUi();
}

function onOpen() {
  // Menus are spreadsheet-specific: main/frontend opens do nothing, while the
  // admin/backend spreadsheet uses the installable onBackendOpen trigger below.
}

function setup() {
  runMenuAction({ label: 'Run setup', category: 'Setup & Automations', action: 'menu.setup' }, () => {
    confirmMenuAction('Run setup', 'This will ensure SHAMROCK resources, triggers, formatting, forms, and sheets exist. Continue?');
    const summary = SetupService.runSetup();
    const message = [
      'Setup completed.',
      `Spreadsheets: ${summary.spreadsheets.length}`,
      `Sheets ensured: ${summary.sheets.length}`,
      `Forms: ${summary.forms.length}`,
    ].join('\n');

    try {
      const ui = SpreadsheetApp.getUi();
      ui.alert(message);
    } catch (err) {
      Log.warn(`No UI context for alert; logging summary instead. Error: ${err}`);
      Log.info(message);
    }
  });
}

function transferToNewSemesterV2() {
  runMenuAction({ label: 'Transfer to new semester (v2)', category: 'Setup & Automations', action: 'menu.transfer_new_semester_v2' }, () => {
    TransitionService.runTransition('semester');
  });
}

function transferToNewAcademicYearV2() {
  runMenuAction({ label: 'Transfer to new academic year (v2)', category: 'Setup & Automations', action: 'menu.transfer_new_academic_year_v2' }, () => {
    TransitionService.runTransition('academic_year');
  });
}

function exportEventsCsv() {
  runMenuAction({ label: 'Export Events CSV', category: 'Imports & Exports', action: 'menu.export_events_csv', targetSheet: 'Events Backend' }, () => AdminService.exportEventsCsv());
}

function importEventsCsv() {
  runMenuAction({ label: 'Import Events CSV', category: 'Imports & Exports', action: 'menu.import_events_csv', targetSheet: 'Events Backend' }, () => {
    confirmMenuAction('Import Events CSV', 'This imports CSV rows into Events Backend and refreshes event artifacts. Continue?');
    AdminService.importEventsCsv(promptDriveFileId('Import Events CSV'));
  });
}

function exportAttendanceCsv() {
  runMenuAction({ label: 'Export Attendance CSV', category: 'Imports & Exports', action: 'menu.export_attendance_csv', targetSheet: 'Attendance Backend' }, () => AdminService.exportAttendanceCsv());
}

function importAttendanceCsv() {
  runMenuAction({ label: 'Import Attendance CSV', category: 'Imports & Exports', action: 'menu.import_attendance_csv', targetSheet: 'Attendance Backend' }, () => {
    confirmMenuAction('Import Attendance CSV', 'This imports CSV rows into Attendance Backend and refreshes attendance artifacts. Continue?');
    AdminService.importAttendanceCsv(promptDriveFileId('Import Attendance CSV'));
  });
}

function exportLeadershipCsv() {
  runMenuAction({ label: 'Export Leadership CSV', category: 'Imports & Exports', action: 'menu.export_leadership_csv', targetSheet: 'Leadership Backend' }, () => AdminService.exportLeadershipCsv());
}

function importLeadershipCsv() {
  runMenuAction({ label: 'Import Leadership CSV', category: 'Imports & Exports', action: 'menu.import_leadership_csv', targetSheet: 'Leadership Backend' }, () => {
    confirmMenuAction('Import Leadership CSV', 'This imports CSV rows into Leadership Backend and syncs the frontend. Continue?');
    AdminService.importLeadershipCsv(promptDriveFileId('Import Leadership CSV'));
  });
}

function exportCadetsCsv() {
  runMenuAction({ label: 'Export Cadets CSV', category: 'Imports & Exports', action: 'menu.export_cadets_csv', targetSheet: 'Directory Backend' }, () => AdminService.exportCadetsCsv());
}

function importCadetsCsv() {
  runMenuAction({ label: 'Import Cadets CSV', category: 'Imports & Exports', action: 'menu.import_cadets_csv', targetSheet: 'Directory Backend' }, () => {
    confirmMenuAction('Import Cadets CSV', 'This imports CSV rows into Directory Backend and syncs dependent artifacts. Continue?');
    AdminService.importCadetsCsv(promptDriveFileId('Import Cadets CSV'));
  });
}

function syncDirectoryBackendToFrontend() {
  runMenuAction({ label: 'Sync Directory', category: 'Sync & Refresh', action: 'menu.sync_directory', targetSheet: 'Directory Backend' }, () => SetupService.syncDirectoryBackendToFrontend());
}

function syncLeadershipBackendToFrontend() {
  runMenuAction({ label: 'Sync Leadership', category: 'Sync & Refresh', action: 'menu.sync_leadership', targetSheet: 'Leadership Backend' }, () => SetupService.syncLeadershipBackendToFrontend());
}

function syncDataLegendBackendToFrontend() {
  runMenuAction({ label: 'Sync Data Legend', category: 'Sync & Refresh', action: 'menu.sync_data_legend', targetSheet: 'Data Legend' }, () => SetupService.syncDataLegendBackendToFrontend());
}

function syncAllBackendToFrontend() {
  runMenuAction({ label: 'Sync all mapped tabs', category: 'Sync & Refresh', action: 'menu.sync_all_mapped' }, () => {
    confirmMenuAction('Sync all mapped tabs', 'This rewrites mapped frontend tabs from backend source data. Continue?');
    SetupService.syncAllBackendToFrontend();
  });
}

function refreshDataLegendAndFrontend() {
  runMenuAction({ label: 'Refresh Data Legend', category: 'Sync & Refresh', action: 'menu.refresh_data_legend', targetSheet: 'Data Legend' }, () => SetupService.refreshDataLegendAndFrontend());
}

function refreshEventsArtifacts() {
  runMenuAction({ label: 'Refresh Events artifacts', category: 'Sync & Refresh', action: 'menu.refresh_events_artifacts', targetSheet: 'Events Backend' }, () => SetupService.refreshEventsArtifacts());
}

function rebuildDashboard() {
  runMenuAction({ label: 'Rebuild Dashboard', category: 'Sync & Refresh', action: 'menu.rebuild_dashboard', targetSheet: 'Dashboard' }, () => SetupService.rebuildDashboard());
}

function rebuildAttendanceMatrix() {
  runMenuAction({ label: 'Rebuild Attendance Matrix', category: 'Sync & Refresh', action: 'menu.rebuild_attendance_matrix', targetSheet: 'Attendance Matrix Backend' }, () => SetupService.rebuildAttendanceMatrix());
}

function sendWeeklyMandoExcusedSummary() {
  AttendanceService.sendWeeklyMandoExcusedSummary();
}

function sendWeeklyLlabExcusedSummary() {
  AttendanceService.sendWeeklyLlabExcusedSummary();
}

function sendWeeklyUnexcusedSummary() {
  AttendanceService.fillUnexcusedAndNotify();
}

function rebuildAttendanceForm() {
  runMenuAction({ label: 'Rebuild Attendance Form', category: 'Sync & Refresh', action: 'menu.rebuild_attendance_form' }, () => {
    confirmMenuAction('Rebuild Attendance Form', 'This rebuilds the Attendance Form from current Events Backend choices. Continue?');
    SetupService.rebuildAttendanceForm();
  });
}

function reorderFrontendSheets() {
  runMenuAction({ label: 'Reorder frontend sheets', category: 'Formatting & Protections', action: 'menu.reorder_frontend_sheets' }, () => SetupService.reorderFrontendSheets());
}

function reorderBackendSheets() {
  runMenuAction({ label: 'Reorder backend sheets', category: 'Formatting & Protections', action: 'menu.reorder_backend_sheets' }, () => SetupService.reorderBackendSheets());
}

function applyFrontendFormatting() {
  runMenuAction({ label: 'Apply frontend formatting', category: 'Formatting & Protections', action: 'menu.apply_frontend_formatting' }, () => SetupService.applyFrontendFormatting());
}

function pauseAutomations() {
  runMenuAction({ label: 'Pause automations', category: 'Setup & Automations', action: 'menu.pause_automations' }, () => SetupService.pauseAutomations());
}

function resumeAutomations() {
  runMenuAction({ label: 'Resume automations', category: 'Setup & Automations', action: 'menu.resume_automations' }, () => SetupService.resumeAutomations());
}

function toggleFrontendFormatting() {
  runMenuAction({ label: 'Toggle frontend formatting', category: 'Formatting & Protections', action: 'menu.toggle_frontend_formatting' }, () => SetupService.toggleFrontendFormatting());
}

function toggleFrontendColumnWidths() {
  runMenuAction({ label: 'Toggle column width formatting', category: 'Formatting & Protections', action: 'menu.toggle_column_widths' }, () => SetupService.toggleFrontendColumnWidths());
}

function reapplyFrontendProtections() {
  runMenuAction({ label: 'Reapply frontend protections', category: 'Formatting & Protections', action: 'menu.reapply_frontend_protections' }, () => SetupService.reapplyFrontendProtections());
}

function archiveCoreSheets() {
  runMenuAction({ label: 'Archive core sheets', category: 'Maintenance', action: 'menu.archive_core_sheets' }, () => {
    confirmMenuAction('Archive core sheets', 'This archives selected core sheets before rebuilding or restoring data. Continue?');
    SetupService.archiveCoreSheets();
  });
}

function restoreCoreSheetsFromArchive() {
  runMenuAction({ label: 'Restore core sheets', category: 'Maintenance', action: 'menu.restore_core_sheets' }, () => {
    confirmMenuAction('Restore core sheets', 'This restores selected core sheets from archive copies. Continue?');
    SetupService.restoreCoreSheetsFromArchive();
  });
}

function refreshExcusalsForm() {
  runMenuAction({ label: 'Refresh Excusals Form choices', category: 'Sync & Refresh', action: 'menu.refresh_excusals_form' }, () => SetupService.refreshExcusalsForm());
}

function debugAttendanceResponseSheet() {
  runMenuAction({ label: 'Debug Attendance response columns', category: 'Attendance', action: 'menu.debug_attendance_response_sheet', targetSheet: Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET }, () => {
    const headers = SetupService.debugAttendanceResponseSheet();
    SpreadsheetApp.getUi().alert(`Found ${headers.length} columns in Attendance Response Sheet. Check logs for details.`);
  });
}

function setupExcusalsManagementSpreadsheet() {
  runMenuAction({ label: 'Setup Excusals management spreadsheet', category: 'Excusals', action: 'menu.setup_excusals_management' }, () => {
    confirmMenuAction('Setup Excusals management spreadsheet', 'This ensures the management spreadsheet exists, is formatted, shared, and protected. Continue?');
    const managementId = ExcusalsService.ensureManagementSpreadsheet();
    ExcusalsService.shareAndProtectManagementSpreadsheet();
    const url = `https://docs.google.com/spreadsheets/d/${managementId}`;
    SpreadsheetApp.getUi().alert(`Excusals management spreadsheet ready and shared:\n${url}`);
  });
}

function shareExcusalsManagementSpreadsheet() {
  runMenuAction({ label: 'Share Excusals management spreadsheet', category: 'Excusals', action: 'menu.share_excusals_management' }, () => {
    ExcusalsService.shareAndProtectManagementSpreadsheet();
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    const url = managementId ? `https://docs.google.com/spreadsheets/d/${managementId}` : 'N/A';
    SpreadsheetApp.getUi().alert(`Excusals management spreadsheet shared with commanders and protected:\n${url}`);
  });
}

function reinitializeExcusalsManagementSheets() {
  runMenuAction({ label: 'Reinitialize Excusals management sheets', category: 'Excusals', action: 'menu.reinitialize_excusals_management' }, () => {
    confirmMenuAction('Reinitialize Excusals management sheets', 'This refreshes the management spreadsheet structure and protections. Continue?');
    ExcusalsService.ensureManagementSpreadsheet();
    ExcusalsService.shareAndProtectManagementSpreadsheet();
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    const url = managementId ? `https://docs.google.com/spreadsheets/d/${managementId}` : 'N/A';
    SpreadsheetApp.getUi().alert(`Excusals management sheets reinitialized and protected:\n${url}`);
  });
}

function debugExcusalsResponseColumnsVerbose() {
  runMenuAction({ label: 'Debug Excusals response columns', category: 'Excusals', action: 'menu.debug_excusals_response_columns', targetSheet: Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET }, () => SetupService.debugExcusalsResponseColumnsVerbose());
}

function reinstallAllTriggers() {
  runMenuAction({ label: 'Reinstall triggers', category: 'Setup & Automations', action: 'menu.reinstall_triggers' }, () => {
    confirmMenuAction('Reinstall triggers', 'This deletes and recreates SHAMROCK installable triggers. Continue?');
    SetupService.reinstallAllTriggers();
  });
}

function addLeadershipEntry() {
  runMenuAction({ label: 'Add Leadership entry', category: 'Leadership & Directory', action: 'menu.add_leadership_entry', targetSheet: 'Leadership Backend' }, () => {
    const ui = SpreadsheetApp.getUi();
    const ask = (label: string, required = false): string | null => {
      const res = ui.prompt(label, SpreadsheetApp.getUi().ButtonSet.OK_CANCEL);
      if (res.getSelectedButton() !== SpreadsheetApp.getUi().Button.OK) return null;
      const value = String(res.getResponseText() || '').trim();
      if (required && !value) return ask(label, required); // re-prompt if required and empty
      return value;
    };

    const lastName = ask('Last Name', true);
    if (lastName === null) throw new MenuActionCancelled('Leadership entry cancelled before Last Name was provided.');
    const firstName = ask('First Name', true);
    if (firstName === null) throw new MenuActionCancelled('Leadership entry cancelled before First Name was provided.');
    const rank = ask('Rank (e.g., C/Col)', true);
    if (rank === null) throw new MenuActionCancelled('Leadership entry cancelled before Rank was provided.');
    const role = ask('Role (e.g., Alpha Flight Commander, Blue Squadron Commander)', true);
    if (role === null) throw new MenuActionCancelled('Leadership entry cancelled before Role was provided.');
    const reportsTo = ask('Reports To (optional)') || '';
    const email = ask('Email', true);
    if (email === null) throw new MenuActionCancelled('Leadership entry cancelled before Email was provided.');
    const cellPhone = ask('Cell Phone (optional)') || '';
    const officePhone = ask('Office Phone (optional)') || '';
    const officeLocation = ask('Office Location (optional)') || '';

    const backendId = Config.getBackendId();
    const leadershipSheet = backendId ? SpreadsheetApp.openById(backendId).getSheetByName('Leadership Backend') : null;
    const directorySheet = backendId ? SpreadsheetApp.openById(backendId).getSheetByName('Directory Backend') : null;
    if (!leadershipSheet) {
      throw new Error('Leadership Backend sheet not found.');
    }

    if (directorySheet) {
      const directoryTable = SheetUtils.readTable(directorySheet);
      const matchIdx = directoryTable.rows.findIndex((row) => {
        const rowEmail = String(row['email'] || '').toLowerCase();
        if (email && rowEmail === email.toLowerCase()) return true;
        return String(row['last_name'] || '').toLowerCase() === lastName.toLowerCase() &&
          String(row['first_name'] || '').toLowerCase() === firstName.toLowerCase();
      });
      if (matchIdx >= 0) {
        const headers = directoryTable.headers;
        const rowNumber = matchIdx + 3;
        const setDirectory = (key: string, val: string) => {
          const idx = headers.indexOf(key);
          if (idx >= 0) directorySheet.getRange(rowNumber, idx + 1).setValue(val);
        };
        setDirectory('rank', rank);
        setDirectory('role', role);
        SetupService.refreshDirectoryArtifacts();
        ui.alert('Directory leadership fields updated and synced to frontend.');
        return;
      }
    }

    const headers = leadershipSheet.getRange(1, 1, 1, leadershipSheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const targetRow = Math.max(3, leadershipSheet.getLastRow() + 1);
    const row: string[] = Array.from({ length: headers.length }, () => '');
    const set = (key: string, val: string) => {
      const idx = headers.indexOf(key);
      if (idx >= 0) row[idx] = val;
    };

    set('last_name', lastName);
    set('first_name', firstName);
    set('rank', rank);
    set('role', role);
    set('reports_to', reportsTo);
    set('email', email);
    set('cell_phone', cellPhone);
    set('office_phone', officePhone);
    set('office_location', officeLocation);

    leadershipSheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    // Sync to frontend after adding.
    try {
      SetupService.syncLeadershipBackendToFrontend();
    } catch (err) {
      Log.warn(`Unable to sync leadership to frontend after add: ${err}`);
    }
    ui.alert('Leadership entry added and synced to frontend.');
  });
}

function fixAttendanceHeaders() {
  runMenuAction({ label: 'Fix Attendance headers', category: 'Attendance', action: 'menu.fix_attendance_headers', targetSheet: 'Attendance' }, () => {
    const frontendId = Config.getFrontendId();
    const ss = frontendId ? SpreadsheetApp.openById(frontendId) : null;
    const sheet = ss ? ss.getSheetByName('Attendance') : null;
    if (!sheet) {
      throw new Error('Attendance sheet not found in frontend.');
    }

    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) throw new Error('Attendance sheet has no columns.');
    try {
      sheet.getRange(1, 1, Math.max(1, sheet.getMaxRows()), Math.max(1, sheet.getMaxColumns())).clearDataValidations();
    } catch (err) {
      Log.warn(`Unable to clear stale attendance validations before header fix: ${err}`);
    }

    const attendanceSchema = Schemas.getTabSchema('Attendance');
    const baseLength = attendanceSchema?.machineHeaders?.length || 7;
    const headers = sheet.getRange(2, 1, 1, lastCol).getValues()[0].map((h) => String(h || ''));
    const normalizedHeaders = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));

    try {
      sheet
        .getRange(2, 1, 1, lastCol)
        .setHorizontalAlignment('left')
        .setFontWeight('bold')
        .setFontSize(10);
    } catch (err) {
      Log.warn(`Unable to format attendance display headers: ${err}`);
    }

    const findIdx = (name: string) => normalizedHeaders.findIndex((h) => h === name.toLowerCase().replace(/\s+/g, ''));
    const machineHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());
    const findMachineIdx = (name: string) => machineHeaders.findIndex((h) => h === name);
    const llabDisplayIdx = findIdx('LLAB');
    const overallDisplayIdx = findIdx('Overall');
    const llabIdx = llabDisplayIdx >= 0 ? llabDisplayIdx : findMachineIdx('llab_attendance_pct');
    const overallIdx = overallDisplayIdx >= 0 ? overallDisplayIdx : findMachineIdx('overall_attendance_pct');

    const dataRows = Math.max(1, sheet.getLastRow() - 2);
    const centerCol = (idx: number) => {
      if (idx < 0) return;
      const col = idx + 1;
      try {
        sheet.getRange(2, col, 1, 1).setHorizontalAlignment('center');
        sheet.getRange(3, col, dataRows, 1).setHorizontalAlignment('center');
      } catch (err) {
        Log.warn(`Unable to center attendance summary column ${col}: ${err}`);
      }
    };
    centerCol(llabIdx);
    centerCol(overallIdx);

    // Event columns start after the canonical Attendance base columns.
    const eventStartCol = baseLength + 1;
    if (eventStartCol <= lastCol) {
      const width = lastCol - eventStartCol + 1;
      try {
        sheet.getRange(2, eventStartCol, 1, width).setFontSize(5).setWrap(true).setHorizontalAlignment('left');
      } catch (err) {
        Log.warn(`Unable to format attendance event headers: ${err}`);
      }
    }

    const eventWidth = Math.max(0, lastCol - eventStartCol + 1);
    const eventRange = eventWidth > 0 ? sheet.getRange(3, eventStartCol, dataRows, eventWidth) : null;

    try {
      sheet.clearConditionalFormatRules();
    } catch (err) {
      Log.warn(`Unable to clear Attendance conditional formatting: ${err}`);
    }

    // Data validation + formatting for event columns.
    if (eventRange && eventWidth > 0) {
      try {
        eventRange.clearDataValidations();
        const codesRange = ss ? ss.getRangeByName('ATTENDANCE_CODES') : null;
        if (codesRange) {
          const validation = SpreadsheetApp.newDataValidation()
            .requireValueInRange(codesRange, true)
            .setAllowInvalid(false)
            .setHelpText('Select attendance code')
            .build();
          eventRange.setDataValidation(validation);
        }
      } catch (err) {
        Log.warn(`Unable to set attendance data validation: ${err}`);
      }

      try {
        eventRange.setHorizontalAlignment('center').setFontWeight('bold');
      } catch (err) {
        Log.warn(`Unable to format attendance event cells: ${err}`);
      }
    }

    SpreadsheetApp.flush();

    SpreadsheetApp.getUi().alert('Attendance headers updated.');
  });
}

function showMenuHelp() {
  runMenuAction({ label: 'Show menu help', category: 'Help', action: 'menu.show_help' }, () => SetupService.showMenuHelp());
}

// Installable onOpen for frontend spreadsheet
function onFrontendOpen() {
  // Intentionally no-op: the main/frontend spreadsheet should not show admin menus.
}

// Installable onOpen for backend spreadsheet
function onBackendOpen() {
  addShamrockMenu();
}

// Prompt-driven filler for attendance events with flexible selectors.
function fillAttendanceEventPrompt() {
  runMenuAction({ label: 'Fill Attendance event cells', category: 'Attendance', action: 'menu.fill_attendance_event', targetSheet: 'Attendance Matrix Backend' }, () => {
  const ui = SpreadsheetApp.getUi();
  const email = ((): string => {
    try {
      return Session.getActiveUser().getEmail();
    } catch {
      return '';
    }
  })();

  const parseList = (raw: string, separators: RegExp = /[,|]/): string[] =>
    raw
      .split(separators)
      .map((s) => s.trim())
      .filter(Boolean);

  const eventResp = ui.prompt(
    'Fill attendance events',
    [
      'Select events to fill.',
      'Examples:',
      ' - all',
      ' - names:TW-17 Mando|TW-17 Secondary',
      ' - starts:TW-, ends:Secondary',
      ' - contains:Secondary',
      ' - TW-18 (unprefixed tokens treated as names)',
      'Use commas or pipes to separate multiple tokens.',
    ].join('\n'),
    ui.ButtonSet.OK_CANCEL,
  );
  if (eventResp.getSelectedButton() !== ui.Button.OK) throw new MenuActionCancelled('Attendance fill cancelled before event selector was provided.');
  const eventRaw = eventResp.getResponseText().trim();
  if (!eventRaw) {
    throw new Error('An event selector is required.');
  }

  const eventSelector = (() => {
    const selector = { names: [] as string[], startsWith: [] as string[], endsWith: [] as string[], contains: [] as string[], all: false };
    const tokens = eventRaw.split(/[,|;]/).map((t) => t.trim()).filter(Boolean);
    tokens.forEach((tok) => {
      const tokLower = tok.toLowerCase();
      if (tokLower === 'all' || tokLower === 'all events') {
        selector.all = true;
        return;
      }
      const [keyRaw, valRaw] = tok.includes(':') ? [tok.slice(0, tok.indexOf(':')), tok.slice(tok.indexOf(':') + 1)] : ['names', tok];
      const key = keyRaw.trim().toLowerCase();
      const val = valRaw.trim();
      if (!val && key !== 'all') return;
      if (key === 'all') selector.all = true;
      else if (key === 'names' || key === 'name') selector.names.push(...parseList(val));
      else if (key === 'starts' || key === 'starts_with') selector.startsWith.push(...parseList(val));
      else if (key === 'ends' || key === 'ends_with') selector.endsWith.push(...parseList(val));
      else if (key === 'contains') selector.contains.push(...parseList(val));
      else selector.names.push(...parseList(tok)); // fallback as name token
    });
    if (!selector.all && !selector.names.length && !selector.startsWith.length && !selector.endsWith.length && !selector.contains.length) {
      selector.names.push(eventRaw);
    }
    return selector;
  })();

  const cadetResp = ui.prompt(
    'Target cadets',
    [
      'Select cadets (union of criteria). Leave blank for all.',
      'Examples:',
      ' - all',
      ' - cadet:Doe, Jane|Smith, John',
      ' - flight:Alpha|Bravo',
      ' - university:Trine',
      ' - as_year:AS300',
      ' - abroad',
      'Combine with commas or pipes for multiple criteria.',
    ].join('\n'),
    ui.ButtonSet.OK_CANCEL,
  );
  if (cadetResp.getSelectedButton() !== ui.Button.OK) throw new MenuActionCancelled('Attendance fill cancelled before cadet selector was provided.');
  const cadetRaw = cadetResp.getResponseText().trim();

  const cadetSelector = (() => {
    const selector = { cadets: [] as string[], flights: [] as string[], universities: [] as string[], asYears: [] as string[], includeAbroad: false };
    if (!cadetRaw || cadetRaw.toLowerCase() === 'all') return selector;
    let tokens = cadetRaw.split(';').map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 1) tokens = cadetRaw.split('|').map((t) => t.trim()).filter(Boolean);
    if (!tokens.length) tokens = [cadetRaw];
    tokens.forEach((tok) => {
      const [keyRaw, valRaw] = tok.includes(':') ? [tok.slice(0, tok.indexOf(':')), tok.slice(tok.indexOf(':') + 1)] : ['cadet', tok];
      const key = keyRaw.trim().toLowerCase();
      const val = valRaw.trim();
      if (!val && key !== 'abroad') return;
      if (key === 'abroad') selector.includeAbroad = true;
      else if (key === 'cadet' || key === 'name') selector.cadets.push(...parseList(val, /[|;]/));
      else if (key === 'flight') selector.flights.push(...parseList(val));
      else if (key === 'university' || key === 'uni') selector.universities.push(...parseList(val));
      else if (key === 'as_year' || key === 'asyear' || key === 'as') selector.asYears.push(...parseList(val));
      else selector.cadets.push(...parseList(tok));
    });
    return selector;
  })();

  const codeResp = ui.prompt('Attendance code', 'Enter attendance code to set (e.g., P, T, A, R, D, U, E, ES, MED, N/A):', ui.ButtonSet.OK_CANCEL);
  if (codeResp.getSelectedButton() !== ui.Button.OK) throw new MenuActionCancelled('Attendance fill cancelled before attendance code was provided.');
  const code = codeResp.getResponseText().trim();
  if (!code) {
    throw new Error('Attendance code is required.');
  }

  const filled = AttendanceService.fillEventColumn({ eventSelector, code, cadetSelector, actorEmail: email, actorRole: 'menu_bulk_fill' });
  ui.alert(`Filled ${filled} cadet-event cells with code '${code}'.`);
  });
}

// Installable onEdit for Excusals Management spreadsheet: mirror decisions back to backend + attendance
function onExcusalsManagementEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
  ExcusalsService.handleExcusalsManagementEdit(e);
}

// Installable onEdit for frontend spreadsheet: mirror allowed Directory edits back to backend with audit + propagation.
function onFrontendEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
  const sheet = e?.range?.getSheet();
  const range = e?.range;
  if (sheet && range) {
    const sheetName = sheet.getName();
    const notation = range.getA1Notation();
    const newVal = String((e as any)?.value ?? range.getValue() ?? '').substring(0, 50);
    Log.info(`[Frontend] ${sheetName} ${notation} -> "${newVal}"`);
  }
  FrontendEditService.onEdit(e);
}

// Installable onEdit for backend spreadsheet: resync directory when backend changes, handle excusals decisions.
function onBackendEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
  if (PauseService.isPaused()) {
    Log.info('Automation paused; skipping onBackendEdit processing.');
    return;
  }

  try {
    const sheet = e?.range?.getSheet();
    if (!sheet) return;
    const sheetName = sheet.getName();
    const col = e?.range?.getColumn() || 0;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const header = headers[col - 1] || '';

    // Handle Excusals Backend edits (decision workflow) early and return
    if (sheetName === 'Excusals Backend') {
      ExcusalsService.handleExcusalsBackendEdit(e);
      return;
    }

    const range = e?.range;
    if (range) {
      const notation = range.getA1Notation();
      const oldVal = String((e as any)?.oldValue ?? '').substring(0, 50);
      const newVal = String((e as any)?.value ?? range.getValue() ?? '').substring(0, 50);
      Log.info(`[Backend] ${sheetName} ${notation}: "${oldVal}" -> "${newVal}"`);
    }
    try {
      const backendId = Config.getBackendId();
      if (backendId) {
        const row = e?.range?.getRow() || 0;
        const rowValues = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
        const normalize = (v: any) => String(v || '').toLowerCase();
        let targetKey = `${sheetName}!R${row}C${col}`;
        if (sheetName === 'Directory Backend') {
          const emailIdx = headers.indexOf('email');
          const lastIdx = headers.indexOf('last_name');
          const firstIdx = headers.indexOf('first_name');
          const email = emailIdx >= 0 ? normalize(rowValues[emailIdx]) : '';
          const last = lastIdx >= 0 ? normalize(rowValues[lastIdx]) : '';
          const first = firstIdx >= 0 ? normalize(rowValues[firstIdx]) : '';
          targetKey = email || (last && first ? `${last},${first}` : targetKey);
        }

        const oldValue = String((e as any)?.oldValue ?? '');
        const newValue = String((e as any)?.value ?? e?.range?.getValue() ?? '');

        FrontendEditService.logAuditEntry({
          backendId,
          targetRange: `${sheetName}!${e?.range?.getA1Notation() || ''}`,
          targetKey,
          header,
          oldValue,
          newValue,
          targetSheet: sheetName,
          targetTable: sheetName.toLowerCase().replace(/\s+/g, '_'),
          role: 'backend_editor',
          source: 'onBackendEdit',
        });
        Log.info(`[Backend] ${targetKey} ${header} changed: \"${oldValue}\" -> \"${newValue}\"`);
      }
    } catch (err) {
      Log.warn(`Backend audit logging failed: ${err}`);
    }

    if (sheetName === 'Directory Backend') {
      SetupService.refreshDirectoryArtifacts({
        rebuildAttendanceMatrix: DirectoryService.shouldRebuildAttendanceMatrixForField(header),
        rebuildAttendanceForm: DirectoryService.shouldRebuildAttendanceFormForField(header),
      });
      return;
    }

    if (sheetName === 'Data Legend') {
      SyncService.syncByBackendSheetName('Data Legend');
      SetupService.applyFrontendFormatting();
      return;
    }

    if (sheetName === 'Events Backend') {
      SetupService.refreshEventsArtifacts();
      return;
    }

    if (sheetName === 'Attendance Backend') {
      SetupService.rebuildAttendanceMatrix();
      SetupService.applyAttendanceBackendFormattingPublic();
      return;
    }

    // Sync other mapped tables when edited.
    SyncService.syncByBackendSheetName(sheetName);
  } catch (err) {
    Log.warn(`onBackendEdit failed: ${err}`);
  }
}

// Debug helper: logs current sheet headers, sizes, and form destinations.
function dumpShamrockStructure() {
  runMenuAction({ label: 'Dump structure to logs', category: 'Maintenance', action: 'menu.dump_structure' }, () => Debug.dumpShamrockStructure());
}

// Debug helper: saves structure snapshot to Drive as JSON and logs the file ID.
function dumpShamrockStructureToDrive() {
  runMenuAction({ label: 'Save structure snapshot to Drive', category: 'Maintenance', action: 'menu.dump_structure_to_drive' }, () => Debug.dumpShamrockStructureToDrive());
}

function cleanupScriptProperties() {
  runMenuAction({ label: 'Clean up script properties', category: 'Maintenance', action: 'menu.cleanup_script_properties' }, () => {
    const lines = Config.SCRIPT_PROPERTY_HELP.map((entry) => `${entry.key}: ${entry.description}`);
    Log.info(`Current SHAMROCK script properties:\n${lines.join('\n')}`);
    try {
      SpreadsheetApp.getUi().alert(`Script properties cleaned up.\n\nCurrent supported properties:\n${lines.join('\n')}`);
    } catch {
      // Running from clasp or the script editor may not have a spreadsheet UI.
    }
  });
}

function cleanupExpiredTransitionArchivesV2() {
  runMenuAction({ label: 'Cleanup expired transition archives', category: 'Maintenance', action: 'menu.cleanup_transition_archives_v2' }, () => {
    TransitionService.cleanupExpiredBackendArchives();
  });
}

// Form triggers
function onDirectoryFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
  FormHandlers.onDirectoryFormSubmit(e);
}

// Debug: replay the latest Directory form response through the handler.
function replayLatestDirectoryFormResponse() {
  runMenuAction({ label: 'Replay latest Directory form response', category: 'Leadership & Directory', action: 'menu.replay_latest_directory_response', targetSheet: Config.RESOURCE_NAMES.DIRECTORY_FORM_SHEET }, () => {
    confirmMenuAction('Replay latest Directory form response', 'This reprocesses the latest Directory Form response through the form handler. Continue?');
    const ok = DirectoryService.replayLatestDirectoryFormResponse();
    SpreadsheetApp.getUi().alert(ok ? 'Replayed latest Directory form response.' : 'No Directory form response replayed.');
  });
}

function onAttendanceFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
  FormHandlers.onAttendanceFormSubmit(e);
}

function onExcusalsFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
  FormHandlers.onExcusalsFormSubmit(e);
}

/**
 * Utility: add deputy flight commanders to Leadership Backend.
 * Supply entries at runtime so source control never stores cadet names.
 */
function addDeputyFlightCommanders() {
  runMenuAction({ label: 'Add Deputy Flight Commanders', category: 'Leadership & Directory', action: 'menu.add_deputy_flight_commanders', targetSheet: 'Leadership Backend' }, () => {
  confirmMenuAction('Add Deputy Flight Commanders', 'This adds missing deputy flight commander rows to Leadership Backend and syncs the frontend. Continue?');
  const ui = SpreadsheetApp.getUi();
  const backendId = Config.getBackendId();
  if (!backendId) {
    throw new Error('Backend spreadsheet not found.');
  }

  const directorySheet = SheetUtils.getSheet(backendId, 'Directory Backend');
  if (!directorySheet) {
    throw new Error('Directory Backend sheet not found.');
  }

  const deputyResp = ui.prompt(
    'Deputy flight commanders',
    [
      'Enter deputies as First, Last, Flight[, Rank].',
      'Separate multiple deputies with semicolons or new lines.',
      'Example: Jane, Doe, Alpha, C/1st Lt',
    ].join('\n'),
    ui.ButtonSet.OK_CANCEL,
  );
  if (deputyResp.getSelectedButton() !== ui.Button.OK) {
    throw new MenuActionCancelled('Add deputy flight commanders cancelled before deputies were provided.');
  }

  const deputies = deputyResp.getResponseText()
    .split(/\r?\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [firstRaw, lastRaw, flightRaw, rankRaw] = entry.split(',').map((part) => part.trim());
      if (!firstRaw || !lastRaw || !flightRaw) {
        throw new Error(`Deputy entry must be First, Last, Flight[, Rank]: ${entry}`);
      }
      return {
        first: firstRaw,
        last: lastRaw,
        flight: flightRaw,
        rank: rankRaw || 'C/1st Lt',
      };
    });

  if (!deputies.length) {
    throw new Error('At least one deputy entry is required.');
  }

  const directoryTable = SheetUtils.readTable(directorySheet);
  const directoryHeaders = directoryTable.headers;

  const results: string[] = [];
  let added = 0;

  for (const dep of deputies) {
    const matchIdx = directoryTable.rows.findIndex((r) => {
      const rLast = String(r['last_name'] || '').toLowerCase().trim();
      const rFirst = String(r['first_name'] || '').toLowerCase().trim();
      return rLast === dep.last.toLowerCase() && rFirst === dep.first.toLowerCase();
    });
    const cadet = matchIdx >= 0 ? directoryTable.rows[matchIdx] : null;

    const role = `${dep.flight} Deputy Flight Commander`;
    if (!cadet) {
      results.push(`${dep.first} ${dep.last}: not found in Directory, skipped`);
      continue;
    }

    const rowNumber = matchIdx + 3;
    const set = (header: string, val: string) => {
      const idx = directoryHeaders.indexOf(header);
      if (idx >= 0) directorySheet.getRange(rowNumber, idx + 1).setValue(val);
    };

    set('rank', dep.rank);
    set('role', role);
    added++;
    results.push(`${dep.first} ${dep.last}: set as ${role}${cadet['email'] ? ` (${cadet['email']})` : ''}`);
  }

  // Sync to frontend
  try {
    SetupService.refreshDirectoryArtifacts({ rebuildAttendanceMatrix: true, rebuildAttendanceForm: true });
  } catch (err) {
    Log.warn(`Unable to sync leadership to frontend after deputy update: ${err}`);
  }

  ui.alert(`Deputy Flight Commanders: ${added} updated\n\n${results.join('\n')}`);
  });
}

// Time-based trigger: reconcile frontend Directory edits to backend (handles edits by unauthorized users).
function reconcilePendingDirectoryEdits() {
  if (PauseService.isPaused()) {
    Log.info('Automation paused; skipping Directory reconciliation.');
    return;
  }
  try {
    const result = FrontendEditService.reconcilePendingDirectoryEdits();
    if (result.updated > 0) {
      Log.info(`Reconciled ${result.updated} Directory edits from frontend to backend`);
      // After reconciling, sync backend -> frontend and rebuild attendance
      SyncService.syncByBackendSheetName('Directory');
      AttendanceService.rebuildMatrix();
    }
    if (result.missing > 0) {
      Log.warn(`${result.missing} frontend Directory rows not found in backend`);
    }
  } catch (err) {
    Log.warn(`reconcilePendingDirectoryEdits failed: ${err}`);
  }
}
