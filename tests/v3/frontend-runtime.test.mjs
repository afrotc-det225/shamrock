import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { consumeFrontendRefresh, buildSignedFrontendRequest, createNativeFrontendRuntime, buildCoherentFrontendModel, frontendRowLocks, readFrontendValidationRanges, assertNativeAttendanceLayoutRequest } from '../../.build/v3/apps/google-adapter/src/frontend-runtime.js';
import { frontendLiteralCell, planFrontendPublication } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import { dashboardReadFingerprint } from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';
import { buildAttendanceGrowthLayout } from '../../.build/v3/apps/google-adapter/src/frontend-layout.js';

const copy = value => structuredClone(value);
const signer = { sha256: value => createHash('sha256').update(value).digest('hex'), hmacSha256: value => createHmac('sha256', 'fictional-signing-material').update(value).digest('hex') };
const config = { baseUrl: 'https://staging.example.test', environment: 'staging', generation: 3, keyId: 'key-1' };
const kinds = ['directory', 'leadership', 'attendance'];
function fixture() {
  const revision = { operations: 2, administration: 2 }, baseRevision = { operations: 1, administration: 1 };
  const model = { generation: 3, revision, tables: [] };
  const state = { version: 1, environment: 'staging', generation: 3, baselines: {}, drafts: {} }, current = {};
  kinds.forEach((kind, index) => {
    const keyHeader = kind === 'leadership' ? 'contact_id' : 'person_id', field = ['phone', 'role', 'event:event-1'][index];
    const columns = [{ header: keyHeader, label: 'ID', editable: false }, { header: field, label: 'Input', editable: true }];
    const row = { key: `record-${index}`, values: { [keyHeader]: `record-${index}`, [field]: 'old' }, versions: { [field]: 1 }, ...(kind === 'attendance' ? { eventVersions: { [field]: 1 } } : {}) };
    state.baselines[kind] = { generation: 3, revision: copy(baseRevision), rows: [copy(row)] }; state.drafts[kind] = [];
    current[kind] = { sheetId: 100 + index, tableId: `table-${index}`, gridRowCount: 20, gridColumnCount: 2,
      headers: columns.map(c => c.header), labels: columns.map(c => c.label), rows: [[frontendLiteralCell(`record-${index}`), frontendLiteralCell('old')]],
      range: { sheetId: 100 + index, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }, hiddenColumns: [0], machineRowHidden: true };
    model.tables.push({ kind, keyHeader, columns, rows: [{ ...copy(row), values: { ...row.values, [field]: 'new' }, versions: { [field]: 2 } }] });
  });
  const claim = { effectId: 'effect-1', kind: 'frontend.refresh', claimToken: 'lease-1', leaseExpiresAt: new Date(2000 * 1000).toISOString() };
  const fx = { enabled: true, now: 1000, fenced: false, claim: undefined, state, current, model, calls: [], writes: 0, paused: 0, restores: 0, released: 0, ack: 0, mode: 'normal' };
  const runtime = {
    config, workerId: 'frontend-1', principalId: 'principal-1', signer, nowSeconds: () => fx.now,
    enabled: () => fx.enabled, lock: { tryLock: () => true, releaseLock: () => { fx.released++; } },
    assertIsolation: () => { fx.calls.push('isolation'); },
    claimStore: { load: () => copy(fx.claim), save: value => { fx.claim = copy(value); }, clear: value => { assert.deepEqual(value, fx.claim); fx.claim = undefined; } },
    state: { load: () => copy(fx.state), save: value => { fx.state = copy(value); fx.calls.push('save-state'); } },
    transport: { send(request) {
      const action = request.url.split('/').at(-1), input = JSON.parse(request.body); fx.calls.push(action);
      assert.equal(request.headers['x-shamrock-signature'], signer.hmacSha256(`POST\n/v1/admin/effects/${action}\n1000\n${signer.sha256(request.body)}`));
      if (action === 'claim') { assert.equal(input.kind, 'frontend.refresh'); return { status: 200, body: JSON.stringify({ effect: claim }) }; }
      if (action === 'project') return { status: 200, body: JSON.stringify({ effect: { effectId: claim.effectId, kind: claim.kind }, snapshot: { contractVersion: 1, environment: 'staging', generation: 3, revision } }) };
      assert.equal(action, 'ack'); fx.ack++;
      assert.equal(fx.fenced, false); assert.ok(fx.state.completedClaim); assert.equal(fx.state.pending, undefined);
      if (fx.mode === 'ack-lost') throw Error('ambiguous network response');
      return { status: 200, body: '{"acknowledged":true}' };
    } },
    buildModel: () => copy(fx.model),
    fenceEdits: () => { fx.fenced = true; fx.calls.push('fence'); },
    assertFenced: () => assert.equal(fx.fenced, true), readTable: kind => copy(fx.current[kind]), readSeeds: () => [],
    verifyValidation: () => { fx.calls.push('validation-readback'); return fx.mode !== 'bad-validation'; },
    writeAtomic(requests) {
      assert.equal(fx.fenced, true); assert.ok(fx.state.pending, 'save pending plan before external write'); assert.ok(requests.length);
      fx.writes++; fx.calls.push('write');
      if (fx.mode === 'write-before') throw Error('Google refused write');
      for (const kind of kinds) fx.current[kind] = copy(fx.state.pending.plans[kind].expectedAfter);
      if (fx.mode === 'write-after') throw Error('Google accepted but response was lost');
      if (fx.mode === 'bad-readback') fx.current.directory.rows[0][1] = frontendLiteralCell('unexpected');
    },
    restoreEditPolicy() { fx.restores++; if (fx.mode === 'restore-fails') throw Error('Google rejected protection restore'); fx.fenced = false; },
    assertEditPolicy: () => assert.equal(fx.fenced, false),
    pause: () => { fx.enabled = false; fx.paused++; },
  };
  return { fx, runtime, claim };
}

