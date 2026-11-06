/** Read-only, provider-neutral typed capture. Ports must never expose mutation methods. */
import { createHash } from 'node:crypto';
export const canonicalImportJson = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
export const importDigest = value => createHash('sha256').update(canonicalImportJson(value)).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const clone = value => JSON.parse(JSON.stringify(value));
function version(info) { check(typeof info.version === 'string' && /^\d+$/.test(info.version) && !info.trashed, 'CAPTURE_RESOURCE_VERSION'); return info.version; }
export function captureRanges(metadata, maxCells = 20000) {
  check(integer(maxCells,1000,50000),'CAPTURE_RANGE_BOUND');
  check(Array.isArray(metadata.sheets) && metadata.sheets.length <= 100, 'CAPTURE_SHEET_BOUND');
  const ranges = []; let total = 0;
  for (const sheet of metadata.sheets) {
    const p = sheet.properties, grid = p?.gridProperties;
    check(integer(p?.sheetId, 0, 2147483647) && typeof p.title === 'string' && grid && integer(grid.rowCount, 1, 50000) && integer(grid.columnCount, 1, 1000), 'CAPTURE_GRID_BOUND');
    total += grid.rowCount * grid.columnCount; check(total <= 5_000_000, 'CAPTURE_BOOK_BOUND');
    const step = Math.max(1, Math.floor(maxCells / grid.columnCount));
    for (let row = 0; row < grid.rowCount; row += step) ranges.push({ sheetId: p.sheetId, title: p.title,
      startRowIndex: row, endRowIndex: Math.min(row + step, grid.rowCount), startColumnIndex: 0, endColumnIndex: grid.columnCount });
  }
  return ranges;
}
async function captureBook(binding, port) {
  const before = await port.file(binding.providerId), metadata = await port.workbook(binding.providerId);
  check(metadata.spreadsheetId === binding.providerId && metadata.properties.title === binding.expectedTitle, 'CAPTURE_RESOURCE_BINDING');
  const ranges = captureRanges(metadata), byId = new Map(metadata.sheets.map(s => [s.properties.sheetId, { metadata: s, rows: Array.from({length:s.properties.gridProperties.rowCount}, () => []) }]));
  for (const range of ranges) {
    const block = await port.grid(binding.providerId, range);
    check(block && (block.startRow ?? 0) === range.startRowIndex && (block.startColumn ?? 0) === 0 && (block.rowData?.length ?? 0) <= range.endRowIndex - range.startRowIndex, 'CAPTURE_GRID_RESPONSE');
    for (let r = 0; r < (block.rowData?.length ?? 0); r++) {
      const values = block.rowData[r].values ?? []; check(values.length <= range.endColumnIndex, 'CAPTURE_COLUMN_RESPONSE');
      byId.get(range.sheetId).rows[range.startRowIndex + r] = values;
    }
  }
  const after = await port.file(binding.providerId);
  return { ...clone(binding), versionBefore:version(before), versionAfter:version(after), metadata,
    sheets:[...byId.values()], coherent:version(before) === version(after) };
}
async function allResponses(binding, port) {
  const result = []; let token; const tokens = new Set();
  do {
    const page = await port.responses(binding.providerId, token);
    check(Array.isArray(page.responses ?? []) && (page.responses?.length ?? 0) <= 1000, 'CAPTURE_FORM_RESPONSE');
    result.push(...page.responses ?? []); check(result.length <= 50000, 'CAPTURE_FORM_BOUND');
    token = page.nextPageToken;
    if (token) { check(typeof token === 'string' && !tokens.has(token), 'CAPTURE_FORM_PAGING'); tokens.add(token); }
  } while (token);
  check(result.every(r => typeof r.responseId === 'string' && r.responseId) && new Set(result.map(r => r.responseId)).size === result.length, 'CAPTURE_RESPONSE_ID_COLLISION');
  return result.sort((a,b) => a.responseId.localeCompare(b.responseId));
}
async function captureForm(binding, port) {
  const before = await port.file(binding.providerId), metadata = await port.form(binding.providerId);
  check(metadata.formId === binding.providerId, 'CAPTURE_FORM_BINDING');
  const responses = await allResponses(binding, port), repeated = await allResponses(binding, port);
  const metadataAfter = await port.form(binding.providerId), after = await port.file(binding.providerId);
  return { ...clone(binding), versionBefore:version(before), versionAfter:version(after), metadata, responses,
    responsesSha256:importDigest(responses), coherent:version(before) === version(after) && importDigest(metadata) === importDigest(metadataAfter) && importDigest(responses) === importDigest(repeated) };
}
/** An optimistic consistent-read window, not a writer fence or proof of complete historical edits. */
export async function captureLegacySources({ manifest, port, maxPasses = 3, now = () => new Date().toISOString(), checkpoint = async () => {} }) {
  check(manifest?.formatVersion === 1 && Array.isArray(manifest.resources) && manifest.resources.length > 0 && manifest.resources.length <= 30 && integer(maxPasses,1,5), 'CAPTURE_MANIFEST');
  check(new Set(manifest.resources.map(r => r.key)).size === manifest.resources.length && new Set(manifest.resources.map(r => r.providerId)).size === manifest.resources.length, 'CAPTURE_DUPLICATE_RESOURCE');
  for (const r of manifest.resources) check(['workbook','form'].includes(r.kind) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(r.key) && typeof r.providerId === 'string' && r.providerId.length <= 512, 'CAPTURE_RESOURCE');
  const resources = new Map(), startedAt = now(); let passes = 0, coherent = false;
  for (; passes < maxPasses; passes++) {
    const initial = new Map(); for (const r of manifest.resources) initial.set(r.key, version(await port.file(r.providerId)));
    for (const binding of manifest.resources) {
      const previous = resources.get(binding.key);
      if (!previous?.coherent || previous.versionAfter !== initial.get(binding.key)) {
        const captured = binding.kind === 'workbook' ? await captureBook(binding, port) : await captureForm(binding, port);
        resources.set(binding.key, captured); await checkpoint({ key:binding.key, captured });
      }
    }
    coherent = true;
    for (const binding of manifest.resources) {
      const current = version(await port.file(binding.providerId)), captured = resources.get(binding.key);
      if (!captured.coherent || current !== captured.versionAfter || current !== initial.get(binding.key)) { coherent = false; captured.coherent = false; }
      // Native response submissions can change without a Drive revision; check again across the full capture window.
      if (binding.kind === 'form' && importDigest(await allResponses(binding,port)) !== captured.responsesSha256) { coherent = false; captured.coherent = false; }
    }
    if (coherent) break;
  }
  const result = { formatVersion:1, startedAt, completedAt:now(), consistent:coherent, passes:Math.min(passes+1,maxPasses),
    consistency:'optimistic-version-vector-and-repeated-native-responses', writerFence:false, manifestSha256:importDigest(manifest), resources:[...resources.values()] };
  result.snapshotSha256 = importDigest(result); await checkpoint({ complete:result }); return result;
}
