import assert from 'node:assert/strict';import test from 'node:test';import {createHash,createHmac} from 'node:crypto';import {readFile,readdir} from 'node:fs/promises';import {resolve} from 'node:path';import {Miniflare,Log,LogLevel} from 'miniflare';
import worker from '../../.build/v3/apps/worker/src/index.js';import {prepareCloseout,advanceCloseout} from '../../.build/v3/apps/worker/src/closeout.js';
import {CLOSEOUT_POLICY,closeoutCode,closeoutWindow} from '../../.build/v3/packages/domain/src/closeout.js';import {noticeLocalClock} from '../../.build/v3/packages/domain/src/notifications.js';
import {splitMigrationSql} from '../../scripts/lib/v3-migrations.mjs';
const secret='fictional-closeout-signing-material-only',identity={environment:'local',generation:1,principalId:'admin',sourceKind:'test',sourceResource:'console',policyVersion:CLOSEOUT_POLICY.version};
const dir=new URL('../../database/migrations/',import.meta.url),sql=(await Promise.all((await readdir(dir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,dir),'utf8')))).flatMap(splitMigrationSql);
const profile=i=>({lastName:'Example',firstName:'Cadet '+i,asYear:'AS100',rank:'C/4C',role:'',university:'Notre Dame',email:`cadet${i}@example.invalid`,phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:''});
const envelope=(operation,payload,id)=>({commandId:id,contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'console',submissionId:id,revision:1},operation,payload});
function timeWindow(){const clock=noticeLocalClock(new Date().toISOString()),day=new Date(clock.date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-clock.weekday-(clock.weekday===0&&clock.hour<17?7:0));const date=day.toISOString().slice(0,10),asOf=[4,5].map(offset=>new Date(Date.parse(date+'T17:00:00Z')+offset*3600000).toISOString()).find(v=>noticeLocalClock(v).hour===17);return {asOf,eventAt:closeoutWindow(asOf).start+'T16:00:00.000Z'};}
async function fixture(t,n=8){
 const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'closeout-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.batch(sql.map(s=>db.prepare(s)));
 await db.batch([db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),db.prepare("INSERT INTO principals VALUES('admin',NULL,1)"),db.prepare("INSERT INTO closeout_authorities VALUES('admin',1)"),db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1)"),db.prepare("INSERT INTO squadrons VALUES('blue','Blue')"),db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue')"),db.prepare("INSERT INTO terms VALUES('current','Current term',1,1)"),db.prepare("INSERT INTO admin_grants SELECT 'admin',value,'wing','*' FROM json_each('[\"directory.manage\",\"leadership.manage\",\"events.manage\",\"attendance.correct\",\"frontend.read\",\"notifications.manage\"]')"),db.prepare("INSERT INTO adapter_sources VALUES('test','console',1)"),db.prepare("INSERT INTO access_grants VALUES('admin','attendance.report','alpha','unit'),('admin','excusal.submit','alpha','unit'),('admin','excusal.decide','alpha','unit')")]);
 const env={DB:db,ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:'fixture',BRIDGE_SECRET:secret};
 async function send(input,path='/v1/admin/commands',override=env){const body=JSON.stringify(input),time=String(Math.floor(Date.now()/1000));const request=new Request('https://fixture.invalid'+path,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':'fixture','x-shamrock-timestamp':time,'x-shamrock-signature':createHmac('sha256',secret).update(`POST\n${path}\n${time}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')}});const response=await worker.fetch(request,override);return {status:response.status,body:await response.json()};}
 const people=Array.from({length:n},(_,i)=>'person-'+String(i).padStart(3,'0'));
 for(const [i,personId]of people.entries()){const result=await send(envelope('directory.upsert',{personId,expectedVersion:0,flightId:'alpha',profile:profile(i)},'directory-'+i));assert.equal(result.status,200,JSON.stringify(result.body));}
 const {asOf,eventAt}=timeWindow();const event={eventId:'event',expectedVersion:0,termId:'current',eventType:'llab',trainingWeek:1,displayOrder:1,label:'Fictional LLAB',columnLabel:'LLAB',expectedGroup:'All Cadets',flightIds:['alpha'],eligiblePersonIds:people,status:'active',startAt:eventAt,endAt:eventAt,location:'Fictional',notes:''};
 assert.equal((await send(envelope('event.upsert',event,'event-create'))).status,200);
 const leader={contactId:'commander',expectedVersion:0,personId:null,profile:{lastName:'Example',firstName:'Commander',rank:'C/Capt',role:'Alpha Flight Commander',email:'commander@example.invalid',cellPhone:''},reportsTo:'',officePhone:'',officeLocation:'',active:true};assert.equal((await send(envelope('leadership.upsert',leader,'commander-create'))).status,200);
 let sequence=0;const snapshot=async()=>{const result=await send({environment:'local',generation:1,principalId:'admin'},'/v1/admin/snapshot');assert.equal(result.status,200);return result.body;};
 async function correct(personId,code){const view=await snapshot(),base=view.attendanceVersions.find(v=>v.personId===personId&&v.eventId==='event')?.version??0;const result=await send(envelope('attendance.correct',{personId,eventId:'event',expectedBaseVersion:base,expectedEventVersion:1,code,reason:'Fictional correction'},'correction-'+sequence++));assert.equal(result.status,200,JSON.stringify(result.body));return result;}
 const prepare=()=>send({...identity,asOf},'/v1/admin/closeout/prepare');const advance=(run,override=env)=>send({...identity,closeoutId:run.closeoutId,expectedVersion:run.version},'/v1/admin/closeout/advance',override);
 const count=async table=>(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
 return {db,env,send,people,asOf,event,correct,prepare,advance,count,snapshot};
}
test('versioned Sunday policy preserves presence/pending/approved outcomes and recognizes native legacy D',()=>{
 const cell={eligible:true,needsReview:false,effectiveCode:null};assert.equal(closeoutCode({cell,latestAttendanceOrder:0,requests:[]}), 'A');
 for(const code of ['P','T','R','E','ES','MED','N/A','U'])assert.equal(closeoutCode({cell:{...cell,effectiveCode:code},latestAttendanceOrder:0,requests:[{status:'Denied',order:9}]}),null,code);
 assert.equal(closeoutCode({cell:{...cell,effectiveCode:'D'},latestAttendanceOrder:0,requests:[]}), 'U');
 assert.equal(closeoutCode({cell,latestAttendanceOrder:3,requests:[{status:'Denied',order:4}]}), 'U');
 assert.equal(closeoutCode({cell,latestAttendanceOrder:5,requests:[{status:'Denied',order:4}]}), 'A');
 assert.deepEqual(closeoutWindow('2026-11-01T22:00:00.000Z'),{start:'2026-10-25',end:'2026-11-01'});
 assert.throws(()=>closeoutWindow('2026-11-01T21:00:00.000Z'));
});
test('missing Flight reports still finalize blanks and denials once, preserve other codes, and create suppressed routed notices',async t=>{
 const f=await fixture(t);for(const [i,code]of [[1,'D'],[2,'P'],[3,'T'],[4,'R'],[5,'E'],[6,'A']])await f.correct(f.people[i],code);
 const submit=envelope('excusal.submit',{requestId:'request',eventId:'event',personId:f.people[7],requestedOutcome:'E',reason:'Fictional reason'},'submit');assert.equal((await f.send(submit,'/v1/commands')).status,200);
 assert.equal((await f.send(envelope('excusal.decide',{requestId:'request',expectedVersion:1,decision:'Denied',reason:'Fictional denial'},'deny'),'/v1/commands')).status,200);
 const prepared=await f.prepare();assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(await f.count('attendance_reports'),0);
 const first=await f.advance(prepared.body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.changed,3);assert.equal(first.body.state,'notifying');
 assert.deepEqual(await f.advance(prepared.body),first);const done=await f.advance(first.body);assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.state,'complete');
 const rows=(await f.db.prepare("SELECT person_id,code FROM attendance_corrections WHERE reason=? ORDER BY person_id").bind(CLOSEOUT_POLICY.version).all()).results;assert.deepEqual(rows.map(r=>[r.person_id,r.code]),[[f.people[0],'A'],[f.people[1],'U'],[f.people[7],'U']]);
 const notice=await f.db.prepare('SELECT * FROM notification_intents').first();assert.equal(notice.state,'suppressed');assert.deepEqual(JSON.parse(notice.to_json),['commander@example.invalid']);assert.match(notice.body,/1 current records remain pending/);assert.equal(await f.count('notification_attempts'),0);
 assert.deepEqual(await f.advance(first.body),done);assert.equal(await f.count('notification_intents'),1);assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 await f.db.prepare('UPDATE closeout_authorities SET active=0').run();assert.equal((await f.advance(first.body)).status,403);assert.equal((await f.prepare()).status,403);
});
test('bounded resume reloads attendance and preserves a report/correction arriving between chunks',async t=>{
 const f=await fixture(t,55),prepared=await f.prepare();assert.equal(prepared.status,200,JSON.stringify(prepared.body));let queries=0;
 const DB={prepare(sql){queries++;return f.db.prepare(sql);},batch:rows=>f.db.batch(rows)};
 const one=await f.advance(prepared.body,{...f.env,DB});assert.equal(one.status,200,JSON.stringify(one.body));assert.equal(one.body.processed,50);assert.equal(one.body.state,'processing');assert.ok(queries<50,`prepared ${queries}`);t.diagnostic(`50-cell closeout uses ${queries} prepared statements.`);
 await f.correct(f.people[54],'P');const two=await f.advance(one.body);assert.equal(two.status,200,JSON.stringify(two.body));assert.equal(two.body.changed,4);
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attendance_corrections WHERE reason=?").bind(CLOSEOUT_POLICY.version).first()).n,54);
 const done=await f.advance(two.body);assert.equal(done.status,200);assert.equal(done.body.state,'complete');
});
test('automatic closeout and final summary keep the event Flight after a later Directory transfer',async t=>{
 const f=await fixture(t,1);
 await f.db.batch([f.db.prepare("INSERT INTO organizational_units VALUES('bravo','Bravo',1)"),f.db.prepare("INSERT INTO flight_hierarchy VALUES('bravo','blue')")]);
 const transfer=envelope('directory.upsert',{personId:f.people[0],expectedVersion:1,flightId:'bravo',profile:profile(0)},'transfer-after-event');assert.equal((await f.send(transfer)).status,200);
 const prepared=await f.prepare();assert.equal(prepared.status,200,JSON.stringify(prepared.body));
 assert.equal((await f.db.prepare('SELECT flight_id FROM closeout_items').first()).flight_id,'alpha');
 const step=await f.advance(prepared.body);assert.equal(step.status,200);assert.equal(step.body.changed,1);
 const done=await f.advance(step.body);assert.equal(done.status,200);assert.equal(done.body.state,'complete');
 const notice=await f.db.prepare('SELECT scope_id,to_json,body FROM notification_intents').first();assert.equal(notice.scope_id,'alpha');assert.deepEqual(JSON.parse(notice.to_json),['commander@example.invalid']);assert.match(notice.body,/Example, Cadet 0/);
 assert.equal((await f.db.prepare('SELECT code FROM attendance_corrections').first()).code,'A');
});
test('concurrent late presence invalidates the whole step and retry uses current effective attendance',async t=>{
 const f=await fixture(t,2),p=await f.prepare();let batches=0;
 const DB={prepare:sql=>f.db.prepare(sql),batch:async rows=>{batches++;if(batches===2)await f.correct(f.people[0],'P');return f.db.batch(rows);}};
 assert.equal((await f.advance(p.body,{...f.env,DB})).status,409);assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attendance_corrections WHERE reason=?").bind(CLOSEOUT_POLICY.version).first()).n,0);
 const retry=await f.advance(p.body);assert.equal(retry.status,200);assert.equal(retry.body.changed,1);
});
test('audit failure rolls back all closeout facts, progress, receipts and effects; forged delivery and early windows fail',async t=>{
 const f=await fixture(t,2),p=await f.prepare(),before=await f.count('admin_effects');
 await f.db.prepare("CREATE TRIGGER fail_closeout BEFORE INSERT ON audit_events WHEN NEW.operation='attendance.closeout' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
 assert.equal((await f.advance(p.body)).status,409);assert.equal(await f.count('attendance_corrections'),0);assert.equal(await f.count('closeout_steps'),0);assert.equal(await f.count('admin_effects'),before);assert.equal(await f.count('command_assertions'),0);
 assert.equal((await f.send({...identity,asOf:f.asOf,delivery:'live'},'/v1/admin/closeout/prepare')).status,400);
 await assert.rejects(prepareCloseout(f.env,{...identity,asOf:f.asOf},()=>new Date(Date.parse(f.asOf)-1)),{code:'INVALID_CLOSEOUT'});
});

test('observed P survives closeout and concurrent identical step deliveries produce one causal correction',async t=>{
 const f=await fixture(t,2);const roster=(await f.db.prepare("SELECT roster_version FROM organizational_units WHERE unit_id='alpha'").first()).roster_version;
 const attendance=envelope('attendance.report',{reportId:'actual-presence',eventId:'event',unitId:'alpha',rosterVersion:roster,coveredPersonIds:f.people,presentPersonIds:[f.people[0]],completeness:'complete'},'actual-presence');assert.equal((await f.send(attendance,'/v1/commands')).status,200);
 const p=await f.prepare(),results=await Promise.all([f.advance(p.body),f.advance(p.body)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].status,200,JSON.stringify(results[0].body));assert.equal(results[0].body.changed,1);
 assert.equal(await f.count('attendance_observations'),1);assert.equal((await f.db.prepare("SELECT observed_code FROM attendance_current WHERE person_id=?").bind(f.people[0]).first()).observed_code,'P');
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attendance_corrections WHERE person_id=?").bind(f.people[0]).first()).n,0);
});
test('a changed event roster is retained as review and notification ledger exhaustion never marks the run complete',async t=>{
 const f=await fixture(t,2),p=await f.prepare();const edited={...f.event,expectedVersion:1,label:'Reviewed changed event'};assert.equal((await f.send(envelope('event.upsert',edited,'changed-event'))).status,200);
 const first=await f.advance(p.body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.changed,0);assert.equal(first.body.state,'notifying');
 const done=await f.advance(first.body);assert.equal(done.body.state,'needs-review');assert.equal(await f.count('attendance_corrections'),0);
 const g=await fixture(t,1),q=await g.prepare(),chunk=await g.advance(q.body);await g.db.prepare('UPDATE notification_delivery_control SET max_ledger_entries=1').run();
 // Fill the ledger with an unrelated, permanently suppressed fixture intent.
 await g.db.prepare("INSERT INTO notification_intents SELECT 'occupied','occupied','fixture','weekly-review','alpha','2000-01-01','local',1,'staging','suppressed',NULL,'[]','[]',NULL,'Fixture','Fixture','hash','{}',0,prepared_command_id,created_at,created_at FROM attendance_closeouts").run();
 assert.equal((await g.advance(chunk.body)).status,409);assert.equal((await g.db.prepare('SELECT state FROM attendance_closeouts').first()).state,'notifying');assert.equal(await g.count('notification_attempts'),0);
});

test('preserved import baselines P/T/R remain unchanged, D becomes U, and an explicit later clear masks P',async t=>{
 const f=await fixture(t,5),insert=(table,row)=>f.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row));
 await f.db.batch([
 insert('legacy_import_runs',{import_run_id:'import-fixture',snapshot_sha256:'0'.repeat(64),plan_sha256:'1'.repeat(64),reconciliation_sha256:'2'.repeat(64),review_reference:'fictional-review',environment:'staging',generation:1,state:'complete',expected_occurrences:1,expected_profiles:5,expected_events:1,expected_baselines:5,expected_batches:1,manifest_json:'{}',started_at:'2026-01-01T00:00:00.000Z',completed_at:'2026-01-01T00:00:00.000Z'}),
 insert('legacy_source_occurrences',{import_run_id:'import-fixture',occurrence_id:'matrix-row',fingerprint:'3'.repeat(64),source_kind:'matrix',disposition:'evidence-only',locator_json:'{}',raw_json:'[]',normalized_json:null,diagnostics_json:'{}'}),
 ...['P','T','D','R','P'].map((code,i)=>insert('legacy_attendance_baselines',{baseline_id:'baseline-'+i,person_id:f.people[i],event_id:'event',code,import_run_id:'import-fixture',source_occurrence_id:'matrix-row',source_column_index:i}))]);
 await f.correct(f.people[4],null);const original=(await f.db.prepare('SELECT * FROM legacy_attendance_baselines ORDER BY baseline_id').all()).results;
 const p=await f.prepare(),step=await f.advance(p.body);assert.equal(step.status,200,JSON.stringify(step.body));assert.equal(step.body.changed,2);
 const codes=(await f.db.prepare('SELECT person_id,code FROM attendance_corrections WHERE reason=? ORDER BY person_id').bind(CLOSEOUT_POLICY.version).all()).results;
 assert.deepEqual(codes,[{person_id:f.people[2],code:'U'},{person_id:f.people[4],code:'A'}]);
 assert.deepEqual((await f.db.prepare('SELECT * FROM legacy_attendance_baselines ORDER BY baseline_id').all()).results,original);assert.equal(await f.count('attendance_observations'),0);
 const done=await f.advance(step.body);assert.equal(done.body.state,'complete');assert.equal(await f.count('notification_attempts'),0);
});

