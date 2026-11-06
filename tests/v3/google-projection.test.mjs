import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { consumeProjectionJobs, initializeProjectionSheets, parseProjectionSnapshot,
  PROJECTION_HEADERS, publishProjectionSnapshot, upgradeRecordedDecisionLabels } from '../../.build/v3/apps/google-adapter/src/projection.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const secret = 'fictional-projection-test-secret-not-for-deployment';
const signer = { sha256, hmacSha256: value => createHmac('sha256', secret).update(value).digest('hex') };
const clone = value => JSON.parse(JSON.stringify(value));
const config = { baseUrl: 'https://fixture.invalid', keyId: 'fixture-key', environment: 'local', generation: 1 };
const fixtureSnapshot = () => ({ revision: 2, event: { eventId: 'event-one', label: 'Example event' },
  unit: { unitId: 'alpha', label: 'Alpha' }, rows: [
    { personId: 'person-a', displayName: 'Example A', observedCode: 'P', requests: [
      { requestId: 'request-one', status: 'Submitted', requestedOutcome: 'E', version: 1 },
    ] },
    { personId: 'person-b', displayName: 'Example B', observedCode: null, requests: [] },
  ] });
const fixtureClaim = () => ({ jobId: `projection:${sha256('fixture-command')}`, claimToken: 'fixture-claim',
  leaseExpiresAt: '2030-01-01T00:10:00.000Z', eventId: 'event-one', unitId: 'alpha', kind: 'attendance.projection' });

class Sheet {
  values = [];
  writes = [];
  filterViews = [{ id: 'fictional-filter', column: 'unit_id' }];
  protected = true;
  formula = false;
  afterWrite;
  getLastRow() { return this.values.length; }
  getLastColumn() { return Math.max(0, ...this.values.map(row => row.length)); }
  getRange(row, column, rows, columns) {
    return {
      getValues: () => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => this.values[row - 1 + r]?.[column - 1 + c] ?? '')),
      getFormulas: () => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => this.formula && row + r === 3 && c === 0 ? '=1' : '')),
    };
  }
  writeRaw(row, column, values) {
    this.writes.push({ row, column, values: clone(values) });
    for (let r = 0; r < values.length; r++) {
      while (this.values.length < row + r) this.values.push([]);
      for (let c = 0; c < values[r].length; c++) this.values[row - 1 + r][column - 1 + c] = values[r][c];
    }
    this.afterWrite?.();
  }
  row(key, value) {
    const index = this.values[0].indexOf(key);
    const cells = this.values.slice(2).find(cells => cells[index] === value);
    return cells && Object.fromEntries(this.values[0].map((key, i) => [key, cells[i]]));
  }
  set(row, key, value) { this.values[row - 1][this.values[0].indexOf(key)] = value; }
  reorderHeaders() { this.values = this.values.map(row => [...row].reverse()); }
}
function runtime() {
  const sheets = { attendance: new Sheet(), decisions: new Sheet(), cursors: new Sheet() };
  initializeProjectionSheets(sheets);
  for (const sheet of Object.values(sheets)) sheet.writes = [];
  let held = false;
  let claim;
  const calls = [];
  const state = { snapshot: fixtureSnapshot(), calls, claimCount: 0, ackCount: 0, flushCount: 0,
    beforeResponse: undefined, now: Date.parse('2030-01-01T00:00:00.000Z') / 1000 };
  const result = {
    config, signer, sheets, workerId: 'fixture-publisher', nowSeconds: () => state.now,
    lock: {
      tryLock() { if (held) return false; held = true; return true; },
      releaseLock() { assert.equal(held, true); held = false; },
    },
    claimStore: { load: () => claim && clone(claim), save: value => { claim = clone(value); },
      clear: value => { assert.deepEqual(value, claim); claim = undefined; } },
    assertProtected(kind, headers) { assert.deepEqual(headers, PROJECTION_HEADERS[kind]); if (!sheets[kind].protected) throw new Error('unprotected'); },
    flush() { state.flushCount++; },
    transport: {
      send(request) {
        const path = new URL(request.url).pathname;
        const timestamp = request.headers['x-shamrock-timestamp'];
        assert.equal(request.headers['x-shamrock-key-id'], config.keyId);
        assert.equal(request.headers['x-shamrock-signature'], signer.hmacSha256(`POST\n${path}\n${timestamp}\n${sha256(request.body)}`));
        const body = JSON.parse(request.body);
        assert.equal(body.environment, 'local'); assert.equal(body.generation, 1); assert.equal(body.workerId, 'fixture-publisher');
        calls.push(path);
        const override = state.beforeResponse?.(path, body);
        if (override) return override;
        if (path.endsWith('/claim')) { state.claimCount++; return { status: 200, body: JSON.stringify({ job: fixtureClaim() }) }; }
        assert.equal(body.jobId, fixtureClaim().jobId); assert.equal(body.claimToken, fixtureClaim().claimToken);
        if (path.endsWith('/project')) return { status: 200, body: JSON.stringify(state.snapshot) };
        assert.equal(path, '/v1/jobs/ack'); state.ackCount++;
        assert.equal(sheets.cursors.row('event_id', 'event-one').projection_revision, state.snapshot.revision);
        assert.equal(sheets.decisions.row('request_id', 'request-one').recorded_version, state.snapshot.rows[0].requests[0].version);
        return { status: 200, body: JSON.stringify({ acknowledged: true }) };
      },
    },
  };
  return { ...result, state, isLocked: () => held };
}

