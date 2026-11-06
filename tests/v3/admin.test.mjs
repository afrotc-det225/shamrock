import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {Miniflare,Log,LogLevel} from 'miniflare';
import worker from '../../.build/v3/apps/worker/src/index.js';
import {parseAdminCommand,operationallyActive} from '../../.build/v3/packages/domain/src/admin.js';
const secret='fictional-admin-test-secret-never-for-deployment';
const keyId='admin-fixture';
const directory=new URL('../../database/migrations/',import.meta.url);
const migration=(await Promise.all((await readdir(directory)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,directory),'utf8')))).join('\n');
function nativeRequest(input,path='/v1/admin/commands',method='POST') {
  const body=method==='GET'?'':JSON.stringify(input);const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',secret).update(`${method}\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  return new Request(`https://fixture.invalid${path}`,{method,...(method==='GET'?{}:{body}),headers:{'content-type':'application/json','x-shamrock-key-id':keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signature}});
}
async function fixture(t) {
  const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'admin-fixture-db'},bindings:{ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret},log:new Log(LogLevel.NONE)});
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  await db.batch(migration.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
    db.prepare("INSERT INTO principals VALUES('admin',NULL,1),('flight-admin',NULL,1),('outsider',NULL,1)"),
    db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)"),
    db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),
    db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold')"),
    db.prepare("INSERT INTO terms VALUES('term-current','Fictional Current',2,1),('term-prior','Fictional Prior',1,0)"),
    db.prepare("INSERT INTO admin_grants SELECT 'admin',value,'wing','*' FROM json_each('[\"directory.manage\",\"leadership.manage\",\"events.manage\",\"frontend.read\"]')"),
    db.prepare("INSERT INTO admin_grants VALUES('flight-admin','directory.manage','flight','alpha')"),
    db.prepare("INSERT INTO adapter_sources VALUES('test','admin-console',1),('sheet','directory-sheet',1)"),
  ]);
  const env={DB:db,ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret};
  const send=async(input,path='/v1/admin/commands',method='POST')=>{const request=nativeRequest(input,path,method);const res=await mf.dispatchFetch(request.url,{method,headers:Object.fromEntries(request.headers),...(method==='GET'?{}:{body:await request.text()})});return {status:res.status,body:await res.json()};};
  const count=async(table)=>(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
  return {db,env,send,count};
}
const profile=()=>({lastName:'Example',firstName:'Cadet',asYear:'AS200',rank:'C/SSgt',role:'Flight Commander',university:'Notre Dame',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:''});
function command(operation='directory.upsert',changes={}) {
  const defaults={
    'directory.upsert':{personId:'person-a',expectedVersion:0,flightId:'alpha',profile:profile()},
    'leadership.upsert':{contactId:'manual-cadre',expectedVersion:0,personId:null,profile:{lastName:'Example',firstName:'Cadre',rank:'Capt',role:'Cadre',email:'cadre@example.invalid',cellPhone:''},reportsTo:'',officePhone:'',officeLocation:'',active:true},
    'event.upsert':{eventId:'event-one',expectedVersion:0,termId:'term-current',eventType:'llab',trainingWeek:1,displayOrder:1,label:'TW-1 LLAB',columnLabel:'LLAB TW-1',expectedGroup:'All Cadets',flightIds:['alpha','bravo'],eligiblePersonIds:[],status:'active',startAt:'2026-01-01T12:00:00.000Z',endAt:'2026-01-01T13:00:00.000Z',location:'Fictional field',notes:''},
  };
  return {commandId:operation,contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'admin-console',submissionId:operation,revision:1},operation,payload:defaults[operation],...changes};
}
function revised(c,revision=2) {const copy=structuredClone(c);copy.commandId+=`-${revision}`;copy.source.revision=revision;copy.payload.expectedVersion=revision-1;return copy;}
const read=extra=>({environment:'local',generation:1,principalId:'admin',...extra});
const effect=extra=>read({workerId:'adapter-one',...extra});

// Contract tests cover unsafe or unsupported identity changes before any SQL runs.
test('admin contract rejects unsupported fields, invalid dates, forms, retired events and contradictory profile state',()=>{
  const valid=command();assert.deepEqual(parseAdminCommand(valid),valid);assert.equal(operationallyActive(profile()),true);
  const cases=[c=>{c.payload.profile.asYear='Unknown';},c=>{c.payload.profile.dateOfBirth='2001-02-29';},c=>{c.payload.profile.photoLink='javascript:alert(1)';},c=>{c.source.kind='form';},c=>{c.payload.flightId=null;},c=>{c.payload.untrusted=true;}];
  for(const change of cases){const bad=command();change(bad);assert.throws(()=>parseAdminCommand(bad),{code:'INVALID_COMMAND'});}
  const retired=command('event.upsert');retired.payload.eventType='third-hour';assert.throws(()=>parseAdminCommand(retired),{code:'INVALID_COMMAND'});
  const linked=command('leadership.upsert');linked.payload.personId='person-a';assert.throws(()=>parseAdminCommand(linked),{code:'INVALID_COMMAND'});
});

test('Directory creates one stable profile, membership history, audit, receipt and two bounded refresh intents',async t=>{
  const f=await fixture(t);const c=command();const first=await f.send(c);assert.equal(first.status,200,JSON.stringify(first.body));
  assert.deepEqual(first.body.result,{targetId:'person-a',version:1});
  for(const table of ['people','directory_profiles','memberships','directory_membership_history','admin_commands','admin_audit_events'])assert.equal(await f.count(table),1,table);
  assert.equal(await f.count('admin_effects'),2);assert.equal(await f.count('command_assertions'),0);
  assert.equal((await f.db.prepare("SELECT roster_version FROM organizational_units WHERE unit_id='alpha'").first()).roster_version,2);
  assert.deepEqual(await f.send(c),first);assert.equal(await f.count('admin_effects'),2);
  const conflict=structuredClone(c);conflict.payload.profile.firstName='Changed';assert.equal((await f.send(conflict)).status,409);
  const sourceReuse=structuredClone(c);sourceReuse.commandId='new-id';assert.equal((await f.send(sourceReuse)).status,409);
});

test('transfers require both Flight scopes and bump both roster versions; inactive cadets retain prior data',async t=>{
  const f=await fixture(t);const c=command();c.actor.principalId='flight-admin';assert.equal((await f.send(c)).status,200);
  const move=revised(c);move.payload.flightId='bravo';assert.equal((await f.send(move)).status,403);
  await f.db.prepare("INSERT INTO admin_grants VALUES('flight-admin','directory.manage','flight','bravo')").run();
  assert.equal((await f.send(move)).status,200);
  assert.deepEqual((await f.db.prepare('SELECT unit_id,active FROM memberships ORDER BY unit_id').all()).results,[{unit_id:'alpha',active:0},{unit_id:'bravo',active:1}]);
  const stale=revised(c,3);stale.payload.expectedVersion=1;assert.equal((await f.send(stale)).status,409);
  const inactive=revised(move,3);inactive.payload.profile.flightPathStatus='Commissioned';assert.equal((await f.send(inactive)).status,200);
  assert.equal(await f.count('people'),1);assert.equal((await f.db.prepare('SELECT SUM(active) AS active FROM memberships').first()).active,0);
  assert.equal(await f.count('directory_membership_history'),3);
});

