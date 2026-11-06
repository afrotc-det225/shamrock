import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeDropdownRuleFingerprint, validateNativeDropdownManifest, planNativeDropdownCopy, cloneNativeTemplate }
  from '../../scripts/lib/native-dropdown-templates.mjs';

const copy = value => structuredClone(value);
const rule = { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Data Legend'!$A$3:$A$6" }] },
  strict: true, showCustomUi: true, inputMessage: 'Choose a decision.' };
function fixture() {
  const manifest = { version: 1, release: 'native-chips-v1', sourceBinding: 'excusal-native-template', sourceDriveVersion: '7',
    roles: [{ role: 'excusal-decision', sheetBinding: 'dropdown-seeds', headers: ['seed_key', 'decision'], field: 'decision',
      headerRowIndex: 0, seedRowIndex: 2, rule: copy(rule), ruleFingerprint: nativeDropdownRuleFingerprint(rule) }] };
  const cells = values => values.map(row => ({ values: row.map(stringValue => ({ userEnteredValue: { stringValue } })) }));
  const source = { properties: { sheetId: 10, gridProperties: { rowCount: 6, columnCount: 2 } },
    data: [{ rowData: cells([['decision', 'seed_key'], ['Decision', 'Seed'], ['Approved', 'decision']]) }] };
  source.data[0].rowData[2].values[0].dataValidation = copy(rule);
  const destination = { properties: { sheetId: 20, gridProperties: { rowCount: 102, columnCount: 3 } },
    data: [{ rowData: cells([['person', 'decision', 'event'], ['Name', 'Decision', 'Event'], ['Fictional cadet', 'Denied', 'Fictional event']]) }] };
  return { manifest, role: 'excusal-decision', sourceFile: { binding: manifest.sourceBinding, version: '7', mimeType: 'application/vnd.google-apps.spreadsheet' },
    spreadsheet: { spreadsheetId: 'fictional-workbook', sheets: [source, destination] }, bindings: { 'dropdown-seeds': 10, 'blue-excusals': 20 },
    target: { sheetBinding: 'blue-excusals', headers: ['person', 'event', 'decision'], field: 'decision', headerRowIndex: 0, startRowIndex: 2, endRowIndex: 102 } };
}

