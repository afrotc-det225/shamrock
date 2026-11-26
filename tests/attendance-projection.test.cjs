const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
const source = ['utils/arrays.ts', 'config/schemas.ts', 'services/attendance.ts', 'forms/handlers.ts'].map(file =>
  ts.transpileModule(fs.readFileSync(path.join(root, 'src', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText);
const fixed = ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'llab_attendance_pct'];
const logHeaders = ['submission_id', 'submitted_at', 'event', 'attendance_type', 'email', 'name', 'flight', 'cadets'];
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const state = { held: false, beforeWrite: null, afterAppend: null, fail: '', writes: [], reads: [], audits: [], locks: [], uuid: 0 };
  const sheets = new Map();
  function makeSheet(id, name, headers, rows) {
    const cells = [headers.slice(), headers.slice(), ...rows.map(row => row.slice())];
    const sheetId = sheets.size;
    const cellData = cells.map(row => row.map(value => ({ userEnteredValue: { stringValue: String(value) } })));
    let capacity = cells.length;
    const sheet = { cells, cellData, getSheetId: () => sheetId, getName: () => name, getParent: () => ({ getId: () => id }),
      getLastRow: () => cells.length, getLastColumn: () => headers.length, getMaxRows: () => capacity,
      insertRowsAfter(after, count) { assert.equal(after, capacity); capacity += count; },
      getRange(row, col, height = 1, width = 1) {
        return {
          getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => cells[row + i - 1]?.[col + j - 1] ?? '')),
          setValues(values) {
            assert(state.held, 'durable append must be locked');
            assert(row + values.length - 1 <= capacity);
            if (name === 'Attendance Backend' && state.fail === 'append') throw Error('append failed');
            values.forEach((values, i) => values.forEach((value, j) => { cells[row + i - 1] ??= []; cells[row + i - 1][col + j - 1] = value; }));
            state.writes.push({ id, name, row, col, values: clone(values) });
            if (name === 'Attendance Backend') state.afterAppend?.();
            if (name === 'Attendance Backend' && state.fail === 'append-response') throw Error('append response lost');
          },
        };
      },
    };
    sheets.set(`${id}/${name}`, sheet);
    return sheet;
  }
  const backend = makeSheet('backend', 'Attendance Matrix Backend', [...fixed, 'Event A', 'Event B'], [
    ['North', 'One', 'AS400', 'Alpha', 'Blue', '', '', 'R', 'A'],
    ['South', 'Two', 'AS300', 'Bravo', 'Blue', '', '', 'R', 'A'],
    ['West', 'Three', 'AS200', 'Alpha', 'Blue', '', '', 'R', 'A'],
  ]);
  const frontend = makeSheet('frontend', 'Attendance', [...fixed, 'Event B', 'Event A'], [
    ['West', 'Three', 'AS200', 'Alpha', 'Blue', '', '', 'A', 'R'],
    ['South', 'Two', 'AS300', 'Bravo', 'Blue', '', '', 'A', 'R'],
    ['North', 'One', 'AS400', 'Alpha', 'Blue', '', '', 'A', 'R'],
  ]);
  const directory = makeSheet('backend', 'Directory Backend', fixed, backend.cells.slice(2).map(row => row.slice(0, 7)));
  const events = makeSheet('backend', 'Events Backend', ['event_id', 'display_name', 'event_type', 'status'], [['event.a', 'Event A', 'llab', ''], ['event.b', 'Event B', 'secondary', '']]);
  const log = makeSheet('backend', 'Attendance Backend', logHeaders, []);
  const readTable = sheet => {
    state.reads.push(sheet.getName());
    return { headers: sheet.cells[0].slice(), rows: sheet.cells.slice(2).map(row => Object.fromEntries(sheet.cells[0].map((header, i) => [header, row[i] ?? '']))) };
  };
  const context = vm.createContext({ console, Date, Map, Set, Error,
    Config: { getBackendId: () => 'backend', getFrontendId: () => 'frontend', getBackendSheet: name => sheets.get(`backend/${name}`) },
    SheetUtils: { getSheet: (id, name) => sheets.get(`${id}/${name}`), readTable,
      appendRows(sheet, records) {
        const next = Math.max(3, sheet.getLastRow() + 1), end = next + records.length - 1;
        if (end > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), end - sheet.getMaxRows());
        sheet.getRange(next, 1, records.length, sheet.getLastColumn()).setValues(records.map(record => sheet.cells[0].map(h => record[h] ?? '')));
      } },
    DirectoryService: { isOperationallyActiveCadet: () => true },
    LockService: { getScriptLock: () => ({ hasLock: () => state.held, waitLock() { assert(!state.held); state.held = true; state.locks.push('acquire'); }, releaseLock() { state.held = false; state.locks.push('release'); } }) },
    SpreadsheetApp: { flush() { assert(state.held); } },
    AuditService: { actorEmail: () => 'operator@example.test', logBatch(entries) { state.audits.push(...clone(entries)); return state.fail !== 'audit'; } },
    Utilities: { getUuid: () => `operation-${++state.uuid}`, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => Array.from(require('node:crypto').createHash(algorithm).update(value).digest()) },
    SetupService: { applyAttendanceBackendFormattingPublic() {} },
    FormService: { isAttendanceCadetQuestionTitle: title => title.startsWith('Cadets (') },
    Log: { info() {}, warn() {}, error() {} },
    Sheets: { Spreadsheets: { batchUpdate(request, id) {
      assert(state.held, 'projection must be locked');
      state.beforeWrite?.(id, request);
      if (state.fail === id) throw Error(`${id} projection failed`);
      for (const { updateCells } of request.requests) {
        assert.equal(updateCells.fields, 'userEnteredValue', 'projection may update only values');
        const { sheetId, rowIndex, columnIndex } = updateCells.start;
        const sheet = [...sheets.values()].find(sheet => sheet.getParent().getId() === id && sheet.getSheetId() === sheetId);
        assert(sheet, 'projection must address a real sheet ID');
        updateCells.rows.forEach(({ values }, i) => values.forEach((value, j) => {
          assert(Object.keys(value).every(key => key === 'userEnteredValue'));
          const target = sheet.cellData[rowIndex + i][columnIndex + j];
          if (value.userEnteredValue) target.userEnteredValue = clone(value.userEnteredValue);
          else delete target.userEnteredValue;
          sheet.cells[rowIndex + i][columnIndex + j] = value.userEnteredValue?.stringValue ?? '';
        }));
      }
      state.writes.push({ id, batch: clone(request) });
      if (state.fail === `${id}-response`) throw Error(`${id} response lost`);
    } } },
  });
  source.forEach(code => vm.runInContext(code, context));
  return { state, backend, frontend, directory, events, log, context, service: context.AttendanceService };
}

