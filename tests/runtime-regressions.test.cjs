const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual namespace code with Apps Script IO doubles. Private
// functions are exported only in this in-memory test compilation.
function load(files, globals = {}, expose = []) {
  const context = vm.createContext({
    console, Date, Map, Set, Error,
    Log: { info() {}, warn() {}, error() {} },
    ProgressService: { report() {} },
    Config: { PROPERTY_KEYS: { AUTOMATIONS_PAUSED: 'paused' } },
    Schemas: { getTabSchema() { return undefined; } },
    ...globals,
  });
  for (const file of files) {
    const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
    let source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    for (const name of expose) source = source.replace(`  function ${name}(`, `  export function ${name}(`);
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None } });
    vm.runInContext(outputText, context, { filename: file });
  }
  return context;
}

function sheet(headers, rows) {
  const cells = [headers, headers, ...rows].map(row => row.slice());
  return {
    cells,
    getLastRow: () => cells.length,
    getLastColumn: () => headers.length,
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => cells.slice(row - 1, row - 1 + height).map(values => values.slice(col - 1, col - 1 + width)),
        setValues(values) { values.forEach((values, i) => values.forEach((value, j) => { cells[row - 1 + i][col - 1 + j] = value; })); },
      };
    },
  };
}

function readTable(s) {
  return { headers: s.cells[0], rows: s.cells.slice(2).map(row => Object.fromEntries(s.cells[0].map((h, i) => [h, row[i]]))) };
}

function attendanceSubmissionFixture(readEmail) {
  const appended = [], applied = [], sleeps = [];
  const { FormHandlers } = load(['forms/handlers.ts'], {
    Config: { getBackendId: () => '', getFrontendId: () => '', getBackendSheet: () => ({}) },
    SheetUtils: { appendRows: (_, rows) => appended.push(...rows) },
    AttendanceService: { applyAttendanceLogEntry: row => applied.push(row) },
    SetupService: { applyAttendanceBackendFormattingPublic() {} },
    FormService: { isAttendanceCadetQuestionTitle: title => title.startsWith('Cadets (') },
    Utilities: { sleep: delay => sleeps.push(delay) },
    GmailApp: { sendEmail() { throw new Error('Attendance must not send receipts'); } },
  });
  const event = { response: {
    getRespondentEmail: readEmail,
    getTimestamp: () => new Date('2026-10-16T20:15:10Z'),
    getItemResponses: () => [
      ['Select Event (Secondary)', 'TW-8 Secondary'],
      ['Cadets (Secondary) AS200', ['Example, Cadet']],
    ].map(([title, value]) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => value })),
  } };
  return { run: () => FormHandlers.onAttendanceFormSubmit(event), appended, applied, sleeps };
}

test('transient responder email failures recover before one attendance write', () => {
  let reads = 0;
  const c = attendanceSubmissionFixture(() => {
    if (++reads < 3) throw new Error('Service Drive timed out while accessing document');
    return 'cadet@example.test';
  });
  c.run();
  assert.equal(reads, 3);
  assert.deepEqual(c.sleeps, [400, 800]);
  assert.equal(c.appended.length, 1);
  assert.equal(c.applied.length, 1);
  assert.equal(c.appended[0].email, 'cadet@example.test');
  assert.equal(c.appended[0].cadets, 'Example, Cadet');
  assert.equal(c.appended[0].attendance_type, 'P');
});

test('persistent responder email failures stop before any attendance write', () => {
  let reads = 0;
  const failure = new Error('Service Drive timed out while accessing document');
  const c = attendanceSubmissionFixture(() => { reads++; throw failure; });
  assert.throws(c.run, err => err === failure);
  assert.equal(reads, 3);
  assert.deepEqual(c.sleeps, [400, 800]);
  assert.equal(c.appended.length, 0);
  assert.equal(c.applied.length, 0);
});

test('responder permission failures are not retried or treated as an empty email', () => {
  let reads = 0;
  const c = attendanceSubmissionFixture(() => { reads++; throw new Error('Permission denied'); });
  assert.throws(c.run, /Permission denied/);
  assert.equal(reads, 1);
  assert.deepEqual(c.sleeps, []);
  assert.equal(c.appended.length, 0);
  assert.equal(c.applied.length, 0);
});

