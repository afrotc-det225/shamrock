import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';
import worker from '../../.build/v3/apps/worker/src/index.js';

// Deliberately fictional, local-only fixture; never use a real bridge secret here.
const secret = 'fictional-test-secret-not-for-deployment-0001';
const keyId = 'fixture-key';
const migrationDirectory = new URL('../../database/migrations/', import.meta.url);
const migration = (await Promise.all((await readdir(migrationDirectory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()
  .map(name => readFile(new URL(name, migrationDirectory), 'utf8')))).join('\n');

async function fixture(t) {
  const mf = new Miniflare({
    modules: true, scriptPath: resolve('.build/v3-artifacts/worker.mjs'),
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'fixture-database' },
    bindings: { ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: keyId, BRIDGE_SECRET: secret },
    log: new Log(LogLevel.NONE),
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const statements = migration.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
    db.prepare("INSERT INTO people VALUES('person-a','Example A'),('person-b','Example B'),('person-c','Example C')"),
    db.prepare("INSERT INTO principals VALUES('representative',NULL,1),('cadet-a','person-a',1),('approver',NULL,1),('outsider',NULL,1)"),
    db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)"),
    db.prepare("INSERT INTO memberships VALUES('person-a','alpha',1),('person-b','alpha',1),('person-c','bravo',1)"),
    db.prepare("INSERT INTO events VALUES('event-one','Example event',1)"),
    db.prepare("INSERT INTO event_units VALUES('event-one','alpha'),('event-one','bravo')"),
    db.prepare("INSERT INTO access_grants VALUES('representative','attendance.report','alpha','unit'),('cadet-a','excusal.submit','alpha','self'),('approver','excusal.decide','alpha','unit')"),
    db.prepare("INSERT INTO adapter_sources VALUES('test','fixture-console',1),('form','fixture-form',1),('sheet','fixture-sheet',1)"),
  ]);
  async function send(input, options = {}) {
    const path = options.path ?? '/v1/commands';
    const method = options.method ?? 'POST';
    const body = options.rawBody ?? (method === 'GET' ? '' : JSON.stringify(input));
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const canonical = `${method}\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`;
    const signature = createHmac('sha256', options.secret ?? secret).update(canonical).digest('hex');
    const response = await mf.dispatchFetch(`https://fixture.invalid${path}`, {
      method, ...(method === 'GET' ? {} : { body }), headers: {
        'content-type': 'application/json', 'x-shamrock-key-id': options.keyId ?? keyId,
        'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature,
        ...options.headers,
      },
    });
    return { status: response.status, body: await response.json() };
  }
  const count = async table => (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
  return { mf, db, send, count, env: { DB: db, ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: keyId, BRIDGE_SECRET: secret } };
}
function command(operation = 'attendance.report', changes = {}) {
  const defaults = {
    'attendance.report': { reportId: 'report-one', eventId: 'event-one', unitId: 'alpha', rosterVersion: 1,
      coveredPersonIds: ['person-a', 'person-b'], presentPersonIds: ['person-a'], completeness: 'complete' },
    'excusal.submit': { requestId: 'request-one', eventId: 'event-one', personId: 'person-a', requestedOutcome: 'E', reason: 'Fictional scheduling conflict.' },
    'excusal.submitMany': { personId: 'person-a', requestedOutcome: 'E', reason: 'Fictional multi-event scheduling conflict.', events: [
      { eventId: 'event-one', requestId: 'request-one' }, { eventId: 'event-two', requestId: 'request-two' },
    ] },
    'excusal.decide': { requestId: 'request-one', expectedVersion: 1, decision: 'Approved', reason: 'Fictional decision rationale.' },
  };
  return {
    commandId: operation.replace('.', '-'), contractVersion: 1, environment: 'local', generation: 1,
    actor: { principalId: operation === 'attendance.report' ? 'representative' : operation.startsWith('excusal.submit') ? 'cadet-a' : 'approver', evidence: 'authenticated-confirmation' },
    source: { kind: 'test', resourceKey: 'fixture-console', submissionId: operation, revision: 1 },
    operation, payload: defaults[operation], ...changes,
  };
}
const jobRequest = extra => ({ environment: 'local', generation: 1, workerId: 'fixture-adapter', ...extra });
function signedNativeRequest(input) {
  const body = JSON.stringify(input); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`POST\n/v1/commands\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  return new Request('https://fixture.invalid/v1/commands', { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-shamrock-key-id': keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature,
  } });
}

test('public health is minimal; domain operations require valid signed adapter requests', async t => {
  const f = await fixture(t);
  const health = await f.mf.dispatchFetch('https://fixture.invalid/health');
  assert.deepEqual(await health.json(), { service: 'shamrock', phase: 'isolated-prototype', contractVersion: 1 });
  const response = await f.mf.dispatchFetch('https://fixture.invalid/v1/commands', { method: 'POST', body: JSON.stringify(command()) });
  assert.equal(response.status, 401);
  for (const options of [{ secret: 'wrong-secret' }, { keyId: 'wrong-key' }, { timestamp: Math.floor(Date.now() / 1000) - 301 }]) {
    assert.equal((await f.send(command(), options)).status, 401);
  }
  assert.equal(await f.count('operation_commands'), 0);
});

test('attendance saves evidence, audit, receipt and outbox together without inferring absences', async t => {
  const f = await fixture(t);
  const response = await f.send(command());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'committed');
  assert.equal(response.body.pendingEffects, true);
  for (const table of ['attendance_reports', 'attendance_observations', 'attendance_current', 'operation_commands', 'audit_events', 'outbox_jobs']) {
    assert.equal(await f.count(table), 1, table);
  }
  assert.equal(await f.count('attendance_report_members'), 2);
  assert.equal(await f.count('command_assertions'), 0);
  const unreported = await f.db.prepare("SELECT * FROM attendance_current WHERE person_id='person-b'").first();
  assert.equal(unreported, null);
});

test('identical retries return the exact receipt while reused command or source identity cannot duplicate work', async t => {
  const f = await fixture(t);
  const original = command();
  const first = await f.send(original);
  assert.equal(first.status, 200);
  assert.deepEqual(await f.send(original), first);
  const changed = structuredClone(original); changed.payload.presentPersonIds = [];
  assert.equal((await f.send(changed)).status, 409);
  const newId = structuredClone(original); newId.commandId = 'another-command'; newId.payload.reportId = 'another-report';
  assert.equal((await f.send(newId)).status, 409);
  assert.equal(await f.count('operation_commands'), 1);
  assert.equal(await f.count('outbox_jobs'), 1);
});

test('a submission retry cannot use a new-unit grant to read its old-unit receipt', async t => {
  const f = await fixture(t);
  const original = command('excusal.submit');
  assert.equal((await f.send(original)).status, 200);
  await f.db.batch([
    f.db.prepare("UPDATE memberships SET unit_id='bravo' WHERE person_id='person-a'"),
    f.db.prepare("UPDATE access_grants SET unit_id='bravo' WHERE principal_id='cadet-a'"),
  ]);
  assert.equal((await f.send(original)).status, 403);
  const receipt = await f.send(null, { method: 'GET', path: `/v1/commands/${original.commandId}?principalId=cadet-a` });
  assert.equal(receipt.status, 404);
  assert.equal(await f.count('operation_commands'), 1);
  assert.equal(await f.count('excusal_records'), 1);
  assert.equal(await f.count('audit_events'), 1);
  assert.equal(await f.count('outbox_jobs'), 1);
});

test('wrong generation, unknown sources and revoked or cross-unit actors fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(command(undefined, { generation: 2 }))).status, 409);
  const unknown = command(); unknown.source.resourceKey = 'unknown-source';
  assert.equal((await f.send(unknown)).status, 403);
  const crossUnit = command(); crossUnit.payload.unitId = 'bravo'; crossUnit.payload.coveredPersonIds = ['person-c']; crossUnit.payload.presentPersonIds = ['person-c'];
  assert.equal((await f.send(crossUnit)).status, 403);
  await f.db.prepare("UPDATE principals SET active=0 WHERE principal_id='representative'").run();
  assert.equal((await f.send(command())).status, 403);
  assert.equal(await f.count('operation_commands'), 0);
});

test('self-service excusals cannot target a different cadet and evidence must match source type', async t => {
  const f = await fixture(t);
  const request = command('excusal.submit'); request.payload.personId = 'person-b';
  assert.equal((await f.send(request)).status, 403);
  const mismatch = command(); mismatch.actor.evidence = 'google-edit';
  assert.equal((await f.send(mismatch)).status, 400);
  assert.equal(await f.count('excusal_records'), 0);
});

test('roster-version and completed-scope assertions roll back the entire batch', async t => {
  const f = await fixture(t);
  const stale = command(); stale.payload.rosterVersion = 2;
  assert.equal((await f.send(stale)).status, 409);
  const incomplete = command(); incomplete.payload.coveredPersonIds = ['person-a'];
  assert.equal((await f.send(incomplete)).status, 409);
  for (const table of ['operation_commands', 'attendance_reports', 'audit_events', 'outbox_jobs', 'command_assertions']) {
    assert.equal(await f.count(table), 0);
  }
  incomplete.payload.completeness = 'partial';
  assert.equal((await f.send(incomplete)).status, 200);
});

test('failure after domain writes rolls back evidence, receipt and pending publication', async t => {
  const f = await fixture(t);
  await f.db.prepare("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit unavailable'); END").run();
  assert.notEqual((await f.send(command())).status, 200);
  for (const table of ['operation_commands', 'attendance_reports', 'attendance_observations', 'attendance_current', 'audit_events', 'outbox_jobs']) {
    assert.equal(await f.count(table), 0, table);
  }
});

test('pending and approved excusals never overwrite an existing presence observation', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(command())).status, 200);
  const submitted = await f.send(command('excusal.submit'));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.result.status, 'Submitted');
  assert.equal((await f.db.prepare('SELECT observed_code FROM attendance_current').first()).observed_code, 'P');
  const approved = await f.send(command('excusal.decide'));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.result.version, 2);
  assert.equal(approved.body.result.status, 'Approved');
  assert.equal((await f.db.prepare('SELECT observed_code FROM attendance_current').first()).observed_code, 'P');
  assert.equal(await f.count('excusal_record_decisions'), 1);
  assert.equal(await f.count('audit_events'), 3);
});

test('stale reconsideration cannot mutate state; a retry of the accepted decision remains idempotent', async t => {
  const f = await fixture(t);
  await f.send(command('excusal.submit'));
  const decision = command('excusal.decide');
  const accepted = await f.send(decision);
  assert.deepEqual(await f.send(decision), accepted);
  const stale = structuredClone(decision); stale.commandId = 'decision-two'; stale.source.submissionId = 'decision-two'; stale.payload.decision = 'Denied';
  assert.equal((await f.send(stale)).status, 409);
  assert.equal(await f.count('excusal_record_decisions'), 1);
  stale.payload.expectedVersion = 2;
  assert.equal((await f.send(stale)).status, 200);
  assert.equal((await f.db.prepare('SELECT version FROM excusal_records').first()).version, 3);
});

test('concurrent decisions at one base version commit exactly once', async t => {
  const f = await fixture(t);
  await f.send(command('excusal.submit'));
  const a = command('excusal.decide');
  const b = structuredClone(a); b.commandId = 'competing-decision'; b.source.submissionId = 'competing-decision'; b.payload.decision = 'Denied';
  const results = await Promise.all([f.send(a), f.send(b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(await f.count('excusal_record_decisions'), 1);
  assert.equal(await f.count('operation_commands'), 2);
});

test('receipt reads require the original active authorized actor', async t => {
  const f = await fixture(t);
  await f.send(command());
  const original = await f.send(null, { method: 'GET', path: '/v1/commands/attendance-report?principalId=representative' });
  assert.equal(original.status, 200);
  assert.equal((await f.send(null, { method: 'GET', path: '/v1/commands/attendance-report?principalId=outsider' })).status, 404);
  await f.db.prepare("DELETE FROM access_grants WHERE principal_id='representative'").run();
  assert.equal((await f.send(null, { method: 'GET', path: '/v1/commands/attendance-report?principalId=representative' })).status, 404);
});

test('publication jobs serialize a resource, publish latest facts and require current claim token', async t => {
  const f = await fixture(t);
  await f.send(command()); await f.send(command('excusal.submit'));
  const claim = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  assert.equal(claim.status, 200);
  const { jobId, claimToken } = claim.body.job;
  assert.equal((await f.send(jobRequest(), { path: '/v1/jobs/claim' })).body.job, null);
  const identity = jobRequest({ jobId, claimToken });
  const projection = await f.send(identity, { path: '/v1/jobs/project' });
  assert.equal(projection.status, 200);
  assert.equal(projection.body.revision, 2);
  assert.deepEqual(projection.body.rows[0], { personId: 'person-a', displayName: 'Example A', observedCode: 'P', requests: [{ requestId: 'request-one', status: 'Submitted', requestedOutcome: 'E', version: 1 }] });
  assert.equal(projection.body.rows[1].observedCode, null);
  assert.equal((await f.send({ ...identity, claimToken: 'wrong-token' }, { path: '/v1/jobs/ack' })).status, 409);
  assert.equal((await f.send(identity, { path: '/v1/jobs/ack' })).status, 200);
  assert.equal((await f.send(identity, { path: '/v1/jobs/ack' })).status, 409);
  assert.ok((await f.send(jobRequest(), { path: '/v1/jobs/claim' })).body.job);
});

test('projection revision advances with decisions and omitted request subjects fail closed', async t => {
  const f = await fixture(t);
  await f.send(command()); await f.send(command('excusal.submit'));
  const { body } = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  const identity = jobRequest({ jobId: body.job.jobId, claimToken: body.job.claimToken });
  const first = await f.send(identity, { path: '/v1/jobs/project' });
  await f.send(command('excusal.decide'));
  const second = await f.send(identity, { path: '/v1/jobs/project' });
  assert.equal(second.body.revision, first.body.revision + 1);
  assert.equal(second.body.rows[0].requests[0].version, 2);
  await f.db.prepare("UPDATE memberships SET active=0 WHERE person_id='person-a'").run();
  const missing = await f.send(identity, { path: '/v1/jobs/project' });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, 'PROJECTION_INCOMPLETE');
  assert.equal((await f.db.prepare("SELECT state FROM outbox_jobs WHERE job_id=?").bind(identity.jobId).first()).state, 'leased');
});

test('multiple active units fail closed for reports, requests and decision scope', async t => {
  const f = await fixture(t);
  await f.send(command('excusal.submit'));
  // Even a second unit not participating in this event is unsupported: evidence
  // is event/person keyed and would otherwise escape per-unit publication revisions.
  await f.db.batch([
    f.db.prepare("DELETE FROM event_units WHERE unit_id='bravo'"),
    f.db.prepare("INSERT INTO memberships VALUES('person-a','bravo',1)"),
  ]);
  for (const input of [command(), command('excusal.submit'), command('excusal.decide')]) {
    const response = await f.send(input);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'AMBIGUOUS_SCOPE');
  }
  assert.equal(await f.count('operation_commands'), 1);
  assert.equal(await f.count('audit_events'), 1);
  assert.equal(await f.count('outbox_jobs'), 1);
  assert.equal(await f.count('attendance_current'), 0);
  assert.equal((await f.db.prepare("SELECT version FROM excusal_records WHERE request_id='request-one'").first()).version, 1);
});

test('a membership ambiguity introduced after acceptance blocks projection without acknowledging it', async t => {
  const f = await fixture(t);
  await f.send(command());
  const { body } = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  await f.db.prepare("INSERT INTO memberships VALUES('person-b','bravo',1)").run();
  const identity = jobRequest({ jobId: body.job.jobId, claimToken: body.job.claimToken });
  const projection = await f.send(identity, { path: '/v1/jobs/project' });
  assert.equal(projection.status, 409);
  assert.equal(projection.body.error.code, 'AMBIGUOUS_SCOPE');
  assert.equal((await f.db.prepare('SELECT state FROM outbox_jobs WHERE job_id=?').bind(identity.jobId).first()).state, 'leased');
});

test('expired publication lease is never stolen while a prior Google request may still be active', async t => {
  const f = await fixture(t);
  await f.send(command()); await f.send(command('excusal.submit'));
  const { body } = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  const identity = jobRequest({ jobId: body.job.jobId, claimToken: body.job.claimToken });
  await f.db.prepare("UPDATE outbox_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE state='leased'").run();
  assert.equal((await f.send(identity, { path: '/v1/jobs/project' })).status, 409);
  assert.equal((await f.send(identity, { path: '/v1/jobs/ack' })).status, 409);
  assert.equal((await f.send(jobRequest(), { path: '/v1/jobs/claim' })).body.job, null);
});

test('maintenance fence rejects new mutations and publication acknowledgement', async t => {
  const f = await fixture(t);
  await f.send(command());
  const { body } = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  await f.db.prepare('UPDATE system_control SET accepting_commands=0').run();
  assert.equal((await f.send(command('excusal.submit'))).status, 403);
  assert.equal((await f.send(jobRequest({ jobId: body.job.jobId, claimToken: body.job.claimToken }), { path: '/v1/jobs/ack' })).status, 409);
});

test('500-person report uses bounded SQL statements and JSON parameters rather than per-person queries', async t => {
  const f = await fixture(t);
  const people = Array.from({ length: 500 }, (_, i) => `synthetic-${i}`);
  await f.db.batch([
    f.db.prepare("UPDATE memberships SET active=0 WHERE unit_id='alpha'"),
    f.db.prepare("UPDATE organizational_units SET roster_version=2 WHERE unit_id='alpha'"),
    f.db.prepare('INSERT INTO people SELECT value,value FROM json_each(?)').bind(JSON.stringify(people)),
    f.db.prepare("INSERT INTO memberships SELECT value,'alpha',1 FROM json_each(?)").bind(JSON.stringify(people)),
  ]);
  const bulk = command(); Object.assign(bulk.payload, { coveredPersonIds: people, presentPersonIds: people, rosterVersion: 2 });
  const response = await f.send(bulk);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(await f.count('attendance_observations'), 500);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM attendance_report_members WHERE present=1').first()).count, 500);
  assert.equal(await f.count('operation_commands'), 1);
});

test('oversized and unsupported payloads fail before any authoritative write', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(null, { rawBody: ' '.repeat(65_537) })).status, 413);
  const malformed = command(); malformed.payload.untrusted = true;
  assert.equal((await f.send(malformed)).status, 400);
  assert.equal(await f.count('operation_commands'), 0);
});

test('maximum-length command IDs still produce claimable publication job IDs', async t => {
  const f = await fixture(t);
  const long = command(); long.commandId = 'x'.repeat(128);
  assert.equal((await f.send(long)).status, 200);
  const claim = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
  assert.ok(claim.body.job.jobId.length <= 128);
  const identity = jobRequest({ jobId: claim.body.job.jobId, claimToken: claim.body.job.claimToken });
  assert.equal((await f.send(identity, { path: '/v1/jobs/project' })).status, 200);
  assert.equal((await f.send(identity, { path: '/v1/jobs/ack' })).status, 200);
});

test('receipt access rechecks a changed self-service person mapping', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(command('excusal.submit'))).status, 200);
  await f.db.prepare("UPDATE principals SET person_id='person-b' WHERE principal_id='cadet-a'").run();
  assert.equal((await f.send(null, { method: 'GET', path: '/v1/commands/excusal-submit?principalId=cadet-a' })).status, 404);
});

test('concurrent identical deliveries create one report and return one receipt', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.send(command()), f.send(command())]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(await f.count('operation_commands'), 1);
  assert.equal(await f.count('audit_events'), 1);
});

test('changing the database generation fences a previously valid signed deployment', async t => {
  const f = await fixture(t);
  await f.db.prepare('UPDATE system_control SET generation=2').run();
  assert.equal((await f.send(command())).status, 403);
  assert.equal(await f.count('operation_commands'), 0);
});

async function extraEvents(f, ids = ['event-two']) {
  await f.db.batch([
    f.db.prepare('INSERT INTO events SELECT value,value,1 FROM json_each(?)').bind(JSON.stringify(ids)),
    f.db.prepare("INSERT INTO event_units SELECT value,'alpha' FROM json_each(?)").bind(JSON.stringify(ids)),
  ]);
}

test('multi-event excusals atomically create children, one receipt/audit and every projection scope', async t => {
  const f = await fixture(t); await extraEvents(f);
  const input = command('excusal.submitMany'); input.payload.events.reverse();
  const accepted = await f.send(input);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.result.requests.map(r => [r.eventId, r.requestId, r.status]), [
    ['event-one', 'request-one', 'Submitted'], ['event-two', 'request-two', 'Submitted'],
  ]);
  input.payload.events.reverse();
  assert.deepEqual(await f.send(input), accepted, 'event selection order is not retry identity');
  for (const [table, count] of Object.entries({ excusal_records: 2, command_event_scopes: 2, operation_commands: 1, audit_events: 1, outbox_jobs: 2, attendance_current: 0 })) {
    assert.equal(await f.count(table), count, table);
  }
  const events = [];
  for (let i = 0; i < 2; i++) {
    const claim = await f.send(jobRequest(), { path: '/v1/jobs/claim' });
    const identity = jobRequest({ jobId: claim.body.job.jobId, claimToken: claim.body.job.claimToken });
    const projection = await f.send(identity, { path: '/v1/jobs/project' });
    assert.equal(projection.status, 200); assert.equal(projection.body.revision, 1);
    events.push(projection.body.event.eventId);
    assert.equal(projection.body.rows[0].requests.length, 1);
    assert.equal((await f.send(identity, { path: '/v1/jobs/ack' })).status, 200);
  }
  assert.deepEqual(events.sort(), ['event-one', 'event-two']);
});

test('every selected event must remain active and authorized in the subject unit', async t => {
  const f = await fixture(t); await extraEvents(f);
  for (const invalid of ['inactive', 'wrong-unit', 'unknown']) {
    await f.db.prepare("UPDATE events SET active=? WHERE event_id='event-two'").bind(invalid === 'inactive' ? 0 : 1).run();
    await f.db.prepare("UPDATE event_units SET unit_id=? WHERE event_id='event-two'").bind(invalid === 'wrong-unit' ? 'bravo' : 'alpha').run();
    const input = command('excusal.submitMany');
    if (invalid === 'unknown') input.payload.events[1].eventId = 'unknown';
    assert.equal((await f.send(input)).status, 403, invalid);
    assert.equal(await f.count('excusal_records'), 0);
  }
  await f.db.prepare("UPDATE event_units SET unit_id='alpha' WHERE event_id='event-two'").run();
  const other = command('excusal.submitMany'); other.payload.personId = 'person-b';
  assert.equal((await f.send(other)).status, 403);
  assert.equal(await f.count('operation_commands'), 0);
});

test('a colliding child or failed second projection insertion rolls back every child and receipt', async t => {
  const f = await fixture(t); await extraEvents(f);
  await f.send(command('excusal.submit'));
  const collision = command('excusal.submitMany');
  assert.equal((await f.send(collision)).status, 409);
  assert.equal(await f.count('excusal_records'), 1);
  collision.payload.events[0].requestId = 'new-request';
  await f.db.prepare("CREATE TRIGGER fail_second_job BEFORE INSERT ON outbox_jobs WHEN NEW.event_id='event-two' BEGIN SELECT RAISE(ABORT, 'fixture publication unavailable'); END").run();
  assert.notEqual((await f.send(collision)).status, 200);
  for (const table of ['operation_commands', 'excusal_records', 'command_event_scopes', 'audit_events', 'outbox_jobs']) assert.equal(await f.count(table), 1, table);
});

test('native source identity prevents single/multi-event and revision changes from duplicating submissions', async t => {
  const f = await fixture(t); await extraEvents(f);
  const single = command('excusal.submit');
  single.source = { kind: 'form', resourceKey: 'fixture-form', submissionId: 'native-response', revision: 1 };
  single.actor.evidence = 'google-form';
  assert.equal((await f.send(single)).status, 200);
  const many = command('excusal.submitMany'); many.source = { ...single.source }; many.actor.evidence = 'google-form';
  many.payload.events[0].requestId = 'different-child';
  assert.equal((await f.send(many)).status, 409);
  many.source.revision = 2;
  assert.equal((await f.send(many)).status, 409);
  assert.equal(await f.count('operation_commands'), 1);
  assert.equal(await f.count('excusal_records'), 1);
});

test('concurrent identical multi-event deliveries return one receipt; competing parent IDs cannot split a source', async t => {
  const f = await fixture(t); await extraEvents(f);
  const input = command('excusal.submitMany');
  const results = await Promise.all([f.send(input), f.send(input)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]); assert.deepEqual(results[0], results[1]);
  const other = structuredClone(input); other.commandId = 'competing-parent';
  other.payload.events = other.payload.events.map(e => ({ ...e, requestId: `${e.requestId}-other` }));
  assert.equal((await f.send(other)).status, 409);
  assert.equal(await f.count('operation_commands'), 1); assert.equal(await f.count('excusal_records'), 2);
});

test('a multi-event receipt and its retry recheck current permission for every event', async t => {
  const f = await fixture(t); await extraEvents(f);
  const input = command('excusal.submitMany'); assert.equal((await f.send(input)).status, 200);
  const read = () => f.send(null, { method: 'GET', path: '/v1/commands/excusal-submitMany?principalId=cadet-a' });
  assert.equal((await read()).status, 200);
  await f.db.prepare("UPDATE events SET active=0 WHERE event_id='event-two'").run();
  assert.equal((await read()).status, 404); assert.equal((await f.send(input)).status, 403);
  await f.db.prepare("UPDATE events SET active=1 WHERE event_id='event-two'").run();
  await f.db.prepare("UPDATE principals SET person_id='person-b' WHERE principal_id='cadet-a'").run();
  assert.equal((await read()).status, 404); assert.equal((await f.send(input)).status, 403);
});

test('authority revocation between preflight and the D1 batch aborts all multi-event writes', async t => {
  const f = await fixture(t); await extraEvents(f);
  const body = JSON.stringify(command('excusal.submitMany')); const path = '/v1/commands';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`POST\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  let intercepted = false;
  const DB = { prepare: sql => f.db.prepare(sql), batch: async statements => {
    intercepted = true;
    await f.db.prepare("DELETE FROM access_grants WHERE principal_id='cadet-a'").run();
    return f.db.batch(statements);
  } };
  const response = await worker.fetch(new Request(`https://fixture.invalid${path}`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-shamrock-key-id': keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature } }), { ...f.env, DB });
  assert.ok(intercepted); assert.equal(response.status, 409);
  for (const table of ['operation_commands', 'command_event_scopes', 'excusal_records', 'audit_events', 'outbox_jobs']) assert.equal(await f.count(table), 0, table);
});

test('maximum 25-event submission has complete child/job coverage and independent decision versions', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 24 }, (_, i) => `event-extra-${i}`); await extraEvents(f, ids);
  const input = command('excusal.submitMany'); input.payload.events = ['event-one', ...ids].map((eventId, i) => ({ eventId, requestId: `child-${i}` }));
  const accepted = await f.send(input); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.result.requests.length, 25);
  assert.equal(await f.count('excusal_records'), 25); assert.equal(await f.count('command_event_scopes'), 25); assert.equal(await f.count('outbox_jobs'), 25);
  const decisions = ['child-0', 'child-1'].map((requestId, i) => command('excusal.decide', {
    commandId: `decision-child-${i}`, source: { kind: 'test', resourceKey: 'fixture-console', submissionId: `decision-child-${i}`, revision: 1 },
    payload: { requestId, expectedVersion: 1, decision: i === 0 ? 'Approved' : 'Denied', reason: 'Fictional independent child decision.' },
  }));
  assert.deepEqual((await Promise.all(decisions.map(d => f.send(d)))).map(r => r.status), [200, 200]);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM excusal_records WHERE version=2').first()).count, 2);
  assert.equal(await f.count('audit_events'), 3);
});

