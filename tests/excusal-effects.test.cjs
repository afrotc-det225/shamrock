const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const requestHeaders = ['request_id', 'event', 'last_name', 'first_name', 'decision', 'status', 'decided_at', 'decided_by', 'last_updated_at', 'submitted_at', 'requested_outcome', 'prior_attendance_code', 'attendance_effect', 'email', 'squadron', 'reason', 'flight'];
const managementHeaders = ['timestamp', 'decision', 'event', 'reason', 'requested_outcome', 'email', 'last_name', 'first_name', 'flight', 'request_id'];
const logHeaders = ['submission_id', 'submitted_at', 'event', 'attendance_type', 'cadets', 'email', 'name', 'flight'];
const decisionAt = '2026-10-01T12:00:00Z';
const request = overrides => ({ request_id: 'request-one', event: 'Event A', last_name: 'Example', first_name: 'Cadet', decision: 'Approved', status: 'Approved', decided_at: decisionAt, decided_by: 'commander@example.test', last_updated_at: decisionAt, submitted_at: '2026-09-30T12:00:00Z', requested_outcome: 'E', prior_attendance_code: '', attendance_effect: 'E', email: 'cadet@example.test', squadron: 'Blue', reason: 'Fictional fixture', ...overrides });
const log = overrides => ({ submission_id: 'pending-original', submitted_at: '2026-09-30T12:00:01Z', event: 'Event A', attendance_type: 'R', cadets: 'Example, Cadet', ...overrides });

