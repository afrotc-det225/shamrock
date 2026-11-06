import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {Miniflare,Log,LogLevel} from 'miniflare';
import worker from '../../.build/v3/apps/worker/src/index.js';
import {splitMigrationSql} from '../../scripts/lib/v3-migrations.mjs';
const secret='fictional-transition-secret-never-for-deployment';
const migrations=new URL('../../database/migrations/',import.meta.url);
const sql=(await Promise.all((await readdir(migrations)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,migrations),'utf8')))).flatMap(splitMigrationSql);
const profile=()=>({lastName:'Example',firstName:'Cadet',asYear:'AS300',rank:'C/2d Lt',role:'Flight Commander',university:'Notre Dame',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:''});
function envelope(operation,payload,id=operation){return {commandId:id,contractVersion:1,environment:'local',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'console',submissionId:id,revision:1},operation,payload};}
function native(input,path){const body=JSON.stringify(input),time=String(Math.floor(Date.now()/1000));return new Request('https://fixture.invalid'+path,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':'fixture','x-shamrock-timestamp':time,'x-shamrock-signature':createHmac('sha256',secret).update(`POST\n${path}\n${time}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')}});}
const identity={environment:'local',generation:1,principalId:'admin'};
const plan=()=>({transitionId:'next-term',kind:'academic-year',sourceTermId:'current',targetTerm:{termId:'next',label:'Next Fall',sortOrder:2},policyVersion:'explicit-term-review-v1',reviewReason:'Reviewed fictional roster and training schedule',people:[{personId:'person',expectedVersion:1,asYear:'AS400',rank:'C/2d Lt',role:'Flight Commander',flightId:'alpha',flightPathStatus:'Active 3/4'}],schedule:{firstSunday:'2026-08-23',firstTrainingWeek:1,weeks:2,mando:{weekday:4,hour:6,minute:30,durationMinutes:60},llab:{weekday:2,hour:15,minute:30,durationMinutes:120}}});
async function fixture(t){
 const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'transition-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await db.batch(sql.map(s=>db.prepare(s)));
 await db.batch([db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),db.prepare("INSERT INTO principals VALUES('admin',NULL,1),('outsider',NULL,1)"),db.prepare("INSERT INTO transition_authorities VALUES('admin',1)"),db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1)"),db.prepare("INSERT INTO squadrons VALUES('blue','Blue')"),db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue')"),db.prepare("INSERT INTO terms VALUES('current','Current Spring',1,1)"),db.prepare("INSERT INTO admin_grants SELECT 'admin',value,'wing','*' FROM json_each('[\"directory.manage\",\"frontend.read\"]')"),db.prepare("INSERT INTO adapter_sources VALUES('test','console',1)")]);
 const env={DB:db,ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:'fixture',BRIDGE_SECRET:secret};
 const send=async(input,path='/v1/admin/transitions/commands',override=env)=>{const response=await worker.fetch(native(input,path),override);return {status:response.status,body:await response.json()};};
 const first=await send(envelope('directory.upsert',{personId:'person',expectedVersion:0,flightId:'alpha',profile:profile()}),'/v1/admin/commands');assert.equal(first.status,200,JSON.stringify(first.body));
 const count=async(table)=>(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
 return {db,env,send,count};
}
async function prepared(f,p=plan()) {const c=envelope('transition.prepare',{plan:p});const result=await f.send(c);assert.equal(result.status,200,JSON.stringify(result.body));return {c,...result.body.result};}
async function archived(f,p){const claim=await f.send({...identity,workerId:'archive-adapter',transitionId:p.transitionId},'/v1/admin/transitions/archive/claim');assert.equal(claim.status,200,JSON.stringify(claim.body));const request={...identity,workerId:'archive-adapter',transitionId:p.transitionId,claimToken:claim.body.claimToken,proof:{snapshotHash:claim.body.snapshotHash,archiveBinding:'term-archive',protected:true,private:true,valuesOnly:true}};const ack=await f.send(request,'/v1/admin/transitions/archive/ack');assert.equal(ack.status,200,JSON.stringify(ack.body));return {claim:claim.body,request};}
function next(operation,p,version=2){return envelope(operation,{transitionId:p.transitionId,expectedVersion:version,planHash:p.planHash});}


