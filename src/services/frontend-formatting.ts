// Frontend formatting: apply Data Legend validations and table-adjacent layout.

namespace FrontendFormattingService {
  interface NamedRangeDef {
    name: string;
    range: GoogleAppsScript.Spreadsheet.Range;
  }

  const ATTENDANCE_SCHEMA = Schemas.getTabSchema('Attendance');
  const ATTENDANCE_BASE_HEADERS = ATTENDANCE_SCHEMA?.machineHeaders || ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'llab_attendance_pct'];
  const ATT_HEADER_OVERALL = ATTENDANCE_BASE_HEADERS.find((h) => h.includes('overall_attendance')) || 'overall_attendance_pct';
  const ATT_HEADER_LLAB = ATTENDANCE_BASE_HEADERS.find((h) => h.includes('llab_attendance')) || 'llab_attendance_pct';
  const STANDARD_COLUMN_WIDTHS: Record<string, number> = {
    last_name: 115,
    first_name: 115,
    as_year: 75,
    flight: 75,
    squadron: 75,
    rank: 75,
    university: 100,
    phone: 125,
    cell_phone: 125,
    office_phone: 125,
    dorm: 150,
    cip_code: 75,
    class_year: 75,
    dob: 100,
    flight_path_status: 125,
    photo_link: 100,
  };
  const DIRECTORY_FIT_TO_DATA_COLUMNS = [
    'role',
    'email',
    'cip_broad_area',
    'desired_assigned_afsc',
    'home_town',
    'home_state',
  ];
  const LEADERSHIP_FIT_TO_DATA_COLUMNS = ['role', 'email', 'office_location'];

  function openFrontend(frontendId: string): GoogleAppsScript.Spreadsheet.Spreadsheet | null {
    if (!frontendId) return null;
    try {
      return SpreadsheetApp.openById(frontendId);
    } catch (err) {
      Log.warn(`Unable to open frontend spreadsheet ${frontendId}: ${err}`);
      return null;
    }
  }

  function buildNamedRanges(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): NamedRangeDef[] {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return [];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());

    const mapping: Record<string, string> = {
      as_year_options: 'AS_YEARS',
      cadet_rank_options: 'CADET_RANKS',
      rank_options: 'RANKS',
      honorific_options: 'HONORIFICS',
      flight_options: 'FLIGHTS',
      squadron_options: 'SQUADRONS',
      university_options: 'UNIVERSITIES',
      dorm_options: 'DORMS',
      home_state_options: 'HOME_STATES',
      cip_broad_area_options: 'CIP_BROAD_AREAS',
      afsc_options: 'AFSC_OPTIONS',
      flight_path_status_options: 'FLIGHT_PATH_STATUSES',
      attendance_code_options: 'ATTENDANCE_CODES',
      excusal_decision_options: 'EXCUSAL_DECISIONS',
      excusal_status_options: 'EXCUSAL_STATUSES',
      excusal_requested_outcome_options: 'EXCUSAL_REQUESTED_OUTCOMES',
    };

    const lastRow = sheet.getLastRow();
    const defs: NamedRangeDef[] = [];
    headers.forEach((header, idx) => {
      const rangeName = mapping[header];
      if (!rangeName) return;
      const col = idx + 1;
      const rowsCount = Math.max(0, lastRow - 2);
      if (rowsCount === 0) return;
      const values = sheet.getRange(3, col, rowsCount, 1).getValues().map((r) => String(r[0] || ''));
      let nonEmpty = -1;
      for (let i = values.length - 1; i >= 0; i--) {
        if (values[i].trim() !== '') {
          nonEmpty = i;
          break;
        }
      }
      if (nonEmpty < 0) return;
      const length = nonEmpty + 1;
      const range = sheet.getRange(3, col, length, 1);
      defs.push({ name: rangeName, range });
    });
    return defs;
  }

  function applyDirectoryValidations(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;

    try {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || ''));
      const headerIndex = (name: string) => headers.indexOf(name);

      const map: Record<string, string> = {
        as_year: 'AS_YEARS',
        rank: 'CADET_RANKS',
        flight: 'FLIGHTS',
        squadron: 'SQUADRONS',
        university: 'UNIVERSITIES',
        dorm: 'DORMS',
        home_state: 'HOME_STATES',
        cip_broad_area: 'CIP_BROAD_AREAS',
        cip_code: 'CIP_CODES',
        desired_assigned_afsc: 'AFSC_OPTIONS',
        flight_path_status: 'FLIGHT_PATH_STATUSES',
      };

      const dataRows = Math.max(1, sheet.getMaxRows() - 2);
      ['last_name', 'first_name', 'role', 'email', 'phone', 'class_year', 'dob'].forEach((field) => {
        const colIdx = headerIndex(field);
        if (colIdx < 0) return;
        try {
          sheet.getRange(3, colIdx + 1, dataRows, 1).clearDataValidations();
        } catch (err) {
          Log.warn(`Skipping Directory stale validation clear on ${field}: ${err}`);
        }
      });

      Object.entries(map).forEach(([field, rangeName]) => {
        const colIdx = headerIndex(field);
        if (colIdx < 0) return;
        const namedRange = ss.getRangeByName(rangeName);
        if (!namedRange) return;
        const dataRange = sheet.getRange(3, colIdx + 1, dataRows, 1);
        const showDropdown = !['as_year', 'rank', 'university'].includes(field);
        const rule = SpreadsheetApp.newDataValidation()
          .requireValueInRange(namedRange, showDropdown)
          .setAllowInvalid(false)
          .build();
        try {
          dataRange.clearDataValidations();
          dataRange.setDataValidation(rule);
        } catch (err) {
          Log.warn(`Skipping Directory validation on column ${colIdx + 1} due to typed column/table constraints: ${err}`);
        }
      });
    } catch (err) {
      // Catch-all: typed columns (Tables) or other new Sheets features may block validation writes.
      Log.warn(`Skipping Directory validations due to sheet constraints: ${err}`);
    }
  }

  function applyLeadershipValidations(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;

    try {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || ''));
      const dataRows = Math.max(1, sheet.getMaxRows() - 2);
      const rankIdx = headers.indexOf('rank');
      if (rankIdx < 0) return;
      const rankRange = getLeadershipRankRange(ss);
      if (!rankRange) return;
      const dataRange = sheet.getRange(3, rankIdx + 1, dataRows, 1);
      dataRange.clearDataValidations();
      dataRange.setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInRange(rankRange, false)
          .setAllowInvalid(false)
          .build(),
      );
    } catch (err) {
      Log.warn(`Skipping Leadership rank validation due to sheet constraints: ${err}`);
    }
  }

  function getLeadershipRankRange(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): GoogleAppsScript.Spreadsheet.Range | null {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return null;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const indexes = ['cadet_rank_options', 'rank_options', 'honorific_options']
      .map((header) => headers.indexOf(header))
      .filter((idx) => idx >= 0);
    if (!indexes.length) return ss.getRangeByName('RANKS');

    const startCol = Math.min(...indexes) + 1;
    const endCol = Math.max(...indexes) + 1;
    const values = sheet.getRange(3, startCol, Math.max(1, sheet.getLastRow() - 2), endCol - startCol + 1).getValues();
    let lastNonEmpty = -1;
    values.forEach((row, idx) => {
      if (row.some((cell) => String(cell || '').trim())) lastNonEmpty = idx;
    });
    if (lastNonEmpty < 0) return null;
    return sheet.getRange(3, startCol, lastNonEmpty + 1, endCol - startCol + 1);
  }

  function applyAttendanceValidations(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const namedRange = ss.getRangeByName('ATTENDANCE_CODES');
    if (!namedRange) return;

    const applyToSheet = (sheetName: string) => {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return;
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim().toLowerCase());
      if (!headers.length) return;
      const fixed = new Set(ATTENDANCE_BASE_HEADERS.map((h) => h.toLowerCase()));
      const startRow = 3;
      const numRows = Math.max(1, sheet.getMaxRows() - 2);
      headers.forEach((h, idx) => {
        if (fixed.has(h)) return;
        const col = idx + 1;
        const dataRange = sheet.getRange(startRow, col, numRows, 1);
        const rule = SpreadsheetApp.newDataValidation()
          .requireValueInRange(namedRange, true)
          .setAllowInvalid(false)
          .build();
        try {
          dataRange.setDataValidation(rule);
        } catch (err) {
          Log.warn(`Skipping ${sheetName} attendance validation on column ${col} due to typed column/table constraints: ${err}`);
        }
      });
    };

    applyToSheet('Attendance');
    applyToSheet('Attendance Matrix Backend');
  }

  function applyValidationRules(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    applyDirectoryValidations(ss);
    applyLeadershipValidations(ss);
    applyAttendanceValidations(ss);
  }

  function clearLegacyBandingFromFrontendTables(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    ['Directory', 'Leadership', 'Attendance', 'Data Legend'].forEach((name) => {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      try {
        sheet.getBandings().forEach((banding) => banding.remove());
      } catch (err) {
        Log.warn(`Unable to remove legacy banding on ${name}: ${err}`);
      }
    });
  }

  export function applyAll(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    const namedRanges = buildNamedRanges(ss);
    namedRanges.forEach((def) => {
      try {
        ss.setNamedRange(def.name, def.range);
      } catch (err) {
        Log.warn(`Unable to set named range ${def.name}: ${err}`);
      }
    });

    clearLegacyBandingFromFrontendTables(ss);

    if (!shouldSkipColumnWidths()) {
      applyDirectoryColumnWidths(ss);
      applyLeadershipColumnWidths(ss);
      applyAttendanceColumnWidths(ss);
      applyDataLegendColumnWidths(ss);
    }

    const skipFormatting = shouldSkipSheetFormatting();
    if (skipFormatting) {
      Log.info(`${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING}=true; validations still applied. Running minimal layout for Dashboard/FAQs.`);
      applyDashboardFormatting(ss); // keep layout populated so Dashboard isn’t blank
      applyFaqsFormatting(ss); // keep the mobile-friendly FAQ layout even when formatting is disabled
      ensureFaqLayout(ss);
      applyValidationRules(ss);
      return;
    }

    freezeTopTwoRowsAllSheets(ss); // Skip freezing rows on FAQs
    applyDirectoryFormatting(ss);
    applyLeadershipFormatting(ss);
    applyDashboardFormatting(ss);
    applyFaqsFormatting(ss);
    applyDataLegendFormatting(ss);
    applyAttendanceFormatting(ss);
    ensureFaqLayout(ss);
    applyValidationRules(ss);
  }

  export function applyValidations(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    const namedRanges = buildNamedRanges(ss);
    namedRanges.forEach((def) => {
      try {
        ss.setNamedRange(def.name, def.range);
      } catch (err) {
        Log.warn(`Unable to set named range ${def.name}: ${err}`);
      }
    });
    applyValidationRules(ss);
  }

  // Final safety net to keep FAQs as one mobile-friendly column without forcing all content into one cell.
  function ensureFaqLayout(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('FAQs');
    if (!sheet) return;
    try {
      sheet.setFrozenRows(0);
      sheet.setFrozenColumns(0);
      sheet.setColumnWidth(1, 1000);
      if (sheet.getMaxRows() < 12) sheet.insertRowsAfter(sheet.getMaxRows(), 12 - sheet.getMaxRows());
      const maxRows = sheet.getMaxRows();
      sheet.getRange(1, 1, maxRows, 1).setWrap(true).setVerticalAlignment('top').setHorizontalAlignment('left');
    } catch (err) {
      Log.warn(`Unable to enforce FAQ layout: ${err}`);
    }
  }

  export function applyDashboardOnly(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    applyDashboardFormatting(ss);
  }

  function freezeTopTwoRowsAllSheets(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    ss.getSheets()
      .filter(sheet => {
        const name = sheet.getName();
        return name !== 'FAQs' && name !== 'Dashboard';
      })
      .forEach(sheet => freezeTopTwoRows(sheet));
  }

  function hideMachineHeaderRow(sheet: GoogleAppsScript.Spreadsheet.Sheet | null) {
    if (!sheet) return;
    try {
      sheet.hideRows(1);
    } catch (err) {
      Log.warn(`Unable to hide row 1 on ${sheet.getName()}: ${err}`);
    }
  }

  function pruneTrailingRows(sheet: GoogleAppsScript.Spreadsheet.Sheet | null) {
    if (!sheet) return;
    SheetUtils.trimTrailingBlankRows(sheet);
  }

  function setDefaultFont(sheet: GoogleAppsScript.Spreadsheet.Sheet | null) {
    if (!sheet) return;
    const lastRow = Math.max(2, sheet.getMaxRows());
    const lastCol = Math.max(1, sheet.getMaxColumns());
    sheet.getRange(1, 1, lastRow, lastCol).setFontFamily('Roboto').setFontSize(10);
  }

  function freezeTopTwoRows(sheet: GoogleAppsScript.Spreadsheet.Sheet | null) {
    if (!sheet) return;
    try {
      sheet.setFrozenRows(2);
    } catch (err) {
      Log.warn(`Unable to freeze rows on ${sheet.getName()}: ${err}`);
    }
  }

  function shouldSkipSheetFormatting(): boolean {
    try {
      return Config.getBooleanScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING} property: ${err}`);
      return false;
    }
  }

  function shouldSkipColumnWidths(): boolean {
    try {
      return Config.getBooleanScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS} property: ${err}`);
      return false;
    }
  }

  function setColumnWidths(sheet: GoogleAppsScript.Spreadsheet.Sheet, widths: Record<string, number>) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    Object.entries(widths).forEach(([header, width]) => {
      const idx = headers.indexOf(header);
      if (idx >= 0) sheet.setColumnWidth(idx + 1, width);
    });
  }

  function autoResizeColumnsByHeader(sheet: GoogleAppsScript.Spreadsheet.Sheet, headerNames: string[]) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    headerNames.forEach((header) => {
      const idx = headers.indexOf(header);
      if (idx >= 0) sheet.autoResizeColumn(idx + 1);
    });
  }

  function applyStandardColumnWidths(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    fixedHeaders: string[],
    fitHeaders: string[],
  ) {
    const fixedWidths: Record<string, number> = {};
    fixedHeaders.forEach((header) => {
      const width = STANDARD_COLUMN_WIDTHS[header];
      if (width) fixedWidths[header] = width;
    });
    setColumnWidths(sheet, fixedWidths);
    autoResizeColumnsByHeader(sheet, fitHeaders);
  }

  function setHeaderLabels(sheet: GoogleAppsScript.Spreadsheet.Sheet, mapping: Record<string, string>) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const display = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    let dirty = false;
    headers.forEach((h, idx) => {
      if (mapping[h]) {
        display[idx] = mapping[h];
        dirty = true;
      }
    });
    if (dirty) sheet.getRange(2, 1, 1, sheet.getLastColumn()).setValues([display]);
  }

  function normalizeDirectoryHeaders(sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    const headers = headerRange.getValues()[0].map((h) => String(h || '').trim());
    const phoneDisplayIdx = headers.indexOf('phone_display');
    if (phoneDisplayIdx >= 0) {
      headers[phoneDisplayIdx] = 'phone';
      headerRange.setValues([headers]);
    }
  }

  function extractDriveFileChipUri(value: unknown, richText?: GoogleAppsScript.Spreadsheet.RichTextValue | null): string {
    const linkUrl = richText?.getLinkUrl() || '';
    const text = String(linkUrl || value || '').trim();
    if (!text) return '';

    const fileMatch = text.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const idParamMatch = text.match(/[?&]id=([A-Za-z0-9_-]+)/);
    const rawIdMatch = text.match(/^[A-Za-z0-9_-]{20,}$/);
    const id = fileMatch?.[1] || idParamMatch?.[1] || rawIdMatch?.[0] || '';
    return id ? `https://drive.google.com/file/d/${id}/view` : '';
  }

  function applyDirectoryPhotoFileChips(ss: GoogleAppsScript.Spreadsheet.Spreadsheet, sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const photoIdx = headers.indexOf('photo_link');
    if (photoIdx < 0 || sheet.getLastRow() < 3) return;

    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn('Unable to apply Directory Photo Link file chips because the Sheets advanced service is unavailable.');
      return;
    }

    const valueRange = sheet.getRange(3, photoIdx + 1, sheet.getLastRow() - 2, 1);
    const values = valueRange.getValues();
    const richTextValues = valueRange.getRichTextValues();
    const requests: Record<string, any>[] = [];
    values.forEach((row, idx) => {
      const uri = extractDriveFileChipUri(row[0], richTextValues[idx]?.[0]);
      if (!uri) return;
      requests.push({
        updateCells: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: idx + 2,
            endRowIndex: idx + 3,
            startColumnIndex: photoIdx,
            endColumnIndex: photoIdx + 1,
          },
          rows: [{
            values: [{
              userEnteredValue: { stringValue: '@' },
              chipRuns: [{
                startIndex: 0,
                chip: {
                  richLinkProperties: { uri },
                },
              }],
            }],
          }],
          fields: 'userEnteredValue,chipRuns',
        },
      });
    });

    if (!requests.length) return;
    let applied = 0;
    for (let i = 0; i < requests.length; i += 10) {
      const chunk = requests.slice(i, i + 10);
      try {
        sheetsService.batchUpdate({ requests: chunk }, ss.getId());
        applied += chunk.length;
      } catch (err) {
        Log.warn(`Unable to apply Directory Photo Link file chips for rows ${i + 1}-${i + chunk.length}: ${err}`);
      }
    }
    if (applied) Log.info(`Applied Directory Photo Link file chips to ${applied} cell(s).`);
  }

  function applyDirectoryFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;

    normalizeDirectoryHeaders(sheet);

    setHeaderLabels(sheet, {
      as_year: 'Year',
      class_year: 'Class',
      phone: 'Phone Number',
      cip_code: 'CIP',
      squadron: 'Sqdn',
      flight_path_status: 'Flight Path',
      desired_assigned_afsc: 'Desired / Assigned AFSC',
    });

    applyStandardColumnWidths(
      sheet,
      [
        'last_name',
        'first_name',
        'as_year',
        'flight',
        'squadron',
        'rank',
        'university',
        'phone',
        'dorm',
        'cip_code',
        'class_year',
        'dob',
        'flight_path_status',
        'photo_link',
      ],
      DIRECTORY_FIT_TO_DATA_COLUMNS,
    );

    // Alignments
    const dataRange = sheet.getRange(3, 1, Math.max(1, sheet.getMaxRows() - 2), sheet.getLastColumn());
    dataRange
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
      .setFontColor('#434343');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const dataRows = Math.max(1, sheet.getMaxRows() - 2);
    const alignColumn = (key: string, alignment: 'left' | 'center' | 'right') => {
      const idx = headers.indexOf(key);
      if (idx >= 0) sheet.getRange(3, idx + 1, dataRows, 1).setHorizontalAlignment(alignment);
    };
    alignColumn('as_year', 'center');
    alignColumn('flight', 'center');
    alignColumn('squadron', 'center');
    alignColumn('phone', 'center');
    alignColumn('dorm', 'left');
    alignColumn('cip_code', 'right');
    alignColumn('desired_assigned_afsc', 'left');
    alignColumn('home_town', 'left');
    alignColumn('home_state', 'left');
    alignColumn('class_year', 'center');
    alignColumn('dob', 'right');
    alignColumn('flight_path_status', 'left');
    alignColumn('photo_link', 'center');
    applyDirectoryPhotoFileChips(ss, sheet);

    // Freeze name columns
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);

    pruneTrailingRows(sheet);
    hideMachineHeaderRow(sheet);
    setDefaultFont(sheet);
  }

  function applyAttendanceColumnWidths(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;
    sheet.setColumnWidth(1, 115);
    sheet.setColumnWidth(2, 115);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const baseCount = ATTENDANCE_BASE_HEADERS.length;
    const headerToIndex = new Map(headers.map((h, idx) => [h.toLowerCase(), idx] as const));
    const llabIdx = headerToIndex.get(ATT_HEADER_LLAB.toLowerCase()) ?? -1;
    const overallIdx = headerToIndex.get(ATT_HEADER_OVERALL.toLowerCase()) ?? -1;

    if (sheet.getLastColumn() > baseCount) {
      const eventStart = Math.max(baseCount + 1, 1);
      const eventCount = sheet.getLastColumn() - baseCount;
      sheet.setColumnWidths(eventStart, eventCount, 75);
    }
    if (overallIdx >= 0) sheet.setColumnWidth(overallIdx + 1, 75);
    if (llabIdx >= 0) sheet.setColumnWidth(llabIdx + 1, 75);
  }

  function applyDataLegendColumnWidths(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol > 0) sheet.autoResizeColumns(1, lastCol);
  }

  function applyDirectoryColumnWidths(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;

    normalizeDirectoryHeaders(sheet);

    applyStandardColumnWidths(
      sheet,
      [
        'last_name',
        'first_name',
        'as_year',
        'flight',
        'squadron',
        'rank',
        'university',
        'phone',
        'dorm',
        'cip_code',
        'class_year',
        'dob',
        'flight_path_status',
        'photo_link',
      ],
      DIRECTORY_FIT_TO_DATA_COLUMNS,
    );
  }

  function applyLeadershipFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;
    applyStandardColumnWidths(
      sheet,
      ['last_name', 'first_name', 'rank', 'cell_phone', 'office_phone'],
      LEADERSHIP_FIT_TO_DATA_COLUMNS,
    );

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const dataRange = sheet.getRange(3, 1, Math.max(1, sheet.getMaxRows() - 2), sheet.getLastColumn());
    dataRange
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
      .setFontColor('#434343');
    const dataRows = Math.max(1, sheet.getMaxRows() - 2);
    const alignColumn = (key: string, alignment: 'left' | 'center' | 'right') => {
      const idx = headers.indexOf(key);
      if (idx >= 0) sheet.getRange(3, idx + 1, dataRows, 1).setHorizontalAlignment(alignment);
    };
    alignColumn('rank', 'left');
    alignColumn('cell_phone', 'center');
    alignColumn('office_phone', 'center');
    try {
      const displayHeaders = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim().toLowerCase());
      const centerDisplayColumns = new Set(['overall', 'llab', 'overall_attendance_pct', 'llab_attendance_pct']);
      headers.forEach((header, idx) => {
        if (!centerDisplayColumns.has(header.toLowerCase()) && !centerDisplayColumns.has(displayHeaders[idx])) return;
        sheet.getRange(2, idx + 1, dataRows + 1, 1).setHorizontalAlignment('center');
      });
    } catch (err) {
      Log.warn(`Unable to center Leadership Overall/LLAB columns: ${err}`);
    }

    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);

    // Hide reports_to helper column for charting.
    const reportsIdx = headers.indexOf('reports_to');
    if (reportsIdx >= 0) {
      sheet.hideColumns(reportsIdx + 1, 1);
    }

    pruneTrailingRows(sheet);
    hideMachineHeaderRow(sheet);
    setDefaultFont(sheet);
  }

  function applyLeadershipColumnWidths(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;
    applyStandardColumnWidths(
      sheet,
      ['last_name', 'first_name', 'rank', 'cell_phone', 'office_phone'],
      LEADERSHIP_FIT_TO_DATA_COLUMNS,
    );
  }

  function applyDashboardFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Dashboard');
    if (!sheet) return;
    setDefaultFont(sheet);
    try {
      (sheet as any).setHiddenGridlines?.(true);
    } catch (err) {
      Log.warn(`Unable to hide Dashboard gridlines: ${err}`);
    }

    if (sheet.getMaxRows() < 36) sheet.insertRowsAfter(sheet.getMaxRows(), 36 - sheet.getMaxRows());
    if (sheet.getMaxColumns() < 12) sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
    sheet.getRange(1, 1, 36, 12).breakApart().clear();
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(0);

    const section = (title: string, row: number, col: number, rows: number, cols: number) => {
      const header = sheet.getRange(row, col, 1, cols);
      header.merge()
        .setValue(title)
        .setBackground('#1f4e3d')
        .setFontColor('#ffffff')
        .setFontWeight('bold')
        .setHorizontalAlignment('left');
      const body = sheet.getRange(row + 1, col, rows - 1, cols);
      body.setBackground('#f8faf9').setBorder(true, true, true, true, true, true, '#d9e2de', SpreadsheetApp.BorderStyle.SOLID);
      header.setBorder(true, true, true, true, false, false, '#1f4e3d', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    };

    section('Quick Links', 1, 1, 8, 2);
    section('Key Metrics', 1, 4, 8, 2);
    section('Attendance Summary', 1, 7, 8, 3);
    section('Birthdays', 1, 11, 14, 2);

    const makeLink = (url: string, label = 'Open') => (url ? `=HYPERLINK("${url}","${label}")` : '');
    const formUrlFor = (key: keyof typeof Config.PROPERTY_KEYS) => {
      const id = Config.getScriptProperty(Config.PROPERTY_KEYS[key]);
      if (!id) {
        Log.warn(`Dashboard quick link missing property for ${key}`);
        return '';
      }
      try {
        return FormApp.openById(id).getPublishedUrl();
      } catch (err) {
        Log.warn(`Dashboard quick link unable to open form ${key}: ${err}`);
        return `https://docs.google.com/forms/d/e/${id}/viewform`;
      }
    };

    const backendId = Config.getScriptProperty(Config.PROPERTY_KEYS.ADMIN_SPREADSHEET_ID);
    const backendUrl = backendId ? `https://docs.google.com/spreadsheets/d/${backendId}/edit` : '';

    const quickLinks = [
      ['Github', makeLink('https://github.com/declanhuggins/shamrock')],
      ['Directory Form', makeLink(formUrlFor('CADET_DIRECTORY_FORM_ID'))],
      ['Attendance Form', makeLink(formUrlFor('ATTENDANCE_FORM_ID'))],
      ['Excusals Form', makeLink(formUrlFor('EXCUSAL_REQUEST_FORM_ID'))],
      ['Backend sheet (admin)', makeLink(backendUrl)],
    ];
    sheet.getRange(2, 1, 1, 2).setValues([['Resource', 'Link']]);
    sheet.getRange(3, 1, quickLinks.length, 2).setValues(quickLinks);

    const metricsHeader = [['Metric', 'Value']];
    const metrics = [
      ['Total Cadets', '=COUNTA(Directory!A3:A)'],
      ['POC Cadets', '=COUNTIF(Directory!C3:C,"AS3*")+COUNTIF(Directory!C3:C,"AS4*")+COUNTIF(Directory!C3:C,"AS7*")+COUNTIF(Directory!C3:C,"AS8*")+COUNTIF(Directory!C3:C,"AS9*")'],
      ['GMC Cadets', '=COUNTIF(Directory!C3:C,"AS1*")+COUNTIF(Directory!C3:C,"AS2*")+COUNTIF(Directory!C3:C,"AS5*")'],
      ['Leadership Roles', '=COUNTIF(Directory!G3:G,"<>")'],
    ];
    sheet.getRange(2, 4, 1, 2).setValues(metricsHeader).setFontWeight('bold');
    sheet.getRange(3, 4, metrics.length, 2).setValues(metrics);

    const attendanceRows = [
      ['Metric', 'Value', 'Basis'],
      ['Events tracked', '=IFERROR(MAX(COUNTA(Attendance!H1:ZZ1),0),0)', 'Attendance event columns'],
      ['Average overall', '=IFERROR(AVERAGE(FILTER(Attendance!F3:F,Attendance!A3:A<>"")),"")', 'Active roster'],
      ['Average LLAB', '=IFERROR(AVERAGE(FILTER(Attendance!G3:G,Attendance!A3:A<>"")),"")', 'LLAB rollup'],
      ['Under 80%', '=IFERROR(COUNTIF(FILTER(Attendance!F3:F,Attendance!A3:A<>""),"<0.8"),0)', 'Accountability watch'],
    ];
    sheet.getRange(2, 7, attendanceRows.length, 3).setValues(attendanceRows);
    sheet.getRange('H4:H5').setNumberFormat('0.0%');

    sheet.getRange(2, 11, 1, 2).setValues([['Cadet', 'Birthday']]).setFontWeight('bold');
    sheet.getRange('K3:L14').clearContent();
    sheet.getRange('K3').setFormula(
      '=IFERROR(LET(\n' +
      'hdr, Directory!1:1,\n' +
      'cLast, IFERROR(MATCH("last_name", hdr, 0), 0),\n' +
      'cFirst, IFERROR(MATCH("first_name", hdr, 0), 0),\n' +
      'cDob, IFERROR(MATCH("dob", hdr, 0), 0),\n' +
      'rng, Directory!A3:Z,\n' +
      'raw, IF(cLast*cFirst*cDob=0, "", CHOOSECOLS(rng, cLast, cFirst, cDob)),\n' +
      'data, IF(raw="", "", FILTER(raw, (INDEX(raw,,1)<>"")*(INDEX(raw,,3)<>""))),\n' +
      'parsedDob, IF(data="", "", MAP(INDEX(data,,3), LAMBDA(d, IF(d="", "", IFERROR(TO_DATE(VALUE(d)), IFERROR(DATEVALUE(d), "")))))),\n' +
      'clean, IF(parsedDob="", "", FILTER(HSTACK(INDEX(data,,1), INDEX(data,,2), parsedDob), parsedDob<>"")),\n' +
      'sortKey, IF(clean="", "", MAP(INDEX(clean,,3), LAMBDA(d, IF(d="", "", DATE(YEAR(TODAY()), MONTH(d), DAY(d)))))),\n' +
      'labels, IF(clean="", "", MAP(INDEX(clean,,1), INDEX(clean,,2), LAMBDA(last, first, "C/" & last & IF(COUNTIF(INDEX(clean,,1), last)>1, ", " & LEFT(first,1) & ".", "")))),\n' +
      'table, IF(clean="", "", SORT(HSTACK(labels, INDEX(clean,,3), sortKey), 3, TRUE)),\n' +
      'IF(table="", "", CHOOSECOLS(table, 1, 2))\n' +
      '),"")'
    );

    ['A2:B2', 'D2:E2', 'G2:I2', 'K2:L2'].forEach((a1) => {
      sheet.getRange(a1).setBackground('#edf3f0').setFontWeight('bold');
    });
    sheet.getRange('A1:L36').setFontFamily('Roboto').setFontSize(10);
    sheet.getRange('A1:L36').setVerticalAlignment('middle');
    sheet.getRange('B3:B7').setHorizontalAlignment('center');
    sheet.getRange('E3:E6').setHorizontalAlignment('center');
    sheet.getRange('H3:H6').setHorizontalAlignment('center');
    sheet.getRange('I3:I6').setWrap(true).setFontColor('#5f6f69');
    sheet.getRange('K3:K14').setWrap(true);
    sheet.getRange('L3:L14').setNumberFormat('M/D').setHorizontalAlignment('center');
    sheet.setColumnWidth(1, 145);
    sheet.setColumnWidth(2, 80);
    sheet.setColumnWidth(3, 18);
    sheet.setColumnWidth(4, 145);
    sheet.setColumnWidth(5, 95);
    sheet.setColumnWidth(6, 18);
    sheet.setColumnWidth(7, 145);
    sheet.setColumnWidth(8, 95);
    sheet.setColumnWidth(9, 145);
    sheet.setColumnWidth(10, 18);
    sheet.setColumnWidth(11, 145);
    sheet.setColumnWidth(12, 90);
    sheet.setRowHeights(1, 36, 28);
    sheet.setRowHeight(1, 32);

    const maxNeededCols = 12;
    const maxCols = sheet.getMaxColumns();
    if (maxCols > maxNeededCols) {
      sheet.deleteColumns(maxNeededCols + 1, maxCols - maxNeededCols);
    }

    pruneTrailingRows(sheet);
  }

  function applyFaqsFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('FAQs');
    if (!sheet) return;

    try {
      (sheet as any).setHiddenGridlines?.(true);
      sheet.setFrozenRows(0);
      sheet.setFrozenColumns(0);
    } catch (err) {
      Log.warn(`Unable to set FAQ sheet chrome: ${err}`);
    }

    sheet.getBandings().forEach((b) => b.remove());
    const maxCols = sheet.getMaxColumns();
    if (maxCols > 1) {
      sheet.deleteColumns(2, maxCols - 1);
    }
    if (sheet.getMaxRows() < 12) {
      sheet.insertRowsAfter(sheet.getMaxRows(), 12 - sheet.getMaxRows());
    }

    setDefaultFont(sheet);
    sheet.setColumnWidth(1, 1000);
    const totalRows = Math.max(1, sheet.getMaxRows());
    const contentRange = sheet.getRange(1, 1, totalRows, 1);
    contentRange
      .setWrap(true)
      .setVerticalAlignment('top')
      .setHorizontalAlignment('left')
      .setBackground('#ffffff')
      .setBorder(false, false, false, false, false, false);

    const usedRows = Math.max(1, sheet.getLastRow());
    const values = sheet.getRange(1, 1, usedRows, 1).getDisplayValues();
    values.forEach((row, idx) => {
      const text = String(row[0] || '').trim();
      const range = sheet.getRange(idx + 1, 1);
      if (!text) {
        range.setBackground('#ffffff').setFontWeight('normal');
      } else if (idx === 0 && text.length <= 80) {
        range.setBackground('#1f4e3d').setFontColor('#ffffff').setFontWeight('bold').setFontSize(12);
      } else if (text.endsWith('?') && text.length <= 140) {
        range.setBackground('#edf3f0').setFontColor('#1f1f1f').setFontWeight('bold');
      } else {
        range.setBackground('#ffffff').setFontColor('#1f1f1f').setFontWeight('normal');
      }
    });

    try {
      sheet.autoResizeRows(1, usedRows);
      for (let r = 1; r <= usedRows; r++) {
        sheet.setRowHeight(r, Math.max(28, sheet.getRowHeight(r)));
      }
    } catch (err) {
      Log.warn(`Unable to autoresize FAQ rows: ${err}`);
    }
  }

  function applyDataLegendFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return;
    pruneTrailingRows(sheet);
    hideMachineHeaderRow(sheet);
    setDefaultFont(sheet);
  }

  function applyAttendanceFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;

    const baseCount = ATTENDANCE_BASE_HEADERS.length;

    // Hide machine headers, prune, defaults
    pruneTrailingRows(sheet);
    hideMachineHeaderRow(sheet);
    setDefaultFont(sheet);
    try {
      sheet.clearConditionalFormatRules();
    } catch (err) {
      Log.warn(`Unable to clear frontend Attendance conditional formatting: ${err}`);
    }

    // Rename percentage headers
    const display = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const headerToIndex = new Map(headers.map((h, idx) => [h.toLowerCase(), idx] as const));
    const llabIdx = headerToIndex.get(ATT_HEADER_LLAB.toLowerCase()) ?? -1;
    const overallIdx = headerToIndex.get(ATT_HEADER_OVERALL.toLowerCase()) ?? -1;
    if (llabIdx >= 0) display[llabIdx] = 'LLAB';
    if (overallIdx >= 0) display[overallIdx] = 'Overall';
    sheet.getRange(2, 1, 1, sheet.getLastColumn()).setValues([display]);
    sheet
      .getRange(2, 1, 1, sheet.getLastColumn())
      .setFontWeight('bold')
      .setFontSize(10)
      .setHorizontalAlignment('left');

    // Widths and hides
    sheet.setColumnWidth(1, 115);
    sheet.setColumnWidth(2, 115);
    sheet.hideColumns(3, 3);
    const eventStartCol = baseCount + 1;
    if (sheet.getLastColumn() >= eventStartCol) {
      sheet.setColumnWidths(eventStartCol, sheet.getLastColumn() - baseCount, 75);
    }

    // Set fixed widths for summary columns
    if (overallIdx >= 0) sheet.setColumnWidth(overallIdx + 1, 75);
    if (llabIdx >= 0) sheet.setColumnWidth(llabIdx + 1, 75);

    // Header styling for event columns after base columns
    if (sheet.getLastColumn() >= eventStartCol) {
      const headerRange = sheet.getRange(2, eventStartCol, 1, sheet.getLastColumn() - baseCount);
      headerRange.setFontSize(5).setWrap(true);
    }

    // Alignments
    const dataRows = Math.max(1, sheet.getMaxRows() - 2);
    sheet.getRange(3, 1, dataRows, sheet.getLastColumn()).setHorizontalAlignment('left');
    if (sheet.getLastColumn() >= eventStartCol) {
      sheet.getRange(3, eventStartCol, dataRows, sheet.getLastColumn() - baseCount).setHorizontalAlignment('center');
      sheet.getRange(3, eventStartCol, dataRows, sheet.getLastColumn() - baseCount)
        .setNumberFormat('@')
        .setHorizontalAlignment('center')
        .setFontWeight('bold');
    }
    // Explicitly center LLAB/Overall data columns (not just percentages) to avoid left drift.
    if (llabIdx >= 0) sheet.getRange(2, llabIdx + 1, dataRows + 1, 1).setHorizontalAlignment('center');
    if (overallIdx >= 0) sheet.getRange(2, overallIdx + 1, dataRows + 1, 1).setHorizontalAlignment('center');

    // Percentage formats
    const formatPercent = (idx: number) => {
      if (idx >= 0) {
        const range = sheet.getRange(3, idx + 1, dataRows, 1);
        range.setNumberFormat('0.0%');
        range.setHorizontalAlignment('center');
      }
    };
    formatPercent(llabIdx);
    formatPercent(overallIdx);

    // Freeze first two columns
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);

  }

  export function applyPostTableFormatting(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    applyAttendanceFormatting(ss);
  }
}