const {readCloseoutPreparationContext,readCloseoutStepContext}=await import('../../.build/v3/apps/worker/src/reporting-context.js');
test('closeout preparation omits facts and each step reads only its exact subject scope',async t=>{
 const f=await fixture(t,55);await f.correct(f.people[0],'P');await f.correct(f.people[54],'T');
 const prep=await readCloseoutPreparationContext(f.env,'admin',f.asOf);assert.equal(prep.corrections.length,0);assert.equal(prep.requests.length,0);assert.equal(prep.legacyBaselines.length,0);
 const p=await f.prepare();assert.equal(p.status,200);const items=(await f.db.prepare("SELECT event_id,person_id FROM closeout_items WHERE closeout_id=? ORDER BY event_id,person_id LIMIT 50").bind(p.body.closeoutId).all()).results;
 const scope=await readCloseoutStepContext(f.env,'admin',p.body.closeoutId,items);assert.equal(scope.people.length,50);assert.equal(scope.corrections.length,1);assert.equal(scope.corrections[0].personId,f.people[0]);assert.equal(scope.events[0].eligiblePersonIds.length,50);
 const final=await readCloseoutStepContext(f.env,'admin',p.body.closeoutId,[]);assert.equal(final.people.length,55);assert.equal(final.corrections.length,2);
});