test('replay and receipt retrieval honor grant, principal and source revocation',async t=>{
  const f=await fixture(t);const c=command();assert.equal((await f.send(c)).status,200);
  assert.equal((await f.send(null,'/v1/admin/commands/directory.upsert?principalId=admin','GET')).status,200);
  await f.db.prepare("DELETE FROM admin_grants WHERE capability='directory.manage'").run();
  assert.equal((await f.send(c)).status,403);assert.equal((await f.send(null,'/v1/admin/commands/directory.upsert?principalId=admin','GET')).status,404);
  await f.db.prepare("INSERT INTO admin_grants VALUES('admin','directory.manage','wing','*')").run();
  await f.db.prepare("UPDATE adapter_sources SET active=0").run();assert.equal((await f.send(c)).status,403);
  await f.db.prepare("UPDATE adapter_sources SET active=1").run();await f.db.prepare("UPDATE principals SET active=0 WHERE principal_id='admin'").run();assert.equal((await f.send(c)).status,403);
});

test('manual Leadership is preserved while Directory-linked contact identity and role follow the current profile',async t=>{
  const f=await fixture(t);const c=command();assert.equal((await f.send(c)).status,200);
  assert.equal((await f.send(command('leadership.upsert'))).status,200);
  const linked=command('leadership.upsert',{commandId:'link-contact',source:{kind:'test',resourceKey:'admin-console',submissionId:'link-contact',revision:1},payload:{contactId:'cadet-contact',expectedVersion:0,personId:'person-a',profile:null,reportsTo:'Blue Squadron Commander',officePhone:'',officeLocation:'',active:true}});
  assert.equal((await f.send(linked)).status,200);
  let view=(await f.send(read(),'/v1/admin/snapshot')).body;
  assert.equal(view.leadership.length,2);assert.equal(view.leadership.find(r=>r.personId==='person-a').role,'Alpha Flight Commander');
  const rename=revised(c);rename.payload.profile.firstName='New Name';assert.equal((await f.send(rename)).status,200);
  view=(await f.send(read(),'/v1/admin/snapshot')).body;assert.equal(view.leadership.find(r=>r.personId==='person-a').firstName,'New Name');
  assert.equal(view.leadership.find(r=>r.personId==='person-a').reportsTo,'Blue Squadron Commander');
  const remove=revised(c,3);remove.payload.profile.role='';assert.equal((await f.send(remove)).status,200);
  view=(await f.send(read(),'/v1/admin/snapshot')).body;assert.equal(view.leadership.length,1);assert.equal(view.leadership[0].contactId,'manual-cadre');
});

test('events preserve ID and term, update explicit Flight scope, cancel without deleting evidence, and reject stale edits',async t=>{
  const f=await fixture(t);const c=command('event.upsert');assert.equal((await f.send(c)).status,200);
  const edit=revised(c);edit.payload.flightIds=['bravo'];edit.payload.status='cancelled';assert.equal((await f.send(edit)).status,200);
  assert.equal(await f.count('events'),1);assert.equal((await f.db.prepare('SELECT active FROM events').first()).active,0);
  assert.equal(await f.count('event_units'),1);assert.equal(await f.count('admin_effects'),4);
  const moveTerm=revised(c,3);moveTerm.payload.termId='term-prior';assert.equal((await f.send(moveTerm)).status,409);
  const stale=revised(c,4);stale.payload.expectedVersion=1;assert.equal((await f.send(stale)).status,409);
  const wingOnly=revised(c,5);wingOnly.actor.principalId='flight-admin';assert.equal((await f.send(wingOnly)).status,403);
});

test('late grant revocation and audit write failure roll back the entire administrative batch',async t=>{
  const f=await fixture(t);let batches=0;
  const DB={prepare:sql=>f.db.prepare(sql),batch:async statements=>{
    batches++;if(batches===3)await f.db.prepare("DELETE FROM admin_grants WHERE capability='directory.manage'").run();
    return f.db.batch(statements);
  }};
  const raced=await worker.fetch(nativeRequest(command()),{...f.env,DB});assert.equal(raced.status,409);
  for(const table of ['people','directory_profiles','admin_commands','admin_audit_events','admin_effects'])assert.equal(await f.count(table),0,table);
  await f.db.prepare("INSERT INTO admin_grants VALUES('admin','directory.manage','wing','*')").run();
  await f.db.prepare("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'fixture-audit-failure'); END").run();
  const failed=await f.send(command());assert.equal(failed.status,409);
  for(const table of ['people','directory_profiles','admin_commands','admin_audit_events','admin_effects'])assert.equal(await f.count(table),0,table);
});

test('snapshot is one coherent bounded read with causal fact order and remains readable while mutations are paused',async t=>{
  const f=await fixture(t);assert.equal((await f.send(command())).status,200);assert.equal((await f.send(command('event.upsert'))).status,200);
  await f.db.batch([f.db.prepare("INSERT INTO access_grants VALUES('admin','attendance.report','alpha','unit')"),f.db.prepare("INSERT INTO adapter_sources VALUES('test','attendance-console',1)")]);
  const attendance={commandId:'attendance-one',contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'attendance-console',submissionId:'attendance-one',revision:1},operation:'attendance.report',payload:{reportId:'report-one',eventId:'event-one',unitId:'alpha',rosterVersion:2,coveredPersonIds:['person-a'],presentPersonIds:['person-a'],completeness:'complete'}};
  assert.equal((await f.send(attendance,'/v1/commands')).status,200);
  await f.db.prepare('UPDATE system_control SET accepting_commands=0').run();
  const result=await f.send(read(),'/v1/admin/snapshot');assert.equal(result.status,200);assert.deepEqual(result.body.revision,{operations:1,administration:2});
  assert.equal(result.body.observations[0].order,1);assert.deepEqual(result.body.diagnostics,[]);
  assert.equal((await f.send(revised(command()))).status,403);
  assert.equal((await f.send(read({principalId:'outsider'}),'/v1/admin/snapshot')).status,403);
});

