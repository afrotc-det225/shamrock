/** Same-workbook native dropdown copying from a protected styled seed cell.
 * No credentials, file cloning, provider SDK, or private Sheets endpoints. */
import { createHash } from 'node:crypto';

const MAX_ROWS = 2002, MAX_COLUMNS = 100;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function requireValue(ok, message) { if (!ok) throw new Error(`Native dropdown template: ${message}`); }
function keys(value, expected) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(','); }
function headers(value) { return Array.isArray(value) && value.length > 0 && value.length <= MAX_COLUMNS
  && value.every(header => typeof header === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(header)) && new Set(value).size === value.length; }
function rule(value) {
  requireValue(value && value.strict === true && (value.showCustomUi === undefined || typeof value.showCustomUi === 'boolean')
    && Object.keys(value).every(key => ['condition', 'inputMessage', 'strict', 'showCustomUi'].includes(key))
    && (value.inputMessage === undefined || typeof value.inputMessage === 'string'), 'a strict validation rule is required');
  requireValue(keys(value.condition, ['type', 'values']) && value.condition.type === 'ONE_OF_RANGE'
    && Array.isArray(value.condition.values) && value.condition.values.length === 1
    && keys(value.condition.values[0], ['userEnteredValue'])
    && /^=?'(?:[^']|'')+'!\$[A-Z]+\$[1-9]\d*:\$[A-Z]+\$[1-9]\d*$/.test(value.condition.values[0].userEnteredValue),
  'the validation must use an explicit absolute legend range');
  const source = value.condition.values[0].userEnteredValue;
  return { ...value, showCustomUi: value.showCustomUi === true,
    condition: { ...value.condition, values: [{ userEnteredValue: source.startsWith('=') ? source : `=${source}` }] } };
}
export function nativeDropdownRuleFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(rule(value)))).digest('hex');
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
/** Plan same-workbook validation copying only from fresh bounded GridData.
 * Source headers can include ordinary legend fields alongside the seed field.
 * The caller verifies source protection and native appearance separately.
 * Google may auto-expand a native Table into the destination rows. Read back
 * Table extents, reconcile only their ranges if needed, and verify the rules. */
export function planNativeDropdownCopy({ spreadsheet, source, target }) {
  requireValue(typeof spreadsheet?.spreadsheetId === 'string' && spreadsheet.spreadsheetId.length > 0
    && Array.isArray(spreadsheet.sheets), 'missing workbook read-back');
  const find = id => {
    requireValue(integer(id, 0, 2147483647), 'invalid sheet reference');
    const matches = spreadsheet.sheets.filter(sheet => sheet.properties?.sheetId === id);
    requireValue(matches.length === 1, 'missing or ambiguous sheet reference');
    const sheet = matches[0], grid = sheet.properties.gridProperties;
    requireValue(integer(grid?.rowCount, 3, MAX_ROWS) && integer(grid?.columnCount, 1, MAX_COLUMNS), 'grid exceeds reviewed bounds');
    return sheet;
  };
  const seedSheet = find(source?.sheetId), destination = find(target?.sheetId);
  requireValue(integer(source.headerRowIndex, 0, MAX_ROWS - 3)
    && integer(source.seedRowIndex, source.headerRowIndex + 2, seedSheet.properties.gridProperties.rowCount - 1), 'invalid seed extent');
  const sourceColumn = column(seedSheet, source.headers, source.field, source.headerRowIndex);
  requireValue(nativeDropdownRuleFingerprint(cellProperty(seedSheet, source.seedRowIndex, sourceColumn, 'dataValidation')) === nativeDropdownRuleFingerprint(source.rule),
    'seed validation or legend source drift');
  requireValue(integer(target.headerRowIndex, 0, MAX_ROWS - 3)
    && integer(target.startRowIndex, target.headerRowIndex + 2, destination.properties.gridProperties.rowCount - 1)
    && integer(target.endRowIndex, target.startRowIndex + 1, destination.properties.gridProperties.rowCount), 'invalid destination extent');
  const targetColumn = column(destination, target.headers, target.field, target.headerRowIndex);
  requireValue(sourceColumn < seedSheet.properties.gridProperties.columnCount && targetColumn < destination.properties.gridProperties.columnCount,
    'schema exceeds grid bounds');
  requireValue(seedSheet !== destination || sourceColumn !== targetColumn
    || source.seedRowIndex < target.startRowIndex || source.seedRowIndex >= target.endRowIndex, 'source and destination overlap');
  return { requests: [{ copyPaste: {
    source: { sheetId: seedSheet.properties.sheetId, startRowIndex: source.seedRowIndex, endRowIndex: source.seedRowIndex + 1,
      startColumnIndex: sourceColumn, endColumnIndex: sourceColumn + 1 },
    destination: { sheetId: destination.properties.sheetId, startRowIndex: target.startRowIndex, endRowIndex: target.endRowIndex,
      startColumnIndex: targetColumn, endColumnIndex: targetColumn + 1 },
    pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL',
  } }] };
}
