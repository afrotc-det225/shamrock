// Excusals processing service: handle notifications, decisions, and management panel.

namespace ExcusalsService {
  const DECISION_VALUES = ['Approved', 'Denied', 'Withdrawn', 'Superseded'];
  const TERMINAL_RESTORE_DECISIONS = new Set(['Withdrawn', 'Superseded']);
  const REQUESTED_OUTCOMES = new Set(['P', 'T', 'E', 'ES', 'MED']);
  const ATTENDANCE_CODES = new Set(['P', 'T', 'A', 'R', 'D', 'U', 'E', 'ES', 'MED', 'N/A', '']);

  function canonicalFlightLeadershipRoles(): Set<string> {
    const roles = new Set<string>();
    Arrays.FLIGHTS.forEach((flight) => {
      roles.add(`${flight} Flight Commander`.toLowerCase());
      roles.add(`${flight} Deputy Flight Commander`.toLowerCase());
    });
    return roles;
  }

  function normalizeRequestedOutcome(raw: any): string {
    const value = String(raw || '').trim().toUpperCase();
    return REQUESTED_OUTCOMES.has(value) ? value : 'E';
  }

  function normalizeAttendanceCode(raw: any): string {
    const value = String(raw || '').trim().toUpperCase();
    return ATTENDANCE_CODES.has(value) ? value : '';
  }

  function eventHasStarted(eventName: string): boolean {
    const backendId = Config.getBackendId();
    if (!backendId || !eventName) return true;
    const eventsSheet = SheetUtils.getSheet(backendId, 'Events Backend');
    if (!eventsSheet) return true;
    const table = SheetUtils.readTable(eventsSheet);
    const target = eventName.trim();
    const match = table.rows.find((row) => {
      const name = String(row['display_name'] || row['attendance_column_label'] || row['event_id'] || '').trim();
      return name === target;
    });
    if (!match || !match['start_datetime']) return true;
    const start = new Date(match['start_datetime']);
    if (Number.isNaN(start.getTime())) return true;
    return start.getTime() <= Date.now();
  }

  function effectForDecision(opts: {
    decision: string;
    requestedOutcome: string;
    priorAttendanceCode: string;
    currentAttendanceCode?: string;
    eventName: string;
  }): string {
    const prior = normalizeAttendanceCode(opts.priorAttendanceCode);
    if (opts.decision === 'Approved') return normalizeRequestedOutcome(opts.requestedOutcome);
    if (opts.decision === 'Denied') {
      const current = normalizeAttendanceCode(opts.currentAttendanceCode);
      if (current === 'P' || current === 'T') return current;
      if (prior === 'P' || prior === 'T') return prior;
      if (prior === 'A' || prior === 'U') return 'U';
      return eventHasStarted(opts.eventName) ? 'U' : 'D';
    }
    if (TERMINAL_RESTORE_DECISIONS.has(opts.decision)) {
      return prior === 'R' || prior === 'D' ? '' : prior;
    }
    return 'R';
  }

  function currentUserEmail(): string {
    try {
      const active = Session.getActiveUser().getEmail();
      if (active) return active;
    } catch (err) {
      Log.warn(`Unable to read active user email: ${err}`);
    }
    return '';
  }

  /**
   * Send notification email to squadron commander when new excusal submitted.
   */
  export function notifySquadronCommanderOfNewExcusal(excusalRow: Record<string, any>) {
    const squadron = String(excusalRow['squadron'] || '').trim();
    if (!squadron) {
      Log.warn('Cannot notify: excusal has no squadron');
      return;
    }

    const commanderEmail = getSquadronCommanderEmail(squadron);
    if (!commanderEmail) {
      Log.warn(`Cannot notify: no squadron commander email found for ${squadron}`);
      return;
    }

    const lastName = String(excusalRow['last_name'] || '');
    const firstName = String(excusalRow['first_name'] || '');
    const cadetEmail = String(excusalRow['email'] || '');
    const event = String(excusalRow['event'] || '');
    const reason = String(excusalRow['reason'] || '');
    const submittedAt = excusalRow['submitted_at'] ? new Date(excusalRow['submitted_at']) : new Date();

    // Determine time of day
    const hours = submittedAt.getHours();
    const timeOfDay = hours < 12 ? 'Good morning' : hours < 18 ? 'Good afternoon' : 'Good evening';

    // Get commander name
    const commander = lookupLeadershipByEmail(commanderEmail);
    const commanderLastName = String(commander?.last_name || 'Commander').trim();

    const managementSheetUrl = getManagementSpreadsheetUrl();

    const subject = `New Excusal Request Submitted: ${lastName}, ${firstName} – ${event}`;
    const body = `${timeOfDay} C/${commanderLastName},

You have received a new excusal request from Cadet ${firstName} ${lastName}.

Details:
• Cadet: ${lastName}, ${firstName} (${cadetEmail})
• Event: ${event}
• Reason: ${reason}

Review & take action here:
${managementSheetUrl}

Very respectfully,
SHAMROCK Automations`;

    try {
      GmailApp.sendEmail(commanderEmail, subject, body, {
        name: 'SHAMROCK Automations',
        replyTo: cadetEmail,
        cc: cadetEmail,
      });
      Log.info(`Excusal notification sent to ${commanderEmail} for ${lastName}, ${firstName}`);
    } catch (err) {
      Log.warn(`Failed to send excusal notification to ${commanderEmail}: ${err}`);
    }
  }

