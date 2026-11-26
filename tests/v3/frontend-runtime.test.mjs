import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { consumeFrontendRefresh, consumeFrontendResume, buildSignedFrontendRequest, createNativeFrontendRuntime, buildCoherentFrontendModel, frontendRowLocks, readFrontendValidationRanges, readFrontendDashboardValues, assertNativeAttendanceLayoutRequest, assertNativeFrontendVisibilityRequest } from '../../.build/v3/apps/google-adapter/src/frontend-runtime.js';
import { frontendLiteralCell, planFrontendPublication } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import { dashboardReadFingerprint } from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';
import { buildAttendanceGrowthLayout } from '../../.build/v3/apps/google-adapter/src/frontend-layout.js';
import {planCatalogLegend} from '../../.build/v3/apps/google-adapter/src/frontend-catalog-legend.js';

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

test('native dispatch accepts the fenced event hide and only reopens its proven original visible slot', () => {
  const {fx, runtime, claim} = fixture(), table = fx.model.tables.find(t => t.kind === 'attendance');
  const header = 'event:event-1', binding = {sheetId: fx.current.attendance.sheetId, tableId: fx.current.attendance.tableId};
  const active = copy(table), hidden = [], write = runtime.writeAtomic;
  fx.state.baselines.attendance.slots = {headers: [...fx.current.attendance.headers], keys: table.rows.map(r => r.key)};
  table.columns = table.columns.filter(c => c.header !== header);
  for (const row of table.rows) { delete row.values[header]; delete row.versions[header]; delete row.eventVersions[header]; }
  table.inactiveEventVersions = {[header]: 2};
  runtime.writeAtomic = requests => {
    assert.equal(fx.fenced, true);
    const context = {binding, before: fx.state.baselines.attendance, plan: fx.state.pending.plans.attendance, read: () => fx.current.attendance};
    const sheetIds = new Set(kinds.map(k => fx.current[k].sheetId));
    for (const {updateDimensionProperties: body} of requests) if (body?.fields === 'hiddenByUser') {
      assertNativeFrontendVisibilityRequest(body, sheetIds, context);
      hidden.push(body.properties.hiddenByUser);
      if (!body.properties.hiddenByUser) {
        for (const mismatch of [{dimension:'ROWS'}, {sheetId:fx.current.directory.sheetId}, {startIndex:0,endIndex:1}, {endIndex:3}]) {
          assert.throws(() => assertNativeFrontendVisibilityRequest({...body, range:{...body.range,...mismatch}}, sheetIds, context));
        }
        for (const changed of [
          {before:{...context.before,retiredEventColumns:[{header,wasHidden:true}]}},
          {plan:{...context.plan,requests:[]}}, {read:() => ({...fx.current.attendance,headers:['person_id','event:other']})},
          {read:() => ({...fx.current.attendance,tableId:'another-table'})},
        ]) assert.throws(() => assertNativeFrontendVisibilityRequest(body, sheetIds, {...context,...changed}));
        assert.throws(() => assertNativeFrontendVisibilityRequest(body, sheetIds));
      }
    }
    write(requests);
  };
  assert.equal(consumeFrontendRefresh(runtime).status, 'published');
  assert.ok(fx.current.attendance.hiddenColumns.includes(1));
  claim.effectId = 'effect-reactivate'; claim.claimToken = 'lease-reactivate';
  fx.model.revision.administration++;
  active.rows[0].eventVersions[header] = 3;
  fx.model.tables[2] = active;
  assert.equal(consumeFrontendRefresh(runtime).status, 'published');
  assert.deepEqual(hidden, [true,false]); assert.deepEqual(fx.current.attendance.hiddenColumns, [0]);
  assert.equal(fx.ack, 2);
});