test('effects project fresh snapshots, serialize each kind, reject stolen or expired claims and remain pending until acknowledgement',async t=>{
  const f=await fixture(t);const c=command();c.commandId='x'.repeat(128);assert.equal((await f.send(c)).status,200);
  const claim=await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim');assert.equal(claim.status,200);assert.ok(claim.body.effect.effectId.length<=128);
  const key={effectId:claim.body.effect.effectId,claimToken:claim.body.effect.claimToken};
  const projected=await f.send(effect(key),'/v1/admin/effects/project');assert.equal(projected.status,200);assert.equal(projected.body.snapshot.people.length,1);
  assert.equal((await f.send(effect({...key,claimToken:'wrong'}),'/v1/admin/effects/ack')).status,409);
  assert.equal((await f.send(effect(key),'/v1/admin/effects/ack')).status,200);
  const second=(await f.send(effect({kind:'forms.refresh'}),'/v1/admin/effects/claim')).body.effect;
  await f.db.prepare("UPDATE admin_effects SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE state='leased'").run();
  assert.equal((await f.send(effect({effectId:second.effectId,claimToken:second.claimToken}),'/v1/admin/effects/ack')).status,409);
  assert.equal((await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect,null);
});

test('concurrent identical administrative deliveries commit once and return the same receipt',async t=>{
  const f=await fixture(t);const result=await Promise.all([f.send(command()),f.send(command())]);
  assert.deepEqual(result.map(r=>r.status),[200,200]);assert.deepEqual(result[0],result[1]);assert.equal(await f.count('admin_audit_events'),1);
});

test('command IDs cannot collide across the operational and administrative ledgers',async t=>{
  const f=await fixture(t);assert.equal((await f.send(command())).status,200);assert.equal((await f.send(command('event.upsert'))).status,200);
  await f.db.prepare("INSERT INTO access_grants VALUES('admin','attendance.report','alpha','unit')").run();
  const operational={commandId:'shared-id',contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'admin-console',submissionId:'presence-source',revision:1},operation:'attendance.report',payload:{reportId:'presence-report',eventId:'event-one',unitId:'alpha',rosterVersion:2,coveredPersonIds:['person-a'],presentPersonIds:['person-a'],completeness:'complete'}};
  assert.equal((await f.send(operational,'/v1/commands')).status,200);
  const admin=revised(command());admin.commandId='shared-id';assert.equal((await f.send(admin)).status,409);
  admin.commandId='administrative-id';assert.equal((await f.send(admin)).status,200);
  operational.commandId='administrative-id';operational.source.submissionId='another-presence-source';operational.payload.reportId='another-report';operational.payload.rosterVersion=3;
  assert.equal((await f.send(operational,'/v1/commands')).status,409);assert.equal(await f.count('attendance_reports'),1);
});

async function correctionFixture(t) {
  const f = await fixture(t);
  assert.equal((await f.send(command())).status, 200);
  const eventCommand = command('event.upsert');
  eventCommand.payload.eligiblePersonIds = ['person-a'];
  assert.equal((await f.send(eventCommand)).status, 200);
  await f.db.batch([
    f.db.prepare("INSERT INTO admin_grants VALUES('admin','attendance.correct','wing','*'),('flight-admin','attendance.correct','flight','alpha')"),
    f.db.prepare("INSERT INTO access_grants VALUES('admin','attendance.report','alpha','unit'),('admin','excusal.submit','alpha','unit'),('admin','excusal.decide','alpha','unit')"),
  ]);
  const base = {contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'admin-console',submissionId:'correction-one',revision:1}};
  const correction = { ...base, commandId:'correction-one',operation:'attendance.correct',payload:{personId:'person-a',eventId:'event-one',expectedBaseVersion:0,expectedEventVersion:1,code:'T',reason:'Fictional authorized correction.'}};
  const attendance = {...base,commandId:'presence-one',source:{...base.source,submissionId:'presence-one'},operation:'attendance.report',payload:{reportId:'report-one',eventId:'event-one',unitId:'alpha',rosterVersion:2,coveredPersonIds:['person-a'],presentPersonIds:['person-a'],completeness:'complete'}};
  return {...f,correction,attendance,eventCommand};
}

test('correction appends one causal audit and receipt; explicit clear retains original presence and can be replayed', async t => {
  const f = await correctionFixture(t);
  assert.equal((await f.send(f.attendance,'/v1/commands')).status,200);
  f.correction.payload.expectedBaseVersion=1;
  const result=await f.send(f.correction);
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.deepEqual(result.body.result,{personId:'person-a',eventId:'event-one',version:2,code:'T'});
  assert.equal(await f.count('attendance_corrections'),1);assert.equal(await f.count('attendance_observations'),1);
  assert.equal(await f.count('admin_commands'),2);assert.equal(await f.count('admin_audit_events'),2);
  assert.equal(await f.count('operation_commands'),2);assert.equal(await f.count('audit_events'),2);
  assert.deepEqual(await f.send(f.correction),result);
  assert.deepEqual(await f.send(null,'/v1/admin/commands/correction-one?principalId=admin','GET'),result);
  const clear=structuredClone(f.correction);clear.commandId='correction-clear';clear.source.submissionId='correction-clear';clear.payload.expectedBaseVersion=2;clear.payload.code=null;
  assert.equal((await f.send(clear)).status,200);
  const view=(await f.send(read(),'/v1/admin/snapshot')).body;
  assert.deepEqual(view.attendanceVersions,[{personId:'person-a',eventId:'event-one',version:3}]);
  assert.deepEqual(view.corrections.map(c=>[c.order,c.code]),[[2,'T'],[3,null]]);
  assert.equal(view.observations[0].code,'P');assert.equal(view.events[0].eligiblePersonIds[0],'person-a');
  assert.equal((await f.db.prepare('SELECT observed_code FROM attendance_current').first()).observed_code,'P');
});

test('correction base versions change on requests and decisions and never erase a newer authoritative change', async t => {
  const f=await correctionFixture(t);
  const submit={...f.attendance,commandId:'request-one',source:{...f.attendance.source,submissionId:'request-one'},operation:'excusal.submit',payload:{requestId:'request-one',eventId:'event-one',personId:'person-a',requestedOutcome:'E',reason:'Fictional reason.'}};
  assert.equal((await f.send(submit,'/v1/commands')).status,200);
  assert.equal((await f.send(f.correction)).status,409);
  f.correction.payload.expectedBaseVersion=1;
  const decision={...f.attendance,commandId:'decision-one',source:{...f.attendance.source,submissionId:'decision-one'},operation:'excusal.decide',payload:{requestId:'request-one',expectedVersion:1,decision:'Approved',reason:'Fictional decision.'}};
  assert.equal((await f.send(decision,'/v1/commands')).status,200);
  assert.equal((await f.send(f.correction)).status,409);
  f.correction.payload.expectedBaseVersion=2;assert.equal((await f.send(f.correction)).status,200);
  assert.equal((await f.send(read(),'/v1/admin/snapshot')).body.attendanceVersions[0].version,3);
});