  /**
   * Update attendance matrix when excusal is submitted.
   * Any request in review is shown as R. The original value is stored on the
   * excusal row as prior_attendance_code and used when the request is denied,
   * withdrawn, or superseded.
   */
  export function updateAttendanceOnExcusalSubmission(excusalRow: Record<string, any>) {
    const backendId = Config.getBackendId();
    if (!backendId) return;

    const lastName = String(excusalRow['last_name'] || '').trim();
    const firstName = String(excusalRow['first_name'] || '').trim();
    const eventName = String(excusalRow['event'] || '').trim();

    if (!lastName || !firstName || !eventName) return;

    const logEntry = {
      submission_id: `excusal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      submitted_at: new Date(),
      event: eventName,
      attendance_type: 'R',
      email: excusalRow['email'] || '',
      name: 'Excusal Request',
      flight: excusalRow['flight'] || '',
      cadets: `${lastName}, ${firstName}`,
    };

    appendAttendanceLogs([logEntry]);
    AttendanceService.applyAttendanceLogEntry(logEntry);
  }

  /**
   * Get squadron commander email by squadron name.
   */
  function getSquadronCommanderEmail(squadron: string): string {
    const backendId = Config.getBackendId();
    if (!backendId) return '';

    const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!leadershipSheet) return '';

    const table = SheetUtils.readTable(leadershipSheet);
    const squadronNormalized = squadron.toLowerCase().trim();

    if (!Arrays.OPERATIONAL_SQUADRONS.some((value) => value.toLowerCase() === squadronNormalized)) {
      return '';
    }

    const commander = table.rows.find((row) =>
      Arrays.getSquadronCommanderUnit(row['role']).toLowerCase() === squadronNormalized,
    );

    return commander ? String(commander['email'] || '') : '';
  }

  /**
   * Look up leadership entry by email.
   */
  function lookupLeadershipByEmail(email: string): Record<string, any> | null {
    const backendId = Config.getBackendId();
    if (!backendId || !email) return null;

    const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!leadershipSheet) return null;

    const table = SheetUtils.readTable(leadershipSheet);
    const lower = email.toLowerCase();
    return table.rows.find((r) => String(r['email'] || '').toLowerCase() === lower) || null;
  }

  /**
   * Get or create the excusals management spreadsheet.
   */
  export function ensureManagementSpreadsheet(): string {
    const existingId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);

    if (existingId) {
      try {
        const ss = SpreadsheetApp.openById(existingId);
        // Ensure squadron sheets exist and are initialized even if spreadsheet already exists.
        const squadrons = Arrays.OPERATIONAL_SQUADRONS;
        squadrons.forEach((squadron) => {
          let sheet = ss.getSheetByName(squadron);
          if (!sheet) {
            sheet = ss.insertSheet(squadron);
          }
          initializeSquadronManagementSheet(sheet, squadron);
        });
        return existingId;
      } catch (err) {
        Log.warn(`Stored management spreadsheet ID invalid; creating new. Error: ${err}`);
      }
    }

    // Create new management spreadsheet
    const ss = SpreadsheetApp.create('SHAMROCK Excusals Management');
    const newId = ss.getId();
    Config.setScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID, newId);
    Log.info(`Created excusals management spreadsheet: ${newId}`);

    // Create squadron sheets first (before deleting default)
    // Use squadrons from canonical Arrays, excluding 'Abroad'
    const squadrons = Arrays.OPERATIONAL_SQUADRONS;
    squadrons.forEach((squadron) => {
      const sheet = ss.insertSheet(squadron);
      initializeSquadronManagementSheet(sheet, squadron);
    });

    // Remove default sheet only after new sheets exist
    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet) ss.deleteSheet(defaultSheet);

    return newId;
  }

  /**
   * Initialize a squadron management sheet with headers and structure.
   */
  function initializeSquadronManagementSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet, squadron: string) {
    const schema = Schemas.EXCUSALS_MANAGEMENT_SCHEMA;
    const machineHeaders = schema.machineHeaders!;
    const displayHeaders = schema.displayHeaders!;
    const headerWidth = machineHeaders.length;

    // Set machine headers in row 1
    sheet.getRange(1, 1, 1, headerWidth).setValues([machineHeaders]);
    sheet.getRange(1, 1, 1, headerWidth).setFontWeight('bold').setHorizontalAlignment('center');

    // Set display headers in row 2
    sheet.getRange(2, 1, 1, headerWidth).setValues([displayHeaders]);
    sheet.getRange(2, 1, 1, headerWidth).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#e8e8e8');

    // Hide machine headers (row 1)
    sheet.hideRows(1, 1);
    // Ensure minimal rows = 3 (2 headers + 1 blank data row)
    const lastRow = sheet.getLastRow();
    const maxRows = sheet.getMaxRows();
    const MIN_ROWS = 3;
    if (lastRow <= 2) {
      if (maxRows < MIN_ROWS) {
        sheet.insertRowsAfter(maxRows, MIN_ROWS - maxRows);
      } else if (maxRows > MIN_ROWS) {
        sheet.deleteRows(MIN_ROWS + 1, maxRows - MIN_ROWS);
      }
    }

    // Trim any extra columns beyond the schema width to keep things tidy.
    const maxCols = sheet.getMaxColumns();
    if (maxCols > headerWidth) {
      sheet.deleteColumns(headerWidth + 1, maxCols - headerWidth);
    }

    // Set column widths
    sheet.setColumnWidth(1, 150);  // timestamp
    sheet.setColumnWidth(2, 100);  // decision
    sheet.setColumnWidth(3, 150);  // event
    sheet.setColumnWidth(4, 220);  // reason
    sheet.setColumnWidth(5, 100);  // requested_outcome
    sheet.setColumnWidth(6, 150);  // email
    sheet.setColumnWidth(7, 100);  // last_name
    sheet.setColumnWidth(8, 100);  // first_name
    sheet.setColumnWidth(9, 80);   // flight
    sheet.setColumnWidth(10, 120); // request_id

    // Requested outcome is a short code and is displayed as the operator-facing Type.
    sheet.getRange(3, 5, Math.max(1, sheet.getMaxRows() - 2), 1).setHorizontalAlignment('center');

    // Freeze first two rows (machine headers + display headers)
    sheet.setFrozenRows(2);

    // Add data validation for Decision column (col 2, starting at row 3 since row 2 is frozen)
    const decisionRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(DECISION_VALUES)
      .setAllowInvalid(false)
      .setHelpText('Select Approved, Denied, Withdrawn, or Superseded')
      .build();
    sheet.getRange('B3:B').setDataValidation(decisionRule);

    Log.info(`Initialized management sheet for ${squadron} squadron`);
  }

  /**
   * Sync excusal to management spreadsheet.
   */
  export function syncExcusalToManagementPanel(excusalRow: Record<string, any>) {
    const squadron = String(excusalRow['squadron'] || '').trim();
    if (!squadron) {
      Log.warn('Cannot sync excusal to management panel: no squadron');
      return;
    }

    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId) {
      Log.warn('Excusals management spreadsheet not found; skipping sync');
      return;
    }

    try {
      const ss = SpreadsheetApp.openById(managementId);
      const sheet = ss.getSheetByName(squadron);
      if (!sheet) {
        Log.warn(`Sheet for squadron ${squadron} not found in management spreadsheet`);
        return;
      }

      // Ensure sheet has capacity and append after existing data (starting at row 3)
      const nextRow = Math.max(3, sheet.getLastRow() + 1);
      const maxRows = sheet.getMaxRows();
      if (nextRow > maxRows) {
        sheet.insertRowsAfter(maxRows, nextRow - maxRows);
      }

      // Ensure columns match current schema (handles legacy sheets created before Reason column was added)
      const maxCols = sheet.getMaxColumns();
      const requiredCols = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders!.length;
      if (maxCols < requiredCols) {
        sheet.insertColumnsAfter(maxCols, requiredCols - maxCols);
      }

      // Refresh headers to match schema (machine headers row 1, display headers row 2)
      const machineHeaders = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders!;
      const displayHeaders = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.displayHeaders!;
      sheet.getRange(1, 1, 1, machineHeaders.length).setValues([machineHeaders]);
      sheet.getRange(2, 1, 1, displayHeaders.length).setValues([displayHeaders]);

      const rowData = [
        excusalRow['submitted_at'] || '',
        '', // Decision column starts empty
        excusalRow['event'] || '',
        excusalRow['reason'] || '',
        excusalRow['requested_outcome'] || '',
        excusalRow['email'] || '',
        excusalRow['last_name'] || '',
        excusalRow['first_name'] || '',
        excusalRow['flight'] || '',
        excusalRow['request_id'] || '',
      ];

      sheet.getRange(nextRow, 1, 1, rowData.length).setValues([rowData]);
      const typeColumn = machineHeaders.indexOf('requested_outcome') + 1;
      if (typeColumn > 0) sheet.getRange(nextRow, typeColumn).setHorizontalAlignment('center');

      // Trim extra rows and columns, then sort by Timestamp (descending)
      trimAndSortManagementSheet(sheet);

      // Reapply protections so new rows remain covered
      applyManagementSheetProtections(ss);

      Log.info(`Synced excusal ${excusalRow['request_id']} to ${squadron} management sheet`);
    } catch (err) {
      Log.warn(`Failed to sync excusal to management panel: ${err}`);
    }
  }

  function mirrorDecisionToManagementPanel(requestId: string, decision: string) {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId || !requestId) return;
    try {
      const ss = SpreadsheetApp.openById(managementId);
      const headers = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || [];
      const requestIdx = headers.indexOf('request_id');
      const decisionIdx = headers.indexOf('decision');
      if (requestIdx < 0 || decisionIdx < 0) return;

      ss.getSheets()
        .filter((sheet) => Arrays.OPERATIONAL_SQUADRONS.includes(sheet.getName()))
        .forEach((sheet) => {
          const lastRow = sheet.getLastRow();
          if (lastRow < 3) return;
          const values = sheet.getRange(3, 1, lastRow - 2, headers.length).getValues();
          for (let i = 0; i < values.length; i++) {
            if (String(values[i][requestIdx] || '').trim() !== requestId) continue;
            sheet.getRange(i + 3, decisionIdx + 1).setValue(decision);
            return;
          }
        });
    } catch (err) {
      Log.warn(`Failed to mirror backend decision ${requestId} to management panel: ${err}`);
    }
  }

  /**
   * Remove junk rows from Excusals Backend and Management sheets where the event
   * is a navigation artifact (e.g. "Done selecting events") rather than a real event.
   */
  export function purgeJunkExcusalRows() {
    const JUNK_EVENTS = new Set(['Done selecting events', '(no events)']);
    let backendPurged = 0;
    let managementPurged = 0;

    // 1. Clean up Excusals Backend
    try {
      const backendSheet = Config.getBackendSheet('Excusals Backend');
      if (backendSheet) {
        const table = SheetUtils.readTable(backendSheet);
        const eventColIdx = table.headers.indexOf('event');
        if (eventColIdx >= 0) {
          // Walk rows bottom-up so deletion indices stay stable
          const allValues = backendSheet.getDataRange().getValues();
          for (let i = allValues.length - 1; i >= 1; i--) {
            const eventVal = String(allValues[i][eventColIdx] || '').trim();
            if (JUNK_EVENTS.has(eventVal)) {
              backendSheet.deleteRow(i + 1); // sheet rows are 1-indexed
              backendPurged++;
            }
          }
        }
      }
    } catch (err) {
      Log.warn(`purgeJunkExcusalRows: backend cleanup failed: ${err}`);
    }

    // 2. Clean up Management sheets (one per squadron)
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (managementId) {
      try {
        const ss = SpreadsheetApp.openById(managementId);
        const sheets = ss.getSheets().filter((sheet) => Arrays.OPERATIONAL_SQUADRONS.includes(sheet.getName()));
        for (const sheet of sheets) {
          const lastRow = sheet.getLastRow();
          if (lastRow < 3) continue; // headers only
          const allValues = sheet.getDataRange().getValues();
          // Event is in column 3 (index 2) per management schema
          for (let i = allValues.length - 1; i >= 2; i--) {
            const eventVal = String(allValues[i][2] || '').trim();
            if (JUNK_EVENTS.has(eventVal)) {
              sheet.deleteRow(i + 1);
              managementPurged++;
            }
          }
          trimAndSortManagementSheet(sheet);
        }
      } catch (err) {
        Log.warn(`purgeJunkExcusalRows: management cleanup failed: ${err}`);
      }
    }

    Log.info(`purgeJunkExcusalRows: removed ${backendPurged} backend rows, ${managementPurged} management rows`);
    return { backendPurged, managementPurged };
  }

  /**
   * Backpopulate requested_outcome from Excusals Backend into existing
   * Management sheet rows. Also refreshes management sheet headers to match
   * the current schema (adds any new columns).
   */
  /**
   * Fill empty requested_outcome cells in Excusals Backend by matching rows
   * to the Excusals Form Responses sheet (by email + submitted_at timestamp).
   */
  function backfillBackendRequestedOutcome(backendSheet: GoogleAppsScript.Spreadsheet.Sheet) {
    let formSheet: GoogleAppsScript.Spreadsheet.Sheet;
    try {
      formSheet = Config.getBackendSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
    } catch (err) {
      Log.warn(`Excusals Form Responses not found; skipping backend backfill: ${err}`);
      return;
    }

    const formLastCol = formSheet.getLastColumn();
    const formLastRow = formSheet.getLastRow();
    if (formLastCol === 0 || formLastRow < 2) return;

    const formHeaders = formSheet.getRange(1, 1, 1, formLastCol).getValues()[0].map((h) => String(h || '').trim());
    const formEmailIdx = formHeaders.findIndex((h) => h.toLowerCase().startsWith('email'));
    const formTsIdx = formHeaders.indexOf('Timestamp');
    const formReqTypeIdx = formHeaders.indexOf('Requested Outcome');

    if (formEmailIdx < 0 || formTsIdx < 0 || formReqTypeIdx < 0) {
      Log.warn('Excusals Form Responses missing required v2 columns for backfill');
      return;
    }

    // Build lookup: email|timestamp -> requested_outcome from form responses.
    const formData = formSheet.getRange(2, 1, formLastRow - 1, formLastCol).getValues();
    const typeByKey = new Map<string, string>();
    for (const row of formData) {
      const email = String(row[formEmailIdx] || '').trim().toLowerCase();
      const ts = String(row[formTsIdx] || '').trim();
      let reqType = String(row[formReqTypeIdx] || '').trim();
      if (!email || !ts) continue;
      reqType = normalizeRequestedOutcome(reqType);
      // Normalize timestamp to ISO for matching
      let isoTs = ts;
      try { isoTs = new Date(ts).toISOString(); } catch {}
      typeByKey.set(`${email}|${isoTs}`, reqType);
    }

    if (typeByKey.size === 0) {
      Log.info('No form response requested outcomes to backfill');
      return;
    }

    // Read backend data and fill empty requested_outcome cells.
    const backendHeaders = backendSheet.getRange(1, 1, 1, backendSheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const bEmailIdx = backendHeaders.indexOf('email');
    const bTsIdx = backendHeaders.indexOf('submitted_at');
    const bReqTypeIdx = backendHeaders.indexOf('requested_outcome');
    if (bEmailIdx < 0 || bTsIdx < 0 || bReqTypeIdx < 0) return;

    const bLastRow = backendSheet.getLastRow();
    if (bLastRow < 3) return;
    const bData = backendSheet.getRange(3, 1, bLastRow - 2, backendHeaders.length).getValues();

    let filled = 0;
    for (let r = 0; r < bData.length; r++) {
      const existing = String(bData[r][bReqTypeIdx] || '').trim();
      if (existing) continue; // already has a value

      const email = String(bData[r][bEmailIdx] || '').trim().toLowerCase();
      const ts = String(bData[r][bTsIdx] || '').trim();
      if (!email || !ts) continue;

      const key = `${email}|${ts}`;
      const formType = typeByKey.get(key);
      if (formType) {
        bData[r][bReqTypeIdx] = formType;
        filled++;
      }
    }

    if (filled > 0) {
      backendSheet.getRange(3, 1, bData.length, backendHeaders.length).setValues(bData);
      Log.info(`backfillBackendRequestedOutcome: filled ${filled} rows in Excusals Backend`);
    } else {
      Log.info('backfillBackendRequestedOutcome: no empty rows matched form responses');
    }
  }

  export function backpopulateManagementRequestedOutcome() {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId) {
      Log.warn('Excusals management spreadsheet not found; cannot backpopulate');
      return { updated: 0 };
    }

    // Ensure Excusals Backend has all schema columns.
    const backendSheet = Config.getBackendSheet('Excusals Backend');
    if (!backendSheet) {
      Log.warn('Excusals Backend not found; cannot backpopulate');
      return { updated: 0 };
    }
    SheetUtils.ensureSchemaColumns(backendSheet);

    // Backfill requested_outcome in the backend from Excusals Form Responses.
    backfillBackendRequestedOutcome(backendSheet);

    // Build a lookup of request_id -> requested_outcome from Excusals Backend.
    const backendTable = SheetUtils.readTable(backendSheet);
    const typeByRequestId = new Map<string, string>();
    backendTable.rows.forEach((row) => {
      const rid = String(row['request_id'] || '').trim();
      const rtype = String(row['requested_outcome'] || '').trim();
      if (rid) typeByRequestId.set(rid, rtype);
    });

    const schema = Schemas.EXCUSALS_MANAGEMENT_SCHEMA;
    const machineHeaders = schema.machineHeaders!;
    const displayHeaders = schema.displayHeaders!;
    const reqTypeColIdx = machineHeaders.indexOf('requested_outcome');
    const requestIdColIdx = machineHeaders.indexOf('request_id');
    if (reqTypeColIdx < 0 || requestIdColIdx < 0) {
      Log.warn('Schema missing expected columns; cannot backpopulate');
      return { updated: 0 };
    }

    let totalUpdated = 0;

    try {
      const ss = SpreadsheetApp.openById(managementId);
      const sheets = ss.getSheets().filter((sheet) => Arrays.OPERATIONAL_SQUADRONS.includes(sheet.getName()));

      for (const sheet of sheets) {
        // Ensure sheet has enough columns for new schema
        const maxCols = sheet.getMaxColumns();
        if (maxCols < machineHeaders.length) {
          sheet.insertColumnsAfter(maxCols, machineHeaders.length - maxCols);
        }

        // Refresh headers to match current schema
        sheet.getRange(1, 1, 1, machineHeaders.length).setValues([machineHeaders]);
        sheet.getRange(2, 1, 1, displayHeaders.length).setValues([displayHeaders]);
        sheet
          .getRange(3, reqTypeColIdx + 1, Math.max(1, sheet.getMaxRows() - 2), 1)
          .setHorizontalAlignment('center');

        const lastRow = sheet.getLastRow();
        if (lastRow < 3) continue;

        const dataRange = sheet.getRange(3, 1, lastRow - 2, machineHeaders.length);
        const data = dataRange.getValues();
        let sheetUpdated = 0;

        // Fill in requested_outcome from backend data.
        for (let r = 0; r < data.length; r++) {
          const requestId = String(data[r][requestIdColIdx] || '').trim();
          if (!requestId) continue;

          const currentVal = String(data[r][reqTypeColIdx] || '').trim();
          const backendVal = typeByRequestId.get(requestId) || '';
          if (!currentVal && backendVal) {
            data[r][reqTypeColIdx] = backendVal;
            sheetUpdated++;
          }
        }

        if (sheetUpdated > 0) {
          dataRange.setValues(data);
          totalUpdated += sheetUpdated;
        }

        trimAndSortManagementSheet(sheet);
      }
    } catch (err) {
      Log.warn(`backpopulateManagementRequestedOutcome failed: ${err}`);
    }

    Log.info(`backpopulateManagementRequestedOutcome: updated ${totalUpdated} management rows`);
    return { updated: totalUpdated };
  }

  /**
   * Trim empty rows and columns from management sheet, sort by Timestamp descending.
   */
  function trimAndSortManagementSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const maxRows = sheet.getMaxRows();
    const maxCols = sheet.getMaxColumns();
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();

    // Only sort and trim if there's any rows present
    if (lastRow >= 2) {
      const dataRange = sheet.getRange(1, 1, lastRow, lastColumn);
      const values = dataRange.getValues();

      // Preserve first two rows (machine + display headers)
      const headerRows = values.slice(0, 2);
      const dataRows = values.slice(2);

      // Sort data rows by timestamp descending (col 1)
      dataRows.sort((a: any[], b: any[]) => {
        const timeA = new Date(a[0] || '').getTime();
        const timeB = new Date(b[0] || '').getTime();
        return timeB - timeA; // Descending (latest first)
      });

      const sortedValues = [...headerRows, ...dataRows];
      dataRange.setValues(sortedValues);

      // Delete extra rows beyond data, but keep minimum of 3 total rows
      const MIN_ROWS = 3;
      const targetRows = Math.max(lastRow, MIN_ROWS);
      if (maxRows > targetRows) {
        sheet.deleteRows(targetRows + 1, maxRows - targetRows);
      } else if (maxRows < targetRows) {
        sheet.insertRowsAfter(maxRows, targetRows - maxRows);
      }
    }

    // Delete extra columns beyond data
    if (lastColumn < maxCols) {
      sheet.deleteColumns(lastColumn + 1, maxCols - lastColumn);
    }
  }

  /**
   * Get the management spreadsheet URL.
   */
  function getManagementSpreadsheetUrl(): string {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId) return '(Management panel URL unavailable)';
    return `https://docs.google.com/spreadsheets/d/${managementId}`;
  }

  /**
   * Share management spreadsheet with squadron and flight commanders, apply sheet protections.
   */
  export function shareAndProtectManagementSpreadsheet() {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId) {
      Log.warn('Excusals management spreadsheet not found; cannot share or protect');
      return;
    }

    try {
      const ss = SpreadsheetApp.openById(managementId);
      try {
        DriveApp.getFileById(managementId).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      } catch (err) {
        Log.warn(`Unable to enforce private link/domain sharing on the Excusals management workbook: ${err}`);
      }
      const backendId = Config.getBackendId();
      if (!backendId) {
        Log.warn('Cannot share management spreadsheet: backend ID missing');
        return;
      }

      // Squadron commanders are workbook editors. Flight commanders and deputies
      // are viewers so they can monitor excusals without changing decisions.
      const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
      if (!leadershipSheet) {
        Log.warn('Cannot share management spreadsheet: Leadership Backend not found');
        return;
      }

      const table = SheetUtils.readTable(leadershipSheet);
      const squadronEditorEmails = new Set<string>();
      const flightViewerEmails = new Set<string>();
      const flightRoles = canonicalFlightLeadershipRoles();
      table.rows.forEach((row) => {
        const role = String(row['role'] || '').toLowerCase().trim();
        const email = String(row['email'] || '').trim().toLowerCase();
        if (!email) return;
        if (Arrays.getSquadronCommanderUnit(role)) squadronEditorEmails.add(email);
        else if (flightRoles.has(role)) flightViewerEmails.add(email);
      });

      // An editor cannot simultaneously be a viewer.
      squadronEditorEmails.forEach((email) => flightViewerEmails.delete(email));

      const ownerEmail = (() => {
        try { return String(ss.getOwner()?.getEmail() || '').trim().toLowerCase(); } catch { return ''; }
      })();
      const intendedEditors = new Set(squadronEditorEmails);
      if (ownerEmail) intendedEditors.add(ownerEmail);

      // Remove stale role-based access before applying current Leadership state.
      ss.getEditors().forEach((user) => {
        const email = String(user.getEmail() || '').trim().toLowerCase();
        if (email && !intendedEditors.has(email)) {
          try { ss.removeEditor(email); } catch (err) { Log.warn(`Failed to remove stale management editor ${email}: ${err}`); }
        }
      });
      ss.getViewers().forEach((user) => {
        const email = String(user.getEmail() || '').trim().toLowerCase();
        if (email && !flightViewerEmails.has(email)) {
          try { ss.removeViewer(email); } catch (err) { Log.warn(`Failed to remove stale management viewer ${email}: ${err}`); }
        }
      });

      squadronEditorEmails.forEach((email) => {
        try {
          ss.addEditor(email);
        } catch (err) {
          Log.warn(`Failed to add editor ${email}: ${err}`);
        }
      });
      flightViewerEmails.forEach((email) => {
        try {
          ss.addViewer(email);
        } catch (err) {
          Log.warn(`Failed to add viewer ${email}: ${err}`);
        }
      });

      // Apply range protections: each squadron sheet editable only by its commander
      applyManagementSheetProtections(ss);

      Log.info(
        `Management access refreshed: ${squadronEditorEmails.size} squadron commander editor(s), `
        + `${flightViewerEmails.size} flight leadership viewer(s)`,
      );
    } catch (err) {
      Log.warn(`Failed to share and protect management spreadsheet: ${err}`);
    }
  }

