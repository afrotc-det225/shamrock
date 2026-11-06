/** Pure keyed frontend publication planning. The host owns IO, authentication and edit fencing. */
import { AdapterError } from './index.js';
import { DIRECTORY_EDIT_FIELDS, LEADERSHIP_EDIT_FIELDS } from './frontend-protections.js';
import { buildAttendanceGrowthLayout } from './frontend-layout.js';
import type { FrontendSnapshot, SnapshotRevision } from '../../../packages/domain/src/admin.js';
import { REPORTING_POLICY_VERSION } from '../../../packages/domain/src/frontend-reporting.js';
import type { FrontendReportingInput, ReportingMatrix, buildFrontendReporting } from '../../../packages/domain/src/frontend-reporting.js';
import type { ExcusalStatus, RequestedOutcome } from '../../../packages/domain/src/index.js';

export type FrontendValue = string | number | boolean | null | { fileUri: string };
export interface FrontendColumn {
  header: string;
  label: string;
  editable: boolean;
  /** Registry key for a protected, visually reviewed native validation seed. */
  seedKey?: string;
  fileChip?: boolean;
}
export interface FrontendPublicationRow {
  key: string;
  values: Record<string, FrontendValue>;
  /** Domain record versions for editable cells; zero is an explicit absent record. */
  versions: Record<string, number>;
  /** Frozen catalog revision for each editable attendance event column. */
  eventVersions?: Record<string, number>;
  readonlyHeaders?: string[];
  commandBindings?: Record<string, FrontendEditBinding>;
}
export interface FrontendEditBinding {
  operation: 'directory.upsert' | 'leadership.upsert' | 'attendance.correct' | 'excusal.decide';
  entityId: string;
  field: string;
  expectedVersion: number;
}
export interface FrontendPublicationTable {
  kind: 'directory' | 'leadership' | 'attendance' | 'excusal';
  keyHeader: 'person_id' | 'contact_id' | 'request_id';
  columns: FrontendColumn[];
  rows: FrontendPublicationRow[];
  holds?: { key: string; header: string; reason: string }[];
}
export interface FrontendPublicationModel {
  generation: number;
  revision: SnapshotRevision;
  tables: FrontendPublicationTable[];
}
export interface NativeCellData {
  userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; formulaValue?: string };
  chipRuns?: { startIndex?: number; chip?: { richLinkProperties?: { uri?: string }; personProperties?: unknown } }[];
}
export interface FrontendTableRead {
  sheetId: number;
  tableId: string;
  gridRowCount: number;
  gridColumnCount: number;
  headers: string[];
  labels: string[];
  /** Exact Table body, starting at row 3. Retain empty rows. */
  rows: NativeCellData[][];
  range: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
  hiddenColumns: number[];
  machineRowHidden: boolean;
}
export interface FrontendPublicationBaseline {
  generation: number;
  revision: SnapshotRevision;
  /** Last verified values and their domain base versions, keyed rather than positional. */
  rows: FrontendPublicationRow[];
}
export interface FrontendDraft {
  key: string;
  header: string;
  baseVersion: number;
  value: FrontendValue;
  expectedEventVersion?: number;
  command?: FrontendEditBinding;
}
export interface FrontendValidationSeed {
  key: string;
  sheetId: number;
  rowIndex: number;
  columnIndex: number;
  protected: boolean;
  hidden: boolean;
  nativeStyleVersion: string;
  expectedRule: unknown;
  observedRule: unknown;
}
export interface FrontendPublicationInput {
  generation: number;
  revision: SnapshotRevision;
  table: FrontendPublicationTable;
  current: FrontendTableRead;
  baseline: FrontendPublicationBaseline;
  drafts: readonly FrontendDraft[];
  seeds: readonly FrontendValidationSeed[];
  /** Host attestation: human editing/sorting is fenced, not merely ScriptLock-held. */
  editFenceVerified: boolean;
}
export interface FrontendPublicationDiagnostic {
  code: 'unsent-edit' | 'version-conflict' | 'pending-draft' | 'draft-cell-changed' | 'retired-row-with-edit' | 'reporting-review';
  key: string;
  header?: string;
}
export interface FrontendPublicationPlan {
  requests: Record<string, unknown>[];
  batches: Record<string, unknown>[][];
  diagnostics: FrontendPublicationDiagnostic[];
  complete: boolean;
  nextBaseline: FrontendPublicationBaseline;
  retainedDrafts: FrontendDraft[];
  /** Private precondition material: do not log, send to an AI, or publish in a sheet. */
  expectedRead: string;
  expectedAfter: FrontendTableRead;
  changedCells: number;
  copiedValidationRanges: number;
  validationExpectations: FrontendValidationExpectation[];
  /** Only commit the baseline/cursor after provider read-back and while the fence holds. */
  requiresVerifiedReadback: true;
}
export interface FrontendValidationExpectation {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  expectedRule: unknown;
}
export interface FrontendValidationRead extends Omit<FrontendValidationExpectation, 'expectedRule'> {
  rows: (unknown | null)[][];
}
const MAX_ROWS = 500, MAX_EVENTS = 128, MAX_COLUMNS = 160, MAX_REQUESTS = 1000;
const MAX_BATCH_BYTES = 900_000, MAX_PLAN_BYTES = 8_000_000;
function fail(message: string): never { throw new AdapterError('frontend_publication', message); }
const integer = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const blank = (value: FrontendValue) => value === null || value === '';
const equal = (a: FrontendValue, b: FrontendValue) => (blank(a) && blank(b)) || same(a, b);
function bytes(value: unknown): number {
  let length = 0; for (const c of JSON.stringify(value)) { const n = c.codePointAt(0)!; length += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; } return length;
}
function batchRequests(requests: Record<string, unknown>[]): Record<string, unknown>[][] {
  if (requests.length > MAX_REQUESTS) fail('Publication exceeds its bounded request plan.');
  const batches: Record<string, unknown>[][] = []; let current: Record<string, unknown>[] = [], size = 16, total = 0;
  for (const request of requests) {
    const n = bytes(request) + 1; total += n;
    if (n + 16 > MAX_BATCH_BYTES || total > MAX_PLAN_BYTES) fail('Publication exceeds its bounded byte budget.');
    if (current.length >= 100 || size + n > MAX_BATCH_BYTES) { batches.push(current); current = []; size = 16; }
    current.push(request); size += n;
  }
  if (current.length) batches.push(current);
  return batches;
}
function revision(value: SnapshotRevision): void {
  if (!value || !integer(value.operations) || !integer(value.administration)) fail('A coherent snapshot revision is required.');
}
function value(input: unknown): FrontendValue {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && input.length <= 50_000 && !input.includes('\u0000')) return input;
  if (input && typeof input === 'object' && Object.keys(input).length === 1 && 'fileUri' in input && typeof input.fileUri === 'string' && input.fileUri.length <= 2048) {
    if (!/^https:\/\/(?:drive|docs)\.google\.com\/[^\s\\\u0000-\u001f\u007f]*$/i.test(input.fileUri)) fail('File chips require an explicit Google file reference.');
    try { decodeURI(input.fileUri); } catch { return fail('Invalid file-chip reference.'); }
    return { fileUri: input.fileUri };
  }
  return fail('Unsupported literal frontend value.');
}
function readValue(cell: NativeCellData, column: FrontendColumn): FrontendValue {
  const entered = cell.userEnteredValue ?? {};
  if (entered.formulaValue !== undefined) fail('Frontend publication requires literal cells; a formula needs review.');
  if (cell.chipRuns?.length) {
    const run = cell.chipRuns[0];
    if (!column.fileChip || cell.chipRuns.length !== 1 || (run.startIndex ?? 0) !== 0 || run.chip?.personProperties || !run.chip?.richLinkProperties?.uri) fail('Unexpected rich chip in a frontend cell.');
    return value({ fileUri: run.chip.richLinkProperties.uri });
  }
  if (Object.keys(entered).length > 1) fail('Ambiguous entered cell value.');
  if (entered.stringValue !== undefined) return value(entered.stringValue);
  if (entered.numberValue !== undefined) return value(entered.numberValue);
  if (entered.boolValue !== undefined) return value(entered.boolValue);
  if (Object.keys(entered).length) fail('Unsupported entered cell value.');
  return null;
}
/** Encodes strings as stringValue, including =, + and apostrophes. Never USER_ENTERED. */
export function frontendLiteralCell(input: FrontendValue): NativeCellData {
  const parsed = value(input);
  if (parsed === null || parsed === '') return {};
  if (typeof parsed === 'object') return { userEnteredValue: { stringValue: '@' }, chipRuns: [{ startIndex: 0, chip: { richLinkProperties: { uri: parsed.fileUri } } }] };
  if (typeof parsed === 'string') return { userEnteredValue: { stringValue: parsed } };
  if (typeof parsed === 'number') return { userEnteredValue: { numberValue: parsed } };
  return { userEnteredValue: { boolValue: parsed } };
}
function normalizeRule(input: unknown): unknown {
  if (!input || typeof input !== 'object') fail('Native validation seed metadata is missing.');
  const rule = input as { strict?: boolean; showCustomUi?: boolean; condition?: { type?: string; values?: { userEnteredValue?: string }[] } };
  const reference = rule.condition?.values?.[0]?.userEnteredValue;
  if (rule.strict !== true || rule.condition?.type !== 'ONE_OF_RANGE' || rule.condition.values?.length !== 1 || typeof reference !== 'string' || !/^=?'[^']+'!\$[A-Z]+\$[1-9]\d*:\$[A-Z]+\$[1-9]\d*$/.test(reference)) fail('Native validation must have a strict, bounded legend source.');
  return { ...clone(rule), showCustomUi: rule.showCustomUi === true,
    condition: { ...rule.condition, values: [{ userEnteredValue: reference.replace(/^=/, '') }] } };
}
function keyed(rows: readonly FrontendPublicationRow[], columns: readonly FrontendColumn[], keyHeader: string): Map<string, FrontendPublicationRow> {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('Frontend row capacity exceeded.');
  const keys = new Map<string, FrontendPublicationRow>(), headers = columns.map(c => c.header);
  for (const row of rows as readonly FrontendPublicationRow[]) {
    if (!id(row.key) || keys.has(row.key) || !row.values || !row.versions) fail('Frontend row identity is missing or duplicated.');
    if (row.values[keyHeader] !== row.key || headers.some(h => !Object.hasOwn(row.values, h)) || Object.keys(row.values).some(h => !headers.includes(h))) fail('Frontend values do not match their keyed schema.');
    if (row.readonlyHeaders && (!Array.isArray(row.readonlyHeaders) || new Set(row.readonlyHeaders).size !== row.readonlyHeaders.length || row.readonlyHeaders.some(h => !headers.includes(h)))) fail('Read-only row fields must match the schema.');
    for (const [header, binding] of Object.entries(row.commandBindings ?? {})) {
      if (!columns.find(c => c.header === header)?.editable || row.readonlyHeaders?.includes(header) || !['directory.upsert', 'leadership.upsert', 'attendance.correct', 'excusal.decide'].includes(binding.operation) || !id(binding.entityId) || !id(binding.field) || !integer(binding.expectedVersion)) fail('Editable command bindings are invalid.');
    }
    for (const column of columns) {
      const parsed = value(row.values[column.header]);
      if (typeof parsed === 'object' && parsed !== null && !column.fileChip) fail('File reference supplied outside a photo column.');
      if (column.editable && !integer(row.versions[column.header])) fail('Editable fields need explicit domain base versions.');
      if (column.header.startsWith('event:') && !integer(row.eventVersions?.[column.header], 1)) fail('Attendance input needs its frozen event catalog version.');
    }
    keys.set(row.key, row);
  }
  return keys;
}

