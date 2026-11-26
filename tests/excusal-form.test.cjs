const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

function fixture() {
  const rows = [], review = new Map(), pending = new Set(), notices = [], audits = [], calls = [];
  let held = false, responseId = 'response-test', reason = 'Academic conflict', failReview = false, loseAppend = false, omitHeader = false;
  const headers = ['request_id', 'event', 'email', 'last_name', 'first_name', 'reason', 'requested_outcome', 'submitted_at'];
  const sheet = {};
  const service = {
    resolveExcusalCadet(email, last, first) {
      assert.equal(email, 'respondent@example.test');
      assert.equal(last, 'Example'); assert.equal(first, 'Cadet');
      return { last_name: 'Example', first_name: 'Cadet', email: 'directory@example.test', flight: 'Alpha', squadron: 'Blue' };
    },
    getCurrentAttendanceCode() { assert(held); calls.push('prior'); return 'P'; },
    auditExcusalSubmission(row) { assert(held); audits.push(row.request_id); },
    syncExcusalToManagementPanel(row) {
      assert(held); calls.push('review');
      if (failReview) { failReview = false; throw Error('temporary review failure'); }
      if (!review.has(row.request_id)) review.set(row.request_id, row.decision);
    },
    updateAttendanceOnExcusalSubmission(row) { assert(held); calls.push('pending'); if (!row.decision) pending.add(row.request_id); },
    notifySquadronCommanderOfNewExcusal(row) { assert.equal(held, false); assert(review.has(row.request_id)); assert(pending.has(row.request_id)); notices.push(row.request_id); calls.push('email'); },
  };
  const context = vm.createContext({
    Date, Map, Set, Error,
    Config: { getBackendSheet: () => sheet },
    Schemas: { getTabSchema: () => ({ machineHeaders: headers }) },
    Arrays: { EXCUSAL_REQUESTED_OUTCOMES: ['P', 'T', 'E', 'ES', 'MED'] },
    ExcusalsService: service,
    AttendanceService: { withWriteLock(fn) { assert.equal(held, false); held = true; calls.push('lock'); try { return fn(); } finally { held = false; calls.push('unlock'); } } },
    SheetUtils: {
      readTable(s) { assert(held); assert.equal(s, sheet); return { headers: omitHeader ? headers.slice(1) : headers, rows: rows.map(r => ({ ...r })) }; },
      appendRows(s, additions) { assert(held); assert.equal(s, sheet); rows.push(...additions.map(r => ({ ...r }))); calls.push('append'); if (loseAppend) { loseAppend = false; throw Error('append response lost'); } },
    },
    SpreadsheetApp: { flush() { assert(held); calls.push('flush'); } },
    AuditService: { log(entry) { audits.push(entry); } },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (algorithm, input) => [...crypto.createHash(algorithm).update(input).digest()] },
    Log: { info() {}, warn() {} },
  });
  const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/forms/handlers.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  }).outputText, context);
  const event = { response: {
    getId: () => responseId,
    getRespondentEmail: () => 'respondent@example.test',
    getTimestamp: () => new Date('2026-10-01T13:00:00Z'),
    getItemResponses: () => [
      ['Select Event(s) (LLAB)', ['TW-1 LLAB', 'TW-2 LLAB']],
      ['Last Name', 'Example'], ['First Name', 'Cadet'], ['Reason', reason], ['Requested Outcome', 'E'],
    ].map(([title, response]) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => response })),
  } };
  return { run: () => context.FormHandlers.onExcusalsFormSubmit(event), rows, review, pending, notices, audits, calls, service,
    failReview: () => { failReview = true; }, loseAppend: () => { loseAppend = true; }, setReason: value => { reason = value; }, noId: () => { responseId = ''; }, omitHeader: () => { omitHeader = true; } };
}

test('native excusal entry point commits unique requests and completes review before notifications', () => {
  const f = fixture(); f.run(); f.run();
  assert.equal(f.rows.length, 2); assert.equal(f.review.size, 2); assert.equal(f.pending.size, 2); assert.equal(f.notices.length, 2);
  assert.equal(new Set(f.rows.map(r => r.request_id)).size, 2);
  assert(f.rows.every(r => /^exc-form-[a-f0-9]{64}$/.test(r.request_id)));
  assert(f.rows.every(r => r.email === 'respondent@example.test' && r.prior_attendance_code === 'P'));
  assert.equal(f.calls.filter(c => c === 'prior').length, 2, 'retry preserves original prior values');
  assert(f.calls.indexOf('flush') < f.calls.indexOf('review'));
});

test('failed review keeps all requests and retry heals without duplicate requests or historical emails', () => {
  const f = fixture(); f.failReview();
  assert.throws(f.run, /requests were saved/);
  assert.equal(f.rows.length, 2); assert.equal(f.review.size, 1, 'other requested events still receive review rows'); assert.equal(f.notices.length, 0);
  f.run(); assert.equal(f.rows.length, 2); assert.equal(f.review.size, 2); assert.equal(f.pending.size, 2); assert.equal(f.notices.length, 0);
});

test('uncertain append retry recognizes the saved receipt and preserves an intervening decision', () => {
  const f = fixture(); f.loseAppend(); assert.throws(f.run, /append response lost/);
  f.rows[0].decision = 'Approved'; f.review.set(f.rows[0].request_id, 'Approved');
  f.run(); assert.equal(f.rows.length, 2); assert.equal(f.review.get(f.rows[0].request_id), 'Approved');
  assert.equal(f.pending.has(f.rows[0].request_id), false); assert.equal(f.notices.length, 0);
});

test('saved response identity rejects changed payload before new side effects', () => {
  const f = fixture(); f.run(); const calls = f.calls.length; f.setReason('Edited later');
  assert.throws(f.run, /conflicts with a saved request/);
  assert.equal(f.rows.length, 2); assert.equal(f.notices.length, 2);
  assert.deepEqual(f.calls.slice(calls), ['lock', 'unlock']);
});

test('matching legacy random request IDs are reused rather than duplicated', () => {
  const f = fixture(); f.run(); f.rows.forEach((r, i) => { r.request_id = `exc-legacy-${i}`; });
  f.review.clear(); f.run(); assert.equal(f.rows.length, 2); assert.equal(f.review.size, 2); assert.equal(f.notices.length, 2);
});

test('missing native identity or ambiguous Directory resolution fails before any append', () => {
  const f = fixture(); f.noId(); assert.throws(f.run, /response identity is missing/); assert.equal(f.rows.length, 0);
  const g = fixture(); g.service.resolveExcusalCadet = () => { throw Error('ambiguous'); };
  assert.throws(g.run, /ambiguous/); assert.equal(g.rows.length, 0); assert.equal(g.calls.length, 0);
});

test('missing request identity header rejects the response before any durable write', () => {
  const f = fixture(); f.omitHeader(); assert.throws(f.run, /headers are incomplete/);
  assert.equal(f.rows.length, 0); assert.equal(f.review.size, 0); assert.equal(f.notices.length, 0);
});
