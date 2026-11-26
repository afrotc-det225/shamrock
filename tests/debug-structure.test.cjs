const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(triggers = [], options = {}) {
  const calls = { spreadsheets: [], forms: [], warnings: [], logs: [], files: [] };
  const configuredForms = { attendance: 'attendance-form-test', excusal: 'excusal-form-test', directory: 'directory-form-test' };
  const context = vm.createContext({
    Config: {
      getFrontendId: () => 'frontend-test', getBackendId: () => 'backend-test',
      PROPERTY_KEYS: { ATTENDANCE_FORM_ID: 'attendance', EXCUSAL_REQUEST_FORM_ID: 'excusal', CADET_DIRECTORY_FORM_ID: 'directory' },
      getScriptProperty: key => configuredForms[key],
    },
    ScriptApp: {
      TriggerSource: { SPREADSHEETS: 'SPREADSHEETS', FORMS: 'FORMS', CLOCK: 'CLOCK', DOCUMENTS: 'DOCUMENTS', CALENDAR: 'CALENDAR' },
      getProjectTriggers: () => triggers,
    },
    SpreadsheetApp: {
      openById(id) {
        calls.spreadsheets.push(id);
        assert(!id.includes('form'), 'Form trigger IDs must not be opened as spreadsheets');
        if (options.failedSources?.includes(id)) throw Error('private source failure');
        return { getName: () => `Spreadsheet ${id}`, getSheets: () => [{
          getName: () => 'Example', getLastColumn: () => 2, getLastRow: () => 3,
          getRange: () => ({ getValues: () => [['id', 'value'], ['ID', 'Value']] }),
        }] };
      },
    },
    FormApp: {
      openById(id) {
        calls.forms.push(id);
        assert(id.includes('form'), 'Spreadsheet trigger IDs must not be opened as Forms');
        if (options.failedSources?.includes(id)) throw Error('private source failure');
        return { getTitle: () => `Form ${id}`, getDestinationId: () => 'response-workbook-test' };
      },
    },
    Log: { warn: text => calls.warnings.push(text) },
    Logger: { log: text => calls.logs.push(text) },
    Utilities: { newBlob: (text, mimeType, name) => ({ text, mimeType, name }) },
    DriveApp: { createFile(blob) { calls.files.push(blob); return { getName: () => blob.name, getId: () => 'snapshot-file-test' }; } },
  });
  const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/debug.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText, context);
  return { calls, dump() { context.Debug.dumpShamrockStructure(); return JSON.parse(calls.logs.at(-1)); },
    dumpToDrive() { context.Debug.dumpShamrockStructureToDrive(); return JSON.parse(calls.files.at(-1).text); } };
}

function trigger(source, id, event = 'ON_FORM_SUBMIT', handler = 'testHandler') {
  return { getTriggerSource: () => source, getTriggerSourceId: () => id, getEventType: () => event, getHandlerFunction: () => handler };
}

test('structure snapshots resolve spreadsheet and Form triggers with the matching service', () => {
  const f = fixture([
    trigger('SPREADSHEETS', 'management-test', 'ON_EDIT'),
    trigger('FORMS', 'extra-form-test'),
    trigger('CLOCK', null, 'CLOCK'),
  ]);
  const snapshot = f.dump();
  assert.deepEqual(snapshot.triggers.map(t => [t.type, t.sourceName]), [
    ['ON_EDIT', 'Spreadsheet management-test'], ['ON_FORM_SUBMIT', 'Form extra-form-test'], ['CLOCK', null],
  ]);
  assert.equal(snapshot.frontend[0].sheet, 'Example');
  assert.equal(snapshot.backend[0].headers_row1[0], 'id');
  assert.equal(snapshot.forms.length, 3);
  assert.deepEqual(f.calls.spreadsheets, ['frontend-test', 'backend-test', 'management-test']);
  assert.deepEqual(f.calls.forms, ['attendance-form-test', 'excusal-form-test', 'directory-form-test', 'extra-form-test']);
  assert.equal(f.calls.warnings.length, 0);
});

