import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildFrontendPreview } from '../../scripts/lib/frontend-preview.mjs';

const fixtureRows = (book, sheetId) => book.requests.find(r => r.updateCells?.start.sheetId === sheetId)?.updateCells.rows.map(row => row.values.map(cell => cell.userEnteredValue.stringValue ?? cell.userEnteredValue.numberValue));
const ruleFor = (book, target) => book.postTableRequests.find(r => JSON.stringify(r.setDataValidation.range) === JSON.stringify(target))?.setDataValidation.rule;

test('preview contracts preserve the production distinction between chip, arrow, plain validation and file chips', () => {
  const { main, excusals } = buildFrontendPreview();
  const directory = main.cellPresentation.filter(c => c.sheetId === 103);
  assert.deepEqual(Object.fromEntries(directory.map(c => [c.field, c.style])), {
    as_year: 'chip', flight: 'arrow', squadron: 'arrow', rank: 'plain', university: 'plain',
    dorm: 'arrow', cip_broad_area: 'plain', desired_assigned_afsc: 'arrow', home_state: 'plain',
    flight_path_status: 'arrow', photo_link: 'file-chip',
  });
  assert.equal(main.dropdownSeeds.length, 1);
  assert.equal(main.dropdownSeeds[0].preserveNativeValidation, true);
  assert.equal(main.dropdownSeeds[0].field, 'as_year');
  assert.equal(excusals.dropdownSeeds.length, 0);
  assert.deepEqual(main.cellPresentation.filter(c => c.preserveNativeValidation).map(c => c.field ?? 'attendance_codes'), ['as_year', 'flight', 'squadron', 'attendance_codes']);
  assert.equal(excusals.cellPresentation.every(c => c.preserveNativeValidation), true);
  for (const book of [main, excusals]) {
    assert.equal(book.requests.some(r => r.setDataValidation), false, 'Table configuration must precede validation');
    for (const contract of book.cellPresentation.filter(c => c.style !== 'file-chip')) {
      const rule = ruleFor(book, contract.range);
      assert.equal(rule.strict, true);
      assert.equal(rule.showCustomUi, contract.style !== 'plain');
      assert.equal(rule.condition.type, 'ONE_OF_RANGE');
      assert.equal(rule.condition.values[0].userEnteredValue, contract.source);
      assert.match(contract.source, /^='[^']+'!\$[A-Z]+\$3:\$[A-Z]+\$\d+$/);
    }
  }
  assert.deepEqual(main.photoChipTargets, [directory.find(c => c.field === 'photo_link')]);
  const rows = fixtureRows(main, 103);
  assert.equal(rows.slice(2).every(row => row[19] === ''), true, 'private photo bindings are applied separately');
  assert.equal(JSON.stringify(main.photoChipTargets).includes('https://'), false);
});

test('preview validation options match canonical configuration and every nonempty fictional field is valid', () => {
  const context = vm.createContext({});
  const source = readFileSync(new URL('../../src/utils/arrays.ts', import.meta.url), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None } }).outputText, context);
  const canonical = JSON.parse(JSON.stringify(context.Arrays));
  const { main } = buildFrontendPreview(), legend = fixtureRows(main, 105), rows = fixtureRows(main, 103);
  const names = { attendance_code_options: 'ATTENDANCE_CODES',
    cadet_rank_options: 'CADET_RANKS', rank_options: 'RANKS', honorific_options: 'HONORIFICS', university_options: 'UNIVERSITIES',
    dorm_options: 'DORMS', cip_broad_area_options: 'CIP_BROAD_AREAS', afsc_options: 'AFSC_OPTIONS', home_state_options: 'HOME_STATES', flight_path_status_options: 'FLIGHT_PATH_STATUSES' };
  for (const [field, name] of Object.entries(names)) {
    const column = legend[0].indexOf(field);
    assert.notEqual(column, -1);
    assert.deepEqual(legend.slice(2).map(row => row[column]).filter(Boolean), canonical[name], field);
  }
  const years = legend.slice(2).map(row => row[0]).filter(Boolean);
  assert.deepEqual(years, ['AS100', 'AS200', 'AS300', 'AS400'], 'preserve the existing native seed source extent');
  assert.equal(years.every(year => canonical.AS_YEARS.includes(year)), true);
  for (const [key, name, expected] of [['flight_options', 'FLIGHTS', ['Alpha', 'Bravo', 'Charlie', 'Delta']], ['squadron_options', 'SQUADRONS', ['Blue', 'Gold']]]) {
    const column = legend[0].indexOf(key), values = legend.slice(2).map(row => row[column]).filter(Boolean);
    assert.deepEqual(values, expected, 'preserve the native seed source extent');
    assert.equal(values.every(value => canonical[name].includes(value)), true);
  }
  for (const contract of main.cellPresentation.filter(c => c.sheetId === 103 && c.values)) {
    const column = rows[0].indexOf(contract.field);
    assert.equal(rows.slice(2).every(row => row[column] === '' || contract.values.includes(row[column])), true, contract.field);
  }
  assert.equal(rows.slice(2).every(row => row[11] === '14 - Engineering'), true);
});

test('attendance preserves plain text and ordinary banding without invented semantic colors', () => {
  const { main, excusals } = buildFrontendPreview();
  assert.equal(main.requests.some(r => r.addConditionalFormatRule?.rule.ranges.some(range => range.sheetId === 104)), false);
  const attendance = main.cellPresentation.find(c => c.sheetId === 104);
  assert.equal(ruleFor(main, attendance.range).showCustomUi, false);
  const directFormats = main.requests.filter(r => {
    const cell = r.repeatCell;
    return cell?.range.sheetId === 104 && cell.range.endRowIndex - cell.range.startRowIndex === 1
      && cell.range.startColumnIndex >= 7 && cell.cell.userEnteredFormat?.backgroundColor;
  });
  assert.equal(directFormats.length, 0, 'semantic cell fills cannot substitute for native validation appearance');
  assert.equal(JSON.stringify({ main, excusals }).includes('nativeChipColors'), false);
});