function fullFixture() {
  const result = fixture(), { fx, runtime } = result;
  fx.dashboard = { sheetId: 20, dataSheetId: 21, canvas: [[frontendLiteralCell('old'), ...Array.from({ length: 11 }, () => ({}))]],
    data: [Array.from({ length: 16 }, () => ({}))], canvasGrid: { rowCount: 1, columnCount: 12 }, dataGrid: { rowCount: 1, columnCount: 16 }, dataHidden: true, merges: [], charts: [] };
  fx.queueReads = {}; fx.queueModels = {}; fx.excusalWrites = 0;
  fx.state.supplemental = { dashboardRevision: { operations: 1, administration: 1 }, baselines: {}, drafts: {} };
  ['blue', 'gold'].forEach((queue, i) => {
    const row = { key: 'request-' + queue, values: { request_id: 'request-' + queue, decision: null }, versions: { decision: 1 } };
    fx.state.supplemental.baselines[queue] = { generation: 3, revision: { operations: 1, administration: 1 }, rows: [copy(row)] };
    fx.state.supplemental.drafts[queue] = [];
    fx.queueReads[queue] = { sheetId: 30 + i, tableId: 'table-' + queue, gridRowCount: 3, gridColumnCount: 2, headers: ['request_id', 'decision'], labels: ['ID', 'Decision'],
      rows: [[frontendLiteralCell(row.key), {}]], range: { sheetId: 30 + i, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }, hiddenColumns: [0], machineRowHidden: true };
    fx.queueModels[queue] = { kind: 'excusal', keyHeader: 'request_id', columns: [{ header: 'request_id', label: 'ID', editable: false }, { header: 'decision', label: 'Decision', editable: true }],
      rows: [{ ...copy(row), values: { ...row.values, decision: 'Denied' }, versions: { decision: 2 } }] };
  });
  const writeMain = runtime.writeAtomic;
  runtime.writeAtomic = requests => {
    assert.ok(requests.some(r => r.updateCells?.range?.sheetId === 20), 'Dashboard belongs to the same Main transaction');
    try { writeMain(requests); } finally { if (fx.mode !== 'write-before') fx.dashboard = copy(fx.state.pending.supplemental.dashboard.expectedAfter); }
  };
  runtime.supplemental = {
    plan(snapshot, state) {
      const expectedAfter = copy(fx.dashboard); expectedAfter.canvas[0][0] = frontendLiteralCell('new');
      return { dashboard: { revision: copy(snapshot.revision), requests: [{ updateCells: { range: { sheetId: 20, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, rows: [{ values: [frontendLiteralCell('new')] }], fields: 'userEnteredValue' } }],
        expectedRead: dashboardReadFingerprint(fx.dashboard), expectedAfter, reportingNeedsReview: false, birthdayCount: 0, noCountedAttendanceCadets: 0 },
        excusals: Object.fromEntries(['blue', 'gold'].map(queue => [queue, planFrontendPublication({ generation: 3, revision: snapshot.revision,
          table: fx.queueModels[queue], current: fx.queueReads[queue], baseline: state.baselines[queue], drafts: state.drafts[queue], seeds: [], editFenceVerified: true })])) };
    },
    readDashboard: () => copy(fx.dashboard), readExcusal: queue => copy(fx.queueReads[queue]), verifyValidation: () => fx.mode !== 'bad-excusal-validation',
    writeAtomic(requests) {
      assert.equal(fx.fenced, true); assert.ok(fx.state.pending.supplemental); assert.ok(requests.length); fx.excusalWrites++; fx.calls.push('write-excusals');
      if (fx.mode === 'excusal-before') throw Error('Excusals write failed');
      for (const queue of ['blue', 'gold']) fx.queueReads[queue] = copy(fx.state.pending.supplemental.excusals[queue].expectedAfter);
      if (fx.mode === 'excusal-after') throw Error('Excusals response was lost');
    },
  };
  return result;
}

test('signed administrative requests bind exact path, staging generation, principal and selected effect kind', () => {
  const request = buildSignedFrontendRequest('claim', { workerId: 'worker', principalId: 'reader' }, config, signer, 1000);
  assert.deepEqual(JSON.parse(request.body), { environment: 'staging', generation: 3, principalId: 'reader', workerId: 'worker', kind: 'frontend.refresh' });
  assert.equal(request.headers['x-shamrock-signature'], signer.hmacSha256(`POST\n/v1/admin/effects/claim\n1000\n${signer.sha256(request.body)}`));
  assert.throws(() => buildSignedFrontendRequest('claim', { workerId: 'worker', principalId: 'reader' }, { ...config, environment: 'production' }, signer, 1000));
  assert.throws(() => buildSignedFrontendRequest('claim', { workerId: 'worker', principalId: 'reader' }, { ...config, baseUrl: 'https://example.test/other' }, signer, 1000));
  assert.throws(() => buildSignedFrontendRequest('ack', { workerId: 'worker', principalId: 'reader' }, config, signer, 1000));
});

test('disabled runtime performs no IO; isolation and lock checks precede claiming', () => {
  const { fx, runtime } = fixture(); fx.enabled = false;
  assert.deepEqual(consumeFrontendRefresh(runtime), { status: 'disabled' }); assert.deepEqual(fx.calls, []);
  fx.enabled = true; runtime.assertIsolation = () => { throw Error('Wrong owner'); };
  assert.throws(() => consumeFrontendRefresh(runtime)); assert.equal(fx.claim, undefined); assert.equal(fx.writes, 0); assert.equal(fx.released, 1);
  runtime.lock.tryLock = () => false; assert.throws(() => consumeFrontendRefresh(runtime), e => e.code === 'frontend_busy'); assert.equal(fx.released, 1);
});

test('publish persists claim and frozen plan, fences human edits, verifies output, restores exact grants then acknowledges', () => {
  const { fx, runtime } = fixture(); const result = consumeFrontendRefresh(runtime);
  assert.equal(result.status, 'published'); assert.equal(fx.writes, 1); assert.equal(fx.ack, 1); assert.equal(fx.claim, undefined); assert.equal(fx.fenced, false);
  assert.ok(fx.calls.indexOf('save-state') < fx.calls.indexOf('write')); assert.ok(fx.calls.indexOf('write') < fx.calls.indexOf('ack'));
  assert.equal(fx.state.baselines.directory.rows[0].values.phone, 'new'); assert.equal(fx.state.pending, undefined);
});

test('an empty queue leaves spreadsheet protections untouched', () => {
  const { fx, runtime } = fixture(); runtime.transport.send = () => ({ status: 200, body: '{"effect":null}' });
  assert.deepEqual(consumeFrontendRefresh(runtime), { status: 'idle' }); assert.equal(fx.writes, 0); assert.equal(fx.restores, 0); assert.equal(fx.fenced, false);
});

test('wrong kind, wrong generation, invalid state and expired leases never publish', () => {
  for (const mode of ['kind', 'generation', 'state', 'expired']) {
    const { fx, runtime, claim } = fixture();
    if (mode === 'state') fx.state.generation = 4;
    else if (mode === 'expired') fx.claim = { ...claim, leaseExpiresAt: new Date(1040 * 1000).toISOString() };
    else { const original = runtime.transport.send; runtime.transport.send = request => {
      const result = original(request), body = JSON.parse(result.body);
      if (mode === 'kind' && request.url.endsWith('claim')) body.effect.kind = 'forms.refresh';
      if (mode === 'generation' && request.url.endsWith('project')) body.snapshot.generation = 4;
      return { status: 200, body: JSON.stringify(body) };
    }; }
    assert.throws(() => consumeFrontendRefresh(runtime)); assert.equal(fx.writes, 0); assert.equal(fx.ack, 0);
  }
});

test('failed or ambiguous writes retain the closed frontend, private pending plan and original claim', () => {
  for (const mode of ['write-before', 'write-after', 'bad-readback', 'bad-validation']) {
    const { fx, runtime } = fixture(); fx.mode = mode;
    assert.throws(() => consumeFrontendRefresh(runtime));
    assert.equal(fx.fenced, true); assert.equal(fx.paused, 1); assert.equal(fx.ack, 0); assert.ok(fx.claim); assert.ok(fx.state.pending);
    assert.equal(fx.state.baselines.directory.rows[0].values.phone, 'old');
  }
});

test('response loss after atomic write recovers by read-back without replaying the write', () => {
  const { fx, runtime } = fixture(); fx.mode = 'write-after'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.mode = 'normal'; fx.enabled = true;
  assert.equal(consumeFrontendRefresh(runtime).status, 'published'); assert.equal(fx.writes, 1); assert.equal(fx.ack, 1); assert.equal(fx.claim, undefined);
});

test('ambiguous-write recovery requires validation read-back before advancing baselines or opening edits', () => {
  const { fx, runtime } = fixture(); fx.mode = 'write-after'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.mode = 'bad-validation'; fx.enabled = true;
  assert.throws(() => consumeFrontendRefresh(runtime), e => e.code === 'frontend_validation');
  assert.equal(fx.writes, 1); assert.equal(fx.ack, 0); assert.equal(fx.fenced, true);
  assert.equal(fx.state.baselines.directory.rows[0].values.phone, 'old'); assert.ok(fx.state.pending);
});

test('failed write before commit retries the original frozen plan instead of a later snapshot', () => {
  const { fx, runtime } = fixture(); fx.mode = 'write-before'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.mode = 'normal'; fx.enabled = true; runtime.buildModel = () => { throw Error('Must use retained plan'); };
  assert.equal(consumeFrontendRefresh(runtime).status, 'published'); assert.equal(fx.writes, 2);
});

test('unexplained mixed publication state fails closed instead of overwriting local changes', () => {
  const { fx, runtime } = fixture(); fx.mode = 'write-after'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.current.directory.rows[0][1] = frontendLiteralCell('unexpected'); fx.enabled = true; fx.mode = 'normal';
  assert.throws(() => consumeFrontendRefresh(runtime)); assert.equal(fx.writes, 1); assert.equal(fx.ack, 0); assert.equal(fx.fenced, true);
});

test('completed checkpoint permits safe protection restoration retry without replaying content', () => {
  const { fx, runtime } = fixture(); fx.mode = 'restore-fails'; assert.throws(() => consumeFrontendRefresh(runtime));
  assert.ok(fx.state.completedClaim); assert.equal(fx.state.pending, undefined); assert.equal(fx.fenced, true);
  fx.enabled = true; fx.mode = 'normal'; assert.equal(consumeFrontendRefresh(runtime).status, 'published'); assert.equal(fx.writes, 1);
});

test('lost acknowledgement retains claim; retry never erases a new user draft after publication', () => {
  const { fx, runtime } = fixture(); fx.mode = 'ack-lost'; assert.throws(() => consumeFrontendRefresh(runtime));
  assert.ok(fx.claim); assert.ok(fx.state.completedClaim); assert.equal(fx.fenced, false);
  fx.current.directory.rows[0][1] = frontendLiteralCell('new user draft'); fx.mode = 'normal';
  assert.equal(consumeFrontendRefresh(runtime).status, 'published'); assert.equal(fx.writes, 1);
  assert.equal(fx.current.directory.rows[0][1].userEnteredValue.stringValue, 'new user draft');
});

test('publication preserves unsent editable cells and saves frozen versions instead of silently acknowledging them', () => {
  const { fx, runtime } = fixture(); fx.current.directory.rows[0][1] = frontendLiteralCell('unsent phone');
  const result = consumeFrontendRefresh(runtime);
  assert.equal(result.status, 'published-with-drafts'); assert.equal(result.retainedDrafts, 1);
  assert.equal(fx.current.directory.rows[0][1].userEnteredValue.stringValue, 'unsent phone');
  assert.equal(fx.state.drafts.directory[0].baseVersion, 1); assert.equal(fx.state.baselines.directory.rows[0].values.phone, 'old');
});

test('native host is disabled without touching Google or requiring optional frontend configuration', () => {
  let calls = 0;
  const native = createNativeFrontendRuntime({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
    UrlFetchApp: { fetch() { calls++; throw Error('Unexpected IO'); } } }, () => { throw Error('Unexpected model'); });
  assert.deepEqual(native.refresh(), { status: 'disabled' }); assert.equal(calls, 0);
});

test('native pause never reports success when the property provider does not retain the override', () => {
  const native = createNativeFrontendRuntime({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) } });
  assert.throws(() => native.pause(), e => e.code === 'frontend_state');
});

