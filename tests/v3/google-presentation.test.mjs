import test from 'node:test';
import assert from 'node:assert/strict';
import { planPresentationRepair, planPresentationGrowth, verifyPresentation, chunkPresentationRequests,
  PRESENTATION_LEGEND_VALUES, presentationTableIdentity } from '../../.build/v3/apps/google-adapter/src/presentation.js';
import { PROJECTION_HEADERS } from '../../.build/v3/apps/google-adapter/src/projection.js';
import { DYNAMIC_DECISION_HEADERS } from '../../.build/v3/apps/google-adapter/src/decision-slots.js';

const invalid = error => error.code === 'invalid_presentation';
const copy = value => structuredClone(value);
const surfaceHeaders = [PROJECTION_HEADERS.attendance, PROJECTION_HEADERS.decisions, DYNAMIC_DECISION_HEADERS];
const foreignRule = { ranges: [{ sheetId: 101, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 4, endColumnIndex: 5 }],
  booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Personal highlight' }] }, format: { textFormat: { italic: true } } } };
function fixture(reorder = false) {
  const surfaces = ['attendance', 'decisions', 'decision-input'].map((role, index) => {
    const headers = [...surfaceHeaders[index]];
    if (reorder) headers.reverse();
    return { role, sheetId: 101 + index, title: ['Attendance', 'Excusal results', 'Decision input'][index], headers,
      displayHeaders: headers.map(header => header.replaceAll('_', ' ')), dataEndRow: 6, gridRowCount: 40, gridColumnCount: 26 };
  });
  const sheets = surfaces.map(surface => ({ properties: { sheetId: surface.sheetId, title: surface.title, gridProperties: { rowCount: 40, columnCount: 26 } },
    tables: [], filterViews: [], conditionalFormats: [], developerMetadata: [], protectedRanges: [{ protectedRangeId: 7, range: { sheetId: surface.sheetId }, warningOnly: false }],
    data: [{ startRow: 0, startColumn: 0, rowMetadata: Array.from({ length: 40 }, () => ({})), columnMetadata: Array.from({ length: 26 }, () => ({})),
      rowData: Array.from({ length: 40 }, (_, row) => ({ values: Array.from({ length: 26 }, (_, column) => ({ userEnteredValue: { stringValue: row < 2
        ? (row === 0 ? surface.headers[column] ?? '' : surface.displayHeaders[column] ?? '') : `retained ${row}:${column}` }, note: 'Retain operator note',
      userEnteredFormat: { textFormat: { italic: true, link: { uri: 'https://example.test/help' } } } })) })) }],
  }));
  sheets[0].conditionalFormats.push(copy(foreignRule));
  sheets[0].filterViews.push({ filterViewId: 17, title: 'Operator view', range: { sheetId: 101, startRowIndex: 1, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 10 }, sortSpecs: [{ dimensionIndex: 5, sortOrder: 'DESCENDING' }] });
  sheets[0].developerMetadata.push({ metadataId: 42, metadataKey: 'operator-note', metadataValue: 'retain' });
  sheets.push({ properties: { sheetId: 199, title: 'Data Legend', gridProperties: { rowCount: 10, columnCount: 2 } },
    protectedRanges: [{ range: { sheetId: 199 }, warningOnly: false }], data: [{ rowData: [] }] });
  return { surfaces, legend: { sheetId: 199, title: 'Data Legend', values: [] }, metadata: { sheets }, requireCellReadback: true };
}
function getSheet(input, id) { return input.metadata.sheets.find(sheet => sheet.properties.sheetId === id); }
function setPath(destination, source, path) {
  const parts = path.split('.'); let target = destination, value = source;
  for (const part of parts.slice(0, -1)) { target[part] ??= {}; target = target[part]; value = value?.[part]; }
  const key = parts.at(-1); if (value?.[key] === undefined) delete target[key]; else target[key] = copy(value[key]);
}
function masked(destination, source, fields) { for (const path of fields.split(',')) setPath(destination, source, path); }
function eachCell(sheet, range, callback) {
  const block = sheet.data[0];
  for (let row = range.startRowIndex ?? 0; row < range.endRowIndex; row++) {
    block.rowData[row] ??= { values: [] };
    for (let column = range.startColumnIndex ?? 0; column < range.endColumnIndex; column++) {
      block.rowData[row].values[column] ??= {}; callback(block.rowData[row].values[column], row, column);
    }
  }
}
/** Minimal faithful metadata/field-mask interpreter, with no provider or credentials. */
function apply(input, requests) {
  for (const request of requests) {
    const [op, body] = Object.entries(request)[0];
    if (op === 'addTable') { const table = copy(body.table); table.tableId = `provider-assigned-${table.range.sheetId}`; getSheet(input, table.range.sheetId).tables.push(table); }
    else if (op === 'createDeveloperMetadata') getSheet(input, body.developerMetadata.location.sheetId).developerMetadata.push(copy(body.developerMetadata));
    else if (op === 'updateTable') {
      const table = input.metadata.sheets.flatMap(s => s.tables ?? []).find(t => t.tableId === body.table.tableId); assert.ok(table); masked(table, body.table, body.fields);
    } else if (op === 'updateSheetProperties') masked(getSheet(input, body.properties.sheetId).properties, body.properties, body.fields);
    else if (op === 'updateDimensionProperties') {
      const data = getSheet(input, body.range.sheetId).data[0], key = body.range.dimension === 'ROWS' ? 'rowMetadata' : 'columnMetadata';
      for (let i = body.range.startIndex; i < body.range.endIndex; i++) masked(data[key][i], body.properties, body.fields);
    } else if (op === 'repeatCell') eachCell(getSheet(input, body.range.sheetId), body.range, cell => masked(cell, body.cell, body.fields));
    else if (op === 'updateCells') {
      eachCell(getSheet(input, body.range.sheetId), body.range, (cell, row, column) => masked(cell, body.rows[row].values[column], body.fields));
      input.legend.values = body.rows.map(row => row.values.map(cell => cell.userEnteredValue.stringValue));
    } else if (op === 'setDataValidation') eachCell(getSheet(input, body.range.sheetId), body.range, cell => { cell.dataValidation = copy(body.rule); });
    else if (op === 'addFilterView') getSheet(input, body.filter.range.sheetId).filterViews.push(copy(body.filter));
    else if (op === 'updateFilterView') {
      const view = input.metadata.sheets.flatMap(s => s.filterViews ?? []).find(v => v.filterViewId === body.filter.filterViewId); assert.ok(view); masked(view, body.filter, body.fields);
    } else if (op === 'addConditionalFormatRule') getSheet(input, body.rule.ranges[0].sheetId).conditionalFormats.splice(body.index, 0, copy(body.rule));
    else if (op === 'deleteConditionalFormatRule') getSheet(input, body.sheetId).conditionalFormats.splice(body.index, 1);
    else assert.fail(`Unexpected planner request ${op}`);
  }
}
function repair(input) {
  const creation = planPresentationRepair(input);
  if (creation.phase === 'create-tables') apply(input, creation.requests);
  const configure = planPresentationRepair(input); assert.equal(configure.phase, 'configure'); apply(input, configure.requests);
  return [...(creation.phase === 'create-tables' ? creation.requests : []), ...configure.requests];
}
function operationalValues(input) { return input.metadata.sheets.slice(0, 3).map(s => s.data[0].rowData.map(r => r.values.map(c => ({ value: c.userEnteredValue, note: c.note, link: c.userEnteredFormat?.textFormat?.link })))); }

test('two-phase native Tables preserve all operational values, drafts, notes, permissions and foreign metadata', () => {
  const input = fixture(), before = copy(operationalValues(input));
  const protections = input.metadata.sheets.map(s => copy(s.protectedRanges));
  const first = planPresentationRepair(input);
  assert.equal(first.phase, 'create-tables'); assert.equal(first.requests.length, 6);
  assert.ok(first.requests.filter(r => r.addTable).every(r => Object.keys(r.addTable.table).sort().join() === 'name,range'));
  assert.equal(chunkPresentationRequests(first.requests, 1).length, 1, 'table + owner markers must stay atomic');
  const requests = repair(input);
  assert.deepEqual(operationalValues(input), before);
  assert.deepEqual(input.metadata.sheets.map(s => s.protectedRanges), protections);
  assert.deepEqual(input.metadata.sheets[0].conditionalFormats.at(-1), foreignRule);
  assert.equal(input.metadata.sheets[0].filterViews.find(v => v.filterViewId === 17).title, 'Operator view');
  assert.equal(input.metadata.sheets[0].developerMetadata.find(m => m.metadataId === 42).metadataValue, 'retain');
  assert.ok(requests.every(r => !r.deleteTable && !r.deleteDimension && !r.sortRange && !r.addProtectedRange && !r.updateProtectedRange));
  assert.ok(requests.filter(r => r.updateCells).every(r => r.updateCells.range.sheetId === input.legend.sheetId));
  assert.deepEqual(verifyPresentation(input), { ready: true, issues: [] });
});

test('repeated repair retains IDs and user view ordering, and growth is a no-op until rows append', () => {
  const input = fixture(); repair(input);
  const tables = input.metadata.sheets.slice(0, 3).map(s => s.tables[0].tableId);
  const managedView = input.metadata.sheets[0].filterViews.find(v => v.title.startsWith('SHAMROCK'));
  managedView.sortSpecs = [{ dimensionIndex: 5, sortOrder: 'DESCENDING' }];
  const second = planPresentationRepair(input);
  assert.ok(second.requests.every(r => !r.addTable && !r.updateTable && !r.addFilterView && !r.deleteConditionalFormatRule && !r.addConditionalFormatRule && !r.updateCells));
  apply(input, second.requests);
  assert.deepEqual(input.metadata.sheets.slice(0, 3).map(s => s.tables[0].tableId), tables);
  assert.deepEqual(managedView.sortSpecs, [{ dimensionIndex: 5, sortOrder: 'DESCENDING' }]);
  assert.deepEqual(planPresentationGrowth(input).requests, []);
  const before = copy(operationalValues(input)); input.surfaces[0].dataEndRow = 12;
  const growth = planPresentationGrowth(input); assert.equal(growth.requests.length, 3);
  assert.ok(growth.requests.every(r => r.updateTable?.fields === 'range' || r.updateFilterView?.fields === 'range'));
  apply(input, growth.requests); assert.deepEqual(operationalValues(input), before);
  assert.equal(verifyPresentation(input).ready, true);
  input.surfaces[0].dataEndRow = 4;
  assert.deepEqual(planPresentationGrowth(input).requests, []);
  assert.equal(verifyPresentation(input).ready, true, 'retained larger table is valid after a smaller projection');
  apply(input, planPresentationRepair(input).requests);
  assert.equal(input.metadata.sheets[0].tables[0].range.endRowIndex, 12);
  managedView.range.endRowIndex = 15;
  assert.equal(verifyPresentation(input).ready, true, 'a bounded wider managed view is retained');
  apply(input, planPresentationRepair(input).requests);
  assert.equal(managedView.range.endRowIndex, 15);
});

test('arbitrary header order keeps validation on decision cells and every machine identity column hidden', () => {
  const input = fixture(true); repair(input);
  const surface = input.surfaces[2], sheet = getSheet(input, surface.sheetId), column = surface.headers.indexOf('draft_decision');
  const cell = sheet.data[0].rowData[2].values[column];
  assert.equal(cell.dataValidation.strict, true);
  assert.deepEqual(cell.dataValidation.condition, { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Data Legend'!$A$3:$A$6" }] });
  assert.ok(sheet.tables[0].columnProperties.every(p => p.columnType === 'COLUMN_TYPE_UNSPECIFIED'));
  for (const header of ['slot_id', 'draft_json', 'slot_origin_row', 'slot_context_hash']) {
    if (surface.headers.includes(header)) assert.equal(sheet.data[0].columnMetadata[surface.headers.indexOf(header)].hiddenByUser, true);
  }
  for (const header of ['base_version', 'recorded_status', 'draft_state']) assert.equal(sheet.data[0].columnMetadata[surface.headers.indexOf(header)].hiddenByUser, false);
  const recorded = input.surfaces[1], recordedSheet = getSheet(input, recorded.sheetId);
  for (const header of ['event_label', 'unit_label']) assert.equal(recordedSheet.data[0].columnMetadata[recorded.headers.indexOf(header)].hiddenByUser, false);
  assert.equal(sheet.data[0].rowData[1].values[column].userEnteredFormat.textFormat.fontFamily, 'Roboto');
  assert.equal(verifyPresentation(input).ready, true);
});

test('missing native structures, drifted colors, weakened validation and incomplete read-back never report ready', () => {
  const base = fixture(); repair(base);
  let input = copy(base); input.metadata.sheets[0].tables = [];
  assert.equal(verifyPresentation(input).ready, false);
  input = copy(base); input.metadata.sheets[0].tables[0].rowsProperties.headerColorStyle = { rgbColor: { red: 1 } };
  assert.ok(verifyPresentation(input).issues.includes('attendance:native-table'));
  input = copy(base); const column = input.surfaces[2].headers.indexOf('draft_decision');
  input.metadata.sheets[2].data[0].rowData[39].values[column].dataValidation.strict = false;
  assert.ok(verifyPresentation(input).issues.includes('decision-input:decision-validation'));
  input = copy(base); input.metadata.sheets[2].data = [];
  assert.equal(verifyPresentation(input).ready, false);
  input = copy(base); input.metadata.sheets[3].protectedRanges[0].warningOnly = true;
  assert.ok(verifyPresentation(input).issues.includes('legend:protection'));
});

test('bounded GridData samples and provider-default enum/boolean/color normalization verify safely', () => {
  const input = fixture(); repair(input);
  for (const sheet of input.metadata.sheets.slice(0, 3)) {
    for (const column of sheet.tables[0].columnProperties) delete column.columnType;
    sheet.tables[0].rowsProperties.headerColorStyle.rgbColor.red += 0.00000001;
    const block = sheet.data[0];
    sheet.data = [{ ...block, rowData: block.rowData.slice(0, 3), rowMetadata: block.rowMetadata.slice(0, 3) },
      { startRow: 39, startColumn: 0, rowData: block.rowData.slice(39), rowMetadata: block.rowMetadata.slice(39) }];
    delete sheet.properties.gridProperties.frozenColumnCount;
    for (const column of sheet.data[0].columnMetadata) if (column.hiddenByUser === false) delete column.hiddenByUser;
  }
  assert.deepEqual(verifyPresentation(input), { ready: true, issues: [] });
});

test('unsafe names, ownership collisions, merges, legend contents and bounds fail before returning mutations', () => {
  const cases = [
    input => { input.surfaces[0].headers[1] = input.surfaces[0].headers[0]; },
    input => { input.surfaces[0].gridRowCount = 2003; },
    input => { input.surfaces[0].dataEndRow = 41; },
    input => { input.legend.values = [['User maintained list']]; },
    input => { input.metadata.sheets[0].merges = [{ sheetId: 101, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }]; },
    input => { input.metadata.sheets[0].tables.push({ tableId: 'foreign', name: presentationTableIdentity(input.surfaces[0]).name, range: { sheetId: 101, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 10 } }); },
    input => { input.metadata.sheets[0].tables.push({ tableId: 'foreign', name: 'Personal table', range: { sheetId: 101, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 10 } }); },
  ];
  for (const alter of cases) { const input = fixture(); alter(input); const before = copy(input); assert.throws(() => planPresentationRepair(input), invalid); assert.deepEqual(input, before); }
});

test('partial configuration recovery preserves foreign rules and produces no duplicate native objects', () => {
  const input = fixture(); apply(input, planPresentationRepair(input).requests);
  const configure = planPresentationRepair(input).requests;
  // Model one successful batch followed by a failure; only read-back determines
  // what must be retried. No optimistic receipt or table-ready fallback exists.
  const firstBatches = chunkPresentationRequests(configure, 19); apply(input, firstBatches[0]);
  assert.equal(verifyPresentation(input).ready, false);
  apply(input, planPresentationRepair(input).requests);
  assert.equal(verifyPresentation(input).ready, true);
  assert.equal(input.metadata.sheets.slice(0, 3).reduce((n, s) => n + s.tables.length, 0), 3);
  assert.equal(input.metadata.sheets[0].conditionalFormats.filter(r => r.booleanRule.condition.type === 'TEXT_EQ').length, 1);
  // An impossible partial create (or external interference) is not silently adopted.
  const tampered = fixture(), create = planPresentationRepair(tampered).requests;
  apply(tampered, create.slice(0, 1)); assert.throws(() => planPresentationRepair(tampered), invalid);
});

test('chunking respects count/byte budgets, rejects malformed requests and never emits empty calls', () => {
  assert.deepEqual(chunkPresentationRequests([]), []);
  const requests = Array.from({ length: 151 }, () => ({ repeatCell: { fields: 'note', cell: { note: 'x' } } }));
  assert.deepEqual(chunkPresentationRequests(requests).map(batch => batch.length), [75, 75, 1]);
  const large = Array.from({ length: 6 }, () => ({ repeatCell: { cell: { note: 'x'.repeat(20000) } } }));
  assert.ok(chunkPresentationRequests(large).every(batch => JSON.stringify(batch).length * 3 < 180100));
  assert.throws(() => chunkPresentationRequests([{}]), invalid);
  assert.throws(() => chunkPresentationRequests([{ updateTable: {}, deleteTable: {} }]), invalid);
  assert.throws(() => chunkPresentationRequests([{ addTable: {}, deleteTable: {} }]), invalid);
  assert.throws(() => chunkPresentationRequests([{ updateCells: { text: 'x'.repeat(60001) } }]), invalid);
  assert.throws(() => chunkPresentationRequests(requests, 101), invalid);
  assert.deepEqual(PRESENTATION_LEGEND_VALUES.slice(2).map(row => row[0]), ['Approved', 'Denied', 'Withdrawn', 'Superseded']);
});
