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
  const LEADERSHIP_RANK_SOURCE_HEADERS = [
    'cadet_rank_options',
    'rank_options',
    'honorific_options',
  ];
  const STANDARD_COLUMN_WIDTHS: Record<string, number> = {
    last_name: 115,
    first_name: 115,
    as_year: 100,
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
    const applied = batchUpdateCellValidations(ss, [{
      setDataValidation: {
        range: gridRangeForColumn(sheet, rankIdx),
        rule: dataValidationRuleForRange(rankRange, false),
        filteredRowsIncluded: true,
      },
    }], 'Leadership rank validation');
    if (!applied) {
      throw new Error('Unable to apply Leadership Rank validation from the complete Data Legend rank source.');
    }
    Log.info(
      `Leadership Rank validation ready source=${rankRange.getSheet().getName()}!${rankRange.getA1Notation()} `
      + `includes=${LEADERSHIP_RANK_SOURCE_HEADERS.join(',')}.`,
    );
  }

  function getLeadershipRankRange(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): GoogleAppsScript.Spreadsheet.Range | null {
    const sheet = ss.getSheetByName('Data Legend');
    if (!sheet) {
      throw new Error('Leadership Rank validation requires the Data Legend sheet.');
    }
    const headers = readHeaderRows(ss, sheet).machine;
    const indexes = LEADERSHIP_RANK_SOURCE_HEADERS.map((header) => headers.indexOf(header));
    const missingHeaders = LEADERSHIP_RANK_SOURCE_HEADERS.filter((_, index) => indexes[index] < 0);
    if (missingHeaders.length) {
      throw new Error(`Leadership Rank validation is missing Data Legend source column(s): ${missingHeaders.join(', ')}.`);
    }
    const contiguous = indexes.every((columnIndex, index) => columnIndex === indexes[0] + index);
    if (!contiguous) {
      throw new Error(
        `Leadership Rank validation requires adjacent Data Legend columns in this order: ${LEADERSHIP_RANK_SOURCE_HEADERS.join(', ')}.`,
      );
    }

    const startCol = indexes[0] + 1;
    const endCol = indexes[indexes.length - 1] + 1;
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
      Log.info(`${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING}=true; validations still applied. Running the required Dashboard layout.`);
      applyDashboardFormatting(ss); // keep layout populated so Dashboard isn’t blank
      if (!opts?.skipValidations) applyValidationRules(ss);
      return;
    }

    freezeTopTwoRowsAllSheets(ss);
    applyDirectoryFormatting(ss);
    applyLeadershipFormatting(ss);
    applyDashboardFormatting(ss);
    applyDataLegendFormatting(ss);
    applyAttendanceFormatting(ss);
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

  export function applyDashboardOnly(frontendId: string) {
    const ss = openFrontend(frontendId);
    if (!ss) return;
    applyDashboardFormatting(ss);
  }

  function freezeTopTwoRowsAllSheets(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    ss.getSheets()
      .filter(sheet => {
        const name = sheet.getName();
        return name !== 'Dashboard';
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

  function extractDriveFileChipUri(value: unknown): string {
    const text = String(value || '').trim();
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
    sourceValues: unknown[],
  ) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const photoIdx = headers.indexOf('photo_link');
    if (photoIdx < 0 || sheet.getLastRow() < 3) return;

    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) {
      Log.warn('Unable to apply Directory Photo Link file chips because the Sheets advanced service is unavailable.');
      return;
    }

    const values = sourceValues.map((value) => [value]);
    const requests: Record<string, any>[] = [];
    let requestedFileChips = 0;
    values.forEach((row, idx) => {
      const uri = extractDriveFileChipUri(row[0]);
      const text = String(row[0] || '').trim();
      if (uri) requestedFileChips += 1;
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
    if (applied) {
      Log.info(`Applied Directory Photo Link file chips to ${requestedFileChips} cell(s).`);
    }
  }

  export function applyDirectoryPhotoFileChips(frontendId: string, sourceValues: unknown[]) {
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
    // Formatting must never republish Photo Link values from the visible chip label.
    // Directory sync owns chip writes because it has the canonical backend URL/file ID.

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

  interface DashboardAttendanceSource {
    sheet: GoogleAppsScript.Spreadsheet.Sheet;
    label: string;
    lastNameIndex: number;
    asYearIndex: number;
    flightIndex: number;
    overallIndex: number;
  }

  interface DashboardChartRanges {
    helperSheet: GoogleAppsScript.Spreadsheet.Sheet;
    attendanceByAsYear: GoogleAppsScript.Spreadsheet.Range;
    attendanceTrend: GoogleAppsScript.Spreadsheet.Range;
    attendanceByFlight: GoogleAppsScript.Spreadsheet.Range;
    rosterByAsYear: GoogleAppsScript.Spreadsheet.Range;
  }

  const DASHBOARD_HELPER_SHEET = 'Dashboard Data';
  const LEGACY_DASHBOARD_HELPER_SHEET = '_Dashboard Data';

  function resolveDashboardHelperSheet(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): GoogleAppsScript.Spreadsheet.Sheet {
    let helper = ss.getSheetByName(DASHBOARD_HELPER_SHEET);
    const legacy = ss.getSheetByName(LEGACY_DASHBOARD_HELPER_SHEET);
    if (!helper && legacy) {
      legacy.setName(DASHBOARD_HELPER_SHEET);
      helper = legacy;
      Log.info(`Renamed legacy ${LEGACY_DASHBOARD_HELPER_SHEET} sheet to ${DASHBOARD_HELPER_SHEET}.`);
    } else if (helper && legacy && helper.getSheetId() !== legacy.getSheetId()) {
      legacy.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => protection.remove());
      legacy.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => protection.remove());
      ss.deleteSheet(legacy);
      Log.info(`Removed duplicate legacy ${LEGACY_DASHBOARD_HELPER_SHEET} sheet.`);
    }
    return helper || ss.insertSheet(DASHBOARD_HELPER_SHEET);
  }

  function dashboardColumnRange(sheet: GoogleAppsScript.Spreadsheet.Sheet, columnIndex: number): string {
    const column = columnNumberToA1(columnIndex + 1);
    return `${quoteSheetNameForFormula(sheet.getName())}!$${column}$3:$${column}`;
  }

  function dashboardAttendanceSources(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): DashboardAttendanceSource[] {
    const archivePattern = /^(Spring|Fall) (\d{4}) Attendance$/;
    const archives = ss.getSheets()
      .map((sheet) => {
        const match = sheet.getName().match(archivePattern);
        if (!match) return null;
        return {
          sheet,
          label: `${match[1]} ${match[2]}`,
          sortKey: Number(match[2]) * 10 + (match[1] === 'Fall' ? 2 : 1),
        };
      })
      .filter((entry): entry is { sheet: GoogleAppsScript.Spreadsheet.Sheet; label: string; sortKey: number } => !!entry)
      .sort((a, b) => b.sortKey - a.sortKey)
      .slice(0, 2);
    const candidates = [
      { sheet: ss.getSheetByName('Attendance'), label: 'Current' },
      ...archives,
    ];

    return candidates
      .filter((entry): entry is { sheet: GoogleAppsScript.Spreadsheet.Sheet; label: string } => !!entry.sheet)
      .map((entry) => {
        const headers = readHeaderRows(ss, entry.sheet).machine.map((header) => header.toLowerCase());
        return {
          sheet: entry.sheet,
          label: entry.label,
          lastNameIndex: headers.indexOf('last_name'),
          asYearIndex: headers.indexOf('as_year'),
          flightIndex: headers.indexOf('flight'),
          overallIndex: headers.indexOf(ATT_HEADER_OVERALL.toLowerCase()),
        };
      })
      .filter((source) => {
        const complete = source.lastNameIndex >= 0 && source.asYearIndex >= 0 && source.overallIndex >= 0;
        if (!complete) Log.warn(`Skipping incomplete Dashboard attendance source ${source.sheet.getName()}.`);
        return complete;
      });
  }

  function buildDashboardChartData(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    dashboard: GoogleAppsScript.Spreadsheet.Sheet,
    directory: GoogleAppsScript.Spreadsheet.Sheet,
    sources: DashboardAttendanceSource[],
  ): DashboardChartRanges {
    const helper = resolveDashboardHelperSheet(ss);
    if (helper.getMaxRows() < 40) helper.insertRowsAfter(helper.getMaxRows(), 40 - helper.getMaxRows());
    if (helper.getMaxColumns() < 12) helper.insertColumnsAfter(helper.getMaxColumns(), 12 - helper.getMaxColumns());
    helper.showSheet();

    helper.clear();
    helper.clearConditionalFormatRules();
    helper.getRange(1, 1, helper.getMaxRows(), helper.getMaxColumns()).setFontFamily('Roboto').setFontSize(10);

    const comparisonSources = sources.slice(0, 3);
    const asYearRows: any[][] = [
      ['AS Year', ...comparisonSources.map((source) => source.label)],
      ...Arrays.AS_YEARS.map((asYear, index) => {
        const row = index + 2;
        return [
          asYear,
          ...comparisonSources.map((source) => {
            const overall = dashboardColumnRange(source.sheet, source.overallIndex);
            const sourceAsYear = dashboardColumnRange(source.sheet, source.asYearIndex);
            return `=IFERROR(AVERAGE(FILTER(${overall},${sourceAsYear}=$A${row},${overall}<>"")),"")`;
          }),
        ];
      }),
    ];
    helper.getRange(1, 1, asYearRows.length, asYearRows[0].length).setValues(asYearRows);
    if (asYearRows[0].length > 1) helper.getRange(2, 2, asYearRows.length - 1, asYearRows[0].length - 1).setNumberFormat('0.0%');

    const chronologicalSources = [...sources.slice(1)].reverse().concat(sources.slice(0, 1));
    const trendRows = [
      ['Term', 'Overall Attendance'],
      ...chronologicalSources.map((source) => {
        const overall = dashboardColumnRange(source.sheet, source.overallIndex);
        const lastName = dashboardColumnRange(source.sheet, source.lastNameIndex);
        return [source.label, `=IFERROR(AVERAGE(FILTER(${overall},${lastName}<>"",${overall}<>"")),"")`];
      }),
    ];
    helper.getRange(15, 1, trendRows.length, 2).setValues(trendRows);
    if (trendRows.length > 1) helper.getRange(16, 2, trendRows.length - 1, 1).setNumberFormat('0.0%');

    const current = sources.find((source) => source.label === 'Current');
    const flightRows: any[][] = [['Flight', 'Overall Attendance']];
    Arrays.FLIGHTS.forEach((flight, index) => {
      let formula = '';
      if (current && current.flightIndex >= 0) {
        const overall = dashboardColumnRange(current.sheet, current.overallIndex);
        const sourceFlight = dashboardColumnRange(current.sheet, current.flightIndex);
        formula = `=IFERROR(AVERAGE(FILTER(${overall},${sourceFlight}=$F${index + 16},${overall}<>"")),"")`;
      }
      flightRows.push([flight, formula]);
    });
    helper.getRange(15, 6, flightRows.length, 2).setValues(flightRows);
    helper.getRange(16, 7, flightRows.length - 1, 1).setNumberFormat('0.0%');

    const directoryHeaders = readHeaderRows(ss, directory).machine.map((header) => header.toLowerCase());
    const directoryAsYearIndex = directoryHeaders.indexOf('as_year');
    const directoryAsYearRange = directoryAsYearIndex >= 0 ? dashboardColumnRange(directory, directoryAsYearIndex) : '';
    const rosterRows = [
      ['AS Year', 'Cadets'],
      ...Arrays.AS_YEARS.map((asYear, index) => [
        asYear,
        directoryAsYearRange ? `=COUNTIF(${directoryAsYearRange},$J${index + 16})` : '',
      ]),
    ];
    helper.getRange(15, 10, rosterRows.length, 2).setValues(rosterRows);

    helper.getRange('A1:L1').setFontWeight('bold').setBackground('#dfe9e4');
    helper.getRange('A15:L15').setFontWeight('bold').setBackground('#dfe9e4');
    helper.autoResizeColumns(1, 12);
    SpreadsheetApp.flush();

    const mirrorRange = (
      sourceRange: GoogleAppsScript.Spreadsheet.Range,
      targetRow: number,
      targetColumn: number,
    ): GoogleAppsScript.Spreadsheet.Range => {
      const formulas = Array.from({ length: sourceRange.getNumRows() }, (_, rowOffset) =>
        Array.from({ length: sourceRange.getNumColumns() }, (_, columnOffset) => {
          const sourceCell = helper.getRange(sourceRange.getRow() + rowOffset, sourceRange.getColumn() + columnOffset);
          return `=${quoteSheetNameForFormula(helper.getName())}!${sourceCell.getA1Notation()}`;
        }));
      const target = dashboard.getRange(targetRow, targetColumn, sourceRange.getNumRows(), sourceRange.getNumColumns());
      target.setFormulas(formulas);
      return target;
    };

    const attendanceByAsYear = mirrorRange(helper.getRange(1, 1, asYearRows.length, asYearRows[0].length), 12, 1);
    const attendanceTrend = mirrorRange(helper.getRange(15, 1, trendRows.length, 2), 12, 7);
    const attendanceByFlight = mirrorRange(helper.getRange(15, 6, flightRows.length, 2), 31, 1);
    const rosterByAsYear = mirrorRange(helper.getRange(15, 10, rosterRows.length, 2), 31, 7);
    if (attendanceByAsYear.getNumColumns() > 1) attendanceByAsYear.offset(1, 1, attendanceByAsYear.getNumRows() - 1, attendanceByAsYear.getNumColumns() - 1).setNumberFormat('0.0%');
    if (attendanceTrend.getNumRows() > 1) attendanceTrend.offset(1, 1, attendanceTrend.getNumRows() - 1, 1).setNumberFormat('0.0%');
    if (attendanceByFlight.getNumRows() > 1) attendanceByFlight.offset(1, 1, attendanceByFlight.getNumRows() - 1, 1).setNumberFormat('0.0%');
    SpreadsheetApp.flush();

    const assertNumericSeries = (range: GoogleAppsScript.Spreadsheet.Range, label: string) => {
      const numericValues = range.getValues().flat().filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (!numericValues.length) throw new Error(`Dashboard chart source has no numeric values: ${label}`);
    };
    assertNumericSeries(attendanceByAsYear, 'attendance by AS year');
    assertNumericSeries(attendanceTrend, 'attendance trend');
    assertNumericSeries(attendanceByFlight, 'attendance by flight');
    assertNumericSeries(rosterByAsYear, 'roster by AS year');

    return { helperSheet: helper, attendanceByAsYear, attendanceTrend, attendanceByFlight, rosterByAsYear };
  }

  function insertDashboardChart(
    sheet: GoogleAppsScript.Spreadsheet.Sheet,
    range: GoogleAppsScript.Spreadsheet.Range,
    title: string,
    chartType: GoogleAppsScript.Charts.ChartType,
    row: number,
    column: number,
    options?: { percentAxis?: boolean; horizontal?: boolean; legend?: string; colors?: string[] },
  ): number {
    const sheetsService = (globalThis as any).Sheets?.Spreadsheets;
    if (!sheetsService?.batchUpdate) throw new Error('Sheets advanced service is unavailable for Dashboard charts.');

    const startRowIndex = range.getRow() - 1;
    const endRowIndex = startRowIndex + range.getNumRows();
    const startColumnIndex = range.getColumn() - 1;
    const sheetId = sheet.getSheetId();
    const source = (columnOffset: number) => ({
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: startColumnIndex + columnOffset,
      endColumnIndex: startColumnIndex + columnOffset + 1,
    });
    const hexColor = (hex: string) => {
      const value = String(hex || '').replace('#', '');
      const normalized = value.length === 3 ? value.split('').map((digit) => digit + digit).join('') : value;
      const numeric = Number.parseInt(normalized, 16);
      return {
        red: ((numeric >> 16) & 255) / 255,
        green: ((numeric >> 8) & 255) / 255,
        blue: (numeric & 255) / 255,
      };
    };

    const apiChartType = chartType === Charts.ChartType.LINE
      ? 'LINE'
      : chartType === Charts.ChartType.BAR ? 'BAR' : 'COLUMN';
    const colors = options?.colors || ['#2b6e55', '#7f9d91', '#b8c6c0'];
    const targetAxis = options?.horizontal ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
    const numericValues = range.getValues().flat().filter((value) => typeof value === 'number' && Number.isFinite(value)) as number[];
    const minimum = numericValues.length ? Math.min(...numericValues) : 0;
    const axisMinimum = Math.max(0, Math.floor((minimum - 0.05) * 10) / 10);
    const axis = [
      { position: 'BOTTOM_AXIS', viewWindowOptions: {} },
      { position: 'LEFT_AXIS', viewWindowOptions: {} },
    ];
    if (options?.percentAxis) {
      const percentAxis = axis.find((entry) => entry.position === targetAxis)!;
      percentAxis.viewWindowOptions = {
        viewWindowMin: axisMinimum,
        viewWindowMax: 1.01,
        viewWindowMode: 'EXPLICIT',
      } as any;
    }

    const series = Array.from({ length: Math.max(0, range.getNumColumns() - 1) }, (_, index) => ({
      series: { sourceRange: { sources: [source(index + 1)] } },
      targetAxis,
      colorStyle: { rgbColor: hexColor(colors[index % colors.length]) },
      ...(apiChartType === 'LINE' ? { lineStyle: { width: 3 }, pointStyle: { size: 5 } } : {}),
    }));
    const response = sheetsService.batchUpdate({
      requests: [{
        addChart: {
          chart: {
            spec: {
              title,
              basicChart: {
                chartType: apiChartType,
                legendPosition: options?.legend === 'none' ? 'NO_LEGEND' : 'BOTTOM_LEGEND',
                axis,
                domains: [{ domain: { sourceRange: { sources: [source(0)] } } }],
                series,
                headerCount: 1,
              },
              hiddenDimensionStrategy: 'SKIP_HIDDEN_ROWS_AND_COLUMNS',
              titleTextFormat: {
                foregroundColorStyle: { rgbColor: hexColor('#173e32') },
                fontFamily: 'Roboto',
                fontSize: 15,
                bold: true,
              },
              fontName: 'Roboto',
            },
            position: {
              overlayPosition: {
                anchorCell: { sheetId, rowIndex: row - 1, columnIndex: column - 1 },
                widthPixels: 560,
                heightPixels: 300,
              },
            },
          },
        },
      }],
    }, sheet.getParent().getId());
    const chartId = Number(response?.replies?.[0]?.addChart?.chart?.chartId || 0);
    if (!chartId) throw new Error(`Dashboard chart creation returned no chart ID: ${title}`);
    return chartId;
  }

  function buildDashboardBirthdayFormula(directoryLastColumn: number): string {
    const endColumn = columnNumberToA1(Math.max(1, directoryLastColumn));
    return '=IFERROR(LET(\n'
      + 'hdr,Directory!1:1,\n'
      + 'cLast,MATCH("last_name",hdr,0),\n'
      + 'cFirst,MATCH("first_name",hdr,0),\n'
      + 'cDob,MATCH("dob",hdr,0),\n'
      + `raw,CHOOSECOLS(Directory!A3:${endColumn},cLast,cFirst,cDob),\n`
      + 'data,FILTER(raw,INDEX(raw,,1)<>"",INDEX(raw,,3)<>""),\n'
      + 'parsedDob,MAP(INDEX(data,,3),LAMBDA(d,IF(d="","",IFERROR(TO_DATE(VALUE(d)),IFERROR(DATEVALUE(d),""))))),\n'
      + 'clean,FILTER(HSTACK(INDEX(data,,1),INDEX(data,,2),parsedDob),parsedDob<>""),\n'
      + 'birthdaysThisYear,MAP(INDEX(clean,,3),LAMBDA(d,DATE(YEAR(TODAY()),MONTH(d),DAY(d)))),\n'
      + 'weekStarts,MAP(birthdaysThisYear,LAMBDA(d,d-WEEKDAY(d,1)+1)),\n'
      + 'sorted,SORT(HSTACK(clean,birthdaysThisYear,weekStarts),4,TRUE,1,TRUE,2,TRUE),\n'
      + 'sortedLast,INDEX(sorted,,1),\n'
      + 'sortedFirst,INDEX(sorted,,2),\n'
      + 'sortedDob,INDEX(sorted,,3),\n'
      + 'sortedBirthdays,INDEX(sorted,,4),\n'
      + 'sortedWeeks,INDEX(sorted,,5),\n'
      + 'displayNames,MAP(sortedLast,sortedFirst,sortedBirthdays,LAMBDA(lastName,firstName,birthday,"C/"&IF(COUNTIF(sortedLast,lastName)>1,LEFT(firstName,1)&". ","")&lastName&" ("&TEXT(birthday,"M/D")&")")),\n'
      + 'groups,MAP(sortedWeeks,LAMBDA(weekStart,MATCH(weekStart,UNIQUE(sortedWeeks),0))),\n'
      + 'HSTACK(sortedLast,sortedFirst,sortedDob,displayNames,groups)\n'
      + '),"")';
  }

  function removeRetiredFaqSheet(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const faqs = ss.getSheetByName('FAQs');
    if (!faqs) return;
    faqs.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((protection) => protection.remove());
    faqs.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((protection) => protection.remove());
    ss.deleteSheet(faqs);
    Log.info('Removed retired FAQs sheet after consolidating current guidance into Dashboard.');
  }

  function applyDashboardFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Dashboard');
    const directory = ss.getSheetByName('Directory');
    if (!sheet || !directory) return;
    const sources = dashboardAttendanceSources(ss);
    const currentAttendance = sources.find((source) => source.label === 'Current');
    const requiredRows = Math.max(120, directory.getLastRow() + 54);
    if (sheet.getMaxRows() < requiredRows) sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
    if (sheet.getMaxColumns() < 12) sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());

    sheet.getCharts().forEach((chart) => sheet.removeChart(chart));
    sheet.clearConditionalFormatRules();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart().clear();
    if (sheet.getMaxColumns() > 12) sheet.deleteColumns(13, sheet.getMaxColumns() - 12);
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(0);
    (sheet as any).setHiddenGridlines?.(true);
    sheet.getRange(1, 1, sheet.getMaxRows(), 12)
      .setFontFamily('Roboto')
      .setFontSize(10)
      .setFontColor('#26332e')
      .setBackground('#f7f9f8')
      .setVerticalAlignment('middle');

    sheet.getRange('A1:L1').merge().setValue('SHAMROCK Dashboard')
      .setBackground('#173e32').setFontColor('#ffffff').setFontWeight('bold').setFontSize(20)
      .setHorizontalAlignment('left');
    sheet.getRange('A2:L2').merge()
      .setValue('Roster, accountability, resources, and historical context in one place')
      .setBackground('#2b6e55').setFontColor('#eaf3ef').setFontSize(10)
      .setHorizontalAlignment('left');

    const styleSectionHeader = (a1: string, title: string) => {
      sheet.getRange(a1).merge().setValue(title)
        .setBackground('#dfe9e4').setFontColor('#173e32').setFontWeight('bold').setFontSize(11)
        .setHorizontalAlignment('left')
        .setBorder(false, false, true, false, false, false, '#98ada4', SpreadsheetApp.BorderStyle.SOLID);
    };
    styleSectionHeader('A4:D4', 'Quick actions');
    styleSectionHeader('E4:L4', 'At a glance');

    const formulaLink = (url: string, label = 'Open →') => {
      if (!url) return '';
      return `=HYPERLINK("${url.replace(/"/g, '""')}","${label.replace(/"/g, '""')}")`;
    };
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
    const sheetUrl = (name: string) => {
      const target = ss.getSheetByName(name);
      return target ? `${ss.getUrl()}#gid=${target.getSheetId()}` : '';
    };
    const quickLinks = [
      ['Directory', sheetUrl('Directory')],
      ['Attendance', sheetUrl('Attendance')],
      ['Leadership contacts', sheetUrl('Leadership')],
      ['Submit attendance', formUrlFor('ATTENDANCE_FORM_ID')],
      ['Request an excusal', formUrlFor('EXCUSAL_REQUEST_FORM_ID')],
      ['Update directory info', formUrlFor('CADET_DIRECTORY_FORM_ID')],
    ];
    quickLinks.forEach(([label, url], index) => {
      const row = index + 5;
      sheet.getRange(row, 1, 1, 2).merge().setValue(label).setFontWeight('bold').setBackground('#ffffff');
      const action = sheet.getRange(row, 3, 1, 2).merge().setHorizontalAlignment('center')
        .setFontColor('#1f5f49').setFontWeight('bold').setBackground('#edf4f1');
      const linkFormula = formulaLink(url);
      if (linkFormula) action.setFormula(linkFormula);
      else action.setValue('Unavailable').setFontColor('#7a8781');
      sheet.getRange(row, 1, 1, 4).setBorder(true, true, true, true, false, false, '#d7e0dc', SpreadsheetApp.BorderStyle.SOLID);
    });

    const directoryHeaders = readHeaderRows(ss, directory).machine.map((header) => header.toLowerCase());
    const directoryLastNameIndex = directoryHeaders.indexOf('last_name');
    const directoryAsYearIndex = directoryHeaders.indexOf('as_year');
    const directoryLastNames = directoryLastNameIndex >= 0 ? dashboardColumnRange(directory, directoryLastNameIndex) : '';
    const directoryAsYears = directoryAsYearIndex >= 0 ? dashboardColumnRange(directory, directoryAsYearIndex) : '';
    const countYears = (years: string[]) => directoryAsYears
      ? `=${years.map((year) => `COUNTIF(${directoryAsYears},"${year}")`).join('+')}`
      : '=""';
    const currentOverall = currentAttendance ? dashboardColumnRange(currentAttendance.sheet, currentAttendance.overallIndex) : '';
    const currentLastNames = currentAttendance ? dashboardColumnRange(currentAttendance.sheet, currentAttendance.lastNameIndex) : '';
    const overallAverage = currentOverall && currentLastNames
      ? `=IFERROR(AVERAGE(FILTER(${currentOverall},${currentLastNames}<>"",${currentOverall}<>"")),"")`
      : '=""';
    const attendanceHeaders = currentAttendance ? readHeaderRows(ss, currentAttendance.sheet).machine : [];
    const llabIndex = attendanceHeaders.map((header) => header.toLowerCase()).indexOf(ATT_HEADER_LLAB.toLowerCase());
    const currentLlab = currentAttendance && llabIndex >= 0 ? dashboardColumnRange(currentAttendance.sheet, llabIndex) : '';
    const llabAverage = currentLlab && currentLastNames
      ? `=IFERROR(AVERAGE(FILTER(${currentLlab},${currentLastNames}<>"",${currentLlab}<>"")),"")`
      : '=""';
    const underEighty = currentOverall && currentLastNames
      ? `=IFERROR(COUNTIF(FILTER(${currentOverall},${currentLastNames}<>"",${currentOverall}<>""),"<0.8"),0)`
      : '=0';
    const metricCards = [
      { label: 'Total cadets', labelRange: 'E5:G5', valueRange: 'E6:G7', formula: directoryLastNames ? `=COUNTA(${directoryLastNames})` : '=""', format: '0' },
      { label: 'GMC cadets', labelRange: 'H5:J5', valueRange: 'H6:J7', formula: countYears(Arrays.GMC_AS_YEARS), format: '0' },
      { label: 'POC cadets', labelRange: 'K5:L5', valueRange: 'K6:L7', formula: countYears(Arrays.POC_AS_YEARS), format: '0' },
      { label: 'Average overall', labelRange: 'E8:G8', valueRange: 'E9:G10', formula: overallAverage, format: '0.0%' },
      { label: 'Average LLAB', labelRange: 'H8:J8', valueRange: 'H9:J10', formula: llabAverage, format: '0.0%' },
      { label: 'Below 80%', labelRange: 'K8:L8', valueRange: 'K9:L10', formula: underEighty, format: '0' },
    ];
    metricCards.forEach((card) => {
      sheet.getRange(card.labelRange).merge().setValue(card.label).setFontWeight('bold').setFontColor('#53635c')
        .setBackground('#ffffff').setHorizontalAlignment('center');
      sheet.getRange(card.valueRange).merge().setFormula(card.formula).setNumberFormat(card.format)
        .setFontWeight('bold').setFontSize(18).setFontColor('#173e32').setBackground('#ffffff')
        .setHorizontalAlignment('center');
      const bounds = `${card.labelRange.split(':')[0]}:${card.valueRange.split(':')[1]}`;
      sheet.getRange(bounds).setBorder(true, true, true, true, false, false, '#d7e0dc', SpreadsheetApp.BorderStyle.SOLID);
    });

    let chartRanges: DashboardChartRanges | null = null;
    ProgressService.report({
      title: 'Preparing Dashboard chart data',
      detail: `Recalculating current attendance and ${Math.max(0, sources.length - 1)} historical term comparison(s).`,
      hint: 'Charts use source cells directly beneath each graphic so hidden support sheets cannot blank the visualization.',
    });
    try {
      chartRanges = buildDashboardChartData(ss, sheet, directory, sources);
      ProgressService.report({
        title: 'Drawing Dashboard charts',
        detail: 'Creating attendance comparisons, the term trend, the flight summary, and roster composition.',
      });
      const chartIds = [
        insertDashboardChart(sheet, chartRanges.attendanceByAsYear, 'Overall Attendance by AS Year — Current vs Historical', Charts.ChartType.COLUMN, 12, 1, { percentAxis: true }),
        insertDashboardChart(sheet, chartRanges.attendanceTrend, 'Detachment Attendance Trend by Term', Charts.ChartType.LINE, 12, 7, { percentAxis: true, legend: 'none', colors: ['#2b6e55'] }),
        insertDashboardChart(sheet, chartRanges.attendanceByFlight, 'Current Overall Attendance by Flight', Charts.ChartType.COLUMN, 31, 1, { percentAxis: true, legend: 'none', colors: ['#2b6e55'] }),
        insertDashboardChart(sheet, chartRanges.rosterByAsYear, 'Current Roster by AS Year', Charts.ChartType.BAR, 31, 7, { horizontal: true, legend: 'none', colors: ['#557f70'] }),
      ];
      SpreadsheetApp.flush();
      if (chartIds.length !== 4 || chartIds.some((chartId) => !chartId)) throw new Error('Dashboard chart verification failed.');
      ProgressService.report({
        title: 'Dashboard charts ready',
        detail: 'Verified four native Sheets charts with recalculated source ranges and explicit axes.',
      });
    } finally {
      const helper = chartRanges?.helperSheet || ss.getSheetByName(DASHBOARD_HELPER_SHEET);
      if (helper && !helper.isSheetHidden()) helper.hideSheet();
    }

    styleSectionHeader('A49:E49', 'Birthday calendar');
    styleSectionHeader('G49:L49', 'How to use SHAMROCK');
    sheet.getRange('A50:E50').setValues([['Last Name', 'First Name', 'Birthday', 'Display', 'Group']])
      .setBackground('#edf2f0').setFontWeight('bold').setHorizontalAlignment('left')
      .setBorder(true, true, true, true, true, true, '#cfd9d5', SpreadsheetApp.BorderStyle.SOLID);
    const birthdayRows = sheet.getMaxRows() - 50;
    sheet.getRange(51, 1, birthdayRows, 5).setBackground('#ffffff').setFontColor('#26332e')
      .setBorder(false, true, true, true, false, true, '#e2e7e5', SpreadsheetApp.BorderStyle.SOLID)
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sheet.getRange('A51').setFormula(buildDashboardBirthdayFormula(directory.getLastColumn()));
    sheet.getRange(51, 3, birthdayRows, 1).setNumberFormat('M/D/YYYY');
    sheet.getRange(51, 5, birthdayRows, 1).setHorizontalAlignment('center');
    const birthdayBanding = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($E51<>"",ISEVEN($E51))')
      .setBackground('#eef1f0')
      .setRanges([sheet.getRange(51, 1, birthdayRows, 5)])
      .build();
    sheet.setConditionalFormatRules([birthdayBanding]);

    const infoHeader = (a1: string, title: string) => {
      sheet.getRange(a1).merge().setValue(title).setBackground('#edf2f0').setFontWeight('bold').setFontColor('#173e32');
    };
    const infoBody = (a1: string, value: string) => {
      sheet.getRange(a1).merge().setValue(value).setBackground('#ffffff').setWrap(true).setVerticalAlignment('top')
        .setBorder(true, true, true, true, false, false, '#d7e0dc', SpreadsheetApp.BorderStyle.SOLID);
    };
    infoHeader('G50:L50', 'Core expectations');
    infoBody('G51:L54', 'SHAMROCK is the read-only source for the current roster, attendance, leadership contacts, and participation history.\n\nCheck Attendance regularly, verify your marks, and report discrepancies promptly. Do not edit managed cells directly.');
    infoHeader('G56:L56', 'Attendance and excusals');
    infoBody('G57:L61', 'Attendance is recorded once per cadet and event. Submit excusal requests before the event whenever possible; submitting a request does not automatically excuse the absence.\n\nIf a mark looks wrong, first check whether a request is pending or denied, then contact flight leadership. Do not submit duplicate requests for the same event.');
    infoHeader('G63:L63', 'Attendance codes');
    const codeRows = [
      ['P', 'Present / full credit'], ['T', 'Tardy / credit'], ['A', 'Absent — follow-up required'],
      ['R', 'Excusal request pending'], ['D', 'Request denied before event; attendance required'],
      ['U', 'Unexcused absence'], ['E', 'Excused'], ['ES', 'Excused — sport'],
      ['MED', 'Medical'], ['N/A', 'Not expected / not applicable'],
    ];
    codeRows.forEach(([code, meaning], index) => {
      const row = 64 + index;
      sheet.getRange(row, 7, 1, 2).merge().setValue(code).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#ffffff');
      sheet.getRange(row, 9, 1, 4).merge().setValue(meaning).setBackground('#ffffff');
      sheet.getRange(row, 7, 1, 6).setBorder(false, false, true, false, false, false, '#e2e7e5', SpreadsheetApp.BorderStyle.SOLID);
    });
    infoHeader('G75:L75', 'Getting help');
    infoBody('G76:L79', 'Start with your Flight Commander for attendance or roster questions. Escalate through squadron leadership or cadre when needed. Use the Leadership link above for current contact information.');

    const widths = [115, 115, 90, 190, 70, 18, 95, 95, 95, 120, 95, 95];
    widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
    sheet.setRowHeight(1, 38);
    sheet.setRowHeight(2, 24);
    sheet.setRowHeight(3, 10);
    sheet.setRowHeight(4, 26);
    sheet.setRowHeights(5, 6, 28);
    sheet.setRowHeight(11, 10);
    sheet.setRowHeights(12, 37, 22);
    sheet.setRowHeight(49, 28);
    sheet.setRowHeight(50, 26);
    sheet.setRowHeights(51, birthdayRows, 24);
    [51, 57, 76].forEach((row) => sheet.setRowHeight(row, 38));
    [52, 53, 54, 58, 59, 60, 61, 77, 78, 79].forEach((row) => sheet.setRowHeight(row, 30));

    removeRetiredFaqSheet(ss);
    Log.info(
      `Dashboard rebuilt with managed links, metrics, charts=${sheet.getCharts().length}, `
      + `birthdaySource=Directory groupRule=Sunday-Saturday historicalTerms=${Math.max(0, sources.length - 1)}.`,
    );
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