test('native frontend has its own explicit gate and can run while legacy Form intake is paused', () => {
  const owner = 'owner@example.test';
  const host = { version: 1, environment: 'staging', generation: 3, resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING', workerOrigin: config.baseUrl,
    keyId: 'key-1', expectedAutomationEmail: owner, journal: { spreadsheetId: 'private-journal', sheetId: 10 },
    attendance: { formId: 'attendance-form', resourceKey: 'attendance-form', itemRoles: { event: '1', scope: '2', present: ['3'], completeness: '4' } } };
  const frontend = { version: 1, environment: 'staging', generation: 3, enabled: false, resourceReview: 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING',
    workerId: 'frontend-1', principalId: 'reader-1', stateFileId: 'private-state', main: { spreadsheetId: 'frontend-main', expectedTitle: 'SHAMROCK — Staging', sheets: Object.fromEntries(kinds.map((kind, i) => [kind, { sheetId: 100 + i, tableId: `table-${i}` }])) },
    allowedFileEditors: [], access: { ownerEmail: owner, automationEmail: owner, supportEditors: [], directoryEditors: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [] }, seeds: [] };
  const props = { SHAMROCK_V3_HOST_CONFIG: JSON.stringify(host), SHAMROCK_V3_ENABLED: 'false', SHAMROCK_V3_BRIDGE_SECRET: 'a'.repeat(40), SHAMROCK_V3_FRONTEND_CONFIG: JSON.stringify(frontend) };
  let calls = 0;
  const services = { PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] ?? null, setProperty: (key, value) => { props[key] = value; }, deleteProperty: key => { delete props[key]; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => owner }) }, ScriptApp: { getOAuthToken: () => 'fixture-only' },
    Utilities: {}, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch() { calls++; throw Error('Reached Google under independent publication gate'); } } };
  const native = createNativeFrontendRuntime(services);
  assert.deepEqual(native.refresh(), { status: 'disabled' }); assert.equal(calls, 0);
  props.SHAMROCK_V3_FRONTEND_CONFIG = JSON.stringify({ ...frontend, enabled: true });
  assert.throws(() => native.refresh(), e => e.code === 'frontend_google_transport'); assert.equal(calls, 1);
  assert.equal(props.SHAMROCK_V3_ENABLED, 'false');
  props.SHAMROCK_V3_FRONTEND_CONFIG = JSON.stringify({ ...frontend, enabled: true, supplemental: { enabled: true } });
  assert.throws(() => native.refresh(), e => e.code === 'frontend_configuration'); assert.equal(calls, 1, 'Incomplete full-mode bindings fail before Google writes or reads');
});

