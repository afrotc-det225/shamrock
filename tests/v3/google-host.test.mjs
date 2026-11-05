import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createStagingHost, HOST_PROPERTIES as P, STAGING_HANDLERS as H, parseStagingHostConfig } from '../../.build/v3/apps/google-adapter/src/staging-host.js';

const signingMaterial = 'fictional-staging-material-never-deploy-this';
const automationEmail = 'automation@example.invalid';
const cadetEmail = 'cadet@example.invalid';
const code = expected => error => error.code === expected;
const decisionHeaders = ['slot_id', 'request_id', 'base_version', 'draft_decision', 'draft_id', 'draft_state', 'draft_json'];
class Sheet {
  constructor(id, rows = []) { this.id = id; this.rows = structuredClone(rows); }
  getSheetId() { return this.id; }
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
function fixture() {
  const config = {
    version: 1, environment: 'staging', resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',
    workerOrigin: 'https://worker.example.invalid', keyId: 'fictional-key', generation: 1,
    expectedAutomationEmail: automationEmail,
    journal: { spreadsheetId: 'existing-private-workbook', sheetId: 11 },
    attendance: { formId: 'existing-attendance-form', resourceKey: 'attendance-form', itemRoles: { event: '10', scope: '20', present: ['30'], completeness: '40' } },
    excusal: { formId: 'existing-excusal-form', resourceKey: 'excusal-form', itemRoles: { event: '50', outcome: '60', reason: '70' } },
    decisionInput: { spreadsheetId: 'existing-review-workbook', sheetId: 22, resourceKey: 'decision-input', slots: [{ row: 3, slotId: 'slot.one', requestId: 'request.one', baseVersion: 1 }] },
  };
  const properties = new Map([
    [P.config, JSON.stringify(config)], [P.secret, signingMaterial],
    [P.principals, JSON.stringify({ entries: [{ email: cadetEmail, principalId: 'principal.cadet', personId: 'person.one' }] })],
    [P.attendanceCatalog, JSON.stringify({ references: {
      'event.one': { kind: 'event', eventId: 'event.one' },
      'scope.one': { kind: 'scope', unitId: 'unit.one', rosterVersion: 1, coveredPersonIds: ['person.one', 'person.two'] },
      'person.one': { kind: 'person', personId: 'person.one' },
    } })],
    [P.excusalCatalog, JSON.stringify({ references: { 'event.one': { kind: 'event', eventId: 'event.one' } } })],
  ]);
  const journal = new Sheet(11);
  const decisions = new Sheet(22, [decisionHeaders, decisionHeaders.map(h => h.toUpperCase()), ['slot.one', 'request.one', 1, 'Approved', '', '', '']]);
  const books = new Map([[config.journal.spreadsheetId, [journal]], [config.decisionInput.spreadsheetId, [decisions]]]);
  const state = { executor: automationEmail, triggers: [], created: 0, deleted: 0, opened: 0, getRequests: [], commands: [], responseMode: 'VERIFIED', formsStatus: 200, commandStatus: 200, now: 1800000000, projections: 0, journalChecks: 0, protectionChecks: 0, failDelete: false, journalPrivate: true, decisionProtected: true };
  const responses = new Map();
  const forms = new Map([config.attendance.formId, config.excusal.formId].map(id => [id, { getId: () => id, getResponse: responseId => {
    if (!responses.has(responseId)) throw Error('Missing native response'); return responses.get(responseId);
  } }]));
  const lock = { held: false, tryLock() { if (this.held) return false; this.held = true; return true; }, releaseLock() { this.held = false; } };
  let uuid = 0;
  const signed = buffer => [...buffer].map(n => n > 127 ? n - 256 : n);
  function trigger(handler, source, event, resource, uid = `trigger.${++state.created}`) {
    return { getUniqueId: () => uid, getHandlerFunction: () => handler, getTriggerSource: () => source, getEventType: () => event, getTriggerSourceId: () => resource };
  }
  function create(handler, source, event, resource) {
    return { create() { const t = trigger(handler, source, event, resource); state.triggers.push(t); return t; } };
  }
  const runtime = {
    properties: { getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value) },
    utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => signed(createHash('sha256').update(text).digest()),
      computeHmacSha256Signature: (text, secret) => signed(createHmac('sha256', secret).update(text).digest()),
      getUuid: () => `draft.${++uuid}`,
    },
    urlFetch: { fetch(url, options) {
      assert.equal(options.followRedirects, false); assert.equal(options.validateHttpsCertificates, true);
      if (options.method === 'get') {
        state.getRequests.push({ url, options });
        assert.ok(url.startsWith('https://forms.googleapis.com/v1/forms/'));
        const formId = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
        return { getResponseCode: () => state.formsStatus, getContentText: () => JSON.stringify({ formId, settings: { emailCollectionType: state.responseMode } }) };
      }
      assert.equal(url, `${config.workerOrigin}/v1/commands`);
      assert.equal(lock.held, true, 'Dispatch stays under the journal lock');
      const command = JSON.parse(options.payload);
      const hash = createHash('sha256').update(options.payload).digest('hex');
      const canonical = `POST\n/v1/commands\n${options.headers['x-shamrock-timestamp']}\n${hash}`;
      assert.equal(options.headers['x-shamrock-signature'], createHmac('sha256', signingMaterial).update(canonical).digest('hex'));
      state.commands.push(command);
      return { getResponseCode: () => state.commandStatus, getContentText: () => JSON.stringify({ commandId: command.commandId, status: 'committed', operation: command.operation, result: {}, pendingEffects: true }) };
    } },
    scriptApp: {
      getOAuthToken: () => 'fictional-oauth-in-memory-only', getProjectTriggers: () => [...state.triggers],
      TriggerSource: { FORMS: 'form', SPREADSHEETS: 'sheet', CLOCK: 'clock' }, EventType: { ON_FORM_SUBMIT: 'submit', ON_EDIT: 'edit', CLOCK: 'clock' },
      newTrigger: handler => ({
        forForm: resource => ({ onFormSubmit: () => create(handler, 'form', 'submit', resource) }),
        forSpreadsheet: resource => ({ onEdit: () => create(handler, 'sheet', 'edit', resource) }),
        timeBased: () => ({ everyMinutes: minutes => { assert.equal(minutes, 5); return create(handler, 'clock', 'clock', null); } }),
      }),
      deleteTrigger(t) { if (state.failDelete) throw Error('Synthetic deletion failure'); state.deleted++; state.triggers.splice(state.triggers.indexOf(t), 1); },
    },
    session: { getEffectiveUser: () => ({ getEmail: () => state.executor }) },
    formApp: { openById: id => { state.opened++; if (!forms.has(id)) throw Error('Missing form'); return forms.get(id); } },
    spreadsheetApp: { openById: id => { state.opened++; if (!books.has(id)) throw Error('Missing workbook'); return { getId: () => id, getSheets: () => books.get(id) }; } },
    lockService: { getScriptLock: () => lock }, nowSeconds: () => state.now,
    assertJournalPrivate(ref) { state.journalChecks++; assert.deepEqual(ref, config.journal); if (!state.journalPrivate) throw Error('Journal sharing rejected'); },
    assertDecisionProtection(ref, headers) { state.protectionChecks++; assert.equal(ref.spreadsheetId, config.decisionInput.spreadsheetId); assert.deepEqual(headers, decisionHeaders.filter(h => h !== 'draft_decision')); if (!state.decisionProtected) throw Error('Decision protection rejected'); },
    consumeProjection() { assert.equal(lock.held, false, 'Projection acquires its own lock after journal release'); state.projections++; return { published: 0 }; },
  };
  const host = createStagingHost(runtime);
  const uid = handler => state.triggers.find(t => t.getHandlerFunction() === handler)?.getUniqueId();
  function nativeResponse(id, answers, responder = cadetEmail) {
    const submitted = state.now;
    const response = { getId: () => id, getRespondentEmail: () => responder, getTimestamp: () => new Date(submitted * 1000), getItemResponses: () => Object.entries(answers).map(([itemId, answer]) => ({ getItem: () => ({ getId: () => Number(itemId) }), getResponse: () => answer })) };
    responses.set(id, response); return response;
  }
  function attendanceEvent(responseId = 'response.attendance') {
    return { source: forms.get(config.attendance.formId), triggerUid: uid(H.attendance), response: nativeResponse(responseId, { 10: 'Event [sr:event.one]', 20: 'Unit [sr:scope.one]', 30: ['Cadet [sr:person.one]'], 40: 'partial' }) };
  }
  function excusalEvent(responder = cadetEmail) {
    return { source: forms.get(config.excusal.formId), triggerUid: uid(H.excusal), response: nativeResponse('response.excusal', { 50: 'Event [sr:event.one]', 60: 'E', 70: 'Synthetic request', 80: 'spoof@example.invalid' }, responder) };
  }
  function editEvent({ value = 'Approved', user = cadetEmail, row = 3, col = 4, rows = 1, cols = 1, setCell = true } = {}) {
    if (setCell) decisions.getRange(row, col, 1, 1).setValues([[value]]);
    return { source: { getId: () => config.decisionInput.spreadsheetId }, triggerUid: uid(H.decision), value,
      ...(user === null ? {} : { user: { getEmail: () => user } }),
      range: { getSheet: () => decisions, getRow: () => row, getColumn: () => col, getNumRows: () => rows, getNumColumns: () => cols },
    };
  }
  return { host, runtime, state, properties, config, journal, decisions, books, forms, responses, lock, trigger, attendanceEvent, excusalEvent, editEvent,
    activate() { host.setup(); host.resume(); }, saveConfig() { properties.set(P.config, JSON.stringify(config)); },
  };
}