const entry = (cadets = 'North, One; West, Three', code = 'E', event = 'Event A') => ({ event, cadets, attendance_type: code });
const presentation = sheet => clone(sheet.cellData.map(row => row.map(({ userEnteredValue, ...metadata }) => metadata)));
function setMixedPresentation(sheet) {
  const formats = [{ type: 'TEXT' }, { type: 'NUMBER', pattern: '0.00' }, { type: 'DATE', pattern: 'yyyy-mm-dd' }, { type: 'PERCENT', pattern: '0.0%' }, null];
  sheet.cellData.forEach((row, r) => row.forEach((cell, c) => {
    const numberFormat = formats[(r + c) % formats.length];
    cell.userEnteredFormat = { ...(numberFormat ? { numberFormat: clone(numberFormat) } : {}), textFormat: { bold: true }, horizontalAlignment: 'CENTER' };
    cell.dataValidation = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'N/A' }] }, strict: false };
    cell.note = 'Existing cell note';
  }));
}

test('incremental projection writes only matched cells across independent row and event orders', () => {
  const f = fixture();
  f.state.beforeWrite = id => { if (id === 'frontend') f.frontend.cells[3][8] = 'P'; };
  assert.equal(f.service.applyAttendanceLogEntry(entry()), true);
  assert.deepEqual(f.backend.cells.slice(2).map(row => row[7]), ['E', 'R', 'E']);
  assert.deepEqual(f.frontend.cells.slice(2).map(row => row[8]), ['E', 'P', 'E']);
  assert.equal(f.state.writes.length, 2);
  assert(f.state.writes.every(write => write.batch.requests.length === 2));
  assert.deepEqual(f.state.reads, ['Attendance Matrix Backend', 'Attendance']);
  assert.deepEqual(f.state.locks, ['acquire', 'release']);
});

