import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../../.build/v3/apps/worker/src/index.js';
import { dailyD1LimitResponse, isDailyD1Limit, isRecordRead } from '../../.build/v3/apps/worker/src/provider-errors.js';

const secret = 'fictional-provider-error-test-secret-never-deploy';
const keyId = 'fixture-key';
const quota = () => new Error("Your account has exceeded D1's free tier daily row read limit. Private provider details.");
const identity = { environment: 'local', generation: 1, principalId: 'fixture-reader' };
const command = {
  contractVersion: 1, environment: 'local', generation: 1, commandId: 'fixture-command',
  actor: { principalId: 'fixture-representative', evidence: 'authenticated-confirmation' },
  source: { kind: 'test', resourceKey: 'fixture-console', submissionId: 'fixture-submission', revision: 1 },
  operation: 'attendance.report', payload: { reportId: 'fixture-report', eventId: 'fixture-event', unitId: 'fixture-flight',
    rosterVersion: 1, coveredPersonIds: ['fixture-person'], presentPersonIds: ['fixture-person'], completeness: 'complete' },
};

function request(path, input = identity, method = 'POST') {
  const body = method === 'GET' ? '' : JSON.stringify(input), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${method}\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  return new Request('https://worker-fixture.invalid' + path, { method, ...(body ? { body } : {}), headers: {
    'content-type': 'application/json', 'x-shamrock-key-id': keyId,
    'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature,
  } });
}

function failingDatabase(error) {
  let queries = 0;
  const fail = async () => { queries++; throw error; };
  const prepared = { bind: () => prepared, first: fail, all: fail, run: fail };
  return { env: { ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: keyId, BRIDGE_SECRET: secret,
    DB: { prepare: () => prepared, batch: fail } }, count: () => queries };
}

test('only explicit daily D1 read/write limits receive a UTC-reset cooldown', async () => {
  assert.equal(isDailyD1Limit(quota()), true);
  assert.equal(isDailyD1Limit(new Error('Batch failed', { cause: new Error('D1_ERROR: daily write quota exhausted') })), true);
  const cycle = new Error('D1_ERROR: ordinary failure'); cycle.cause = cycle;
  for (const error of [undefined, null, 7500, { code: 7500 }, cycle,
    new Error('D1_ERROR: SQL syntax error'), new Error('D1_ERROR: storage limit exceeded'),
    new Error('D1_ERROR: too many requests'), new Error('D1_ERROR: network read timeout'),
    new Error('Worker daily request limit exceeded')]) {
    assert.equal(isDailyD1Limit(error), false);
    assert.equal(dailyD1LimitResponse(error), null);
  }
  const noon = Date.UTC(2026, 10, 17, 12);
  for (const [now, seconds] of [[noon, '43200'], [noon + 43199999, '1'], [noon + 43200000, '86400']]) {
    const response = dailyD1LimitResponse(quota(), now);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), seconds);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'SERVICE_LIMIT_REACHED');
  }
});

test('signed reads and mutations preserve quota classification without exposing provider details or retrying', async () => {
  for (const [path, input, method] of [
    ['/v1/admin/panel/access', identity, 'POST'],
    ['/v1/admin/panel/page', { ...identity, section: 'manifest', offset: 0, revision: null }, 'POST'],
    ['/v1/commands/fixture-command?principalId=fixture-representative', null, 'GET'],
    ['/v1/commands', command, 'POST'],
  ]) {
    const f = failingDatabase(new Error('Private batch failure', { cause: quota() }));
    const response = await worker.fetch(request(path, input, method), f.env);
    assert.equal(response.status, 503, path);
    const delay = Number(response.headers.get('retry-after'));
    assert(delay >= 1 && delay <= 86400);
    assert.deepEqual(await response.json(), { error: { code: 'SERVICE_LIMIT_REACHED',
      message: "SHAMROCK's database has reached its daily limit. Please try again after midnight UTC." } });
    assert.equal(f.count(), 1, 'the error boundary makes no retry or diagnostic query');
  }
});

test('unrelated read failures use read guidance while writes retain receipt reconciliation', async () => {
  for (const [path, input, method, message] of [
    ['/v1/admin/panel/access', identity, 'POST', 'Records could not be loaded. Please try again shortly.'],
    ['/v1/commands/fixture-command?principalId=fixture-representative', null, 'GET', 'Records could not be loaded. Please try again shortly.'],
    ['/v1/commands', command, 'POST', 'The operation failed; check its receipt before retrying.'],
  ]) {
    const f = failingDatabase(new Error('D1_ERROR: SQL syntax error; private fixture row value'));
    const response = await worker.fetch(request(path, input, method), f.env);
    assert.equal(response.status, 500, path);
    assert.equal(response.headers.get('retry-after'), null);
    assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message } });
    assert.equal(f.count(), 1);
  }
  assert.equal(isRecordRead(request('/v1/admin/panel/view-as/access')), true);
  assert.equal(isRecordRead(request('/v1/admin/panel/view-as/authorize')), false, 'preview entry/exit writes an audit');
  assert.equal(isRecordRead(request('/v1/admin/unknown')), false, 'unknown POST operations use conservative guidance');
});

test('authentication failures do not consult a failed database or become quota errors', async () => {
  const f = failingDatabase(quota());
  const response = await worker.fetch(new Request('https://worker-fixture.invalid/v1/admin/panel/access', {
    method: 'POST', body: JSON.stringify(identity), headers: { 'content-type': 'application/json' },
  }), f.env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  assert.equal(f.count(), 0);
});
