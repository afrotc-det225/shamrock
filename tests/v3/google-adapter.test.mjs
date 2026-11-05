import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  attendanceCommandFromForm, buildSignedCommandRequest, buildSignedJobRequest,
  captureDecisionDraft, decisionCommandFromDraft, enqueueCommand, dispatchPending,
  publishRecordedDecision,
} from '../../.build/v3/apps/google-adapter/src/index.js';
import {
  createGoogleSigner, createGoogleTransport, withJournalLock, snapshotGoogleForm, googleEditActorEmail,
} from '../../.build/v3/apps/google-adapter/src/apps-script.js';

const secret = 'fictional-local-signing-material-do-not-deploy';
const signer = {
  sha256: value => createHash('sha256').update(value).digest('hex'),
  hmacSha256: value => createHmac('sha256', secret).update(value).digest('hex'),
};
const config = { baseUrl: 'http://127.0.0.1:8787', keyId: 'local-key', environment: 'local', generation: 1 };
const fixtureEmail = 'operator@example.invalid';
const principals = { resolveVerifiedEmail: email => email === fixtureEmail ? 'principal.operator' : undefined };
const catalog = {
  nativeFormId: 'fictional-form', resourceKey: 'attendance-form',
  itemRoles: { event: '10', scope: '20', present: ['30', '40'], completeness: '50' },
  references: {
    'event.first': { kind: 'event', eventId: 'event.first' },
    'scope.alpha.v1': { kind: 'scope', unitId: 'unit.alpha', rosterVersion: 1, coveredPersonIds: ['person.one', 'person.two'] },
    'person.one': { kind: 'person', personId: 'person.one' },
    'person.two': { kind: 'person', personId: 'person.two' },
  },
};
function snapshot(overrides = {}) {
  return {
    nativeFormId: 'fictional-form', responseId: 'response.first', revision: 1,
    responderEmail: fixtureEmail, verifiedResponder: true,
    answers: { '10': 'Old event label [sr:event.first]', '20': 'Alpha [sr:scope.alpha.v1]', '30': ['Same name [sr:person.one]', 'Same name [sr:person.two]'], '40': [], '50': 'partial' },
    ...overrides,
  };
}
const command = () => attendanceCommandFromForm(snapshot(), catalog, principals, config, signer);

class MemorySheet {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getRange(row, col, rows, cols) {
    return {
      getValues: () => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
      setValues: values => {
        for (let r = 0; r < rows; r++) {
          this.rows[row - 1 + r] ??= [];
          for (let c = 0; c < cols; c++) this.rows[row - 1 + r][col - 1 + c] = values[r][c];
        }
      },
    };
  }
}
function lock() {
  return { held: false, releases: 0,
    tryLock() { if (this.held) return false; this.held = true; return true; },
    releaseLock() { this.held = false; this.releases++; },
  };
}
function code(expected) { return error => error.code === expected; }

test('Form references distinguish duplicate names and preserve an old roster snapshot', () => {
  const result = command();
  assert.equal(result.payload.eventId, 'event.first');
  assert.deepEqual(result.payload.presentPersonIds, ['person.one', 'person.two']);
  assert.deepEqual(result.payload.coveredPersonIds, ['person.one', 'person.two']);
  assert.equal(result.source.submissionId, 'response.first');
  const renamed = snapshot(); renamed.answers['10'] = 'Renamed event [sr:event.first]';
  assert.deepEqual(attendanceCommandFromForm(renamed, catalog, principals, config, signer), result);
  catalog.references['scope.alpha.v2'] = { kind: 'scope', unitId: 'unit.alpha', rosterVersion: 2, coveredPersonIds: ['person.three'] };
  assert.equal(command().payload.rosterVersion, 1);
});

test('native response redelivery has stable command identity; completeness is explicit', () => {
  assert.deepEqual(command(), command());
  const zero = snapshot(); zero.answers['30'] = []; zero.answers['50'] = 'complete';
  const result = attendanceCommandFromForm(zero, catalog, principals, config, signer);
  assert.equal(result.payload.completeness, 'complete');
  assert.deepEqual(result.payload.presentPersonIds, []);
  delete zero.answers['50'];
  assert.throws(() => attendanceCommandFromForm(zero, catalog, principals, config, signer), code('invalid_form_answer'));
  const longId = 'r'.repeat(280);
  assert.equal(attendanceCommandFromForm(snapshot({ responseId: longId }), catalog, principals, config, signer).source.submissionId, longId);
});

test('unverified respondents, wrong sources and ambiguous choices cannot become commands', () => {
  assert.throws(() => attendanceCommandFromForm(snapshot({ verifiedResponder: false }), catalog, principals, config, signer), code('confirmation_required'));
  assert.throws(() => attendanceCommandFromForm(snapshot({ responderEmail: 'unknown@example.invalid' }), catalog, principals, config, signer), code('confirmation_required'));
  assert.throws(() => attendanceCommandFromForm(snapshot({ nativeFormId: 'other-form' }), catalog, principals, config, signer), code('wrong_source'));
  const missing = snapshot(); missing.answers['30'] = ['Same name'];
  assert.throws(() => attendanceCommandFromForm(missing, catalog, principals, config, signer), code('unknown_choice'));
  missing.answers['30'] = ['Done selecting events'];
  assert.throws(() => attendanceCommandFromForm(missing, catalog, principals, config, signer), code('unknown_choice'));
});