test('pause with an operator reason blocks updates and resume recognizes the pause', () => {
  let value;
  const { PauseService } = load(['services/pause.ts'], { Config: {
    PROPERTY_KEYS: { AUTOMATIONS_PAUSED: 'paused' },
    getScriptProperty: () => value,
    setScriptProperty: (_, next) => { value = next; },
    deleteScriptProperty: () => { value = undefined; },
  } });
  PauseService.pause('maintenance');
  assert.equal(PauseService.isPaused(), true);
  assert.equal(PauseService.pauseInfo(), 'paused: maintenance');
  assert.equal(PauseService.resume(), true);
  assert.equal(PauseService.isPaused(), false);
});

test('pause accepts the plain flag without treating false JSON as paused', () => {
  let value = 'true';
  const { PauseService } = load(['services/pause.ts'], { Config: { PROPERTY_KEYS: {}, getScriptProperty: () => value } });
  assert.equal(PauseService.isPaused(), true);
  for (value of ['', 'false', '{"paused":false}', 'invalid']) assert.equal(PauseService.isPaused(), false);
});

test('failed pause/resume persistence is reported instead of claiming success', () => {
  const { PauseService } = load(['services/pause.ts'], { Config: {
    PROPERTY_KEYS: {}, getScriptProperty: () => 'true',
    setScriptProperty() { throw new Error('write failed'); },
    deleteScriptProperty() { throw new Error('delete failed'); },
  } });
  assert.throws(() => PauseService.pause('maintenance'), /write failed/);
  assert.throws(() => PauseService.resume(), /delete failed/);
});

test('full attendance replay preserves a withdrawal clear and later attendance', () => {
  const { AttendanceService } = load(['services/attendance.ts'], {}, ['buildMatrixRows']);
  const roster = [{ last_name: 'Example', first_name: 'Cadet' }];
  const events = [{ name: 'TW-1 Mando' }];
  const entry = code => ({ event: 'TW-1 Mando', cadets: 'Example, Cadet', attendance_type: code });
  for (const code of ['', null, undefined]) {
    assert.equal(AttendanceService.buildMatrixRows(roster, events, [entry('R'), entry(code)])[0]['TW-1 Mando'], '');
  }
  assert.equal(AttendanceService.buildMatrixRows(roster, events, [entry('R'), entry(''), entry('P')])[0]['TW-1 Mando'], 'P');
});

test('incremental attendance resolves frontend event headers and cadet identity independently', () => {
  const backend = sheet(['last_name', 'first_name', 'Event A', 'Event B'], [['Example', 'One', 'R', 'A'], ['Example', 'Two', 'E', 'T']]);
  const frontend = sheet(['first_name', 'last_name', 'Event B', 'Event A'], [['Two', 'Example', 'T', 'E'], ['One', 'Example', 'A', 'R']]);
  const { AttendanceService } = load(['services/attendance.ts'], {
    Config: { getBackendId: () => 'backend', getFrontendId: () => 'frontend' },
    SheetUtils: { getSheet: id => id === 'backend' ? backend : frontend, readTable },
  });
  assert.equal(AttendanceService.applyAttendanceLogEntry({ event: 'Event A', cadets: 'Example, One', attendance_type: '' }), true);
  assert.equal(backend.cells[2][2], '');
  assert.deepEqual(frontend.cells.slice(2), [['Two', 'Example', 'T', 'E'], ['One', 'Example', 'A', '']]);
});

test('missing frontend event reports repair need without writing a different column', () => {
  const backend = sheet(['last_name', 'first_name', 'Event A'], [['Example', 'One', 'R']]);
  const frontend = sheet(['last_name', 'first_name', 'Event B'], [['Example', 'One', 'T']]);
  const { AttendanceService } = load(['services/attendance.ts'], {
    Config: { getBackendId: () => 'backend', getFrontendId: () => 'frontend' },
    SheetUtils: { getSheet: id => id === 'backend' ? backend : frontend, readTable },
  });
  assert.throws(() => AttendanceService.applyAttendanceLogEntry({ event: 'Event A', cadets: 'Example, One', attendance_type: 'P' }), /Rebuild Attendance/);
  assert.equal(frontend.cells[2][2], 'T');
});

function trigger(id, source, event = 'submit', kind = 'form') {
  return { id, getHandlerFunction: () => 'submitHandler', getTriggerSourceId: () => source, getEventType: () => event, getTriggerSource: () => kind };
}