test('coherent model uses authoritative sparse pair versions and never invents missing roster eligibility', () => {
  const person = { personId: 'p-1', version: 1, active: true, lastName: 'Example', firstName: 'Cadet', asYear: 'AS100', flightId: 'alpha', flightPathStatus: 'Active 3/4', dateOfBirth: null, photoLink: '' };
  const event = { eventId: 'e-1', termId: 'term-1', version: 1, eventType: 'llab', trainingWeek: 1, displayOrder: 1, label: 'LLAB', columnLabel: 'LLAB', eligiblePersonIds: ['p-1'] };
  const snapshot = { contractVersion: 1, environment: 'staging', generation: 3, revision: { operations: 7, administration: 2 }, people: [person], leadership: [], flights: [{ flightId: 'alpha', label: 'Alpha', squadronId: 'blue' }],
    squadrons: [{ squadronId: 'blue', label: 'Blue' }], terms: [{ termId: 'term-1', label: 'Current term', sortOrder: 1, isCurrent: true }], events: [event],
    observations: [], corrections: [], requests: [], attendanceVersions: [], diagnostics: [] };
  let model = buildCoherentFrontendModel(snapshot, '2026-11-06');
  assert.equal(model.tables.find(t => t.kind === 'attendance').rows[0].versions['event:e-1'], 0);
  snapshot.attendanceVersions = [{ personId: 'p-1', eventId: 'e-1', version: 7 }];
  model = buildCoherentFrontendModel(snapshot, '2026-11-06');
  assert.equal(model.tables.find(t => t.kind === 'attendance').rows[0].versions['event:e-1'], 7);
  delete snapshot.attendanceVersions;
  assert.throws(() => buildCoherentFrontendModel(snapshot, '2026-11-06'), e => e.code === 'frontend_snapshot_incomplete');
});

