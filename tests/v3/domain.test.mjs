import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError,
  parseCommand,
  buildAttendanceReport,
  createExcusalRequest,
  createExcusalRequests,
  decideExcusalRequest,
  deriveAttendanceView,
} from '../../.build/v3/packages/domain/src/index.js';

const SUBMITTED = '2026-11-05T12:00:00.000Z';
const DECIDED = '2026-11-05T13:00:00.000Z';

function requests(events = [{ eventId: 'event-b', requestId: 'request-b' }, { eventId: 'event-a', requestId: 'request-a' }]) {
  return envelope('excusal.submitMany', { personId: 'person-fixture-1', requestedOutcome: 'ES', reason: 'Fictional shared conflict.', events });
}

test('multi-event excusal expansion preserves child identity and canonicalizes event order', () => {
  const input = requests();
  const parsed = parseCommand(input);
  const reordered = structuredClone(input); reordered.payload.events.reverse();
  assert.deepEqual(parseCommand(reordered), parsed);
  const records = createExcusalRequests(input, SUBMITTED);
  assert.deepEqual(records.map(r => [r.eventId, r.requestId, r.status, r.version]), [
    ['event-a', 'request-a', 'Submitted', 1], ['event-b', 'request-b', 'Submitted', 1],
  ]);
  assert.ok(records.every(r => r.commandId === input.commandId && r.requestedOutcome === 'ES' && r.submittedAt === SUBMITTED));
  input.payload.events[0].requestId = 'changed'; input.source.submissionId = 'changed';
  assert.equal(records[1].requestId, 'request-b');
  assert.notEqual(records[1].source.submissionId, 'changed');
  records[0].source.submissionId = 'changed-child';
  assert.notEqual(records[1].source.submissionId, 'changed-child');
});

test('multi-event excusals reject ambiguous children and enforce an explicit 25-event bound', () => {
  for (const events of [[], [{ eventId: 'same', requestId: 'one' }, { eventId: 'same', requestId: 'two' }],
    [{ eventId: 'one', requestId: 'same' }, { eventId: 'two', requestId: 'same' }],
    [{ eventId: 'one', requestId: 'one', arbitrary: true }],
    Array.from({ length: 26 }, (_, i) => ({ eventId: `event-${i}`, requestId: `request-${i}` }))]) {
    rejectsInvalid(requests(events));
  }
  assert.equal(createExcusalRequests(requests(Array.from({ length: 25 }, (_, i) => ({ eventId: `event-${i}`, requestId: `request-${i}` }))), SUBMITTED).length, 25);
  const invalid = requests(); invalid.payload.requestedOutcome = 'unknown'; rejectsInvalid(invalid);
});

function envelope(operation, payload, overrides = {}) {
  return {
    commandId: 'command-fixture-1',
    contractVersion: 1,
    environment: 'local',
    generation: 1,
    actor: { principalId: 'principal-fixture-1', evidence: 'google-form' },
    source: { kind: 'test', resourceKey: 'fixture-form', submissionId: 'response-fixture-1', revision: 1 },
    operation,
    payload,
    ...overrides,
  };
}

function report(overrides = {}) {
  return envelope('attendance.report', {
    reportId: 'report-fixture-1', eventId: 'event-fixture-1', unitId: 'unit-fixture-alpha',
    rosterVersion: 4, coveredPersonIds: ['person-fixture-1', 'person-fixture-2'],
    presentPersonIds: ['person-fixture-1'], completeness: 'partial', ...overrides,
  });
}

function request(outcome = 'E') {
  return envelope('excusal.submit', {
    requestId: 'request-fixture-1', eventId: 'event-fixture-1', personId: 'person-fixture-1',
    requestedOutcome: outcome, reason: 'Fictional scheduling conflict.',
  });
}

function decision(value, expectedVersion = 1, overrides = {}) {
  return envelope('excusal.decide', {
    requestId: 'request-fixture-1', expectedVersion, decision: value,
    reason: 'Fictional reviewer explanation.', ...overrides,
  }, {
    commandId: `command-decision-${expectedVersion}`,
    actor: { principalId: 'principal-fixture-reviewer', evidence: 'authenticated-confirmation' },
    source: { kind: 'sheet', resourceKey: 'fixture-management', submissionId: `draft-${expectedVersion}`, revision: 1 },
  });
}

function rejectsInvalid(value) {
  assert.throws(() => parseCommand(value), error => error instanceof DomainError && error.code === 'INVALID_COMMAND');
}