function fixture({ requests = [request()], logs = [log()], frontend = 'R', backend = 'R', events = [{ display_name: 'Event A', start_datetime: '2026-09-29T10:00:00Z' }], roster = [{ last_name: 'Example', first_name: 'Cadet' }], directory = [], management = [] } = {}) {
  let locked = false;
  const calls = { append: 0, writes: [], emails: [], audits: [], reads: new Map() };
  const fail = {};
  const sheets = new Map();
  function makeSheet(id, name, headers, records) {
    const cells = [headers.slice(), headers.slice(), ...records.map(record => headers.map(header => record[header] ?? ''))];
    const sheet = {
      cells, getName: () => name, getParent: () => ({ getId: () => id }), getLastRow: () => cells.length, getLastColumn: () => headers.length,
      getRange(row, col, height = 1, width = 1) { return {
        getValues: () => cells.slice(row - 1, row - 1 + height).map(values => values.slice(col - 1, col - 1 + width)),
        sort() { assert.equal(locked, true); calls.sorted = (calls.sorted || 0) + 1; },
        setValue(value) {
          assert.equal(locked, true);
          if (fail.metadata === headers[col - 1]) throw Error('metadata interrupted');
          cells[row - 1][col - 1] = value;
        },
      }; },
    };
    sheets.set(`${id}:${name}`, sheet);
    return sheet;
  }
  const requestsSheet = makeSheet('backend', 'Excusals Backend', requestHeaders, requests);
  const logsSheet = makeSheet('backend', 'Attendance Backend', logHeaders, logs);
  makeSheet('backend', 'Events Backend', ['display_name', 'start_datetime', 'status'], events);
  makeSheet('backend', 'Directory Backend', ['email', 'last_name', 'first_name', 'flight', 'squadron'], directory);
  const blueSheet = makeSheet('management', 'Blue', managementHeaders, management);
  const goldSheet = makeSheet('management', 'Gold', managementHeaders, []);
  const managementBook = { getSheets: () => [blueSheet, goldSheet], getSheetByName: name => sheets.get(`management:${name}`) };
  const matrixHeaders = ['last_name', 'first_name', 'Event A'];
  const backendSheet = makeSheet('backend', 'Attendance Matrix Backend', matrixHeaders, roster.map(cadet => ({ ...cadet, 'Event A': backend })));
  const frontendSheet = makeSheet('frontend', 'Attendance', matrixHeaders, roster.map(cadet => ({ ...cadet, 'Event A': frontend })).reverse());
  const context = vm.createContext({
    Date, Map, Set, Error, console,
    Config: { getBackendId: () => 'backend', getFrontendId: () => 'frontend', PROPERTY_KEYS: {}, getScriptProperty: () => 'management' },
    Schemas: { getTabSchema() {}, EXCUSALS_MANAGEMENT_SCHEMA: { machineHeaders: managementHeaders } },
    Arrays: { EXCUSAL_DECISIONS: ['Approved', 'Denied', 'Withdrawn', 'Superseded'], OPERATIONAL_SQUADRONS: ['Blue', 'Gold'], FLIGHTS: ['Alpha', 'Bravo'] },
    Log: { info() {}, warn() {}, error() {} }, ProgressService: { report() {} },
    LockService: { getScriptLock: () => ({ hasLock: () => locked, waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }) },
    SpreadsheetApp: { flush() {}, openById: () => managementBook },
    Session: { getActiveUser: () => ({ getEmail: () => 'operator@example.test' }) },
    FrontendFormattingService: { repairAttendanceInputs() {} },
    __presentation() { if (fail.presentation) throw Error('presentation interrupted'); },
    __protections() { calls.protections = (calls.protections || 0) + 1; },
    GmailApp: { sendEmail: (...args) => calls.emails.push(args) },
    AuditService: { log: entry => calls.audits.push(entry) },
    SheetUtils: {
      getSheet: (id, name) => sheets.get(`${id}:${name}`),
      readTable(sheet) {
        calls.reads.set(sheet.getName(), (calls.reads.get(sheet.getName()) || 0) + 1);
        return { headers: sheet.cells[0], rows: sheet.cells.slice(2).map(row => Object.fromEntries(sheet.cells[0].map((header, index) => [header, row[index]]))) };
      },
      appendRows(sheet, rows) {
        assert.equal(locked, true);
        calls.append++;
        if (fail.appendBefore) throw Error('append interrupted');
        sheet.cells.push(...rows.map(row => sheet.cells[0].map(header => row[header] ?? '')));
        if (fail.appendAfter) throw Error('append response interrupted');
      },
    },
    Sheets: { Spreadsheets: { Values: { batchUpdate(body, id) {
      assert.equal(locked, true);
      calls.writes.push(id);
      if (fail.projection === id) throw Error('projection interrupted');
      body.data.forEach(update => {
        const [, name, letters, first] = update.range.match(/^'([^']+)'!([A-Z]+)(\d+):[A-Z]+\d+$/);
        const col = [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
        const sheet = sheets.get(`${id}:${name}`);
        update.values.forEach((row, index) => { sheet.cells[Number(first) - 1 + index][col] = row[0]; });
      });
    } } } },
  });
  for (const file of ['services/attendance.ts', 'services/excusals.ts']) {
    let source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    // Keep the service entrypoints real; replace only unrelated presentation /
    // sharing IO boundaries, which have their own runtime regression coverage.
    source = source.replaceAll('ensureManagementPresentation(ss);', '__presentation(ss);')
      .replaceAll('applyManagementSheetProtections(ss);', '__protections(ss);');
    for (const name of ['repairAuthoritativeAttendanceEffects', 'excusalsBackendIndexes', 'applyManagementDecision']) source = source.replace(`  function ${name}(`, `  export function ${name}(`);
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None } }).outputText, context);
  }
  const state = () => ({ backendSheet: requestsSheet, data: requestsSheet.cells.slice(2).map(row => row.slice()), idx: context.ExcusalsService.excusalsBackendIndexes(requestHeaders) });
  const repair = options => context.AttendanceService.withWriteLock(() => context.ExcusalsService.repairAuthoritativeAttendanceEffects({ ...state(), ...options }));
  const decide = options => context.AttendanceService.withWriteLock(() => context.ExcusalsService.applyManagementDecision({ ...state(), headers: requestHeaders, requestId: 'request-one', decision: 'Approved', actorEmail: 'commander@example.test', actorRole: 'squadron_commander', source: 'test', managementSheet: 'Blue', notifyCadet: true, ...options }));
  const submit = () => context.ExcusalsService.updateAttendanceOnExcusalSubmission(requests[0]);
  const finalLog = () => context.SheetUtils.readTable(logsSheet).rows.at(-1);
  return { context, calls, fail, sheets, requestsSheet, logsSheet, backendSheet, frontendSheet, blueSheet, repair, decide, submit, finalLog };
}

test('a delayed submission continuation cannot restore R after the commander has approved it', () => {
  const f = fixture({ logs: [log({ attendance_type: 'E' })], frontend: 'E', backend: 'E' });
  f.submit();
  assert.equal(f.calls.append, 0);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.frontendSheet.cells[2][2], 'E');
});

