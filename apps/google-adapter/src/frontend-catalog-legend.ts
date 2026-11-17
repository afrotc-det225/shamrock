/** Literal catalog publication around reviewed native validation controls. No chip metadata is invented. */
import { AdapterError } from './index.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import type { FrontendPublicationPlan, FrontendTableRead, FrontendValidationSeed } from './frontend-publication.js';
import { normalizeFrontendValidationRule } from './frontend-publication.js';

type Field = 'flight' | 'squadron';
type Range = { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
type Seed = Pick<FrontendValidationSeed, 'key' | 'sheetId' | 'rowIndex' | 'columnIndex' | 'expectedRule'>;
export interface CatalogLegendBinding { field: Field; title: string; range: Range }
export interface CatalogLegendRead {
  columns: (CatalogLegendBinding & { values: string[] })[];
  tables: { sheetId: number; tableId: string; fields: { columnIndex: number; field: Field }[]; columnProperties: Record<string, any>[] }[];
}
export interface CatalogLegendPlan {
  requests: Record<string, unknown>[];
  expectedBefore: CatalogLegendRead;
  expectedAfter: CatalogLegendRead;
}
const fields: Field[] = ['flight', 'squadron'];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const canonical = (x: unknown): string => JSON.stringify(x, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const natural = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
function fail(message: string): never { throw new AdapterError('frontend_catalog_legend', message); }
const columnIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const intersects = (a: Range, b: any) => a.sheetId === b.sheetId && a.startRowIndex < (b.endRowIndex ?? Infinity)
  && a.endRowIndex > (b.startRowIndex ?? 0) && a.startColumnIndex < (b.endColumnIndex ?? Infinity) && a.endColumnIndex > (b.startColumnIndex ?? 0);

/** Both source columns come from existing reviewed ONE_OF_RANGE seeds. The source
 * sheet remains hidden and under the host's verified whole-sheet protection. */
export function catalogLegendBindings(seeds: readonly Seed[], metadata: Record<string, any>, businessSheetIds: readonly number[]): CatalogLegendBinding[] {
  const selected = seeds.filter(s => fields.some(f => s.key === `directory:${f}`));
  if (!selected.length) return [];
  if (selected.length !== 2 || fields.some(f => selected.filter(s => s.key === `directory:${f}`).length !== 1)) fail('Flight and Squadron require one reviewed native seed each.');
  return fields.map(field => {
    const seed = selected.find(s => s.key === `directory:${field}`)!, rule = seed.expectedRule as any;
    const text = rule?.condition?.values?.[0]?.userEnteredValue;
    const match = typeof text === 'string' && /^=?'((?:[^']|'')+)'!\$([A-Z]{1,3})\$([1-9][0-9]*):\$([A-Z]{1,3})(?:\$([1-9][0-9]*))?$/.exec(text);
    if (!match || rule.strict !== true || rule.condition.type !== 'ONE_OF_RANGE' || rule.condition.values.length !== 1 || match[2] !== match[4]) fail('Catalog choices require a reviewed absolute single-column source range.');
    const title = match[1].replace(/''/g, "'"), sheets = (metadata.sheets ?? []).filter((s: any) => s.properties?.title === title);
    const sheet = sheets[0], grid = sheet?.properties?.gridProperties;
    const startRowIndex = Number(match[3]) - 1, endRowIndex = match[5] ? Number(match[5]) : grid?.rowCount, startColumnIndex = columnIndex(match[2]);
    if (sheets.length !== 1 || !natural(sheet.properties.sheetId) || businessSheetIds.includes(sheet.properties.sheetId) || sheet.properties.hidden !== true
      || !natural(grid?.rowCount) || grid.rowCount > 10002 || !natural(endRowIndex) || endRowIndex > grid.rowCount || startRowIndex < 2 || endRowIndex <= startRowIndex
      || !natural(grid?.columnCount) || startColumnIndex >= grid.columnCount || startColumnIndex >= 512) fail('The protected hidden catalog source is missing or exceeds its bounds.');
    const range = { sheetId: sheet.properties.sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex: startColumnIndex + 1 };
    if ((sheet.merges ?? []).some((r: any) => intersects(range, r)) || seeds.some(s => s.sheetId === range.sheetId && s.columnIndex === startColumnIndex && s.rowIndex >= startRowIndex && s.rowIndex < endRowIndex)) fail('Catalog source values must not overlap merged cells or native validation seeds.');
    return { field, title, range };
  }).map((binding, i, all) => { if (all.some((other, j) => i !== j && intersects(binding.range, other.range))) fail('Flight and Squadron catalog columns overlap.'); return binding; });
}

/** Reads every owned source cell, including the trailing tail, so removed choices
 * cannot survive unnoticed. Only literal text is an acceptable legend value. */