test('unconfigured host is paused without opening any resource or requesting OAuth', () => {
  const f = fixture(); f.properties.clear();
  assert.deepEqual(f.host.flush(), { status: 'paused' });
  assert.deepEqual(f.host.onAttendanceSubmit(undefined), { status: 'paused' });
  assert.deepEqual(f.host.onExcusalSubmit(undefined), { status: 'paused' });
  assert.deepEqual(f.host.onDecisionEdit(undefined), { status: 'paused' });
  assert.equal(f.state.opened, 0); assert.equal(f.state.getRequests.length, 0); assert.equal(f.state.created, 0);
});

test('native output configuration changes invalidate the reviewed host setup', () => {
  const f = fixture();
  let binding = 'projection-binding-one';
  f.runtime.configurationFingerprint = () => binding;
  f.activate();
  binding = 'projection-binding-two';
  assert.throws(() => f.host.flush(), code('setup_required'));
  assert.equal(f.state.commands.length, 0);
  assert.throws(() => f.host.resume(), code('setup_required'));
  assert.equal(f.properties.get(P.enabled), 'false');
});

test('setup requires explicit staging review and configured authenticated executor', () => {
  const f = fixture();
  assert.throws(() => parseStagingHostConfig({ ...f.config, environment: 'production' }), code('staging_configuration_required'));
  assert.throws(() => parseStagingHostConfig({ ...f.config, resourceReview: undefined }), code('staging_configuration_required'));
  f.state.executor = 'other@example.invalid';
  assert.throws(() => f.host.setup(), code('wrong_automation_identity'));
  assert.equal(f.state.opened, 0); assert.equal(f.state.created, 0); assert.equal(f.properties.get(P.enabled), 'false');
});