test('bulk fill preserves mixed per-cell formats, validation and notes with value-only updates', () => {
  const f = fixture();
  [f.backend, f.frontend].forEach(setMixedPresentation);
  const before = [presentation(f.backend), presentation(f.frontend)];
  assert.equal(f.service.fillEventColumn({ eventSelector: { all: true }, code: 'N/A' }), 6);
  assert.deepEqual([presentation(f.backend), presentation(f.frontend)], before);
  assert(f.frontend.cells.slice(2).every(row => row[7] === 'N/A' && row[8] === 'N/A'));
  const batches = f.state.writes.filter(write => write.batch);
  assert.equal(batches.length, 2, 'one provider batch per workbook');
  for (const { batch } of batches) {
    assert.deepEqual(Object.keys(batch), ['requests']);
    assert.equal(batch.requests.length, 2, 'adjacent cadets coalesce into one run per event');
    for (const request of batch.requests) {
      assert.deepEqual(Object.keys(request), ['updateCells']);
      assert.equal(request.updateCells.fields, 'userEnteredValue');
      assert.equal(request.updateCells.rows.length, 3);
      assert.deepEqual(request.updateCells.rows, Array.from({ length: 3 }, () => ({ values: [{ userEnteredValue: { stringValue: 'N/A' } }] })));
    }
  }
});

test('projection uses literal string values and groups different sheets in one workbook batch', () => {
  const f = fixture();
  f.frontend.getParent = () => ({ getId: () => 'backend' });
  const entries = [entry('North, One', '=1+1'), entry('South, Two', '00123'), entry('West, Three', '01/02/2026')];
  f.service.withWriteLock(() => f.service.applyPreparedAttendanceProjections(f.service.prepareAttendanceProjections(entries)));
  assert.deepEqual(f.backend.cells.slice(2).map(row => row[7]), ['=1+1', '00123', '01/02/2026']);
  assert.deepEqual(f.frontend.cells.slice(2).map(row => row[8]), ['01/02/2026', '00123', '=1+1']);
  assert.equal(f.state.writes.length, 1);
  const updates = f.state.writes[0].batch.requests.map(request => request.updateCells);
  assert.deepEqual(updates.map(update => update.start), [
    { sheetId: f.backend.getSheetId(), rowIndex: 2, columnIndex: 7 },
    { sheetId: f.frontend.getSheetId(), rowIndex: 2, columnIndex: 8 },
  ]);
  assert(updates.every(update => update.rows.every(row => Object.keys(row.values[0].userEnteredValue).join() === 'stringValue')));
});

test('partial identity matches, duplicate identities and duplicate event headers fail before either matrix is written', () => {
  for (const alter of [
    f => f.frontend.cells.splice(2, 1),
    f => { f.backend.cells[3][0] = 'North'; f.backend.cells[3][1] = 'One'; },
    f => f.frontend.cells[0][7] = 'Event A',
  ]) {
    const f = fixture(); alter(f);
    assert.throws(() => f.service.applyAttendanceLogEntry(entry()), /missing or ambiguous/);
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.state.held, false);
  }
});

test('explicit clears remain clear and a retry after interrupted frontend projection heals without duplicate log writes', () => {
  const f = fixture(); f.state.fail = 'frontend';
  [f.backend, f.frontend].forEach(setMixedPresentation);
  const before = [presentation(f.backend), presentation(f.frontend)];
  assert.throws(() => f.service.applyAttendanceLogEntry(entry('North, One', '')), /frontend projection failed/);
  assert.equal(f.backend.cells[2][7], '');
  assert.equal(f.frontend.cells[4][8], 'R');
  f.state.fail = '';
  f.service.applyAttendanceLogEntry(entry('North, One', ''));
  assert.equal(f.frontend.cells[4][8], '');
  assert.equal(f.log.cells.length, 2);
  assert.equal(f.state.writes.filter(write => write.id === 'backend').length, 1, 'retry does not rewrite already-correct backend');
  assert.equal('userEnteredValue' in f.backend.cellData[2][7], false, 'clear removes the stored value');
  assert.equal('userEnteredValue' in f.frontend.cellData[4][8], false);
  assert.deepEqual([presentation(f.backend), presentation(f.frontend)], before);
  assert(f.state.writes.every(write => JSON.stringify(write.batch.requests[0].updateCells.rows) === '[{"values":[{}]}]'));
});