test('review, protected archive, acceptance and refresh receipts preserve history and apply advancement exactly once',async t=>{
 const f=await fixture(t), p=await prepared(f);const before=await f.db.prepare('SELECT * FROM directory_profiles').first();
 assert.deepEqual(await f.send(p.c),(await f.send(p.c)));assert.equal(await f.count('term_transitions'),1);
 assert.equal((await f.send(next('transition.accept',p,1))).status,409);
 const archive=await archived(f,p);assert.equal(archive.claim.snapshot.people[0].asYear,'AS300');
 assert.deepEqual(await f.send(archive.request,'/v1/admin/transitions/archive/ack'),{status:200,body:{status:'done'}});
 const accepted=await f.send(next('transition.accept',p));assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.result.state,'publishing');
 assert.equal((await f.db.prepare('SELECT as_year FROM directory_profiles').first()).as_year,'AS400');assert.equal((await f.db.prepare('SELECT as_year FROM term_roster_snapshots WHERE term_id=?').bind('current').first()).as_year,before.as_year);
 assert.equal(await f.count('event_roster_versions'),6);assert.equal(await f.count('event_roster_members'),6);assert.equal(await f.count('transition_people_history'),1);
 assert.deepEqual(await f.send(next('transition.accept',p)),accepted);
 assert.equal((await f.send(next('transition.complete',p,3))).status,409);
 await f.db.prepare("UPDATE admin_effects SET state='done' WHERE command_id='transition.accept' AND kind='frontend.refresh'").run();assert.equal((await f.send(next('transition.complete',p,3))).status,409);
 await f.db.prepare("UPDATE admin_effects SET state='done' WHERE command_id='transition.accept' AND kind='forms.refresh'").run();
 assert.equal((await f.send(next('transition.complete',p,3))).body.result.state,'complete');
 assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);assert.equal(await f.count('command_assertions'),0);
});

test('proposal cancellation and stale reviewed source never alter people or current term',async t=>{
 const f=await fixture(t), p=await prepared(f);assert.equal((await f.send(next('transition.cancel',p,1))).status,200);
 assert.equal((await f.db.prepare('SELECT as_year FROM directory_profiles').first()).as_year,'AS300');assert.equal((await f.db.prepare('SELECT term_id FROM terms WHERE is_current=1').first()).term_id,'current');
 assert.equal((await f.send({...identity,workerId:'adapter',transitionId:p.transitionId},'/v1/admin/transitions/archive/claim')).status,409);
 const g=await fixture(t), q=await prepared(g);await archived(g,q);
 const edit=envelope('directory.upsert',{personId:'person',expectedVersion:1,flightId:'alpha',profile:{...profile(),firstName:'Changed'}},'changed-profile');assert.equal((await g.send(edit,'/v1/admin/commands')).status,200);
 assert.equal((await g.send(next('transition.accept',q))).status,409);assert.equal(await g.count('events'),0);assert.equal((await g.db.prepare('SELECT term_id FROM terms WHERE is_current=1').first()).term_id,'current');
});

test('transition receipt retries and archive operations enforce revocation, generation and verified archive proof',async t=>{
 const f=await fixture(t), p=await prepared(f);const bad=next('transition.accept',p,1);bad.actor.principalId='outsider';assert.equal((await f.send(bad)).status,403);
 const claim=(await f.send({...identity,workerId:'adapter',transitionId:p.transitionId},'/v1/admin/transitions/archive/claim')).body;
 const proof={...identity,workerId:'adapter',transitionId:p.transitionId,claimToken:claim.claimToken,proof:{snapshotHash:claim.snapshotHash,archiveBinding:'archive',protected:false,private:true,valuesOnly:true}};
 assert.equal((await f.send(proof,'/v1/admin/transitions/archive/ack')).status,409);
 await f.db.prepare('UPDATE transition_authorities SET active=0').run();assert.equal((await f.send(p.c)).status,403);
 const {transitionStatus}=await import('../../.build/v3/apps/worker/src/transitions.js');
 await assert.rejects(transitionStatus(f.env,{...identity,transitionId:p.transitionId}),{code:'NOT_AUTHORIZED'});
});

test('acceptance rolls back every event/profile/receipt if any audit insert fails',async t=>{
 const f=await fixture(t), p=await prepared(f);await archived(f,p);
 await f.db.prepare("CREATE TRIGGER reject_transition_event BEFORE INSERT ON admin_audit_events WHEN NEW.operation='transition.event' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
 const result=await f.send(next('transition.accept',p));assert.equal(result.status,409);
 assert.equal(await f.count('events'),0);assert.equal(await f.count('transition_people_history'),0);assert.equal((await f.db.prepare('SELECT version FROM directory_profiles').first()).version,1);
 assert.equal((await f.db.prepare("SELECT state FROM term_transitions").first()).state,'ready');assert.equal(await f.count('command_assertions'),0);
});

test('largest reviewed schedule uses bounded query count and concurrent acceptance keeps one term',async t=>{
 const f=await fixture(t),proposal=plan();proposal.schedule.weeks=20;
 const p=await prepared(f,proposal);await archived(f,p);let preparedQueries=0;
 const DB={prepare(sql){preparedQueries++;return f.db.prepare(sql);},batch:statements=>f.db.batch(statements)};
 const input=next('transition.accept',p);const first=await f.send(input,undefined,{...f.env,DB});assert.equal(first.status,200,JSON.stringify(first.body));assert.ok(preparedQueries<50,`prepared ${preparedQueries}`);
 assert.equal(await f.count('events'),60);assert.equal(await f.count('event_roster_versions'),60);t.diagnostic(`Maximum schedule acceptance uses ${preparedQueries} prepared statements.`);
 const g=await fixture(t),q=await prepared(g);await archived(g,q);const c=next('transition.accept',q);
 const results=await Promise.all([g.send(c),g.send(c)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].status,200);assert.equal(await g.count('transition_people_history'),1);
});