test('pending submission uses a stable receipt and repairs an interrupted mirror without duplicate logs', () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '', attendance_effect: '' })], logs: [], frontend: 'D', backend: '' });
  f.fail.projection = 'frontend';
  assert.throws(f.submit, /projection interrupted/);
  assert.equal(f.finalLog().submission_id, 'excusal-request-request-one');
  f.fail.projection = '';
  f.submit();
  assert.equal(f.calls.append, 1);
  assert.equal(f.backendSheet.cells[2][2], 'R');
  assert.equal(f.frontendSheet.cells[2][2], 'R');
});

for (const code of ['P', '']) test(`pending receipt retry cannot replace an unexplained frontend ${code || 'blank'}`, () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '' })], logs: [log({ submission_id: 'excusal-request-request-one' })], frontend: code });
  assert.throws(f.submit, /needs review/);
  assert.equal(f.calls.append, 0);
  assert.equal(f.frontendSheet.cells[2][2], code);
  assert.equal(f.calls.audits.at(-1).action, 'excusal_pending_projection_review_required');
});

for (const code of ['P', '']) test(`pending retry preserves later independent ${code || 'explicit clear'}`, () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '' })], logs: [log({ submission_id: 'excusal-request-request-one' }), log({ submission_id: 'manual-later', attendance_type: code })], frontend: code, backend: code });
  f.submit();
  assert.equal(f.calls.append, 0);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.frontendSheet.cells[2][2], code);
});

test('retrying the same decision completes a metadata-only failure without restamping or notifying', () => {
  const f = fixture();
  const original = f.requestsSheet.cells[2].slice();
  assert.equal(f.decide(), 'updated');
  assert.equal(f.finalLog().attendance_type, 'E');
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.emails.length, 0);
  assert.deepEqual(f.requestsSheet.cells[2], original);
  assert.equal(f.decide(), 'unchanged');
  assert.equal(f.calls.append, 1);
});

test('a new decision persists before mirroring and a failed mirror retries without another log or email', () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '', attendance_effect: '' })] });
  f.fail.projection = 'frontend';
  assert.throws(f.decide, /projection interrupted/);
  const savedTime = f.requestsSheet.cells[2][requestHeaders.indexOf('decided_at')];
  assert.equal(f.finalLog().attendance_type, 'E');
  f.fail.projection = '';
  f.decide();
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.emails.length, 0);
  assert.equal(f.frontendSheet.cells[2][2], 'E');
  assert.equal(f.requestsSheet.cells[2][requestHeaders.indexOf('decided_at')], savedTime);
});

test('an uncertain append receipt is recognized on retry', () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '' })] });
  f.fail.appendAfter = true;
  assert.throws(f.decide, /append response interrupted/);
  f.fail.appendAfter = false;
  f.decide();
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.emails.length, 0);
  assert.equal(f.frontendSheet.cells[2][2], 'E');
});

test('an incomplete metadata checkpoint is completed by repeating the selection', () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '' })] });
  f.fail.metadata = 'decided_at';
  assert.throws(f.decide, /metadata interrupted/);
  assert.equal(f.calls.append, 0);
  f.fail.metadata = '';
  f.decide();
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.emails.length, 1);
  assert.equal(f.requestsSheet.cells[2][requestHeaders.indexOf('status')], 'Approved');
});

test('a correct decision log with stale frontend R needs no new attendance record', () => {
  const f = fixture({ logs: [log({ submission_id: 'excusal-decision-request-one-original', attendance_type: 'E', submitted_at: decisionAt })], backend: 'E' });
  const result = f.repair();
  assert.equal(result.repaired, 0);
  assert.equal(result.projected, 1);
  assert.deepEqual(f.calls.writes, ['frontend']);
  assert.equal(f.frontendSheet.cells[2][2], 'E');
});