test('event roster history survives Directory transfer, event edits preserve captured profiles, and old event versions reject corrections', async t => {
  const f=await correctionFixture(t);
  const move=revised(command());move.payload.flightId='bravo';move.payload.profile.lastName='New Name';
  assert.equal((await f.send(move)).status,200);
  const edit=revised(f.eventCommand);edit.payload.notes='Fictional updated location notes.';
  assert.equal((await f.send(edit)).status,200);
  const captured=(await f.db.prepare('SELECT version,flight_id,last_name FROM event_roster_members ORDER BY version').all()).results;
  assert.deepEqual(captured,[{version:1,flight_id:'alpha',last_name:'Example'},{version:2,flight_id:'alpha',last_name:'Example'}]);
  assert.equal((await f.send(f.correction)).status,409);
  f.correction.payload.expectedEventVersion=2;f.correction.actor.principalId='flight-admin';
  assert.equal((await f.send(f.correction)).status,200);
  const snapshot=(await f.send(read(),'/v1/admin/snapshot')).body;
  assert.equal(snapshot.people[0].flightId,'bravo');assert.deepEqual(snapshot.events[0].eligiblePersonIds,['person-a']);
  assert.equal(snapshot.terms.find(t=>t.isCurrent).roster[0].lastName,'New Name');
});

test('event roster validation rejects unknown people and preserves an explicitly empty roster', async t => {
  const f=await fixture(t);const eventCommand=command('event.upsert');eventCommand.payload.eligiblePersonIds=['not-a-person'];
  assert.equal((await f.send(eventCommand)).status,409);assert.equal(await f.count('events'),0);
  eventCommand.payload.eligiblePersonIds=[];assert.equal((await f.send(eventCommand)).status,200);
  const snapshot=(await f.send(read(),'/v1/admin/snapshot')).body;assert.deepEqual(snapshot.events[0].eligiblePersonIds,[]);
});

test('correction authority revocation blocks replay and audit failure rolls back registry, receipt, evidence and effect', async t => {
  const f=await correctionFixture(t);
  await f.db.prepare("CREATE TRIGGER reject_correction_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fixture-correction-audit'); END").run();
  assert.equal((await f.send(f.correction)).status,409);
  for(const table of ['attendance_corrections','operation_commands','audit_events'])assert.equal(await f.count(table),0);
  assert.equal(await f.count('command_registry'),2);
  await f.db.prepare('DROP TRIGGER reject_correction_audit').run();
  assert.equal((await f.send(f.correction)).status,200);
  await f.db.prepare("DELETE FROM admin_grants WHERE capability='attendance.correct'").run();
  assert.equal((await f.send(f.correction)).status,403);
  assert.equal((await f.send(null,'/v1/admin/commands/correction-one?principalId=admin','GET')).status,404);
});

test('correction concurrent delivery commits once and stored source identity prevents duplicate edits', async t => {
  const f=await correctionFixture(t);
  const results=await Promise.all([f.send(f.correction),f.send(f.correction)]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);assert.deepEqual(results[0],results[1]);
  const other=structuredClone(f.correction);other.commandId='different-id';other.payload.expectedBaseVersion=1;
  assert.equal((await f.send(other)).status,409);
  assert.equal(await f.count('attendance_corrections'),1);assert.equal(await f.count('audit_events'),1);
});

test('late correction grant revocation and a racing request both reject the stale mutation atomically', async t => {
  const f = await correctionFixture(t);
  let calls = 0;
  const revoked = {
    prepare: sql => f.db.prepare(sql),
    batch: async statements => {
      if (calls++ === 0) await f.db.prepare("DELETE FROM admin_grants WHERE capability='attendance.correct'").run();
      return f.db.batch(statements);
    },
  };
  assert.equal((await worker.fetch(nativeRequest(f.correction), {...f.env, DB:revoked})).status,409);
  assert.equal(await f.count('attendance_corrections'),0);
  await f.db.prepare("INSERT INTO admin_grants VALUES('admin','attendance.correct','wing','*')").run();
  const request={...f.attendance,commandId:'racing-request',source:{...f.attendance.source,submissionId:'racing-request'},operation:'excusal.submit',payload:{requestId:'racing-request',eventId:'event-one',personId:'person-a',requestedOutcome:'E',reason:'Fictional concurrent request.'}};
  calls=0;
  const changed = {
    prepare: sql => f.db.prepare(sql),
    batch: async statements => {
      if (calls++ === 0) assert.equal((await f.send(request,'/v1/commands')).status,200);
      return f.db.batch(statements);
    },
  };
  assert.equal((await worker.fetch(nativeRequest(f.correction), {...f.env, DB:changed})).status,409);
  assert.equal(await f.count('attendance_corrections'),0);assert.equal(await f.count('excusal_requests'),1);
  assert.equal(await f.count('command_registry'),3);
});

test('linked Leadership separates publication and command versions and hashes maximum-length person IDs', async t => {
  const f = await fixture(t);
  const c = command(); c.payload.personId='p'.repeat(128);
  assert.equal((await f.send(c)).status,200);
  let row=(await f.send(read(),'/v1/admin/snapshot')).body.leadership[0];
  const originalId=row.contactId;
  assert.match(originalId,/^cadet:[a-f0-9]{64}$/);
  assert.deepEqual([row.profileVersion,row.contactVersion,row.publicationVersion],[1,0,1]);
  const rename=revised(c);rename.payload.profile.firstName='Changed';assert.equal((await f.send(rename)).status,200);
  row=(await f.send(read(),'/v1/admin/snapshot')).body.leadership[0];
  assert.equal(row.contactId,originalId);assert.deepEqual([row.profileVersion,row.contactVersion,row.publicationVersion],[2,0,2]);
  const contact=command('leadership.upsert',{payload:{contactId:originalId,personId:c.payload.personId,profile:null,expectedVersion:0,reportsTo:'Wing Commander',officePhone:'',officeLocation:'',active:true}});
  assert.equal((await f.send(contact)).status,200);
  row=(await f.send(read(),'/v1/admin/snapshot')).body.leadership[0];
  assert.deepEqual([row.profileVersion,row.contactVersion,row.publicationVersion],[2,1,3]);
});

async function notificationFixture(t) {
  const f=await correctionFixture(t);
  await f.db.prepare("INSERT INTO admin_grants VALUES('admin','notifications.manage','wing','*')").run();
  const plan={...f.correction,commandId:'notice-plan-one',operation:'notifications.plan',source:{...f.correction.source,submissionId:'notice-plan-one'},payload:{kind:'scheduled',asOf:'2026-01-01T10:00:00.000Z',requestId:null}};
  return {...f,plan};
}
const noticePath='/v1/admin/notifications/plan';

