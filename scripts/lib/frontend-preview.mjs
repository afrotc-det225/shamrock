// Synthetic presentation fixtures only. No provider bindings, D1 commands or production records.
// Baseline: src/config/schemas.ts, src/services/frontend-formatting.ts and src/services/excusals.ts.
const COLORS = { header: '#356854', dark: '#173E32', green: '#2B6E55', band: '#F6F8F9', text: '#434343', canvas: '#F7F9F8' };
const DECISION_COLORS = { Approved: ['#D9EAD3', '#274E13'], Denied: ['#F4CCCC', '#990000'], Withdrawn: ['#FFF2CC', '#7F6000'], Superseded: ['#D9D2E9', '#674EA7'] };
// Canonical option snapshot from src/utils/arrays.ts; regression tests prevent drift.
// Year, Flight and Squadron keep the existing representative fixture choices
// so native seed rules and their opaque option styles can be preserved.
const OPTIONS = {
  CADET_RANKS: ["C/4C","C/3C","C/2d Lt","C/1st Lt","C/Capt","C/Maj","C/Lt Col","C/Col"],
  RANKS: ["AB","Amn","A1C","SrA","SSgt","TSgt","MSgt","SMSgt","CMSgt","2d Lt","1st Lt","Capt","Maj","Lt Col","Col","Brig Gen","Maj Gen","Lt Gen","Gen"],
  HONORIFICS: ["Mr.","Mrs.","Ms.","Miss","Mx.","Dr.","Prof.","Rev.","Fr.","Sister","Brother"],
  UNIVERSITIES: ["Notre Dame","St. Mary's","Holy Cross","Trine","Valparaiso"],
  DORMS: ["Cross-Town","Off-Campus","Alumni Hall","Baumer Hall","Carroll Hall","Coyle Hall","Dillon Hall","Duncan Hall","Dunne Hall","Graham Family Hall","Keenan Hall","Keough Hall","Knott Hall","Morrissey Hall","O'Neill Family Hall","Siegfried Hall","Sorin Hall","Stanford Hall","St. Edward's Hall","Badin Hall","Breen-Phillips Hall","Cavanaugh Hall","Farley Hall","Flaherty Hall","Grojean Hall","Johnson Family Hall","Lewis Hall","Lyons Hall","McGlinn Hall","Pasquerilla East Hall","Pasquerilla West Hall","Ryan Hall","Walsh Hall","Welsh Family Hall","Undergraduate Community at Fischer","Fischer Graduate Residences"],
  CIP_BROAD_AREAS: ["01 - Agricultural/Animal/Plant/Veterinary Science and Related Fields","03 - Natural Resources and Conservation","04 - Architecture and Related Services","05 - Area, Ethnic, Cultural, Gender, and Group Studies","09 - Communication, Journalism, and Related Programs","10 - Communications Technologies/Technicians and Support Services","11 - Computer and Information Sciences and Support Services","12 - Culinary, Entertainment, and Personal Services","13 - Education","14 - Engineering","15 - Engineering/Engineering-Related Technologies/Technicians","16 - Foreign Languages, Literatures, and Linguistics","19 - Family and Consumer Sciences/Human Sciences","21 - Reserved","22 - Legal Professions and Studies","23 - English Language and Literature/Letters","24 - Liberal Arts and Sciences, General Studies and Humanities","25 - Library Science","26 - Biological and Biomedical Sciences","27 - Mathematics and Statistics","28 - Military Science, Leadership and Operational Art","29 - Military Technologies and Applied Sciences","30 - Multi/Interdisciplinary Studies","31 - Parks, Recreation, Leisure, Fitness, and Kinesiology","32 - Basic Skills and Developmental/Remedial Education","33 - Citizenship Activities","34 - Health-Related Knowledge and Skills","35 - Interpersonal and Social Skills","36 - Leisure and Recreational Activities","37 - Personal Awareness and Self-Improvement","38 - Philosophy and Religious Studies","39 - Theology and Religious Vocations","40 - Physical Sciences","41 - Science Technologies/Technicians","42 - Psychology","43 - Homeland Security, Law Enforcement, Firefighting and Related Protective Services","44 - Public Administration and Social Service Professions","45 - Social Sciences","46 - Construction Trades","47 - Mechanic and Repair Technologies/Technicians","48 - Precision Production","49 - Transportation and Materials Moving","50 - Visual and Performing Arts","51 - Health Professions and Related Programs","52 - Business, Management, Marketing, and Related Support Services","53 - High School/Secondary Diplomas and Certificates","54 - History","55 - Reserved","60 - Health Professions Residency/Fellowship Programs","61 - Medical Residency/Fellowship Programs"],
  AFSC_OPTIONS: ["Undecided","Space Force","11X - Pilot","12X - Combat Systems Officer","13A - Astronaut","13B - Air Battle Manager","13H - Aerospace Physiologist","13M - Airfield Operations","13N - Nuclear and Missile Operations","13O - Multi-Domain Warfare Officer","13S - Space Operations","13Z - Rated Multi-Domain Warfare Officer","14F - Information Operations","14N - Intelligence","15A - Operations Analysis Officer","15W - Weather and Environmental Sciences","16F - Foreign Area Officer (FAO)","16G - Air Force Operations Staff Officer","16K - Software Development Officer (SDO)","16P - Political-Military Affairs Strategist (PAS)","16R - Planning and Programming","16Z - Rated Foreign Area Officer (FAO)","17D - Warfighter Communications","17S - Cyberspace Effects Operations","17W - Warfighter Communications & IT Systems","17Y - Cyber Effects & Warfare Operations","18X - Remotely Piloted Aircraft (RPA) Pilot","19G - Space Warfare Officer","19Z - Special Warfare","21A - Aircraft Maintenance","21M - Munitions and Missile Maintenance","21R - Logistics Readiness","31P - Security Forces","32E - Civil Engineer","35B - Band","35P - Public Affairs","38F - Force Support","41A - Healthcare Administrator","42X - Biomedical Clinician","43X - Biomedical Specialists","44X - Physician","46X - Nurse","47X - Dental","48X - Aerospace Medicine","51J - Judge Advocate","52R - Chaplain","61C - Chemist/Nuclear Chemist","61D - Physicist/Nuclear Engineer","62E - Developmental Engineer","62S - Materiel Leader","63A - Acquisition Manager","64P - Contracting","65F - Financial Management","65W - Cost Analysis","71S - Special Investigations","92F0 - Foreign Area Officer (FAO) Trainee","92J0 - Non-designated Lawyer","92J1 - AFROTC Educational Delay Law Student","92J2 - Funded Legal Education Program Law Student","92J3 - Excess Leave Law Student","92M0 - HPSP Medical Student","92M1 - USUHS Student","92M2 - HPSP Biomedical Science Student","92P0 - Physician Assistant Student","92T0 - Pilot Trainee","92T1 - Combat Systems Officer Trainee","92T2 - Air Battle Manager Trainee","92T3 - Remotely Piloted Aircraft Pilot Trainee"],
  HOME_STATES: ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"],
  FLIGHT_PATH_STATUSES: ["Participating 1/4","Enrolled 2/4","Active 3/4","Ready 4/4","Inactive","Commissioned","Dropped"],
};
const CODES = ['P', 'T', 'A', 'R', 'D', 'U', 'E', 'ES', 'MED', 'N/A'];
const DECISIONS = Object.keys(DECISION_COLORS);
const FLIGHTS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const YEARS = ['AS100', 'AS200', 'AS300', 'AS400'];
const DIRECTORY = {
  machine: ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'rank', 'role', 'university', 'email', 'phone', 'dorm', 'cip_broad_area', 'cip_code', 'desired_assigned_afsc', 'home_town', 'home_state', 'class_year', 'dob', 'flight_path_status', 'photo_link'],
  display: ['Last Name', 'First Name', 'Year', 'Flight', 'Sqdn', 'Rank', 'Role', 'University', 'Email', 'Phone Number', 'Dorm', 'CIP Broad Area', 'CIP', 'Desired / Assigned AFSC', 'Home Town', 'Home State', 'Class', 'DOB', 'Flight Path', 'Photo Link'],
};
const LEADERSHIP = {
  machine: ['last_name', 'first_name', 'rank', 'role', 'reports_to', 'email', 'cell_phone', 'office_phone', 'office_location'],
  display: ['Last Name', 'First Name', 'Rank', 'Role', 'Reports To', 'Email', 'Cell Phone', 'Office Phone', 'Office Location'],
};
const ATTENDANCE = {
  machine: ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'llab_attendance_pct', 'preview_event_1', 'preview_event_2', 'preview_event_3', 'preview_event_4', 'preview_event_5', 'preview_event_6'],
  display: ['Last Name', 'First Name', 'Year', 'Flight', 'Sqdn', 'Overall', 'LLAB', 'TW-1 Mando', 'TW-1 Secondary', 'TW-1 LLAB', 'TW-2 Mando', 'TW-2 Secondary', 'TW-2 LLAB'],
};
const EXCUSALS = {
  machine: ['timestamp', 'decision', 'event', 'reason', 'requested_outcome', 'email', 'last_name', 'first_name', 'flight', 'request_id'],
  display: ['Timestamp', 'Decision', 'Event', 'Reason', 'Type', 'Email', 'Last Name', 'First Name', 'Flight', 'Request ID'],
};
const rgb = hex => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const color = hex => ({ rgbColor: rgb(hex) });
const range = (sheetId, r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
const val = x => typeof x === 'number' ? { numberValue: x } : { stringValue: String(x ?? '') };
const cell = x => ({ userEnteredValue: val(x) });
const formula = x => ({ userEnteredValue: { formulaValue: x } });

function write(sheetId, row, column, values) {
  return { updateCells: { start: { sheetId, rowIndex: row, columnIndex: column }, rows: values.map(row => ({ values: row.map(x => x?.userEnteredValue ? x : cell(x)) })), fields: 'userEnteredValue' } };
}
function format(r, f) {
  const style = f.textFormat ? { ...f, textFormat: { fontFamily: 'Roboto', ...f.textFormat } } : f;
  return { repeatCell: { range: r, cell: { userEnteredFormat: style }, fields: Object.keys(style).map(k => 'userEnteredFormat.' + k).join(',') } };
}
function width(sheetId, startIndex, endIndex, pixelSize) { return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex }, properties: { pixelSize }, fields: 'pixelSize' } }; }
function height(sheetId, startIndex, endIndex, pixelSize) { return { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex }, properties: { pixelSize }, fields: 'pixelSize' } }; }
function merge(sheetId, r0, r1, c0, c1) { return { mergeCells: { range: range(sheetId, r0, r1, c0, c1), mergeType: 'MERGE_ALL' } }; }
function coloredRules(sheetId, r0, r1, c0, c1, palette) {
  return Object.entries(palette).map(([value, [background, foreground]], index) => ({ addConditionalFormatRule: { index, rule: { ranges: [range(sheetId, r0, r1, c0, c1)], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] }, format: { backgroundColor: rgb(background), textFormat: { foregroundColor: rgb(foreground), bold: true } } } } } }));
}
function validation(r, source, showCustomUi) { return { setDataValidation: { range: r, rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: source }] }, strict: true, showCustomUi }, filteredRowsIncluded: true } }; }
function sheet(book, id, title, columns, rows, hidden = false) {
  book.sheets.push({ sheetId: id, title, visible: !hidden });
  book.requests.push({ addSheet: { properties: { sheetId: id, title, hidden, gridProperties: { rowCount: rows, columnCount: columns, hideGridlines: true } } } });
  book.requests.push(format(range(id, 0, rows, 0, columns), { textFormat: { fontFamily: 'Roboto', fontSize: 10, foregroundColor: rgb(COLORS.text) }, verticalAlignment: 'MIDDLE', backgroundColor: rgb('#FFFFFF') }));
}
function table(book, id, title, schema, data, widths) {
  const end = data.length + 2, columns = schema.machine.length;
  sheet(book, id, title, columns, Math.max(32, end + 5));
  book.requests.push(write(id, 0, 0, [schema.machine, schema.display, ...data]));
  book.requests.push({ updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } });
  book.requests.push({ updateDimensionProperties: { range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  book.requests.push(format(range(id, 1, 2, 0, columns), { backgroundColor: rgb(COLORS.header), textFormat: { fontFamily: 'Roboto', fontSize: 10, foregroundColor: rgb('#FFFFFF'), bold: true }, wrapStrategy: 'WRAP' }));
  book.requests.push(format(range(id, 2, 32, 0, columns), { wrapStrategy: 'CLIP' }), height(id, 1, 2, 42), height(id, 2, 32, 29));
  widths.forEach((w, i) => book.requests.push(width(id, i, i + 1, w)));
  book.tables.push({ sheetId: id, name: title === 'Blue' || title === 'Gold' ? `${title} Excusals` : title, range: range(id, 1, end, 0, columns), columnProperties: schema.display.map((columnName, columnIndex) => ({ columnName, columnIndex, columnType: 'COLUMN_TYPE_UNSPECIFIED' })), rowsProperties: { headerColorStyle: color(COLORS.header), firstBandColorStyle: color('#FFFFFF'), secondBandColorStyle: color(COLORS.band) } });
  book.requests.push({ addProtectedRange: { protectedRange: { range: { sheetId: id }, description: 'SHAMROCK fictional presentation preview', warningOnly: false, ...(title === 'Blue' || title === 'Gold' ? { unprotectedRanges: [range(id, 2, 32, 1, 2)] } : {}) } } });
  return end;
}
function legend(book, id, title, columns) {
  const rows = Math.max(...columns.map(c => c.values.length)) + 2;
  sheet(book, id, title, columns.length, Math.max(20, rows), true);
  const data = Array.from({ length: rows }, (_, row) => columns.map(c => row === 0 ? c.key : row === 1 ? c.label : c.values[row - 2] ?? ''));
  book.requests.push(write(id, 0, 0, data));
  columns.forEach((c, index) => {
    c.values.forEach((value, row) => {
      const pair = c.colors?.[value];
      if (pair) book.requests.push(format(range(id, row + 2, row + 3, index, index + 1), { backgroundColor: rgb(pair[0]), textFormat: { bold: true, foregroundColor: rgb(pair[1]) } }));
    });
  });
  book.requests.push({ addProtectedRange: { protectedRange: { range: { sheetId: id }, description: 'SHAMROCK preview legend', warningOnly: false } } });
  return Object.fromEntries(columns.map((column, index) => {
    const letter = String.fromCharCode(65 + index), sourceA1 = `${letter}3:${letter}${column.values.length + 2}`;
    return [column.key, { legendSheetId: id, sourceA1, values: column.values, source: `='${title}'!$${letter}$3:$${letter}$${column.values.length + 2}` }];
  }));
}
function chart(sheetId, dataId, title, type, startRow, endRow, startColumn, endColumn, anchorRow, anchorColumn, axis) {
  const domain = range(dataId, startRow, endRow, startColumn, startColumn + 1);
  return { addChart: { chart: { spec: { title, fontName: 'Roboto', backgroundColor: rgb('#FFFFFF'), hiddenDimensionStrategy: 'SHOW_ALL', titleTextFormat: { fontSize: 12, bold: true, foregroundColor: rgb(COLORS.dark) }, basicChart: { chartType: type, legendPosition: 'NO_LEGEND', headerCount: 1, axis: [{ position: 'BOTTOM_AXIS', title: axis }, { position: 'LEFT_AXIS', title: type === 'BAR' ? '' : 'Count' }], domains: [{ domain: { sourceRange: { sources: [domain] } } }], series: [{ series: { sourceRange: { sources: [range(dataId, startRow, endRow, endColumn - 1, endColumn)] } }, targetAxis: 'LEFT_AXIS', colorStyle: color(COLORS.green) }] } }, position: { overlayPosition: { anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorColumn }, widthPixels: 550, heightPixels: 245 } } } } };
}

/** Pure, deterministic native-Sheets descriptors. Apply only to explicitly provisioned preview files.
 * Native table creation is intentionally a separate phase: create minimally, read assigned IDs,
 * then apply the returned columnProperties/rowsProperties, followed by postTableRequests.
 * Google can clear cell validation while configuring native Table columns, so legend-backed
 * rules must be applied last. No Apps Script or D1 is attached.
 */
export function buildFrontendPreview() {
  const main = { title: 'SHAMROCK — Fictional production preview', sheets: [], requests: [], tables: [], dropdownSeeds: [], cellPresentation: [], photoChipTargets: [] };
  const excusals = { title: 'SHAMROCK Excusals — Fictional production preview', sheets: [], requests: [], tables: [], dropdownSeeds: [], cellPresentation: [], photoChipTargets: [] };
  const ids = { dashboard: 101, leadership: 102, directory: 103, attendance: 104, legend: 105, chartData: 106, blue: 201, gold: 202, excusalLegend: 203 };
  const cadets = Array.from({ length: 16 }, (_, i) => ({ last: `Cadet ${String(i + 1).padStart(2, '0')}`, first: 'Example', year: YEARS[i % 4], flight: FLIGHTS[Math.floor(i / 4)], squadron: i < 8 ? 'Blue' : 'Gold', rank: ['C/4C', 'C/3C', 'C/2d Lt', 'C/Capt'][i % 4] }));
  const marks = cadets.map((_c, i) => ['P', 'P', i % 5 === 0 ? 'E' : 'P', i % 7 === 0 ? 'A' : 'P', i % 4 === 0 ? 'T' : 'P', i % 6 === 0 ? 'MED' : 'P']);
  const requests = [
    ['Blue', 0, '', 'TW-2 LLAB', 'Fictional academic conflict', 'E'], ['Blue', 2, 'Approved', 'TW-1 LLAB', 'Fictional scheduled appointment', 'E'],
    ['Blue', 5, 'Denied', 'TW-2 Mando', 'Fictional example request', 'E'], ['Blue', 7, 'Withdrawn', 'TW-2 Secondary', 'Fictional request withdrawn', 'E'],
    ['Gold', 8, '', 'TW-2 LLAB', 'Fictional academic conflict', 'E'], ['Gold', 10, 'Approved', 'TW-1 Secondary', 'Fictional athletics conflict', 'ES'],
    ['Gold', 12, '', 'TW-2 Mando', 'Fictional scheduled appointment', 'MED'], ['Gold', 15, 'Superseded', 'TW-1 LLAB', 'Fictional replacement request', 'E'],
  ];
  sheet(main, ids.dashboard, 'Dashboard', 12, 72);
  table(main, ids.leadership, 'Leadership', LEADERSHIP, [
    ['Leader 01', 'Example', 'C/Col', 'Wing Commander', 'Cadre', '', '', '', ''],
    ['Leader 02', 'Example', 'C/Lt Col', 'Blue Squadron Commander', 'Wing Commander', '', '', '', ''],
    ['Leader 03', 'Example', 'C/Lt Col', 'Gold Squadron Commander', 'Wing Commander', '', '', '', ''],
    ...FLIGHTS.map((f, i) => [`Leader ${String(i + 4).padStart(2, '0')}`, 'Example', 'C/Capt', `${f} Flight Commander`, `${i < 2 ? 'Blue' : 'Gold'} Squadron Commander`, '', '', '', '']),
  ], [115, 115, 95, 235, 235, 190, 125, 125, 150]);
  table(main, ids.directory, 'Directory', DIRECTORY, cadets.map((c, i) => [c.last, c.first, c.year, c.flight, c.squadron, c.rank, i % 4 === 3 ? 'Flight Commander' : 'Cadet', 'Notre Dame', '', '', 'Off-Campus', '14 - Engineering', '', '', '', '', 2030 - i % 4, '', 'Active 3/4', '']), [115, 115, 100, 120, 85, 95, 160, 110, 190, 125, 150, 155, 75, 190, 130, 110, 95, 100, 125, 150]);
  table(main, ids.attendance, 'Attendance', ATTENDANCE, cadets.map((c, i) => [c.last, c.first, c.year, c.flight, c.squadron, '', '', ...marks[i]]), [115, 115, 100, 85, 85, 95, 95, 130, 130, 130, 130, 130, 130]);
  main.requests.push(height(ids.attendance, 1, 2, 56));
  main.requests.push({ repeatCell: { range: range(ids.attendance, 2, 18, 5, 7), cell: { note: 'Presentation preview only. Percentages are intentionally blank until the approved attendance-credit policy is implemented and tested.' }, fields: 'note' } });
  main.requests.push(format(range(ids.attendance, 2, 32, 2, 13), { horizontalAlignment: 'CENTER' }), format(range(ids.attendance, 2, 32, 5, 7), { numberFormat: { type: 'PERCENT', pattern: '0.0%' } }));
  const sources = legend(main, ids.legend, 'Data Legend', [
    { key: 'as_year_options', label: 'AS Year', values: YEARS },
    { key: 'flight_options', label: 'Flight', values: FLIGHTS },
    { key: 'squadron_options', label: 'Squadron', values: ['Blue', 'Gold'] },
    { key: 'attendance_code_options', label: 'Attendance Codes', values: CODES },
    { key: 'cadet_rank_options', label: 'Cadet Rank', values: OPTIONS.CADET_RANKS },
    { key: 'rank_options', label: 'Rank', values: OPTIONS.RANKS },
    { key: 'honorific_options', label: 'Honorific', values: OPTIONS.HONORIFICS },
    { key: 'university_options', label: 'University', values: OPTIONS.UNIVERSITIES },
    { key: 'dorm_options', label: 'Dorm', values: OPTIONS.DORMS },
    { key: 'cip_broad_area_options', label: 'CIP Broad Area', values: OPTIONS.CIP_BROAD_AREAS },
    { key: 'afsc_options', label: 'AFSC', values: OPTIONS.AFSC_OPTIONS },
    { key: 'home_state_options', label: 'Home State', values: OPTIONS.HOME_STATES },
    { key: 'flight_path_status_options', label: 'Flight Path', values: OPTIONS.FLIGHT_PATH_STATUSES },
  ]);
  // showCustomUi controls the presence of a dropdown, not Chip versus Arrow rendering.
  // Preserve existing native option styling when refreshing an existing preview.
  // Creation rules alone cannot reproduce this provider-managed presentation.
  for (const [field, key, style] of [
    ['as_year', 'as_year_options', 'chip'], ['flight', 'flight_options', 'arrow'],
    ['squadron', 'squadron_options', 'arrow'], ['rank', 'cadet_rank_options', 'plain'],
    ['university', 'university_options', 'plain'], ['dorm', 'dorm_options', 'arrow'],
    ['cip_broad_area', 'cip_broad_area_options', 'plain'], ['desired_assigned_afsc', 'afsc_options', 'arrow'],
    ['home_state', 'home_state_options', 'plain'], ['flight_path_status', 'flight_path_status_options', 'arrow'],
  ]) {
    const column = DIRECTORY.machine.indexOf(field), source = sources[key];
    const target = range(ids.directory, 2, 32, column, column + 1);
    main.requests.push(validation(target, source.source, style !== 'plain'));
    const contract = { sheetId: ids.directory, field, style, range: target, ...source,
      ...(['as_year', 'flight', 'squadron'].includes(field) ? { preserveNativeValidation: true } : {}) };
    main.cellPresentation.push(contract);
    if (style === 'chip') main.dropdownSeeds.push({ ...contract, a1: 'C3:C32' });
  }
  const rankColumn = LEADERSHIP.machine.indexOf('rank');
  const leadershipRankSource = `='Data Legend'!$E$3:$G$${Math.max(OPTIONS.CADET_RANKS.length, OPTIONS.RANKS.length, OPTIONS.HONORIFICS.length) + 2}`;
  const leadershipRankTarget = range(ids.leadership, 2, 32, rankColumn, rankColumn + 1);
  main.requests.push(validation(leadershipRankTarget, leadershipRankSource, false));
  main.cellPresentation.push({ sheetId: ids.leadership, field: 'rank', style: 'plain', range: leadershipRankTarget, source: leadershipRankSource });
  main.requests.push(validation(range(ids.attendance, 2, 32, 7, 13), sources.attendance_code_options.source, false));
  main.cellPresentation.push({ sheetId: ids.attendance, fields: ATTENDANCE.machine.slice(7), style: 'plain', preserveNativeValidation: true, range: range(ids.attendance, 2, 32, 7, 13), ...sources.attendance_code_options });
  main.requests.push(format(range(ids.attendance, 2, 32, 7, 13), { numberFormat: { type: 'TEXT' }, textFormat: { fontFamily: 'Roboto', fontSize: 10, foregroundColor: rgb(COLORS.text), bold: true } }));
  // Production has ordinary white/banded cell formats. Native validation option
  // colors are opaque to the public API, including in Plain and Arrow display.
  // Preserve them with validated native-seed copying, never invented cell fills.
  for (const field of ['cip_code', 'class_year']) {
    const column = DIRECTORY.machine.indexOf(field);
    main.requests.push(format(range(ids.directory, 2, 32, column, column + 1), { numberFormat: { type: 'TEXT' } }));
  }
  const dob = DIRECTORY.machine.indexOf('dob'), photo = DIRECTORY.machine.indexOf('photo_link');
  main.requests.push(format(range(ids.directory, 2, 32, dob, dob + 1), { numberFormat: { type: 'DATE', pattern: 'M/d/yyyy' } }));
  const photoTarget = { sheetId: ids.directory, field: 'photo_link', style: 'file-chip', range: range(ids.directory, 2, 18, photo, photo + 1), assetBinding: 'fictional_portrait' };
  main.photoChipTargets.push(photoTarget);
  main.cellPresentation.push(photoTarget);
  main.requests.push({ repeatCell: { range: photoTarget.range, cell: { note: 'Fictional preview: every Photo Link uses the same shared placeholder portrait when its private asset binding is supplied. No actual cadet photograph is used.' }, fields: 'note' } });
  for (const [i, f] of FLIGHTS.entries()) main.requests.push({ addFilterView: { filter: { title: `${f} Flight`, range: range(ids.attendance, 1, 18, 0, 13), criteria: { 3: { hiddenValues: FLIGHTS.filter(x => x !== f) } } } } });
  sheet(main, ids.chartData, 'Dashboard Data', 8, 20, true);
  const presentByFlight = FLIGHTS.map((f, index) => [f, marks.slice(index * 4, index * 4 + 4).flat().filter(x => x === 'P').length]);
  const rosterByYear = YEARS.map(year => [year, cadets.filter(c => c.year === year).length]);
  const codeCounts = CODES.filter(code => marks.flat().includes(code)).map(code => [code, marks.flat().filter(x => x === code).length]);
  const pendingBySquadron = ['Blue', 'Gold'].map(s => [s, requests.filter(r => r[0] === s && !r[2]).length]);
  main.requests.push(write(ids.chartData, 0, 0, [['Flight', 'P records'], ...presentByFlight]), write(ids.chartData, 0, 2, [['AS Year', 'Cadets'], ...rosterByYear]), write(ids.chartData, 0, 4, [['Code', 'Records'], ...codeCounts]), write(ids.chartData, 0, 6, [['Squadron', 'Pending requests'], ...pendingBySquadron]));
  main.requests.push({ addProtectedRange: { protectedRange: { range: { sheetId: ids.chartData }, description: 'SHAMROCK fictional chart data', warningOnly: false } } });
  const d = ids.dashboard;
  main.requests.push(format(range(d, 0, 72, 0, 12), { backgroundColor: rgb(COLORS.canvas) }));
  const widths = [115, 115, 90, 190, 70, 18, 95, 95, 95, 120, 95, 95];
  widths.forEach((w, i) => main.requests.push(width(d, i, i + 1, w)));
  main.requests.push(height(d, 0, 1, 40), height(d, 1, 2, 28), height(d, 3, 4, 28), height(d, 4, 10, 29), height(d, 11, 38, 22));
  main.requests.push(merge(d, 0, 1, 0, 12), write(d, 0, 0, [['SHAMROCK Dashboard']]), format(range(d, 0, 1, 0, 12), { backgroundColor: rgb(COLORS.dark), textFormat: { fontSize: 20, bold: true, foregroundColor: rgb('#FFFFFF') } }));
  main.requests.push(merge(d, 1, 2, 0, 12), write(d, 1, 0, [['Fictional production preview • Sample records only • No attendance or decisions are submitted']]), format(range(d, 1, 2, 0, 12), { backgroundColor: rgb(COLORS.green), textFormat: { fontSize: 10, foregroundColor: rgb('#EAF3EF') } }));
  const section = (row, c0, c1, title) => main.requests.push(merge(d, row, row + 1, c0, c1), write(d, row, c0, [[title]]), format(range(d, row, row + 1, c0, c1), { backgroundColor: rgb('#DFE9E4'), textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(COLORS.dark) } }));
  section(3, 0, 4, 'Quick actions'); section(3, 4, 12, 'At a glance');
  [['Directory', ids.directory], ['Attendance', ids.attendance], ['Leadership contacts', ids.leadership], ['Submit attendance', null], ['Request an excusal', null], ['Update directory info', null]].forEach(([label, target], i) => {
    main.requests.push(merge(d, i + 4, i + 5, 0, 2), merge(d, i + 4, i + 5, 2, 4), write(d, i + 4, 0, [[label]]), write(d, i + 4, 2, [[target ? formula(`=HYPERLINK("#gid=${target}","Open →")`) : 'Preview only']]), format(range(d, i + 4, i + 5, 0, 4), { backgroundColor: rgb('#FFFFFF'), textFormat: { bold: true, foregroundColor: rgb(COLORS.dark) } }));
  });
  const metrics = [['Cadets', 16], ['GMC cadets', 8], ['POC cadets', 8], ['Recorded P', marks.flat().filter(x => x === 'P').length], ['Pending excusals', requests.filter(r => !r[2]).length], ['Flights', 4]];
  metrics.forEach(([label, value], index) => {
    const row = index < 3 ? 4 : 7, col = [4, 7, 10][index % 3], end = [7, 10, 12][index % 3];
    main.requests.push(merge(d, row, row + 1, col, end), merge(d, row + 1, row + 3, col, end), write(d, row, col, [[label]]), write(d, row + 1, col, [[value]]), format(range(d, row, row + 3, col, end), { backgroundColor: rgb('#FFFFFF'), horizontalAlignment: 'CENTER' }), format(range(d, row, row + 1, col, end), { textFormat: { bold: true, foregroundColor: rgb('#53635C') } }), format(range(d, row + 1, row + 3, col, end), { textFormat: { fontSize: 20, bold: true, foregroundColor: rgb(COLORS.dark) } }));
  });
  main.requests.push(chart(d, ids.chartData, 'Recorded present by flight', 'COLUMN', 0, 5, 0, 2, 11, 0, 'Flight'), chart(d, ids.chartData, 'Cadet roster by AS year', 'COLUMN', 0, 5, 2, 4, 11, 6, 'AS Year'), chart(d, ids.chartData, 'Recorded attendance codes', 'COLUMN', 0, codeCounts.length + 1, 4, 6, 24, 0, 'Attendance Code'), chart(d, ids.chartData, 'Requests awaiting decision', 'COLUMN', 0, 3, 6, 8, 24, 6, 'Squadron'));
  section(38, 0, 5, 'Using this preview'); section(38, 6, 12, 'Attendance codes');
  main.requests.push(merge(d, 39, 44, 0, 5), write(d, 39, 0, [['The four visible tabs match the normal Main workbook. Use an Attendance filter view to focus on a flight.\n\nNames and records are fictional. Overall/LLAB percentages are blank while attendance-credit policy is finalized. Form actions are inactive in this preview.']]), format(range(d, 39, 44, 0, 5), { backgroundColor: rgb('#FFFFFF'), wrapStrategy: 'WRAP', verticalAlignment: 'TOP' }));
  [['P', 'Present'], ['T', 'Tardy'], ['A', 'Absent — follow-up required'], ['R', 'Excusal request pending'], ['D', 'Request denied before event; attendance required'], ['U', 'Unexcused absence'], ['E', 'Excused'], ['ES', 'Excused — sport'], ['MED', 'Medical'], ['N/A', 'Not expected / not applicable']].forEach(([code, label], i) => main.requests.push(merge(d, 39 + i, 40 + i, 6, 8), merge(d, 39 + i, 40 + i, 8, 12), write(d, 39 + i, 6, [[code]]), write(d, 39 + i, 8, [[label]])));
  main.requests.push({ addProtectedRange: { protectedRange: { range: { sheetId: d }, description: 'SHAMROCK fictional Dashboard', warningOnly: false } } });
  legend(excusals, ids.excusalLegend, '_Excusals Data Legend', [{ key: 'excusal_decision_options', label: 'Excusal Decision Options', values: DECISIONS, colors: DECISION_COLORS }]);
  for (const [squadron, id] of [['Blue', ids.blue], ['Gold', ids.gold]]) {
    const data = requests.filter(r => r[0] === squadron).map((r, index) => { const c = cadets[r[1]], date = (Date.UTC(2027, 0, 12 + index, 8, 30) - Date.UTC(1899, 11, 30)) / 86400000; return [date, r[2], r[3], r[4], r[5], '', c.last, c.first, c.flight, `preview-${squadron.toLowerCase()}-${index + 1}`]; });
    table(excusals, id, squadron, EXCUSALS, data, [135, 135, 160, 265, 80, 180, 115, 115, 85, 150]);
    excusals.requests.push({ updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } }, format(range(id, 2, 32, 0, 1), { numberFormat: { type: 'DATE_TIME', pattern: 'm/d/yy h:mm' } }), format(range(id, 2, 32, 3, 4), { wrapStrategy: 'WRAP' }), validation(range(id, 2, 32, 1, 2), "='_Excusals Data Legend'!$A$3:$A$6", true), ...coloredRules(id, 2, 32, 1, 2, DECISION_COLORS));
    excusals.requests.push({ addFilterView: { filter: { title: 'Awaiting decision', range: range(id, 1, 6, 0, 10), criteria: { 1: { hiddenValues: DECISIONS } } } } });
    excusals.cellPresentation.push({ sheetId: id, field: 'decision', style: 'arrow', preserveNativeValidation: true, range: range(id, 2, 32, 1, 2), legendSheetId: ids.excusalLegend, sourceA1: 'A3:A6', source: "='_Excusals Data Legend'!$A$3:$A$6", values: DECISIONS, colors: DECISION_COLORS });
  }
  excusals.sheets.sort((a, b) => a.sheetId - b.sheetId);
  for (const book of [main, excusals]) {
    book.postTableRequests = book.requests.filter(request => request.setDataValidation);
    book.requests = book.requests.filter(request => !request.setDataValidation);
  }
  return { main, excusals };
}