function triggerContext(triggers) {
  const deleted = [], created = [];
  const ScriptApp = {
    TriggerSource: { FORMS: 'form' }, EventType: { ON_FORM_SUBMIT: 'submit' },
    getProjectTriggers: () => triggers,
    deleteTrigger(t) { deleted.push(t.id); },
    newTrigger(handler) { return { forForm(id) { return { onFormSubmit() { return { create() { created.push({ handler, id }); } }; } }; } }; },
  };
  return { ...load(['services/setup.ts'], { ScriptApp }, ['ensureFormTrigger']), deleted, created, ScriptApp };
}

test('form trigger repair keeps one correct trigger and removes stale, duplicate and wrong-event triggers', () => {
  const c = triggerContext([trigger('valid', 'current'), trigger('duplicate', 'current'), trigger('stale', 'old'), trigger('wrong-event', 'current', 'open')]);
  c.SetupService.ensureFormTrigger('submitHandler', 'current');
  assert.deepEqual(c.deleted, ['duplicate', 'stale', 'wrong-event']);
  assert.equal(c.created.length, 0);
});

test('a matching form ID with the wrong trigger source is replaced', () => {
  const c = triggerContext([trigger('wrong-source', 'current', 'submit', 'spreadsheet')]);
  c.SetupService.ensureFormTrigger('submitHandler', 'current');
  assert.deepEqual(c.deleted, ['wrong-source']);
  assert.deepEqual(c.created, [{ handler: 'submitHandler', id: 'current' }]);
});

test('failed trigger deletion stops repair instead of creating another submit trigger', () => {
  const c = triggerContext([trigger('stale', 'old')]);
  c.ScriptApp.deleteTrigger = () => { throw new Error('permission denied'); };
  assert.throws(() => c.SetupService.ensureFormTrigger('submitHandler', 'current'), /permission denied/);
  assert.equal(c.created.length, 0);
});

function orderingFixture(fail) {
  let ids = [1, 3, 2, 4];
  let attempts = 0, moves = 0, reopens = 0;
  const item = id => ({
    getId: () => id, getTitle: () => id === 1 ? 'Cadets' : id === 4 ? 'Next' : `Question ${id}`,
    getType: () => id === 1 || id === 4 ? 'page' : 'checkbox',
    getIndex() { throw new Error('stale item index should not be read'); },
  });
  const form = {
    getId: () => 'test-form',
    getItems() { if (fail === 'read' && attempts++ === 0) throw new Error('Failed to retrieve form data'); return ids.map(item); },
    getItemById: item,
    moveItem(from, to) {
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      moves++;
      if (fail === 'partial' && moves === 1) throw new Error('Failed to retrieve form data');
    },
  };
  const c = load(['services/forms.ts'], {
    FormApp: { ItemType: { PAGE_BREAK: 'page' }, openById() { reopens++; return form; } },
    Utilities: { sleep() {} },
  }, ['reorderAttendanceCadetQuestions']);
  const expected = [2, 3].map(id => ({ title: `Question ${id}`, sectionTitle: 'Cadets' }));
  const active = new Map([2, 3].map(id => [`Question ${id}`, item(id)]));
  return { run: () => c.FormService.reorderAttendanceCadetQuestions(form, expected, active), ids: () => ids, moves: () => moves, reopens: () => reopens };
}

for (const failure of ['read', 'partial']) test(`cadet question ordering recovers from ${failure} failure without replacing questions`, () => {
  const c = orderingFixture(failure);
  c.run();
  assert.deepEqual(c.ids(), [1, 2, 3, 4]);
  assert.equal(c.reopens(), 1);
  const moves = c.moves();
  c.run();
  assert.equal(c.moves(), moves);
});

test('management access failure never provisions a replacement workbook', () => {
  let created = false, propertyWritten = false;
  const c = load(['services/excusals.ts'], {
    Config: { PROPERTY_KEYS: {}, getScriptProperty: () => 'configured', setScriptProperty() { propertyWritten = true; } },
    SpreadsheetApp: { openById() { throw new Error('permission denied'); }, create() { created = true; } },
  });
  assert.throws(() => c.ExcusalsService.ensureManagementSpreadsheet(), /restore administrator access/);
  assert.equal(created, false);
  assert.equal(propertyWritten, false);
});

