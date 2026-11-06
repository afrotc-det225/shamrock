import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeDropdownRuleFingerprint, planNativeDropdownCopy } from '../../scripts/lib/native-dropdown-templates.mjs';

const copy = value => structuredClone(value);
const rule = { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Data Legend'!$A$3:$A$6" }] },
  strict: true, showCustomUi: true, inputMessage: 'Choose a decision.' };
function fixture() {
  const cells = values => values.map(row => ({ values: row.map(stringValue => ({ userEnteredValue: { stringValue } })) }));
  const legend = { properties: { sheetId: 10, hidden: true, gridProperties: { rowCount: 6, columnCount: 2 } },
    data: [{ rowData: cells([['decision_seed', 'decision_options'], ['Decision seed', 'Decision options'], ['Approved', 'Approved']]) }] };
  legend.data[0].rowData[2].values[0].dataValidation = copy(rule);
  const destination = { properties: { sheetId: 20, gridProperties: { rowCount: 102, columnCount: 3 } },
    data: [{ rowData: cells([['person', 'decision', 'event'], ['Name', 'Decision', 'Event'], ['Fictional cadet', 'Denied', 'Fictional event']]) }] };
  return { spreadsheet: { spreadsheetId: 'fictional-workbook', sheets: [legend, destination] },
    source: { sheetId: 10, headers: ['decision_options', 'decision_seed'], field: 'decision_seed', headerRowIndex: 0, seedRowIndex: 2, rule: copy(rule) },
    target: { sheetId: 20, headers: ['person', 'event', 'decision'], field: 'decision', headerRowIndex: 0, startRowIndex: 2, endRowIndex: 102 } };
}

test('same-workbook copying finds a hidden legend seed by header and cannot write values or recreate rules', () => {
  const input = fixture(), before = copy(input), plan = planNativeDropdownCopy(input);
  assert.deepEqual(input, before);
  assert.deepEqual(plan, { requests: [{ copyPaste: {
    source: { sheetId: 10, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
    destination: { sheetId: 20, startRowIndex: 2, endRowIndex: 102, startColumnIndex: 1, endColumnIndex: 2 },
    pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL',
  } }] });
  assert.equal(plan.requests.some(request => request.setDataValidation || request.updateCells || request.updateTable), false);
  input.target.startRowIndex = 50;
  assert.equal(planNativeDropdownCopy(input).requests[0].copyPaste.destination.startRowIndex, 50, 'growth touches only the selected new rows');
});

test('wrong legend, weaker rules, ambiguous or missing read-back, header drift and unsafe extents fail before planning', () => {
  for (const mutate of [
    input => { input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation.strict = false; },
    input => { input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation.condition.values[0].userEnteredValue = "='Wrong Legend'!$A$3:$A$6"; },
    input => { input.spreadsheet.sheets[0].data.push({ startRow: 2, startColumn: 0, rowData: [{ values: [{ dataValidation: { ...rule, strict: false } }] }] }); },
    input => { delete input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation; },
    input => { input.spreadsheet.sheets[1].data[0].rowData[0].values[1].userEnteredValue = { formulaValue: '="decision"' }; },
    input => { input.target.headers = ['person', 'person', 'decision']; },
    input => { input.target.sheetId = 30; },
    input => { input.spreadsheet.sheets.push(copy(input.spreadsheet.sheets[0])); },
    input => { input.target.endRowIndex = 103; },
    input => { input.target.startRowIndex = 1; },
    input => { input.target.endRowIndex = input.target.startRowIndex; },
    input => { input.source.seedRowIndex = 1; },
    input => { Object.assign(input.target, { sheetId: 10, headers: input.source.headers, field: 'decision_seed', startRowIndex: 2, endRowIndex: 4 }); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planNativeDropdownCopy(input), /Native dropdown template:/);
  }
});

test('fingerprints normalize only an optional leading equals sign on absolute quoted legend ranges', () => {
  const input = fixture(), seed = input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation;
  seed.condition.values[0].userEnteredValue = "'Data Legend'!$A$3:$A$6";
  const before = copy(seed);
  assert.equal(nativeDropdownRuleFingerprint(seed), nativeDropdownRuleFingerprint(rule));
  assert.deepEqual(seed, before);
  assert.equal(planNativeDropdownCopy(input).requests.length, 1);
  for (const invalid of ["='Data Legend'!A3:A6", '=DataLegend!$A$3:$A$6', " ='Data Legend'!$A$3:$A$6", "=='Data Legend'!$A$3:$A$6"]) {
    const altered = copy(rule); altered.condition.values[0].userEnteredValue = invalid;
    assert.throws(() => nativeDropdownRuleFingerprint(altered), /absolute legend range/);
  }
  const different = copy(rule); different.condition.values[0].userEnteredValue = "='Data Legend'!$A$4:$A$7";
  assert.notEqual(nativeDropdownRuleFingerprint(different), nativeDropdownRuleFingerprint(rule));
});

test('plain validation copies native appearance with omitted or false dropdown visibility, but never accepts visible-rule drift', () => {
  const input = fixture();
  input.source.rule.showCustomUi = false;
  const seed = input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation;
  delete seed.showCustomUi;
  const before = copy(seed);
  assert.equal(nativeDropdownRuleFingerprint(seed), nativeDropdownRuleFingerprint(input.source.rule));
  assert.equal(planNativeDropdownCopy(input).requests[0].copyPaste.pasteType, 'PASTE_DATA_VALIDATION');
  assert.deepEqual(seed, before);
  seed.showCustomUi = true;
  assert.throws(() => planNativeDropdownCopy(input), /seed validation or legend source drift/);
  for (const invalid of [null, 0, 'false']) {
    seed.showCustomUi = invalid;
    assert.throws(() => nativeDropdownRuleFingerprint(seed), /strict validation rule/);
  }
});