test('lost projection response is safe to retry and already-correct cells consume no additional writes', () => {
  const f = fixture(); f.state.fail = 'frontend-response';
  assert.throws(() => f.service.applyAttendanceLogEntry(entry()), /response lost/);
  const writes = f.state.writes.length; f.state.fail = '';
  f.service.applyAttendanceLogEntry(entry());
  assert.equal(f.state.writes.length, writes);
});

test('historical pending-only projection preserves later frontend codes and intentional blanks', () => {
  const f = fixture(); f.frontend.cells[2][8] = ''; f.frontend.cells[3][8] = 'P';
  const batches = f.service.prepareAttendanceProjections([entry('North, One; South, Two; West, Three')], { frontendPendingOnly: true });
  assert.equal(batches.reduce((n, batch) => n + batch.conflicts, 0), 2);
  f.service.withWriteLock(() => f.service.applyPreparedAttendanceProjections(batches));
  assert.deepEqual(f.backend.cells.slice(2).map(row => row[7]), ['E', 'E', 'E']);
  assert.deepEqual(f.frontend.cells.slice(2).map(row => row[8]), ['', 'P', 'E']);
});

test('prepared projection rejects a changed frontend identity, header or target value before writing that workbook', () => {
  for (const alter of [
    f => { [f.frontend.cells[2], f.frontend.cells[4]] = [f.frontend.cells[4], f.frontend.cells[2]]; },
    f => { f.frontend.cells[0][8] = 'Renamed event'; },
    f => { f.frontend.cells[4][8] = ''; },
  ]) {
    const f = fixture(); const batches = f.service.prepareAttendanceProjections([entry('North, One')]);
    alter(f); const expected = clone(f.frontend.cells);
    assert.throws(() => f.service.withWriteLock(() => f.service.applyPreparedAttendanceProjections(batches)), /changed before projection|edited or sorted before projection/);
    assert.deepEqual(f.frontend.cells, expected);
    assert.equal(f.state.writes.filter(write => write.id === 'frontend').length, 0);
  }
});

test('a human sort after durable bulk append leaves the log saved and does not misaddress the frontend', () => {
  const f = fixture();
  f.state.afterAppend = () => { [f.frontend.cells[2], f.frontend.cells[4]] = [f.frontend.cells[4], f.frontend.cells[2]]; };
  assert.throws(() => f.service.fillEventColumn({ eventSelector: { names: ['Event A'] }, cadetSelector: { cadets: ['North, One'] }, code: 'E' }), /edited or sorted before projection/);
  assert.equal(f.log.cells.length, 3);
  assert.equal(f.frontend.cells[4][0], 'West');
  assert.equal(f.frontend.cells[4][8], 'R');
  assert(f.state.audits.every(audit => audit.result === 'failed'));
});

test('bulk fill appends one durable event batch before sparse projections and respects sorted frontend rows', () => {
  const f = fixture();
  f.state.beforeWrite = () => assert.equal(f.log.cells.length, 4, 'both event records must exist before projection');
  assert.equal(f.service.fillEventColumn({ eventSelector: { all: true }, cadetSelector: { flights: ['Alpha'] }, code: 'N/A' }), 4);
  assert.deepEqual(f.log.cells.slice(2).map(row => [row[2], row[3], row[7]]), [
    ['Event A', 'N/A', 'North, One; West, Three'], ['Event B', 'N/A', 'North, One; West, Three'],
  ]);
  assert.deepEqual(f.frontend.cells.slice(2).map(row => row.slice(7)), [['N/A', 'N/A'], ['A', 'R'], ['N/A', 'N/A']]);
  assert.equal(f.state.writes.filter(write => write.name === 'Attendance Backend').length, 1);
  assert.equal(f.state.writes.filter(write => write.batch).length, 2);
  assert(f.state.audits.every(audit => audit.result === 'ok'));
  assert.deepEqual(f.state.locks, ['acquire', 'release']);
});