test('native row locks follow protected keys after sorting and close empty slots without guessing names', () => {
  const { fx } = fixture(), table = copy(fx.current.leadership), baseline = copy(fx.state.baselines.leadership);
  baseline.rows[0].readonlyHeaders = ['role'];
  baseline.rows.push({ key: 'manual-contact', values: { contact_id: 'manual-contact', role: 'manual' }, versions: { role: 1 }, readonlyHeaders: [] });
  table.rows = [[frontendLiteralCell('manual-contact'), frontendLiteralCell('manual')], table.rows[0], [{}, {}]]; table.range.endRowIndex = 5;
  assert.deepEqual(frontendRowLocks('leadership', table, baseline), [{ rowIndex: 3, headers: ['role'] }, { rowIndex: 4, headers: ['contact_id', 'role'] }]);
  table.rows[0][0] = frontendLiteralCell('unknown-contact');
  assert.throws(() => frontendRowLocks('leadership', table, baseline), e => e.code === 'frontend_state');
});

test('native validation reads only copied intervals in bounded chunks and retains exact rule fields', () => {
  const rule = { strict: true, showCustomUi: false, condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "'Data Legend'!$A$3:$A$12" }] } };
  const expectations = Array.from({ length: 10 }, (_, c) => ({ sheetId: 100, startRowIndex: 2, endRowIndex: 502, startColumnIndex: c, endColumnIndex: c + 1, expectedRule: rule }));
  const calls = [];
  const observations = readFrontendValidationRanges(expectations, {
    sheetTitle: () => 'Attendance',
    read(ranges) {
      calls.push(ranges);
      return { sheets: [{ properties: { sheetId: 100 }, data: ranges.map(range => {
        const match = range.match(/!([A-J])3:[A-J]502$/); assert.ok(match);
        return { startRow: 2, startColumn: match[1].charCodeAt(0) - 65, rowData: Array.from({ length: 500 }, () => ({ values: [{ dataValidation: copy(rule) }] })) };
      }) }] };
    },
  });
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(c => c.length), [4, 4, 2]);
  assert.equal(observations.length, 10); assert.deepEqual(observations[9].rows[499][0], rule);
  assert.deepEqual(readFrontendValidationRanges([], { sheetTitle() { throw Error('Unexpected lookup'); }, read() { throw Error('Unexpected IO'); } }), []);
  const missing = readFrontendValidationRanges([expectations[0]], { sheetTitle: () => 'Attendance', read: () => ({ sheets: [{ properties: { sheetId: 100 }, data: [{ startRow: 2, startColumn: 0 }] }] }) });
  assert.equal(missing[0].rows[499][0], null);
  assert.throws(() => readFrontendValidationRanges([expectations[0]], { sheetTitle: () => 'Attendance', read: () => ({ sheets: [{ properties: { sheetId: 100 }, data: [{ startRow: 3, startColumn: 0 }] }] }) }), e => e.code === 'frontend_validation');
});

