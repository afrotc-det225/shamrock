import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';

// Deliberately fictional, local-only fixture; never use a real bridge secret here.
const secret = 'fictional-test-secret-not-for-deployment-0001';
const keyId = 'fixture-key';
const migration = await readFile(new URL('../../database/migrations/0001_prototype.sql', import.meta.url), 'utf8');

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
  return { mf, db, send, count };
}
function command(operation = 'attendance.report', changes = {}) {
  const defaults = {
    'attendance.report': { reportId: 'report-one', eventId: 'event-one', unitId: 'alpha', rosterVersion: 1,
      coveredPersonIds: ['person-a', 'person-b'], presentPersonIds: ['person-a'], completeness: 'complete' },
    'excusal.submit': { requestId: 'request-one', eventId: 'event-one', personId: 'person-a', requestedOutcome: 'E', reason: 'Fictional scheduling conflict.' },
    'excusal.decide': { requestId: 'request-one', expectedVersion: 1, decision: 'Approved', reason: 'Fictional decision rationale.' },
  };
  return {
    commandId: operation.replace('.', '-'), contractVersion: 1, environment: 'local', generation: 1,
    actor: { principalId: operation === 'attendance.report' ? 'representative' : operation === 'excusal.submit' ? 'cadet-a' : 'approver', evidence: 'authenticated-confirmation' },
    source: { kind: 'test', resourceKey: 'fixture-console', submissionId: operation, revision: 1 },
    operation, payload: defaults[operation], ...changes,
  };
}
const jobRequest = extra => ({ environment: 'local', generation: 1, workerId: 'fixture-adapter', ...extra });

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
  assert.equal(await f.count('excusal_requests'), 0);
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
  assert.equal(await f.count('excusal_decisions'), 1);
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
  assert.equal(await f.count('excusal_decisions'), 1);
  stale.payload.expectedVersion = 2;
  assert.equal((await f.send(stale)).status, 200);
  assert.equal((await f.db.prepare('SELECT version FROM excusal_requests').first()).version, 3);
});

test('concurrent decisions at one base version commit exactly once', async t => {
  const f = await fixture(t);
  await f.send(command('excusal.submit'));
  const a = command('excusal.decide');
  const b = structuredClone(a); b.commandId = 'competing-decision'; b.source.submissionId = 'competing-decision'; b.payload.decision = 'Denied';
  const results = await Promise.all([f.send(a), f.send(b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(await f.count('excusal_decisions'), 1);
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
  assert.equal((await f.db.prepare("SELECT version FROM excusal_requests WHERE request_id='request-one'").first()).version, 1);
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