test('notification HTTP planning persists terminal suppressed intents with trusted routing and deterministic keys',async t=>{
  const f=await notificationFixture(t);
  const first=await f.send(f.plan,noticePath);assert.equal(first.status,200,JSON.stringify(first.body));
  assert.deepEqual(first.body.result,{planned:2,created:2,suppressed:2,missingRouting:1});
  assert.equal(await f.count('notification_intents'),2);assert.equal(await f.count('notification_attempts'),0);
  const notices=(await f.db.prepare('SELECT state,to_json,cc_json FROM notification_intents ORDER BY scope_id').all()).results;
  assert.ok(notices.every(n=>n.state==='suppressed'));assert.deepEqual(JSON.parse(notices[0].to_json),['cadet@example.invalid']);
  assert.deepEqual(await f.send(f.plan,noticePath),first);
  const newRun=structuredClone(f.plan);newRun.commandId='notice-plan-two';newRun.source.submissionId='notice-plan-two';
  assert.equal((await f.send(newRun,noticePath)).body.result.created,0);assert.equal(await f.count('notification_intents'),2);
  const forged=structuredClone(newRun);forged.payload.mode='live';assert.equal((await f.send(forged,noticePath)).status,400);
  const injected=structuredClone(newRun);injected.payload.to=['attacker@example.invalid'];assert.equal((await f.send(injected,noticePath)).status,400);
  const status=await f.send(read(),'/v1/admin/notifications/status');assert.equal(status.status,200);assert.equal(status.body.deliveryEnabled,false);
  assert.deepEqual(status.body.states,[{state:'suppressed',count:2}]);assert.equal(JSON.stringify(status.body).includes('@'),false);
});

test('notification plan is atomic under backlog limits and revocation and uses fewer than 50 prepared queries',async t=>{
  const f=await notificationFixture(t);let prepared=0;
  const DB={prepare(sql){prepared++;return f.db.prepare(sql);},batch:statements=>f.db.batch(statements)};
  const response=await worker.fetch(nativeRequest(f.plan,noticePath),{...f.env,DB});
  assert.equal(response.status,200);assert.ok(prepared<50,`prepared ${prepared} statements`);t.diagnostic(`Notification plan used ${prepared} prepared statements, including its coherent snapshot and atomic batch.`);
  await f.db.prepare("DELETE FROM admin_grants WHERE capability='notifications.manage'").run();
  assert.equal((await f.send(f.plan,noticePath)).status,403);
  await f.db.prepare("INSERT INTO admin_grants VALUES('admin','notifications.manage','wing','*')").run();
  await f.db.prepare('UPDATE notification_delivery_control SET max_ledger_entries=2').run();
  const another=structuredClone(f.plan);another.commandId='weekly-plan';another.source.submissionId='weekly-plan';another.payload.asOf='2026-01-04T22:00:00.000Z';
  assert.equal((await f.send(another,noticePath)).status,409);
  assert.equal(await f.count('notification_intents'),2);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM command_registry WHERE command_id='weekly-plan'").first()).count,0);
});

test('excusal notification planning uses recorded request and current Squadron routing, never caller email fields',async t=>{
  const f=await notificationFixture(t);
  const leader=command('leadership.upsert');leader.payload.profile.role='Blue Squadron Commander';assert.equal((await f.send(leader)).status,200);
  const request={...f.attendance,commandId:'notice-request',source:{...f.attendance.source,submissionId:'notice-request'},operation:'excusal.submit',payload:{requestId:'notice-request',eventId:'event-one',personId:'person-a',requestedOutcome:'E',reason:'Fictional recorded reason.'}};
  assert.equal((await f.send(request,'/v1/commands')).status,200);
  f.plan.payload={kind:'excusal',asOf:'2026-01-01T10:00:00.000Z',requestId:'notice-request'};
  assert.equal((await f.send(f.plan,noticePath)).status,200);
  const notice=await f.db.prepare('SELECT state,to_json,cc_json,reply_to,body FROM notification_intents').first();
  assert.equal(notice.state,'suppressed');assert.deepEqual(JSON.parse(notice.to_json),['cadre@example.invalid']);
  assert.deepEqual(JSON.parse(notice.cc_json),['cadet@example.invalid']);assert.equal(notice.reply_to,'cadet@example.invalid');
  assert.match(notice.body,/Fictional recorded reason/);
});

async function localDeliveryFixture(t,budget=10) {
  const f=await notificationFixture(t);assert.equal((await f.send(f.plan,noticePath)).status,200);
  // Explicit fixture-only activation; no API can change suppression or activate this mode.
  await f.db.batch([
    f.db.prepare("UPDATE notification_delivery_control SET mode='local-test',daily_recipient_budget=?").bind(budget),
    f.db.prepare("UPDATE notification_intents SET mode='local-test',state='queued' WHERE recipient_count>0"),
  ]);
  return f;
}

test('local injected transport sees a persisted attempt before delivery; confirmed and known-no-send outcomes are durable',async t=>{
  const {deliverLocalNotification}=await import('../../.build/v3/apps/worker/src/notifications.js');
  const f=await localDeliveryFixture(t);
  const input={principalId:'admin',workerId:'fake-mail',asOf:'2026-01-01T10:00:00.000Z'};
  let calls=0;
  const transport={send:async message=>{
    calls++;assert.deepEqual(message.to,['cadet@example.invalid']);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM notification_attempts WHERE state='sending'").first()).count,1);
    return calls===1?{outcome:'known-not-sent'}:{outcome:'confirmed',providerReference:'fictional-provider-result'};
  }};
  assert.equal((await deliverLocalNotification(f.env,input,transport)).state,'queued');
  assert.equal((await deliverLocalNotification(f.env,input,transport)).state,'sent');
  assert.equal(await f.count('notification_attempts'),2);assert.equal(calls,2);
  assert.equal((await deliverLocalNotification(f.env,input,transport)).attempted,false);
});

test('ambiguous local delivery is terminal uncertain and staging cannot invoke the injected transport',async t=>{
  const {deliverLocalNotification}=await import('../../.build/v3/apps/worker/src/notifications.js');
  const f=await localDeliveryFixture(t);let calls=0;
  const input={principalId:'admin',workerId:'fake-mail',asOf:'2026-01-01T10:00:00.000Z'};
  const transport={send:async()=>{calls++;throw Error('fictional lost result');}};
  assert.equal((await deliverLocalNotification(f.env,input,transport)).state,'uncertain');
  assert.equal((await deliverLocalNotification(f.env,input,transport)).attempted,false);assert.equal(calls,1);
  await assert.rejects(deliverLocalNotification({...f.env,ENVIRONMENT:'staging'},input,transport),{code:'DELIVERY_SUPPRESSED'});
  assert.equal(calls,1);
});

