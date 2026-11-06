/** Pure, bounded Sheets API presentation plans for the isolated staging frontend.
 * No resource discovery, ACL changes, sorting, deletion, or operational cell writes.
 * Tables are real Sheets Tables (not a formatting fallback). The native host owns
 * authentication, locks, paused repair, protection checks and read-back execution.
 * API contract: https://developers.google.com/workspace/sheets/api/guides/tables
 */
import { AdapterError } from './index.js';

export type PresentationRole = 'attendance' | 'decisions' | 'decision-input';
/** Raw API shapes stay at this presentation boundary; no provider SDK is needed in GAS. */
export type PresentationRequest = Record<string, any>;
export interface SheetsMetadata { sheets?: Record<string, any>[]; [key: string]: any }
export interface PresentationSurface {
  role: PresentationRole;
  sheetId: number;
  title: string;
  headers: readonly string[];
  displayHeaders: readonly string[];
  /** Last occupied row, one based, including the two header rows. */
  dataEndRow: number;
  gridRowCount: number;
  gridColumnCount: number;
  /** Existing grid capacity to preformat, including the two header rows. */
  capacityRows?: number;
}
export interface PresentationInput {
  surfaces: PresentationSurface[];
  legend: { sheetId: number; title: string; values: unknown[][] };
  metadata: SheetsMetadata;
  /** Full repair verification requires bounded GridData samples and dimensions. */
  requireCellReadback?: boolean;
}
export interface PresentationPlan { requests: PresentationRequest[]; phase?: 'create-tables' | 'configure' }
export interface PresentationVerification { ready: boolean; issues: string[] }

export const PRESENTATION_LEGEND_VALUES: readonly (readonly string[])[] = [
  ['decision', 'meaning'], ['Decision', 'Meaning'],
  ['Approved', 'Approve the requested outcome'], ['Denied', 'Deny the request'],
  ['Withdrawn', 'Withdraw the request'], ['Superseded', 'Replaced by another request'],
];
const MAX_ROWS = 2002;
const MAX_COLUMNS = 100;
const RULE_MARKER = 'SHAMROCK_PRESENTATION_V1:';
const REQUIRED: Record<PresentationRole, readonly string[]> = {
  attendance: ['event_label', 'unit_label', 'display_name', 'observed_code', 'in_current_scope'],
  decisions: ['display_name', 'recorded_status', 'requested_outcome', 'approved_outcome', 'recorded_version', 'event_label', 'unit_label'],
  'decision-input': ['base_version', 'draft_decision', 'draft_state', 'event_label', 'display_name', 'requested_outcome', 'recorded_status'],
};
const HIDDEN = new Set(['event_id', 'unit_id', 'person_id', 'request_id', 'slot_id', 'draft_id', 'draft_json',
  'slot_origin_row', 'slot_context_hash', 'generation', 'projection_revision']);
