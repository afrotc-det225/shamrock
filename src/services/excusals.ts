// Excusals processing service: handle notifications, decisions, and management panel.

namespace ExcusalsService {
  const DEFAULT_DECISION_VALUES = ['Approved', 'Denied', 'Withdrawn', 'Superseded'];
  const MANAGEMENT_LEGEND_SHEET = '_Excusals Data Legend';
  const MANAGEMENT_DECISION_RANGE = 'EXCUSAL_DECISIONS';
  const MANAGEMENT_TABLE_SUFFIX = ' Excusals';
  const TERMINAL_RESTORE_DECISIONS = new Set(['Withdrawn', 'Superseded']);
  const REQUESTED_OUTCOMES = new Set(['P', 'T', 'E', 'ES', 'MED']);
  const ATTENDANCE_CODES = new Set(['P', 'T', 'A', 'R', 'D', 'U', 'E', 'ES', 'MED', 'N/A', '']);

  function decisionValues(): string[] {
    const canonical = Arrays.EXCUSAL_DECISIONS || [];
    return canonical.length ? canonical : DEFAULT_DECISION_VALUES;
  }

  function isDecisionValue(value: string): boolean {
    return decisionValues().includes(value);
  }

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

  /** Resolve claimed names to exactly one Directory record without replacing
   * the verified respondent email with that record's potentially different email. */
  export function resolveExcusalCadet(email: string, lastName: string, firstName: string): Record<string, any> {
    const normalize = (value: any) => String(value || '').trim().toLowerCase();
    const respondent = normalize(email);
    if (!respondent) throw new Error('A verified respondent email is required for an excusal request.');
    const sheet = SheetUtils.getSheet(Config.getBackendId(), 'Directory Backend');
    if (!sheet) throw new Error('Directory Backend is unavailable. The excusal request was not saved.');
    const rows = SheetUtils.readTable(sheet).rows;
    const emailMatches = rows.filter(row => normalize(row['email']) === respondent);
    if (emailMatches.length > 1) throw new Error('The respondent email matches multiple Directory records. Review the Directory before retrying.');
    let matches = emailMatches;
    if (!matches.length) {
      // Some submissions copied the same "Last, First" selection into both
      // text fields. Only that exact repeated shape is normalized.
      if (normalize(lastName) === normalize(firstName)) {
        const parts = lastName.split(',').map(part => part.trim());
        if (parts.length === 2 && parts.every(Boolean)) [lastName, firstName] = parts;
      }
      matches = rows.filter(row => normalize(row['last_name']) === normalize(lastName) && normalize(row['first_name']) === normalize(firstName));
    }
    if (matches.length !== 1) throw new Error('The excusal cadet identity is missing or ambiguous. Review the Directory before retrying.');
    const cadet = matches[0];
    if (rows.filter(row => normalize(row['last_name']) === normalize(cadet['last_name']) && normalize(row['first_name']) === normalize(cadet['first_name'])).length !== 1) {
      throw new Error('The Directory name matches multiple attendance identities. Review the Directory before retrying.');
    }
    if (!String(cadet['last_name'] || '').trim() || !String(cadet['first_name'] || '').trim()
      || !Arrays.OPERATIONAL_SQUADRONS.some(squadron => normalize(squadron) === normalize(cadet['squadron']))
      || !Arrays.FLIGHTS.some(flight => normalize(flight) === normalize(cadet['flight']))) {
      throw new Error('The Directory record needs a valid name, flight and operational squadron before an excusal can be routed.');
    }
    return { ...cadet,
      flight: Arrays.FLIGHTS.find(flight => normalize(flight) === normalize(cadet['flight'])),
      squadron: Arrays.OPERATIONAL_SQUADRONS.find(squadron => normalize(squadron) === normalize(cadet['squadron'])),
      respondent_email: respondent, identity_match: emailMatches.length ? 'verified_email' : 'directory_name' };
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

    AttendanceService.withWriteLock(() => {
      // Notifications can delay this continuation long enough for a commander
      // to decide the request. The submitted object is not authoritative now.
      const requestId = String(excusalRow['request_id'] || '').trim();
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(requestId)) throw new Error('Excusal request identity is missing or invalid.');
      const requestSheet = SheetUtils.getSheet(backendId, 'Excusals Backend');
      if (!requestSheet) throw new Error('Excusals Backend is unavailable.');
      const matches = SheetUtils.readTable(requestSheet).rows.filter(row => String(row['request_id'] || '').trim() === requestId);
      if (matches.length !== 1) throw new Error('Excusal request identity is missing or ambiguous.');
      const current = matches[0];
      if (attendanceStateKey(current['event'], current['last_name'], current['first_name']) !== attendanceStateKey(eventName, lastName, firstName)) {
        throw new Error('Excusal request target changed before attendance could be applied.');
      }
      if (isDecisionValue(String(current['decision'] || '').trim())) return;
      const logEntry = {
        submission_id: `excusal-request-${requestId}`,
        submitted_at: new Date(),
        event: eventName,
        attendance_type: 'R',
        email: excusalRow['email'] || '',
        name: 'Excusal Request',
        flight: excusalRow['flight'] || '',
        cadets: `${lastName}, ${firstName}`,
      };
      // A retry after an uncertain append must not restore R over newer P/T or
      // an intentional clear. The original durable effect already exists.
      const log = readAttendanceLogState();
      if (log.receiptIds.has(logEntry.submission_id)) {
        if (log.state.get(attendanceStateKey(eventName, lastName, firstName))?.submissionId === logEntry.submission_id) {
          const projections = AttendanceService.prepareAttendanceProjections([logEntry], { frontendPendingOnly: true });
          AttendanceService.applyPreparedAttendanceProjections(projections);
          if (projections.some(batch => batch.conflicts)) {
            AuditService.log({ action: 'excusal_pending_projection_review_required', result: 'ok', role: 'automation',
              targetSheet: 'Attendance', requestId, targetKey: requestId,
              source: 'ExcusalsService.updateAttendanceOnExcusalSubmission', metadata: { reason: 'Saved request conflicts with a non-pending frontend value.' } });
            throw new Error('The request is saved, but its live attendance value needs review before retrying. No non-pending frontend value was replaced.');
          }
        }
        return;
      }
      const projections = AttendanceService.prepareAttendanceProjections([logEntry]);
      appendAttendanceLogs([logEntry]);
      AttendanceService.applyPreparedAttendanceProjections(projections);
    });
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

  function managementTableName(squadron: string): string {
    return `${squadron}${MANAGEMENT_TABLE_SUFFIX}`;
  }

  interface ManagementPermission {
    type: string;
    role: string;
    emailAddress?: string;
    deleted?: boolean;
  }