test('signed claim/project/ack writes named columns and preserves filters and separate frozen drafts', () => {
  const r = runtime();
  const input = new Sheet();
  input.values = [['request_id', 'base_version', 'draft_decision', 'draft_id'], ['Request', 'Version', 'Draft', 'ID'], ['request-one', 1, 'Denied', 'draft-frozen']];
  const beforeDraft = clone(input.values);
  const filters = r.sheets.attendance.filterViews;
  for (const sheet of Object.values(r.sheets)) sheet.reorderHeaders();
  assert.deepEqual(consumeProjectionJobs(r), { published: 1, idle: false });
  assert.deepEqual(r.state.calls, ['/v1/jobs/claim', '/v1/jobs/project', '/v1/jobs/ack']);
  const observed = r.sheets.attendance.row('person_id', 'person-a');
  assert.equal(observed.observed_code, 'P');
  assert.equal(r.sheets.attendance.row('person_id', 'person-b').observed_code, '');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').recorded_status, 'Submitted');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').approved_outcome, '');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').event_label, 'Example event');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').unit_label, 'Alpha');
  assert.deepEqual(input.values, beforeDraft);
  assert.equal(r.sheets.attendance.filterViews, filters);
  assert.equal(r.claimStore.load(), undefined);
  assert.equal(r.isLocked(), false);
  assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 1 && sheet.writes[0].row === 3));
});

test('duplicate snapshot is idempotent and later decision preserves observed P and stable rows', () => {
  const r = runtime();
  consumeProjectionJobs(r);
  const personOrder = clone(r.sheets.attendance.values);
  consumeProjectionJobs(r);
  assert.deepEqual(r.sheets.attendance.values, personOrder);
  assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 1));
  r.state.snapshot.revision = 3;
  Object.assign(r.state.snapshot.rows[0].requests[0], { version: 2, status: 'Approved' });
  consumeProjectionJobs(r);
  assert.equal(r.sheets.attendance.row('person_id', 'person-a').observed_code, 'P');
  const request = r.sheets.decisions.row('request_id', 'request-one');
  assert.equal(request.recorded_version, 2); assert.equal(request.recorded_status, 'Approved'); assert.equal(request.approved_outcome, 'E');
  assert.equal(r.sheets.decisions.getLastRow(), 3);
});

