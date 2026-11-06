/** Pure Dashboard and squadron Excusals publication. No provider IO or cross-book transaction claims. */
import type { FrontendSnapshot, SnapshotRevision } from '../../../packages/domain/src/admin.js';
import type { buildFrontendReporting } from '../../../packages/domain/src/frontend-reporting.js';
import { EXCUSAL_DECISIONS, REQUESTED_OUTCOMES } from '../../../packages/domain/src/index.js';
import { AdapterError } from './index.js';
import { buildFrontendDashboard, type DashboardAction } from './frontend-dashboard.js';
import { frontendLiteralCell, planFrontendPublication, type FrontendPublicationInput, type FrontendPublicationTable,
  type FrontendValue, type NativeCellData } from './frontend-publication.js';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function fail(message: string): never { throw new AdapterError('frontend_supplemental', message); }
const integer = (x: unknown, min = 0, max = 2147483647) => typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
type Range = { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
const range = (sheetId: number, top: number, bottom: number, left: number, right: number): Range => ({ sheetId, startRowIndex: top, endRowIndex: bottom, startColumnIndex: left, endColumnIndex: right });

function canonicalTimestamp(iso: string, timeZone: string): Date {
  if (typeof timeZone !== 'string' || !timeZone.trim()) fail('An explicit detachment time zone is required.');
  if (typeof iso !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(iso)) fail('A canonical submission timestamp is required.');
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) fail('Invalid submission timestamp.');
  return date;
}
/** Sheets serial in the configured detachment time zone, not the host process's time zone. */
export function frontendTimestampSerial(iso: string, timeZone: string): number {
  const date = canonicalTimestamp(iso, timeZone);
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date); }
  catch { return fail('An explicit supported detachment time zone is required.'); }
  const field = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return (Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second')) - Date.UTC(1899, 11, 30)) / 86400000;
}

const EXCUSALS = [
  ['timestamp', 'Timestamp'], ['decision', 'Decision'], ['event', 'Event'], ['reason', 'Reason'], ['requested_outcome', 'Type'],
  ['email', 'Email'], ['last_name', 'Last Name'], ['first_name', 'First Name'], ['flight', 'Flight'], ['request_id', 'Request ID'],
] as const;
export interface ExcusalPublicationTable extends FrontendPublicationTable { kind: 'excusal'; squadronId: string; title: 'Blue' | 'Gold' }

/** Current-term queues only. The recorded request flight chooses its squadron, not today's cadet flight. */
export function buildExcusalPublicationTables(input: {
  snapshot: FrontendSnapshot;
  blueSquadronId: string;
  goldSquadronId: string;
  timeZone: string;
  /** Native Apps Script hosts supply Utilities.formatDate rather than relying on Intl. */
  timestampSerial?: (iso: string, timeZone: string) => number;
}): ExcusalPublicationTable[] {
  const { snapshot } = input, current = snapshot.terms.filter(t => t.isCurrent);
  if (current.length !== 1 || input.blueSquadronId === input.goldSquadronId) fail('Excusal publication needs one current term and two distinct squadron bindings.');
  const squadrons = new Map(snapshot.squadrons.map(s => [s.squadronId, s]));
  if (squadrons.get(input.blueSquadronId)?.label !== 'Blue' || squadrons.get(input.goldSquadronId)?.label !== 'Gold') fail('Blue and Gold bindings must match the explicit squadron catalog.');
  const people = new Map(snapshot.people.map(p => [p.personId, p])), events = new Map(snapshot.events.map(e => [e.eventId, e])), flights = new Map(snapshot.flights.map(f => [f.flightId, f]));
  const tables: ExcusalPublicationTable[] = (['Blue', 'Gold'] as const).map(title => ({ kind: 'excusal', title, squadronId: title === 'Blue' ? input.blueSquadronId : input.goldSquadronId,
    keyHeader: 'request_id', columns: EXCUSALS.map(([header, label]) => ({ header, label, editable: header === 'decision', ...(header === 'decision' ? { seedKey: 'excusal:decision' } : {}) })), rows: [] }));
  const seen = new Set<string>();
  for (const request of [...snapshot.requests].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.requestId.localeCompare(b.requestId))) {
    if (seen.has(request.requestId)) fail('Duplicate excusal request identity.'); seen.add(request.requestId);
    const event = events.get(request.eventId), person = people.get(request.personId), flight = flights.get(request.flightId);
    if (!event || !person || !flight?.squadronId) fail('An excusal target or its recorded squadron is unavailable.');
    if (event.termId !== current[0].termId) continue;
    const table = tables.find(t => t.squadronId === flight.squadronId);
    if (!table) fail('A current request is outside the configured Blue/Gold queues.');
    if (!integer(request.version, 1) || !['Submitted', ...EXCUSAL_DECISIONS].includes(request.status) || !(REQUESTED_OUTCOMES as readonly string[]).includes(request.requestedOutcome) || typeof request.reason !== 'string' || request.reason.length > 4000) fail('Invalid recorded excusal state.');
    canonicalTimestamp(request.submittedAt, input.timeZone);
    const timestamp = (input.timestampSerial ?? frontendTimestampSerial)(request.submittedAt, input.timeZone);
    if (!Number.isFinite(timestamp)) fail('Submission timestamp conversion failed.');
    table.rows.push({ key: request.requestId, values: {
      timestamp, decision: request.status === 'Submitted' ? null : request.status,
      event: event.columnLabel || event.label, reason: request.reason, requested_outcome: request.requestedOutcome,
      email: person.email, last_name: person.lastName, first_name: person.firstName, flight: flight.label, request_id: request.requestId,
    }, versions: { decision: request.version }, commandBindings: { decision: { operation: 'excusal.decide', entityId: request.requestId, field: 'decision', expectedVersion: request.version } } });
    if (table.rows.length > 500) fail('A squadron queue exceeds the reviewed 500-request capacity.');
  }
  return tables;
}