test('a secondary event scope revoked after preflight rolls the entire submission back', async t => {
  const f = await fixture(t); await extraEvents(f);
  const DB = { prepare: sql => f.db.prepare(sql), batch: async statements => {
    await f.db.prepare("DELETE FROM event_units WHERE event_id='event-two'").run();
    return f.db.batch(statements);
  } };
  const response = await worker.fetch(signedNativeRequest(command('excusal.submitMany')), { ...f.env, DB });
  assert.equal(response.status, 409);
  for (const table of ['operation_commands', 'command_event_scopes', 'excusal_records', 'audit_events', 'outbox_jobs']) assert.equal(await f.count(table), 0, table);
});

test('receipt retry cannot expose a committed submission if authority is revoked after preflight', async t => {
  const f = await fixture(t); await extraEvents(f);
  const input = command('excusal.submitMany'); assert.equal((await f.send(input)).status, 200);
  let intercepted = false;
  const DB = { batch: statements => f.db.batch(statements), prepare: sql => ({ bind(...values) {
    const statement = f.db.prepare(sql).bind(...values);
    if (!sql.startsWith('SELECT payload_hash AS')) return statement;
    return { first: async () => {
      intercepted = true;
      await f.db.prepare("DELETE FROM access_grants WHERE principal_id='cadet-a'").run();
      return statement.first();
    } };
  } }) };
  const response = await worker.fetch(signedNativeRequest(input), { ...f.env, DB });
  assert.ok(intercepted); assert.equal(response.status, 403);
  assert.equal(await f.count('operation_commands'), 1); assert.equal(await f.count('excusal_records'), 2);
});

test('competing parent commands for one native response cannot split its event children', async t => {
  const f = await fixture(t); await extraEvents(f);
  const a = command('excusal.submitMany');
  a.source = { kind: 'form', resourceKey: 'fixture-form', submissionId: 'same-native-response', revision: 1 };
  a.actor.evidence = 'google-form';
  const b = structuredClone(a); b.commandId = 'competing-batch'; b.payload.events.forEach(e => { e.requestId += '-other'; });
  const results = await Promise.all([f.send(a), f.send(b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(await f.count('operation_commands'), 1); assert.equal(await f.count('excusal_records'), 2);
  const parents = await f.db.prepare('SELECT DISTINCT command_id FROM excusal_records').all();
  assert.equal(parents.results.length, 1);
  assert.equal(await f.count('command_event_scopes'), 2); assert.equal(await f.count('outbox_jobs'), 2);
});