test('full refresh freezes one snapshot, writes Main with Dashboard, then both squadron queues before reopening or ACK', () => {
  const { fx, runtime } = fullFixture();
  assert.equal(consumeFrontendRefresh(runtime).status, 'published');
  assert.equal(fx.writes, 1); assert.equal(fx.excusalWrites, 1); assert.equal(fx.ack, 1);
  assert.ok(fx.calls.indexOf('write') < fx.calls.indexOf('write-excusals')); assert.ok(fx.calls.indexOf('write-excusals') < fx.calls.indexOf('ack'));
  assert.deepEqual(fx.state.supplemental.dashboardRevision, { operations: 2, administration: 2 });
  assert.equal(fx.state.supplemental.baselines.blue.rows[0].values.decision, 'Denied');
});

test('partial two-book publication retains both fences and retries only the unfinished workbook from frozen plans', () => {
  const { fx, runtime } = fullFixture(); fx.mode = 'excusal-before';
  assert.throws(() => consumeFrontendRefresh(runtime)); assert.equal(fx.writes, 1); assert.equal(fx.excusalWrites, 1);
  assert.equal(fx.fenced, true); assert.equal(fx.ack, 0); assert.equal(fx.state.baselines.directory.rows[0].values.phone, 'old');
  fx.enabled = true; fx.mode = 'normal'; runtime.supplemental.plan = () => { throw Error('Do not rebuild a different snapshot'); };
  assert.equal(consumeFrontendRefresh(runtime).status, 'published'); assert.equal(fx.writes, 1); assert.equal(fx.excusalWrites, 2);
});