test('request-bound delayed R can be healed, but a legacy unbound R is not guessed to be that request', () => {
  for (const bound of [true, false]) {
    const f = fixture({ logs: [log({ submission_id: 'excusal-decision-request-one-original', attendance_type: 'E', submitted_at: decisionAt }), log({ submission_id: bound ? 'excusal-request-request-one' : 'excusal-random', submitted_at: '2026-10-01T12:00:01Z' })] });
    const result = f.repair();
    assert.equal(result.repaired, bound ? 1 : 0);
    assert.equal(result.preserved, bound ? 0 : 1);
    assert.equal(f.frontendSheet.cells[2][2], bound ? 'E' : 'R');
  }
});

for (const code of ['P', 'T', '', 'R']) test(`reconciliation preserves a backdated independent ${code || 'clear'} appended after the current decision`, () => {
  const f = fixture({ logs: [log({ submission_id: 'excusal-decision-request-one-original', attendance_type: 'E', submitted_at: decisionAt }), log({ submission_id: 'independent-report', attendance_type: code, submitted_at: '2026-09-29T00:00:00Z' })] });
  const result = f.repair();
  assert.equal(result.preserved, 1);
  assert.equal(result.repaired, 0);
  assert.equal(f.frontendSheet.cells[2][2], code);
  assert.equal(f.backendSheet.cells[2][2], code);
});

for (const code of ['P', 'N/A', '']) test(`reconciliation flags and preserves an unexplained frontend ${code || 'blank'}`, () => {
  const f = fixture({ logs: [log({ attendance_type: 'E', submission_id: 'excusal-decision-request-one-original', submitted_at: decisionAt })], frontend: code });
  const result = f.repair();
  assert.equal(result.conflicts, 1);
  assert.equal(f.frontendSheet.cells[2][2], code);
  assert.equal(f.backendSheet.cells[2][2], 'E');
});

test('withdrawal writes a durable explicit clear and repairs only its matching pending cells', () => {
  const f = fixture({ requests: [request({ decision: 'Withdrawn', status: 'Withdrawn', prior_attendance_code: 'R', attendance_effect: '' })] });
  assert.equal(f.repair().repaired, 1);
  assert.equal(f.finalLog().attendance_type, '');
  assert.equal(f.frontendSheet.cells[2][2], '');
  assert.equal(f.repair().repaired, 0);
});

test('current repairs skip removed, canceled and off-roster history without recreating targets', () => {
  const f = fixture({ requests: [request(), request({ request_id: 'old', event: 'Removed Event' }), request({ request_id: 'off-roster', last_name: 'Retired' })] });
  const result = f.repair();
  assert.equal(result.checked, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.repaired, 1);
  const canceled = fixture({ events: [{ display_name: 'Event A', status: 'Canceled' }] });
  assert.equal(canceled.repair().skipped, 1);
  assert.equal(canceled.calls.append, 0);
});

test('multiple cadet repairs use one append and one sparse write per workbook despite different sorting', () => {
  const f = fixture({ requests: [request(), request({ request_id: 'request-two', last_name: 'Another', requested_outcome: 'MED', attendance_effect: 'MED' })], roster: [{ last_name: 'Example', first_name: 'Cadet' }, { last_name: 'Another', first_name: 'Cadet' }] });
  assert.equal(f.repair().repaired, 2);
  assert.equal(f.calls.append, 1);
  assert.deepEqual(f.calls.writes, ['backend', 'frontend']);
  assert.deepEqual(f.frontendSheet.cells.slice(2).map(row => row[2]), ['MED', 'E']);
  assert.equal(f.calls.reads.get('Attendance Backend'), 1);
});

test('repeating an older request cannot replace a later decided request for the same cadet and event', () => {
  const f = fixture({ requests: [request(), request({ request_id: 'later', decided_at: '2026-10-02T12:00:00Z', requested_outcome: 'MED', attendance_effect: 'MED' })] });
  assert.equal(f.repair({ requestIds: new Set(['request-one']) }).checked, 0);
  assert.equal(f.calls.append, 0);
  f.repair();
  assert.equal(f.finalLog().attendance_type, 'MED');
});

test('management repair records removed-event selections without recreating columns or aborting current repairs', () => {
  const f = fixture({ requests: [request(), request({ request_id: 'removed', event: 'Removed Event', decision: '', status: 'Submitted', decided_at: '' })], management: [{ request_id: 'removed', decision: 'Approved' }] });
  const result = f.context.ExcusalsService.reconcileManagementDecisions();
  assert.equal(result.repaired, 1);
  assert.equal(result.attendanceSkipped, 1);
  assert.equal(result.attendanceRepaired, 1);
  assert.equal(f.requestsSheet.cells[3][requestHeaders.indexOf('status')], 'Approved');
  assert.equal(f.logsSheet.cells.slice(2).some(row => row[logHeaders.indexOf('event')] === 'Removed Event'), false);
  assert.equal(f.frontendSheet.cells[2][2], 'E');
});