test('expired local attempts stay uncertain even if a late result claims success, and quota failures do not attempt delivery',async t=>{
  const {deliverLocalNotification,recoverLocalNotificationAttempts}=await import('../../.build/v3/apps/worker/src/notifications.js');
  const f=await localDeliveryFixture(t);
  const input={principalId:'admin',workerId:'fake-mail',asOf:'2026-01-01T10:00:00.000Z'};
  const late=await deliverLocalNotification(f.env,input,{send:async()=>{await recoverLocalNotificationAttempts(f.env,'2026-01-01T10:11:00.000Z');return {outcome:'confirmed'};}});
  assert.equal(late.state,'uncertain');assert.equal((await f.db.prepare('SELECT state FROM notification_attempts').first()).state,'uncertain');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM notification_delivery_events WHERE state='sent'").first()).count,0);
  const g=await localDeliveryFixture(t,0);let calls=0;
  const quota=await deliverLocalNotification(g.env,input,{send:async()=>{calls++;return {outcome:'confirmed'};}});
  assert.equal(quota.reason,'quota-exhausted');assert.equal(calls,0);assert.equal(await g.count('notification_attempts'),0);
  assert.equal((await g.db.prepare("SELECT state FROM notification_intents WHERE mode='local-test'").first()).state,'blocked');
});

test('frontend ACK coalesces both audit streams only through its immutable claim-time watermarks',async t=>{
  const f=await correctionFixture(t);
  assert.equal((await f.send(f.attendance,'/v1/commands')).status,200);
  const claim=(await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect;
  assert.deepEqual(Object.keys(claim).sort(),['claimToken','effectId','kind','leaseExpiresAt']);
  const identity=effect({effectId:claim.effectId,claimToken:claim.claimToken});
  const floor=await f.db.prepare('SELECT claim_operations_revision AS operations,claim_administration_revision AS administration FROM admin_effects WHERE effect_id=?').bind(claim.effectId).first();
  assert.deepEqual(floor,{operations:1,administration:2});
  // This is the exact snapshot a publisher could already have cached before later commands arrive.
  const earlier=await f.send(identity,'/v1/admin/effects/project');assert.equal(earlier.status,200);assert.deepEqual(earlier.body.snapshot.revision,floor);
  const later=command('directory.upsert',{commandId:'later-directory',source:{kind:'test',resourceKey:'admin-console',submissionId:'later-directory',revision:1}});
  later.payload.personId='person-b';later.payload.profile.email='second@example.invalid';assert.equal((await f.send(later)).status,200);
  f.correction.payload.expectedBaseVersion=1;assert.equal((await f.send(f.correction)).status,200);
  // Reprojection can be newer without advancing the persisted floor used for ACK.
  const newer=await f.send(identity,'/v1/admin/effects/project');assert.deepEqual(newer.body.snapshot.revision,{operations:2,administration:3});
  assert.deepEqual(await f.db.prepare('SELECT claim_operations_revision AS operations,claim_administration_revision AS administration FROM admin_effects WHERE effect_id=?').bind(claim.effectId).first(),floor);
  assert.equal((await f.send(identity,'/v1/admin/effects/ack')).status,200);
  const front=(await f.db.prepare("SELECT command_id,state,completed_by_effect_id FROM admin_effects WHERE kind='frontend.refresh' ORDER BY command_id").all()).results;
  for(const row of front) {
    const isLater=['later-directory','correction-one'].includes(row.command_id);
    assert.equal(row.state,isLater?'pending':'done',row.command_id);
    assert.equal(row.completed_by_effect_id,isLater?null:claim.effectId,row.command_id);
  }
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE kind='forms.refresh' AND state='pending'").first()).count,3);
  // Successful ACK is still not blindly replayable; ambiguous-result recovery semantics are unchanged.
  assert.equal((await f.send(identity,'/v1/admin/effects/ack')).status,409);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE kind='frontend.refresh' AND state='pending'").first()).count,2);
  const next=(await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect;
  const nextIdentity=effect({effectId:next.effectId,claimToken:next.claimToken});
  assert.equal((await f.send(nextIdentity,'/v1/admin/effects/project')).status,200);
  assert.equal((await f.send(nextIdentity,'/v1/admin/effects/ack')).status,200);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE kind='frontend.refresh' AND state='pending'").first()).count,0);
});

test('Forms ACK never coalesces another effect; wrong or fenced frontend claims cannot complete pending work',async t=>{
  const f=await correctionFixture(t);
  const form=(await f.send(effect({kind:'forms.refresh'}),'/v1/admin/effects/claim')).body.effect;
  const floor=await f.db.prepare('SELECT claim_operations_revision,claim_administration_revision FROM admin_effects WHERE effect_id=?').bind(form.effectId).first();
  assert.deepEqual(floor,{claim_operations_revision:null,claim_administration_revision:null});
  assert.equal((await f.send(effect({effectId:form.effectId,claimToken:form.claimToken}),'/v1/admin/effects/ack')).status,200);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE kind='forms.refresh' AND state='pending'").first()).count,1);
  const front=(await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect;
  assert.equal((await f.send(effect({effectId:front.effectId,claimToken:'wrong-token'}),'/v1/admin/effects/ack')).status,409);
  await f.db.prepare('UPDATE system_control SET accepting_commands=0').run();
  assert.equal((await f.send(effect({effectId:front.effectId,claimToken:front.claimToken}),'/v1/admin/effects/ack')).status,409);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE kind='frontend.refresh' AND state='done'").first()).count,0);
  assert.equal(await f.count('command_assertions'),0);
});

test('a snapshot behind the immutable claim watermark fails closed without completing effects',async t=>{
  const f=await correctionFixture(t);
  assert.equal((await f.send(f.attendance,'/v1/commands')).status,200);
  const claim=(await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect;
  const DB={prepare:sql=>f.db.prepare(sql),batch:async statements=>{
    const result=await f.db.batch(statements);
    // Simulate a replica/read regression at the snapshot boundary, not a normal D1 outcome.
    result[1].results[0].operations=0;
    return result;
  }};
  const input=effect({effectId:claim.effectId,claimToken:claim.claimToken});
  const response=await worker.fetch(nativeRequest(input,'/v1/admin/effects/project'),{...f.env,DB});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'SNAPSHOT_BEHIND_CLAIM');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE state='done'").first()).count,0);
});

test('coalesced completion rolls back if the claimed effect cannot be completed',async t=>{
  const f=await correctionFixture(t);
  const claim=(await f.send(effect({kind:'frontend.refresh'}),'/v1/admin/effects/claim')).body.effect;
  // Fail the final leased-row update after pending rows would have been coalesced.
  await f.db.prepare("CREATE TRIGGER reject_final_effect BEFORE UPDATE ON admin_effects WHEN OLD.state='leased' AND NEW.state='done' BEGIN SELECT RAISE(ABORT,'fictional-ack-failure'); END").run();
  assert.equal((await f.send(effect({effectId:claim.effectId,claimToken:claim.claimToken}),'/v1/admin/effects/ack')).status,409);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE state='done'").first()).count,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM admin_effects WHERE state='leased'").first()).count,1);
  assert.equal(await f.count('command_assertions'),0);
});