  /**
   * Handle edits to the Excusals Backend (e.g., decision approval/denial).
   */
  export function handleExcusalsBackendEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    if (!range) return;

    const sheet = range.getSheet();
    const row = range.getRow();
    const col = range.getColumn();
    const newValue = String((e as any)?.value ?? range.getValue() ?? '').trim();

    // Get headers to find Decision column
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim().toLowerCase());
    const decisionColIdx = headers.indexOf('decision');
    const statusIdx = headers.indexOf('status');
    const decidedByIdx = headers.indexOf('decided_by');
    const decidedAtIdx = headers.indexOf('decided_at');
    const lastUpdatedIdx = headers.indexOf('last_updated_at');

    // Only process if Decision column was edited and value is a v2 workflow decision.
    if (col - 1 !== decisionColIdx || row < 3) return;
    if (!DECISION_VALUES.includes(newValue)) return;

    try {
      const backendSheet = SheetUtils.getSheet(Config.getBackendId(), 'Excusals Backend');
      if (!backendSheet) return;
      const table = SheetUtils.readTable(backendSheet);
      const rowData = table.rows[row - 3]; // data starts on sheet row 3
      if (!rowData) return;

      // The sheet row already contains the new value by the time onEdit runs.
      // Use the event's oldValue so reconsiderations are audited and messaged correctly.
      const oldDecision = String((e as any)?.oldValue ?? '').trim();
      if (oldDecision === newValue) return;
      const requestId = String(rowData['request_id'] || '').trim();
      const cadetEmail = String(rowData['email'] || '').trim();
      const eventName = String(rowData['event'] || '').trim();
      const reason = String(rowData['reason'] || '').trim();
      const squadron = String(rowData['squadron'] || '').trim();
      const firstName = String(rowData['first_name'] || '').trim();
      const lastName = String(rowData['last_name'] || '').trim();

      // Update status and decided_at in the same row
      if (statusIdx >= 0) sheet.getRange(row, statusIdx + 1).setValue(newValue);
      if (decidedByIdx >= 0) sheet.getRange(row, decidedByIdx + 1).setValue(currentUserEmail());
      if (decidedAtIdx >= 0) sheet.getRange(row, decidedAtIdx + 1).setValue(new Date().toISOString());
      if (lastUpdatedIdx >= 0) sheet.getRange(row, lastUpdatedIdx + 1).setValue(new Date().toISOString());

      const requestedOutcomeIdx = headers.indexOf('requested_outcome');
      const priorIdx = headers.indexOf('prior_attendance_code');
      const effectIdx = headers.indexOf('attendance_effect');
      const requestedOutcome = requestedOutcomeIdx >= 0 ? String(sheet.getRange(row, requestedOutcomeIdx + 1).getValue() || 'E') : 'E';
      const priorAttendanceCode = priorIdx >= 0 ? String(sheet.getRange(row, priorIdx + 1).getValue() || '') : '';
      const attendanceEffect = effectForDecision({
        decision: newValue,
        requestedOutcome,
        priorAttendanceCode,
        currentAttendanceCode: lookupMatrixValue(eventName, lastName, firstName),
        eventName,
      });
      if (effectIdx >= 0) sheet.getRange(row, effectIdx + 1).setValue(attendanceEffect);

      // Update attendance matrix based on decision
      updateAttendanceOnExcusalDecision({
        lastName,
        firstName,
        eventName,
        decision: newValue,
        requestedOutcome,
        priorAttendanceCode,
        attendanceEffect,
      });
      mirrorDecisionToManagementPanel(requestId, newValue);

      // Check if decision is being changed (not initial decision)
      const isDecisionChange = oldDecision && oldDecision !== newValue;

      // Send decision email to cadet from squadron commander
      sendExcusalDecisionEmail({
        cadetEmail,
        cadetFirstName: firstName,
        cadetLastName: lastName,
        event: eventName,
        decision: newValue,
        previousDecision: isDecisionChange ? oldDecision : undefined,
        reason,
        squadron,
      });

      Log.info(`Excusal decision recorded: row ${row} -> ${newValue}${isDecisionChange ? ` (changed from ${oldDecision})` : ''}`);
      AuditService.log({
        action: 'excusal_decision_recorded',
        result: 'ok',
        role: 'admin_operator',
        targetSheet: 'Excusals Backend',
        targetTable: 'Excusals Backend',
        targetKey: requestId,
        requestId,
        field: 'decision',
        oldValue: oldDecision,
        newValue,
        source: 'ExcusalsService.handleExcusalsBackendEdit',
        metadata: { event: eventName, squadron, attendanceEffect },
      });
    } catch (err) {
      Log.warn(`Failed to handle Excusals Backend edit: ${err}`);
      AuditService.log({
        action: 'excusal_decision_recorded',
        result: 'failed',
        role: 'admin_operator',
        targetSheet: 'Excusals Backend',
        field: 'decision',
        newValue,
        source: 'ExcusalsService.handleExcusalsBackendEdit',
        error: err,
      });
    }
  }

  /**
   * Handle edits in the Excusals Management spreadsheet (squadron tabs) and mirror decisions to Excusals Backend.
   */
  export function handleExcusalsManagementEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const mgmtId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!mgmtId) return;

    const range = e?.range;
    const sheet = range?.getSheet();
    if (!sheet || sheet.getParent().getId() !== mgmtId) return;
    if (!Arrays.OPERATIONAL_SQUADRONS.includes(sheet.getName())) return;

    const row = range.getRow();
    const col = range.getColumn();
    const decision = String((e as any)?.value ?? range.getValue() ?? '').trim();

    const decisionCol = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders?.indexOf('decision') ?? -1;
    const requestCol = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders?.indexOf('request_id') ?? -1;
    if (decisionCol < 0 || requestCol < 0) return;
    if (row < 3 || col !== decisionCol + 1) return;
    if (!DECISION_VALUES.includes(decision)) return;

    const requestId = String(sheet.getRange(row, requestCol + 1).getValue() || '').trim();
    if (!requestId) {
      Log.warn(`Management edit ignored: missing request_id on row ${row}`);
      return;
    }

    const backendId = Config.getBackendId();
    const backendSheet = SheetUtils.getSheet(backendId, 'Excusals Backend');
    if (!backendSheet) {
      Log.warn('Excusals Backend not found; cannot mirror management decision');
      return;
    }

    const headers = backendSheet.getRange(1, 1, 1, backendSheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const schemaHeaders = Schemas.getTabSchema('Excusals Backend')?.machineHeaders || [];
    const headerName = (name: string) => (schemaHeaders.includes(name) ? name : name); // prefer schema names
    const idx = {
      request: headers.indexOf(headerName('request_id')),
      decision: headers.indexOf(headerName('decision')),
      status: headers.indexOf(headerName('status')),
      decidedBy: headers.indexOf(headerName('decided_by')),
      decidedAt: headers.indexOf(headerName('decided_at')),
      lastUpdated: headers.indexOf(headerName('last_updated_at')),
      event: headers.indexOf(headerName('event')),
      email: headers.indexOf(headerName('email')),
      last: headers.indexOf(headerName('last_name')),
      first: headers.indexOf(headerName('first_name')),
      squadron: headers.indexOf(headerName('squadron')),
      reason: headers.indexOf(headerName('reason')),
      requestedOutcome: headers.indexOf(headerName('requested_outcome')),
      priorAttendanceCode: headers.indexOf(headerName('prior_attendance_code')),
      attendanceEffect: headers.indexOf(headerName('attendance_effect')),
    };

    if (idx.request < 0) return;

    const data = backendSheet.getRange(3, 1, backendSheet.getLastRow() - 2, headers.length).getValues();
    let targetRow = -1;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][idx.request] || '').trim() === requestId) {
        targetRow = i;
        break;
      }
    }

    if (targetRow < 0) {
      Log.warn(`Request ${requestId} not found in Excusals Backend; cannot mirror decision`);
      return;
    }

    const rowNumber = targetRow + 3; // account for two header rows
    const oldDecision = idx.decision >= 0 ? String(data[targetRow][idx.decision] || '').trim() : '';
    if (oldDecision === decision) return;
    const nowIso = new Date().toISOString();
    const activeEmail = currentUserEmail();

    const lastName = idx.last >= 0 ? String(data[targetRow][idx.last] || '') : '';
    const firstName = idx.first >= 0 ? String(data[targetRow][idx.first] || '') : '';
    const eventName = idx.event >= 0 ? String(data[targetRow][idx.event] || '') : '';
    const cadetEmail = idx.email >= 0 ? String(data[targetRow][idx.email] || '') : '';
    const squadron = idx.squadron >= 0 ? String(data[targetRow][idx.squadron] || '') : '';
    const reason = idx.reason >= 0 ? String(data[targetRow][idx.reason] || '') : '';
    const requestedOutcome = idx.requestedOutcome >= 0 ? String(data[targetRow][idx.requestedOutcome] || 'E') : 'E';
    const priorAttendanceCode = idx.priorAttendanceCode >= 0 ? String(data[targetRow][idx.priorAttendanceCode] || '') : '';
    const attendanceEffect = effectForDecision({
      decision,
      requestedOutcome,
      priorAttendanceCode,
      currentAttendanceCode: lookupMatrixValue(eventName, lastName, firstName),
      eventName,
    });
    const isDecisionChange = !!(oldDecision && oldDecision !== decision);

    if (idx.status >= 0) backendSheet.getRange(rowNumber, idx.status + 1).setValue(decision);
    if (idx.decision >= 0) backendSheet.getRange(rowNumber, idx.decision + 1).setValue(decision);
    if (idx.decidedBy >= 0) backendSheet.getRange(rowNumber, idx.decidedBy + 1).setValue(activeEmail);
    if (idx.decidedAt >= 0) backendSheet.getRange(rowNumber, idx.decidedAt + 1).setValue(nowIso);
    if (idx.lastUpdated >= 0) backendSheet.getRange(rowNumber, idx.lastUpdated + 1).setValue(nowIso);
    if (idx.attendanceEffect >= 0) backendSheet.getRange(rowNumber, idx.attendanceEffect + 1).setValue(attendanceEffect);

    updateAttendanceOnExcusalDecision({
      lastName,
      firstName,
      eventName,
      decision,
      requestedOutcome,
      priorAttendanceCode,
      attendanceEffect,
    });

    sendExcusalDecisionEmail({
      cadetEmail,
      cadetFirstName: firstName,
      cadetLastName: lastName,
      event: eventName,
      decision,
      previousDecision: isDecisionChange ? oldDecision : undefined,
      reason,
      squadron,
    });

    Log.info(
      `Mirrored management decision for request ${requestId}: ${decision}${isDecisionChange ? ` (was ${oldDecision})` : ''}`,
    );
    AuditService.log({
      action: 'excusal_decision_recorded',
      result: 'ok',
      actorEmail: activeEmail || undefined,
      role: 'squadron_commander',
      targetSheet: 'Excusals Backend',
      targetTable: 'Excusals Backend',
      targetKey: requestId,
      requestId,
      field: 'decision',
      oldValue: oldDecision,
      newValue: decision,
      source: 'ExcusalsService.handleExcusalsManagementEdit',
      metadata: { event: eventName, squadron, attendanceEffect, managementSheet: sheet.getName() },
    });
  }

  export function auditExcusalSubmission(excusalRow: Record<string, any>) {
    const requestId = String(excusalRow['request_id'] || '').trim();
    AuditService.log({
      action: 'excusal_request_submitted',
      result: 'ok',
      actorEmail: String(excusalRow['email'] || '').trim().toLowerCase() || undefined,
      role: 'cadet',
      targetSheet: 'Excusals Backend',
      targetTable: 'Excusals Backend',
      targetKey: requestId,
      requestId,
      field: 'status',
      oldValue: '',
      newValue: 'Submitted',
      source: 'ExcusalsService.auditExcusalSubmission',
      metadata: {
        event: String(excusalRow['event'] || ''),
        squadron: String(excusalRow['squadron'] || ''),
        requestedOutcome: String(excusalRow['requested_outcome'] || ''),
      },
    });
  }

  /**
   * Update attendance matrix when excusal decision is made.
   * Approved writes the requested outcome. Denied writes U after an event, D
   * before an event, or preserves P/T if the cadet actually attended.
   * Withdrawn/Superseded restore the prior attendance code.
   */
  function updateAttendanceOnExcusalDecision(opts: {
    lastName: string;
    firstName: string;
    eventName: string;
    decision: string;
    requestedOutcome?: string;
    priorAttendanceCode?: string;
    attendanceEffect?: string;
  }) {
    const code = opts.attendanceEffect ?? effectForDecision({
      decision: opts.decision,
      requestedOutcome: opts.requestedOutcome || 'E',
      priorAttendanceCode: opts.priorAttendanceCode || '',
      currentAttendanceCode: lookupMatrixValue(opts.eventName, opts.lastName, opts.firstName),
      eventName: opts.eventName,
    });

    const logEntry = {
      submission_id: `excusal-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      submitted_at: new Date(),
      event: opts.eventName,
      attendance_type: code,
      email: 'excusal-decision',
      name: 'Excusal Decision',
      flight: '',
      cadets: `${opts.lastName}, ${opts.firstName}`,
    };

    appendAttendanceLogs([logEntry]);
    AttendanceService.applyAttendanceLogEntry(logEntry);
  }

  /**
   * Send decision notification email to cadet from squadron commander.
   */
  function sendExcusalDecisionEmail(opts: {
    cadetEmail: string;
    cadetFirstName: string;
    cadetLastName: string;
    event: string;
    decision: string;
    previousDecision?: string;
    reason: string;
    squadron: string;
  }) {
    if (!opts.cadetEmail) {
      Log.warn('Cannot send decision email: no cadet email');
      return;
    }

    const backendId = Config.getBackendId();
    if (!backendId) {
      Log.warn('Cannot send decision email: no backend ID');
      return;
    }

    // Get squadron commander details
    const commanderEmail = getSquadronCommanderEmail(opts.squadron);
    const commander = commanderEmail ? lookupLeadershipByEmail(commanderEmail) : null;
    const commanderLastName = String(commander?.last_name || 'Commander').trim();

    // Determine time of day
    const hours = new Date().getHours();
    const timeOfDay = hours < 12 ? 'Good morning' : hours < 18 ? 'Good afternoon' : 'Good evening';

    let subject: string;
    let body: string;

    if (opts.previousDecision) {
      // Decision change notification
      subject = `Excusal Request Decision Changed: ${opts.cadetLastName}, ${opts.cadetFirstName} – ${opts.event}`;
      body = `${timeOfDay} Cadet ${opts.cadetFirstName} ${opts.cadetLastName},

Your excusal request for ${opts.event} has been reconsidered and the decision has changed.

Previous decision: ${opts.previousDecision}
New decision: ${opts.decision}

Your excusal reason: ${opts.reason}

If you have questions or would like to appeal, contact your flight/squadron commander through the chain of command.

Very respectfully,
C/${commanderLastName}`;
    } else {
      // Initial decision notification
      subject = `Excusal Request ${opts.decision}: ${opts.cadetLastName}, ${opts.cadetFirstName} – ${opts.event}`;
      body = `${timeOfDay} Cadet ${opts.cadetFirstName} ${opts.cadetLastName},

Your excusal request for ${opts.event} has been ${opts.decision.toLowerCase()}.

Your excusal reason: ${opts.reason}

If you have questions or would like to appeal, contact your flight/squadron commander through the chain of command.

Very respectfully,
C/${commanderLastName}`;
    }

    try {
      GmailApp.sendEmail(opts.cadetEmail, subject, body, {
        name: 'SHAMROCK Automations',
        replyTo: commanderEmail || 'shamrock@nd.edu',
        cc: commanderEmail || undefined,
      });
      Log.info(`Decision email sent to ${opts.cadetEmail}; decision=${opts.decision}${opts.previousDecision ? ` (changed from ${opts.previousDecision})` : ''}`);
    } catch (err) {
      Log.warn(`Failed to send decision email to ${opts.cadetEmail}: ${err}`);
    }
  }

  function appendAttendanceLogs(logs: Record<string, any>[]) {
    if (!logs.length) return;
    const backendId = Config.getBackendId();
    if (!backendId) return;
    const sheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
    if (!sheet) return;
    SheetUtils.appendRows(sheet, logs);
  }

  // Helper: lookup current matrix value for a cadet/event (backend matrix)
  function lookupMatrixValue(eventName: string, lastName: string, firstName: string): string {
    const backendId = Config.getBackendId();
    if (!backendId) return '';
    const matrixSheet = SheetUtils.getSheet(backendId, 'Attendance Matrix Backend');
    if (!matrixSheet) return '';

    const lastRow = matrixSheet.getLastRow();
    const lastCol = matrixSheet.getLastColumn();
    if (lastRow < 3 || lastCol < 1) return '';

    const headers = matrixSheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map((h) => String(h || '').trim());
    const eventColIdx = headers.indexOf(eventName);
    const lastIdx = headers.indexOf('last_name');
    const firstIdx = headers.indexOf('first_name');
    if (eventColIdx < 0 || lastIdx < 0 || firstIdx < 0) return '';

    const data = matrixSheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
    for (let i = 0; i < data.length; i++) {
      if (
        String(data[i][lastIdx] || '').trim().toLowerCase() === lastName.toLowerCase() &&
        String(data[i][firstIdx] || '').trim().toLowerCase() === firstName.toLowerCase()
      ) {
        return String(data[i][eventColIdx] || '').trim();
      }
    }
    return '';
  }

  export function getCurrentAttendanceCode(eventName: string, lastName: string, firstName: string): string {
    return lookupMatrixValue(eventName, lastName, firstName);
  }

  /** Archive current-term management rows into the admin workbook. */
  export function archiveManagementSheets(archiveLabel: string, archiveKey: string): string[] {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    const backendId = Config.getBackendId();
    if (!managementId || !backendId) return [];
    const management = SpreadsheetApp.openById(managementId);
    const archiveWorkbook = SpreadsheetApp.openById(backendId);
    const archivedNames: string[] = [];
    const safeLabel = String(archiveLabel || 'Previous Term').trim() || 'Previous Term';
    const safeKey = String(archiveKey || 'archive').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 8) || 'archive';
    const lockArchive = (sheet: GoogleAppsScript.Spreadsheet.Sheet, archiveName: string) => {
      sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => {
        try { protection.remove(); } catch {}
      });
      sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => {
        try { protection.remove(); } catch {}
      });
      const protection = sheet.protect().setDescription(`${archiveName}: locked term archive`);
      protection.setWarningOnly(false);
      try { protection.removeEditors(protection.getEditors()); } catch {}
      if (protection.canDomainEdit()) protection.setDomainEdit(false);
      sheet.hideSheet();
    };
    Arrays.OPERATIONAL_SQUADRONS.forEach((squadron) => {
      const source = management.getSheetByName(squadron);
      if (!source || source.getLastRow() < 3) return;
      const archiveName = `${safeLabel} ${squadron} Excusals ${safeKey}`;
      const existing = archiveWorkbook.getSheetByName(archiveName);
      if (existing) {
        lockArchive(existing, archiveName);
        archivedNames.push(archiveName);
        return;
      }
      const archived = source.copyTo(archiveWorkbook).setName(archiveName);
      lockArchive(archived, archiveName);
      archivedNames.push(archiveName);
    });
    Log.info(`Archived ${archivedNames.length} Excusals management sheet(s) in the admin workbook for ${safeLabel}`);
    return archivedNames;
  }

  /** Clear active management rows and refresh the sheets against current Leadership assignments. */
  export function resetManagementForNewTerm() {
    const managementId = ensureManagementSpreadsheet();
    const ss = SpreadsheetApp.openById(managementId);
    Arrays.OPERATIONAL_SQUADRONS.forEach((squadron) => {
      const sheet = ss.getSheetByName(squadron);
      if (!sheet) return;
      const lastRow = sheet.getLastRow();
      if (lastRow >= 3) sheet.getRange(3, 1, lastRow - 2, sheet.getMaxColumns()).clearContent();
      initializeSquadronManagementSheet(sheet, squadron);
    });
    shareAndProtectManagementSpreadsheet();
    Log.info('Reset active Excusals management sheets and refreshed current-term access');
  }

  /** Apply protections so only each squadron commander can edit Decision cells on their squadron tab. */
  function applyManagementSheetProtections(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheets = ss.getSheets();
    const squadrons = Arrays.OPERATIONAL_SQUADRONS;

    sheets.forEach((sheet) => {
      const sheetName = sheet.getName();
      if (!squadrons.includes(sheetName)) return;

      const commanderEmail = getSquadronCommanderEmail(sheetName);
      const lastCol = Math.max(1, sheet.getLastColumn(), sheet.getMaxColumns());
      const maxRows = sheet.getMaxRows();

      // Remove existing protections (sheet and ranges)
      sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => {
        try { p.remove(); } catch {}
      });
      sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => {
        try { p.remove(); } catch {}
      });

      // Protect header rows (1-2): owner/script only.
      const headerRange = sheet.getRange(1, 1, 2, lastCol);
      try {
        const headerProt = headerRange.protect().setDescription(`${sheetName}: Headers protected`);
        headerProt.setWarningOnly(false);
        try { headerProt.removeEditors(headerProt.getEditors()); } catch {}
        if (headerProt.canDomainEdit()) headerProt.setDomainEdit(false);
      } catch (err) {
        Log.warn(`Failed to protect headers on ${sheetName}: ${err}`);
      }

      // Protect every data field except Decision. These fields are managed by SHAMROCK.
      const dataRowCount = Math.max(1, maxRows - 2);
      if (dataRowCount > 0) {
        const decisionColumn = (Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || []).indexOf('decision') + 1;
        const managedRanges: GoogleAppsScript.Spreadsheet.Range[] = [];
        if (decisionColumn > 1) managedRanges.push(sheet.getRange(3, 1, dataRowCount, decisionColumn - 1));
        if (decisionColumn > 0 && decisionColumn < lastCol) {
          managedRanges.push(sheet.getRange(3, decisionColumn + 1, dataRowCount, lastCol - decisionColumn));
        }
        managedRanges.forEach((range, index) => {
          try {
            const protection = range.protect().setDescription(`${sheetName}: Managed request fields ${index + 1}`);
            protection.setWarningOnly(false);
            try { protection.removeEditors(protection.getEditors()); } catch {}
            if (protection.canDomainEdit()) protection.setDomainEdit(false);
          } catch (err) {
            Log.warn(`Failed to protect managed request fields on ${sheetName}: ${err}`);
          }
        });

        if (decisionColumn > 0) {
          try {
            const decisionProtection = sheet
              .getRange(3, decisionColumn, dataRowCount, 1)
              .protect()
              .setDescription(`${sheetName}: Decisions editable only by squadron commander`);
            decisionProtection.setWarningOnly(false);
            try { decisionProtection.removeEditors(decisionProtection.getEditors()); } catch {}
            if (decisionProtection.canDomainEdit()) decisionProtection.setDomainEdit(false);
            if (commanderEmail) decisionProtection.addEditor(commanderEmail);
            else Log.warn(`No commander email found for ${sheetName}; Decision cells will be owner-only`);
          } catch (err) {
            Log.warn(`Failed to protect Decision cells on ${sheetName}: ${err}`);
          }
        }
      }

      Log.info(`Applied Decision-only editing protections on ${sheetName}; commander=${commanderEmail || 'none'}`);
    });
  }
}