test('native validation copying follows actual headers and cannot write values or recreate rules', () => {
  const input = fixture(), before = copy(input), plan = planNativeDropdownCopy(input);
  assert.deepEqual(input, before);
  assert.deepEqual(plan, { requests: [{ copyPaste: {
    source: { sheetId: 10, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
    destination: { sheetId: 20, startRowIndex: 2, endRowIndex: 102, startColumnIndex: 1, endColumnIndex: 2 },
    pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL',
  } }] });
  assert.equal(plan.requests.some(request => request.setDataValidation || request.updateCells || request.updateTable), false);
  input.target.startRowIndex = 50;
  assert.equal(planNativeDropdownCopy(input).requests[0].copyPaste.destination.startRowIndex, 50, 'growth copies only the caller-selected new extent');
});

test('wrong legend, weaker rules, ambiguous seed, version drift and unsafe extents fail before returning mutations', () => {
  for (const mutate of [
    input => { input.sourceFile.version = '8'; },
    input => { input.sourceFile.binding = 'wrong-template'; },
    input => { input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation.strict = false; },
    input => { input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation.condition.values[0].userEnteredValue = "='Wrong Legend'!$A$3:$A$6"; },
    input => { input.spreadsheet.sheets[0].data.push({ startRow: 2, startColumn: 0, rowData: [{ values: [{ dataValidation: { ...rule, strict: false } }] }] }); },
    input => { input.spreadsheet.sheets[1].data[0].rowData[0].values[1].userEnteredValue = { formulaValue: '="decision"' }; },
    input => { input.target.endRowIndex = 103; },
    input => { input.target.startRowIndex = 1; },
    input => { input.target.endRowIndex = input.target.startRowIndex; },
    input => { Object.assign(input.target, { sheetBinding: 'dropdown-seeds', headers: ['seed_key', 'decision'], startRowIndex: 2, endRowIndex: 4 }); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planNativeDropdownCopy(input), /Native dropdown template:/);
  }
});

test('the committed manifest permits logical bindings and rejects raw binding fields or inconsistent fingerprints', () => {
  const input = fixture(); assert.equal(validateNativeDropdownManifest(input.manifest), input.manifest);
  for (const mutate of [
    value => { value.sourceFileId = 'must-remain-private'; },
    value => { value.roles[0].ruleFingerprint = '0'.repeat(64); },
    value => { value.roles.push(copy(value.roles[0])); },
  ]) { const value = copy(input.manifest); mutate(value); assert.throws(() => validateNativeDropdownManifest(value)); }
});

test('fingerprints normalize only an optional leading equals sign on absolute quoted legend ranges', () => {
  const input = fixture(), seed = input.spreadsheet.sheets[0].data[0].rowData[2].values[0].dataValidation;
  seed.condition.values[0].userEnteredValue = "'Data Legend'!$A$3:$A$6";
  const before = copy(seed);
  assert.equal(nativeDropdownRuleFingerprint(seed), nativeDropdownRuleFingerprint(rule));
  assert.deepEqual(seed, before, 'fingerprinting must not change the native read-back');
  assert.equal(planNativeDropdownCopy(input).requests.length, 1);
  for (const invalid of ["='Data Legend'!A3:A6", '=DataLegend!$A$3:$A$6', " ='Data Legend'!$A$3:$A$6", "=='Data Legend'!$A$3:$A$6"]) {
    const altered = copy(rule); altered.condition.values[0].userEnteredValue = invalid;
    assert.throws(() => nativeDropdownRuleFingerprint(altered), /absolute legend range/);
  }
  const different = copy(rule); different.condition.values[0].userEnteredValue = "='Data Legend'!$A$4:$A$7";
  assert.notEqual(nativeDropdownRuleFingerprint(different), nativeDropdownRuleFingerprint(rule));
});

function cloneFixture() {
  const entry = { binding: 'excusal-native-template', role: 'excusal-review', sourceFileId: 'fictional-master', driveVersion: '7', ownerEmail: 'automation@example.invalid' };
  const source = { id: entry.sourceFileId, name: 'Fictional native master', version: '7', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false,
    owners: [{ emailAddress: entry.ownerEmail }], permissions: [{ type: 'user', role: 'owner', emailAddress: entry.ownerEmail }],
    appProperties: { shamrockTemplateBinding: entry.binding, shamrockTemplateRole: entry.role } };
  const destination = { ...copy(source), id: 'fictional-preview', name: 'Fictional preview', version: '1' }, calls = [];
  const io = {
    async readTemplateMetadata(id) { calls.push(['read-master', id]); return copy(source); },
    async copyFile(options) { calls.push(['copy', options]); return { id: destination.id }; },
    async readCopiedMetadata(id) { calls.push(['read-copy', id]); return copy(destination); },
  };
  return { entry, source, destination, calls, io };
}

test('native cloning verifies pinned source and private copy without any source mutation', async () => {
  const f = cloneFixture(), before = copy(f.source);
  assert.equal(await cloneNativeTemplate(f.io, f.entry, { title: 'Fictional preview' }), 'fictional-preview');
  assert.deepEqual(f.source, before);
  assert.deepEqual(f.calls.filter(call => call[0] === 'copy'), [['copy', { sourceFileId: 'fictional-master', title: 'Fictional preview' }]]);
  assert.equal(f.calls.filter(call => call[0] === 'read-master').length, 2, 'source version is checked again to detect a concurrent edit');
});

test('source drift and widened permissions block copying; reused identity or concurrent source edits block success', async () => {
  for (const mutate of [
    f => { f.source.version = '8'; },
    f => { f.source.id = 'wrong-source'; },
    f => { f.source.appProperties.shamrockTemplateRole = 'wrong-role'; },
    f => { f.source.permissions.push({ type: 'anyone', role: 'reader' }); },
    f => { f.source.owners[0].emailAddress = 'other@example.invalid'; },
  ]) {
    const f = cloneFixture(); mutate(f);
    await assert.rejects(cloneNativeTemplate(f.io, f.entry, { title: 'Fictional preview' }));
    assert.equal(f.calls.some(call => call[0] === 'copy'), false);
  }
  let f = cloneFixture(); f.destination.id = f.source.id;
  await assert.rejects(cloneNativeTemplate(f.io, f.entry, { title: 'Fictional preview' }), /distinct file/);
  f = cloneFixture(); const copyFile = f.io.copyFile;
  f.io.copyFile = async options => { const result = await copyFile(options); f.source.version = '8'; return result; };
  await assert.rejects(cloneNativeTemplate(f.io, f.entry, { title: 'Fictional preview' }), /source changed during copy/);
  f = cloneFixture(); f.destination.permissions.push({ type: 'anyone', role: 'reader' });
  await assert.rejects(cloneNativeTemplate(f.io, f.entry, { title: 'Fictional preview' }), /owner-only access/);
});
