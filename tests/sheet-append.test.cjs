const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(options = {}) {
  const calls = [], cells = [['id', 'code'], ['ID', 'Code'], ['existing', 'A']];
  let held = !!options.outerLock, maxRows = 3;
  const lock = {
    hasLock: () => held,
    waitLock() {
      calls.push('wait');
      if (options.lockFailure) throw Error('busy');
      // Simulate the first execution committing before this waiter acquires.
      if (options.precedingAppend) { cells.push(['preceding', 'E']); maxRows++; }
      held = true;
    },
    releaseLock() { assert(held); held = false; calls.push('release'); },
  };
  const sheet = {
    getName: () => 'Audit Backend',
    getLastColumn: () => 2,
    getLastRow() { assert(held); calls.push('lastRow'); return cells.length; },
    getMaxRows: () => maxRows,
    insertRowsAfter(row, count) { assert(held); assert.equal(row, maxRows); maxRows += count; calls.push('grow'); },
    getRange(row, column, height, width) {
      assert(held);
      return {
        getValues: () => options.noHeaders ? [['', '']] : cells.slice(row - 1, row - 1 + height).map(r => r.slice(column - 1, column - 1 + width)),
        setValues(values) {
          assert(held); calls.push('write');
          if (options.writeFailure) throw Error('write failed');
          assert(row + height - 1 <= maxRows);
          values.forEach((r, i) => { cells[row - 1 + i] = [...r]; });
        },
      };
    },
  };
  const context = vm.createContext({
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush() { assert(held); calls.push('flush'); if (options.flushFailure) throw Error('flush failed'); } },
    Schemas: { getTabSchema: () => undefined }, Log: { warn() {} },
  });
  const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/utils/sheets.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText, context);
  return { append: rows => context.SheetUtils.appendRows(sheet, rows), calls, cells, held: () => held };
}

test('append allocates after a competing writer commits and preserves explicit clears', () => {
  const f = fixture({ precedingAppend: true });
  f.append([{ id: 'next', code: '' }, { id: 'last', code: 'P' }]);
  assert.deepEqual(f.cells.slice(2), [['existing', 'A'], ['preceding', 'E'], ['next', ''], ['last', 'P']]);
  assert.deepEqual(f.calls, ['wait', 'lastRow', 'grow', 'write', 'flush', 'release']);
});

test('append reuses an outer writer lock without releasing or flushing it', () => {
  const f = fixture({ outerLock: true });
  f.append([{ id: 'next', code: 'P' }]);
  assert.deepEqual(f.calls, ['lastRow', 'grow', 'write']);
  assert(f.held());
});

test('append fails closed on lock contention before reading or writing records', () => {
  const f = fixture({ lockFailure: true });
  assert.throws(() => f.append([{ id: 'next' }]), /busy/);
  assert.deepEqual(f.calls, ['wait']);
  assert.equal(f.cells.length, 3);
});

for (const [option, message] of [['writeFailure', /write failed/], ['flushFailure', /flush failed/], ['noHeaders', /no machine headers/]]) {
  test(`append releases its owned lock after ${option}`, () => {
    const f = fixture({ [option]: true });
    assert.throws(() => f.append([{ id: 'next' }]), message);
    assert.equal(f.held(), false);
    assert.deepEqual(f.calls.slice(-2), ['flush', 'release']);
    if (option === 'noHeaders') assert.equal(f.cells.length, 3);
  });
}

test('empty append does not acquire a lock or touch the spreadsheet', () => {
  const f = fixture(); f.append([]); assert.deepEqual(f.calls, []);
});

test('excusal repair entry point delegates sparse reconciliation without rebuilding attendance', () => {
  const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  const result = { repaired: 2 }; let calls = 0;
  const context = vm.createContext({
    ExcusalsService: { reconcileManagementDecisions() { calls++; return result; } },
    SetupService: { rebuildAttendanceMatrix() { throw Error('Destructive replay must not run'); } },
  });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None } }).outputText, context);
  assert.equal(context.repairExcusalDecisionAttendanceHistory(), result);
  assert.equal(calls, 1);
});

test('audit schema and row allocation run inside the same writer lock', () => {
  let held = false; const order = [], appended = [];
  const sheet = { getLastRow() { assert(held); return 2; }, getMaxRows: () => 10 };
  const context = vm.createContext({
    Date, Error,
    AttendanceService: { withWriteLock(fn) { assert.equal(held, false); held = true; order.push('lock'); try { return fn(); } finally { held = false; order.push('unlock'); } } },
    Config: { getBackendId: () => 'backend-test' },
    SheetUtils: {
      getSheet() { assert(held); return sheet; },
      ensureSchemaColumns() { assert(held); order.push('schema'); return ['audit_id', 'action', 'result']; },
      appendRows(_sheet, rows) { assert(held); order.push('append'); appended.push(...rows); },
    },
    Session: { getActiveUser: () => ({ getEmail: () => 'operator@example.test' }), getTemporaryActiveUserKey: () => 'test-key' },
    SpreadsheetApp: { getActiveSpreadsheet: () => null },
    Utilities: { getUuid: () => 'test-audit-id' }, Log: { warn() {} },
  });
  const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/services/audit.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText, context);
  assert.equal(context.AuditService.logBatch([{ action: 'repair', result: 'ok' }]), true);
  assert.deepEqual(order, ['lock', 'schema', 'append', 'unlock']);
  assert.equal(appended[0].action, 'repair');
  assert.equal(appended[0].audit_id, 'test-audit-id');
  context.AttendanceService.withWriteLock = () => { throw Error('busy'); };
  assert.equal(context.AuditService.logBatch([{ action: 'repair', result: 'ok' }]), false);
  assert.equal(appended.length, 1);
});