test('partial attendance records selected evidence and immutable reporting scope without inferring absence', () => {
  const input = report();
  const result = buildAttendanceReport(input, SUBMITTED);
  assert.deepEqual(result.observations, [{
    personId: 'person-fixture-1', eventId: 'event-fixture-1', reportId: 'report-fixture-1', code: 'P',
  }]);
  assert.deepEqual(result.coveredPersonIds, ['person-fixture-1', 'person-fixture-2']);
  assert.equal(result.rosterVersion, 4);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.submittedBy, 'principal-fixture-1');
  assert.equal(result.source.submissionId, 'response-fixture-1');
  input.payload.coveredPersonIds[0] = 'person-changed-later';
  input.payload.presentPersonIds.push('person-fixture-2');
  input.source.submissionId = 'changed-source';
  assert.equal(result.coveredPersonIds[0], 'person-fixture-1');
  assert.equal(result.observations.length, 1);
  assert.equal(result.source.submissionId, 'response-fixture-1');
});

test('complete report can explicitly record zero attendees without inventing A or U', () => {
  const result = buildAttendanceReport(report({ completeness: 'complete', presentPersonIds: [] }), SUBMITTED);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.observations, []);
  assert.equal(result.coveredPersonIds.length, 2);
});

test('two overlapping reports retain their own reporting snapshots', () => {
  const first = buildAttendanceReport(report({ completeness: 'complete' }), SUBMITTED);
  const second = buildAttendanceReport(report({
    reportId: 'report-fixture-2', rosterVersion: 5,
    coveredPersonIds: ['person-fixture-2', 'person-fixture-3'], presentPersonIds: ['person-fixture-3'],
  }), DECIDED);
  assert.deepEqual(first.coveredPersonIds, ['person-fixture-1', 'person-fixture-2']);
  assert.deepEqual(second.coveredPersonIds, ['person-fixture-2', 'person-fixture-3']);
  assert.equal(first.rosterVersion, 4);
  assert.equal(second.rosterVersion, 5);
  assert.deepEqual(second.observations.map(item => item.personId), ['person-fixture-3']);
});

test('attendance rejects duplicate or out-of-scope selected IDs and missing scope', () => {
  rejectsInvalid(report({ presentPersonIds: ['person-not-covered'] }));
  rejectsInvalid(report({ presentPersonIds: ['person-fixture-1', 'person-fixture-1'] }));
  rejectsInvalid(report({ coveredPersonIds: ['person-fixture-1', 'person-fixture-1'] }));
  rejectsInvalid(report({ coveredPersonIds: [], presentPersonIds: [] }));
  rejectsInvalid(report({ rosterVersion: 0 }));
});

test('oversized interactive roster is rejected rather than truncated', () => {
  rejectsInvalid(report({ coveredPersonIds: Array.from({ length: 501 }, (_, index) => `person-fixture-${index}`) }));
});

test('a pending request preserves actual P and T independently', () => {
  const pending = createExcusalRequest(request(), SUBMITTED);
  for (const observed of ['P', 'T']) {
    assert.deepEqual(deriveAttendanceView(observed, pending), {
      observedCode: observed, requestStatus: 'Submitted', requestedOutcome: 'E', approvedOutcome: null, requestVersion: 1,
    });
  }
  assert.equal(deriveAttendanceView(null, pending).observedCode, null);
});

test('approval records the requested outcome separately for every supported request code', () => {
  for (const outcome of ['P', 'T', 'E', 'ES', 'MED']) {
    const submitted = createExcusalRequest(request(outcome), SUBMITTED);
    const approved = decideExcusalRequest(submitted, decision('Approved'), DECIDED);
    const view = deriveAttendanceView('P', approved);
    assert.equal(view.observedCode, 'P');
    assert.equal(view.approvedOutcome, outcome);
    assert.equal(approved.version, 2);
    assert.equal(submitted.version, 1);
    assert.equal(submitted.decision, null);
  }
});

test('denial never manufactures an attendance observation or automatic U/D', () => {
  const denied = decideExcusalRequest(createExcusalRequest(request(), SUBMITTED), decision('Denied'), DECIDED);
  assert.deepEqual(deriveAttendanceView(null, denied), {
    observedCode: null, requestStatus: 'Denied', requestedOutcome: 'E', approvedOutcome: null, requestVersion: 2,
  });
  assert.equal(deriveAttendanceView('P', denied).observedCode, 'P');
  assert.equal(deriveAttendanceView('A', denied).observedCode, 'A');
});

