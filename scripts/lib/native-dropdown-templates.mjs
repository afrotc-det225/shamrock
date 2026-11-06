/** Native Sheets template operations. No credentials, provider SDK, or private
 * Sheets endpoints. Chip appearance is preserved by native copying; the public
 * API can verify validation rules, but does not expose chip colors/styles. */
import { createHash } from 'node:crypto';

const MIME = 'application/vnd.google-apps.spreadsheet';
const MAX_ROWS = 2002, MAX_COLUMNS = 100;
const logical = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function requireValue(ok, message) { if (!ok) throw new Error(`Native dropdown template: ${message}`); }
function keys(value, expected) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(','); }
function headers(value) { return Array.isArray(value) && value.length > 0 && value.length <= MAX_COLUMNS
  && value.every(header => typeof header === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(header)) && new Set(value).size === value.length; }
function rule(value) {
  requireValue(value && value.strict === true && value.showCustomUi === true
    && Object.keys(value).every(key => ['condition', 'inputMessage', 'strict', 'showCustomUi'].includes(key))
    && (value.inputMessage === undefined || typeof value.inputMessage === 'string'), 'a strict visible validation rule is required');
  requireValue(keys(value.condition, ['type', 'values']) && value.condition.type === 'ONE_OF_RANGE'
    && Array.isArray(value.condition.values) && value.condition.values.length === 1
    && keys(value.condition.values[0], ['userEnteredValue'])
    && /^=?'(?:[^']|'')+'!\$[A-Z]+\$[1-9]\d*:\$[A-Z]+\$[1-9]\d*$/.test(value.condition.values[0].userEnteredValue),
  'the validation must use an explicit absolute legend range');
  const source = value.condition.values[0].userEnteredValue;
  return { ...value, condition: { ...value.condition, values: [{ userEnteredValue: source.startsWith('=') ? source : `=${source}` }] } };
}
export function nativeDropdownRuleFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(rule(value)))).digest('hex');
}
/** This serializable manifest contains logical bindings, never provider IDs or
 * owners. Resolve those privately before using cloneNativeTemplate. */
export function validateNativeDropdownManifest(manifest) {
  requireValue(keys(manifest, ['version', 'release', 'sourceBinding', 'sourceDriveVersion', 'roles'])
    && manifest.version === 1 && logical(manifest.release) && logical(manifest.sourceBinding)
    && typeof manifest.sourceDriveVersion === 'string' && /^[1-9]\d*$/.test(manifest.sourceDriveVersion)
    && Array.isArray(manifest.roles) && manifest.roles.length > 0 && manifest.roles.length <= 20, 'invalid manifest');
  const seen = new Set();
  for (const role of manifest.roles) {
    requireValue(keys(role, ['role', 'sheetBinding', 'headers', 'field', 'headerRowIndex', 'seedRowIndex', 'rule', 'ruleFingerprint'])
      && logical(role.role) && logical(role.sheetBinding) && !seen.has(role.role) && headers(role.headers)
      && role.headers.includes(role.field) && integer(role.headerRowIndex, 0, MAX_ROWS - 3)
      && integer(role.seedRowIndex, role.headerRowIndex + 2, MAX_ROWS - 1), 'invalid or ambiguous role');
    seen.add(role.role);
    requireValue(role.ruleFingerprint === nativeDropdownRuleFingerprint(role.rule), 'rule fingerprint mismatch');
  }
  return manifest;
}
function cellProperty(sheet, row, column, property) {
  const matches = (sheet.data ?? []).map(block => {
    const r = row - (block.startRow ?? 0), c = column - (block.startColumn ?? 0);
    return r >= 0 && c >= 0 ? block.rowData?.[r]?.values?.[c]?.[property] : undefined;
  }).filter(value => value !== undefined);
  requireValue(matches.length > 0, 'bounded cell read-back is missing');
  requireValue(matches.every(value => JSON.stringify(canonical(value)) === JSON.stringify(canonical(matches[0]))), 'ambiguous seed or header read-back');
  return matches[0];
}
function column(sheet, expected, field, row) {
  requireValue(headers(expected) && expected.includes(field), 'invalid expected schema');
  const actual = expected.map((_value, index) => {
    const entered = cellProperty(sheet, row, index, 'userEnteredValue');
    requireValue(keys(entered, ['stringValue']), 'machine headers must be literal strings');
    return entered.stringValue;
  });
  requireValue(headers(actual) && actual.length === expected.length && actual.every(value => expected.includes(value)), 'machine schema drift');
  return actual.indexOf(field);
}
/** Plan same-workbook validation copying only. Callers read the pinned native
 * master before cloning and pass fresh bounded cells from its copied seed tab.
 * Google may auto-expand a native Table into the destination rows. Read back
 * Table extents, reconcile only their ranges if needed, and verify the rules. */