for (const code of ['P', '']) test(`unknown original decision timing flags existing ${code || 'clear'} for review`, () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', decided_at: '' })], logs: [log({ submission_id: 'independent', attendance_type: code })], frontend: code, backend: code, management: [{ request_id: 'request-one', decision: 'Approved' }] });
  const result = f.context.ExcusalsService.reconcileManagementDecisions();
  assert.equal(result.reviewRequired, 1);
  assert.equal(f.calls.append, 0);
  assert.equal(f.requestsSheet.cells[2][requestHeaders.indexOf('decision')], '');
  assert.equal(f.frontendSheet.cells[2][2], code);
});

test('management request sync retries a saved row without clearing a commander selection', () => {
  const f = fixture({ requests: [request({ decision: '', status: 'Submitted', flight: 'Alpha' })] });
  f.fail.presentation = true;
  assert.throws(() => f.context.ExcusalsService.syncExcusalToManagementPanel(request()), /presentation interrupted/);
  assert.equal(f.calls.append, 1);
  assert.equal(f.blueSheet.cells[2][0], '2026-09-30T12:00:00Z');
  f.blueSheet.cells[2][1] = 'Denied';
  f.fail.presentation = false;
  f.context.ExcusalsService.syncExcusalToManagementPanel(request());
  assert.equal(f.calls.append, 1);
  assert.equal(f.blueSheet.cells[2][1], 'Denied');
  assert.equal(f.calls.protections, 2);
  assert.equal(f.calls.sorted, 1);
});

test('ambiguous management routing fails before another review row is created', () => {
  const f = fixture({ management: [{ request_id: 'request-one' }, { request_id: 'request-one' }] });
  assert.throws(() => f.context.ExcusalsService.syncExcusalToManagementPanel(request()), /ambiguous/);
  assert.equal(f.calls.append, 0);
});

test('unique repeated combined names resolve Directory routing while preserving the verified respondent', () => {
  const f = fixture({ directory: [{ email: 'directory@example.test', last_name: 'Example', first_name: 'Cadet', flight: 'alpha', squadron: 'blue' }] });
  const result = f.context.ExcusalsService.resolveExcusalCadet('RESPONDENT@example.test', 'Example, Cadet', 'Example, Cadet');
  assert.equal(result.last_name, 'Example');
  assert.equal(result.first_name, 'Cadet');
  assert.equal(result.respondent_email, 'respondent@example.test');
  assert.equal(result.email, 'directory@example.test');
  assert.equal(result.identity_match, 'directory_name');
  assert.equal(result.flight, 'Alpha');
  assert.equal(result.squadron, 'Blue');
});

test('unique verified Directory email resolves identity independently of free-text name errors', () => {
  const f = fixture({ directory: [{ email: 'cadet@example.test', last_name: 'Example', first_name: 'Cadet', flight: 'Alpha', squadron: 'Blue' }] });
  const result = f.context.ExcusalsService.resolveExcusalCadet('cadet@example.test', 'Misspelled', 'Name');
  assert.equal(result.last_name, 'Example');
  assert.equal(result.identity_match, 'verified_email');
});

for (const kind of ['email', 'name', 'routing', 'unknown']) test(`unresolved ${kind} fails before excusal routing`, () => {
  const row = { email: 'cadet@example.test', last_name: 'Example', first_name: 'Cadet', flight: 'Alpha', squadron: 'Blue' };
  const directory = kind === 'email' ? [row, { ...row, last_name: 'Other' }] : kind === 'name' ? [row, { ...row, email: 'other@example.test' }] : kind === 'routing' ? [{ ...row, squadron: '' }] : [];
  const f = fixture({ directory });
  assert.throws(() => f.context.ExcusalsService.resolveExcusalCadet('cadet@example.test', 'Example', 'Cadet'), /multiple|ambiguous|squadron/);
  assert.equal(f.calls.append, 0);
});