test('RAW publication preserves potentially formula-like names without executing formulas', () => {
  const r = runtime();
  r.state.snapshot.rows[0].displayName = '=IMPORTDATA("https://example.invalid")';
  r.state.snapshot.event.label = "'Quoted example";
  consumeProjectionJobs(r);
  assert.equal(r.sheets.attendance.row('person_id', 'person-a').display_name, r.state.snapshot.rows[0].displayName);
  assert.equal(r.sheets.attendance.row('person_id', 'person-a').event_label, "'Quoted example");
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').event_label, "'Quoted example");
});

function precedingOutput() {
  const r = runtime(); publishProjectionSnapshot(r.state.snapshot, r);
  r.sheets.decisions.values = r.sheets.decisions.values.map(row => row.slice(0, 11));
  for (const sheet of Object.values(r.sheets)) sheet.writes = [];
  return r;
}
test('paused recorded-output upgrade appends readable labels without rewriting old cells or cursors', () => {
  const r = precedingOutput();
  r.sheets.decisions.reorderHeaders(); r.sheets.attendance.reorderHeaders(); r.sheets.cursors.reorderHeaders();
  const old = clone(r.sheets.decisions.values), attendance = clone(r.sheets.attendance.values), cursors = clone(r.sheets.cursors.values);
  assert.deepEqual(upgradeRecordedDecisionLabels(r.sheets, { generation: 1 }), { upgraded: true, rows: 1 });
  assert.deepEqual(r.sheets.decisions.values.map(row => row.slice(0, 11)), old);
  assert.deepEqual(r.sheets.attendance.values, attendance); assert.deepEqual(r.sheets.cursors.values, cursors);
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').event_label, 'Example event');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').unit_label, 'Alpha');
  assert.deepEqual(r.sheets.decisions.writes.map(({ row, column, values }) => ({ row, column, width: values[0].length })), [{ row: 1, column: 12, width: 2 }]);
  assert.equal(r.sheets.attendance.writes.length + r.sheets.cursors.writes.length, 0);
  assert.deepEqual(upgradeRecordedDecisionLabels(r.sheets, { generation: 1 }), { upgraded: false, rows: 1 });
  assert.equal(r.sheets.decisions.writes.length, 1);
  initializeProjectionSheets(r.sheets);
});

test('label upgrade handles fresh and initialized empty output and preserves literal formula-like labels', () => {
  const empty = { attendance: new Sheet(), decisions: new Sheet(), cursors: new Sheet() };
  assert.deepEqual(upgradeRecordedDecisionLabels(empty, { generation: 1 }), { upgraded: false, rows: 0 });
  initializeProjectionSheets(empty);
  empty.decisions.values = empty.decisions.values.map(row => row.slice(0, 11));
  assert.deepEqual(upgradeRecordedDecisionLabels(empty, { generation: 1 }), { upgraded: true, rows: 0 });
  assert.deepEqual(empty.decisions.values[0].slice(11), ['event_label', 'unit_label']);
  const r = precedingOutput();
  for (let row = 3; row <= r.sheets.attendance.getLastRow(); row++) {
    r.sheets.attendance.set(row, 'event_label', '=Literal event'); r.sheets.attendance.set(row, 'unit_label', "'Literal unit");
  }
  upgradeRecordedDecisionLabels(r.sheets, { generation: 1 });
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').event_label, '=Literal event');
  assert.equal(r.sheets.decisions.row('request_id', 'request-one').unit_label, "'Literal unit");
});

