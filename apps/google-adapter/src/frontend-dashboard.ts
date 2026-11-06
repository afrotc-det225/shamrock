/** Native Dashboard presentation. Environment warnings belong in operator tooling,
 * not the cadet-facing canvas. This planner performs no IO and invents no links. */
export interface DashboardAction { label: string; url: string }
export interface DashboardMetric { label: string; value: number; format?: 'count' | 'percent' }
export interface DashboardChart {
  title: string; axis: string; sourceColumn: number; sourceEndRow: number;
}
export interface DashboardInput {
  sheetId: number; dataSheetId: number;
  actions: DashboardAction[]; metrics: DashboardMetric[]; charts: DashboardChart[];
}
type Request = Record<string, unknown>;
const C = { dark: '#173E32', green: '#2B6E55', text: '#434343', canvas: '#F7F9F8' };
const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const r = (sheetId: number, startRowIndex: number, endRowIndex: number, startColumnIndex: number, endColumnIndex: number) =>
  ({ sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
const text = (value: string, limit = 512): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f]/.test(value)) throw Error('Invalid Dashboard label.');
  return value;
};
function link(value: string): string {
  if (typeof value !== 'string' || !/^(?:#gid=\d+|https:\/\/(?:docs\.google\.com|drive\.google\.com)\/[^\s"<>]+)$/.test(value)) {
    throw Error('Dashboard actions require a resolved Google resource or a sheet link.');
  }
  return value;
}

/** Render into an empty/unmerged Dashboard canvas. Updating an existing canvas
 * requires the caller to remove only its known Dashboard merges/charts first.
 * Never touches native Tables, validation or business-input cells. */
export function buildFrontendDashboard(input: DashboardInput): Request[] {
  if (![input.sheetId, input.dataSheetId].every(x => Number.isSafeInteger(x) && x >= 0)
    || input.sheetId === input.dataSheetId || input.actions.length > 6 || input.metrics.length !== 6
    || input.charts.length !== 4) throw Error('Invalid Dashboard presentation shape.');
  input.actions.forEach(a => { text(a.label, 80); link(a.url); });
  input.metrics.forEach(m => {
    text(m.label, 80);
    if (!Number.isFinite(m.value) || m.value < 0 || (m.format === 'percent' && m.value > 1)) throw Error('Invalid Dashboard metric.');
  });
  input.charts.forEach(c => {
    text(c.title); text(c.axis);
    if (!Number.isSafeInteger(c.sourceColumn) || c.sourceColumn < 0 || c.sourceColumn > 24
      || !Number.isSafeInteger(c.sourceEndRow) || c.sourceEndRow < 2 || c.sourceEndRow > 1002) throw Error('Invalid Dashboard chart source.');
  });
  const { sheetId: d, dataSheetId: source } = input, requests: Request[] = [];
  const format = (range: ReturnType<typeof r>, style: Record<string, unknown>) => {
    const userEnteredFormat = { ...style };
    if (style.textFormat) userEnteredFormat.textFormat = { fontFamily: 'Roboto', ...(style.textFormat as object) };
    requests.push({ repeatCell: { range, cell: { userEnteredFormat }, fields: Object.keys(style).map(k => 'userEnteredFormat.' + k).join(',') } });
  };
  const merge = (row: number, end: number, col: number, right: number) => requests.push({ mergeCells: { range: r(d, row, end, col, right), mergeType: 'MERGE_ALL' } });
  const write = (row: number, col: number, value: string | number, isFormula = false) => requests.push({ updateCells: {
    start: { sheetId: d, rowIndex: row, columnIndex: col },
    rows: [{ values: [{ userEnteredValue: typeof value === 'number' ? { numberValue: value } : isFormula ? { formulaValue: value } : { stringValue: value } }] }], fields: 'userEnteredValue' } });
  const height = (startIndex: number, endIndex: number, pixelSize: number) => requests.push({ updateDimensionProperties: {
    range: { sheetId: d, dimension: 'ROWS', startIndex, endIndex }, properties: { pixelSize }, fields: 'pixelSize' } });
  format(r(d, 0, 70, 0, 12), { backgroundColor: rgb(C.canvas), verticalAlignment: 'MIDDLE',
    textFormat: { fontSize: 10, foregroundColor: rgb(C.text) } });
  [115, 115, 90, 190, 70, 18, 95, 95, 95, 120, 95, 95].forEach((pixelSize, startIndex) => requests.push({ updateDimensionProperties: {
    range: { sheetId: d, dimension: 'COLUMNS', startIndex, endIndex: startIndex + 1 }, properties: { pixelSize }, fields: 'pixelSize' } }));
  height(0, 1, 40); height(1, 2, 28); height(2, 8, 29); height(9, 48, 22);
  merge(0, 1, 0, 12); write(0, 0, 'SHAMROCK Dashboard');
  format(r(d, 0, 1, 0, 12), { backgroundColor: rgb(C.dark), textFormat: { fontSize: 20, bold: true, foregroundColor: rgb('#FFFFFF') } });
  const section = (row: number, col: number, right: number, title: string) => {
    merge(row, row + 1, col, right); write(row, col, title);
    format(r(d, row, row + 1, col, right), { backgroundColor: rgb('#DFE9E4'), textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(C.dark) } });
  };
  section(1, 0, 4, 'Quick actions'); section(1, 4, 12, 'At a glance');
  input.actions.forEach((action, i) => {
    merge(i + 2, i + 3, 0, 2); merge(i + 2, i + 3, 2, 4);
    write(i + 2, 0, action.label); write(i + 2, 2, `=HYPERLINK("${action.url}","Open →")`, true);
    format(r(d, i + 2, i + 3, 0, 4), { backgroundColor: rgb('#FFFFFF'), textFormat: { bold: true, foregroundColor: rgb(C.dark) } });
  });
  input.metrics.forEach((metric, i) => {
    const row = i < 3 ? 2 : 5, col = [4, 7, 10][i % 3], right = [7, 10, 12][i % 3];
    merge(row, row + 1, col, right); merge(row + 1, row + 3, col, right);
    write(row, col, metric.label); write(row + 1, col, metric.value);
    format(r(d, row, row + 3, col, right), { backgroundColor: rgb('#FFFFFF'), horizontalAlignment: 'CENTER' });
    format(r(d, row, row + 1, col, right), { textFormat: { bold: true, foregroundColor: rgb('#53635C') } });
    format(r(d, row + 1, row + 3, col, right), { textFormat: { fontSize: 20, bold: true, foregroundColor: rgb(C.dark) },
      numberFormat: metric.format === 'percent' ? { type: 'PERCENT', pattern: '0.0%' } : { type: 'NUMBER', pattern: '0' } });
  });
  input.charts.forEach((chart, i) => requests.push({ addChart: { chart: {
    spec: { title: chart.title, fontName: 'Roboto', backgroundColor: rgb('#FFFFFF'), hiddenDimensionStrategy: 'SHOW_ALL',
      titleTextFormat: { fontSize: 12, bold: true, foregroundColor: rgb(C.dark) }, basicChart: { chartType: 'COLUMN', legendPosition: 'NO_LEGEND', headerCount: 1,
        axis: [{ position: 'BOTTOM_AXIS', title: chart.axis }, { position: 'LEFT_AXIS', title: 'Count', viewWindowOptions: { viewWindowMin: 0 } }],
        domains: [{ domain: { sourceRange: { sources: [r(source, 0, chart.sourceEndRow, chart.sourceColumn, chart.sourceColumn + 1)] } } }],
        series: [{ series: { sourceRange: { sources: [r(source, 0, chart.sourceEndRow, chart.sourceColumn + 1, chart.sourceColumn + 2)] } }, targetAxis: 'LEFT_AXIS', colorStyle: { rgbColor: rgb(C.green) } }] } },
    position: { overlayPosition: { anchorCell: { sheetId: d, rowIndex: i < 2 ? 9 : 22, columnIndex: i % 2 ? 6 : 0 }, widthPixels: 550, heightPixels: 245 } },
  } } }));
  section(36, 0, 5, 'Using SHAMROCK'); section(36, 6, 12, 'Attendance codes');
  merge(37, 42, 0, 5);
  write(37, 0, 'Use an Attendance filter view to focus on your flight or squadron. Submit attendance through the attendance Form. Squadron commanders review excusal requests in their squadron’s sheet.');
  format(r(d, 37, 42, 0, 5), { backgroundColor: rgb('#FFFFFF'), wrapStrategy: 'WRAP', verticalAlignment: 'TOP' });
  const codes = [['P', 'Present'], ['T', 'Tardy'], ['A', 'Absent — follow-up required'], ['R', 'Excusal request pending'],
    ['D', 'Request denied; attendance required'], ['U', 'Unexcused absence'], ['E', 'Excused'], ['ES', 'Excused — sport'],
    ['MED', 'Medical'], ['N/A', 'Not expected / not applicable']];
  codes.forEach(([code, label], i) => {
    merge(37 + i, 38 + i, 6, 8); merge(37 + i, 38 + i, 8, 12);
    write(37 + i, 6, code); write(37 + i, 8, label);
  });
  return requests;
}