test('Forms API VERIFIED is mandatory; responder input or unavailable metadata cannot install triggers', () => {
  for (const mode of ['RESPONDER_INPUT', 'DO_NOT_COLLECT', undefined]) {
    const f = fixture(); f.state.responseMode = mode;
    assert.throws(() => f.host.setup(), code('verified_email_required'));
    assert.equal(f.state.created, 0);
  }
  const f = fixture(); f.state.formsStatus = 403;
  assert.throws(() => f.host.setup(), code('forms_verification_failed'));
  assert.equal(f.state.created, 0); assert.equal(f.properties.get(P.enabled), 'false');
});

test('setup uses existing resource IDs, installs exact versioned triggers once, and remains paused', () => {
  const f = fixture(); const legacy = f.trigger('legacyHandler', 'sheet', 'edit', 'legacy-workbook'); f.state.triggers.push(legacy);
  const first = f.host.setup(); const created = f.state.created;
  assert.deepEqual(first, { status: 'ready-paused', triggers: 4, verifiedForms: 2 });
  assert.equal(f.properties.get(P.enabled), 'false'); assert.equal(f.state.triggers.length, 5);
  f.host.setup(); assert.equal(f.state.created, created); assert.equal(f.state.deleted, 0);
  assert.ok(f.state.triggers.includes(legacy));
  assert.deepEqual(f.state.triggers.filter(t => t.getTriggerSource() === 'form').map(t => t.getTriggerSourceId()).sort(), [f.config.attendance.formId, f.config.excusal.formId].sort());
  assert.equal(f.books.size, 2); assert.equal(f.forms.size, 2);
  assert.ok(f.state.getRequests.every(request => request.url.endsWith('?fields=formId,settings.emailCollectionType')));
});