export function readCatalogLegend(input: {
  seeds: readonly Seed[]; metadata: Record<string, any>; tables: readonly FrontendTableRead[];
  businessSheetIds: readonly number[];
  readCells(bindings: readonly CatalogLegendBinding[]): { sheets?: Record<string, any>[] };
}): CatalogLegendRead {
  const bindings = catalogLegendBindings(input.seeds, input.metadata, input.businessSheetIds);
  if (!bindings.length) return { columns: [], tables: [] };
  const data = input.readCells(bindings);
  const columns = bindings.map(binding => {
    const { range } = binding, sheet = data.sheets?.find(s => s.properties?.sheetId === range.sheetId);
    const block = sheet?.data?.find((d: any) => (d.startRow ?? 0) === range.startRowIndex && (d.startColumn ?? 0) === range.startColumnIndex);
    if (!block) fail('Google omitted a catalog source range.');
    const values = Array.from({ length: range.endRowIndex - range.startRowIndex }, (_, i) => {
      const cell = block.rowData?.[i]?.values?.[0] ?? {}, entered = cell.userEnteredValue ?? {};
      if (cell.chipRuns?.length || Object.keys(entered).some(k => k !== 'stringValue') || entered.stringValue !== undefined && (typeof entered.stringValue !== 'string' || entered.stringValue.length > 80 || /[\u0000-\u001f]/.test(entered.stringValue))) fail('Catalog sources require bounded literal labels, without formulas or file chips.');
      return entered.stringValue ?? '';
    });
    while (values.length && values.at(-1) === '') values.pop();
    return { ...binding, values };
  });
  const tables: CatalogLegendRead['tables'] = [];
  for (const sheet of input.metadata.sheets ?? []) for (const table of sheet.tables ?? []) {
    const surface = input.tables.find(t => t.sheetId === sheet.properties.sheetId && t.tableId === table.tableId);
    const owned = bindings.filter(b => intersects(b.range, table.range));
    if (!surface && !owned.length) continue;
    const selected = fields.flatMap(field => {
      const index = surface ? surface.headers.indexOf(field) : owned.find(b => b.field === field)?.range.startColumnIndex;
      if (index === undefined || index < 0) return [];
      const properties = (table.columnProperties ?? []).filter((p: any) => (p.columnIndex ?? 0) === index);
      if (properties.length > 1) fail('A catalog Table column has duplicate metadata.');
      const p = properties[0];
      if (!p || !p.columnType || ['TEXT', 'COLUMN_TYPE_UNSPECIFIED'].includes(p.columnType)) return [];
      if (p.columnType !== 'DROPDOWN') fail('A managed catalog Table column must retain its existing text or dropdown type.');
      if (p.dataValidationRule?.condition?.type !== 'ONE_OF_LIST' || !Array.isArray(p.dataValidationRule.condition.values)) fail('A native catalog dropdown requires its existing explicit Table choices.');
      return [{ columnIndex: index, field }];
    });
    if (selected.length) {
      if (typeof table.tableId !== 'string' || !Array.isArray(table.columnProperties) || table.columnProperties.length > 160) fail('Catalog Table metadata exceeds its bound.');
      tables.push({ sheetId: sheet.properties.sheetId, tableId: table.tableId, fields: selected, columnProperties: clone(table.columnProperties) });
    }
  }
  if (tables.length > 5) fail('Too many native Tables use the managed catalog.');
  return { columns, tables };
}

