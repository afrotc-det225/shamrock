const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(options = {}) {
  const calls = [];
  let held = options.held || false;
  const lock = {
    hasLock: () => held,
    waitLock(timeout) {
      calls.push(['wait', timeout]);
      if (options.acquireError) throw options.acquireError;
      assert.equal(held, false);
      held = true;
    },
    releaseLock() {
      assert.equal(held, true);
      calls.push(['release']);
      held = false;
    },
  };
  const assertHeld = (label) => {
    assert.equal(held, true, `${label} must occur under the attendance write lock`);
    calls.push([label]);
  };
  const spreadsheet = {
    flush() {
      assertHeld('flush');
      if (options.flushError) throw options.flushError;
    },
  };
  const context = vm.createContext({
    Date, Map, Set, Error,
    Log: { info() {}, warn() {}, error() {} },
    Schemas: { getTabSchema: () => undefined },
    Config: { getBackendId: () => 'backend', getFrontendId: () => 'frontend' },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: spreadsheet,
    ...options.globals,
  });
  for (const file of ['services/attendance.ts', 'services/excusals.ts']) {
    const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
    });
    vm.runInContext(outputText, context, { filename: file });
  }
  return { context, calls, spreadsheet, assertHeld, isHeld: () => held };
}

test('attendance writes acquire once, flush before release, and return the operation result', () => {
  const f = fixture();
  const result = f.context.AttendanceService.withWriteLock(() => {
    f.assertHeld('write');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(f.calls, [['wait', 120000], ['write'], ['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});

test('nested attendance operations do not reacquire or release their caller lock', () => {
  const f = fixture();
  f.context.AttendanceService.withWriteLock(() => {
    f.assertHeld('outer');
    f.context.AttendanceService.withWriteLock(() => f.assertHeld('inner'));
    f.assertHeld('after-inner');
  });
  assert.deepEqual(f.calls, [
    ['wait', 120000], ['outer'], ['inner'], ['after-inner'], ['flush'], ['release'],
  ]);
  const existing = fixture({ held: true });
  const failure = new Error('operation failed');
  assert.throws(() => existing.context.AttendanceService.withWriteLock(() => {
    existing.assertHeld('external-owner');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(existing.calls, [['external-owner']]);
  assert.equal(existing.isHeld(), true);
});

test('failed attendance operations flush completed writes and release their owned lock', () => {
  const f = fixture();
  const failure = new Error('mirror interrupted');
  assert.throws(() => f.context.AttendanceService.withWriteLock(() => {
    f.assertHeld('append');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(f.calls, [['wait', 120000], ['append'], ['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});

test('a flush error still releases the attendance lock and remains a failed operation', () => {
  const failure = new Error('flush interrupted');
  const f = fixture({ flushError: failure });
  assert.throws(() => f.context.AttendanceService.withWriteLock(() => f.assertHeld('write')),
    error => error === failure);
  assert.deepEqual(f.calls, [['wait', 120000], ['write'], ['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});

test('lock contention failure makes no attendance writes and does not release another owner', () => {
  const failure = new Error('lock unavailable');
  const f = fixture({ acquireError: failure });
  assert.throws(() => f.context.AttendanceService.withWriteLock(() => {
    throw new Error('must not run');
  }), error => error === failure);
  assert.deepEqual(f.calls, [['wait', 120000]]);
});

test('matrix rebuild reads its source and replaces both projections under one lock', () => {
  const f = fixture();
  const matrix = name => ({
    getName: () => name,
    getMaxRows: () => 3,
    getMaxColumns: () => 7,
    clear: () => f.assertHeld('clear-backend'),
    clearContents: () => f.assertHeld('clear-frontend'),
    getRange: () => ({
      clearDataValidations: () => f.assertHeld('validation'),
      setValues: () => f.assertHeld('write-headers'),
    }),
  });
  const backend = matrix('Attendance Matrix Backend'), frontend = matrix('Attendance');
  f.context.SheetUtils = {
    getSheet(_id, name) {
      f.assertHeld(`open:${name}`);
      return name === 'Attendance' ? frontend : { name };
    },
    readTable(sheet) {
      f.assertHeld(`read:${sheet.name}`);
      return { rows: [] };
    },
    trimRowsToDataCount: () => f.assertHeld('trim'),
  };
  f.spreadsheet.openById = () => {
    f.assertHeld('open-backend');
    return { getSheetByName: () => backend };
  };
  f.context.AttendanceService.rebuildMatrix();
  assert.equal(f.calls.filter(c => c[0] === 'wait').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'clear-backend').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'clear-frontend').length, 1);
  assert.deepEqual(f.calls.slice(-2), [['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});

test('excusal request persists its attendance entry before projection under the shared lock', () => {
  const f = fixture(), appended = [];
  f.context.SheetUtils = {
    getSheet: () => ({}),
    appendRows(_sheet, rows) {
      f.assertHeld('append');
      appended.push(...rows);
    },
  };
  f.context.AttendanceService.applyAttendanceLogEntry = entry => {
    f.assertHeld('mirror');
    assert.equal(appended.length, 1);
    assert.equal(entry, appended[0]);
  };
  f.context.ExcusalsService.updateAttendanceOnExcusalSubmission({
    last_name: 'Example', first_name: 'Cadet', event: 'TW-1 LLAB',
  });
  assert.equal(appended[0].attendance_type, 'R');
  assert.deepEqual(f.calls, [['wait', 120000], ['append'], ['mirror'], ['flush'], ['release']]);
});

test('failed excusal append cannot update attendance and still releases the shared lock', () => {
  const f = fixture(), failure = new Error('append interrupted');
  f.context.SheetUtils = {
    getSheet: () => ({}),
    appendRows() { f.assertHeld('append'); throw failure; },
  };
  f.context.AttendanceService.applyAttendanceLogEntry = () => { throw new Error('must not mirror'); };
  assert.throws(() => f.context.ExcusalsService.updateAttendanceOnExcusalSubmission({
    last_name: 'Example', first_name: 'Cadet', event: 'TW-1 LLAB',
  }), error => error === failure);
  assert.deepEqual(f.calls, [['wait', 120000], ['append'], ['flush'], ['release']]);
});

test('backend excusal edit flushes before releasing its outer lock on an early return', () => {
  const f = fixture();
  const sheet = {
    getLastColumn: () => 1,
    getLastRow: () => 3,
    getRange(row) {
      return { getValues() {
        if (row === 1) return [['decision']];
        if (f.isHeld()) f.assertHeld('backend-read');
        return [['Approved']];
      } };
    },
  };
  f.context.ExcusalsService.handleExcusalsBackendEdit({range:{
    getSheet: () => sheet, getRow: () => 3, getLastRow: () => 3,
    getColumn: () => 1, getLastColumn: () => 1,
  }});
  // Missing request_id exits the actual handler from inside its try block.
  assert.deepEqual(f.calls, [['wait', 120000], ['backend-read'], ['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});

test('excusal reconciliation flushes and releases its outer lock on configuration failure', () => {
  const f = fixture();
  f.context.Config.PROPERTY_KEYS = { EXCUSAL_MANAGEMENT_SPREADSHEET_ID: 'management' };
  f.context.Config.getScriptProperty = () => {
    f.assertHeld('configuration-read');
    return '';
  };
  assert.throws(() => f.context.ExcusalsService.reconcileManagementDecisions(), /not configured/);
  assert.deepEqual(f.calls, [['wait', 120000], ['configuration-read'], ['flush'], ['release']]);
  assert.equal(f.isHeld(), false);
});