/** Same keyed preservation/version/seed/read-back contract as the Main tables. */
export function planExcusalPublication(input: FrontendPublicationInput & { table: ExcusalPublicationTable }) {
  if (input.table.keyHeader !== 'request_id' || input.table.columns.filter(c => c.editable).some(c => c.header !== 'decision')) fail('Only the bound excusal decision may be edited.');
  for (const draft of input.drafts) if (draft.header !== 'decision' || !(EXCUSAL_DECISIONS as readonly unknown[]).includes(draft.value)) fail('A frozen decision draft must contain an explicit supported decision.');
  return planFrontendPublication(input);
}

export interface DashboardPublicationRead {
  sheetId: number;
  dataSheetId: number;
  canvas: NativeCellData[][];
  data: NativeCellData[][];
  canvasGrid: { rowCount: number; columnCount: number };
  dataGrid: { rowCount: number; columnCount: number };
  dataHidden: boolean;
  merges: Range[];
  charts: { chartId: number; spec: Record<string, any>; [key: string]: unknown }[];
}
export interface DashboardPublicationPlan {
  revision: SnapshotRevision;
  requests: Record<string, any>[];
  expectedRead: string;
  expectedAfter: DashboardPublicationRead;
  reportingNeedsReview: boolean;
  birthdayCount: number;
  noCountedAttendanceCadets: number;
}
/** Exact private precondition material; not a cryptographic digest or an authorization token. */
export function dashboardReadFingerprint(current: DashboardPublicationRead): string { return canonical(current); }

const entered = (cell: NativeCellData | undefined) => cell?.userEnteredValue ?? {};
const intersects = (a: Range, b: Range) => a.sheetId === b.sheetId && a.startRowIndex < b.endRowIndex && a.endRowIndex > b.startRowIndex && a.startColumnIndex < b.endColumnIndex && a.endColumnIndex > b.startColumnIndex;