test('label upgrade rejects missing/inconsistent/unpublished sources and every malformed target before writes', () => {
  const mutations = [
    r => { r.sheets.attendance.values = r.sheets.attendance.values.slice(0, 2); },
    r => { r.sheets.attendance.set(4, 'event_label', 'Conflicting event'); },
    r => { r.sheets.attendance.set(4, 'unit_label', 'Conflicting unit'); },
    r => { r.sheets.cursors.values = r.sheets.cursors.values.slice(0, 2); },
    r => { r.sheets.attendance.set(3, 'projection_revision', 3); },
    r => { r.sheets.decisions.set(3, 'projection_revision', 3); },
    r => { r.sheets.attendance.set(3, 'projection_revision', 1); },
    r => { r.sheets.decisions.set(3, 'projection_revision', 1); },
    r => { r.sheets.cursors.set(3, 'snapshot_hash', 'malformed watermark'); },
    r => { r.sheets.attendance.set(3, 'generation', 2); },
    r => { r.sheets.decisions.set(3, 'generation', 2); },
    r => { r.sheets.decisions.values[0].push('event_label'); },
    r => { r.sheets.decisions.values[0].push('event_label', 'unit_label'); r.sheets.decisions.values[1].push('Event', 'Unit'); },
    r => { r.sheets.decisions.formula = true; },
  ];
  for (const mutate of mutations) {
    const r = precedingOutput(); mutate(r); const before = clone(r.sheets.decisions.values);
    assert.throws(() => upgradeRecordedDecisionLabels(r.sheets, { generation: 1 }));
    assert.deepEqual(r.sheets.decisions.values, before);
    assert.equal(r.sheets.decisions.writes.length, 0);
  }
});

test('ambiguous label upgrade retries only complete read-back; old-cell damage and partial schemas fail closed', () => {
  const r = precedingOutput(); const before = clone(r.sheets.decisions.values);
  r.sheets.decisions.afterWrite = () => { throw new Error('ambiguous reply'); };
  assert.throws(() => upgradeRecordedDecisionLabels(r.sheets, { generation: 1 }), /ambiguous reply/);
  r.sheets.decisions.afterWrite = undefined;
  assert.deepEqual(upgradeRecordedDecisionLabels(r.sheets, { generation: 1 }), { upgraded: false, rows: 1 });
  assert.deepEqual(r.sheets.decisions.values.map(row => row.slice(0, 11)), before);
  const damaged = precedingOutput();
  damaged.sheets.decisions.afterWrite = () => damaged.sheets.decisions.set(3, 'display_name', 'Unexpected change');
  assert.throws(() => upgradeRecordedDecisionLabels(damaged.sheets, { generation: 1 }), { code: 'projection_readback' });
  const partial = precedingOutput();
  partial.sheets.decisions.afterWrite = () => partial.sheets.decisions.set(3, 'event_label', '');
  assert.throws(() => upgradeRecordedDecisionLabels(partial.sheets, { generation: 1 }));
  partial.sheets.decisions.afterWrite = undefined;
  assert.throws(() => upgradeRecordedDecisionLabels(partial.sheets, { generation: 1 }));
  assert.equal(partial.sheets.decisions.writes.length, 1);
});

test('partial ambiguous write is never acknowledged; same durable claim repairs on retry', () => {
  const r = runtime();
  r.sheets.attendance.afterWrite = () => { throw new Error('ambiguous write after application'); };
  assert.throws(() => consumeProjectionJobs(r), /ambiguous write/);
  assert.equal(r.state.ackCount, 0);
  assert.ok(r.claimStore.load());
  assert.equal(r.sheets.cursors.getLastRow(), 2);
  assert.equal(r.isLocked(), false);
  r.sheets.attendance.afterWrite = undefined;
  assert.deepEqual(consumeProjectionJobs(r), { published: 1, idle: false });
  assert.equal(r.state.claimCount, 1);
  assert.equal(r.sheets.attendance.getLastRow(), 4);
  assert.equal(r.sheets.attendance.writes.length, 1);
  assert.equal(r.state.ackCount, 1);
});

test('crash after output and cursor but before ack resumes without rewriting', () => {
  const r = runtime();
  r.state.beforeResponse = path => { if (path.endsWith('/ack')) throw new Error('transport ambiguity'); };
  assert.throws(() => consumeProjectionJobs(r), /transport ambiguity/);
  assert.ok(r.claimStore.load());
  assert.equal(r.sheets.cursors.getLastRow(), 3);
  r.state.beforeResponse = undefined;
  consumeProjectionJobs(r);
  assert.equal(r.state.claimCount, 1);
  assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 1));
});