test('accepted excusal versions enqueue one frozen task each; delayed task processing preserves submission and decision separately',async t=>{
  const f=await notificationFixture(t);
  const leader=command('leadership.upsert');leader.payload.profile.role='Blue Squadron Commander';assert.equal((await f.send(leader)).status,200);
  const submitted={...f.attendance,commandId:'frozen-notice-request',source:{...f.attendance.source,submissionId:'frozen-notice-request'},operation:'excusal.submit',payload:{requestId:'frozen-notice-request',eventId:'event-one',personId:'person-a',requestedOutcome:'E',reason:'Fictional original reason.'}};
  assert.equal((await f.send(submitted,'/v1/commands')).status,200);assert.equal((await f.send(submitted,'/v1/commands')).status,200);
  const decision={...submitted,commandId:'frozen-notice-decision',source:{...submitted.source,submissionId:'frozen-notice-decision'},operation:'excusal.decide',payload:{requestId:'frozen-notice-request',expectedVersion:1,decision:'Denied',reason:'Fictional decision reason.'}};
  assert.equal((await f.send(decision,'/v1/commands')).status,200);
  const tasks=(await f.db.prepare('SELECT task_id,request_version,request_json FROM notification_tasks ORDER BY request_version').all()).results;
  assert.equal(tasks.length,2);assert.equal(JSON.parse(tasks[0].request_json).status,'Submitted');assert.equal(JSON.parse(tasks[1].request_json).status,'Denied');
  for(const task of tasks){const input=read({sourceKind:'test',sourceResource:'admin-console',taskId:task.task_id});const result=await f.send(input,'/v1/admin/notifications/process');assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(await f.send(input,'/v1/admin/notifications/process'),result);}
  assert.equal(await f.count('notification_intents'),2);assert.equal(await f.count('notification_attempts'),0);
  const notices=(await f.db.prepare('SELECT kind,state,body FROM notification_intents ORDER BY kind').all()).results;assert.deepEqual(notices.map(n=>n.kind),['excusal-decision','excusal-submitted']);assert.ok(notices.every(n=>n.state==='suppressed'));
  assert.match(notices[1].body,/Status: Submitted/);assert.match(notices[0].body,/Status: Denied/);
});

test('delivery claim/result HTTP protocol retains ambiguous claims and idempotent results without exposing staging mail',async t=>{
  const f=await localDeliveryFixture(t);
  const claimInput=effect({claimId:'durable-mail-claim'});const path='/v1/admin/notifications/delivery/';
  const claim=await f.send(claimInput,path+'claim');assert.equal(claim.status,200,JSON.stringify(claim.body));assert.equal(claim.body.attempted,true);
  assert.deepEqual(await f.send(claimInput,path+'claim'),claim);assert.equal(await f.count('notification_attempts'),1);
  const complete=effect({attemptId:claim.body.attemptId,claimToken:claim.body.claimToken,outcome:'confirmed',providerReference:'fictional-result'});
  const result=await f.send(complete,path+'complete');assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.state,'sent');assert.deepEqual(await f.send(complete,path+'complete'),result);
  assert.equal((await f.send({...complete,outcome:'lost-result'},path+'complete')).status,409);
  assert.equal((await f.send({...complete,workerId:'other-adapter'},path+'complete')).status,403);
  const stage={...claimInput,environment:'staging'};await f.db.prepare("UPDATE system_control SET environment='staging'").run();
  const response=await worker.fetch(nativeRequest(stage,path+'claim'),{...f.env,ENVIRONMENT:'staging'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{attempted:false,deliveryEnabled:false,reason:'staging-suppressed'});assert.equal(await f.count('notification_attempts'),1);
});

test('concurrent notification results return one durable receipt and completion remains possible after a pause',async t=>{
 const f=await localDeliveryFixture(t);const path='/v1/admin/notifications/delivery/';const claim=(await f.send(effect({claimId:'concurrent-mail'}),path+'claim')).body;
 await f.db.prepare('UPDATE system_control SET accepting_commands=0').run();
 const input=effect({attemptId:claim.attemptId,claimToken:claim.claimToken,outcome:'confirmed',providerReference:null});
 const results=await Promise.all([f.send(input,path+'complete'),f.send(input,path+'complete')]);assert.equal(results[0].status,200,JSON.stringify(results));assert.deepEqual(results[0],results[1]);
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM notification_delivery_events WHERE action='confirmed'").first()).n,1);
});

test('verified Directory self-service changes only the linked cadet profile and rechecks revocation',async t=>{
  const f=await fixture(t);assert.equal((await f.send(command())).status,200);
  await f.db.batch([f.db.prepare("INSERT INTO principals VALUES('cadet','person-a',1),('other-cadet',NULL,1)"),f.db.prepare("INSERT INTO adapter_sources VALUES('form','directory-form',1)")]);
  const c={commandId:'self-profile',contractVersion:1,environment:'local',generation:1,actor:{principalId:'cadet',evidence:'google-form'},source:{kind:'form',resourceKey:'directory-form',submissionId:'native-response',revision:1},operation:'directory.selfUpdate',payload:{personId:'person-a',expectedVersion:1,changes:{phone:'555-555-0100',photoLink:'https://drive.google.com/file/d/fictional-photo/view'}}};
  const accepted=await f.send(c);assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.result.version,2);
  const p=await f.db.prepare("SELECT version,rank,role,flight_id,email,phone FROM directory_profiles WHERE person_id='person-a'").first();
  assert.deepEqual(p,{version:2,rank:'C/SSgt',role:'Flight Commander',flight_id:'alpha',email:'cadet@example.invalid',phone:'555-555-0100'});
  assert.deepEqual(await f.send(c),accepted);
  assert.equal((await f.send(null,'/v1/admin/commands/self-profile?principalId=cadet','GET')).status,200);
  const other=structuredClone(c);other.commandId='other-profile';other.actor.principalId='other-cadet';other.source.submissionId='other-response';other.payload.expectedVersion=2;assert.equal((await f.send(other)).status,403);
  for(const changes of [{rank:'C/Col'},{role:'Wing Commander'},{asYear:'AS400'},{flightId:'bravo'},{flightPathStatus:'Active 3/4'},{email:'other@example.invalid'}]){
    const bad=structuredClone(c);bad.payload.changes=changes;assert.throws(()=>parseAdminCommand(bad),{code:'INVALID_COMMAND'});
  }
  await f.db.prepare("UPDATE principals SET person_id=NULL WHERE principal_id='cadet'").run();assert.equal((await f.send(c)).status,403);
  assert.equal((await f.send(null,'/v1/admin/commands/self-profile?principalId=cadet','GET')).status,404);
});