export function planNativeDropdownCopy({ manifest, role, sourceFile, spreadsheet, bindings, target }) {
  validateNativeDropdownManifest(manifest);
  requireValue(sourceFile?.binding === manifest.sourceBinding && sourceFile.version === manifest.sourceDriveVersion
    && sourceFile.mimeType === MIME, 'source version or logical binding drift');
  const entry = manifest.roles.find(value => value.role === role);
  requireValue(entry && spreadsheet?.spreadsheetId && Array.isArray(spreadsheet.sheets), 'unknown role or workbook');
  const find = binding => {
    requireValue(logical(binding) && integer(bindings?.[binding], 0, 2147483647), 'unresolved logical sheet binding');
    const matches = spreadsheet.sheets.filter(sheet => sheet.properties?.sheetId === bindings[binding]);
    requireValue(matches.length === 1, 'missing or ambiguous sheet binding');
    const sheet = matches[0], grid = sheet.properties.gridProperties;
    requireValue(integer(grid?.rowCount, 3, MAX_ROWS) && integer(grid?.columnCount, 1, MAX_COLUMNS), 'grid exceeds reviewed bounds');
    return sheet;
  };
  const source = find(entry.sheetBinding), destination = find(target?.sheetBinding);
  const sourceColumn = column(source, entry.headers, entry.field, entry.headerRowIndex);
  requireValue(integer(entry.seedRowIndex, 0, source.properties.gridProperties.rowCount - 1), 'seed exceeds grid bounds');
  requireValue(nativeDropdownRuleFingerprint(cellProperty(source, entry.seedRowIndex, sourceColumn, 'dataValidation')) === entry.ruleFingerprint,
    'seed validation or legend source drift');
  requireValue(integer(target.headerRowIndex, 0, MAX_ROWS - 3)
    && integer(target.startRowIndex, target.headerRowIndex + 2, destination.properties.gridProperties.rowCount - 1)
    && integer(target.endRowIndex, target.startRowIndex + 1, destination.properties.gridProperties.rowCount), 'invalid destination extent');
  const targetColumn = column(destination, target.headers, target.field, target.headerRowIndex);
  requireValue(sourceColumn < source.properties.gridProperties.columnCount && targetColumn < destination.properties.gridProperties.columnCount,
    'schema exceeds grid bounds');
  requireValue(source !== destination || sourceColumn !== targetColumn
    || entry.seedRowIndex < target.startRowIndex || entry.seedRowIndex >= target.endRowIndex, 'source and destination overlap');
  return { requests: [{ copyPaste: {
    source: { sheetId: source.properties.sheetId, startRowIndex: entry.seedRowIndex, endRowIndex: entry.seedRowIndex + 1,
      startColumnIndex: sourceColumn, endColumnIndex: sourceColumn + 1 },
    destination: { sheetId: destination.properties.sheetId, startRowIndex: target.startRowIndex, endRowIndex: target.endRowIndex,
      startColumnIndex: targetColumn, endColumnIndex: targetColumn + 1 },
    pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL',
  } }] };
}
function privateNativeFile(file, entry) {
  requireValue(file?.mimeType === MIME && file.trashed === false && file.owners?.length === 1
    && file.owners[0].emailAddress === entry.ownerEmail && file.permissions?.length === 1
    && file.permissions[0].type === 'user' && file.permissions[0].role === 'owner'
    && file.permissions[0].emailAddress === entry.ownerEmail, 'native template must have verified owner-only access');
  requireValue(file.appProperties?.shamrockTemplateBinding === entry.binding
    && file.appProperties?.shamrockTemplateRole === entry.role, 'native template role or binding drift');
}
/** runtimeEntry is private resolved configuration, not the committed manifest.
 * IO must return complete owners/permissions and appProperties for both files.
 * A Drive version pin detects later edits; it does not make a file immutable. */
export async function cloneNativeTemplate(io, runtimeEntry, { title }) {
  requireValue(runtimeEntry && logical(runtimeEntry.binding) && logical(runtimeEntry.role)
    && typeof runtimeEntry.sourceFileId === 'string' && runtimeEntry.sourceFileId.length > 0
    && typeof runtimeEntry.ownerEmail === 'string' && runtimeEntry.ownerEmail.includes('@')
    && typeof runtimeEntry.driveVersion === 'string' && /^[1-9]\d*$/.test(runtimeEntry.driveVersion), 'invalid resolved clone binding');
  requireValue(typeof title === 'string' && title.trim() === title && title.length > 0 && title.length <= 200
    && !/[\r\n]/.test(title), 'invalid copy title');
  const source = await io.readTemplateMetadata(runtimeEntry.sourceFileId);
  requireValue(source?.id === runtimeEntry.sourceFileId && source.version === runtimeEntry.driveVersion, 'source identity or Drive version drift');
  privateNativeFile(source, runtimeEntry);
  const copied = await io.copyFile({ sourceFileId: source.id, title });
  requireValue(typeof copied?.id === 'string' && copied.id.length > 0 && copied.id !== source.id, 'copy must create a distinct file');
  const [after, sourceAfter] = await Promise.all([io.readCopiedMetadata(copied.id), io.readTemplateMetadata(source.id)]);
  requireValue(sourceAfter?.id === source.id && sourceAfter.version === runtimeEntry.driveVersion, 'source changed during copy');
  privateNativeFile(sourceAfter, runtimeEntry);
  requireValue(after?.id === copied.id && after.name === title, 'copied file identity mismatch');
  privateNativeFile(after, runtimeEntry);
  return copied.id;
}