test('Apps Script native snapshot uses item IDs and native email, not an Email answer', () => {
  const result = snapshotGoogleForm({ getId: () => 'fictional-form' }, {
    getId: () => 'response.native', getRespondentEmail: () => '',
    getItemResponses: () => [{ getItem: () => ({ getId: () => 9 }), getResponse: () => fixtureEmail }],
  }, true);
  assert.equal(result.responderEmail, '');
  assert.equal(result.answers['9'], fixtureEmail);
  assert.throws(() => attendanceCommandFromForm(result, catalog, principals, config, signer), code('confirmation_required'));
  assert.throws(() => snapshotGoogleForm({ getId: () => 'fictional-form' }, { getId: () => null }, true), code('missing_response_identity'));
});

test('Apps Script signed-byte Utilities encoding matches the Worker HMAC protocol', () => {
  const signed = buffer => [...buffer].map(byte => byte > 127 ? byte - 256 : byte);
  const googleSigner = createGoogleSigner({
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_, text) => signed(createHash('sha256').update(text).digest()),
    computeHmacSha256Signature: (text, key) => signed(createHmac('sha256', key).update(text).digest()),
  }, secret);
  const request = buildSignedCommandRequest(command(), config, googleSigner, 1800000000);
  const expected = `POST\n/v1/commands\n1800000000\n${signer.sha256(request.body)}`;
  assert.equal(request.headers['x-shamrock-signature'], signer.hmacSha256(expected));
  assert.deepEqual(request, buildSignedCommandRequest(command(), config, signer, 1800000000));
  assert.throws(() => buildSignedCommandRequest(command(), { ...config, generation: 2 }, signer, 1800000000), code('wrong_generation'));
  assert.throws(() => buildSignedCommandRequest({ ...command(), environment: 'staging' }, { ...config, environment: 'staging' }, signer, 1800000000), code('invalid_endpoint'));
  const job = buildSignedJobRequest('/v1/jobs/claim', { workerId: 'adapter.one' }, config, signer, 1800000000);
  assert.equal(job.headers['x-shamrock-signature'], signer.hmacSha256(`POST\n/v1/jobs/claim\n1800000000\n${signer.sha256(job.body)}`));
  const injected = buildSignedJobRequest('/v1/jobs/claim', { workerId: 'adapter.one', environment: 'production', generation: 9 }, config, signer, 1800000000);
  assert.deepEqual(JSON.parse(injected.body), { environment: 'local', generation: 1, workerId: 'adapter.one' });
});

test('Google HTTP transport never follows redirects with signed credentials', () => {
  let args;
  const transport = createGoogleTransport({ fetch(...values) { args = values; return { getResponseCode: () => 302, getContentText: () => '' }; } });
  transport.send(buildSignedCommandRequest(command(), config, signer, 1800000000));
  assert.equal(args[1].followRedirects, false);
  assert.equal(args[1].validateHttpsCertificates, true);
  assert.equal(args[1].muteHttpExceptions, true);
});

test('private Sheets journal retains exact command through timeout and retry with a fresh signature', () => {
  const sheet = new MemorySheet(); const scriptLock = lock(); const sent = [];
  withJournalLock(sheet, scriptLock, journal => enqueueCommand(command(), journal, signer));
  const failed = withJournalLock(sheet, scriptLock, journal => dispatchPending(journal, {
    send(request) { sent.push(request); throw new Error('sensitive HTTP error must not be saved'); },
  }, config, signer, 1800000000));
  assert.deepEqual(failed, { committed: 0, pending: 1, attention: 0 });
  const pending = withJournalLock(sheet, scriptLock, journal => journal.due(1800000030, 10))[0];
  assert.equal(pending.lastError, 'delivery_pending');
  const success = withJournalLock(sheet, scriptLock, journal => dispatchPending(journal, {
    send(request) { sent.push(request); return { status: 200, body: JSON.stringify({ commandId: command().commandId, status: 'committed' }) }; },
  }, config, signer, 1800000030));
  assert.deepEqual(success, { committed: 1, pending: 0, attention: 0 });
  assert.equal(sent[0].body, sent[1].body);
  assert.notEqual(sent[0].headers['x-shamrock-signature'], sent[1].headers['x-shamrock-signature']);
  assert.deepEqual(withJournalLock(sheet, scriptLock, journal => journal.due(1800000060, 10)), []);
  assert.equal(scriptLock.held, false);
});