test('Directory self-service freezes the submitted base version and rejects stale or typed identity evidence',async t=>{
  const f=await fixture(t);assert.equal((await f.send(command())).status,200);
  await f.db.batch([f.db.prepare("INSERT INTO principals VALUES('cadet','person-a',1)"),f.db.prepare("INSERT INTO adapter_sources VALUES('form','directory-form',1)")]);
  const base={commandId:'self-1',contractVersion:1,environment:'local',generation:1,actor:{principalId:'cadet',evidence:'google-form'},source:{kind:'form',resourceKey:'directory-form',submissionId:'native-1',revision:1},operation:'directory.selfUpdate',payload:{personId:'person-a',expectedVersion:1,changes:{dorm:'Reviewed Dorm'}}};
  assert.equal((await f.send(base)).status,200);
  const stale=structuredClone(base);stale.commandId='self-2';stale.source.submissionId='native-2';assert.equal((await f.send(stale)).status,409);
  const bad=structuredClone(base);bad.actor.evidence='google-edit';assert.throws(()=>parseAdminCommand(bad),{code:'INVALID_COMMAND'});
  await f.db.prepare("UPDATE adapter_sources SET active=0 WHERE resource_key='directory-form'").run();assert.equal((await f.send(base)).status,403);
});

test('managed Form event versions reject stale first acceptance while committed responses keep their receipt',async t=>{
 const f=await fixture(t);assert.equal((await f.send(command())).status,200);assert.equal((await f.send(command('event.upsert'))).status,200);
 await f.db.batch([f.db.prepare("INSERT INTO access_grants VALUES('admin','attendance.report','alpha','unit')"),f.db.prepare("INSERT INTO adapter_sources VALUES('form','managed-attendance',1)")]);
 const c={commandId:'bound-event',contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'google-form'},source:{kind:'form',resourceKey:'managed-attendance',submissionId:'native-event',revision:1},operation:'attendance.report',payload:{reportId:'bound-report',eventId:'event-one',expectedEventVersion:2,unitId:'alpha',rosterVersion:2,coveredPersonIds:['person-a'],presentPersonIds:['person-a'],completeness:'complete'}};
 assert.equal((await f.send(c,'/v1/commands')).status,409);assert.equal(await f.count('attendance_reports'),0);
 c.payload.expectedEventVersion=1;const accepted=await f.send(c,'/v1/commands');assert.equal(accepted.status,200);
 const changed=revised(command('event.upsert'));changed.payload.label='Updated event';assert.equal((await f.send(changed)).status,200);
 assert.deepEqual(await f.send(c,'/v1/commands'),accepted);
 const newer=structuredClone(c);newer.commandId='new-native';newer.source.submissionId='new-native';newer.payload.reportId='new-report';assert.equal((await f.send(newer,'/v1/commands')).status,409);assert.equal(await f.count('attendance_reports'),1);
});

test('pending Directory review requires current Wing authority even when the private adapter knows the cadet',async t=>{
 const f=await fixture(t),path='/v1/admin/directory/review-authorize';
 assert.deepEqual(await f.send(read(),path),{status:200,body:{authorized:true}});
 assert.equal((await f.send(read({principalId:'flight-admin'}),path)).status,403);
 assert.equal((await f.send(read({principalId:'outsider'}),path)).status,403);
 await f.db.prepare("DELETE FROM admin_grants WHERE principal_id='admin' AND capability='directory.manage'").run();assert.equal((await f.send(read(),path)).status,403);
});

const enrollment=(email='new@example.invalid',revision=1)=>({commandId:`enroll-${revision}`,contractVersion:1,environment:'local',generation:1,actor:{principalId:`google.${createHash('sha256').update(email).digest('hex')}`,evidence:'google-form'},source:{kind:'form',resourceKey:'directory-form',submissionId:'native-new',revision},operation:'directory.enroll',payload:{verifiedEmail:email,flightId:'alpha',profile:{...profile(),email,rank:'C/AB',role:'',flightPathStatus:'Active 3/4'}}});
test('verified Directory enrollment activates once with only self excusal authority and immutable replay',async t=>{
 const f=await fixture(t);await f.db.prepare("INSERT INTO adapter_sources VALUES('form','directory-form',1)").run();const c=enrollment(),first=await f.send(c);assert.equal(first.status,200,JSON.stringify(first.body));const personId=first.body.result.targetId;
 assert.equal(await f.count('people'),1);assert.equal(await f.count('principals'),4);assert.equal(await f.count('directory_profiles'),1);assert.equal((await f.db.prepare('SELECT active FROM memberships WHERE person_id=?').bind(personId).first()).active,1);
 assert.deepEqual((await f.db.prepare('SELECT capability,unit_id,subject_scope FROM access_grants WHERE principal_id=?').bind(c.actor.principalId).all()).results,[{capability:'excusal.submit',unit_id:'alpha',subject_scope:'self'}]);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admin_grants WHERE principal_id=?').bind(c.actor.principalId).first()).n,0);
 assert.deepEqual(await f.send(c),first);assert.equal((await f.send(enrollment('new@example.invalid',2))).status,200);assert.equal(await f.count('people'),1);assert.equal(await f.count('directory_profiles'),1);
 await f.db.prepare('DELETE FROM access_grants WHERE principal_id=?').bind(c.actor.principalId).run();assert.equal((await f.send(enrollment('new@example.invalid',3))).status,200);assert.equal(await f.count('access_grants'),0,'repeat enrollment does not restore a revoked capability');
 await f.db.prepare('UPDATE principals SET active=0 WHERE principal_id=?').bind(c.actor.principalId).run();assert.equal((await f.send(c)).status,403);assert.equal((await f.send(enrollment('new@example.invalid',4))).status,409);
});
test('Directory enrollment links one existing verified email without overwriting its operational profile',async t=>{
 const f=await fixture(t);await f.db.prepare("INSERT INTO adapter_sources VALUES('form','directory-form',1)").run();assert.equal((await f.send(command())).status,200);const c=enrollment('cadet@example.invalid'),r=await f.send(c);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.result.targetId,'person-a');assert.equal(await f.count('people'),1);assert.equal((await f.db.prepare("SELECT rank FROM directory_profiles WHERE person_id='person-a'").first()).rank,'C/SSgt');
 const forged=enrollment('other@example.invalid',2);forged.actor.principalId=c.actor.principalId;assert.equal((await f.send(forged)).status,400);
 const leader=enrollment('leader@example.invalid',3);leader.payload.profile.role='Wing Commander';assert.equal((await f.send(leader)).status,400);
 const unregistered=enrollment('unregistered@example.invalid',4);unregistered.source.resourceKey='other-form';assert.equal((await f.send(unregistered)).status,403);
});
test('enrollment is atomic under duplicate delivery and honors the mutation fence',async t=>{
 const f=await fixture(t);await f.db.prepare("INSERT INTO adapter_sources VALUES('form','directory-form',1)").run();const c=enrollment();const results=await Promise.all([f.send(c),f.send(c)]);assert(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(await f.count('people'),1);assert.equal(await f.count('admin_commands'),1);
 await f.db.prepare('UPDATE system_control SET accepting_commands=0').run();assert.equal((await f.send(enrollment('second@example.invalid',2))).status,403);assert.equal(await f.count('people'),1);
});