function managementProtectionMetadata() {
  const protection = (description, range, extra = []) => ({ description, range, editors: { users: ['admin@example.test', ...extra] } });
  return { sheets: [
    { properties: { sheetId: 1, title: 'Blue', gridProperties: { rowCount: 10, columnCount: 3 } }, protectedRanges: [
      protection('Blue: Headers protected', { sheetId: 1, endRowIndex: 2, endColumnIndex: 3 }),
      protection('Blue: Managed request fields 1', { sheetId: 1, startRowIndex: 2, endRowIndex: 10, endColumnIndex: 1 }),
      protection('Blue: Managed request fields 2', { sheetId: 1, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 3 }),
      protection('Blue: Decisions editable only by squadron commander', { sheetId: 1, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 }, ['commander@example.test']),
    ] },
    { properties: { sheetId: 2, title: '_Excusals Data Legend' }, protectedRanges: [protection('Excusals Management Data Legend', { sheetId: 2 })] },
  ] };
}

test('management sharing preserves backend administrators and removes former role access', () => {
  const removed = [], added = [], viewers = [];
  const roles = new Map([['admin@example.test', 'reader'], ['owner@example.test', 'owner'], ['former@example.test', 'writer']]);
  let failAdminRead = false;
  const management = {
    getEditors() { throw new Error('Profile-based emails must not determine access'); },
    getSheets: () => [], getSheetByName: () => null, getId: () => 'management',
    addEditors(emails) { added.push(...emails); emails.forEach(email => { if (roles.get(email) !== 'owner') roles.set(email, 'writer'); }); },
    addEditor(email) { added.push(email); roles.set(email, 'writer'); },
    removeEditor(email) { removed.push(email); roles.delete(email); },
    removeViewer(email) { removed.push(email); roles.delete(email); },
    addViewer(email) { viewers.push(email); roles.set(email, 'reader'); },
  };
  const c = load(['services/excusals.ts'], {
    Config: { PROPERTY_KEYS: {}, getScriptProperty: () => 'management', getBackendId: () => 'backend' },
    Arrays: { FLIGHTS: ['Alpha'], OPERATIONAL_SQUADRONS: ['Blue'], getSquadronCommanderUnit: role => role.toLowerCase() === 'blue squadron commander' ? 'Blue' : '' },
    Schemas: { EXCUSALS_MANAGEMENT_SCHEMA: { machineHeaders: ['timestamp', 'decision', 'event'] } },
    Sheets: { Spreadsheets: { get: managementProtectionMetadata } },
    SpreadsheetApp: { openById: () => management },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    UrlFetchApp: { fetch(url) {
      if (url.includes('/backend/') && failAdminRead) throw new Error('admin lookup failed');
      const permissions = url.includes('/backend/')
        ? [{ type: 'user', role: 'writer', emailAddress: 'admin@example.test' }, { type: 'user', role: 'owner', emailAddress: 'owner@example.test' }]
        : [...roles].map(([emailAddress, role]) => ({ type: 'user', role, emailAddress }));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ permissions }) };
    } },
    SheetUtils: { getSheet: () => ({}), readTable: () => ({ rows: [
      { role: 'Blue Squadron Commander', email: 'commander@example.test' },
      { role: 'Alpha Flight Commander', email: 'admin@example.test' },
    ] }) },
    DriveApp: { Access: { PRIVATE: 'private' }, Permission: { NONE: 'none' }, getFileById: () => ({ setSharing() {} }) },
  });
  c.ExcusalsService.shareAndProtectManagementSpreadsheet();
  assert.deepEqual(removed, ['former@example.test']);
  assert.ok(added.includes('admin@example.test'));
  assert.ok(added.includes('owner@example.test'));
  assert.ok(added.includes('commander@example.test'));
  assert.deepEqual(viewers, []);
  assert.equal(roles.get('admin@example.test'), 'writer');
  failAdminRead = true;
  const removals = removed.length;
  assert.throws(() => c.ExcusalsService.shareAndProtectManagementSpreadsheet(), /admin lookup failed/);
  assert.equal(removed.length, removals);
});