test('snapshot names reuse configured resources and repeated trigger lookups exactly once', () => {
  const f = fixture([
    trigger('SPREADSHEETS', 'frontend-test', 'ON_EDIT'), trigger('SPREADSHEETS', 'backend-test', 'ON_OPEN'),
    trigger('SPREADSHEETS', 'management-test', 'ON_EDIT'), trigger('SPREADSHEETS', 'management-test', 'ON_OPEN'),
    trigger('FORMS', 'attendance-form-test'), trigger('FORMS', 'excusal-form-test'), trigger('FORMS', 'directory-form-test'),
    trigger('FORMS', 'extra-form-test'), trigger('FORMS', 'extra-form-test'),
  ]);
  const snapshot = f.dump();
  assert(snapshot.triggers.every(t => typeof t.sourceName === 'string'));
  assert.equal(f.calls.spreadsheets.length, 3);
  assert.equal(new Set(f.calls.spreadsheets).size, 3);
  assert.equal(f.calls.forms.length, 4);
  assert.equal(new Set(f.calls.forms).size, 4);
});

test('clock, unsupported and unreadable source types never guess a file service', () => {
  const unavailable = trigger('FORMS', 'unknown-form-test');
  unavailable.getTriggerSource = () => { throw Error('unavailable'); };
  const noId = trigger('FORMS', 'missing-form-test');
  noId.getTriggerSourceId = () => { throw Error('unavailable'); };
  const f = fixture([
    trigger('CLOCK', 'unexpected-clock-source', 'CLOCK'),
    trigger('DOCUMENTS', 'document-test', 'ON_OPEN'),
    trigger('CALENDAR', 'calendar-test', 'ON_EVENT_UPDATED'), unavailable, noId,
  ]);
  const snapshot = f.dump();
  assert(snapshot.triggers.every(t => t.sourceName === null));
  assert.deepEqual(f.calls.spreadsheets, ['frontend-test', 'backend-test']);
  assert.deepEqual(f.calls.forms, ['attendance-form-test', 'excusal-form-test', 'directory-form-test']);
});

test('inaccessible trigger resources remain null and failed lookups are not repeated or exposed', () => {
  const f = fixture([
    trigger('SPREADSHEETS', 'inaccessible-test', 'ON_EDIT'), trigger('SPREADSHEETS', 'inaccessible-test', 'ON_OPEN'),
    trigger('FORMS', 'inaccessible-form-test'), trigger('FORMS', 'inaccessible-form-test'),
  ], { failedSources: ['inaccessible-test', 'inaccessible-form-test'] });
  const snapshot = f.dump();
  assert(snapshot.triggers.every(t => t.sourceName === null));
  assert.equal(f.calls.spreadsheets.filter(id => id === 'inaccessible-test').length, 1);
  assert.equal(f.calls.forms.filter(id => id === 'inaccessible-form-test').length, 1);
  assert.equal(f.calls.warnings.length, 2);
  assert(f.calls.warnings.every(text => !/inaccessible|private source failure/.test(text)));
});

test('Drive snapshot uses the same source-safe inspection and preserves the existing JSON shape', () => {
  const f = fixture([trigger('FORMS', 'attendance-form-test'), trigger('CLOCK', null, 'CLOCK')]);
  const snapshot = f.dumpToDrive();
  assert.deepEqual(Object.keys(snapshot).sort(), ['backend', 'forms', 'frontend', 'generated_at', 'triggers']);
  assert.equal(snapshot.triggers[0].sourceName, 'Form attendance-form-test');
  assert.equal(snapshot.triggers[1].sourceName, null);
  assert.equal(f.calls.forms.length, 3);
  assert.equal(f.calls.files.length, 1);
  assert.equal(f.calls.files[0].mimeType, 'application/json');
  assert(Number.isFinite(Date.parse(snapshot.generated_at)));
});
