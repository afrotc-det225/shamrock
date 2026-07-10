// Frontend formatting: apply Data Legend validations and table-adjacent layout.

namespace FrontendFormattingService {
  interface NamedRangeDef {
    name: string;
    range: GoogleAppsScript.Spreadsheet.Range;
  }

  interface ValidationColumnDef {
    field: string;
    rangeName: string;
    showDropdown: boolean;
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

  function readSheetValuesViaApi(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    sheetName: string,
    a1Range: string,
  ): unknown[][] | null {
    const valuesService = (globalThis as any).Sheets?.Spreadsheets?.Values;
    if (!valuesService?.get) return null;
    const escapedName = sheetName.replace(/'/g, "''");
    try {
      const response = valuesService.get(ss.getId(), `'${escapedName}'!${a1Range}`, {
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      return (response?.values || []) as unknown[][];
    } catch (err) {
      Log.warn(`Unable to read ${sheetName}!${a1Range} with Sheets API: ${err}`);
      return null;
    }
  }

  function columnNumberToA1(column: number): string {
    let value = Math.max(1, Math.floor(column));
    let result = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }

  function quoteSheetNameForFormula(sheetName: string): string {
    return `'${sheetName.replace(/'/g, "''")}'`;
  }

  function absoluteA1Notation(a1Notation: string): string {
    return String(a1Notation || '').replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  }

  function gridRangeForColumn(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    columnIndex: number,
    endRowIndex = Math.max(3, sheet.getLastRow()),
  ) {
    return {
      sheetId: sheet.getSheetId(),
      startRowIndex: 2,
      endRowIndex,
      startColumnIndex: columnIndex,
      endColumnIndex: columnIndex + 1,
    };
  }

  function dataValidationRuleForRange(
    sourceRange: GoogleAppsScript.Spreadsheet.Range,
    showDropdown: boolean,
  ): Record<string, any> {
    const formula = `=${quoteSheetNameForFormula(sourceRange.getSheet().getName())}!${absoluteA1Notation(sourceRange.getA1Notation())}`;
    return {
      condition: {
        type: 'ONE_OF_RANGE',
        values: [{ userEnteredValue: formula }],
      },
      strict: true,
      showCustomUi: showDropdown,
    };
  }

  function latestArchiveSheet(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    baseName: 'Directory' | 'Leadership' | 'Attendance',
  ): GoogleAppsScript.Spreadsheet.Sheet | null {
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(Spring|Fall) (\\d{4}) ${escapedBaseName}$`);
    const candidates = ss.getSheets()
      .map((sheet) => {
        const match = sheet.getName().match(pattern);
        if (!match) return null;
        const termOrder = match[1] === 'Fall' ? 2 : 1;
        return {
          sheet,
          sortKey: Number(match[2]) * 10 + termOrder,
          index: sheet.getIndex(),
        };
      })
      .filter((entry): entry is { sheet: GoogleAppsScript.Spreadsheet.Sheet; sortKey: number; index: number } => !!entry)
      .sort((a, b) => b.sortKey - a.sortKey || b.index - a.index);
    return candidates[0]?.sheet || null;
  }

  function archiveValidationSourceColumn(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    archive: GoogleAppsScript.Spreadsheet.Sheet | null,
    field: string,
  ): number {
    if (!archive || !field || archive.getLastRow() < 3) return -1;
    const headers = readHeaderRows(ss, archive).machine;
    const columnIndex = headers.indexOf(field);
    if (columnIndex < 0) return -1;
    try {
      return archive.getRange(3, columnIndex + 1).getDataValidation() ? columnIndex : -1;
    } catch (err) {
      Log.warn(`Unable to inspect archive validation source ${archive.getName()} field=${field}: ${err}`);
      return -1;
    }
  }

  function batchUpdateCellValidations(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    requests: Record<string, any>[],
    label: string,
  ): boolean {
    if (!requests.length) return true;
    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn(`Unable to apply ${label} because the Sheets advanced service is unavailable.`);
      return false;
    }
    try {
      sheetsService.batchUpdate({ requests }, ss.getId());
      Log.info(`Applied ${label} through the cell-level Sheets API requests=${requests.length}.`);
      return true;
    } catch (err) {
      Log.warn(`Unable to apply ${label} through the cell-level Sheets API: ${err}`);
      return false;
    }
  }

  function readHeaderRows(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
  ): { machine: string[]; display: string[] } {
    const apiRows = readSheetValuesViaApi(ss, sheet.getName(), '1:2');
    if (apiRows) {
      return {
        machine: (apiRows[0] || []).map((h) => String(h || '').trim()),
        display: (apiRows[1] || []).map((h) => String(h || '').trim()),
      };
    }
    Log.warn(`Unable to read ${sheet.getName()} headers through the Sheets API path; skipping this header-driven step.`);
    return { machine: [], display: [] };
  }

  function buildNamedRanges(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): NamedRangeDef[] {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return [];
    const headers = readHeaderRows(ss, sheet).machine;

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
      const columnLetter = columnNumberToA1(col);
      const apiValues = readSheetValuesViaApi(ss, sheet.getName(), `${columnLetter}3:${columnLetter}${lastRow}`);
      if (!apiValues) return;
      const values = apiValues.map((r) => String(r[0] || ''));
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

    const headers = readHeaderRows(ss, sheet).machine;
    if (!headers.length) return;
    const endRowIndex = Math.max(3, sheet.getLastRow());
    const validationColumns: ValidationColumnDef[] = [
      { field: 'as_year', rangeName: 'AS_YEARS', showDropdown: true },
      { field: 'flight', rangeName: 'FLIGHTS', showDropdown: true },
      { field: 'squadron', rangeName: 'SQUADRONS', showDropdown: true },
      { field: 'rank', rangeName: 'CADET_RANKS', showDropdown: false },
      { field: 'university', rangeName: 'UNIVERSITIES', showDropdown: false },
      { field: 'dorm', rangeName: 'DORMS', showDropdown: true },
      { field: 'cip_broad_area', rangeName: 'CIP_BROAD_AREAS', showDropdown: false },
      { field: 'desired_assigned_afsc', rangeName: 'AFSC_OPTIONS', showDropdown: true },
      { field: 'home_state', rangeName: 'HOME_STATES', showDropdown: false },
      { field: 'flight_path_status', rangeName: 'FLIGHT_PATH_STATUSES', showDropdown: true },
    ];
    const archive = latestArchiveSheet(ss, 'Directory');
    const requests: Record<string, any>[] = [{
      setDataValidation: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: 2,
          endRowIndex,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
        filteredRowsIncluded: true,
      },
    }];
    let copiedFromArchive = 0;
    let generatedFromLegend = 0;

    validationColumns.forEach((def) => {
      const columnIndex = headers.indexOf(def.field);
      if (columnIndex < 0) return;
      const archiveColumnIndex = archiveValidationSourceColumn(ss, archive, def.field);
      if (archive && archiveColumnIndex >= 0) {
        requests.push({
          copyPaste: {
            source: gridRangeForColumn(archive, archiveColumnIndex, 3),
            destination: gridRangeForColumn(sheet, columnIndex, endRowIndex),
            pasteType: 'PASTE_DATA_VALIDATION',
            pasteOrientation: 'NORMAL',
          },
        });
        copiedFromArchive += 1;
        return;
      }

      const namedRange = ss.getRangeByName(def.rangeName);
      if (!namedRange) {
        Log.warn(`Directory validation source missing field=${def.field} namedRange=${def.rangeName}.`);
        return;
      }
      requests.push({
        setDataValidation: {
          range: gridRangeForColumn(sheet, columnIndex, endRowIndex),
          rule: dataValidationRuleForRange(namedRange, def.showDropdown),
          filteredRowsIncluded: true,
        },
      });
      generatedFromLegend += 1;
    });

    if (batchUpdateCellValidations(ss, requests, 'Directory archive-style validations')) {
      Log.info(
        `Directory validations ready rows=${Math.max(1, endRowIndex - 2)} columns=${copiedFromArchive + generatedFromLegend} `
        + `archive=${archive?.getName() || 'none'} copied=${copiedFromArchive} generated=${generatedFromLegend} tableColumnTypes=unchanged`,
      );
    }
  }

  function applyLeadershipValidations(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;
    const headers = readHeaderRows(ss, sheet).machine;
    const rankIdx = headers.indexOf('rank');
    if (rankIdx < 0) return;
    const rankRange = getLeadershipRankRange(ss);
    if (!rankRange) return;
    batchUpdateCellValidations(ss, [{
      setDataValidation: {
        range: gridRangeForColumn(sheet, rankIdx),
        rule: dataValidationRuleForRange(rankRange, false),
        filteredRowsIncluded: true,
      },
    }], 'Leadership rank validation');
  }

  function getLeadershipRankRange(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): GoogleAppsScript.Spreadsheet.Range | null {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) return null;
    const headers = readHeaderRows(ss, sheet).machine;
    const indexes = ['cadet_rank_options', 'rank_options', 'honorific_options']
      .map((header) => headers.indexOf(header))
      .filter((idx) => idx >= 0);
    if (!indexes.length) return ss.getRangeByName('RANKS');

    const startCol = Math.min(...indexes) + 1;
    const endCol = Math.max(...indexes) + 1;
    const lastRow = Math.max(3, sheet.getLastRow());
    const startLetter = columnNumberToA1(startCol);
    const endLetter = columnNumberToA1(endCol);
    const values = readSheetValuesViaApi(ss, sheet.getName(), `${startLetter}3:${endLetter}${lastRow}`);
    if (!values) return null;
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
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;
    const headers = readHeaderRows(ss, sheet).machine.map((h) => h.toLowerCase());
    if (!headers.length) return;
    const fixed = new Set(ATTENDANCE_BASE_HEADERS.map((h) => h.toLowerCase()));
    const eventIndexes = headers
      .map((header, index) => ({ header, index }))
      .filter((entry) => !fixed.has(entry.header))
      .map((entry) => entry.index);
    if (!eventIndexes.length) return;

    const eventStartIndex = Math.min(...eventIndexes);
    const eventEndIndex = Math.max(...eventIndexes) + 1;
    const endRowIndex = Math.max(3, sheet.getLastRow());
    const archive = latestArchiveSheet(ss, 'Attendance');
    const archiveHeaders = archive ? readHeaderRows(ss, archive).machine.map((h) => h.toLowerCase()) : [];
    const archiveEventIndex = archiveHeaders.findIndex((header) => !fixed.has(header));
    let archiveHasValidation = false;
    if (archive && archiveEventIndex >= 0 && archive.getLastRow() >= 3) {
      try {
        archiveHasValidation = !!archive.getRange(3, archiveEventIndex + 1).getDataValidation();
      } catch (err) {
        Log.warn(`Unable to inspect archive Attendance validation source ${archive.getName()}: ${err}`);
      }
    }

    const destination = {
      sheetId: sheet.getSheetId(),
      startRowIndex: 2,
      endRowIndex,
      startColumnIndex: eventStartIndex,
      endColumnIndex: eventEndIndex,
    };
    const requests: Record<string, any>[] = [{
      setDataValidation: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: 2,
          endRowIndex,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
        filteredRowsIncluded: true,
      },
    }];
    if (archive && archiveEventIndex >= 0 && archiveHasValidation) {
      requests.push({
        copyPaste: {
          source: gridRangeForColumn(archive, archiveEventIndex, 3),
          destination,
          pasteType: 'PASTE_DATA_VALIDATION',
          pasteOrientation: 'NORMAL',
        },
      });
    } else {
      requests.push({
        setDataValidation: {
          range: destination,
          rule: dataValidationRuleForRange(namedRange, true),
          filteredRowsIncluded: true,
        },
      });
    }

    if (batchUpdateCellValidations(ss, requests, 'Attendance archive-style validations')) {
      Log.info(
        `Attendance validations ready rows=${Math.max(1, endRowIndex - 2)} eventColumns=${eventIndexes.length} `
        + `archive=${archive?.getName() || 'none'} source=${archive && archiveHasValidation ? 'archive-copy' : 'Data Legend'} tableColumnTypes=unchanged`,
      );
    }
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

  export function applyAll(frontendId: string, opts?: { skipValidations?: boolean }) {
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
      if (!opts?.skipValidations) applyValidationRules(ss);
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
    if (!opts?.skipValidations) applyValidationRules(ss);
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

  export function repairAttendanceInputs(frontendId: string) {
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
    applyAttendanceValidations(ss);

    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;
    const headers = readHeaderRows(ss, sheet).machine.map((header) => header.toLowerCase());
    const overallIdx = headers.indexOf(ATT_HEADER_OVERALL.toLowerCase());
    const llabIdx = headers.indexOf(ATT_HEADER_LLAB.toLowerCase());
    applyAttendancePercentageGradient(sheet, overallIdx, llabIdx, Math.max(1, sheet.getLastRow() - 2));
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
    try {
      SheetUtils.trimTrailingBlankRows(sheet);
    } catch (err) {
      Log.warn(`Unable to prune trailing rows on ${sheet.getName()}: ${err}`);
    }
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

  function applyDirectoryPhotoFileChipsToSheet(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    sourceValues?: unknown[],
  ) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const photoIdx = headers.indexOf('photo_link');
    if (photoIdx < 0 || sheet.getLastRow() < 3) return;

    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn('Unable to apply Directory Photo Link file chips because the Sheets advanced service is unavailable.');
      return;
    }

    const valueRange = sheet.getRange(3, photoIdx + 1, sheet.getLastRow() - 2, 1);
    const values = sourceValues ? sourceValues.map((value) => [value]) : valueRange.getValues();
    const richTextValues = sourceValues ? [] : valueRange.getRichTextValues();
    const requests: Record<string, any>[] = [];
    values.forEach((row, idx) => {
      const uri = extractDriveFileChipUri(row[0], richTextValues[idx]?.[0]);
      const text = String(row[0] || '').trim();
      const cell = uri
        ? {
            userEnteredValue: { stringValue: '@' },
            chipRuns: [{
              startIndex: 0,
              chip: {
                richLinkProperties: { uri },
              },
            }],
          }
        : (text
          ? {
              userEnteredValue: { stringValue: text },
              chipRuns: [],
            }
          : {
              userEnteredValue: { stringValue: '' },
              chipRuns: [],
            });
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
            values: [cell],
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

  export function applyDirectoryPhotoFileChips(frontendId: string, sourceValues?: unknown[]) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;
    applyDirectoryPhotoFileChipsToSheet(ss, sheet, sourceValues);
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
    applyDirectoryPhotoFileChipsToSheet(ss, sheet);

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

    const countCadetsByAsYear = (asYears: string[]): string =>
      `=${asYears.map((asYear) => `COUNTIF(Directory!C3:C,"${asYear}")`).join('+')}`;
    const metricsHeader = [['Metric', 'Value']];
    const metrics = [
      ['Total Cadets', '=COUNTA(Directory!A3:A)'],
      ['POC Cadets', countCadetsByAsYear(Arrays.POC_AS_YEARS)],
      ['GMC Cadets', countCadetsByAsYear(Arrays.GMC_AS_YEARS)],
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
    applyAttendancePercentageGradient(sheet, overallIdx, llabIdx, dataRows);

    // Freeze first two columns
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);

  }

  function applyAttendancePercentageGradient(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    overallIdx: number,
    llabIdx: number,
    dataRows: number,
  ) {
    const ranges = [overallIdx, llabIdx]
      .filter((idx) => idx >= 0)
      .map((idx) => sheet.getRange(3, idx + 1, Math.max(1, dataRows), 1));
    if (!ranges.length) return;
    try {
      const rule = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E67C73', SpreadsheetApp.InterpolationType.NUMBER, '0.8')
        .setGradientMidpointWithValue('#FFCE65', SpreadsheetApp.InterpolationType.NUMBER, '0.9')
        .setGradientMaxpointWithValue('#57BB8A', SpreadsheetApp.InterpolationType.NUMBER, '1')
        .setRanges(ranges)
        .build();
      sheet.setConditionalFormatRules([rule]);
      Log.info(`Attendance percentage gradient ready rows=${Math.max(1, dataRows)} summaryColumns=${ranges.length}.`);
    } catch (err) {
      Log.warn(`Unable to apply archive-style Attendance percentage gradient: ${err}`);
    }
  }

  function applyAttendancePostTableFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Attendance');
    if (!sheet) return;

    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn('Unable to apply post-table Attendance formatting because the Sheets advanced service is unavailable.');
      return;
    }

    const headers = readHeaderRows(ss, sheet).machine.map((h) => h.toLowerCase());
    const headerToIndex = new Map(headers.map((h, idx) => [h, idx] as const));
    const baseCount = ATTENDANCE_BASE_HEADERS.length;
    const eventStartIdx = baseCount;
    const lastCol = sheet.getLastColumn();
    const endRowIndex = Math.max(3, sheet.getLastRow());
    const requests: Record<string, any>[] = [];

    if (lastCol > eventStartIdx && endRowIndex > 2) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: 2,
            endRowIndex,
            startColumnIndex: eventStartIdx,
            endColumnIndex: lastCol,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'TEXT' },
              horizontalAlignment: 'CENTER',
              textFormat: { bold: true },
            },
          },
          fields: 'userEnteredFormat(numberFormat,horizontalAlignment,textFormat.bold)',
        },
      });
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: eventStartIdx,
            endColumnIndex: lastCol,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: 'CENTER',
              wrapStrategy: 'WRAP',
              textFormat: { bold: true, fontSize: 5 },
            },
          },
          fields: 'userEnteredFormat(horizontalAlignment,wrapStrategy,textFormat.bold,textFormat.fontSize)',
        },
      });
    }

    [ATT_HEADER_OVERALL, ATT_HEADER_LLAB].forEach((header) => {
      const idx = headerToIndex.get(header.toLowerCase());
      if (idx === undefined) return;
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: 1,
            endRowIndex,
            startColumnIndex: idx,
            endColumnIndex: idx + 1,
          },
          cell: {
            userEnteredFormat: { horizontalAlignment: 'CENTER' },
          },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      });
    });

    if (!requests.length) return;
    try {
      sheetsService.batchUpdate({ requests }, ss.getId());
      Log.info(`Applied post-table Attendance formatting requests=${requests.length}.`);
    } catch (err) {
      Log.warn(`Unable to apply post-table Attendance formatting: ${err}`);
    }
  }

  function applyLeadershipPostTableFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;

    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn('Unable to apply post-table Leadership formatting because the Sheets advanced service is unavailable.');
      return;
    }

    const headerRows = readHeaderRows(ss, sheet);
    const machineHeaders = headerRows.machine.map((h) => h.toLowerCase());
    const displayHeaders = headerRows.display.map((h) => h.toLowerCase());
    const centerHeaders = new Set(['overall', 'llab', 'overall_attendance_pct', 'llab_attendance_pct']);
    const endRowIndex = Math.max(3, sheet.getLastRow());
    const requests: Record<string, any>[] = [];

    machineHeaders.forEach((header, idx) => {
      if (!centerHeaders.has(header) && !centerHeaders.has(displayHeaders[idx])) return;
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheet.getSheetId(),
            startRowIndex: 1,
            endRowIndex,
            startColumnIndex: idx,
            endColumnIndex: idx + 1,
          },
          cell: {
            userEnteredFormat: { horizontalAlignment: 'CENTER' },
          },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      });
    });

    if (!requests.length) return;
    try {
      sheetsService.batchUpdate({ requests }, ss.getId());
      Log.info(`Applied post-table Leadership formatting requests=${requests.length}.`);
    } catch (err) {
      Log.warn(`Unable to apply post-table Leadership formatting: ${err}`);
    }
  }

  export function applyPostTableFormatting(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    applyLeadershipPostTableFormatting(ss);
    applyAttendancePostTableFormatting(ss);
  }
}