test('full-roster photos resume ten-chip batches after lost responses and reject unrelated changes', () => {
  for (const interrupted of [false, true, 'tamper']) {
    const {fx,runtime}=fixture(), oldRows=Array.from({length:26},(_,i)=>({key:`photo-${i}`,values:{person_id:`photo-${i}`,photo:{fileUri:`https://drive.google.com/file/d/old-${i}/view`}},versions:{}}));
    const columns=[{header:'person_id',label:'ID',editable:false},{header:'photo',label:'Photo',editable:false,fileChip:true}];
    fx.state.baselines.directory.rows=copy(oldRows);
    Object.assign(fx.current.directory,{headers:columns.map(c=>c.header),labels:columns.map(c=>c.label),gridRowCount:28,rows:oldRows.map(r=>columns.map(c=>frontendLiteralCell(r.values[c.header]))),range:{sheetId:100,startRowIndex:1,endRowIndex:28,startColumnIndex:0,endColumnIndex:2}});
    fx.model.tables[0]={kind:'directory',keyHeader:'person_id',columns,rows:oldRows.map((r,i)=>({...copy(r),values:{...r.values,photo:{fileUri:`https://drive.google.com/file/d/new-${i}/view`}}}))};
    let lost=false;const chipCounts=[];runtime.writeAtomic=requests=>{
      assert.equal(fx.fenced,true);assert.ok(fx.state.pending);
      const chipCount=requests.reduce((n,r)=>n+(r.updateCells?.rows??[]).reduce((m,row)=>m+row.values.reduce((p,c)=>p+(c.chipRuns?.length??0),0),0),0);assert.ok(chipCount<=10);chipCounts.push(chipCount);
      for(const request of requests){const b=request.updateCells;if(!b)continue;const target=Object.values(fx.current).find(t=>t.sheetId===b.range.sheetId);assert.ok(target);b.rows.forEach((r,i)=>r.values.forEach((cell,j)=>{const row=b.range.startRowIndex+i;if(row<2)return;target.rows[row-2][b.range.startColumnIndex+j]=copy(cell);}));}
      if(interrupted&&chipCount&& !lost){lost=true;throw Error('accepted chip batch; response lost');}
    };
    if(interrupted){assert.throws(()=>consumeFrontendRefresh(runtime),/response lost/);assert.equal(fx.fenced,true);assert.equal(fx.ack,0);assert.equal(fx.state.pending.photos.length,26);fx.enabled=true;}
    if(interrupted==='tamper'){fx.current.leadership.rows[0][1]=frontendLiteralCell('unrelated owner edit');assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.fenced,true);assert.equal(fx.ack,0);assert.deepEqual(chipCounts.filter(n=>n>0),[10]);continue;}
    assert.equal(consumeFrontendRefresh(runtime).status,'published');assert.equal(fx.ack,1);assert.equal(fx.fenced,false);
    assert.deepEqual(chipCounts.filter(n=>n>0),[10,10,6]);assert.equal(fx.state.pending,undefined);
  }
});

