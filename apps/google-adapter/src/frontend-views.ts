/** Managed Flight filter views follow native Tables and equality criteria as the roster grows. */
export type NativeFilterView = Record<string, any>;
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const canonical = (x: unknown): string => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function fail(): never { throw Error('INVALID_FRONTEND_FLIGHT_VIEWS'); }
export function normalizedFrontendViews(views: NativeFilterView[]): NativeFilterView[] {
  if (!Array.isArray(views) || views.length > 200 || new Set(views.map(v => v.filterViewId)).size !== views.length) fail();
  return views.map(source => {
    const view = copy(source);
    if (!Number.isSafeInteger(view.filterViewId) || view.filterViewId < 0) fail();
    if (view.filterSpecs) delete view.criteria;
    if (view.tableId) delete view.range; // Provider-derived Table extent changes with row/event growth.
    if (!view.sortSpecs?.length) delete view.sortSpecs;
    return view;
  }).sort((a, b) => a.filterViewId - b.filterViewId);
}
export function sameFrontendViews(a: NativeFilterView[], b: NativeFilterView[]): boolean {
  try { return canonical(normalizedFrontendViews(a)) === canonical(normalizedFrontendViews(b)); } catch { return false; }
}
function viewId(key: string): number { let n = 2166136261; for (let i = 0; i < key.length; i++) n = Math.imul(n ^ key.charCodeAt(i), 16777619); return (n >>> 0) % 2000000000 + 1; }
export function planFrontendFlightViews(input: { sheetId: number; tableId: string; headers: string[]; flights: string[]; views: NativeFilterView[] }) {
  const columnIndex = input.headers.indexOf('flight');
  if (columnIndex < 0 || !Number.isSafeInteger(input.sheetId) || !input.tableId || input.flights.length > 50
    || input.flights.some(f => typeof f !== 'string' || !f.trim() || f.length > 80) || new Set(input.flights).size !== input.flights.length) fail();
  const views = normalizedFrontendViews(input.views), requests: Record<string, unknown>[] = [];
  for (const flight of input.flights) {
    const title = `${flight} Flight`, matches = views.filter(v => v.title === title);
    if (matches.length > 1) fail();
    const existing = matches[0], filterSpecs = [{ columnIndex, filterCriteria: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: flight }] } } }];
    if (existing) {
      // Adopt only the existing standard single-Flight view. Keep user-created multi-field views untouched.
      const criteria = existing.filterSpecs ?? Object.entries(existing.criteria ?? {}).map(([index, filterCriteria]) => ({ columnIndex: Number(index), filterCriteria }));
      if (existing.tableId !== input.tableId || criteria.length !== 1 || criteria[0].columnIndex !== columnIndex) fail();
      const previous = criteria[0].filterCriteria;
      if (!previous || Object.keys(previous).some(k => !['hiddenValues', 'condition'].includes(k))
        || previous.condition && (previous.condition.type !== 'TEXT_EQ' || previous.condition.values?.length !== 1 || previous.condition.values[0].userEnteredValue !== flight)) fail();
      if (canonical(criteria) !== canonical(filterSpecs)) {
        requests.push({ updateFilterView: { filter: { filterViewId: existing.filterViewId, tableId: input.tableId, filterSpecs }, fields: 'filterSpecs' } });
        existing.filterSpecs = filterSpecs; delete existing.criteria;
      }
    } else {
      const filterViewId = viewId(`${input.sheetId}:${input.tableId}:flight:${flight}`);
      if (views.some(v => v.filterViewId === filterViewId)) fail();
      const view = { filterViewId, title, tableId: input.tableId, filterSpecs };
      views.push(view); requests.push({ addFilterView: { filter: copy(view) } });
    }
  }
  return { requests, views: normalizedFrontendViews(views) };
}