test('ambiguous success is not an acknowledgement; conflicts preserve original input', () => {
  const sheet = new MemorySheet(); const scriptLock = lock();
  withJournalLock(sheet, scriptLock, journal => enqueueCommand(command(), journal, signer));
  withJournalLock(sheet, scriptLock, journal => dispatchPending(journal, { send: () => ({ status: 200, body: '{}' }) }, config, signer, 1800000000));
  const pending = withJournalLock(sheet, scriptLock, journal => journal.due(1800000030, 10))[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.lastError, 'unknown_outcome');
  const result = withJournalLock(sheet, scriptLock, journal => dispatchPending(journal, { send: () => ({ status: 409, body: 'private conflict detail' }) }, config, signer, 1800000030));
  assert.equal(result.attention, 1);
  const retained = withJournalLock(sheet, scriptLock, journal => enqueueCommand(command(), journal, signer));
  assert.equal(retained.status, 'conflict');
  assert.equal(retained.body, JSON.stringify(command()));
});

test('journal capacity, collision and lock failures never discard input', () => {
  const sheet = new MemorySheet(); const scriptLock = lock();
  withJournalLock(sheet, scriptLock, journal => enqueueCommand(command(), journal, signer), { maxEntries: 1 });
  assert.throws(() => withJournalLock(sheet, scriptLock, journal => enqueueCommand({ ...command(), commandId: 'another' }, journal, signer), { maxEntries: 1 }), code('journal_full'));
  const altered = command(); altered.payload.completeness = 'complete';
  assert.throws(() => withJournalLock(sheet, scriptLock, journal => enqueueCommand(altered, journal, signer)), code('command_collision'));
  assert.equal(sheet.getLastRow(), 2);
  assert.equal(scriptLock.held, false);
  scriptLock.held = true;
  assert.throws(() => withJournalLock(sheet, scriptLock, () => {}), code('adapter_busy'));
});

test('journal uses header names and rejects corrupt saved payload before HTTP', () => {
  const sheet = new MemorySheet(); const scriptLock = lock();
  withJournalLock(sheet, scriptLock, journal => enqueueCommand(command(), journal, signer));
  sheet.rows = sheet.rows.map(row => [...row].reverse());
  assert.equal(withJournalLock(sheet, scriptLock, journal => journal.due(1800000000, 1))[0].commandId, command().commandId);
  const payloadColumn = sheet.rows[0].indexOf('payload_json');
  sheet.rows[1][payloadColumn] += ' ';
  let sent = false;
  const result = withJournalLock(sheet, scriptLock, journal => dispatchPending(journal, { send() { sent = true; throw new Error(); } }, config, signer, 1800000000));
  assert.equal(result.attention, 1);
  assert.equal(sent, false);
});

test('unknown edit actor remains a confirmation draft and bulk events require frozen review', () => {
  const input = { slot: { slotId: 'slot.one', requestId: 'request.one', baseVersion: 1 }, draftId: 'input.one', resourceKey: 'excusal-sheet', decision: 'Approved', reason: 'Synthetic reviewed decision', editedCellCount: 1 };
  const draft = captureDecisionDraft(input, principals);
  assert.equal(draft.status, 'confirmation-required');
  assert.equal(draft.actor, undefined);
  assert.throws(() => decisionCommandFromDraft(draft, config), code('confirmation_required'));
  assert.equal(googleEditActorEmail({ effectiveUser: { getEmail: () => fixtureEmail } }), undefined);
  assert.throws(() => captureDecisionDraft({ ...input, editedCellCount: 2, eventUserEmail: fixtureEmail }, principals), code('bulk_review_required'));
  assert.throws(() => captureDecisionDraft({ ...input, reason: '' }, principals), code('invalid_reason'));
  const ready = captureDecisionDraft({ ...input, eventUserEmail: fixtureEmail }, principals);
  input.slot.requestId = 'different-request';
  assert.equal(decisionCommandFromDraft(ready, config).payload.requestId, 'request.one');
  assert.equal(decisionCommandFromDraft(ready, config).actor.evidence, 'google-edit');
});

test('recorded output cannot overwrite or rebind a pending decision draft', () => {
  const row = { slotId: 'slot.one', requestId: 'request.one', baseVersion: 1, recordedVersion: 1, draftDecision: 'Denied' };
  const port = { readSlot: () => ({ ...row }), writeRecorded: (_, result) => { row.recordedVersion = result.version; row.recordedDecision = result.decision; } };
  publishRecordedDecision({ ...row, recordedVersion: 3, recordedDecision: 'Approved', saveStatus: 'Recorded' }, port);
  assert.equal(row.draftDecision, 'Denied');
  assert.equal(row.baseVersion, 1);
  assert.throws(() => publishRecordedDecision({ ...row, recordedVersion: 2, recordedDecision: 'Denied', saveStatus: 'Recorded' }, port), code('stale_projection'));
  assert.throws(() => publishRecordedDecision({ ...row, requestId: 'different-request', recordedVersion: 4, recordedDecision: 'Denied', saveStatus: 'Recorded' }, port), code('draft_target_changed'));
  assert.equal(row.recordedVersion, 3);
});