/** Refresh an approved existing Dashboard canvas; retain native chart IDs, positions and layout. */
export function planDashboardPublication(input: {
  revision: SnapshotRevision;
  previousRevision: SnapshotRevision;
  reporting: { revision: SnapshotRevision; result: ReturnType<typeof buildFrontendReporting> };
  current: DashboardPublicationRead;
  /** Logical order: AS-year comparison, term trend, current flights, roster by AS year. */
  chartIds: readonly number[];
  actions: DashboardAction[];
  editFenceVerified: boolean;
}): DashboardPublicationPlan {
  const { current } = input, report = input.reporting.result, dashboard = report.dashboard;
  if (!input.editFenceVerified || !same(input.revision, input.reporting.revision) || !integer(input.revision.operations) || !integer(input.revision.administration) || input.revision.operations < input.previousRevision.operations || input.revision.administration < input.previousRevision.administration || report.scope.kind !== 'wing') fail('Dashboard needs a coherent wing snapshot and verified edit fence.');
  if (!integer(current.sheetId) || !integer(current.dataSheetId) || current.sheetId === current.dataSheetId || input.chartIds.length !== 4 || new Set(input.chartIds).size !== 4 || current.charts.length !== 4 || input.chartIds.some(id => !integer(id) || current.charts.filter(c => c.chartId === id).length !== 1)) fail('Dashboard chart identity is missing or ambiguous.');
  if (!current.canvas.length || current.canvas.length > 602 || current.canvas.some(r => r.length !== 12) || !current.data.length || current.data.length > 1002 || current.data.some(r => r.length !== 16) || dashboard.birthdays.length > 500) fail('Dashboard managed read is outside its bounds.');
  const sources: FrontendValue[][] = [], setSource = (row: number, column: number, v: FrontendValue) => { sources[row] ??= Array.from({ length: 16 }, () => null); sources[row][column] = v; };
  const comparisons = dashboard.attendanceByYear[0]?.terms ?? [];
  ['AS Year', ...comparisons.map(t => t.label)].forEach((v, c) => setSource(0, c, v));
  dashboard.attendanceByYear.forEach((year, r) => { setSource(r + 1, 0, year.asYear); year.terms.forEach((t, i) => setSource(r + 1, i + 1, t.percentage)); });
  ['Term', 'Overall Attendance'].forEach((v, c) => setSource(0, c + 5, v));
  dashboard.termTrend.forEach((t, r) => { setSource(r + 1, 5, t.label); setSource(r + 1, 6, t.percentage); });
  ['Flight', 'Overall Attendance'].forEach((v, c) => setSource(0, c + 8, v));
  dashboard.attendanceByFlight.forEach((f, r) => { setSource(r + 1, 8, f.flight); setSource(r + 1, 9, f.percentage); });
  ['AS Year', 'Cadets'].forEach((v, c) => setSource(0, c + 11, v));
  dashboard.rosterByYear.forEach((year, r) => { setSource(r + 1, 11, year.asYear); setSource(r + 1, 12, year.cadets); });
  const definitions = [
    { title: 'Attendance by AS year', axis: 'AS Year', sourceColumn: 0, sourceEndRow: Math.max(2, dashboard.attendanceByYear.length + 1) },
    { title: 'Attendance by term', axis: 'Term', sourceColumn: 5, sourceEndRow: Math.max(2, dashboard.termTrend.length + 1) },
    { title: 'Current attendance by flight', axis: 'Flight', sourceColumn: 8, sourceEndRow: Math.max(2, dashboard.attendanceByFlight.length + 1) },
    { title: 'Cadet roster by AS year', axis: 'AS Year', sourceColumn: 11, sourceEndRow: Math.max(2, dashboard.rosterByYear.length + 1) },
  ];
  const metricValues = [dashboard.totalCadets, dashboard.gmcCadets, dashboard.pocCadets, dashboard.averageOverall, dashboard.averageLlab, dashboard.belowEighty];
  const metrics = ['Total cadets', 'GMC cadets', 'POC cadets', 'Average overall', 'Average LLAB', 'Below 80%'].map((label, i) => ({ label, value: metricValues[i] ?? 0, format: (i === 3 || i === 4 ? 'percent' : 'count') as 'percent' | 'count' }));
  const layout = buildFrontendDashboard({ sheetId: current.sheetId, dataSheetId: current.dataSheetId, actions: input.actions, metrics, charts: definitions }) as Record<string, any>[];
  const requiredMerges = layout.filter(r => r.mergeCells).map(r => r.mergeCells.range as Range);
  if (requiredMerges.some(r => !current.merges.some(m => same(m, r)))) fail('Dashboard canvas must first be initialized with its approved native layout.');
  const expected = copy(current), requests: Record<string, any>[] = [];
  while (expected.canvas.length < Math.max(53, 51 + dashboard.birthdays.length)) expected.canvas.push(Array.from({ length: 12 }, () => ({})));
  while (expected.data.length < Math.max(2, sources.length)) expected.data.push(Array.from({ length: 16 }, () => ({})));
  const put = (row: number, column: number, cell: NativeCellData) => { expected.canvas[row][column] = { ...expected.canvas[row][column], userEnteredValue: cell.userEnteredValue }; };
  // Reuse the approved native planner's labels/anchors; only its value writes are applied here.
  for (const r of layout) if (r.updateCells) put(r.updateCells.start.rowIndex, r.updateCells.start.columnIndex, r.updateCells.rows[0].values[0]);
  metricValues.forEach((v, i) => put((i < 3 ? 2 : 5) + 1, [4, 7, 10][i % 3], frontendLiteralCell(v)));
  for (let i = input.actions.length; i < 6; i++) { put(i + 2, 0, {}); put(i + 2, 2, {}); }
  // Known owned footer/birthday area, below the unchanged compact four-chart layout.
  for (let r = 47; r < expected.canvas.length; r++) for (let c = 0; c < 12; c++) put(r, c, {});
  put(47, 0, frontendLiteralCell(dashboard.noCountedAttendanceCadets ? `${dashboard.noCountedAttendanceCadets} cadet(s) have no counted attendance yet.` : ''));
  put(48, 0, frontendLiteralCell(report.needsReview ? 'Some attendance records need review.' : ''));
  put(49, 0, frontendLiteralCell('Birthday calendar'));
  ['Last Name', 'First Name', 'Birthday', 'Display', 'Group'].forEach((v, c) => put(50, c, frontendLiteralCell(v)));
  dashboard.birthdays.forEach((b, r) => [b.lastName, b.firstName, (Date.parse(`${b.birthdayThisYear}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000, b.display, b.group].forEach((v, c) => put(r + 51, c, frontendLiteralCell(v))));
  if (!dashboard.birthdays.length) put(51, 0, frontendLiteralCell('No birthdays recorded.'));
  const footer = range(current.sheetId, 47, expected.canvas.length, 0, 12);
  const oldFooterMerges = current.merges.filter(m => intersects(m, footer));
  if (oldFooterMerges.some(m => m.startRowIndex < 47 || m.endRowIndex > expected.canvas.length)) fail('A merge crosses the owned Dashboard footer boundary.');
  for (const m of oldFooterMerges) requests.push({ unmergeCells: { range: m } });
  const footerMerges = [47, 48, 49].map(r => range(current.sheetId, r, r + 1, 0, 12));
  if (!dashboard.birthdays.length) footerMerges.push(range(current.sheetId, 51, 52, 0, 5));
  footerMerges.forEach(r => requests.push({ mergeCells: { range: r, mergeType: 'MERGE_ALL' } }));
  expected.merges = [...current.merges.filter(m => !intersects(m, footer)), ...footerMerges];
  for (const [kind, sheetId, width] of [['canvas', current.sheetId, 12], ['data', current.dataSheetId, 16]] as const) {
    const gridKey = kind === 'canvas' ? 'canvasGrid' : 'dataGrid';
    if (expected[kind].length > current[gridKey].rowCount || width > current[gridKey].columnCount) {
      expected[gridKey] = { rowCount: Math.max(expected[kind].length, current[gridKey].rowCount), columnCount: Math.max(width, current[gridKey].columnCount) };
      requests.unshift({ updateSheetProperties: { properties: { sheetId, gridProperties: expected[gridKey] }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
    }
  }
  for (let r = 0; r < expected.data.length; r++) for (let c = 0; c < 16; c++) expected.data[r][c] = { ...expected.data[r][c], userEnteredValue: frontendLiteralCell(sources[r]?.[c] ?? null).userEnteredValue };
  const writeChanged = (sheetId: number, before: NativeCellData[][], after: NativeCellData[][]) => {
    const spans: { r: number; c: number; cells: NativeCellData[] }[] = [];
    for (let r = 0; r < after.length; r++) for (let c = 0; c < after[r].length; c++) if (!same(entered(before[r]?.[c]), entered(after[r][c]))) {
      const previous = spans.at(-1), cell = { userEnteredValue: after[r][c].userEnteredValue };
      if (previous && previous.r === r && previous.c + previous.cells.length === c) previous.cells.push(cell); else spans.push({ r, c, cells: [cell] });
    }
    const blocks: { r: number; c: number; rows: NativeCellData[][] }[] = [];
    const open = new Map<string, typeof blocks[number]>();
    for (const span of spans) {
      const key = `${span.c}:${span.cells.length}`, previous = open.get(key);
      if (previous && previous.r + previous.rows.length === span.r && previous.rows.length < 32) previous.rows.push(span.cells);
      else { const block = { r: span.r, c: span.c, rows: [span.cells] }; blocks.push(block); open.set(key, block); }
    }
    for (const b of blocks) requests.push({ updateCells: { range: range(sheetId, b.r, b.r + b.rows.length, b.c, b.c + b.rows[0].length), rows: b.rows.map(values => ({ values })), fields: 'userEnteredValue' } });
  };
  writeChanged(current.sheetId, current.canvas, expected.canvas); writeChanged(current.dataSheetId, current.data, expected.data);
  const baseCharts = layout.filter(r => r.addChart).map(r => r.addChart.chart.spec);
  baseCharts.forEach((spec: Record<string, any>, i: number) => {
    if (i < 3) spec.basicChart.axis[1] = { position: 'LEFT_AXIS', title: 'Attendance', viewWindowOptions: { viewWindowMin: 0, viewWindowMax: 1 } };
    if (i === 0 && comparisons.length > 1) {
      const base = spec.basicChart.series[0]; spec.basicChart.legendPosition = 'BOTTOM_LEGEND';
      spec.basicChart.series = comparisons.map((_t, j) => ({ ...copy(base), colorStyle: { rgbColor: [{ red: 0.17, green: 0.43, blue: 0.33 }, { red: 0.25, green: 0.48, blue: 0.7 }, { red: 0.72, green: 0.55, blue: 0.17 }][j] }, series: { sourceRange: { sources: [range(current.dataSheetId, 0, definitions[i].sourceEndRow, j + 1, j + 2)] } } }));
    }
    const chart = expected.charts.find(c => c.chartId === input.chartIds[i])!;
    if (!same(chart.spec, spec)) requests.push({ updateChartSpec: { chartId: chart.chartId, spec } }); chart.spec = spec;
  });
  requests.push({ repeatCell: { range: range(current.sheetId, 49, expected.canvas.length, 0, 5), cell: { userEnteredFormat: { textFormat: { fontFamily: 'Roboto', fontSize: 10 }, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
    { repeatCell: { range: range(current.sheetId, 49, 51, 0, 5), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    { repeatCell: { range: range(current.sheetId, 51, expected.canvas.length, 2, 3), cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'M/d' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { updateDimensionProperties: { range: { sheetId: current.sheetId, dimension: 'ROWS', startIndex: 51, endIndex: expected.canvas.length }, properties: { pixelSize: 48 }, fields: 'pixelSize' } });
  for (const [left, right] of [[1, Math.max(2, comparisons.length + 1)], [6, 7], [9, 10]]) requests.push({ repeatCell: { range: range(current.dataSheetId, 1, expected.data.length, left, right), cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } }, fields: 'userEnteredFormat.numberFormat' } });
  if (!current.dataHidden) requests.push({ updateSheetProperties: { properties: { sheetId: current.dataSheetId, hidden: true }, fields: 'hidden' } }); expected.dataHidden = true;
  if (requests.length > 1000 || JSON.stringify({ requests }).length * 3 > 1_800_000) fail('Dashboard publication exceeds the conservative atomic request budget.');
  return { revision: copy(input.revision), requests, expectedRead: dashboardReadFingerprint(current), expectedAfter: expected, reportingNeedsReview: report.needsReview,
    birthdayCount: dashboard.birthdays.length, noCountedAttendanceCadets: dashboard.noCountedAttendanceCadets };
}

export function verifyDashboardPublicationReadback(plan: DashboardPublicationPlan, actual: DashboardPublicationRead): boolean {
  const expected = plan.expectedAfter;
  if (actual.sheetId !== expected.sheetId || actual.dataSheetId !== expected.dataSheetId || !actual.dataHidden || actual.canvas.length !== expected.canvas.length || actual.data.length !== expected.data.length || actual.charts.length !== expected.charts.length || !same(actual.canvasGrid, expected.canvasGrid) || !same(actual.dataGrid, expected.dataGrid)) return false;
  const merged = (ranges: Range[]) => ranges.map(canonical).sort();
  if (!same(merged(actual.merges), merged(expected.merges))) return false;
  if (expected.charts.some(c => !actual.charts.some(a => a.chartId === c.chartId && same(a.spec, c.spec)))) return false;
  return (['canvas', 'data'] as const).every(key => actual[key].every((row, r) => row.length === expected[key][r].length && row.every((c, i) => same(entered(c), entered(expected[key][r][i])))));
}