test('management protection verification rejects missing admins, extra access and incomplete ranges', () => {
  let metadata;
  const c = load(['services/excusals.ts'], {
    Config: { getBackendId: () => 'backend' },
    Arrays: { OPERATIONAL_SQUADRONS: ['Blue'], getSquadronCommanderUnit: () => 'Blue' },
    SheetUtils: { getSheet: () => ({}), readTable: () => ({ rows: [{ role: 'Blue Squadron Commander', email: 'commander@example.test' }] }) },
    Schemas: { EXCUSALS_MANAGEMENT_SCHEMA: { machineHeaders: ['timestamp', 'decision', 'event'] } },
    Sheets: { Spreadsheets: { get: () => metadata } },
  }, ['verifyManagementProtections']);
  const verify = () => c.ExcusalsService.verifyManagementProtections({ getId: () => 'management' }, ['admin@example.test', 'owner@example.test'], 'owner@example.test');
  metadata = managementProtectionMetadata();
  verify();
  for (const mutate of [
    m => { m.sheets[0].protectedRanges[0].editors.users = []; },
    m => { m.sheets[0].protectedRanges[0].editors.users.push('commander@example.test'); },
    m => { m.sheets[0].protectedRanges[3].range.endRowIndex = 9; },
    m => { m.sheets[1].protectedRanges[0].warningOnly = true; },
    m => { m.sheets[1].protectedRanges[0].editors.domainUsersCanEdit = true; },
    m => { m.sheets[0].protectedRanges.pop(); },
  ]) {
    metadata = managementProtectionMetadata();
    mutate(metadata);
    assert.throws(verify, /Management protection/);
  }
});

test('management administrator lookup reads every permission page without losing cross-domain editors', () => {
  const urls = [];
  const c = load(['services/excusals.ts'], {
    Config: { getBackendId: () => 'backend' },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    UrlFetchApp: { fetch(url) {
      urls.push(url);
      const page = url.includes('pageToken=next')
        ? { permissions: [{ type: 'user', role: 'writer', emailAddress: 'Admin@Example.test' }, { type: 'user', role: 'reader', emailAddress: 'reader@example.test' }] }
        : { nextPageToken: 'next', permissions: [{ type: 'user', role: 'owner', emailAddress: 'owner@example.test' }] };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(page) };
    } },
  }, ['managementAdminEmails']);
  assert.deepEqual(Array.from(c.ExcusalsService.managementAdminEmails()), ['owner@example.test', 'admin@example.test']);
  assert.equal(urls.length, 2);
});

test('incomplete or denied administrator lookup cannot become an empty sharing allowlist', () => {
  let status = 403, permissions = [];
  const c = load(['services/excusals.ts'], {
    Config: { getBackendId: () => 'backend' }, ScriptApp: { getOAuthToken: () => 'test-token' },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => status, getContentText: () => JSON.stringify({ permissions }) }) },
  }, ['managementAdminEmails']);
  assert.throws(() => c.ExcusalsService.managementAdminEmails(), /HTTP 403/);
  status = 200;
  assert.throws(() => c.ExcusalsService.managementAdminEmails(), /No backend administrators/);
  permissions = [{ type: 'user', role: 'owner', emailAddress: 'owner@example.test' }, { type: 'user', role: 'writer' }];
  assert.throws(() => c.ExcusalsService.managementAdminEmails(), /resolved completely/);
});

test('editor sharing recovery audits success without requiring a spreadsheet dialog', () => {
  const audit = [];
  let context, calls = 0;
  const c = load(['index.ts'], {
    Utilities: { getUuid: () => 'test-run' },
    Config: { PROPERTY_KEYS: {}, getScriptProperty: () => 'management' },
    SpreadsheetApp: { getUi() { throw new Error('Cannot call SpreadsheetApp.getUi() from this context'); } },
    ProgressService: {
      currentRunId: () => context, prepareAndShow: () => false,
      withExecutionContext(id, action, fn) { context = id; try { return fn(); } finally { context = undefined; } },
      begin() {}, report() {}, complete() {}, fail() {},
    },
    AuditService: { actorEmail: () => 'owner@example.test', log: row => audit.push(row) },
    ExcusalsService: { shareAndProtectManagementSpreadsheet() { calls++; } },
  });
  c.shareExcusalsManagementSpreadsheet();
  assert.equal(calls, 1);
  assert.deepEqual(audit.map(row => row.result), ['started', 'ok']);
  c.ExcusalsService.shareAndProtectManagementSpreadsheet = () => { throw new Error('sharing denied'); };
  assert.throws(() => c.shareExcusalsManagementSpreadsheet(), /sharing denied/);
  assert.equal(audit.at(-1).result, 'failed');
});