test('setup repairs only owned wrong-source triggers and stops if deletion fails', () => {
  const f = fixture(); f.state.triggers.push(f.trigger(H.attendance, 'form', 'submit', 'wrong-form'));
  f.host.setup(); assert.equal(f.state.deleted, 1); assert.equal(f.state.triggers.length, 4);
  const broken = fixture(); broken.state.triggers.push(broken.trigger(H.attendance, 'form', 'submit', 'wrong-form')); broken.state.failDelete = true;
  const before = broken.state.created;
  assert.throws(() => broken.host.setup(), /deletion failure/);
  assert.equal(broken.state.created, before); assert.equal(broken.properties.get(P.enabled), 'false');
});

test('missing existing tabs, unsafe sharing, or missing protections fail without replacements', () => {
  const f = fixture(); f.books.set(f.config.journal.spreadsheetId, []);
  assert.throws(() => f.host.setup(), code('configured_resource_unavailable')); assert.equal(f.state.created, 0);
  const g = fixture(); g.state.journalPrivate = false;
  assert.throws(() => g.host.setup(), /sharing rejected/); assert.equal(g.journal.rows.length, 0);
  const h = fixture(); h.state.decisionProtected = false;
  assert.throws(() => h.host.setup(), /protection rejected/); assert.equal(h.state.created, 0);
});

test('resume checks setup fingerprint, trigger manifest and present executor', () => {
  const f = fixture(); f.host.setup(); f.config.generation = 2; f.saveConfig();
  assert.throws(() => f.host.resume(), code('setup_required')); assert.equal(f.properties.get(P.enabled), 'false');
  f.host.setup(); f.state.triggers.pop();
  assert.throws(() => f.host.resume(), code('trigger_repair_required'));
  f.host.setup(); f.state.executor = '';
  assert.throws(() => f.host.resume(), code('wrong_automation_identity'));
});

test('native attendance delivery is signed, journaled and idempotent across replay', () => {
  const f = fixture(); f.activate(); const event = f.attendanceEvent('r'.repeat(280));
  assert.equal(f.host.onAttendanceSubmit(event).commands.committed, 1);
  assert.equal(f.state.commands.length, 1); assert.equal(f.state.commands[0].source.submissionId, 'r'.repeat(280));
  assert.equal(f.state.commands[0].actor.principalId, 'principal.cadet'); assert.equal(f.journal.rows.length, 2);
  f.host.onAttendanceSubmit(event); f.host.replayAttendanceResponse('r'.repeat(280));
  assert.equal(f.state.commands.length, 1); assert.equal(f.journal.rows.length, 2); assert.equal(f.lock.held, false);
  assert.equal(f.state.projections, 3);
});

test('changed native response content cannot silently reuse its original command identity', () => {
  const f = fixture(); f.activate(); const event = f.attendanceEvent(); f.host.onAttendanceSubmit(event);
  const original = event.response.getItemResponses;
  event.response.getItemResponses = () => original().map(item => item.getItem().getId() === 40 ? { getItem: item.getItem, getResponse: () => 'complete' } : item);
  assert.throws(() => f.host.onAttendanceSubmit(event), code('command_collision')); assert.equal(f.state.commands.length, 1);
});

test('current VERIFIED mode cannot establish identity for historical native responses', () => {
  const f = fixture(); const event = f.attendanceEvent(); f.state.now += 100; f.activate();
  assert.throws(() => f.host.replayAttendanceResponse('response.attendance'), code('historical_response_review_required'));
  assert.equal(f.state.commands.length, 0); assert.ok(f.responses.has('response.attendance'));
  const current = f.attendanceEvent('response.current'); current.response.getTimestamp = () => new Date(NaN);
  assert.throws(() => f.host.onAttendanceSubmit(current), code('historical_response_review_required'));
  assert.equal(f.state.commands.length, 0);
});