test('bulk fill append failure or lost append response never mirrors or falsely succeeds', () => {
  for (const fail of ['append', 'append-response']) {
    const f = fixture(); f.state.fail = fail;
    assert.throws(() => f.service.fillEventColumn({ eventSelector: { all: true }, code: 'P' }), /append/);
    assert.equal(f.state.writes.filter(write => write.batch).length, 0);
    assert(f.state.audits.every(audit => audit.result === 'failed'));
    assert.equal(f.log.cells.length, fail === 'append' ? 2 : 4);
    assert.equal(f.state.held, false);
  }
});

test('interrupted bulk projection retains full durable log for targeted retry', () => {
  const f = fixture(); f.state.fail = 'frontend';
  [f.backend, f.frontend].forEach(setMixedPresentation);
  const before = [presentation(f.backend), presentation(f.frontend)];
  assert.throws(() => f.service.fillEventColumn({ eventSelector: { all: true }, code: 'P' }), /frontend/);
  assert.equal(f.log.cells.length, 4);
  assert(f.state.audits.every(audit => audit.result === 'failed'));
  f.state.fail = '';
  const logs = f.log.cells.slice(2).map(row => Object.fromEntries(logHeaders.map((h, i) => [h, row[i]])));
  f.service.withWriteLock(() => f.service.applyPreparedAttendanceProjections(f.service.prepareAttendanceProjections(logs)));
  assert(f.frontend.cells.slice(2).every(row => row[7] === 'P' && row[8] === 'P'));
  assert.equal(f.log.cells.length, 4);
  assert.deepEqual([presentation(f.backend), presentation(f.frontend)], before);
});