test('read-back mismatch, protection loss and formulas each prevent ack', () => {
  for (const cause of ['changed-value', 'lost-protection', 'formula']) {
    const r = runtime();
    r.sheets.decisions.afterWrite = () => {
      if (cause === 'changed-value') r.sheets.decisions.set(3, 'display_name', 'Unexpected edit');
      if (cause === 'lost-protection') r.sheets.decisions.protected = false;
      if (cause === 'formula') r.sheets.decisions.formula = true;
    };
    assert.throws(() => consumeProjectionJobs(r));
    assert.equal(r.state.ackCount, 0, cause);
    assert.ok(r.claimStore.load(), cause);
    assert.equal(r.sheets.cursors.getLastRow(), 2, cause);
  }
});

test('older snapshot or request version cannot replace newer recorded output', () => {
  for (const cause of ['snapshot', 'request']) {
    const r = runtime();
    r.state.snapshot.revision = 3;
    Object.assign(r.state.snapshot.rows[0].requests[0], { version: 2, status: 'Approved' });
    consumeProjectionJobs(r);
    const before = clone(r.sheets.decisions.values);
    r.state.snapshot.revision = cause === 'snapshot' ? 2 : 4;
    Object.assign(r.state.snapshot.rows[0].requests[0], { version: 1, status: 'Submitted' });
    assert.throws(() => consumeProjectionJobs(r), { code: 'stale_projection' });
    assert.deepEqual(r.sheets.decisions.values, before);
    assert.equal(r.state.ackCount, 1);
  }
});

test('same revision conflicts, request rebinds, missing requests and observation erasure fail closed', () => {
  for (const cause of ['revision', 'request-version', 'rebound', 'missing', 'erasure']) {
    const r = runtime(); consumeProjectionJobs(r);
    r.state.snapshot.revision = cause === 'revision' ? 2 : 3;
    if (cause === 'revision') r.state.snapshot.rows[0].displayName = 'Changed name';
    if (cause === 'request-version') r.state.snapshot.rows[0].requests[0].status = 'Denied';
    if (cause === 'rebound') r.state.snapshot.rows[1].requests.push(r.state.snapshot.rows[0].requests.pop());
    if (cause === 'missing') r.state.snapshot.rows[0].requests = [];
    if (cause === 'erasure') r.state.snapshot.rows[0].observedCode = null;
    assert.throws(() => consumeProjectionJobs(r));
    assert.equal(r.state.ackCount, 1, cause);
    assert.equal(r.sheets.cursors.row('event_id', 'event-one').projection_revision, 2, cause);
  }
});

test('empty snapshots retain stable prior attendance row and mark it outside current scope', () => {
  const r = runtime(); r.state.snapshot.rows[0].requests = [];
  publishProjectionSnapshot(r.state.snapshot, r);
  r.state.snapshot.rows = []; r.state.snapshot.revision = 3;
  publishProjectionSnapshot(r.state.snapshot, r);
  assert.equal(r.sheets.attendance.row('person_id', 'person-a').in_current_scope, false);
  assert.equal(r.sheets.attendance.row('person_id', 'person-a').observed_code, 'P');
  assert.equal(r.sheets.attendance.getLastRow(), 4);
  assert.equal(r.sheets.cursors.row('event_id', 'event-one').projection_revision, 3);
});