test('catalog publication shares the frozen Main transaction, preserves pending inputs and verifies exact retry state',()=>{
 for(const mode of ['write-after','bad-catalog-readback']){
  const {fx,runtime}=fixture();let plans=0;
  const seed=(field,columnIndex,letter,chip)=>({key:`directory:${field}`,sheetId:7,rowIndex:2,columnIndex,protected:true,hidden:true,nativeStyleVersion:'reviewed',expectedRule:{strict:true,...(chip?{showCustomUi:true}:{}),condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='Data Legend'!$${letter}$3:$${letter}`}]}}});
  const seeds=[seed('flight',18,'B',true),seed('squadron',19,'C',false)].map(s=>({...s,observedRule:copy(s.expectedRule)}));runtime.readSeeds=()=>copy(seeds);
  const columns=[{header:'flight',label:'Flight',editable:true,seedKey:'directory:flight'},{header:'squadron',label:'Squadron',editable:false,seedKey:'directory:squadron'}];fx.model.tables[0].columns.push(...columns);
  for(const row of [fx.state.baselines.directory.rows[0],fx.model.tables[0].rows[0]]){row.values.flight='Alpha';row.values.squadron='Blue';row.versions.flight=1;}
  fx.current.directory.headers.push('flight','squadron');fx.current.directory.labels.push('Flight','Squadron');fx.current.directory.gridColumnCount=4;fx.current.directory.range.endColumnIndex=4;fx.current.directory.rows[0].push(frontendLiteralCell('Alpha'),frontendLiteralCell('Blue'));fx.current.directory.rows[0][1]=frontendLiteralCell('pending human input');
  let observed={columns:['flight','squadron'].map((field,i)=>({field,title:'Data Legend',range:{sheetId:7,startRowIndex:2,endRowIndex:70,startColumnIndex:i+1,endColumnIndex:i+2},values:i?['Blue','Gold']:['Alpha']})),tables:[]};
  let choices={flights:[{label:'Alpine'},{label:'Bravo'}],squadrons:[{label:'Blue'},{label:'Gold'}]};
  runtime.catalog={plan(){plans++;return planCatalogLegend(choices,observed);},read:()=>copy(observed)};
  const write=runtime.writeAtomic;runtime.writeAtomic=requests=>{assert.ok(requests.some(r=>r.updateCells?.range?.sheetId===7),'catalog is in the same atomic Main write');try{write(requests);}finally{observed=copy(fx.state.pending.catalog.expectedAfter);if(mode==='bad-catalog-readback')observed.columns[0].values.push('unexpected stale label');}};
  fx.mode=mode;assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.fenced,true);assert.equal(fx.ack,0);assert.equal(fx.restores,0);assert.equal(plans,1);assert.equal(fx.state.pending.plans.directory.retainedDrafts[0].value,'pending human input');
  fx.enabled=true;fx.mode='normal';choices.flights=[{label:'Future catalog change'}];
  if(mode==='bad-catalog-readback'){assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.writes,1);assert.equal(fx.ack,0);continue;}
  assert.equal(consumeFrontendRefresh(runtime).status,'published-with-drafts');assert.equal(fx.writes,1);assert.equal(plans,1);assert.equal(fx.ack,1);assert.deepEqual(observed.columns[0].values,['Alpine','Bravo']);assert.equal(fx.state.drafts.directory[0].value,'pending human input');
 }
});

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

test('named closed publication pins the claim and revision, leaves protections closed through a lost acknowledgement and rejects drafts', () => {
  for (const mode of ['ack-retry','draft','diverged','wrong-effect','wrong-revision']) {
    const {fx,runtime,claim} = fullFixture();
    runtime.closedWindow = {version:1,frontendEffectId:claim.effectId,formsEffectId:'forms-only-effect',revision:copy(fx.model.revision),
      expiresAt:new Date((fx.now+900)*1000).toISOString()};
    fx.fenced = true;
    runtime.restoreEditPolicy = runtime.assertEditPolicy = runtime.fenceEdits = () => assert.fail('closed maintenance must never change the field policy');
    const normalSend = runtime.transport.send;
    let acknowledgements = 0;
    runtime.transport.send = request => {
      const action=request.url.split('/').at(-1);
      if (action==='claim') {
        const body=JSON.parse(request.body);
        assert.equal(body.expectedEffectId,claim.effectId);
        assert.deepEqual(body.expectedRevision,runtime.closedWindow.revision);
        if(mode==='wrong-effect') return {status:200,body:JSON.stringify({effect:{...claim,effectId:'unrelated-effect'}})};
      }
      if(action==='ack'){
        assert.equal(fx.fenced,true);assert.ok(fx.state.completedClaim);acknowledgements++;
        if(acknowledgements===1)throw Error('ack response interrupted');
        return {status:200,body:'{"acknowledged":true}'};
      }
      return normalSend(request);
    };
    if(mode==='draft')fx.state.drafts.attendance=[{key:'retained'}];
    if(mode==='diverged')fx.current.directory.rows[0][1]=frontendLiteralCell('unsent');
    if(mode==='wrong-revision')runtime.closedWindow.revision.administration++;
    if(mode!=='ack-retry'){
      assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.writes,0);assert.equal(fx.excusalWrites,0);assert.equal(acknowledgements,0);continue;
    }
    assert.throws(()=>consumeFrontendRefresh(runtime),/ack response interrupted/);
    const writes=fx.writes,queueWrites=fx.excusalWrites;
    assert.equal(consumeFrontendRefresh(runtime).status,'published');
    assert.equal(fx.writes,writes);assert.equal(fx.excusalWrites,queueWrites);assert.equal(acknowledgements,2);assert(fx.fenced);
  }
});

test('native host is disabled without touching Google or requiring optional frontend configuration', () => {
  let calls = 0;
  const native = createNativeFrontendRuntime({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
    UrlFetchApp: { fetch() { calls++; throw Error('Unexpected IO'); } } }, () => { throw Error('Unexpected model'); });
  assert.deepEqual(native.refresh(), { status: 'disabled' }); assert.equal(calls, 0);
});

test('retained native row maintenance blocks ordinary publication without provider work or clearing pauses', () => {
  const native = createNativeFrontendRuntime({ PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'SHAMROCK_V3_INPUT_REORDER' ? 'retained' : null,
    setProperty() { throw Error('must not change gates'); }, deleteProperty() { throw Error('must not clear gates'); } }) } });
  assert.deepEqual(native.refresh(), { status: 'maintenance-paused' });
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
  props.SHAMROCK_V3_FRONTEND_CONFIG = JSON.stringify({ ...frontend, enabled: true, supplemental: { enabled: true, dashboard: { reviewedRetainedHistory: { version: 1, terms: [] } } } });
  assert.throws(() => native.refresh(), /INVALID_RETAINED_HISTORY_SUMMARY/);
  assert.equal(calls, 1, 'Malformed retained selections fail at configuration load before provider access');
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

test('native Attendance growth accepts exact production geometry and keeps rejected sizes and styles bounded', () => {
  const headers = ['last_name', 'first_name', 'as_year', 'flight', 'squadron', 'overall_attendance_pct', 'event:new'];
  const requests = buildAttendanceGrowthLayout({ sheetId: 100, headers, labels: headers, eventHeaders: ['event:new'], dataEndRow: 20 }, [], 2);
  for (const request of requests) assert.doesNotThrow(() => assertNativeAttendanceLayoutRequest(request, 100));
  const formats = requests.filter(r => r.repeatCell).map(r => r.repeatCell.cell.userEnteredFormat);
  assert.deepEqual([...new Set(formats.flatMap(f => f.textFormat?.fontSize ?? []))].sort((a, b) => a - b), [5, 10]);
  assert(formats.some(f => f.textFormat?.bold === false && f.horizontalAlignment === 'LEFT'));
  assert(formats.some(f => f.textFormat?.bold === true && f.horizontalAlignment === 'CENTER'));
  assert.deepEqual([...new Set(requests.filter(r => r.updateDimensionProperties?.range.dimension === 'COLUMNS').map(r => r.updateDimensionProperties.properties.pixelSize))].sort((a, b) => a - b), [75, 100, 115]);
  const row = copy(requests.find(r => r.updateDimensionProperties?.range.dimension === 'ROWS'));
  assert.equal(row.updateDimensionProperties.properties.pixelSize, 30);
  const header = copy(row); header.updateDimensionProperties.range.startIndex = 1; header.updateDimensionProperties.range.endIndex = 2;
  assert.doesNotThrow(() => assertNativeAttendanceLayoutRequest(header, 100));
  for (const pixels of [20, 22, 24, 500]) {
    const invalid = copy(row); invalid.updateDimensionProperties.properties.pixelSize = pixels;
    assert.throws(() => assertNativeAttendanceLayoutRequest(invalid, 100), e => e.code === 'frontend_request');
  }
  const format = requests.find(r => r.repeatCell?.cell.userEnteredFormat.textFormat?.fontSize === 5);
  for (const [field, value] of [['fontSize', 6], ['fontSize', 11], ['bold', 'false']]) {
    const invalid = copy(format); invalid.repeatCell.cell.userEnteredFormat.textFormat[field] = value;
    assert.throws(() => assertNativeAttendanceLayoutRequest(invalid, 100), e => e.code === 'frontend_request');
  }
  const invalidAlignment = copy(format); invalidAlignment.repeatCell.cell.userEnteredFormat.horizontalAlignment = 'RIGHT';
  assert.throws(() => assertNativeAttendanceLayoutRequest(invalidAlignment, 100), e => e.code === 'frontend_request');
  for (const pixels of [74, 76, 114, 116]) {
    const invalid = copy(requests.find(r => r.updateDimensionProperties?.range.dimension === 'COLUMNS'));
    invalid.updateDimensionProperties.properties.pixelSize = pixels;
    assert.throws(() => assertNativeAttendanceLayoutRequest(invalid, 100), e => e.code === 'frontend_request');
  }
});

test('native Dashboard reads a narrow physical data grid before padding planned growth locally', () => {
  const input = { canvas: { sheetId: 101, title: 'Dashboard', rowCount: 72, columnCount: 12 },
    data: { sheetId: 106, title: "Dashboard's Data", rowCount: 20, columnCount: 8 } };
  let calls = 0;
  const read = ranges => {
    calls++;
    // This provider rejects reads outside its existing eight columns.
    assert.deepEqual(ranges, ["'Dashboard'!A1:L72", "'Dashboard''s Data'!A1:H20"]);
    return { sheets: [{ properties: { sheetId: 101 }, data: [{ rowData: [{ values: [{ userEnteredValue: { stringValue: 'Title' } }] }] }] },
      { properties: { sheetId: 106 }, data: [{ rowData: [{ values: Array.from({ length: 8 }, (_, n) => ({ userEnteredValue: { numberValue: n } })) }] }] }] };
  };
  const result = readFrontendDashboardValues(input, read);
  assert.equal(calls, 1); assert.equal(result.canvas.length, 72); assert.equal(result.canvas[0].length, 12);
  assert.equal(result.data.length, 20); assert.equal(result.data[0].length, 16);
  assert.equal(result.data[0][7].userEnteredValue.numberValue, 7);
  assert.deepEqual(result.data[0].slice(8), Array.from({ length: 8 }, () => ({})));
  assert.deepEqual(result.data[19], Array.from({ length: 16 }, () => ({})));
  assert.throws(() => readFrontendDashboardValues({ ...input, data: { ...input.data, columnCount: 17 } }, read), e => e.code === 'frontend_dashboard');
  assert.equal(calls, 1);
});

test('private operator resume is checkpoint-bound, monotonic and consumed before clearing a pause', () => {
  const props = { SHAMROCK_V3_FRONTEND_PAUSED: 'true' }, calls = [];
  const request = { requestId: 'resume-1', sequence: 1, stateSha256: 'a'.repeat(64) };
  const properties = { getProperty: key => props[key] ?? null, setProperty(key, value) { calls.push('persist'); props[key] = value; }, deleteProperty(key) { calls.push('clear'); delete props[key]; } };
  const input = { request, properties, readStateSha256() { calls.push('read'); return request.stateSha256; }, lock: { tryLock() { calls.push('lock'); return true; }, releaseLock() { calls.push('unlock'); } } };
  assert.equal(consumeFrontendResume(input), 'resumed');
  assert.deepEqual(calls, ['lock', 'read', 'persist', 'clear', 'unlock']);
  props.SHAMROCK_V3_FRONTEND_PAUSED = 'true'; calls.length = 0;
  assert.equal(consumeFrontendResume(input), 'already-consumed');
  assert.equal(props.SHAMROCK_V3_FRONTEND_PAUSED, 'true');
  assert.deepEqual(calls, ['lock', 'unlock']);
  assert.throws(() => consumeFrontendResume({ ...input, request: { ...request, requestId: 'another', sequence: 1 } }));
  const second = { ...request, requestId: 'resume-2', sequence: 2 };
  assert.throws(() => consumeFrontendResume({ ...input, request: second, readStateSha256: () => 'b'.repeat(64) }), /checkpoint changed/);
  assert.equal(props.SHAMROCK_V3_FRONTEND_PAUSED, 'true');
  assert.equal(consumeFrontendResume({ ...input, request: second }), 'resumed');
  assert.throws(() => consumeFrontendResume(input)); // old request cannot override a later pause
});

test('failed resume receipt persistence never clears a pause', () => {
  let cleared = false;
  assert.throws(() => consumeFrontendResume({ request: { requestId: 'resume', sequence: 1, stateSha256: 'a'.repeat(64) }, readStateSha256: () => 'a'.repeat(64),
    properties: { getProperty: () => null, setProperty() {}, deleteProperty() { cleared = true; } }, lock: { tryLock: () => true, releaseLock() {} } }), /did not persist/);
  assert.equal(cleared, false);
});

const canonicalRecovery = value => JSON.stringify(value, (_k,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
function reviewedRecovery(runtime, fx, claim) {
  fx.claim = { ...claim, leaseExpiresAt: new Date(990000).toISOString() };
  if (fx.state.pending) fx.state.pending.claim = copy(fx.claim);
  runtime.recovery = { recoveryId: 'operator-recovery', previousExpiry: fx.claim.leaseExpiresAt, checkpointSha256: signer.sha256(canonicalRecovery(fx.state)) };
  const original = runtime.transport.send.bind(runtime.transport);
  runtime.transport.send = request => {
    if (!request.url.endsWith('/recover')) return original(request);
    const body=JSON.parse(request.body);fx.calls.push('recover');
    assert.equal(fx.fenced,true);assert.equal(body.producerFenced,true);assert.equal(body.exclusiveWriter,true);
    assert.equal(request.headers['x-shamrock-signature'],signer.hmacSha256(`POST\n/v1/admin/effects/recover\n1000\n${signer.sha256(request.body)}`));
    assert.equal(body.checkpointSha256,runtime.recovery.checkpointSha256);
    return {status:200,body:JSON.stringify({status:'renewed',recoveryId:body.recoveryId,effectId:body.effectId,workerId:body.workerId,claimToken:body.claimToken,leaseExpiresAt:claim.leaseExpiresAt,checkpointSha256:body.checkpointSha256,providerState:body.providerState})};
  };
}
test('explicit lease reconciliation recovers a failed pre-write checkpoint and uses the same retained claim',()=>{
  const {fx,runtime,claim}=fixture(); reviewedRecovery(runtime,fx,claim);
  assert.equal(consumeFrontendRefresh(runtime).status,'published');
  assert.equal(fx.calls.filter(x=>x==='recover').length,1);assert.equal(fx.calls.includes('claim'),false);assert.equal(fx.writes,1);
});
test('explicit recovery verifies a partial two-workbook publication and never replays its completed Main batch',()=>{
  const {fx,runtime,claim}=fullFixture();fx.mode='excusal-before';
  assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.writes,1);assert.ok(fx.state.pending);
  fx.enabled=true;fx.mode='normal';reviewedRecovery(runtime,fx,claim);
  assert.equal(consumeFrontendRefresh(runtime).status,'published');assert.equal(fx.writes,1);assert.equal(fx.excusalWrites,2);
});
test('lease recovery refuses an unreviewed checkpoint or mixed provider contents before contacting renewal',()=>{
  for(const broken of ['checkpoint','mixed']){
    const {fx,runtime,claim}=fixture();fx.mode='write-after';assert.throws(()=>consumeFrontendRefresh(runtime));
    fx.enabled=true;fx.mode='normal';reviewedRecovery(runtime,fx,claim);
    if(broken==='checkpoint')runtime.recovery.checkpointSha256='b'.repeat(64);else fx.current.directory.rows[0][1]=frontendLiteralCell('unexpected');
    assert.throws(()=>consumeFrontendRefresh(runtime));assert.equal(fx.calls.includes('recover'),false);assert.equal(fx.fenced,true);
  }
});


test('explicit input setup can verify a disabled publisher without enabling ordinary publication or input',()=>{
 const owner='automation@example.invalid',host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://staging.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'journal',sheetId:1},attendance:{formId:'form',resourceKey:'attendance',itemRoles:{event:'event',scope:'scope',present:['present'],completeness:'complete'}}};
 const frontend={version:1,environment:'staging',generation:1,enabled:false,resourceReview:'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING',workerId:'worker',principalId:'publisher',stateFileId:'state',main:{spreadsheetId:'main',expectedTitle:'Frontend Staging',sheets:{directory:{sheetId:1,tableId:'directory'},leadership:{sheetId:2,tableId:'leadership'},attendance:{sheetId:3,tableId:'attendance'}}},access:{ownerEmail:owner,automationEmail:owner},allowedFileEditors:[],seeds:[]};
 const values={SHAMROCK_V3_HOST_CONFIG:JSON.stringify(host),SHAMROCK_V3_FRONTEND_CONFIG:JSON.stringify(frontend),SHAMROCK_V3_BRIDGE_SECRET:'fictional-input-setup-secret-long-enough',SHAMROCK_V3_FRONTEND_PAUSED:'true'};let fetched=0,locked=0,released=0,called=false;
 const runtime=createNativeFrontendRuntime({PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]??null,setProperty(){throw Error('must stay paused');},deleteProperty(){throw Error('must stay paused');}})},Session:{getEffectiveUser:()=>({getEmail:()=>owner})},ScriptApp:{getOAuthToken:()=> 'fixture'},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:()=>Array(32).fill(0),computeHmacSha256Signature:()=>Array(32).fill(0)},LockService:{getScriptLock:()=>({tryLock:()=>{locked++;return true;},releaseLock:()=>{released++;}})},UrlFetchApp:{fetch(url,options){fetched++;assert.equal(options.method,'get');assert.match(url,/googleapis/);throw Error('stop at provider isolation');}}});
 assert.equal(runtime.refresh().status,'disabled');assert.equal(runtime.inputSession(()=>{called=true;}).status,'disabled');assert.equal(fetched,0);assert.equal(locked,0);
 assert.throws(()=>runtime.inputSession(()=>{called=true;},{allowPaused:true}),e=>e.code==='frontend_google_transport');assert.equal(called,false);assert.equal(fetched,1);assert.equal(locked,1);assert.equal(released,1);assert.equal(values.SHAMROCK_V3_FRONTEND_PAUSED,'true');
});

test('explicit setup recovers only an exactly closed native fence; ordinary input and mixed protections still fail',async()=>{
 const {assertInputSessionPolicy}=await import('../../.build/v3/apps/google-adapter/src/frontend-runtime.js');let closed=0;
 const exact={assertEditPolicy(){throw Error('not open');},assertFenced(){closed++;}};
 assertInputSessionPolicy(exact,true);assert.equal(closed,1);assert.throws(()=>assertInputSessionPolicy(exact,false),/not open/);assert.equal(closed,1);
 assert.throws(()=>assertInputSessionPolicy({assertEditPolicy(){throw Error('mixed');},assertFenced(){throw Error('not exactly fenced');}},true),/not exactly fenced/);
});

test('successive closed scheduler ticks publish Sheets then Forms through the same named pins', async () => {
  const {runClosedPublicationTick} = await import('../../.build/v3/apps/google-adapter/src/scheduled-runtime.js');
  const {fx,runtime,claim} = fullFixture();
  const window = {version:1,frontendEffectId:claim.effectId,formsEffectId:'managed-forms',revision:copy(fx.model.revision),
    expiresAt:new Date((fx.now+1800)*1000).toISOString()};
  runtime.closedWindow=window;
  fx.fenced=true;
  runtime.fenceEdits=runtime.restoreEditPolicy=runtime.assertEditPolicy=()=>assert.fail('opening the native edit policy');
  const send=runtime.transport.send, calls=[];
  let done=false;
  runtime.transport.send=request=>{
    const action=request.url.split('/').at(-1);
    if (action==='claim') {
      const body=JSON.parse(request.body);
      assert.equal(body.expectedEffectId,window.frontendEffectId);assert.deepEqual(body.expectedRevision,window.revision);
      calls.push(action);if(done)return {status:200,body:'{"effect":null}'};
    }
    if(action==='ack'){assert.ok(fx.fenced);assert.ok(fx.state.completedClaim);done=true;return {status:200,body:'{"acknowledged":true}'};}
    return send(request);
  };
  const frontend={publishClosedMaintenance:w=>{assert.deepEqual(w,window);return consumeFrontendRefresh(runtime);},
    assertClosedMaintenance:()=>assert.equal(fx.fenced,true)};
  const forms={publishClosedMaintenance:(w,guard)=>{guard();assert.equal(w.formsEffectId,window.formsEffectId);calls.push('forms');return {status:'published'};}};
  assert.equal(runClosedPublicationTick(window,frontend,forms).frontend.status,'published');
  assert.deepEqual(calls,['claim']); const writes=fx.writes+fx.excusalWrites;
  assert.equal(runClosedPublicationTick(window,frontend,forms).forms.status,'published');
  assert.deepEqual(calls,['claim','claim','forms']);assert.equal(fx.writes+fx.excusalWrites,writes);
});