test('bulk fill rejects stale event definitions and unsupported codes before appending', () => {
  for (const alter of [f => { f.events.cells[2][3] = 'cancelled'; }, f => { f.events.cells[2][1] = 'Renamed'; }]) {
    const f = fixture(); alter(f);
    assert.throws(() => f.service.fillEventColumn({ eventSelector: { all: true }, code: 'P' }), /stale or ambiguous/);
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture();
  assert.throws(() => f.service.fillEventColumn({ eventSelector: { all: true }, code: '=1+1' }), /Unsupported/);
  assert.equal(f.state.writes.length, 0);
});

const responseEntry = (responseId = 'response-one', cadets = 'North, One', event = 'Event A') => ({
  submission_id: 'att-form-' + require('node:crypto').createHash('sha256').update(JSON.stringify([responseId, event])).digest('hex'),
  submitted_at: '2026-11-13T17:00:00.000Z', event, cadets, attendance_type: 'P', email: 'reporter@example.test', name: 'Attendance Reporter', flight: 'Alpha',
});
const appendFixtureRecords = (f, records) => f.service.withWriteLock(() => f.context.SheetUtils.appendRows(f.log, records));

test('native response commit is idempotent and retries project latest later records instead of stale submitted P', () => {
  const f = fixture(), response = responseEntry();
  f.service.commitAttendanceFormRows([response]);
  appendFixtureRecords(f, [{ ...response, submission_id: 'manual-later', submitted_at: '2026-11-14T17:00:00Z', attendance_type: '' }]);
  f.frontend.cells[4][8] = 'R';
  f.service.commitAttendanceFormRows([response]);
  assert.equal(f.log.cells.length, 4);
  assert.equal(f.backend.cells[2][7], '');
  assert.equal(f.frontend.cells[4][8], '');
  assert.deepEqual(clone(f.service.commitAttendanceFormRows([response])), { appended: 0, existing: 1, conflicts: 0 });
});

test('native response commit recovers lost append response without duplicating durable records', () => {
  const f = fixture(), response = responseEntry(); f.state.fail = 'append-response';
  assert.throws(() => f.service.commitAttendanceFormRows([response]), /append response lost/);
  assert.equal(f.log.cells.length, 3); assert.equal(f.state.writes.filter(w => w.batch).length, 0);
  f.state.fail = '';
  assert.deepEqual(clone(f.service.commitAttendanceFormRows([response])), { appended: 0, existing: 1, conflicts: 0 });
  assert.equal(f.log.cells.length, 3); assert.equal(f.frontend.cells[4][8], 'P');
});

test('native multi-event retry preserves a later decision for the committed event while appending only its missing event', () => {
  const f = fixture(), a = responseEntry(), b = responseEntry('response-one', 'North, One', 'Event B');
  appendFixtureRecords(f, [a, { ...a, submission_id: 'decision-later', submitted_at: '2026-11-14T17:00:00Z', attendance_type: 'MED' }]);
  assert.deepEqual(clone(f.service.commitAttendanceFormRows([a, b])), { appended: 1, existing: 1, conflicts: 0 });
  assert.equal(f.log.cells.length, 5);
  assert.deepEqual(f.frontend.cells[4].slice(7), ['P', 'MED']);
});

test('first-time delayed response cannot overwrite a later correction or intentional clear', () => {
  for (const code of ['', 'E']) {
    const f = fixture(), response = responseEntry();
    appendFixtureRecords(f, [{ ...response, submission_id: 'manual-newer', submitted_at: '2026-11-14T17:00:00Z', attendance_type: code }]);
    const writes = f.state.writes.length;
    assert.throws(() => f.service.commitAttendanceFormRows([response]), /delayed attendance response/);
    assert.equal(f.log.cells.length, 3); assert.equal(f.state.writes.length, writes);
  }
});

test('stable response identity rejects conflicting content and recognizes a matching legacy receipt', () => {
  const f = fixture(), response = responseEntry();
  appendFixtureRecords(f, [response]);
  assert.throws(() => f.service.commitAttendanceFormRows([{ ...response, cadets: 'South, Two' }]), /conflicts with existing log receipts/);
  const legacy = fixture(); appendFixtureRecords(legacy, [{ ...response, submission_id: 'att-legacy-random' }]);
  assert.deepEqual(clone(legacy.service.commitAttendanceFormRows([response])), { appended: 0, existing: 1, conflicts: 0 });
  assert.equal(legacy.log.cells.length, 3);
});

test('existing Form receipt retry preserves an unlogged human clear or changed code and reports the conflict', () => {
  for (const pendingValue of ['', 'T']) {
    const f = fixture(), response = responseEntry(); f.service.commitAttendanceFormRows([response]);
    f.frontend.cells[4][8] = pendingValue;
    const result = f.service.commitAttendanceFormRows([response]);
    assert.deepEqual(clone(result), { appended: 0, existing: 1, conflicts: 1 });
    assert.equal(f.frontend.cells[4][8], pendingValue);
    assert.equal(f.log.cells.length, 3);
  }
});

test('a zero-selection native response keeps a durable receipt without inventing attendance', () => {
  const f = fixture(), response = responseEntry('nobody-present', '');
  assert.deepEqual(clone(f.service.commitAttendanceFormRows([response])), { appended: 1, existing: 0, conflicts: 0 });
  assert.deepEqual(clone(f.service.commitAttendanceFormRows([response])), { appended: 0, existing: 1, conflicts: 0 });
  assert.equal(f.log.cells.length, 3); assert.equal(f.state.writes.filter(write => write.batch).length, 0);
});

test('actual native attendance Form entry point uses stable response-event IDs through commit and retry', () => {
  const f = fixture();
  const event = { response: {
    getId: () => 'native-response', getTimestamp: () => new Date('2026-11-13T17:00:00Z'), getRespondentEmail: () => 'reporter@example.test',
    getItemResponses: () => [ ['Select Event (Other)', 'Event A'], ['Cadets (All) AS400', ['North, One']] ]
      .map(([title, value]) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => value })),
  } };
  f.context.FormHandlers.onAttendanceFormSubmit(event);
  f.context.FormHandlers.onAttendanceFormSubmit(event);
  assert.equal(f.log.cells.length, 3);
  assert.equal(f.log.cells[2][0], responseEntry('native-response').submission_id);
  assert.equal(f.frontend.cells[4][8], 'P');
});
