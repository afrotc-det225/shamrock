const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
const compiled = ['utils/arrays.ts', 'config/schemas.ts', 'services/attendance.ts', 'services/setup.ts'].map(file => ts.transpileModule(fs.readFileSync(path.join(root, 'src', file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None } }).outputText);
const fixed = ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'llab_attendance_pct'];
const logHeaders = ['submission_id', 'submitted_at', 'event', 'attendance_type', 'email', 'name', 'flight', 'cadets'];
const submitted = '2026-11-13T17:00:00.000Z';
const rawRow = (cadets = 'North, One', event = 'Event A', timestamp = new Date(submitted)) => [timestamp, 'reporter@example.test', 'Reporter', event, cadets];
const logRow = (id = 'att-legacy', code = 'P', cadets = 'North, One', timestamp = submitted) => [id, timestamp, 'Event A', code, 'reporter@example.test', 'Reporter', 'Other', cadets];
function fixture(responses = [rawRow()], records = []) {
  const state = { held: false, writes: 0, projections: 0, fail: '', beforeAcquire: null };
  const sheets = new Map();
  function sheet(book, name, cells) {
    let capacity = cells.length;
    const sheetId = sheets.size + 1;
    const s = { cells, getName: () => name, getSheetId: () => sheetId, getParent: () => ({ getId: () => book }), getLastRow: () => cells.length, getLastColumn: () => cells[0].length, getMaxRows: () => capacity,
      insertRowsAfter(row, count) { assert(state.held); assert.equal(row, capacity); capacity += count; },
      clearConditionalFormatRules() {}, setConditionalFormatRules() {},
      getRange(row, col, height = 1, width = 1) { return {
        getValues() { assert(state.held); return Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => cells[row - 1 + i]?.[col - 1 + j] ?? '')); },
        setValues(values) { assert(state.held); assert(row + values.length - 1 <= capacity); values.forEach((r, i) => { cells[row - 1 + i] ??= []; r.forEach((v, j) => cells[row - 1 + i][col - 1 + j] = v); }); state.writes++; if (state.fail === 'lost-append') throw Error('append response lost'); },
      }; },
    }; sheets.set(`${book}/${name}`, s); return s;
  }
  const response = sheet('backend', 'Responses', [['Timestamp', 'Email Address', 'Name', 'Select Event (Other)', 'Cadets (All) AS400'], ...responses]);
  const log = sheet('backend', 'Attendance Backend', [logHeaders.slice(), logHeaders.slice(), ...records.map(r => r.slice())]);
  const people = [['North', 'One', 'AS400', 'Alpha', 'Blue', '', '', 'R'], ['West', 'Three', 'AS400', 'Alpha', 'Blue', '', '', 'R']];
  const backend = sheet('backend', 'Attendance Matrix Backend', [[...fixed, 'Event A'], [...fixed, 'Event A'], ...people.map(r => r.slice())]);
  const frontend = sheet('frontend', 'Attendance', [[...fixed, 'Event A'], [...fixed, 'Event A'], ...people.map(r => r.slice()).reverse()]);
  const events = sheet('backend', 'Events Backend', [['display_name', 'event_type', 'status'], ['Name', 'Type', 'Status'], ['Event A', 'other', '']]);
  sheet('backend', 'Directory Backend', [['email', 'flight'], ['Email', 'Flight'], ['reporter@example.test', 'Alpha']]);
  const rule = { whenFormulaSatisfied() { return this; }, setBackground() { return this; }, setRanges() { return this; }, build() { return {}; } };
  const context = vm.createContext({ Date, Map, Set, Error, console,
    Config: { RESOURCE_NAMES: { ATTENDANCE_FORM_SHEET: 'Responses' }, getBackendId: () => 'backend', getFrontendId: () => 'frontend', getBackendSheet: name => sheets.get(`backend/${name}`) },
    FormService: { isAttendanceCadetQuestionTitle: title => title.startsWith('Cadets (') },
    LockService: { getScriptLock: () => ({ hasLock: () => state.held, waitLock() { assert(!state.held); state.beforeAcquire?.(); state.held = true; }, releaseLock() { state.held = false; } }) },
    SpreadsheetApp: { flush() { assert(state.held); }, newConditionalFormatRule: () => rule },
    SheetUtils: { getSheet: (id, name) => sheets.get(`${id}/${name}`), readTable(s) { assert(state.held); return { headers: s.cells[0].slice(), rows: s.cells.slice(2).map(r => Object.fromEntries(s.cells[0].map((h, i) => [h, r[i] ?? '']))) }; },
      appendRows(s, rows) { assert(state.held); const start = Math.max(3, s.getLastRow() + 1); const end = start + rows.length - 1; if (end > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), end - s.getMaxRows()); s.getRange(start, 1, rows.length, s.getLastColumn()).setValues(rows.map(r => s.cells[0].map(h => r[h] ?? ''))); } },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => Array.from(require('node:crypto').createHash('sha256').update(value).digest()) },
    ProgressService: { report() {} }, Log: { info() {}, warn() {} },
    Sheets: { Spreadsheets: { batchUpdate({ requests }, id) {
      assert(state.held); if (state.fail === id) throw Error('projection failed');
      for (const { updateCells } of requests) {
        assert.equal(updateCells.fields, 'userEnteredValue');
        const { sheetId, rowIndex, columnIndex } = updateCells.start;
        const s = [...sheets.values()].find(sheet => sheet.getParent().getId() === id && sheet.getSheetId() === sheetId);
        updateCells.rows.forEach(({ values }, i) => values.forEach((cell, j) => { s.cells[rowIndex + i][columnIndex + j] = cell.userEnteredValue?.stringValue ?? ''; }));
      }
      state.projections++;
    } } },
  }); compiled.forEach(code => vm.runInContext(code, context));
  return { state, response, log, backend, frontend, events, run: () => context.SetupService.processAttendanceFormBacklog() };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('backlog normalizes Date/ISO receipts and projects a later durable clear instead of old P', () => {
  const records = [logRow('att-legacy', 'P', 'North, One', new Date(submitted)), logRow('manual-later', '', 'North, One', '2026-11-14T17:00:00Z')];
  const f = fixture(undefined, records); const before = plain(f.log.cells);
  assert.deepEqual(plain(f.run()), { appended: 0, repaired: 0 });
  assert.deepEqual(plain(f.log.cells), before);
  assert.equal(f.frontend.cells[3][7], ''); assert.equal(f.backend.cells[2][7], '');
});
test('backlog replaces blank legacy cadet receipts by append while leaving original records immutable', () => {
  const f = fixture([rawRow('North, One, West, Three')], [logRow('att-empty', 'P', '')]);
  assert.deepEqual(plain(f.run()), { appended: 0, repaired: 1 });
  assert.equal(f.log.cells[2][7], ''); assert.equal(f.log.cells[3][7], 'North, One; West, Three');
  assert.equal(f.state.writes, 1); assert.equal(f.state.projections, 2);
  assert.deepEqual(plain(f.run()), { appended: 0, repaired: 0 }); assert.equal(f.log.cells.length, 4);
});
test('delayed missing response fails before appending over a later attendance decision', () => {
  const f = fixture(undefined, [logRow('decision-newer', 'E', 'North, One', '2026-11-14T17:00:00Z')]);
  assert.throws(f.run, /delayed attendance response/); assert.equal(f.state.writes, 0); assert.equal(f.state.projections, 0);
});
test('backlog retry heals an interrupted projection without appending a second receipt', () => {
  const f = fixture(); f.state.fail = 'frontend'; assert.throws(f.run, /projection failed/); assert.equal(f.log.cells.length, 3);
  f.state.fail = ''; assert.deepEqual(plain(f.run()), { appended: 0, repaired: 0 }); assert.equal(f.log.cells.length, 3); assert.equal(f.frontend.cells[3][7], 'P');
});
test('backlog retry recognizes an uncertain successful append', () => {
  const f = fixture(); f.state.fail = 'lost-append'; assert.throws(f.run, /append response lost/); assert.equal(f.state.projections, 0);
  f.state.fail = ''; f.run(); assert.equal(f.log.cells.length, 3); assert.equal(f.frontend.cells[3][7], 'P');
});
test('backlog preserves an unlogged frontend clear on existing-receipt retry and reports the conflict', () => {
  const f = fixture(undefined, [logRow()]); f.frontend.cells[3][7] = '';
  assert.throws(f.run, /frontend edits need review/); assert.equal(f.frontend.cells[3][7], ''); assert.equal(f.log.cells.length, 3);
});
test('backlog validates timestamps and ambiguous checkbox serialization without inventing records', () => {
  for (const row of [rawRow('North, One', 'Event A', 'bad date'), rawRow('North, One, Broken')]) {
    const f = fixture([row]); assert.throws(f.run, /timestamp|ambiguous cadet list/); assert.equal(f.state.writes, 0);
  }
});
test('backlog skips removed or canceled events and rejects conflicting duplicate response identities', () => {
  const f = fixture([rawRow('North, One', 'Removed Event')]); assert.deepEqual(plain(f.run()), { appended: 0, repaired: 0 });
  const c = fixture(); c.events.cells[2][2] = 'cancelled'; assert.deepEqual(plain(c.run()), { appended: 0, repaired: 0 });
  const d = fixture([rawRow('North, One'), rawRow('West, Three')]); assert.throws(d.run, /Duplicate attendance response identities disagree/); assert.equal(d.state.writes, 0);
});
test('backlog acquires the shared lock before checking a concurrently committed receipt', () => {
  const f = fixture(); f.state.beforeAcquire = () => { f.log.cells.push(logRow()); };
  assert.deepEqual(plain(f.run()), { appended: 0, repaired: 0 }); assert.equal(f.log.cells.length, 3); assert.equal(f.state.held, false);
});

test('backlog rejects an existing same-response payload disagreement without modifying or appending records', () => {
  for (const existing of [logRow('att-existing', 'P', 'West, Three'), logRow('att-existing', 'E')]) {
    const f = fixture(undefined, [existing]);
    assert.throws(f.run, /existing log payload/); assert.equal(f.log.cells.length, 3); assert.equal(f.state.writes, 0);
  }
});