  function managementPermissions(fileId: string): ManagementPermission[] {
    // User.getEmail() can omit cross-domain collaborators. Read the actual file
    // permission addresses instead of treating unavailable profiles as no access.
    const permissions: ManagementPermission[] = [];
    const seen = new Set<string>();
    let pageToken = '';
    do {
      const query = 'pageSize=100&supportsAllDrives=true&fields='
        + encodeURIComponent('nextPageToken,permissions(type,role,emailAddress,deleted)')
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const response = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?${query}`, {
        headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
        muteHttpExceptions: true,
      });
      if (response.getResponseCode() !== 200) {
        throw new Error(`Unable to read workbook sharing (HTTP ${response.getResponseCode()}); access was not refreshed.`);
      }
      const page = JSON.parse(response.getContentText());
      if (!Array.isArray(page.permissions)) throw new Error('Workbook sharing returned an incomplete permission list.');
      permissions.push(...page.permissions.filter((permission: ManagementPermission) => !permission.deleted));
      pageToken = String(page.nextPageToken || '');
      if (pageToken && seen.has(pageToken)) throw new Error('Workbook sharing pagination did not complete.');
      seen.add(pageToken);
    } while (pageToken);
    return permissions;
  }

  function managementAdminEmails(): string[] {
    // Resolve every explicit backend administrator before changing sharing.
    const permissions = managementPermissions(Config.getBackendId());
    const editors = permissions.filter((permission) => ['owner', 'writer'].includes(permission.role));
    if (editors.some((permission) => !['user', 'group'].includes(permission.type) || !permission.emailAddress)) {
      throw new Error('Backend administrator sharing could not be resolved completely; access was not refreshed.');
    }
    const emails = Array.from(new Set(editors.map((permission) => String(permission.emailAddress).trim().toLowerCase())));
    if (!emails.length) throw new Error('No backend administrators could be resolved; access was not refreshed.');
    return emails;
  }

  function protectManagementLegend(sheet: GoogleAppsScript.Spreadsheet.Sheet, admins: string[]) {
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => protection.remove());
    const protection = sheet.protect().setDescription('Excusals Management Data Legend');
    protection.setWarningOnly(false);
    try { protection.removeEditors(protection.getEditors()); } catch {}
    protection.addEditors(admins);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  }

  function verifyManagementProtections(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, admins: string[], owner: string) {
    const metadata = (globalThis as any).Sheets.Spreadsheets.get(ss.getId(), {
      fields: 'sheets(properties(sheetId,title,gridProperties),protectedRanges(description,range,warningOnly,editors,unprotectedRanges))',
    });
    let checked = 0;
    for (const name of [...Arrays.OPERATIONAL_SQUADRONS, MANAGEMENT_LEGEND_SHEET]) {
      const sheet = metadata.sheets?.find((entry: any) => entry.properties?.title === name);
      if (!sheet) throw new Error(`Management protection verification could not find ${name}.`);
      const expected = name === MANAGEMENT_LEGEND_SHEET
        ? [{ description: 'Excusals Management Data Legend', range: { sheetId: sheet.properties.sheetId }, editors: admins }]
        : (() => {
          const rowEnd = sheet.properties.gridProperties.rowCount;
          const colEnd = sheet.properties.gridProperties.columnCount;
          const decision = (Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || []).indexOf('decision');
          const range = (startRowIndex: number, endRowIndex: number, startColumnIndex: number, endColumnIndex: number) =>
            ({ sheetId: sheet.properties.sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
          const fields = [];
          if (decision > 0) fields.push(range(2, rowEnd, 0, decision));
          if (decision + 1 < colEnd) fields.push(range(2, rowEnd, decision + 1, colEnd));
          return [
            { description: `${name}: Headers protected`, range: range(0, 2, 0, colEnd), editors: admins },
            ...fields.map((field, index) => ({ description: `${name}: Managed request fields ${index + 1}`, range: field, editors: admins })),
            { description: `${name}: Decisions editable only by squadron commander`, range: range(2, rowEnd, decision, decision + 1), editors: [...admins, getSquadronCommanderEmail(name)].filter(Boolean) },
          ];
        })();
      const actual = sheet.protectedRanges || [];
      if (actual.length !== expected.length) throw new Error(`Management protection count is incorrect on ${name}.`);
      for (const requirement of expected) {
        const protection = actual.find((entry: any) => entry.description === requirement.description);
        const allowed = new Set([...requirement.editors, owner].filter(Boolean).map((email) => email.toLowerCase()));
        const editors = new Set<string>([...(protection?.editors?.users || []), ...(protection?.editors?.groups || []), owner]
          .filter(Boolean).map((email: string) => email.toLowerCase()));
        const rangeMatches = protection && ['sheetId', 'startRowIndex', 'endRowIndex', 'startColumnIndex', 'endColumnIndex'].every((key) => {
          const expectedValue = (requirement.range as any)[key];
          const actualValue = protection.range?.[key];
          return key.startsWith('start') ? (actualValue || 0) === (expectedValue || 0) : actualValue === expectedValue;
        });
        if (!rangeMatches || protection.warningOnly || protection.editors?.domainUsersCanEdit || protection.unprotectedRanges?.length
          || [...allowed].some((email) => !editors.has(email)) || [...editors].some((email) => !allowed.has(email))) {
          throw new Error(`Management protection verification failed for ${requirement.description}. Run sharing again as the owner.`);
        }
        checked++;
      }
    }
    Log.info(`Verified ${checked} management protections and backend administrator access.`);
  }

  function ensureManagementDecisionLegend(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
  ): GoogleAppsScript.Spreadsheet.Range {
    const admins = managementAdminEmails();
    const values = decisionValues();
    let sheet = ss.getSheetByName(MANAGEMENT_LEGEND_SHEET);
    if (!sheet) sheet = ss.insertSheet(MANAGEMENT_LEGEND_SHEET);

    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => {
      try { protection.remove(); } catch {}
    });
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => {
      try { protection.remove(); } catch {}
    });
    let sourceRange: GoogleAppsScript.Spreadsheet.Range | null = null;
    try {
      if (sheet.getMaxRows() < values.length + 2) {
        sheet.insertRowsAfter(sheet.getMaxRows(), values.length + 2 - sheet.getMaxRows());
      }
      const managedRange = sheet.getRange(1, 1, sheet.getMaxRows(), 1);
      managedRange.clearContent().clearFormat();
      sheet.getRange(1, 1).setValue('excusal_decision_options');
      sheet.getRange(2, 1).setValue('Excusal Decision Options');
      sourceRange = sheet.getRange(3, 1, values.length, 1);
      const colors: Record<string, { background: string; font: string }> = {
        Approved: { background: '#D9EAD3', font: '#274E13' },
        Denied: { background: '#F4CCCC', font: '#990000' },
        Withdrawn: { background: '#FFF2CC', font: '#7F6000' },
        Superseded: { background: '#D9D2E9', font: '#674EA7' },
      };
      sourceRange.setValues(values.map((value) => [value]));
      sourceRange.setBackgrounds(values.map((value) => [colors[value]?.background || '#FFFFFF']))
        .setFontColors(values.map((value) => [colors[value]?.font || '#434343']))
        .setFontWeight('bold');
      sheet.getRange(1, 1, 2, 1).setFontWeight('bold');
      sheet.setColumnWidth(1, 180);
      ss.setNamedRange(MANAGEMENT_DECISION_RANGE, sourceRange);
    } finally {
      protectManagementLegend(sheet, admins);
      if (!sheet.isSheetHidden()) sheet.hideSheet();
    }
    if (!sourceRange) throw new Error('Unable to prepare the Excusals Management decision legend.');
    return sourceRange;
  }

  function applyManagementDecisionValidation(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    sourceRange: GoogleAppsScript.Spreadsheet.Range,
  ) {
    const decisionColumn = (Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || []).indexOf('decision');
    if (decisionColumn < 0) throw new Error('Excusals Management schema is missing Decision.');
    const sourceSheetName = sourceRange.getSheet().getName().replace(/'/g, "''");
    const sourceA1 = sourceRange.getA1Notation().replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
    const endRowIndex = Math.max(3, sheet.getMaxRows());
    const svc = (globalThis as any).Sheets?.Spreadsheets;
    if (!svc?.batchUpdate) throw new Error('Sheets advanced service is required for management Decision validation.');
    svc.batchUpdate({
      requests: [{
        setDataValidation: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: 2,
            endRowIndex,
            startColumnIndex: decisionColumn,
            endColumnIndex: decisionColumn + 1,
          },
          rule: {
            condition: {
              type: 'ONE_OF_RANGE',
              values: [{ userEnteredValue: `='${sourceSheetName}'!${sourceA1}` }],
            },
            inputMessage: 'Select Approved, Denied, Withdrawn, or Superseded',
            strict: true,
            showCustomUi: true,
          },
          filteredRowsIncluded: true,
        },
      }],
    }, ss.getId());

    const decisionRange = sheet.getRange(3, decisionColumn + 1, Math.max(1, sheet.getMaxRows() - 2), 1);
    const colorRule = (value: string, background: string, font: string) => SpreadsheetApp
      .newConditionalFormatRule()
      .whenTextEqualTo(value)
      .setBackground(background)
      .setFontColor(font)
      .setRanges([decisionRange])
      .build();
    sheet.setConditionalFormatRules([
      colorRule('Approved', '#D9EAD3', '#274E13'),
      colorRule('Denied', '#F4CCCC', '#990000'),
      colorRule('Withdrawn', '#FFF2CC', '#7F6000'),
      colorRule('Superseded', '#D9D2E9', '#674EA7'),
    ]);
  }

  function ensureManagementPresentation(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sourceRange = ensureManagementDecisionLegend(ss);
    Arrays.OPERATIONAL_SQUADRONS.forEach((squadron) => {
      const sheet = ss.getSheetByName(squadron);
      if (!sheet) return;
      const tableReady = SetupService.ensureTableForSheet(ss.getId(), squadron, managementTableName(squadron));
      if (!tableReady) throw new Error(`Unable to create the required Google Sheets table for ${squadron}.`);
      applyManagementDecisionValidation(ss, sheet, sourceRange);
    });
  }

  /**
   * Get or create the excusals management spreadsheet.
   */
  export function ensureManagementSpreadsheet(): string {
    const existingId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);

    if (existingId) {
      let existing: GoogleAppsScript.Spreadsheet.Spreadsheet | null = null;
      try {
        existing = SpreadsheetApp.openById(existingId);
      } catch (err) {
        Log.error(`Cannot open the configured management spreadsheet: ${err}`);
        throw new Error('Cannot access the configured Excusals Management workbook. Ask its owner to restore administrator access, then retry setup. The configured workbook has not been replaced.');
      }
      if (existing) {
        // Ensure squadron sheets exist and are initialized even if spreadsheet already exists.
        const squadrons = Arrays.OPERATIONAL_SQUADRONS;
        squadrons.forEach((squadron) => {
          let sheet = existing!.getSheetByName(squadron);
          if (!sheet) {
            sheet = existing!.insertSheet(squadron);
          }
          initializeSquadronManagementSheet(sheet, squadron);
        });
        ensureManagementPresentation(existing);
        return existingId;
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

    ensureManagementPresentation(ss);

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
    const maxRows = sheet.getMaxRows();
    const MIN_ROWS = 3;
    if (maxRows < MIN_ROWS) sheet.insertRowsAfter(maxRows, MIN_ROWS - maxRows);

    // Tables tolerate spare blank rows/columns; avoid structural trimming after
    // a native table exists because Google can reject those sheet mutations.
    const maxCols = sheet.getMaxColumns();
    if (maxCols < headerWidth) sheet.insertColumnsAfter(maxCols, headerWidth - maxCols);

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
    sheet.setFrozenColumns(2);
    sheet.getRange(2, 1, Math.max(2, sheet.getMaxRows() - 1), headerWidth)
      .setFontFamily('Roboto')
      .setVerticalAlignment('middle');

    Log.info(`Initialized management sheet for ${squadron} squadron`);
  }

  /**
   * Sync excusal to management spreadsheet.
   */
  export function syncExcusalToManagementPanel(excusalRow: Record<string, any>) {
    return AttendanceService.withWriteLock(() => {
      const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
      if (!managementId) throw new Error('Excusals Management is not configured. The saved request needs review routing.');
      const requestId = String(excusalRow['request_id'] || '').trim();
      const source = SheetUtils.getSheet(Config.getBackendId(), 'Excusals Backend');
      if (!source || !requestId) throw new Error('The saved excusal request could not be resolved for management routing.');
      const matches = SheetUtils.readTable(source).rows.filter(row => String(row['request_id'] || '').trim() === requestId);
      if (matches.length !== 1) throw new Error('The saved excusal request identity is missing or ambiguous.');
      const current = matches[0];
      const squadron = String(current['squadron'] || '').trim();
      if (!Arrays.OPERATIONAL_SQUADRONS.includes(squadron)) throw new Error('The saved request needs an operational squadron before it can be routed.');
      const ss = SpreadsheetApp.openById(managementId);
      const sheet = ss.getSheetByName(squadron);
      if (!sheet) throw new Error('The operational squadron review sheet is missing. The request remains saved in the backend.');
      const existing = ss.getSheets().filter(candidate => Arrays.OPERATIONAL_SQUADRONS.includes(candidate.getName()))
        .flatMap(candidate => SheetUtils.readTable(candidate).rows.filter(row => String(row['request_id'] || '').trim() === requestId).map(() => candidate.getName()));
      if (existing.length > 1 || (existing.length === 1 && existing[0] !== squadron)) {
        throw new Error('The request has ambiguous or inconsistent review routing. Review its existing management row.');
      }
      if (!existing.length) {
        // Append by machine headers once. Never replace an existing row: its
        // commander decision may be newer than the backend while a trigger waits.
        const required = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || [];
        const headers = SheetUtils.readTable(sheet).headers;
        if (required.some(header => headers.filter(value => value === header).length !== 1)) {
          throw new Error('The review sheet headers need repair before a request can be added.');
        }
        SheetUtils.appendRows(sheet, [{ ...current, timestamp: current['submitted_at'] || '' }]);
        SpreadsheetApp.flush();
        trimAndSortManagementSheet(sheet);
      }
      // Retrying after a presentation failure keeps the saved row/decision and
      // completes presentation/protections without a second insert.
      try {
        ensureManagementPresentation(ss);
      } finally {
        applyManagementSheetProtections(ss);
      }
      Log.info(`Synced excusal ${requestId} to ${squadron} management sheet`);
    });
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
              sheet.getRange(i + 1, 1, 1, Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders!.length).clearContent();
              managementPurged++;
            }
          }
          trimAndSortManagementSheet(sheet);
        }
        ensureManagementPresentation(ss);
        applyManagementSheetProtections(ss);
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
      ensureManagementPresentation(ss);
      applyManagementSheetProtections(ss);
    } catch (err) {
      Log.warn(`backpopulateManagementRequestedOutcome failed: ${err}`);
    }

    Log.info(`backpopulateManagementRequestedOutcome: updated ${totalUpdated} management rows`);
    return { updated: totalUpdated };
  }

  /**
   * Sort the management sheet by Timestamp descending without structural edits.
   */
  function trimAndSortManagementSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow < 3) return;
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(value => String(value || '').trim());
    const timestamp = headers.indexOf('timestamp');
    if (timestamp < 0 || headers.lastIndexOf('timestamp') !== timestamp) throw new Error('The review sheet timestamp header is missing or ambiguous.');
    // Native sorting moves the current complete rows atomically. Clearing and
    // rewriting a captured array could erase a commander edit made meanwhile.
    sheet.getRange(3, 1, lastRow - 2, lastColumn).sort({ column: timestamp + 1, ascending: false });
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
   * Share management spreadsheet with current commanders, apply sheet protections.
   */
  export function shareAndProtectManagementSpreadsheet() {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    if (!managementId) {
      throw new Error('Excusals Management is not configured. Run Setup management spreadsheet first.');
    }

    try {
      const ss = SpreadsheetApp.openById(managementId);
      const backendId = Config.getBackendId();
      if (!backendId) {
        throw new Error('The backend workbook is not configured; management access was not refreshed.');
      }

      // Squadron commanders are workbook editors. The wing commander, flight commanders,
      // and flight deputies are viewers so they can monitor without changing decisions.
      const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
      if (!leadershipSheet) {
        throw new Error('Leadership Backend is unavailable; management access was not refreshed.');
      }

      const table = SheetUtils.readTable(leadershipSheet);
      const squadronEditorEmails = new Set<string>();
      const leadershipViewerEmails = new Set<string>();
      const flightRoles = canonicalFlightLeadershipRoles();
      table.rows.forEach((row) => {
        const role = String(row['role'] || '').toLowerCase().trim();
        const email = String(row['email'] || '').trim().toLowerCase();
        if (!email) return;
        if (Arrays.getSquadronCommanderUnit(role)) squadronEditorEmails.add(email);
        else if (flightRoles.has(role) || role === 'cadet wing commander' || role === 'wing commander') leadershipViewerEmails.add(email);
      });

      const adminEmails = managementAdminEmails();
      const existingPermissions = managementPermissions(managementId);
      const ownerEmail = existingPermissions.find((permission) => permission.role === 'owner')?.emailAddress?.trim().toLowerCase();
      const intendedEditors = new Set([...squadronEditorEmails, ...adminEmails]);
      if (ownerEmail) intendedEditors.add(ownerEmail);
      intendedEditors.forEach((email) => leadershipViewerEmails.delete(email));

      // Restore intended administrator access before removing stale assignments.
      // Fail visibly if this cannot be done instead of reporting a repaired panel.
      if (adminEmails.length) ss.addEditors(adminEmails);
      DriveApp.getFileById(managementId).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);

      // Remove stale role-based access before applying current Leadership state.
      existingPermissions.forEach((permission) => {
        const email = String(permission.emailAddress || '').trim().toLowerCase();
        if (!email || intendedEditors.has(email)) return;
        if (permission.role === 'writer') ss.removeEditor(email);
        else if (['reader', 'commenter'].includes(permission.role) && !leadershipViewerEmails.has(email)) ss.removeViewer(email);
      });

      squadronEditorEmails.forEach((email) => ss.addEditor(email));
      leadershipViewerEmails.forEach((email) => ss.addViewer(email));

      // Apply range protections: each squadron sheet editable only by its commander
      applyManagementSheetProtections(ss, adminEmails);
      const legend = ss.getSheetByName(MANAGEMENT_LEGEND_SHEET);
      if (legend) protectManagementLegend(legend, adminEmails);

      ProgressService.report({
        title: 'Checking management access',
        detail: 'Confirming administrator access and protected fields on both squadron tabs and the decision legend.',
        percent: 92,
      });
      const actualPermissions = managementPermissions(managementId);
      const actualEditors = new Set(actualPermissions.filter((permission) => ['owner', 'writer'].includes(permission.role))
        .map((permission) => String(permission.emailAddress || '').trim().toLowerCase()));
      if ([...intendedEditors].some((email) => !actualEditors.has(email))) {
        throw new Error('Management editor access did not persist. Run sharing again as the workbook owner.');
      }
      const actualViewers = new Set(actualPermissions.filter((permission) => permission.role === 'reader')
        .map((permission) => String(permission.emailAddress || '').trim().toLowerCase()));
      if ([...leadershipViewerEmails].some((email) => !actualViewers.has(email))) {
        throw new Error('Management viewer access did not persist. Run sharing again as the workbook owner.');
      }
      verifyManagementProtections(ss, adminEmails, ownerEmail || '');

      Log.info(
        `Management access refreshed: ${adminEmails.length} backend administrator(s), ${squadronEditorEmails.size} squadron commander editor(s), `
        + `${leadershipViewerEmails.size} leadership viewer(s)`,
      );
    } catch (err) {
      Log.warn(`Failed to share and protect management spreadsheet: ${err}`);
      throw err;
    }
  }

  /**
   * Handle edits to the Excusals Backend (e.g., decision approval/denial).
   */
  export function handleExcusalsBackendEdit(e: GoogleAppsScript.Events.SheetsOnEdit) {
    const range = e?.range;
    if (!range) return;

    const sheet = range.getSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const decisionColIdx = headers.indexOf('decision');
    if (decisionColIdx < 0) return;
    const firstRow = Math.max(3, range.getRow());
    const lastRow = range.getLastRow();
    const firstCol = range.getColumn();
    const lastCol = range.getLastColumn();
    const decisionSheetCol = decisionColIdx + 1;
    if (lastRow < 3 || decisionSheetCol < firstCol || decisionSheetCol > lastCol) return;

    const rowCount = lastRow - firstRow + 1;
    const decisions = sheet.getRange(firstRow, decisionSheetCol, rowCount, 1).getValues();
    const singleCellEdit = rowCount === 1 && firstCol === decisionSheetCol && lastCol === decisionSheetCol;
    const previousDecision = singleCellEdit ? String((e as any)?.oldValue ?? '').trim() : '';

    const lock = LockService.getScriptLock();
    lock.waitLock(120000);
    try {
      const data = sheet.getRange(3, 1, sheet.getLastRow() - 2, headers.length).getValues();
      const idx = excusalsBackendIndexes(headers);
      if (idx.request < 0) return;
      const actorEmail = currentUserEmail();
      let updated = 0;

      decisions.forEach((values, offset) => {
        const decision = String(values[0] || '').trim();
        if (!isDecisionValue(decision)) return;
        const dataIndex = firstRow + offset - 3;
        const requestId = String(data[dataIndex]?.[idx.request] || '').trim();
        if (!requestId) {
          Log.warn(`Backend decision edit ignored: missing request_id on row ${firstRow + offset}`);
          return;
        }
        const result = applyManagementDecision({
          backendSheet: sheet,
          headers,
          data,
          idx,
          requestId,
          decision,
          actorEmail,
          actorRole: 'admin_operator',
          source: 'ExcusalsService.handleExcusalsBackendEdit',
          managementSheet: '',
          notifyCadet: true,
          previousDecision: singleCellEdit ? previousDecision : '',
        });
        if (result !== 'updated') return;
        mirrorDecisionToManagementPanel(requestId, decision);
        updated++;
      });

      if (updated > 0) repairAttendancePresentation();
      Log.info(`Processed ${decisions.length} backend decision edit(s): updated=${updated}.`);
    } catch (err) {
      Log.warn(`Failed to handle Excusals Backend edit range: ${err}`);
      AuditService.log({
        action: 'excusal_decision_recorded',
        result: 'failed',
        role: 'admin_operator',
        targetSheet: 'Excusals Backend',
        field: 'decision',
        source: 'ExcusalsService.handleExcusalsBackendEdit',
        error: err,
      });
    } finally {
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
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

    const managementHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((value) => String(value || '').trim());
    const decisionCol = managementHeaders.indexOf('decision');
    const requestCol = managementHeaders.indexOf('request_id');
    if (decisionCol < 0 || requestCol < 0) return;
    const firstRow = range.getRow();
    const lastRow = range.getLastRow();
    const firstCol = range.getColumn();
    const lastCol = range.getLastColumn();
    const decisionSheetCol = decisionCol + 1;
    if (lastRow < 3 || decisionSheetCol < firstCol || decisionSheetCol > lastCol) return;

    const firstDataRow = Math.max(3, firstRow);
    const rowCount = lastRow - firstDataRow + 1;
    const decisions = sheet.getRange(firstDataRow, decisionSheetCol, rowCount, 1).getValues();
    const requestIds = sheet.getRange(firstDataRow, requestCol + 1, rowCount, 1).getValues();
    const pending = decisions
      .map((values, index) => ({
        row: firstDataRow + index,
        decision: String(values[0] || '').trim(),
        requestId: String(requestIds[index][0] || '').trim(),
      }))
      .filter((item) => isDecisionValue(item.decision));
    if (!pending.length) return;

    // Rapid dropdown edits can start overlapping installable-trigger executions.
    // Serialize the backend/log/matrix writes so no decision loses an append or
    // overwrites another trigger's in-flight matrix update.
    const lock = LockService.getScriptLock();
    lock.waitLock(120000);
    try {

    const backendId = Config.getBackendId();
    const backendSheet = SheetUtils.getSheet(backendId, 'Excusals Backend');
    if (!backendSheet || backendSheet.getLastRow() < 3) {
      throw new Error('Excusals Backend has no request rows to match this decision. Restore the request before retrying.');
    }

    const headers = backendSheet.getRange(1, 1, 1, backendSheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const idx = excusalsBackendIndexes(headers);

    if (idx.request < 0) return;

    const data = backendSheet.getRange(3, 1, backendSheet.getLastRow() - 2, headers.length).getValues();
    const activeEmail = currentUserEmail();
    let updated = 0;
    let missing = 0;

    pending.forEach((item) => {
      if (!item.requestId) {
        missing++;
        Log.warn(`Management edit ignored: missing request_id on row ${item.row}`);
        return;
      }
      const result = applyManagementDecision({
        backendSheet,
        headers,
        data,
        idx,
        requestId: item.requestId,
        decision: item.decision,
        actorEmail: activeEmail,
        actorRole: 'squadron_commander',
        source: 'ExcusalsService.handleExcusalsManagementEdit',
        managementSheet: sheet.getName(),
        notifyCadet: true,
      });
      if (result === 'updated') updated++;
      if (result === 'missing') missing++;
    });

    if (updated > 0) repairAttendancePresentation();
    Log.info(`Processed ${pending.length} management decision edit(s): updated=${updated}, missing=${missing}`);
    } finally {
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
    }
  }

  type ManagementDecisionResult = 'updated' | 'unchanged' | 'missing' | 'review';

  function excusalsBackendIndexes(headers: string[]): Record<string, number> {
    return {
      request: headers.indexOf('request_id'),
      decision: headers.indexOf('decision'),
      status: headers.indexOf('status'),
      decidedBy: headers.indexOf('decided_by'),
      decidedAt: headers.indexOf('decided_at'),
      lastUpdated: headers.indexOf('last_updated_at'),
      submittedAt: headers.indexOf('submitted_at'),
      event: headers.indexOf('event'),
      email: headers.indexOf('email'),
      last: headers.indexOf('last_name'),
      first: headers.indexOf('first_name'),
      squadron: headers.indexOf('squadron'),
      reason: headers.indexOf('reason'),
      requestedOutcome: headers.indexOf('requested_outcome'),
      priorAttendanceCode: headers.indexOf('prior_attendance_code'),
      attendanceEffect: headers.indexOf('attendance_effect'),
    };
  }

  function applyManagementDecision(opts: {
    backendSheet: GoogleAppsScript.Spreadsheet.Sheet;
    headers: string[];
    data: any[][];
    idx: Record<string, number>;
    requestId: string;
    decision: string;
    actorEmail: string;
    actorRole: string;
    source: string;
    managementSheet: string;
    notifyCadet: boolean;
    deferAttendanceEffects?: boolean;
    repairLogState?: Map<string, EffectiveAttendanceState>;
    previousDecision?: string;
  }): ManagementDecisionResult {
    const matches = opts.data.map((row, index) => String(row[opts.idx.request] || '').trim() === opts.requestId ? index : -1).filter(index => index >= 0);
    if (matches.length > 1) throw new Error('Excusal request identity is ambiguous. No decision was applied.');
    const targetRow = matches.length ? matches[0] : -1;
    if (targetRow < 0) {
      Log.warn(`Request ${opts.requestId} not found in Excusals Backend; cannot mirror decision`);
      return 'missing';
    }

    const storedDecision = opts.idx.decision >= 0
      ? String(opts.data[targetRow][opts.idx.decision] || '').trim()
      : '';
    const oldDecision = opts.previousDecision !== undefined ? opts.previousDecision : storedDecision;
    const recordedStatus = opts.idx.status >= 0 ? String(opts.data[targetRow][opts.idx.status] || '').trim() : '';
    const recordedAt = opts.idx.decidedAt >= 0 ? opts.data[targetRow][opts.idx.decidedAt] : '';
    const recorded = storedDecision === opts.decision && (
      recordedStatus === opts.decision && !!recordedAt && Number.isFinite(new Date(recordedAt).getTime())
    );
    if (recorded) {
      if (opts.deferAttendanceEffects) return 'unchanged';
      // Metadata may have committed before a failed append/mirror. Repeating
      // that decision heals effects without inventing a new decision time or
      // sending a second decision email.
      const repaired = repairAuthoritativeAttendanceEffects({
        backendSheet: opts.backendSheet, data: opts.data, idx: opts.idx,
        requestIds: new Set([opts.requestId]),
      });
      return repaired.repaired || repaired.metadataRepaired || repaired.projected ? 'updated' : 'unchanged';
    }

    const rowNumber = targetRow + 3;
    const nowIso = new Date().toISOString();
    const value = (index: number, fallback = '') => index >= 0
      ? String(opts.data[targetRow][index] || fallback)
      : fallback;
    const lastName = value(opts.idx.last);
    const firstName = value(opts.idx.first);
    const eventName = value(opts.idx.event);
    const cadetEmail = value(opts.idx.email);
    const squadron = value(opts.idx.squadron);
    const reason = value(opts.idx.reason);
    const requestedOutcome = value(opts.idx.requestedOutcome, 'E');
    const priorAttendanceCode = value(opts.idx.priorAttendanceCode);
    const latest = opts.repairLogState?.get(attendanceStateKey(eventName, lastName, firstName));
    if (opts.deferAttendanceEffects && latest && latest.code !== 'R') {
      // A management dropdown has no original decision timestamp. Replaying it
      // as a new decision could erase an intervening attendance report/clear.
      // Require evidence rather than inventing that ordering during repair.
      AuditService.log({ action: 'excusal_decision_repair_review_required', result: 'ok', role: 'admin_repair',
        targetSheet: 'Excusals Backend', targetKey: opts.requestId, requestId: opts.requestId, source: opts.source,
        metadata: { reason: 'Original decision time is unknown and attendance is no longer pending.' } });
      return 'review';
    }
    const attendanceEffect = effectForDecision({
      decision: opts.decision,
      requestedOutcome,
      priorAttendanceCode,
      currentAttendanceCode: lookupMatrixValue(eventName, lastName, firstName),
      eventName,
    });
    const isDecisionChange = !!(oldDecision && oldDecision !== opts.decision);

    const setValue = (index: number, cellValue: any) => {
      if (index < 0) return;
      opts.backendSheet.getRange(rowNumber, index + 1).setValue(cellValue);
      opts.data[targetRow][index] = cellValue;
    };
    setValue(opts.idx.decision, opts.decision);
    setValue(opts.idx.decidedBy, opts.actorEmail);
    setValue(opts.idx.decidedAt, nowIso);
    setValue(opts.idx.lastUpdated, nowIso);
    setValue(opts.idx.attendanceEffect, attendanceEffect);
    // Status is the final metadata checkpoint. A partial metadata write must
    // not be mistaken for a completely recorded decision on retry.
    setValue(opts.idx.status, opts.decision);

    const appended = !opts.deferAttendanceEffects && updateAttendanceOnExcusalDecision({
      lastName,
      firstName,
      eventName,
      decision: opts.decision,
      requestedOutcome,
      priorAttendanceCode,
      attendanceEffect,
      requestId: opts.requestId,
      decisionAt: nowIso,
    });

    if (opts.notifyCadet && appended) {
      sendExcusalDecisionEmail({
        cadetEmail,
        cadetFirstName: firstName,
        cadetLastName: lastName,
        event: eventName,
        decision: opts.decision,
        previousDecision: isDecisionChange ? oldDecision : undefined,
        reason,
        squadron,
      });
    }

    Log.info(
      `Mirrored management decision for request ${opts.requestId}: ${opts.decision}`
      + `${isDecisionChange ? ` (was ${oldDecision})` : ''}`,
    );
    AuditService.log({
      action: 'excusal_decision_recorded',
      result: 'ok',
      actorEmail: opts.actorEmail || undefined,
      role: opts.actorRole,
      targetSheet: 'Excusals Backend',
      targetTable: 'Excusals Backend',
      targetKey: opts.requestId,
      requestId: opts.requestId,
      field: 'decision',
      oldValue: oldDecision,
      newValue: opts.decision,
      source: opts.source,
      metadata: { event: eventName, squadron, attendanceEffect, managementSheet: opts.managementSheet },
    });
    return 'updated';
  }

  function repairAttendancePresentation() {
    const frontendId = Config.getFrontendId();
    if (!frontendId) return;
    try {
      FrontendFormattingService.repairAttendanceInputs(frontendId);
    } catch (err) {
      Log.warn(`Unable to restore Attendance presentation after excusal decisions: ${err}`);
    }
  }

  function attendanceStateKey(eventName: any, lastName: any, firstName: any): string {
    const normalize = (value: any) => String(value || '').trim().toLowerCase();
    return `${normalize(eventName)}|${normalize(lastName)}|${normalize(firstName)}`;
  }

  function attendanceLogCadets(raw: any): Array<{ last: string; first: string }> {
    return String(raw || '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [namePart] = entry.split('=');
        const cleaned = namePart.replace(/\(AS[^)]*\)/gi, '').trim();
        const [last, ...firstParts] = cleaned.split(',').map((part) => part.trim());
        return { last: last || '', first: firstParts.join(',').trim() };
      })
      .filter((cadet) => !!(cadet.last || cadet.first));
  }

  interface EffectiveAttendanceState {
    code: string;
    timestamp: number;
    submissionId: string;
    position: number;
  }

  function readAttendanceLogState(): { state: Map<string, EffectiveAttendanceState>; receiptIds: Set<string>; history: Map<string, EffectiveAttendanceState[]> } {
    const state = new Map<string, EffectiveAttendanceState>();
    const receiptIds = new Set<string>();
    const history = new Map<string, EffectiveAttendanceState[]>();
    const sheet = SheetUtils.getSheet(Config.getBackendId(), 'Attendance Backend');
    if (!sheet) throw new Error('Attendance Backend is unavailable. No excusal effect was applied.');
    if (sheet.getLastRow() < 3) return { state, receiptIds, history };
    const table = SheetUtils.readTable(sheet);
    table.rows.forEach((row, position) => {
      const submissionId = String(row['submission_id'] || '');
      if (submissionId) receiptIds.add(submissionId);
      const eventName = String(row['event'] || '').trim();
      if (!eventName) return;
      const code = normalizeAttendanceCode(row['attendance_type']);
      const timestamp = new Date(row['submitted_at']).getTime();
      attendanceLogCadets(row['cadets']).forEach((cadet) => {
        const key = attendanceStateKey(eventName, cadet.last, cadet.first);
        const entry = {
          code,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
          submissionId,
          position,
        };
        state.set(key, entry);
        const entries = history.get(key) || [];
        entries.push(entry);
        history.set(key, entries);
      });
    });
    return { state, receiptIds, history };
  }

  function decisionLogEntry(opts: {
    requestId: string; decision: string; decisionAt: number; code: string;
    eventName: string; lastName: string; firstName: string; afterPosition?: number;
  }): Record<string, any> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(opts.requestId) || !Number.isFinite(opts.decisionAt)) {
      throw new Error('Excusal decision identity or date is invalid. Review the request before retrying.');
    }
    return {
      submission_id: `excusal-decision-${opts.requestId}-${opts.decisionAt}-${opts.decision}-${opts.code || 'clear'}${opts.afterPosition === undefined ? '' : `-after-${opts.afterPosition}`}`,
      submitted_at: new Date(), event: opts.eventName, attendance_type: opts.code,
      email: 'excusal-decision', name: 'Excusal Decision', flight: '', cadets: `${opts.lastName}, ${opts.firstName}`,
    };
  }

  function decisionTimestamp(dataRow: any[], idx: Record<string, number>, rowIndex: number): number {
    for (const index of [idx.decidedAt, idx.lastUpdated, idx.submittedAt]) {
      if (index < 0) continue;
      const time = new Date(dataRow[index]).getTime();
      if (Number.isFinite(time)) return time;
    }
    return rowIndex;
  }

  function repairAuthoritativeAttendanceEffects(opts: {
    backendSheet: GoogleAppsScript.Spreadsheet.Sheet;
    data: any[][];
    idx: Record<string, number>;
    requestIds?: Set<string>;
  }): { checked: number; repaired: number; metadataRepaired: number; preserved: number; projected: number; conflicts: number; skipped: number } {
    const { state: effectiveLogState, history } = readAttendanceLogState();
    const finalByCadetEvent = new Map<string, {
      rowIndex: number;
      timestamp: number;
      requestId: string;
      decision: string;
      requestedOutcome: string;
      priorAttendanceCode: string;
      lastName: string;
      firstName: string;
      eventName: string;
    }>();
    let metadataRepaired = 0;

    opts.data.forEach((row, rowIndex) => {
      const value = (index: number, fallback = '') => index >= 0 ? String(row[index] || fallback).trim() : fallback;
      const decision = value(opts.idx.decision);
      const eventName = value(opts.idx.event);
      const lastName = value(opts.idx.last);
      const firstName = value(opts.idx.first);
      if (!isDecisionValue(decision) || !eventName || (!lastName && !firstName)) return;

      const key = attendanceStateKey(eventName, lastName, firstName);
      const requestedOutcome = value(opts.idx.requestedOutcome, 'E');
      const priorAttendanceCode = value(opts.idx.priorAttendanceCode);
      const expectedEffect = effectForDecision({
        decision,
        requestedOutcome,
        priorAttendanceCode,
        currentAttendanceCode: effectiveLogState.get(key)?.code || '',
        eventName,
      });
      if ((!opts.requestIds || opts.requestIds.has(value(opts.idx.request))) && opts.idx.attendanceEffect >= 0 && value(opts.idx.attendanceEffect) !== expectedEffect) {
        opts.backendSheet.getRange(rowIndex + 3, opts.idx.attendanceEffect + 1).setValue(expectedEffect);
        row[opts.idx.attendanceEffect] = expectedEffect;
        metadataRepaired++;
      }

      const candidate = {
        rowIndex,
        timestamp: decisionTimestamp(row, opts.idx, rowIndex),
        requestId: value(opts.idx.request),
        decision,
        requestedOutcome,
        priorAttendanceCode,
        lastName,
        firstName,
        eventName,
      };
      const current = finalByCadetEvent.get(key);
      if (!current || candidate.timestamp > current.timestamp || (
        candidate.timestamp === current.timestamp && candidate.rowIndex > current.rowIndex
      )) {
        finalByCadetEvent.set(key, candidate);
      }
    });

    // Historical decisions remain in the request log after events or cadets
    // leave the current matrix. They must not recreate removed event columns.
    const matrix = SheetUtils.getSheet(Config.getBackendId(), 'Attendance Matrix Backend');
    const events = SheetUtils.getSheet(Config.getBackendId(), 'Events Backend');
    if (!matrix || !events) throw new Error('Attendance matrix or Events Backend is unavailable.');
    const matrixTable = SheetUtils.readTable(matrix);
    const currentIdentities = new Set(matrixTable.rows.map(row => attendanceStateKey('', row['last_name'], row['first_name'])));
    const activeEvents = new Set(SheetUtils.readTable(events).rows.filter(row =>
      !['cancelled', 'canceled', 'inactive', 'archived', 'n/a'].includes(String(row['status'] || '').trim().toLowerCase()),
    ).map(row => String(row['display_name'] || row['attendance_column_label'] || row['event_id'] || '').trim()));
    const corrections: Record<string, any>[] = [];
    const projections: Record<string, any>[] = [];
    const audits: Array<() => void> = [];
    let preserved = 0;
    let checked = 0;
    let skipped = 0;
    finalByCadetEvent.forEach((candidate, key) => {
      if (opts.requestIds && !opts.requestIds.has(candidate.requestId)) return;
      checked++;
      if (!activeEvents.has(candidate.eventName) || !matrixTable.headers.includes(candidate.eventName)
        || !currentIdentities.has(attendanceStateKey('', candidate.lastName, candidate.firstName))) {
        skipped++;
        return;
      }
      const effective = effectiveLogState.get(key);
      // Reconciliation repairs a missing decision effect; it must not roll back
      // a later attendance report, manual correction, or newly pending request.
      const sameDecisionLog = effective?.submissionId.startsWith(`excusal-decision-${candidate.requestId}-`);
      const samePendingLog = effective?.submissionId === `excusal-request-${candidate.requestId}`;
      const decisionPosition = (history.get(key) || []).reduce((position, entry) =>
        entry.submissionId.startsWith(`excusal-decision-${candidate.requestId}-`)
          && (entry.timestamp >= candidate.timestamp || entry.submissionId.startsWith(`excusal-decision-${candidate.requestId}-${candidate.timestamp}-${candidate.decision}-`))
          ? Math.max(position, entry.position) : position, -1);
      const laterIndependent = effective && (!effective.timestamp || effective.timestamp > candidate.timestamp
        || (decisionPosition >= 0 && effective.position > decisionPosition));
      if (effective && laterIndependent && !sameDecisionLog && !samePendingLog) {
        preserved++;
        // A newer independent value remains authoritative, including a clear.
        // Repair only stale pending projections of that value, never replay the
        // older decision over the newer log entry.
        projections.push({ event: candidate.eventName, attendance_type: effective.code, cadets: `${candidate.lastName}, ${candidate.firstName}` });
        return;
      }
      const expectedEffect = effectForDecision({
        decision: candidate.decision,
        requestedOutcome: candidate.requestedOutcome,
        priorAttendanceCode: candidate.priorAttendanceCode,
        currentAttendanceCode: effective?.code || '',
        eventName: candidate.eventName,
      });
      projections.push({ event: candidate.eventName, attendance_type: expectedEffect, cadets: `${candidate.lastName}, ${candidate.firstName}` });
      if (effective && effective.code === expectedEffect) return;
      corrections.push(decisionLogEntry({ ...candidate, decisionAt: candidate.timestamp, code: expectedEffect, afterPosition: effective?.position ?? -1 }));
      audits.push(() => AuditService.log({
        action: 'excusal_attendance_repaired',
        result: 'ok',
        role: 'admin_repair',
        targetSheet: 'Attendance Backend',
        targetTable: 'Attendance Backend',
        targetKey: candidate.requestId,
        requestId: candidate.requestId,
        field: 'attendance_type',
        oldValue: effective?.code || '',
        newValue: expectedEffect,
        source: 'ExcusalsService.reconcileManagementDecisions',
        metadata: { event: candidate.eventName, decision: candidate.decision },
      }));
    });
    const batches = projections.length ? AttendanceService.prepareAttendanceProjections(projections, { frontendPendingOnly: true }) : [];
    const projected = batches.reduce((count, batch) => count + batch.updates.reduce((n, update) => n + update.values.length, 0), 0);
    const conflicts = batches.reduce((count, batch) => count + batch.conflicts, 0);
    // Preflight all targets once, persist all missing effects once, then mirror
    // sparse cells. A failed mirror is repaired from the saved log on retry.
    appendAttendanceLogs(corrections);
    AttendanceService.applyPreparedAttendanceProjections(batches);
    audits.forEach(audit => audit());
    if (projected || conflicts || skipped) AuditService.log({
      action: 'excusal_attendance_projections_reconciled', result: 'ok', role: 'admin_repair',
      targetSheet: 'Attendance', source: 'ExcusalsService.reconcileManagementDecisions',
      metadata: { projectedCells: projected, preservedFrontendCells: conflicts, skippedHistoricalTargets: skipped },
    });
    return { checked, repaired: corrections.length, metadataRepaired, preserved, projected, conflicts, skipped };
  }

  /**
   * Repair decisions that are present in the commander-facing workbook but did
   * not reach the authoritative backend, then verify that every authoritative
   * decided excusal reached the effective Attendance Backend log. This
   * intentionally does not resend cadet notification emails for historical decisions.
   */
  export function reconcileManagementDecisions(): {
    scanned: number;
    repaired: number;
    missing: number;
    reviewRequired: number;
    attendanceChecked: number;
    attendanceRepaired: number;
    metadataRepaired: number;
    attendancePreserved: number;
    attendanceProjected: number;
    attendanceConflicts: number;
    attendanceSkipped: number;
  } {
    const lock = LockService.getScriptLock();
    lock.waitLock(120000);
    try {
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    const backendId = Config.getBackendId();
    if (!managementId || !backendId) {
      throw new Error('Excusals Management or backend workbook is not configured.');
    }

    const backendSheet = SheetUtils.getSheet(backendId, 'Excusals Backend');
    if (!backendSheet || backendSheet.getLastRow() < 3) {
      throw new Error('Excusals Backend is missing or has no request rows.');
    }

    const headers = backendSheet
      .getRange(1, 1, 1, backendSheet.getLastColumn())
      .getValues()[0]
      .map((header) => String(header || '').trim());
    const idx = excusalsBackendIndexes(headers);
    if (idx.request < 0 || idx.decision < 0) {
      throw new Error('Excusals Backend is missing request_id or decision.');
    }

    const data = backendSheet.getRange(3, 1, backendSheet.getLastRow() - 2, headers.length).getValues();
    const management = SpreadsheetApp.openById(managementId);
    const managementHeaders = Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || [];
    const requestCol = managementHeaders.indexOf('request_id');
    const decisionCol = managementHeaders.indexOf('decision');
    if (requestCol < 0 || decisionCol < 0) {
      throw new Error('Excusals Management schema is missing request_id or decision.');
    }

    const actorEmail = currentUserEmail();
    let scanned = 0;
    let repaired = 0;
    let missing = 0;
    let reviewRequired = 0;
    const repairLogState = readAttendanceLogState().state;
    const sheets = management.getSheets().filter((sheet) => Arrays.OPERATIONAL_SQUADRONS.includes(sheet.getName()));

    sheets.forEach((sheet, sheetIndex) => {
      ProgressService.report({
        title: `Checking ${sheet.getName()} decisions`,
        detail: 'Comparing commander selections with the authoritative excusals records.',
        percent: 20 + Math.round((sheetIndex / Math.max(1, sheets.length)) * 55),
        step: sheetIndex + 1,
        totalSteps: sheets.length + 1,
      });
      const lastRow = sheet.getLastRow();
      if (lastRow < 3) return;
      const rows = sheet.getRange(3, 1, lastRow - 2, managementHeaders.length).getValues();
      rows.forEach((row) => {
        const requestId = String(row[requestCol] || '').trim();
        const decision = String(row[decisionCol] || '').trim();
        if (!requestId || !isDecisionValue(decision)) return;
        scanned++;
        const result = applyManagementDecision({
          backendSheet,
          headers,
          data,
          idx,
          requestId,
          decision,
          actorEmail,
          actorRole: 'admin_repair',
          source: 'ExcusalsService.reconcileManagementDecisions',
          managementSheet: sheet.getName(),
          notifyCadet: false,
          deferAttendanceEffects: true,
          repairLogState,
        });
        if (result === 'updated') repaired++;
        if (result === 'missing') missing++;
        if (result === 'review') reviewRequired++;
      });
    });

    const attendance = repairAuthoritativeAttendanceEffects({ backendSheet, data, idx });
    if (repaired > 0 || attendance.repaired > 0 || attendance.metadataRepaired > 0 || attendance.projected > 0) {
      repairAttendancePresentation();
    }
    Log.info(
      `Reconciled excusal decisions: managementScanned=${scanned}, managementRepaired=${repaired}, missing=${missing}, reviewRequired=${reviewRequired} `
      + `attendanceChecked=${attendance.checked}, attendanceRepaired=${attendance.repaired} `
      + `metadataRepaired=${attendance.metadataRepaired}, attendancePreserved=${attendance.preserved} `
      + `attendanceProjected=${attendance.projected}, attendanceConflicts=${attendance.conflicts}, attendanceSkipped=${attendance.skipped}`,
    );
    return {
      scanned,
      repaired,
      missing,
      reviewRequired,
      attendanceChecked: attendance.checked,
      attendanceRepaired: attendance.repaired,
      metadataRepaired: attendance.metadataRepaired,
      attendancePreserved: attendance.preserved,
      attendanceProjected: attendance.projected,
      attendanceConflicts: attendance.conflicts,
      attendanceSkipped: attendance.skipped,
    };
    } finally {
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
    }
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
    requestId: string;
    decisionAt: string;
  }): boolean {
    return AttendanceService.withWriteLock(() => {
      const code = opts.attendanceEffect ?? effectForDecision({
        decision: opts.decision,
        requestedOutcome: opts.requestedOutcome || 'E',
        priorAttendanceCode: opts.priorAttendanceCode || '',
        currentAttendanceCode: lookupMatrixValue(opts.eventName, opts.lastName, opts.firstName),
        eventName: opts.eventName,
      });

      const logEntry = decisionLogEntry({ ...opts, decisionAt: new Date(opts.decisionAt).getTime(), code });
      const log = readAttendanceLogState();
      if (log.receiptIds.has(logEntry.submission_id)) return false;
      const projections = AttendanceService.prepareAttendanceProjections([logEntry]);
      appendAttendanceLogs([logEntry]);
      AttendanceService.applyPreparedAttendanceProjections(projections);
      return true;
    });
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
    if (!backendId) throw new Error('Backend workbook is not configured. No excusal attendance was saved.');
    const sheet = SheetUtils.getSheet(backendId, 'Attendance Backend');
    if (!sheet) throw new Error('Attendance Backend is unavailable. No excusal attendance was saved.');
    SheetUtils.appendRows(sheet, logs);
    // Apps Script buffers SpreadsheetApp writes. Confirm the durable log before
    // any Sheets API projection request, including inside an already-held lock.
    SpreadsheetApp.flush();
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
      const tableReady = SetupService.ensureTableForSheet(backendId, archiveName, archiveName);
      const decisionColumn = (Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || []).indexOf('decision') + 1;
      if (decisionColumn > 0) {
        sheet.getRange(3, decisionColumn, Math.max(1, sheet.getMaxRows() - 2), 1).clearDataValidations();
      }
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
      if (!tableReady) throw new Error(`Unable to create the required archive table for ${archiveName}.`);
    };
    Arrays.OPERATIONAL_SQUADRONS.forEach((squadron) => {
      const source = management.getSheetByName(squadron);
      if (!source || source.getLastRow() < 3) return;
      const archiveName = `${safeLabel} ${squadron} Excusals ${safeKey}`;
      const existing = archiveWorkbook.getSheetByName(archiveName);
      if (existing) {
        lockArchive(existing, archiveName);
        try {
          ensureManagementPresentation(management);
        } finally {
          applyManagementSheetProtections(management);
        }
        archivedNames.push(archiveName);
        return;
      }
      const decisionColumn = (Schemas.EXCUSALS_MANAGEMENT_SCHEMA.machineHeaders || []).indexOf('decision') + 1;
      const sourceDecisionRange = decisionColumn > 0
        ? source.getRange(3, decisionColumn, Math.max(1, source.getMaxRows() - 2), 1)
        : null;
      if (sourceDecisionRange) sourceDecisionRange.clearDataValidations();
      let archived: GoogleAppsScript.Spreadsheet.Sheet;
      let restoreError: any = null;
      try {
        archived = source.copyTo(archiveWorkbook).setName(archiveName);
      } finally {
        try {
          ensureManagementPresentation(management);
        } catch (err) {
          restoreError = err;
        } finally {
          applyManagementSheetProtections(management);
        }
      }
      lockArchive(archived, archiveName);
      if (restoreError) throw restoreError;
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
    ensureManagementPresentation(ss);
    shareAndProtectManagementSpreadsheet();
    Log.info('Reset active Excusals management sheets and refreshed current-term access');
  }

  /** Apply protections so only each squadron commander can edit Decision cells on their squadron tab. */
  function applyManagementSheetProtections(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, admins = managementAdminEmails()) {
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

      // Protect header rows (1-2): owner and backend administrators only.
      const headerRange = sheet.getRange(1, 1, 2, lastCol);
      try {
        const headerProt = headerRange.protect().setDescription(`${sheetName}: Headers protected`);
        headerProt.setWarningOnly(false);
        try { headerProt.removeEditors(headerProt.getEditors()); } catch {}
        if (admins.length) headerProt.addEditors(admins);
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
            if (admins.length) protection.addEditors(admins);
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
            if (admins.length) decisionProtection.addEditors(admins);
            if (decisionProtection.canDomainEdit()) decisionProtection.setDomainEdit(false);
            if (commanderEmail) decisionProtection.addEditor(commanderEmail);
            else Log.warn(`No commander email found for ${sheetName}; Decision cells will be administrator-only`);
          } catch (err) {
            Log.warn(`Failed to protect Decision cells on ${sheetName}: ${err}`);
          }
        }
      }

      Log.info(`Applied Decision-only editing protections on ${sheetName}; commander=${commanderEmail || 'none'}`);
    });
  }
}