test('backend pasted range checks every affected Directory field', () => {
  const calls = [];
  const s = sheet(['role', 'as_year', 'flight'], [['', 'AS100', 'Alpha']]);
  s.getName = () => 'Directory Backend';
  const range = { getSheet: () => s, getColumn: () => 1, getLastColumn: () => 3, getRow: () => 3, getA1Notation: () => 'A3:C3', getValue: () => '' };
  const c = load(['services/directory.ts', 'index.ts'], {
    PauseService: { isPaused: () => false }, Config: { getBackendId: () => '' },
    SetupService: { refreshDirectoryArtifacts: options => calls.push(options) },
  });
  c.onBackendEdit({ range });
  assert.equal(calls[0].rebuildAttendanceMatrix, true);
  assert.equal(calls[0].refreshAttendanceForm, true);
});

test('periodic Directory reconciliation refreshes Leadership and form choices through the supported workflow', () => {
  const calls = [], audit = [];
  const c = load(['index.ts'], {
    PauseService: { isPaused: () => false },
    FrontendEditService: { reconcilePendingDirectoryEdits: () => ({ updated: 1, missing: 0 }) },
    SetupService: { refreshDirectoryArtifacts: options => calls.push(options) },
    AuditService: { log: row => audit.push(row) },
  });
  c.reconcilePendingDirectoryEdits();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].refreshAttendanceForm, true);
  c.SetupService.refreshDirectoryArtifacts = () => { throw new Error('refresh failed'); };
  assert.throws(() => c.reconcilePendingDirectoryEdits(), /refresh failed/);
  assert.equal(audit[0].result, 'failed');
});

for (const scenario of [
  { label: 'later actual attendance', code: 'P', timestamp: '2026-10-02T12:00:00Z', id: 'form-response', preserved: 1 },
  { label: 'new pending request', code: 'R', timestamp: '2026-10-02T12:00:00Z', id: 'excusal-pending-new', preserved: 1 },
  { label: 'later manual correction', code: 'E', timestamp: '2026-10-02T12:00:00Z', id: 'manual-correction', preserved: 1 },
  { label: 'missing decision effect', code: 'R', timestamp: '2026-09-30T12:00:00Z', id: 'excusal-pending-original', preserved: 0 },
  { label: 'incorrect log for the same decision', code: 'E', timestamp: '2026-10-01T12:00:01Z', id: 'excusal-decision-request-1-suffix', preserved: 0 },
]) test(`excusal reconciliation handles ${scenario.label}`, () => {
  const appended = [], applied = [];
  const logSheet = {};
  const c = load(['services/excusals.ts'], {
    Config: { getBackendId: () => 'backend' },
    Arrays: { EXCUSAL_DECISIONS: ['Approved', 'Denied', 'Withdrawn', 'Superseded'] },
    SheetUtils: {
      getSheet: () => ({ ...logSheet, getLastRow: () => 3 }),
      readTable: () => ({ rows: [{ event: 'Event A', cadets: 'Example, Cadet', attendance_type: scenario.code, submitted_at: scenario.timestamp, submission_id: scenario.id }] }),
      appendRows: (_, rows) => appended.push(...rows),
    },
    AttendanceService: { applyAttendanceLogEntry: entry => applied.push(entry) },
    AuditService: { log() {} },
  }, ['repairAuthoritativeAttendanceEffects', 'excusalsBackendIndexes']);
  const headers = ['request_id', 'event', 'last_name', 'first_name', 'decision', 'decided_at', 'requested_outcome', 'prior_attendance_code', 'attendance_effect'];
  const data = [['request-1', 'Event A', 'Example', 'Cadet', 'Approved', '2026-10-01T12:00:00Z', 'MED', '', 'MED']];
  const result = c.ExcusalsService.repairAuthoritativeAttendanceEffects({
    backendSheet: { getRange: () => ({ setValue() {} }) }, data,
    idx: c.ExcusalsService.excusalsBackendIndexes(headers),
  });
  assert.equal(result.preserved, scenario.preserved);
  assert.equal(appended.length, 1 - scenario.preserved);
  assert.equal(applied.length, appended.length);
  if (appended.length) assert.equal(appended[0].attendance_type, 'MED');
});
