/** Native Dashboard presentation. Environment warnings belong in operator tooling,
 * not the cadet-facing canvas. This planner performs no IO and invents no links. */
export interface DashboardAction { label: string; url: string }
export interface DashboardMetric { label: string; value: number; format?: 'count' | 'percent' }
export interface DashboardChart {
  title: string; axis: string; sourceColumn: number; sourceEndRow: number;
  kind?: 'COLUMN' | 'LINE' | 'BAR';
  percentage?: boolean;
  minimum?: number;
}
/** Official plain shamrock artwork, without the ND monogram. */
export const SHAMROCK_MARK_URL = 'https://onmessage.nd.edu/assets/189127/300x/shamrock_1.jpg';
export const SHAMROCK_MARK_FORMULA = `=IMAGE("${SHAMROCK_MARK_URL}",4,36,36)`;
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
    if (c.kind !== undefined && !['COLUMN', 'LINE', 'BAR'].includes(c.kind)
      || c.minimum !== undefined && (!c.percentage || !Number.isFinite(c.minimum) || c.minimum < 0 || c.minimum >= 1)) throw Error('Invalid Dashboard chart scale.');
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
  // Match the production canvas: wide enough for horizontal AS-year labels,
  // term comparisons and readable metric cards at the normal Sheets zoom.
  [115, 115, 90, 190, 70, 18, 95, 95, 95, 120, 95, 95].forEach((pixelSize, startIndex) => requests.push({ updateDimensionProperties: {
    range: { sheetId: d, dimension: 'COLUMNS', startIndex, endIndex: startIndex + 1 }, properties: { pixelSize }, fields: 'pixelSize' } }));
  height(0, 1, 44); height(1, 2, 26); height(2, 8, 28); height(8, 9, 10); height(9, 48, 22);
  merge(0, 1, 0, 11); write(0, 0, 'SHAMROCK Dashboard');
  format(r(d, 0, 1, 0, 12), { backgroundColor: rgb(C.dark), textFormat: { fontSize: 20, bold: true, foregroundColor: rgb('#FFFFFF') } });
  write(0, 11, SHAMROCK_MARK_FORMULA, true);
  format(r(d, 0, 1, 11, 12), { backgroundColor: rgb('#FFFFFF'), horizontalAlignment: 'CENTER' });
  const border = (range: ReturnType<typeof r>) => requests.push({ updateBorders: { range,
    ...Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, { style: 'SOLID', colorStyle: { rgbColor: rgb('#D5DEDA') } }])) } });
  const section = (row: number, col: number, right: number, title: string) => {
    merge(row, row + 1, col, right); write(row, col, title);
    format(r(d, row, row + 1, col, right), { backgroundColor: rgb('#DFE9E4'), textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(C.dark) } });
  };
  section(1, 0, 4, 'Quick actions'); section(1, 4, 12, 'At a glance');
  input.actions.forEach((action, i) => {
    merge(i + 2, i + 3, 0, 2); merge(i + 2, i + 3, 2, 4);
    write(i + 2, 0, action.label); write(i + 2, 2, `=HYPERLINK("${action.url}","Open →")`, true);
    format(r(d, i + 2, i + 3, 0, 4), { backgroundColor: rgb('#FFFFFF'), textFormat: { bold: true, foregroundColor: rgb(C.dark) } });
    format(r(d, i + 2, i + 3, 2, 4), { backgroundColor: rgb('#EDF3F0'), horizontalAlignment: 'CENTER' });
    border(r(d, i + 2, i + 3, 0, 4));
  });
  input.metrics.forEach((metric, i) => {
    const row = i < 3 ? 2 : 5, col = [4, 7, 10][i % 3], right = [7, 10, 12][i % 3];
    merge(row, row + 1, col, right); merge(row + 1, row + 3, col, right);
    write(row, col, metric.label); write(row + 1, col, metric.value);
    format(r(d, row, row + 3, col, right), { backgroundColor: rgb('#FFFFFF'), horizontalAlignment: 'CENTER' });
    format(r(d, row, row + 1, col, right), { textFormat: { bold: true, foregroundColor: rgb('#53635C') } });
    format(r(d, row + 1, row + 3, col, right), { textFormat: { fontSize: 20, bold: true, foregroundColor: rgb(C.dark) },
      numberFormat: metric.format === 'percent' ? { type: 'PERCENT', pattern: '0.0%' } : { type: 'NUMBER', pattern: '0' } });
    border(r(d, row, row + 3, col, right));
  });
  input.charts.forEach((chart, i) => requests.push({ addChart: { chart: {
    spec: { title: chart.title, fontName: 'Roboto', backgroundColor: rgb('#FFFFFF'), hiddenDimensionStrategy: 'SHOW_ALL',
      titleTextFormat: { fontSize: 12, bold: true, foregroundColor: rgb(C.dark) }, basicChart: { chartType: chart.kind ?? 'COLUMN', legendPosition: 'NO_LEGEND', headerCount: 1,
        axis: [{ position: chart.kind === 'BAR' ? 'LEFT_AXIS' : 'BOTTOM_AXIS', title: '' },
          { position: chart.kind === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS', title: '', viewWindowOptions: {
            viewWindowMin: chart.percentage ? chart.minimum ?? 0 : 0,
            ...(chart.percentage ? { viewWindowMax: 1, viewWindowMode: 'EXPLICIT' } : {}) } }],
        domains: [{ domain: { sourceRange: { sources: [r(source, 0, chart.sourceEndRow, chart.sourceColumn, chart.sourceColumn + 1)] } } }],
        series: [{ series: { sourceRange: { sources: [r(source, 0, chart.sourceEndRow, chart.sourceColumn + 1, chart.sourceColumn + 2)] } }, targetAxis: chart.kind === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
          ...(chart.kind === 'LINE' ? { lineStyle: { width: 3 }, pointStyle: { shape: 'CIRCLE', size: 6 } } : {}), colorStyle: { rgbColor: rgb(C.green) } }] } },
    position: { overlayPosition: { anchorCell: { sheetId: d, rowIndex: i < 2 ? 9 : 22, columnIndex: i % 2 ? 6 : 0 }, widthPixels: 560, heightPixels: 280 } },
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

/** Explicit paused presentation repair. Keep the four existing chart IDs and
 * all managed values; the normal publication planner refreshes their contents.
 * Caller must verify the workbook fence and re-read the exact source first. */
export function buildDashboardLayoutRepair(input: DashboardInput, current: {
  merges: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }[];
  chartIds: readonly number[];
}): Request[] {
  if (current.chartIds.length !== 4 || new Set(current.chartIds).size !== 4
    || current.chartIds.some(id => !Number.isSafeInteger(id) || id < 0)) throw Error('Invalid Dashboard chart identities.');
  const managed = current.merges.filter(m => m.startRowIndex < 47);
  if (managed.some(m => m.sheetId !== input.sheetId || m.endRowIndex > 47 || m.startColumnIndex < 0 || m.endColumnIndex > 12)) throw Error('A merge crosses the Dashboard layout boundary.');
  const layout = buildFrontendDashboard(input) as Record<string, any>[];
  let chart = 0;
  return [
    ...managed.map(range => ({ unmergeCells: { range } })),
    ...layout.flatMap(request => request.addChart ? [{ updateEmbeddedObjectPosition: {
      objectId: current.chartIds[chart++], newPosition: request.addChart.chart.position,
      fields: 'anchorCell,widthPixels,heightPixels',
    } }] : request.updateCells ? [] : [request]),
  ];
}