const {revalidateNotificationIntent,deliverLocalNotification,messageHash}=await import('../../.build/v3/apps/worker/src/notifications.js');
const {ownerMailRehearsal}=await import('../../.build/v3/apps/worker/src/mail-rehearsal.js');
async function completeFixtureCloseout(f){let r=await f.prepare();assert.equal(r.status,200);while(!['complete','needs-review'].includes(r.body.state)){r=await f.advance(r.body);assert.equal(r.status,200,JSON.stringify(r.body));}return r.body;}
test('terminal closeout recipes revalidate exact scoped content and use the normal local claim/result protocol',async t=>{
 const f=await fixture(t,2);await completeFixtureCloseout(f);const notice=await f.db.prepare('SELECT * FROM notification_intents').first();
 const result=await revalidateNotificationIntent(f.env,'admin',JSON.parse(notice.recipe_json),notice.notice_key);
 assert.equal(await messageHash(result.intent),notice.payload_hash);assert.equal(result.asOf,f.asOf);assert.equal(result.snapshot.events.length,1);assert.equal(result.intent.body,notice.body);
 await f.db.batch([f.db.prepare("UPDATE notification_delivery_control SET mode='local-test',daily_recipient_budget=10"),f.db.prepare("UPDATE notification_intents SET mode='local-test',state='queued'")]);
 let sends=0;const receipt=await deliverLocalNotification(f.env,{principalId:'admin',workerId:'closeout-mail',asOf:f.asOf},{async send(message){sends++;assert.equal(message.body,notice.body);assert.deepEqual(message.to,['commander@example.invalid']);return{outcome:'confirmed'};}});
 assert.equal(receipt.state,'sent');assert.equal(sends,1);assert.equal((await deliverLocalNotification(f.env,{principalId:'admin',workerId:'closeout-mail',asOf:f.asOf},{async send(){assert.fail('duplicate closeout send');}})).attempted,false);
});
test('closeout owner rehearsal preserves the suppressed ledger and rechecks current routing',async t=>{
 const f=await fixture(t,2);await completeFixtureCloseout(f);
 // Fixture-only conversion models a staging run; no operational activation endpoint exists.
 await f.db.batch([f.db.prepare("UPDATE system_control SET environment='staging'"),f.db.prepare("UPDATE attendance_closeouts SET environment='staging'"),f.db.prepare("UPDATE notification_intents SET environment='staging',created_at=?").bind(f.asOf)]);
 const env={...f.env,ENVIRONMENT:'staging',OWNER_MAIL_REHEARSAL_ENABLED:'true',OWNER_MAIL_REHEARSAL_EMAIL:'owner@example.invalid',OWNER_MAIL_REHEARSAL_PRINCIPAL:'admin'},base={environment:'staging',generation:1,principalId:'admin'},at=new Date(Date.parse(f.asOf)+1000).toISOString();
 const before=(await f.db.prepare('SELECT * FROM notification_intents').all()).results,notice=before[0];
 const prepared=await ownerMailRehearsal(env,'prepare',{...base,caseId:'closeout-case',noticeId:notice.notice_id,payloadHash:notice.payload_hash},at);
 await f.db.batch([f.db.prepare(`INSERT INTO event_roster_policies VALUES('event',1,'current-active-flight-v1',1,'["alpha"]','event-create','admin','2026-01-01T00:00:00.000Z',NULL)`),f.db.prepare("INSERT INTO event_roster_refresh_work VALUES('event','event-create','2026-01-01T00:00:00.000Z')")]);
 await assert.rejects(ownerMailRehearsal(env,'claim',{...base,caseId:'closeout-case',claimId:'closeout-claim',workerId:'native',reviewHash:prepared.reviewHash},at),{code:'EVENT_ROSTERS_PENDING'});assert.equal(await f.count('owner_mail_attempts'),0);
 await f.db.prepare('DELETE FROM event_roster_refresh_work').run();
 const claim=await ownerMailRehearsal(env,'claim',{...base,caseId:'closeout-case',claimId:'closeout-claim',workerId:'native',reviewHash:prepared.reviewHash},at);
 assert.deepEqual(claim.message.to,['owner@example.invalid']);assert.match(claim.message.body,/Sunday attendance closeout/);assert.deepEqual((await f.db.prepare('SELECT * FROM notification_intents').all()).results,before);
 const g=await fixture(t,1);await completeFixtureCloseout(g);const original=await g.db.prepare('SELECT * FROM notification_intents').first();await g.db.prepare("UPDATE leadership_contacts SET email='changed@example.invalid',version=version+1 WHERE contact_id='commander'").run();
 const changed=await revalidateNotificationIntent(g.env,'admin',JSON.parse(original.recipe_json),original.notice_key);assert.notEqual(await messageHash(changed.intent),original.payload_hash);
});
test('incomplete, old-generation, changed-term and revoked-reader closeout recipes cannot revalidate',async t=>{
 const f=await fixture(t,1),prepared=await f.prepare(),recipe={kind:'closeout',closeoutId:prepared.body.closeoutId,policyVersion:CLOSEOUT_POLICY.version};
 await assert.rejects(revalidateNotificationIntent(f.env,'admin',recipe,'fixture'),{code:'CLOSEOUT_NOTICE_UNAVAILABLE'});
 let next=await f.advance(prepared.body);next=await f.advance(next.body);assert.equal(next.body.state,'complete');const notice=await f.db.prepare('SELECT * FROM notification_intents').first();
 await assert.rejects(revalidateNotificationIntent(f.env,'admin',{...recipe,policyVersion:'unknown'},notice.notice_key),{code:'INVALID_CLOSEOUT'});
 await assert.rejects(revalidateNotificationIntent({...f.env,GENERATION:'2'},'admin',recipe,notice.notice_key),{code:'CLOSEOUT_NOTICE_UNAVAILABLE'});
 await f.db.prepare("DELETE FROM admin_grants WHERE capability='frontend.read'").run();await assert.rejects(revalidateNotificationIntent(f.env,'admin',recipe,notice.notice_key),{code:'NOT_AUTHORIZED'});
 await f.db.batch([f.db.prepare("INSERT INTO admin_grants VALUES('admin','frontend.read','wing','*')"),f.db.prepare('UPDATE terms SET is_current=0'),f.db.prepare("INSERT INTO terms VALUES('next','Next',2,1)")]);
 await assert.rejects(revalidateNotificationIntent(f.env,'admin',recipe,notice.notice_key),{code:'CLOSEOUT_TERM'});
});

test('pending event roster work blocks scoped closeout preparation and later processing without partial facts',async t=>{
 const f=await fixture(t,1);await f.db.batch([f.db.prepare(`INSERT INTO event_roster_policies VALUES('event',1,'current-active-flight-v1',1,'["alpha"]','event-create','admin','2026-01-01T00:00:00.000Z',NULL)`),f.db.prepare("INSERT INTO event_roster_refresh_work VALUES('event','event-create','2026-01-01T00:00:00.000Z')")]);
 assert.equal((await f.prepare()).body.error.code,'EVENT_ROSTERS_PENDING');assert.equal(await f.count('attendance_closeouts'),0);
 await f.db.prepare('DELETE FROM event_roster_refresh_work').run();const prepared=await f.prepare();assert.equal(prepared.status,200);
 await f.db.prepare("INSERT INTO event_roster_refresh_work VALUES('event','event-create','2026-01-01T00:00:00.000Z')").run();assert.equal((await f.advance(prepared.body)).body.error.code,'EVENT_ROSTERS_PENDING');assert.equal(await f.count('attendance_corrections'),0);assert.equal(await f.count('closeout_steps'),0);
});