test('withdrawal and supersession remove approval without restoring a stale prior code', () => {
  for (const terminal of ['Withdrawn', 'Superseded']) {
    const submitted = createExcusalRequest(request('MED'), SUBMITTED);
    const approved = decideExcusalRequest(submitted, decision('Approved'), DECIDED);
    const changed = decideExcusalRequest(approved, decision(terminal, 2), '2026-11-05T14:00:00Z');
    assert.equal(deriveAttendanceView('T', changed).observedCode, 'T');
    assert.equal(deriveAttendanceView('T', changed).approvedOutcome, null);
    assert.equal(changed.status, terminal);
    assert.equal(changed.version, 3);
    assert.equal(approved.status, 'Approved');
    assert.equal(changed.submittedAt, SUBMITTED);
    assert.equal(changed.commandId, submitted.commandId);
    assert.equal(changed.lastCommandId, 'command-decision-2');
  }
});

test('decision binds to exact request and version and retains actor/provenance', () => {
  const submitted = createExcusalRequest(request(), SUBMITTED);
  const changed = decideExcusalRequest(submitted, decision('Approved'), DECIDED);
  assert.equal(changed.submittedBy, 'principal-fixture-1');
  assert.equal(changed.decidedBy, 'principal-fixture-reviewer');
  assert.equal(changed.decidedAt, DECIDED);
  assert.equal(changed.reason, submitted.reason);
  assert.equal(changed.decisionReason, 'Fictional reviewer explanation.');
  assert.deepEqual(changed.source, submitted.source);
  assert.throws(() => decideExcusalRequest(changed, decision('Denied'), DECIDED), error =>
    error instanceof DomainError && error.code === 'VERSION_CONFLICT');
  assert.throws(() => decideExcusalRequest(submitted, decision('Denied', 1, { requestId: 'request-wrong-target' }), DECIDED), error =>
    error instanceof DomainError && error.code === 'INVALID_COMMAND');
});

test('unknown operation, fields and unsafe environment fail closed', () => {
  rejectsInvalid({ ...report(), operation: 'sql.execute' });
  rejectsInvalid({ ...report(), environment: 'production' });
  rejectsInvalid({ ...report(), contractVersion: 2 });
  rejectsInvalid({ ...report(), authority: 'admin' });
  rejectsInvalid(report({ sql: 'unsupported-input' }));
  rejectsInvalid({ ...report(), actor: { principalId: 'principal-fixture-1', evidence: 'google-form', role: 'admin' } });
  rejectsInvalid({ ...report(), source: { kind: 'form', resourceKey: 'fixture-form', submissionId: 'response-fixture-1', revision: 1, actorEmail: 'unsupported-identity-field' } });
});

test('missing or fabricated actor evidence cannot enter the command contract', () => {
  rejectsInvalid({ ...report(), actor: { principalId: '', evidence: 'google-form' } });
  rejectsInvalid({ ...report(), actor: { principalId: 'principal-fixture-1', evidence: 'unknown' } });
  const missing = report();
  delete missing.actor;
  rejectsInvalid(missing);
});

test('version/source/identity and reason fields reject malformed values without echoing private input', () => {
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejectsInvalid({ ...report(), generation });
  rejectsInvalid({ ...report(), commandId: '../escape' });
  rejectsInvalid({ ...report(), source: { ...report().source, revision: 0 } });
  rejectsInvalid(request('anything'));
  rejectsInvalid(decision('anything'));
  rejectsInvalid(decision('Approved', 0));
  const privateText = 'Fictional private payload '.repeat(200);
  const value = request();
  value.payload.reason = privateText;
  assert.throws(() => parseCommand(value), error => {
    assert.equal(error.message.includes('Fictional private payload'), false);
    return error instanceof DomainError && error.code === 'INVALID_COMMAND';
  });
});

test('accepted timestamps are deterministic UTC values and reject impossible dates', () => {
  const first = createExcusalRequest(request(), '2026-11-05T12:00:00Z');
  assert.equal(first.submittedAt, SUBMITTED);
  assert.deepEqual(createExcusalRequest(request(), SUBMITTED), first);
  for (const timestamp of ['2026-02-30T12:00:00Z', '2026-11-05', 'not-a-date', '2026-11-05T12:00:00-05:00']) {
    assert.throws(() => buildAttendanceReport(report(), timestamp), error => error instanceof DomainError);
  }
});

test('opaque source identifiers retain their full value within the separate transport bound', () => {
  const submissionId = `source-${'x'.repeat(250)}`;
  const input = { ...report(), source: { ...report().source, submissionId } };
  assert.equal(parseCommand(input).source.submissionId, submissionId);
  rejectsInvalid({ ...input, source: { ...input.source, submissionId: 'x'.repeat(513) } });
  rejectsInvalid({ ...input, commandId: 'x'.repeat(129) });
});