test('strict DTO and schema validation reject malformed data before writes', () => {
  const mutations = [
    snapshot => { snapshot.unexpected = true; },
    snapshot => { snapshot.rows[0].observedCode = 'A'; },
    snapshot => { snapshot.rows[1].personId = snapshot.rows[0].personId; },
    snapshot => { snapshot.rows[1].requests = clone(snapshot.rows[0].requests); },
    snapshot => { snapshot.rows[0].requests[0].version = 0; },
    snapshot => { snapshot.rows[0].requests[0].status = 'Unknown'; },
    snapshot => { snapshot.rows[0].requests[0].requestedOutcome = 'A'; },
    snapshot => { snapshot.rows[0].requests[0].extra = true; },
  ];
  for (const mutate of mutations) {
    const r = runtime(); mutate(r.state.snapshot);
    assert.throws(() => consumeProjectionJobs(r));
    assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 0));
    assert.equal(r.state.ackCount, 0);
  }
  const r = runtime(); r.sheets.attendance.values[0][0] = 'unknown_header';
  assert.throws(() => consumeProjectionJobs(r), { code: 'projection_schema' });
  assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 0));
});

test('claim scope, generation, bounds and expired leases prevent publication', () => {
  for (const cause of ['scope', 'generation', 'size', 'expired']) {
    const r = runtime();
    if (cause === 'scope') r.state.snapshot.event.eventId = 'other-event';
    if (cause === 'generation') {
      publishProjectionSnapshot(r.state.snapshot, r);
      r.config = { ...config, generation: 2 };
      // Direct publisher tests binding isolation independently of HTTP fixture config.
      assert.throws(() => publishProjectionSnapshot(r.state.snapshot, r), { code: 'wrong_generation' }); continue;
    }
    if (cause === 'expired') r.state.now += 600;
    assert.throws(() => consumeProjectionJobs(r, cause === 'size' ? { maxRows: 1 } : {}));
    assert.equal(r.state.ackCount, 0);
    assert.ok(Object.values(r.sheets).every(sheet => sheet.writes.length === 0));
  }
});

test('bounded idle and busy runs release locks without publishing', () => {
  const r = runtime();
  r.state.beforeResponse = path => path.endsWith('/claim') ? { status: 200, body: '{"job":null}' } : undefined;
  assert.deepEqual(consumeProjectionJobs(r, { limit: 5 }), { published: 0, idle: true });
  assert.equal(r.isLocked(), false);
  assert.throws(() => consumeProjectionJobs(r, { limit: 6 }), { code: 'invalid_batch' });
  r.lock.tryLock();
  assert.throws(() => consumeProjectionJobs(r), { code: 'projection_busy' });
  r.lock.releaseLock();
});

test('malformed ack retains claim for reconciliation and does not report success', () => {
  const r = runtime();
  r.state.beforeResponse = path => path.endsWith('/ack') ? { status: 200, body: '{"acknowledged":false}' } : undefined;
  assert.throws(() => consumeProjectionJobs(r), { code: 'invalid_ack' });
  assert.ok(r.claimStore.load());
  assert.equal(r.isLocked(), false);
});

test('canonical snapshot order gives identical hashes without mutating caller data', () => {
  const input = fixtureSnapshot(); input.rows.reverse();
  const before = clone(input);
  const parsed = parseProjectionSnapshot(input);
  assert.deepEqual(input, before);
  assert.deepEqual(parsed, fixtureSnapshot());
});

test('dynamic input publication runs inside the claim lock after recorded verification and blocks ACK on failure', () => {
  const r = runtime(); let fail = true; let calls = 0;
  r.publishDecisionSlots = snapshot => {
    calls++; assert.equal(r.isLocked(), true); assert.equal(r.sheets.cursors.row('event_id', 'event-one').projection_revision, snapshot.revision);
    if (fail) throw Error('Synthetic slot capacity failure');
  };
  assert.throws(() => consumeProjectionJobs(r), /Synthetic slot capacity failure/);
  assert.equal(r.state.ackCount, 0); assert.ok(r.claimStore.load()); assert.equal(r.isLocked(), false);
  fail = false; consumeProjectionJobs(r);
  assert.equal(calls, 2); assert.equal(r.state.claimCount, 1); assert.equal(r.state.ackCount, 1); assert.equal(r.claimStore.load(), undefined);
});