/** Plan only the explicitly bound existing native Table. Never creates/deletes sheets or sorts rows. */
export function planFrontendPublication(input: FrontendPublicationInput): FrontendPublicationPlan {
  if (!input.editFenceVerified) fail('A host-verified human-edit and sort fence is required.');
  revision(input.revision); revision(input.baseline.revision);
  if (!integer(input.generation, 1) || input.generation !== input.baseline.generation || input.revision.operations < input.baseline.revision.operations || input.revision.administration < input.baseline.revision.administration) fail('Frontend generation or snapshot revision is stale.');
  const { table, current } = input;
  if (!['directory', 'leadership', 'attendance', 'excusal'].includes(table.kind) || table.keyHeader !== (table.kind === 'leadership' ? 'contact_id' : table.kind === 'excusal' ? 'request_id' : 'person_id')) fail('Frontend identity must use the correct stable key.');
  if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > MAX_COLUMNS || new Set(table.columns.map(c => c.header)).size !== table.columns.length) fail('Frontend column schema is invalid.');
  for (const c of table.columns) if (!id(c.header) || typeof c.label !== 'string' || !c.label || c.label.length > 512 || typeof c.editable !== 'boolean' || (c.header === table.keyHeader && c.editable)) fail('Frontend column metadata is invalid.');
  const columns = new Map(table.columns.map(c => [c.header, c]));
  if (!columns.has(table.keyHeader) || table.columns.filter(c => c.header.startsWith('event:')).length > MAX_EVENTS) fail('Frontend event capacity or identity schema is invalid.');
  if (!integer(current.sheetId, 0, 2147483647) || typeof current.tableId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(current.tableId) || !integer(current.gridRowCount, 3, 10_002) || !integer(current.gridColumnCount, 1, 512)) fail('A bounded existing native Table binding is required.');
  if (!Array.isArray(current.headers) || current.headers.length > MAX_COLUMNS || current.headers.length > current.gridColumnCount || new Set(current.headers).size !== current.headers.length || current.headers.some(h => !columns.has(h)) || !current.headers.includes(table.keyHeader) || current.labels.length !== current.headers.length) fail('Existing headers need explicit schema migration; publication cannot guess identity or remove columns.');
  if (!Array.isArray(current.rows) || current.rows.length > MAX_ROWS || current.rows.some(r => r.length !== current.headers.length) || current.range.sheetId !== current.sheetId || current.range.startRowIndex !== 1 || current.range.startColumnIndex !== 0 || current.range.endRowIndex !== current.rows.length + 2 || current.range.endRowIndex > current.gridRowCount || current.range.endColumnIndex !== current.headers.length) fail('Fresh native Table extent does not match the bounded read.');
  const desired = keyed(table.rows, table.columns, table.keyHeader);
  const oldColumns = current.headers.map(h => columns.get(h)!);
  const baseline = keyed(input.baseline.rows, oldColumns, table.keyHeader);
  const readRows = current.rows.map(cells => Object.fromEntries(current.headers.map((h, i) => [h, readValue(cells[i], columns.get(h)!)])));
  const seen = new Set<string>();
  for (const row of readRows) {
    const key = row[table.keyHeader];
    if (blank(key)) { if (Object.values(row).some(v => !blank(v))) fail('A populated row is missing its protected stable identity.'); continue; }
    if (!id(key) || seen.has(key) || !baseline.has(key)) fail('A row identity is duplicated, untracked or rebound.'); seen.add(key);
  }
  if (baseline.size !== seen.size) fail('Published keyed rows disappeared; explicit reconciliation is required.');
  const headers = [...current.headers, ...table.columns.map(c => c.header).filter(h => !current.headers.includes(h))];
  const labels = headers.map(h => columns.get(h)!.label);
  const drafts = new Map<string, FrontendDraft>();
  const cellKey = (key: string, header: string) => JSON.stringify([key, header]);
  if (!Array.isArray(input.drafts) || input.drafts.length > MAX_ROWS * MAX_COLUMNS) fail('Pending draft capacity exceeded.');
  for (const draft of input.drafts) {
    const column = columns.get(draft.header), key = cellKey(draft.key, draft.header);
    if (!baseline.has(draft.key) || !column?.editable || baseline.get(draft.key)!.readonlyHeaders?.includes(draft.header) || !integer(draft.baseVersion) || drafts.has(key)) fail('A pending draft has an invalid keyed target.');
    if (draft.command && !same(draft.command, baseline.get(draft.key)!.commandBindings?.[draft.header])) fail('The draft command does not match its original publication binding.');
    if (draft.header.startsWith('event:') && !integer(draft.expectedEventVersion, 1)) fail('Attendance draft event version is missing.');
    value(draft.value); drafts.set(key, draft);
  }
  const holds = new Set((table.holds ?? []).map(h => {
    if (!desired.has(h.key) || !columns.has(h.header)) fail('A reporting hold has an invalid target.');
    return cellKey(h.key, h.header);
  }));
  const diagnostics: FrontendPublicationDiagnostic[] = [], retainedDrafts: FrontendDraft[] = [];
  const finalRows = readRows.map(row => Object.fromEntries(headers.map(h => [h, row[h] ?? null])));
  const nextRows = new Map<string, FrontendPublicationRow>();
  const positions = new Map<string, number>(); readRows.forEach((r, i) => { if (id(r[table.keyHeader])) positions.set(r[table.keyHeader] as string, i); });
  const dirty = (row: Record<string, FrontendValue>, base: FrontendPublicationRow, header: string) => columns.get(header)!.editable && !base.readonlyHeaders?.includes(header) && (!equal(row[header], base.values[header]) || drafts.has(cellKey(base.key, header)));
  // Retire only verified clean rows; an unsent edit pins its row and identity.
  for (const [key, index] of positions) if (!desired.has(key)) {
    const row = readRows[index], base = baseline.get(key)!;
    if (current.headers.some(h => dirty(row, base, h))) {
      if (headers.length !== current.headers.length) fail('Resolve a retired row with pending edits before expanding its schema.');
      diagnostics.push({ code: 'retired-row-with-edit', key }); nextRows.set(key, clone(base));
      for (const h of current.headers) if (dirty(row, base, h)) retainedDrafts.push(clone(drafts.get(cellKey(key, h)) ?? { key, header: h, value: row[h], baseVersion: base.versions[h], ...(h.startsWith('event:') ? { expectedEventVersion: base.eventVersions![h] } : {}), ...(base.commandBindings?.[h] ? { command: base.commandBindings[h] } : {}) }));
    } else {
      if (current.headers.some(h => !equal(row[h], base.values[h]))) fail('Automation-only values changed outside the published baseline.');
      finalRows[index] = Object.fromEntries(headers.map(h => [h, null])); positions.delete(key);
    }
  }
  const growthRows = new Set<number>();
  for (const [key, server] of desired) {
    let index = positions.get(key); const existed = index !== undefined;
    if (index === undefined) {
      index = finalRows.findIndex(r => blank(r[table.keyHeader]));
      if (index < 0) { index = finalRows.length; finalRows.push(Object.fromEntries(headers.map(h => [h, null]))); }
      if (index >= MAX_ROWS) fail('Frontend row capacity exceeded.');
      positions.set(key, index); growthRows.add(index);
    }
    const base = baseline.get(key), local = existed ? readRows[index] : null;
    const readonlyHeaders = [...new Set([...(base?.readonlyHeaders ?? []), ...(server.readonlyHeaders ?? [])])];
    const next: FrontendPublicationRow = { key, values: {}, versions: {}, ...(table.kind === 'attendance' ? { eventVersions: {} } : {}),
      readonlyHeaders, commandBindings: Object.fromEntries(Object.entries(server.commandBindings ?? {}).filter(([h]) => !readonlyHeaders.includes(h))) };
    for (const header of headers) {
      const column = columns.get(header)!, serverValue = server.values[header], existingField = current.headers.includes(header);
      const canEdit = column.editable && !readonlyHeaders.includes(header);
      const draft = drafts.get(cellKey(key, header));
      if (holds.has(cellKey(key, header))) {
        if (!base || !existingField) fail('A new unresolved reporting cell cannot be initialized as an authoritative value.');
        diagnostics.push({ code: 'reporting-review', key, header });
        if (canEdit && (!equal(local![header], base.values[header]) || draft)) retainedDrafts.push(clone(draft ?? { key, header, value: local![header], baseVersion: base.versions[header], ...(header.startsWith('event:') ? { expectedEventVersion: base.eventVersions![header] } : {}), ...(base.commandBindings?.[header] ? { command: base.commandBindings[header] } : {}) }));
        next.values[header] = base?.values[header] ?? null;
        if (column.editable) next.versions[header] = base?.versions[header] ?? server.versions[header];
        if (base.commandBindings?.[header]) next.commandBindings![header] = clone(base.commandBindings[header]);
        if (header.startsWith('event:')) next.eventVersions![header] = base.eventVersions![header];
        continue;
      }
      if (base && existingField) {
        if (column.editable && (server.versions[header] < base.versions[header] || (server.versions[header] === base.versions[header] && !equal(serverValue, base.values[header])))) fail('Server field value/version is inconsistent with the last published base.');
        if (header.startsWith('event:') && server.eventVersions![header] < base.eventVersions![header]) fail('Event catalog version is stale.');
        const changedLocally = !equal(local![header], base.values[header]);
        if (!canEdit && changedLocally) fail('Automation-only values changed outside the published baseline.');
        if (canEdit && (changedLocally || draft)) {
          if (server.commandBindings?.[header] && !base.commandBindings?.[header]) fail('The original editable command binding is missing; reconcile the private baseline before submitting the edit.');
          const pending = draft ?? { key, header, baseVersion: base.versions[header], value: local![header], ...(header.startsWith('event:') ? { expectedEventVersion: base.eventVersions![header] } : {}), ...(base.commandBindings?.[header] ? { command: base.commandBindings[header] } : {}) };
          retainedDrafts.push(clone(pending));
          const sourceConflict = pending.command ? !same(server.commandBindings?.[header], pending.command) || !equal(serverValue, base.values[header]) : server.versions[header] !== pending.baseVersion;
          diagnostics.push({ code: sourceConflict || (header.startsWith('event:') && server.eventVersions![header] !== pending.expectedEventVersion) ? 'version-conflict' : draft ? 'pending-draft' : 'unsent-edit', key, header });
          if (draft && !equal(draft.value, local![header])) diagnostics.push({ code: 'draft-cell-changed', key, header });
          next.values[header] = base.values[header]; next.versions[header] = base.versions[header];
          if (base.commandBindings?.[header]) next.commandBindings![header] = clone(base.commandBindings[header]);
          if (header.startsWith('event:')) next.eventVersions![header] = base.eventVersions![header];
          continue;
        }
      }
      finalRows[index][header] = serverValue; next.values[header] = serverValue;
      if (column.editable) next.versions[header] = server.versions[header];
      if (header.startsWith('event:')) next.eventVersions![header] = server.eventVersions![header];
    }
    nextRows.set(key, next);
  }
  // Retain cleared tail rows inside the read-back extent. Shrinking/compacting is separate maintenance.
  if (!finalRows.length) finalRows.push(Object.fromEntries(headers.map(h => [h, null])));
  const endRow = finalRows.length + 2;
  const range = { sheetId: current.sheetId, startRowIndex: 1, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: headers.length };
  const requests: Record<string, unknown>[] = [];
  const expectedRows = finalRows.map((r, i) => headers.map((h, c) => {
    if (i < current.rows.length && c < current.headers.length && equal(r[h], readRows[i][h])) return clone(current.rows[i][c]);
    return frontendLiteralCell(r[h]);
  }));
  if (endRow > current.gridRowCount || headers.length > current.gridColumnCount) requests.push({ updateSheetProperties: { properties: { sheetId: current.sheetId, gridProperties: { rowCount: Math.max(endRow, current.gridRowCount), columnCount: Math.max(headers.length, current.gridColumnCount) } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
  let writes: { row: number; column: number; cell: NativeCellData; fields: string }[] = [];
  const write = (row: number, column: number, cell: NativeCellData, fileChip = false) => writes.push({ row, column, cell, fields: fileChip ? 'userEnteredValue,chipRuns' : 'userEnteredValue' });
  const flushWrites = () => {
    const spans: { row: number; start: number; fields: string; cells: NativeCellData[] }[] = [];
    for (const w of writes.sort((a, b) => a.row - b.row || a.column - b.column)) {
      const previous = spans.at(-1);
      if (previous && previous.row === w.row && previous.start + previous.cells.length === w.column && previous.fields === w.fields) previous.cells.push(w.cell);
      else spans.push({ row: w.row, start: w.column, fields: w.fields, cells: [w.cell] });
    }
    const rectangles: { row: number; start: number; fields: string; rows: NativeCellData[][] }[] = [];
    const open = new Map<string, typeof rectangles[number]>();
    for (const span of spans) {
      const key = `${span.start}:${span.cells.length}:${span.fields}`, previous = open.get(key);
      if (previous && previous.row + previous.rows.length === span.row && previous.rows.length < 32) previous.rows.push(span.cells);
      else { const rectangle = { row: span.row, start: span.start, fields: span.fields, rows: [span.cells] }; rectangles.push(rectangle); open.set(key, rectangle); }
    }
    const emit = (rectangle: typeof rectangles[number]) => {
      const request = { updateCells: { range: { sheetId: current.sheetId, startRowIndex: rectangle.row, endRowIndex: rectangle.row + rectangle.rows.length, startColumnIndex: rectangle.start, endColumnIndex: rectangle.start + rectangle.rows[0].length }, rows: rectangle.rows.map(values => ({ values })), fields: rectangle.fields } };
      if (bytes(request) + 16 > MAX_BATCH_BYTES && rectangle.rows.length > 1) {
        const middle = Math.ceil(rectangle.rows.length / 2);
        emit({ ...rectangle, rows: rectangle.rows.slice(0, middle) }); emit({ ...rectangle, row: rectangle.row + middle, rows: rectangle.rows.slice(middle) });
      } else requests.push(request);
    };
    rectangles.forEach(emit); writes = [];
  };
  headers.forEach((header, c) => {
    if (c >= current.headers.length) write(0, c, frontendLiteralCell(header));
    if (labels[c] !== current.labels[c]) write(1, c, frontendLiteralCell(labels[c]));
  });
  flushWrites();
  const resize = () => requests.push({ updateTable: { table: { tableId: current.tableId, range }, fields: 'range' } });
  if (!same(range, current.range)) resize();
  let changedCells = 0;
  const writeRows = Math.max(finalRows.length, current.rows.length);
  for (let r = 0; r < writeRows; r++) for (let c = 0; c < headers.length; c++) {
    const h = headers[c], before = readRows[r]?.[h] ?? null, after = finalRows[r]?.[h] ?? null;
    if (!equal(before, after)) { write(r + 2, c, frontendLiteralCell(after), columns.get(h)!.fileChip); changedCells++; }
  }
  flushWrites();
  const seeds = new Map(input.seeds.map(s => [s.key, s]));
  if (seeds.size !== input.seeds.length) fail('Native validation seed identity is ambiguous.');
  let copiedValidationRanges = 0;
  const validationExpectations: FrontendValidationExpectation[] = [];
  for (let c = 0; c < headers.length; c++) {
    const column = columns.get(headers[c])!;
    if (!column.seedKey) continue;
    const destinationRows = c >= current.headers.length ? finalRows.map((_, i) => i) : [...growthRows].filter(i => i < finalRows.length);
    if (!destinationRows.length) continue;
    const seed = seeds.get(column.seedKey);
    if (!seed || !seed.protected || !seed.hidden || !seed.nativeStyleVersion || !integer(seed.sheetId, 0, 2147483647) || seed.sheetId === current.sheetId || !integer(seed.rowIndex, 2, 10_001) || !integer(seed.columnIndex, 0, 511) || !same(normalizeRule(seed.expectedRule), normalizeRule(seed.observedRule))) fail('A fresh protected native validation seed is required for growth.');
    destinationRows.sort((a, b) => a - b);
    const blocks: { start: number; end: number }[] = [];
    for (const r of destinationRows) { const previous = blocks.at(-1); if (previous?.end === r) previous.end++; else blocks.push({ start: r, end: r + 1 }); }
    for (const block of blocks) {
      validationExpectations.push({ sheetId: current.sheetId, startRowIndex: block.start + 2, endRowIndex: block.end + 2, startColumnIndex: c, endColumnIndex: c + 1, expectedRule: clone(seed.expectedRule) });
      requests.push({ copyPaste: { source: { sheetId: seed.sheetId, startRowIndex: seed.rowIndex, endRowIndex: seed.rowIndex + 1, startColumnIndex: seed.columnIndex, endColumnIndex: seed.columnIndex + 1 },
        destination: { sheetId: current.sheetId, startRowIndex: block.start + 2, endRowIndex: block.end + 2, startColumnIndex: c, endColumnIndex: c + 1 }, pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL' } });
      copiedValidationRanges++;
    }
  }
  // Validation copying may auto-expand a Table. Reassert only its range, never its column metadata.
  if (copiedValidationRanges) resize();
  if (table.kind === 'attendance') requests.push(...buildAttendanceGrowthLayout({ sheetId: current.sheetId,
    headers, labels, eventHeaders: table.columns.filter(c => c.header.startsWith('event:')).map(c => c.header), dataEndRow: endRow },
  current.headers, current.range.endRowIndex));
  const keyColumn = headers.indexOf(table.keyHeader);
  if (!current.hiddenColumns.includes(keyColumn)) requests.push({ updateDimensionProperties: { range: { sheetId: current.sheetId, dimension: 'COLUMNS', startIndex: keyColumn, endIndex: keyColumn + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  if (!current.machineRowHidden) requests.push({ updateDimensionProperties: { range: { sheetId: current.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  const batches = batchRequests(requests);
  const nextBaseline = { generation: input.generation, revision: clone(input.revision), rows: [...nextRows.values()].map(clone) };
  const expectedAfter: FrontendTableRead = { ...clone(current), headers, labels, rows: expectedRows, range,
    gridRowCount: Math.max(current.gridRowCount, endRow), gridColumnCount: Math.max(current.gridColumnCount, headers.length),
    hiddenColumns: [...new Set([...current.hiddenColumns, keyColumn])].sort((a, b) => a - b), machineRowHidden: true };
  return { requests, batches, diagnostics, complete: diagnostics.length === 0, nextBaseline, retainedDrafts,
    expectedRead: canonical(current), expectedAfter, changedCells, copiedValidationRanges, validationExpectations, requiresVerifiedReadback: true };
}

/** Read only the copied intervals; every destination cell must retain the reviewed public rule. */
export function verifyFrontendValidationReadback(plan: Pick<FrontendPublicationPlan, 'validationExpectations'>, observations: readonly FrontendValidationRead[]): boolean {
  if (!Array.isArray(observations) || observations.length !== plan.validationExpectations.length) return false;
  const rangeKey = (r: Omit<FrontendValidationExpectation, 'expectedRule'>) => JSON.stringify([r.sheetId, r.startRowIndex, r.endRowIndex, r.startColumnIndex, r.endColumnIndex]);
  const found = new Map((observations as readonly FrontendValidationRead[]).map(r => [rangeKey(r), r]));
  if (found.size !== observations.length) return false;
  try {
    for (const expected of plan.validationExpectations) {
      const actual = found.get(rangeKey(expected));
      if (!actual || actual.rows.length !== expected.endRowIndex - expected.startRowIndex || actual.rows.some(row => row.length !== expected.endColumnIndex - expected.startColumnIndex)) return false;
      const normalized = normalizeRule(expected.expectedRule);
      if (!actual.rows.every(row => row.every(rule => same(normalizeRule(rule), normalized)))) return false;
    }
    return true;
  } catch { return false; }
}

/** Re-read under the same verified edit fence immediately before the atomic write. */
export function assertFrontendPublicationPreconditions(plan: FrontendPublicationPlan, current: FrontendTableRead): void {
  if (canonical(current) !== plan.expectedRead) fail('Frontend changed after planning; discard the plan and read again.');
}

/** Private exact-read binding, not an authorization token or a cryptographic digest. */
export function frontendReadFingerprint(current: FrontendTableRead): string { return canonical(current); }

/** Call only after authenticating a committed command receipt. Equality with a server cell is not a receipt. */
export function applyFrontendReceipt(input: {
  baseline: FrontendPublicationBaseline;
  drafts: readonly FrontendDraft[];
  draft: FrontendDraft;
  receiptVerified: boolean;
  receipt: { key: string; header: string; baseVersion: number; committedVersion: number; value: FrontendValue; expectedEventVersion?: number;
    command?: FrontendEditBinding & { committedVersion: number } };
}): { baseline: FrontendPublicationBaseline; drafts: FrontendDraft[] } {
  const { draft, receipt } = input;
  const matches = input.drafts.filter(d => d.key === draft.key && d.header === draft.header);
  if (!input.receiptVerified || matches.length !== 1 || !same(matches[0], draft) || receipt.key !== draft.key || receipt.header !== draft.header || receipt.baseVersion !== draft.baseVersion || !integer(receipt.committedVersion, draft.baseVersion + 1) || !equal(value(receipt.value), value(draft.value)) || receipt.expectedEventVersion !== draft.expectedEventVersion) fail('The verified receipt does not match the exact frozen frontend draft.');
  if (draft.command) {
    if (!receipt.command) fail('The command receipt binding is missing.');
    const { committedVersion, ...binding } = receipt.command;
    if (!same(binding, draft.command) || !integer(committedVersion, draft.command.expectedVersion + 1)) fail('The command receipt does not match the frozen command version.');
  } else if (receipt.command) fail('An unexpected command binding was supplied.');
  const baseline = clone(input.baseline), rows = baseline.rows.filter(r => r.key === draft.key);
  if (rows.length !== 1 || rows[0].versions[draft.header] !== draft.baseVersion || (draft.header.startsWith('event:') && rows[0].eventVersions?.[draft.header] !== draft.expectedEventVersion)) fail('The frozen draft no longer matches its private baseline.');
  rows[0].values[draft.header] = clone(receipt.value); rows[0].versions[draft.header] = receipt.committedVersion;
  if (draft.command && receipt.command) rows[0].commandBindings![draft.header] = { ...clone(draft.command), expectedVersion: receipt.command.committedVersion };
  return { baseline, drafts: input.drafts.filter(d => d !== matches[0]).map(clone) };
}

/** Initialize only an empty native Table, or an explicitly reviewed fictional reset target. */
export function planFrontendInitialization(input: {
  generation: number;
  revision: SnapshotRevision;
  table: FrontendPublicationTable;
  current: FrontendTableRead;
  seeds: readonly FrontendValidationSeed[];
  editFenceVerified: boolean;
  reviewedFictionalReset?: { environment: 'local' | 'staging'; generation: number; sheetId: number; tableId: string; expectedRead: string };
}): FrontendPublicationPlan {
  const { current, table } = input;
  if (!Array.isArray(current.rows) || current.rows.length > MAX_ROWS || current.headers.length > MAX_COLUMNS || current.rows.some(r => r.length !== current.headers.length) || current.range.endRowIndex !== current.rows.length + 2 || current.range.endColumnIndex !== current.headers.length) fail('Initialization requires an exact bounded Table read.');
  const nonempty = current.rows.some(row => row.some(c => !blank(readValue(c, { header: 'initial', label: 'Initial', editable: false, fileChip: true }))));
  if (nonempty) {
    const consent = input.reviewedFictionalReset;
    if (!consent || !['local', 'staging'].includes(consent.environment) || consent.generation !== input.generation || consent.sheetId !== current.sheetId || consent.tableId !== current.tableId || consent.expectedRead !== frontendReadFingerprint(current)) fail('A populated Table requires an explicit, freshly reviewed fictional reset binding.');
  }
  const headers = table.columns.map(c => c.header), labels = table.columns.map(c => c.label);
  const width = Math.max(current.headers.length, headers.length), rowCount = Math.max(1, current.rows.length);
  const virtual: FrontendTableRead = { ...clone(current), headers, labels, gridRowCount: Math.max(current.gridRowCount, rowCount + 2), gridColumnCount: Math.max(current.gridColumnCount, width),
    rows: Array.from({ length: rowCount }, () => headers.map(() => ({}))),
    // A reviewed reset clears values, not physical visibility (for example, Attendance Year/Flight/Squadron).
    hiddenColumns: current.hiddenColumns.filter(c => c < headers.length),
    range: { sheetId: current.sheetId, startRowIndex: 1, endRowIndex: rowCount + 2, startColumnIndex: 0, endColumnIndex: headers.length } };
  const plan = planFrontendPublication({ ...input, current: virtual, baseline: { generation: input.generation, revision: input.revision, rows: [] }, drafts: [] });
  const prefix: Record<string, unknown>[] = [];
  if (virtual.gridColumnCount !== current.gridColumnCount || virtual.gridRowCount !== current.gridRowCount) prefix.push({ updateSheetProperties: { properties: { sheetId: current.sheetId, gridProperties: { rowCount: virtual.gridRowCount, columnCount: virtual.gridColumnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
  // Clearing explicitly includes chipRuns so an old file chip cannot survive a blank reset.
  prefix.push({ updateCells: { range: { sheetId: current.sheetId, startRowIndex: 0, endRowIndex: rowCount + 2, startColumnIndex: 0, endColumnIndex: width }, rows: [], fields: 'userEnteredValue,chipRuns' } });
  prefix.push({ updateCells: { range: { sheetId: current.sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: headers.length }, rows: [headers, labels].map(row => ({ values: row.map(frontendLiteralCell) })), fields: 'userEnteredValue' } });
  prefix.push({ updateTable: { table: { tableId: current.tableId, range: virtual.range }, fields: 'range' } });
  plan.requests = [...prefix, ...plan.requests]; plan.batches = batchRequests(plan.requests); plan.expectedRead = frontendReadFingerprint(current);
  return plan;
}

/** Normalize one coherent D1 snapshot without inventing historical membership or eligibility. */
export function snapshotToFrontendReportingInput(snapshot: FrontendSnapshot, asOfDate: string): FrontendReportingInput {
  const currents = snapshot.terms.filter(t => t.isCurrent);
  if (currents.length !== 1) fail('The frontend needs exactly one current term.');
  const people = snapshot.people.map(p => ({ personId: p.personId, lastName: p.lastName, firstName: p.firstName,
    asYear: p.asYear, flightId: p.flightId, flightPathStatus: p.active ? p.flightPathStatus : 'Inactive', dateOfBirth: p.dateOfBirth }));
  const flights = snapshot.flights.map(f => {
    if (!f.squadronId) fail('Flight-to-squadron catalog mapping needs repair.');
    return { flightId: f.flightId, label: f.label, squadronId: f.squadronId };
  });
  return { policyVersion: REPORTING_POLICY_VERSION, asOfDate, currentTermId: currents[0].termId,
    people, flights, squadrons: clone(snapshot.squadrons),
    terms: snapshot.terms.map(t => ({ termId: t.termId, label: t.label, sortOrder: t.sortOrder,
      ...(!t.isCurrent && t.roster ? { roster: clone(t.roster) } : {}) })),
    events: snapshot.events.map(e => ({ eventId: e.eventId, termId: e.termId, label: e.columnLabel || e.label, type: e.eventType, trainingWeek: e.trainingWeek, displayOrder: e.displayOrder,
      eligiblePersonIds: clone((e as typeof e & { eligiblePersonIds?: string[] | null }).eligiblePersonIds ?? null) })),
    observations: clone(snapshot.observations), corrections: clone(snapshot.corrections),
    requests: snapshot.requests.map(r => ({ requestId: r.requestId, personId: r.personId, eventId: r.eventId, order: r.order, status: r.status as ExcusalStatus, requestedOutcome: r.requestedOutcome as RequestedOutcome })),
  };
}

/** Value/identity/Table verification only. Native option appearance and permissions need their own checks. */
export function verifyFrontendPublicationReadback(plan: FrontendPublicationPlan, actual: FrontendTableRead): boolean {
  const expected = plan.expectedAfter;
  if (actual.sheetId !== expected.sheetId || actual.tableId !== expected.tableId || !same(actual.range, expected.range) || !same(actual.headers, expected.headers) || !same(actual.labels, expected.labels) || actual.rows.length !== expected.rows.length || !actual.machineRowHidden || expected.hiddenColumns.some(c => !actual.hiddenColumns.includes(c))) return false;
  try {
    return actual.rows.every((row, r) => row.length === expected.headers.length && row.every((cell, c) => {
      const column: FrontendColumn = { header: expected.headers[c], label: expected.labels[c], editable: false, fileChip: !!expected.rows[r][c].chipRuns?.length };
      return equal(readValue(cell, column), readValue(expected.rows[r][c], column));
    }));
  } catch { return false; }
}

const DIRECTORY = [
  ['last_name', 'Last Name', 'lastName'], ['first_name', 'First Name', 'firstName'], ['as_year', 'Year', 'asYear'],
  ['flight', 'Flight', 'flight'], ['squadron', 'Sqdn', 'squadron'], ['rank', 'Rank', 'rank'], ['role', 'Role', 'role'],
  ['university', 'University', 'university'], ['email', 'Email', 'email'], ['phone', 'Phone Number', 'phone'],
  ['dorm', 'Dorm', 'dorm'], ['cip_broad_area', 'CIP Broad Area', 'cipBroadArea'], ['cip_code', 'CIP', 'cipCode'],
  ['desired_assigned_afsc', 'Desired / Assigned AFSC', 'afsc'], ['home_town', 'Home Town', 'homeTown'], ['home_state', 'Home State', 'homeState'],
  ['class_year', 'Class', 'classYear'], ['dob', 'DOB', 'dateOfBirth'], ['flight_path_status', 'Flight Path', 'flightPathStatus'], ['photo_link', 'Photo Link', 'photoLink'],
] as const;
const LEADERSHIP = [
  ['last_name', 'Last Name', 'lastName'], ['first_name', 'First Name', 'firstName'], ['rank', 'Rank', 'rank'], ['role', 'Role', 'role'], ['reports_to', 'Reports To', 'reportsTo'],
  ['email', 'Email', 'email'], ['cell_phone', 'Cell Phone', 'cellPhone'], ['office_phone', 'Office Phone', 'officePhone'], ['office_location', 'Office Location', 'officeLocation'],
] as const;
const DIRECTORY_VALIDATED = new Set(['as_year', 'flight', 'squadron', 'rank', 'university', 'dorm', 'cip_broad_area', 'desired_assigned_afsc', 'home_state', 'flight_path_status']);
function photoValue(uri: string): FrontendValue {
  if (!uri) return null;
  return /^https:\/\/(?:drive|docs)\.google\.com\//i.test(uri) ? value({ fileUri: uri }) : value(uri);
}

/** Map one coherent domain snapshot to ordinary Directory/Leadership/Attendance tables. */
export function buildFrontendPublicationModel(input: {
  snapshot: FrontendSnapshot;
  reporting: { revision: SnapshotRevision; result: ReturnType<typeof buildFrontendReporting> };
  /** Actual attendance record versions from the same snapshot; never inferred from fact order. */
  attendanceVersions: readonly { personId: string; eventId: string; version: number }[];
}): FrontendPublicationModel {
  const { snapshot } = input;
  revision(snapshot.revision);
  if (!same(snapshot.revision, input.reporting.revision)) fail('Reporting and profile snapshots have different committed revisions.');
  const report = input.reporting.result;
  if (report.scope.kind !== 'wing') fail('The full workbook publisher requires an authorized wing-scoped snapshot.');
  const matrix: ReportingMatrix | undefined = report.matrices.find(m => m.termId === report.currentTermId);
  if (!matrix) fail('Current attendance matrix is missing.');
  const flights = new Map(snapshot.flights.map(f => [f.flightId, f])), squadrons = new Map(snapshot.squadrons.map(s => [s.squadronId, s]));
  const columns = (fields: readonly (readonly [string, string, string])[], edits: readonly string[], seeds: Set<string>): FrontendColumn[] => fields.map(([header, label]) => ({ header, label, editable: edits.includes(header), ...(seeds.has(header) ? { seedKey: `directory:${header}` } : {}), ...(header === 'photo_link' ? { fileChip: true } : {}) }));
  const directoryColumns = [...columns(DIRECTORY, DIRECTORY_EDIT_FIELDS, DIRECTORY_VALIDATED), { header: 'person_id', label: 'Person ID', editable: false }];
  const directory: FrontendPublicationTable = { kind: 'directory', keyHeader: 'person_id', columns: directoryColumns,
    rows: snapshot.people.filter(p => p.active).map(p => {
      const flight = p.flightId ? flights.get(p.flightId) : null, squadron = flight?.squadronId ? squadrons.get(flight.squadronId) : null;
      const profile = { ...p, flight: flight?.label ?? '', squadron: squadron?.label ?? '' };
      const values = Object.fromEntries(DIRECTORY.map(([header, _label, field]) => [header, header === 'photo_link' ? photoValue(p.photoLink) : header === 'dob' ? (p.dateOfBirth === null ? null : (Date.parse(`${p.dateOfBirth}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000) : profile[field] as FrontendValue]));
      values.person_id = p.personId;
      return { key: p.personId, values, versions: Object.fromEntries(directoryColumns.filter(c => c.editable).map(c => [c.header, p.version])),
        readonlyHeaders: ['squadron'],
        commandBindings: Object.fromEntries(DIRECTORY.filter(([header]) => header !== 'squadron' && (DIRECTORY_EDIT_FIELDS as readonly string[]).includes(header)).map(([header, _label, field]) => [header, { operation: 'directory.upsert' as const, entityId: p.personId, field: header === 'flight' ? 'flightId' : field, expectedVersion: p.version }])) };
    }) };
  const leadershipColumns = [...columns(LEADERSHIP, LEADERSHIP_EDIT_FIELDS, new Set()), { header: 'contact_id', label: 'Contact ID', editable: false }];
  leadershipColumns.find(c => c.header === 'rank')!.seedKey = 'leadership:rank';
  const leadership: FrontendPublicationTable = { kind: 'leadership', keyHeader: 'contact_id', columns: leadershipColumns,
    rows: snapshot.leadership.filter(p => p.active).map(p => ({ key: p.contactId,
      values: { ...Object.fromEntries(LEADERSHIP.map(([header, _label, field]) => [header, p[field]])), contact_id: p.contactId },
      versions: Object.fromEntries(leadershipColumns.filter(c => c.editable).map(c => [c.header, p.publicationVersion])),
      readonlyHeaders: p.personId ? ['last_name', 'first_name', 'rank', 'role', 'email', 'cell_phone'] : [],
      commandBindings: Object.fromEntries(LEADERSHIP.filter(([header]) => !p.personId || ['reports_to', 'office_phone', 'office_location'].includes(header)).map(([header, _label, field]) => [header, { operation: 'leadership.upsert' as const, entityId: p.contactId, field, expectedVersion: p.contactVersion }])),
    })) };
  const versions = new Map<string, number>();
  for (const v of input.attendanceVersions) {
    const key = JSON.stringify([v.personId, v.eventId]); if (!id(v.personId) || !id(v.eventId) || !integer(v.version) || versions.has(key)) fail('Attendance record versions are missing or ambiguous.'); versions.set(key, v.version);
  }
  const fixed = [['last_name', 'Last Name'], ['first_name', 'First Name'], ['as_year', 'Year'], ['flight', 'Flight'], ['squadron', 'Sqdn'], ['overall_attendance_pct', 'Overall'], ['llab_attendance_pct', 'LLAB']];
  const attendance: FrontendPublicationTable = { kind: 'attendance', keyHeader: 'person_id',
    columns: [...fixed.map(([header, label]) => ({ header, label, editable: false })), ...matrix.eventColumns.map(e => ({ header: e.machineHeader, label: e.label, editable: true, seedKey: 'attendance:code' })), { header: 'person_id', label: 'Person ID', editable: false }], rows: [], holds: [] };
  for (const r of matrix.rows) {
    const values: Record<string, FrontendValue> = { last_name: r.lastName, first_name: r.firstName, as_year: r.asYear, flight: r.flight, squadron: r.squadron, overall_attendance_pct: r.overall.percentage, llab_attendance_pct: r.llab.percentage, person_id: r.personId };
    const rowVersions: Record<string, number> = {}, eventVersions: Record<string, number> = {};
    for (const c of r.cells) {
      const header = matrix.eventColumns.find(e => e.eventId === c.eventId)!.machineHeader, version = versions.get(JSON.stringify([r.personId, c.eventId]));
      if (version === undefined) fail('Every attendance input cell needs its actual record version.');
      values[header] = c.effectiveCode; rowVersions[header] = version;
      const eventVersion = snapshot.events.find(e => e.eventId === c.eventId)?.version;
      if (!integer(eventVersion, 1)) fail('Attendance event catalog version is missing.'); eventVersions[header] = eventVersion;
      if (c.needsReview) attendance.holds!.push({ key: r.personId, header, reason: 'reporting-review' });
    }
    if (r.cells.some(c => c.needsReview)) for (const header of ['overall_attendance_pct', 'llab_attendance_pct']) attendance.holds!.push({ key: r.personId, header, reason: 'reporting-review' });
    attendance.rows.push({ key: r.personId, values, versions: rowVersions, eventVersions,
      commandBindings: Object.fromEntries(r.cells.map(c => [`event:${c.eventId}`, { operation: 'attendance.correct' as const, entityId: r.personId, field: c.eventId, expectedVersion: rowVersions[`event:${c.eventId}`] }])) });
  }
  return { generation: snapshot.generation, revision: clone(snapshot.revision), tables: [directory, leadership, attendance] };
}