test('intake rechecks verified-email mode and accepts only its installed trigger and exact source', () => {
  const f = fixture(); f.activate(); const event = f.attendanceEvent();
  assert.throws(() => f.host.onAttendanceSubmit({ ...event, triggerUid: 'other-trigger' }), code('unrecognized_trigger'));
  assert.throws(() => f.host.onAttendanceSubmit({ ...event, source: { getId: () => 'wrong-form' } }), code('wrong_source'));
  f.state.responseMode = 'RESPONDER_INPUT';
  assert.throws(() => f.host.onAttendanceSubmit(event), code('verified_email_required'));
  assert.equal(f.state.commands.length, 0);
});

test('single-event excusal uses enrolled person and native verified email, never an Email answer', () => {
  const f = fixture(); f.activate();
  assert.throws(() => f.host.onExcusalSubmit(f.excusalEvent('')), code('confirmation_required'));
  f.host.onExcusalSubmit(f.excusalEvent()); f.host.replayExcusalResponse('response.excusal');
  assert.equal(f.state.commands.length, 1);
  assert.equal(f.state.commands[0].operation, 'excusal.submit'); assert.equal(f.state.commands[0].payload.personId, 'person.one');
  assert.equal(f.state.commands[0].payload.eventId, 'event.one'); assert.equal(f.state.commands[0].payload.requestedOutcome, 'E');
});

test('unknown sheet editor retains confirmation draft without substituting the automation owner', () => {
  const f = fixture(); f.activate(); const event = f.editEvent({ user: null });
  assert.deepEqual(f.host.onDecisionEdit(event), { status: 'confirmation-required' });
  assert.equal(f.state.commands.length, 0);
  const draft = JSON.parse(f.decisions.rows[2][6]);
  assert.equal(draft.actor, undefined); assert.equal(draft.status, 'confirmation-required'); assert.equal(draft.requestId, 'request.one');
  assert.equal(f.decisions.rows[2][3], 'Approved'); assert.equal(f.decisions.rows[2][2], 1);
  f.host.onDecisionEdit(event); assert.equal(JSON.parse(f.decisions.rows[2][6]).draftId, draft.draftId);
});

test('verified edit captures original input and frozen target, retains same identity on redelivery', () => {
  const f = fixture(); f.activate(); const event = f.editEvent();
  f.host.onDecisionEdit(event); f.host.onDecisionEdit(event);
  assert.equal(f.state.commands.length, 1); assert.equal(f.state.commands[0].operation, 'excusal.decide');
  assert.equal(f.state.commands[0].actor.evidence, 'google-edit'); assert.equal(f.state.commands[0].payload.expectedVersion, 1);
  assert.equal(f.decisions.rows[2][3], 'Approved'); assert.equal(f.decisions.rows[2][1], 'request.one');
  f.decisions.rows[2][1] = 'request.other';
  assert.throws(() => f.host.onDecisionEdit(event), code('draft_target_changed')); assert.equal(f.state.commands.length, 1);
});

test('bulk edits intersecting decision input and delayed values require review without a command', () => {
  const f = fixture(); f.activate();
  assert.throws(() => f.host.onDecisionEdit(f.editEvent({ col: 3, cols: 2, setCell: false })), code('bulk_review_required'));
  assert.throws(() => f.host.onDecisionEdit(f.editEvent({ rows: 2 })), code('bulk_review_required'));
  const delayed = f.editEvent(); f.decisions.rows[2][3] = 'Denied';
  assert.throws(() => f.host.onDecisionEdit(delayed), code('draft_input_changed'));
  assert.equal(f.state.commands.length, 0); assert.equal(f.decisions.rows[2][3], 'Denied');
});

test('pausing stops new intake and preserves pending original body through HTTP retry', () => {
  const f = fixture(); f.activate(); f.state.commandStatus = 503; const event = f.attendanceEvent();
  f.host.onAttendanceSubmit(event); const original = JSON.stringify(f.state.commands[0]);
  f.host.pause(); const requests = f.state.getRequests.length;
  assert.deepEqual(f.host.onAttendanceSubmit(event), { status: 'paused' }); assert.deepEqual(f.host.flush(), { status: 'paused' });
  assert.equal(f.state.getRequests.length, requests); assert.equal(f.journal.rows.length, 2);
  f.state.now += 1000; f.state.commandStatus = 200; f.host.resume(); f.host.flush();
  assert.equal(f.state.commands.length, 2); assert.equal(JSON.stringify(f.state.commands[1]), original);
});