test('ambiguous Excusals commit is read back without replay, and a failed native rule check keeps both fences closed', () => {
  const { fx, runtime } = fullFixture(); fx.mode = 'excusal-after'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.enabled = true; fx.mode = 'bad-excusal-validation';
  assert.throws(() => consumeFrontendRefresh(runtime), e => e.code === 'frontend_readback');
  assert.equal(fx.writes, 1); assert.equal(fx.excusalWrites, 1); assert.equal(fx.fenced, true); assert.equal(fx.ack, 0);
  fx.enabled = true; fx.mode = 'normal'; assert.equal(consumeFrontendRefresh(runtime).status, 'published');
  assert.equal(fx.excusalWrites, 1); assert.equal(fx.ack, 1);
});

test('mixed Main table and Dashboard state is rejected instead of overwriting either side', () => {
  const { fx, runtime } = fullFixture(); fx.mode = 'excusal-before'; assert.throws(() => consumeFrontendRefresh(runtime));
  fx.dashboard.canvas[0][0] = frontendLiteralCell('unexpected'); fx.enabled = true; fx.mode = 'normal';
  assert.throws(() => consumeFrontendRefresh(runtime)); assert.equal(fx.writes, 1); assert.equal(fx.excusalWrites, 1); assert.equal(fx.ack, 0);
});