export function planCatalogLegend(snapshot: Pick<FrontendSnapshot, 'flights' | 'squadrons'>, before: CatalogLegendRead): CatalogLegendPlan {
  const labels = (values: { label: string }[], max: number) => {
    if (!Array.isArray(values) || values.length > max || values.some(v => typeof v.label !== 'string' || !v.label.trim() || v.label.length > 80 || /[\u0000-\u001f]/.test(v.label))) fail('The current organizational catalog exceeds its reviewed bounds.');
    const names = values.map(v => v.label).sort((a, b) => a.localeCompare(b));
    if (new Set(names.map(s => s.trim().toLowerCase())).size !== names.length) fail('Organizational catalog labels are ambiguous.');
    return names;
  };
  if (!before.columns.length) return { requests: [], expectedBefore: clone(before), expectedAfter: clone(before) };
  const desired = { flight: labels(snapshot.flights, 50), squadron: labels(snapshot.squadrons, 20) }, after = clone(before), requests: Record<string, unknown>[] = [];
  for (const column of after.columns) {
    const values = desired[column.field], previous = before.columns.find(c => c.field === column.field)!;
    if (values.length > column.range.endRowIndex - column.range.startRowIndex) fail('The reviewed Data Legend range cannot hold the current catalog.');
    column.values = [...values];
    if (same(previous.values, values)) continue;
    const count = Math.max(1, previous.values.length, values.length);
    requests.push({ updateCells: { range: { ...column.range, endRowIndex: column.range.startRowIndex + count },
      rows: Array.from({ length: count }, (_, i) => ({ values: [i < values.length ? { userEnteredValue: { stringValue: values[i] } } : {}] })), fields: 'userEnteredValue' } });
  }
  for (const table of after.tables) {
    for (const field of table.fields) {
      const p = table.columnProperties.find(p => (p.columnIndex ?? 0) === field.columnIndex)!;
      p.dataValidationRule.condition.values = desired[field.field].map(userEnteredValue => ({ userEnteredValue }));
    }
    if (!same(table, before.tables.find(t => t.tableId === table.tableId))) requests.push({ updateTable: { table: { tableId: table.tableId, columnProperties: clone(table.columnProperties) }, fields: 'columnProperties' } });
  }
  return { requests, expectedBefore: clone(before), expectedAfter: after };
}
export function catalogLegendMatches(plan: CatalogLegendPlan, read: CatalogLegendRead, phase: 'before' | 'after'): boolean {
  if (phase === 'before') return same(read, plan.expectedBefore);
  const expected = plan.expectedAfter;
  if (!same(read.columns, expected.columns) || read.tables.length !== expected.tables.length) return false;
  return expected.tables.every(table => {
    const observed = read.tables.find(t => t.sheetId === table.sheetId && t.tableId === table.tableId);
    if (!observed || !same(observed.fields, table.fields)) return false;
    // Main publication separately verifies header labels and Table growth. Google
    // may reflect those changes here; existing noncatalog column types/rules must stay intact.
    return table.columnProperties.every(column => {
      const actual = observed.columnProperties.filter(p => (p.columnIndex ?? 0) === (column.columnIndex ?? 0));
      if (actual.length !== 1) return false;
      if (table.fields.some(f => f.columnIndex === (column.columnIndex ?? 0))) return same(actual[0], column);
      const { columnName: _expectedName, ...properties } = column, { columnName: _actualName, ...actualProperties } = actual[0];
      return same(actualProperties, properties);
    });
  });
}
export function assertCatalogLegendPlan(plan: CatalogLegendPlan): void {
  const labels = (field: Field) => (plan.expectedAfter.columns.find(c => c.field === field)?.values ?? []).map(label => ({ label }));
  const derived = planCatalogLegend({ flights: labels('flight'), squadrons: labels('squadron') } as Pick<FrontendSnapshot, 'flights' | 'squadrons'>, plan.expectedBefore);
  if (!same(plan, derived)) fail('Retained catalog writes differ from their literal reviewed plan.');
}

/** Re-copy the existing native controls when their choices change. Google retains
 * opaque chip colors and display mode; text/plain columns are never converted. */
export function refreshCatalogValidation(plan: CatalogLegendPlan, publication: FrontendPublicationPlan, seeds: readonly FrontendValidationSeed[]): void {
  const initialCopies = publication.copiedValidationRanges;
  for (const field of fields) {
    const before = plan.expectedBefore.columns.find(c => c.field === field), after = plan.expectedAfter.columns.find(c => c.field === field);
    if (!before || !after || same(before.values, after.values)) continue;
    const seed = seeds.find(s => s.key === `directory:${field}`);
    if (!seed || !seed.hidden || !seed.protected || !seed.nativeStyleVersion
      || !same(normalizeFrontendValidationRule(seed.expectedRule), normalizeFrontendValidationRule(seed.observedRule))) fail('Changed catalog choices require their fresh protected native control.');
    // Directory owns these editable controls; readonly Attendance labels stay readonly.
    const table = publication.expectedAfter, column = table.headers.indexOf(field), range = { sheetId: table.sheetId, startRowIndex: 2, endRowIndex: table.range.endRowIndex, startColumnIndex: column, endColumnIndex: column + 1 };
    if (column < 0) fail('The Directory native Table is missing its catalog controls.');
    if (range.endRowIndex <= 2) continue;
    const request = { copyPaste: { source: { sheetId: seed.sheetId, startRowIndex: seed.rowIndex, endRowIndex: seed.rowIndex + 1, startColumnIndex: seed.columnIndex, endColumnIndex: seed.columnIndex + 1 }, destination: range, pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL' } };
    publication.requests.push(request); publication.batches.push([clone(request)]);
    publication.validationExpectations.push({ ...range, expectedRule: clone(seed.expectedRule) });
    publication.copiedValidationRanges++;
  }
  if (publication.copiedValidationRanges !== initialCopies) {
    const request = { updateTable: { table: { tableId: publication.expectedAfter.tableId, range: clone(publication.expectedAfter.range) }, fields: 'range' } };
    publication.requests.push(request); publication.batches.push([clone(request)]);
  }
}