const COLORS = { green: '#356854', white: '#FFFFFF', band: '#F6F8F9', ink: '#434343' };
const SEMANTIC: Record<string, [string, string]> = {
  P: ['#D9EAD3', '#274E13'], T: ['#FFF2CC', '#7F6000'], E: ['#D9EAD3', '#274E13'],
  ES: ['#D9EAD3', '#274E13'], MED: ['#D9D2E9', '#674EA7'],
  Submitted: ['#FFF2CC', '#7F6000'], Approved: ['#D9EAD3', '#274E13'],
  Denied: ['#F4CCCC', '#990000'], Withdrawn: ['#FFF2CC', '#7F6000'], Superseded: ['#D9D2E9', '#674EA7'],
};
function fail(message: string): never { throw new AdapterError('invalid_presentation', message); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function color(hex: string): Record<string, any> {
  const n = parseInt(hex.slice(1), 16);
  return { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } };
}
/** Sheets normalizes default scalar fields and float colors in its read-back. */
function same(expected: any, actual: any): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) < 0.00001;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => same(v, actual[i]));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
    && Object.keys(expected).every(key => same(expected[key], actual[key]));
  if (actual === undefined && (expected === false || expected === 0 || expected === 'COLUMN_TYPE_UNSPECIFIED')) return true;
  return expected === actual;
}
function capacity(surface: PresentationSurface): number { return surface.capacityRows ?? surface.gridRowCount; }
function range(surface: PresentationSurface, startRowIndex = 1, endRowIndex = Math.max(3, surface.dataEndRow), startColumnIndex = 0, endColumnIndex = surface.headers.length): Record<string, any> {
  return { sheetId: surface.sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex };
}
function sheet(input: PresentationInput, sheetId: number): Record<string, any> {
  const found = input.metadata.sheets?.filter(value => value.properties?.sheetId === sheetId);
  if (found?.length !== 1) fail('A bound presentation sheet is missing or ambiguous.');
  return found[0];
}
function overlaps(a: Record<string, any>, b: Record<string, any>): boolean {
  return a.sheetId === b.sheetId && (a.startRowIndex ?? 0) < (b.endRowIndex ?? Infinity)
    && (b.startRowIndex ?? 0) < (a.endRowIndex ?? Infinity)
    && (a.startColumnIndex ?? 0) < (b.endColumnIndex ?? Infinity)
    && (b.startColumnIndex ?? 0) < (a.endColumnIndex ?? Infinity);
}
function legendEmpty(input: PresentationInput): boolean {
  return input.legend.values.every(row => Array.isArray(row) && row.every(value => value === '' || value === null || value === undefined));
}
function legendExact(input: PresentationInput): boolean {
  const values = input.legend.values;
  return PRESENTATION_LEGEND_VALUES.every((row, r) => row.every((value, c) => values[r]?.[c] === value))
    && values.every((row, r) => Array.isArray(row) && row.every((value, c) =>
      (r < 6 && c < 2) || value === '' || value === null || value === undefined));
}
export function presentationTableIdentity(surface: Pick<PresentationSurface, 'role' | 'sheetId'>): { name: string; metadataKey: string; metadataValue: string } {
  const names: Record<PresentationRole, string> = { attendance: 'Attendance observations', decisions: 'Recorded excusals', 'decision-input': 'Decision review' };
  return { name: names[surface.role], metadataKey: 'SHAMROCK_PRESENTATION_V1', metadataValue: surface.role };
}
function ownershipMarkers(input: PresentationInput, surface: PresentationSurface): Record<string, any>[] {
  const identity = presentationTableIdentity(surface);
  const markers = (sheet(input, surface.sheetId).developerMetadata ?? []).filter((m: any) => m.metadataKey === identity.metadataKey);
  if (markers.length > 1 || (markers.length === 1 && (markers[0].metadataValue !== identity.metadataValue
    || markers[0].location?.sheetId !== surface.sheetId || markers[0].visibility !== 'DOCUMENT'))) fail('Managed presentation ownership metadata is ambiguous.');
  return markers;
}
function tableFor(surface: PresentationSurface, existing?: Record<string, any>): Record<string, any> {
  return { ...(existing ? { tableId: existing.tableId } : {}), name: presentationTableIdentity(surface).name,
    range: range(surface, 1, Math.max(3, surface.dataEndRow, existing?.range?.endRowIndex ?? 0)), rowsProperties: {
    headerColorStyle: color(COLORS.green), firstBandColorStyle: color(COLORS.white), secondBandColorStyle: color(COLORS.band),
  }, columnProperties: surface.displayHeaders.map((columnName, columnIndex) => ({ columnIndex, columnName, columnType: 'COLUMN_TYPE_UNSPECIFIED' })) };
}
function managedTable(input: PresentationInput, surface: PresentationSurface): Record<string, any> | undefined {
  const identity = presentationTableIdentity(surface), markers = ownershipMarkers(input, surface);
  const matches = (input.metadata.sheets ?? []).flatMap(s => s.tables ?? []).filter(table => table.name === identity.name);
  if (matches.length > 1 || (matches.length === 1 && (!markers.length || !matches[0].tableId
    || matches[0].range?.sheetId !== surface.sheetId || matches[0].range?.startRowIndex !== 1
    || (matches[0].range?.startColumnIndex ?? 0) !== 0 || !integer(matches[0].range?.endColumnIndex, 1, surface.headers.length)
    || !integer(matches[0].range?.endRowIndex, 3, capacity(surface))))) {
    fail('A managed table name, ownership marker, or range conflicts with the bound sheet.');
  }
  return matches[0];
}
function validate(input: PresentationInput): void {
  if (!input || !input.metadata || !Array.isArray(input.metadata.sheets) || !Array.isArray(input.surfaces)
    || input.surfaces.length < 1 || input.surfaces.length > 3 || !input.legend || !Array.isArray(input.legend.values)) fail('Missing presentation bindings.');
  const ids = [input.legend.sheetId, ...input.surfaces.map(s => s.sheetId)];
  if (ids.some(id => !integer(id, 0, 2147483647)) || new Set(ids).size !== ids.length
    || new Set(input.surfaces.map(s => s.role)).size !== input.surfaces.length) fail('Presentation bindings must identify distinct sheets and roles.');
  const legend = sheet(input, input.legend.sheetId);
  if (legend.properties?.title !== input.legend.title || !input.legend.title || input.legend.title.length > 100
    || legend.properties?.gridProperties?.rowCount < 6 || legend.properties?.gridProperties?.columnCount < 2) fail('Invalid legend binding.');
  if (!legendEmpty(input) && !legendExact(input)) fail('The bound legend contains unrecognized values; repair will not overwrite them.');
  if ((legend.merges ?? []).some((r: any) => overlaps({ sheetId: input.legend.sheetId, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 2 }, r))) fail('The managed legend intersects merged cells.');
  for (const surface of input.surfaces) {
    if (!REQUIRED[surface.role] || !Array.isArray(surface.headers) || !Array.isArray(surface.displayHeaders)
      || !integer(surface.headers.length, 1, MAX_COLUMNS) || surface.displayHeaders.length !== surface.headers.length
      || surface.headers.some(h => typeof h !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(h))
      || surface.displayHeaders.some(h => typeof h !== 'string' || !h.trim() || h.length > 100)
      || new Set(surface.headers).size !== surface.headers.length || new Set(surface.displayHeaders).size !== surface.displayHeaders.length
      || REQUIRED[surface.role].some(h => !surface.headers.includes(h))
      || !integer(surface.gridRowCount, 3, MAX_ROWS) || !integer(surface.gridColumnCount, surface.headers.length, MAX_COLUMNS)
      || !integer(capacity(surface), 3, surface.gridRowCount) || !integer(surface.dataEndRow, 2, capacity(surface))) fail('Invalid or oversized presentation schema.');
    const metadata = sheet(input, surface.sheetId);
    if (metadata.properties?.title !== surface.title || metadata.properties?.gridProperties?.rowCount !== surface.gridRowCount
      || metadata.properties?.gridProperties?.columnCount !== surface.gridColumnCount) fail('Presentation metadata does not match the bound sheet.');
    const managed = managedTable(input, surface);
    const footprint = range(surface, 0, capacity(surface));
    if ((metadata.merges ?? []).some((r: any) => overlaps(footprint, r))) fail('A managed presentation range intersects merged cells.');
    if ((metadata.tables ?? []).some((table: any) => table !== managed && overlaps(footprint, table.range ?? {}))) fail('A managed presentation range intersects another table.');
  }
}
function columnLetter(index: number): string {
  let result = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
function filterId(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % 2000000000 + 1;
}
function views(surface: PresentationSurface, existing?: Record<string, any>): Record<string, any>[] {
  const labels = { attendance: 'Attendance', decisions: 'Excusal results', 'decision-input': 'Decisions' };
  const definitions: { name: string; conditions: [string, string, string?][] }[] = [{ name: 'All records', conditions: [] }];
  if (surface.role === 'attendance') definitions.push({ name: 'Current roster', conditions: [['in_current_scope', 'TEXT_EQ', 'TRUE']] });
  if (surface.role === 'decisions') definitions.push({ name: 'Pending requests', conditions: [['recorded_status', 'TEXT_EQ', 'Submitted']] });
  if (surface.role === 'decision-input') definitions.push({ name: 'Ready for decision', conditions: [['draft_state', 'TEXT_EQ', 'Ready for decision'], ['draft_decision', 'BLANK']] });
  return definitions.map(({ name, conditions }) => ({
    filterViewId: filterId(`${surface.sheetId}:${surface.role}:${name}`), title: `SHAMROCK · ${labels[surface.role]} · ${name}`,
    range: tableFor(surface, existing).range, filterSpecs: conditions.map(([header, type, value]) => ({
      columnIndex: surface.headers.indexOf(header), filterCriteria: { condition: { type, ...(value === undefined ? {} : { values: [{ userEnteredValue: value }] }) } },
    })),
  }));
}
function existingView(input: PresentationInput, surface: PresentationSurface, view: Record<string, any>): Record<string, any> | undefined {
  const matches = (input.metadata.sheets ?? []).flatMap(s => s.filterViews ?? []).filter(v => v.filterViewId === view.filterViewId || v.title === view.title);
  if (matches.length > 1 || (matches.length === 1 && (matches[0].filterViewId !== view.filterViewId || matches[0].range?.sheetId !== surface.sheetId))) {
    fail('A managed filter view identity collides with an existing view.');
  }
  return matches[0];
}
function retainViewExtent(view: Record<string, any>, existing: Record<string, any> | undefined, surface: PresentationSurface): Record<string, any> {
  if (!existing) return view;
  if (!integer(existing.range?.endRowIndex, 3, capacity(surface))) fail('A managed filter view exceeds presentation capacity.');
  return { ...view, range: { ...view.range, endRowIndex: Math.max(view.range.endRowIndex, existing.range.endRowIndex) } };
}
function semanticRules(surface: PresentationSurface): Record<string, any>[] {
  const rules: Record<string, any>[] = [];
  const add = (header: string, key: string, expression: string, background: string, foreground: string) => {
    const column = surface.headers.indexOf(header); if (column < 0) return;
    rules.push({ ranges: [range(surface, 2, capacity(surface), column, column + 1)], booleanRule: {
      condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND(N("${RULE_MARKER}${header}:${key}")=0,${expression})` }] },
      format: { backgroundColorStyle: color(background), textFormat: { foregroundColorStyle: color(foreground), bold: true } },
    } });
  };
  for (const header of ['observed_code', 'requested_outcome', 'approved_outcome', 'recorded_status', 'draft_decision']) {
    const col = surface.headers.indexOf(header); if (col < 0) continue;
    const statuses = header === 'recorded_status' || header === 'draft_decision';
    for (const [key, palette] of Object.entries(SEMANTIC)) {
      if ((key.length > 3) !== statuses || (header === 'observed_code' && key !== 'P')) continue;
      add(header, key, `$${columnLetter(col)}3="${key}"`, ...palette);
    }
  }
  const state = surface.headers.indexOf('draft_state');
  if (state >= 0) {
    add('draft_state', 'committed', `REGEXMATCH($${columnLetter(state)}3,"^Committed")`, '#D9EAD3', '#274E13');
    add('draft_state', 'attention', `REGEXMATCH($${columnLetter(state)}3,"^(Conflict|Rejected|Attention|Needs|Failed)")`, '#F4CCCC', '#990000');
    add('draft_state', 'pending', `REGEXMATCH($${columnLetter(state)}3,"^(Queued|Retry|Awaiting|Waiting)")`, '#FFF2CC', '#7F6000');
  }
  return rules;
}
function managedRule(rule: Record<string, any>): boolean {
  return rule.booleanRule?.condition?.type === 'CUSTOM_FORMULA'
    && String(rule.booleanRule.condition.values?.[0]?.userEnteredValue ?? '').startsWith(`=AND(N("${RULE_MARKER}`);
}
function width(header: string): number {
  if (HIDDEN.has(header)) return 110;
  if (header === 'event_label') return 260;
  if (header === 'display_name') return 185;
  if (header === 'unit_label') return 135;
  if (header === 'draft_state') return 245;
  if (header === 'draft_decision') return 175;
  if (header.endsWith('version')) return 95;
  if (header === 'recorded_status') return 155;
  return 135;
}
function bodyFormat(header: string): Record<string, any> {
  const centered = ['observed_code', 'requested_outcome', 'approved_outcome', 'base_version', 'recorded_version', 'in_current_scope'].includes(header);
  return { horizontalAlignment: centered ? 'CENTER' : 'LEFT', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP',
    textFormat: { fontFamily: 'Roboto', fontSize: 10, foregroundColorStyle: color(COLORS.ink), bold: header === 'observed_code' || header === 'draft_decision' },
    numberFormat: { type: header.endsWith('version') || header === 'slot_origin_row' ? 'NUMBER' : 'TEXT', pattern: header.endsWith('version') || header === 'slot_origin_row' ? '0' : '@' },
  };
}
function headerFormat(): Record<string, any> {
  return { backgroundColorStyle: color(COLORS.green), horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP',
    textFormat: { fontFamily: 'Roboto', fontSize: 10, foregroundColorStyle: color(COLORS.white), bold: true } };
}
function formatFields(format: Record<string, any>): string {
  return Object.keys(format).flatMap(key => key === 'textFormat'
    ? Object.keys(format.textFormat).map(part => `userEnteredFormat.textFormat.${part}`)
    : [`userEnteredFormat.${key}`]).join(',');
}
function validationRule(input: PresentationInput): Record<string, any> {
  return { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `='${input.legend.title.replace(/'/g, "''")}'!$A$3:$A$6` }] },
    inputMessage: 'Select Approved, Denied, Withdrawn, or Superseded. Delivery status shows the saved result.', strict: true, showCustomUi: true };
}
function formatRequests(input: PresentationInput, surface: PresentationSurface): PresentationRequest[] {
  const requests: PresentationRequest[] = [{ updateSheetProperties: { properties: { sheetId: surface.sheetId,
    gridProperties: { frozenRowCount: 2, frozenColumnCount: 0, hideGridlines: true }, tabColorStyle: color(COLORS.green) },
  fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.hideGridlines,tabColorStyle' } },
  { updateDimensionProperties: { range: { sheetId: surface.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
  { updateDimensionProperties: { range: { sheetId: surface.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { hiddenByUser: false, pixelSize: 42 }, fields: 'hiddenByUser,pixelSize' } },
  { repeatCell: { range: range(surface, 1, 2), cell: { userEnteredFormat: headerFormat() }, fields: formatFields(headerFormat()) } },
  { repeatCell: { range: range(surface, 1, capacity(surface)), cell: { userEnteredFormat: { borders: {} } }, fields: 'userEnteredFormat.borders' } }];
  surface.headers.forEach((header, column) => {
    requests.push({ updateDimensionProperties: { range: { sheetId: surface.sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 },
      properties: { hiddenByUser: HIDDEN.has(header), pixelSize: width(header) }, fields: 'hiddenByUser,pixelSize' } });
    const format = bodyFormat(header);
    requests.push({ repeatCell: { range: range(surface, 2, capacity(surface), column, column + 1), cell: { userEnteredFormat: format }, fields: formatFields(format) } });
  });
  if (surface.role === 'decision-input') {
    const column = surface.headers.indexOf('draft_decision');
    requests.push({ setDataValidation: { range: range(surface, 2, capacity(surface), column, column + 1), rule: validationRule(input), filteredRowsIncluded: true } });
  }
  return requests;
}
/** Full repair may repeat formatting requests; its resulting state is idempotent.
 * Each entire plan is validated before any request is returned. Execute in order,
 * then GET fresh metadata and verify; an HTTP success alone is not readiness. */
export function planPresentationRepair(input: PresentationInput): PresentationPlan {
  validate(input);
  // Table creation and its ownership marker travel together in one small atomic
  // batch. Re-read before configuring the provider-assigned IDs. Never adopt an
  // unmarked table after an ambiguous failure; inspect/recover it explicitly.
  const creations: PresentationRequest[] = [];
  for (const surface of input.surfaces) if (!managedTable(input, surface)) {
    const identity = presentationTableIdentity(surface);
    creations.push({ addTable: { table: { name: identity.name, range: range(surface) } } });
    if (!ownershipMarkers(input, surface).length) creations.push({ createDeveloperMetadata: { developerMetadata: {
      metadataKey: identity.metadataKey, metadataValue: identity.metadataValue,
      location: { sheetId: surface.sheetId }, visibility: 'DOCUMENT',
    } } });
  }
  if (creations.length) return { phase: 'create-tables', requests: creations };
  const requests: PresentationRequest[] = [];
  if (legendEmpty(input)) requests.push({ updateCells: { range: { sheetId: input.legend.sheetId, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 2 },
    rows: PRESENTATION_LEGEND_VALUES.map(row => ({ values: row.map(stringValue => ({ userEnteredValue: { stringValue } })) })), fields: 'userEnteredValue' } });
  if (sheet(input, input.legend.sheetId).properties.hidden !== true) requests.push({ updateSheetProperties: {
    properties: { sheetId: input.legend.sheetId, hidden: true }, fields: 'hidden' } });
  for (const surface of input.surfaces) {
    const existing = managedTable(input, surface)!, desired = tableFor(surface, existing);
    if (!same(desired, existing)) requests.push({ updateTable: { table: desired, fields: 'name,range,rowsProperties,columnProperties' } });
    for (const view of views(surface, managedTable(input, surface))) {
      const existing = existingView(input, surface, view), desired = retainViewExtent(view, existing, surface);
      if (!existing) requests.push({ addFilterView: { filter: desired } });
      else if (!same(desired, { ...existing, filterSpecs: existing.filterSpecs ?? [] })) requests.push({ updateFilterView: { filter: desired, fields: 'title,range,filterSpecs' } });
    }
    const current = sheet(input, surface.sheetId).conditionalFormats ?? [];
    const managed = current.filter(managedRule), expected = semanticRules(surface);
    if (!same(expected, managed)) {
      // Reverse removal preserves all foreign rules and their relative precedence.
      for (let index = current.length - 1; index >= 0; index--) if (managedRule(current[index])) requests.push({ deleteConditionalFormatRule: { sheetId: surface.sheetId, index } });
      expected.forEach((rule, index) => requests.push({ addConditionalFormatRule: { rule, index } }));
    }
    requests.push(...formatRequests(input, surface));
  }
  return { phase: 'configure', requests };
}
/** Publication fast path: only extends existing table/view ranges. Never recreates
 * or shrinks tables, changes styling/validation, or writes an operational value. */
export function planPresentationGrowth(input: PresentationInput): PresentationPlan {
  validate(input);
  if (!legendExact(input)) fail('Presentation repair is required before publication.');
  const requests: PresentationRequest[] = [];
  for (const surface of input.surfaces) {
    const existing = managedTable(input, surface), desired = tableFor(surface, existing);
    if (!existing || existing.range.startRowIndex !== 1 || (existing.range.startColumnIndex ?? 0) !== 0
      || existing.range.endColumnIndex !== surface.headers.length || !same(desired.columnProperties, existing.columnProperties)
      || !same(desired.rowsProperties, existing.rowsProperties)) fail('A native table needs full presentation repair.');
    const end = Math.max(existing.range.endRowIndex ?? 0, desired.range.endRowIndex);
    if (end > capacity(surface)) fail('The managed table exceeds presentation capacity.');
    if (end > existing.range.endRowIndex) requests.push({ updateTable: { table: { tableId: existing.tableId, range: { ...desired.range, endRowIndex: end } }, fields: 'range' } });
    for (const view of views(surface, managedTable(input, surface))) {
      const existing = existingView(input, surface, view);
      if (!existing) fail('A managed filter view needs full presentation repair.');
      retainViewExtent(view, existing, surface);
      if ((existing.range?.endRowIndex ?? 0) < end) requests.push({ updateFilterView: {
        filter: { filterViewId: view.filterViewId, range: { ...view.range, endRowIndex: end } }, fields: 'range' } });
    }
  }
  return { requests };
}
function cellAt(metadata: Record<string, any>, row: number, column: number): Record<string, any> | undefined {
  for (const block of metadata.data ?? []) {
    const localRow = row - (block.startRow ?? 0), localColumn = column - (block.startColumn ?? 0);
    if (localRow >= 0 && localColumn >= 0) {
      const value = block.rowData?.[localRow]?.values?.[localColumn]; if (value !== undefined) return value;
    }
  }
  return undefined;
}
function dimensionAt(metadata: Record<string, any>, dimension: 'row' | 'column', index: number): Record<string, any> | undefined {
  for (const block of metadata.data ?? []) {
    const offset = index - (block[dimension === 'row' ? 'startRow' : 'startColumn'] ?? 0);
    if (offset >= 0 && block[`${dimension}Metadata`]?.[offset] !== undefined) return block[`${dimension}Metadata`][offset];
  }
  return undefined;
}
/** Structural checks are separate from sampled style read-back. Missing real Table
 * metadata always fails, even if every cell happens to look like a table. */
export function verifyPresentation(input: PresentationInput): PresentationVerification {
  validate(input);
  const issues: string[] = [];
  const legend = sheet(input, input.legend.sheetId);
  if (!legendExact(input)) issues.push('legend:values');
  if (legend.properties.hidden !== true) issues.push('legend:hidden');
  if (!(legend.protectedRanges ?? []).some((p: any) => p.warningOnly !== true && p.range?.sheetId === input.legend.sheetId
    && Object.keys(p.range).every(key => key === 'sheetId') && !(p.unprotectedRanges?.length))) issues.push('legend:protection');
  for (const surface of input.surfaces) {
    const metadata = sheet(input, surface.sheetId), actual = managedTable(input, surface), desired = tableFor(surface, actual);
    if (!actual || !same(desired, actual)) issues.push(`${surface.role}:native-table`);
    for (const view of views(surface, managedTable(input, surface))) {
      const actual = existingView(input, surface, view);
      if (!actual || !same(retainViewExtent(view, actual, surface), { ...actual, filterSpecs: actual.filterSpecs ?? [] })) issues.push(`${surface.role}:filter-view`);
    }
    if (!same(semanticRules(surface), (metadata.conditionalFormats ?? []).filter(managedRule))) issues.push(`${surface.role}:conditional-colors`);
    if (!same({ frozenRowCount: 2, frozenColumnCount: 0, hideGridlines: true }, metadata.properties.gridProperties)) issues.push(`${surface.role}:frozen-headers`);
    if (!same(color(COLORS.green), metadata.properties.tabColorStyle)) issues.push(`${surface.role}:tab-color`);
    if (!input.requireCellReadback) continue;
    if (!same({ hiddenByUser: true }, dimensionAt(metadata, 'row', 0)) || !same({ hiddenByUser: false, pixelSize: 42 }, dimensionAt(metadata, 'row', 1))) issues.push(`${surface.role}:header-dimensions`);
    surface.headers.forEach((header, column) => {
      if (!same({ hiddenByUser: HIDDEN.has(header), pixelSize: width(header) }, dimensionAt(metadata, 'column', column))) issues.push(`${surface.role}:column-dimensions:${header}`);
      if (!same(headerFormat(), cellAt(metadata, 1, column)?.userEnteredFormat)) issues.push(`${surface.role}:header-format:${header}`);
      for (const row of new Set([2, capacity(surface) - 1])) {
        const cell = cellAt(metadata, row, column);
        if (!same(bodyFormat(header), cell?.userEnteredFormat)) issues.push(`${surface.role}:body-format:${header}`);
        if (header === 'draft_decision' && !same(validationRule(input), cell?.dataValidation)) issues.push(`${surface.role}:decision-validation`);
      }
    });
  }
  return { ready: issues.length === 0, issues: [...new Set(issues)] };
}
/** Each batch is bounded by both request count and serialized bytes. Never send
 * an empty batch; on a failed/ambiguous response fetch metadata and re-plan. */
export function chunkPresentationRequests(requests: PresentationRequest[], max = 75): PresentationRequest[][] {
  if (!Array.isArray(requests) || !integer(max, 1, 100) || requests.length > 1000) fail('Presentation batch limits exceeded.');
  if (requests.some(request => !request || typeof request !== 'object' || Object.keys(request).length !== 1)) fail('A Sheets request must contain exactly one operation.');
  if (requests.some(request => request.addTable)) {
    if (requests.length > 6 || requests.some(request => !request.addTable && !request.createDeveloperMetadata)
      || JSON.stringify(requests).length * 3 > 180000) fail('Table creation must remain a small atomic ownership batch.');
    return requests.length ? [requests] : [];
  }
  const batches: PresentationRequest[][] = []; let batch: PresentationRequest[] = [], bytes = 0;
  for (const request of requests) {
    if (!request || typeof request !== 'object' || Object.keys(request).length !== 1) fail('A Sheets request must contain exactly one operation.');
    const size = JSON.stringify(request).length * 3;
    if (size > 180000) fail('One presentation request exceeds the byte budget.');
    if (batch.length && (batch.length >= max || bytes + size > 180000)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(request); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
