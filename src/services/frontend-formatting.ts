// Frontend formatting: band tables and apply data validations from Data Legend.

namespace FrontendFormattingService {
  interface NamedRangeDef {
    name: string;
    range: GoogleAppsScript.Spreadsheet.Range;
  }

  const ATTENDANCE_SCHEMA = Schemas.getTabSchema('Attendance');
  const ATTENDANCE_BASE_HEADERS = ATTENDANCE_SCHEMA?.machineHeaders || ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'llab_attendance_pct'];
  const ATT_HEADER_OVERALL = ATTENDANCE_BASE_HEADERS.find((h) => h.includes('overall_attendance')) || 'overall_attendance_pct';
  const ATT_HEADER_LLAB = ATTENDANCE_BASE_HEADERS.find((h) => h.includes('llab_attendance')) || 'llab_attendance_pct';

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
      flight_options: 'FLIGHTS',
      squadron_options: 'SQUADRONS',
      university_options: 'UNIVERSITIES',
      dorm_options: 'DORMS',
      home_state_options: 'HOME_STATES',
      cip_broad_area_options: 'CIP_BROAD_AREAS',
      afsc_options: 'AFSC_OPTIONS',
      flight_path_status_options: 'FLIGHT_PATH_STATUSES',
      attendance_code_options: 'ATTENDANCE_CODES',
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

  function applyBandingToFrontendTables(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    Schemas.FRONTEND_TABS.forEach((tab) => {
      if (tab.name === 'FAQs' || tab.name === 'Dashboard') return; // FAQs is freeform text; Dashboard handled separately
      const sheet = ss.getSheetByName(tab.name);
      if (!sheet) return;
      const lastRow = Math.max(sheet.getLastRow(), 3);
      const lastCol = Math.max(sheet.getLastColumn(), 1);
      sheet.getBandings().forEach((b) => b.remove());
      const bandWidth = tab.name === 'Dashboard' ? Math.min(8, lastCol) : lastCol; // limit Dashboard banding to A:H
      const bandRange = sheet.getRange(2, 1, Math.max(1, lastRow - 1), bandWidth);
      bandRange.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
    });
  }

  function applyDirectoryValidations(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Directory');
    if (!sheet) return;

    try {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || ''));
      const headerIndex = (name: string) => headers.indexOf(name);

      const map: Record<string, string> = {
        as_year: 'AS_YEARS',
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

      Object.entries(map).forEach(([field, rangeName]) => {
        const colIdx = headerIndex(field);
        if (colIdx < 0) return;
        const namedRange = ss.getRangeByName(rangeName);
        if (!namedRange) return;
        const dataRange = sheet.getRange(3, colIdx + 1, Math.max(1, sheet.getMaxRows() - 2), 1);
        const rule = SpreadsheetApp.newDataValidation()
          .requireValueInRange(namedRange, true)
          .setAllowInvalid(false)
          .build();
        try {
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
        dataRange.setDataValidation(rule);
      });
    };

    applyToSheet('Attendance');
    applyToSheet('Attendance Matrix Backend');
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

    applyDirectoryValidations(ss);
    applyAttendanceValidations(ss);

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
      applyFaqsFormatting(ss); // enforce single-row canvas even when formatting is disabled
      ensureFaqSingleRow(ss);
      return;
    }

    freezeTopTwoRowsAllSheets(ss); // Skip freezing rows on FAQs
    applyBandingToFrontendTables(ss);
    applyDirectoryFormatting(ss);
    applyLeadershipFormatting(ss);
    applyDashboardFormatting(ss);
    applyFaqsFormatting(ss);
    applyDataLegendFormatting(ss);
    applyAttendanceFormatting(ss);
    ensureFaqSingleRow(ss);
  }

  // Final safety net to guarantee FAQs stays a single-row canvas even if earlier formatting failed.
  function ensureFaqSingleRow(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('FAQs');
    if (!sheet) return;
    try {
      sheet.setFrozenRows(0);
      const maxRows = sheet.getMaxRows();
      if (maxRows > 1) sheet.deleteRows(2, maxRows - 1);
      try {
        (sheet as any).setMaxRows?.(1);
      } catch (err) {
        Log.warn(`Unable to force FAQs max rows to 1: ${err}`);
      }
    } catch (err) {
      Log.warn(`Unable to enforce single-row FAQs: ${err}`);
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
    const lastDataRow = Math.max(3, sheet.getLastRow());
    const maxRows = sheet.getMaxRows();
    if (maxRows > lastDataRow) {
      sheet.deleteRows(lastDataRow + 1, maxRows - lastDataRow);
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

    setColumnWidths(sheet, {
      as_year: 100,
      class_year: 75,
      flight: 75,
      squadron: 75,
      university: 100,
      email: 175,
      phone: 125,
      cip_code: 75,
      dob: 100,
      flight_path_status: 125,
    });

    // Fit-to-data widths where requested.
    ['last_name', 'first_name', 'email', 'dorm', 'home_town', 'home_state', 'cip_broad_area', 'desired_assigned_afsc', 'photo_link', 'notes'].forEach((h) => {
      const idx = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(h);
      if (idx >= 0) sheet.autoResizeColumn(idx + 1);
    });

    // Alignments
    const dataRange = sheet.getRange(3, 1, Math.max(1, sheet.getMaxRows() - 2), sheet.getLastColumn());
    dataRange.setHorizontalAlignment('left');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const alignCenter = (key: string) => {
      const idx = headers.indexOf(key);
      if (idx >= 0) sheet.getRange(3, idx + 1, Math.max(1, sheet.getMaxRows() - 2), 1).setHorizontalAlignment('center');
    };
    alignCenter('phone');
    alignCenter('cip_code');
    const dobIdx = headers.indexOf('dob');
    if (dobIdx >= 0) sheet.getRange(3, dobIdx + 1, Math.max(1, sheet.getMaxRows() - 2), 1).setHorizontalAlignment('right');

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
    sheet.autoResizeColumn(1);
    sheet.autoResizeColumn(2);
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
    if (overallIdx !== undefined) sheet.setColumnWidth(overallIdx + 1, 75);
    if (llabIdx !== undefined) sheet.setColumnWidth(llabIdx + 1, 75);
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

    setColumnWidths(sheet, {
      as_year: 100,
      class_year: 75,
      flight: 75,
      squadron: 75,
      university: 100,
      email: 175,
      phone: 125,
      cip_code: 75,
      dob: 100,
      flight_path_status: 125,
    });

    ['last_name', 'first_name', 'email', 'dorm', 'home_town', 'home_state', 'cip_broad_area', 'desired_assigned_afsc', 'photo_link', 'notes'].forEach((h) => {
      const idx = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(h);
      if (idx >= 0) sheet.autoResizeColumn(idx + 1);
    });
  }

  function columnToLetter(col: number): string {
    let temp = '';
    let n = col;
    while (n > 0) {
      const rem = (n - 1) % 26;
      temp = String.fromCharCode(65 + rem) + temp;
      n = Math.floor((n - 1) / 26);
    }
    return temp;
  }

  function applyLeadershipFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Leadership');
    if (!sheet) return;
    sheet.autoResizeColumns(1, sheet.getLastColumn());
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);

    // Hide reports_to helper column for charting.
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
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
    sheet.autoResizeColumns(1, sheet.getLastColumn());
  }

  function applyDashboardFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('Dashboard');
    if (!sheet) return;
    setDefaultFont(sheet);

    // Section titles (row 1)
    sheet.getRange('A1').setValue('Quick Links');
    sheet.getRange('D1').setValue('Key Metrics');
    sheet.getRange('G1').setValue('Attendance Charts');
    sheet.getRange('I1').setValue('Birthdays (auto from Directory)');

    // Quick links table
    const quickLinksHeader = [['Name', 'URL']];

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
    sheet.getRange(2, 1, 1, 2).setValues(quickLinksHeader).setFontWeight('bold');
    sheet.getRange(3, 1, quickLinks.length, 2).setValues(quickLinks);

    // Key metrics placeholders
    const metricsHeader = [['Metric', 'Value']];
    const metrics = [
      ['Total Cadets', '=COUNTA(Directory!A3:A)'],
      ['Pending Excusals (backend-fed later)', ''],
      ['Upcoming Events (manual)', ''],
      ['Attendance YTD (manual)', ''],
    ];
    sheet.getRange(2, 4, 1, 2).setValues(metricsHeader).setFontWeight('bold');
    sheet.getRange(3, 4, metrics.length, 2).setValues(metrics);

    // Attendance charts placeholder
    sheet.getRange('G2').setValue('Add charts here using Attendance data').setFontStyle('italic');

    // Birthdays view sourced from Directory
    const birthdayHeaders = [['Last Name', 'First Name', 'Birthday', 'Display', 'Group']];
    sheet.getRange(2, 9, 1, birthdayHeaders[0].length).setValues(birthdayHeaders).setFontWeight('bold');

    // Clear existing birthdays block to allow spills to expand
    sheet.getRange('I3:M').clearContent();

    // Names + DOB (sorted by calendar order) -> spill into Last/First/Birthday
    sheet.getRange('I3').setFormula(
      '=LET(\n' +
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
      'table, IF(clean="", "", HSTACK(INDEX(clean,,1), INDEX(clean,,2), INDEX(clean,,3), sortKey)),\n' +
      'sorted, IF(table="", "", SORT(table, 4, TRUE)),\n' +
      'IF(sorted="", "", HSTACK(INDEX(sorted,,1), INDEX(sorted,,2), INDEX(sorted,,3)))\n' +
      ')'
    );

    // Display column (duplicate-aware cadet label)
    sheet.getRange('L3').setFormula(
      '=ARRAYFORMULA(LET(\n'
      + '  last, I3:I,\n'
      + '  first, J3:J,\n'
      + '  dob, K3:K,\n'
      + '  dup, IF(last="", 0, COUNTIF(last, last)),\n'
      + '  label, IF(last="", "", "C/" & IF(dup>1, LEFT(first,1) & ". ", "") & last),\n'
      + '  IF(label="", "", label & IF(dob="", "", " (" & TEXT(dob, "M/D") & ")"))\n'
      + '))'
    );

    // Group column (week grouping from birthdays in column K)
    sheet.getRange('M3').setFormula(
      '=ARRAYFORMULA(LET(\n'
      + '  names, I3:I,\n'
      + '  dobs, K3:K,\n'
      + '  mask, (names<>"")*(dobs<>""),\n'
      + '  wnums, IF(mask, WEEKNUM(DATE(YEAR(TODAY()), MONTH(dobs), DAY(dobs)), 1), ),\n'
      + '  uniq, FILTER(UNIQUE(wnums), UNIQUE(wnums)<>""),\n'
      + '  IF(mask, IF(COUNTA(uniq)=0, "", XMATCH(wnums, uniq)), "")\n'
      + '))'
    );

    // Alternating shading by group (odd groups grey, even groups default)
    const cfRange = sheet.getRange('I3:M');
    const rules = sheet.getConditionalFormatRules().filter((r) => {
      const f = r.getBooleanCondition()?.getCriteriaValues?.()?.[0] as string | undefined;
      return f !== '=ISODD($M3)';
    });
    const oddGroupRule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=ISODD($M3)')
      .setBackground('#f0f0f0')
      .setRanges([cfRange])
      .build();
    rules.push(oddGroupRule);
    sheet.setConditionalFormatRules(rules);

    // Apply light banding only to the non-birthday block (A:H).
    sheet.getBandings().forEach((b) => b.remove());
    const bandRows = Math.max(1, sheet.getLastRow() - 1);
    sheet.getRange(2, 1, bandRows, Math.min(8, sheet.getLastColumn()))
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);

    // Layout polish
    sheet.autoResizeColumns(1, 2); // quick links
    sheet.setColumnWidth(2, 160);
    sheet.autoResizeColumns(4, 2); // metrics
    sheet.setColumnWidth(7, 220); // charts note area
    sheet.setColumnWidth(9, 125); // Last Name
    sheet.setColumnWidth(10, 125); // First Name
    sheet.setColumnWidth(11, 100); // Birthday
    sheet.setColumnWidth(12, 175); // Display
    sheet.setColumnWidth(13, 75); // Group
    sheet.getRange('I3:I').setHorizontalAlignment('left');
    sheet.getRange('J3:J').setHorizontalAlignment('left');
    sheet.getRange('K3:K').setNumberFormat('M/D/YYYY');
    sheet.getRange('L3:L').setWrap(true);
    sheet.getRange('M3:M').setHorizontalAlignment('center');
    sheet.getRange('M3:M').setNumberFormat('0');

    // Trim unused space to keep the canvas tight.
    const maxNeededCols = 13; // A-M used for layout
    const maxCols = sheet.getMaxColumns();
    if (maxCols > maxNeededCols) {
      sheet.deleteColumns(maxNeededCols + 1, maxCols - maxNeededCols);
    }

    pruneTrailingRows(sheet);
  }

  function applyFaqsFormatting(ss: GoogleAppsScript.Spreadsheet.Spreadsheet) {
    const sheet = ss.getSheetByName('FAQs');
    if (!sheet) return;

    // Remove old header rows if they match the legacy schema.
    try {
      const first = String(sheet.getRange(1, 1).getValue() || '').trim().toLowerCase();
      const second = String(sheet.getRange(2, 1).getValue() || '').trim().toLowerCase();
      if (first === 'faq' && (!second || second === 'faq')) {
        const deleteCount = Math.min(2, sheet.getMaxRows());
        if (deleteCount > 0) sheet.deleteRows(1, deleteCount);
      }
    } catch (err) {
      Log.warn(`Unable to normalize FAQ headers: ${err}`);
    }

    // Ensure no frozen rows/columns so the page behaves like a blank canvas.
    // (Sheets can refuse to delete rows if it would remove all non-frozen rows.)
    try {
      sheet.setFrozenRows(0);
      sheet.setFrozenColumns(0);
    } catch (err) {
      Log.warn(`Unable to unfreeze FAQ sheet: ${err}`);
    }

    // Strip banding and keep a single wide column for freeform text.
    sheet.getBandings().forEach((b) => b.remove());
    const maxCols = sheet.getMaxColumns();
    if (maxCols > 1) {
      sheet.deleteColumns(2, maxCols - 1);
    }

    // Keep a single visible row; explicitly unfreeze before delete to avoid protected last-row issues.
    try {
      sheet.setFrozenRows(0);
      const maxRows = sheet.getMaxRows();
      if (maxRows > 1) {
        sheet.deleteRows(2, maxRows - 1);
      }
      try {
        (sheet as any).setMaxRows?.(1);
      } catch (err2) {
        Log.warn(`Unable to set FAQ max rows to 1: ${err2}`);
      }
    } catch (err) {
      Log.warn(`Unable to prune FAQ rows: ${err}`);
    }

    setDefaultFont(sheet);
    sheet.setColumnWidth(1, 1000);

    // Fit the single row to content (can be tall for long FAQs).
    try {
      sheet.autoResizeRows(1, 1);
    } catch (err) {
      Log.warn(`Unable to autoresize FAQ row: ${err}`);
    }

    // Allow freeform text starting at A1.
    const totalRows = Math.max(1, sheet.getMaxRows());
    const contentRange = sheet.getRange(1, 1, totalRows, 1);
    contentRange.setWrap(true).setVerticalAlignment('top').setHorizontalAlignment('left');
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

    const canSetRules = typeof (sheet as any).setConditionalFormatRules === 'function';
    const baseCount = ATTENDANCE_BASE_HEADERS.length;

    // Hide machine headers, prune, defaults
    pruneTrailingRows(sheet);
    hideMachineHeaderRow(sheet);
    setDefaultFont(sheet);

    // Rename percentage headers
    const display = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
    const headerToIndex = new Map(headers.map((h, idx) => [h.toLowerCase(), idx] as const));
    const llabIdx = headerToIndex.get(ATT_HEADER_LLAB.toLowerCase()) ?? -1;
    const overallIdx = headerToIndex.get(ATT_HEADER_OVERALL.toLowerCase()) ?? -1;
    if (llabIdx >= 0) display[llabIdx] = 'LLAB';
    if (overallIdx >= 0) display[overallIdx] = 'Overall';
    sheet.getRange(2, 1, 1, sheet.getLastColumn()).setValues([display]);

    // Widths and hides
    sheet.autoResizeColumn(1);
    sheet.autoResizeColumn(2);
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
    }
    // Explicitly center LLAB/Overall data columns (not just percentages) to avoid left drift.
    if (llabIdx >= 0) sheet.getRange(3, llabIdx + 1, dataRows, 1).setHorizontalAlignment('center');
    if (overallIdx >= 0) sheet.getRange(3, overallIdx + 1, dataRows, 1).setHorizontalAlignment('center');

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

    const rules: GoogleAppsScript.Spreadsheet.ConditionalFormatRule[] = [];

    // Attendance percentage gradient (LLAB/Overall columns)
    const maxRows = Math.max(3, sheet.getMaxRows());
    if (llabIdx >= 0 && overallIdx >= 0) {
      const startCol = Math.min(llabIdx, overallIdx) + 1;
      const colCount = Math.abs(llabIdx - overallIdx) + 1;
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .setGradientMinpointWithValue('0.8', SpreadsheetApp.InterpolationType.NUMBER, '#e67c73')
          .setGradientMidpointWithValue('0.9', SpreadsheetApp.InterpolationType.NUMBER, '#ffce65')
          .setGradientMaxpointWithValue('1', SpreadsheetApp.InterpolationType.NUMBER, '#57bb8a')
          .setRanges([sheet.getRange(1, startCol, maxRows, colCount)])
          .build(),
      );
    }

    // Attendance code colors for event columns
    const startRow = 3;
    const lastRow = Math.max(startRow, sheet.getLastRow());
    const rowCount = Math.max(1, lastRow - startRow + 1);
    const codePalette: Record<string, string> = {
      P: '#C8E6C9',
      E: '#BBDEFB',
      ES: '#E1BEE7',
      ER: '#FFF9C4',
      ED: '#FFE0B2',
      T: '#E0E0E0',
      U: '#FFCDD2',
      UR: '#F8BBD0',
      MU: '#D1C4E9',
      MRS: '#C5CAE9',
      'N/A': '#F5F5F5',
      '': '#FFFFFF',
    };
    headers.forEach((h, idx) => {
      if (idx < baseCount) return; // event columns only
      const colLetter = columnToLetter(idx + 1);
      const colRange = sheet.getRange(startRow, idx + 1, rowCount, 1);
      Object.entries(codePalette).forEach(([code, color]) => {
        rules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied(`=$${colLetter}${startRow}="${code}"`)
            .setBackground(color)
            .setRanges([colRange])
            .build(),
        );
      });
    });

    if (!canSetRules) {
      Log.warn('Skipping Attendance conditional formatting: setConditionalFormatRules not available in this environment.');
      return;
    }

    try {
      sheet.setConditionalFormatRules(rules);
    } catch (err) {
      Log.warn(`Unable to set conditional formatting on Attendance: ${err}`);
    }
  }
}