test('full configuration cannot claim without its matching private baseline and preserved squadron drafts remain frozen', () => {
  const missing = fullFixture(); delete missing.fx.state.supplemental;
  assert.throws(() => consumeFrontendRefresh(missing.runtime), e => e.code === 'frontend_state'); assert.equal(missing.fx.claim, undefined);
  const { fx, runtime } = fullFixture(); fx.queueReads.blue.rows[0][1] = frontendLiteralCell('Approved');
  assert.equal(consumeFrontendRefresh(runtime).status, 'published-with-drafts');
  assert.equal(fx.state.supplemental.drafts.blue[0].value, 'Approved'); assert.equal(fx.state.supplemental.drafts.blue[0].baseVersion, 1);
});

test('Main, Dashboard and squadron queue plans cannot mix snapshot revisions', () => {
  const { fx, runtime } = fullFixture(), original = runtime.supplemental.plan;
  runtime.supplemental.plan = (snapshot, state) => { const plans = original(snapshot, state); plans.dashboard.revision.operations++; return plans; };
  assert.throws(() => consumeFrontendRefresh(runtime), e => e.code === 'frontend_contract');
  assert.equal(fx.writes, 0); assert.equal(fx.excusalWrites, 0); assert.equal(fx.ack, 0);
});

test('native content allowlist accepts compact Attendance growth and rejects other sheets, values and arbitrary styling', () => {
  const requests = buildAttendanceGrowthLayout({ sheetId: 100, headers: ['last_name', 'overall_attendance_pct', 'event:new'], labels: ['Name', 'Overall', 'New event'], eventHeaders: ['event:new'], dataEndRow: 20 }, ['last_name', 'overall_attendance_pct'], 18);
  for (const request of requests) assert.doesNotThrow(() => assertNativeAttendanceLayoutRequest(request, 100));
  const format = copy(requests.find(r => r.repeatCell));
  assert.throws(() => assertNativeAttendanceLayoutRequest(format, 101), e => e.code === 'frontend_request');
  format.repeatCell.cell.userEnteredValue = { stringValue: 'forbidden' };
  assert.throws(() => assertNativeAttendanceLayoutRequest(format, 100));
  delete format.repeatCell.cell.userEnteredValue;
  format.repeatCell.fields += ',userEnteredFormat.backgroundColor'; format.repeatCell.cell.userEnteredFormat.backgroundColor = { red: 1 };
  assert.throws(() => assertNativeAttendanceLayoutRequest(format, 100));
  const size = copy(requests.find(r => r.updateDimensionProperties)); size.updateDimensionProperties.properties.pixelSize = 500;
  assert.throws(() => assertNativeAttendanceLayoutRequest(size, 100));
});
