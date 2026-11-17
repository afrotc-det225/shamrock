import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {resolve} from 'node:path';import {createHash,createHmac} from 'node:crypto';import {Miniflare,Log,LogLevel} from 'miniflare';
import worker from '../../.build/v3/apps/worker/src/index.js';import {ownerMailRehearsal} from '../../.build/v3/apps/worker/src/mail-rehearsal.js';import {splitMigrationSql} from '../../scripts/lib/v3-migrations.mjs';
const secret='fictional-owner-mail-signing-material-only',owner='automation@example.invalid',base={environment:'staging',generation:1,principalId:'admin'},dir=new URL('../../database/migrations/',import.meta.url);
const statements=(await Promise.all((await readdir(dir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>readFile(new URL(n,dir),'utf8')))).flatMap(splitMigrationSql);
const profile={lastName:'Example',firstName:'Cadet',asYear:'AS100',rank:'C/4C',role:'',university:'Notre Dame',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:''};
async function fixture(t){
 const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'owner-mail-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');await DB.batch(statements.map(s=>DB.prepare(s)));
 await DB.batch([DB.prepare("INSERT INTO system_control VALUES(1,'staging',1,1)"),DB.prepare("INSERT INTO principals VALUES('admin',NULL,1),('outsider',NULL,1)"),DB.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1)"),DB.prepare("INSERT INTO squadrons VALUES('blue','Blue')"),DB.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue')"),DB.prepare("INSERT INTO terms VALUES('current','Current term',1,1)"),DB.prepare("INSERT INTO admin_grants SELECT 'admin',value,'wing','*' FROM json_each('[\"directory.manage\",\"leadership.manage\",\"events.manage\",\"frontend.read\",\"notifications.manage\"]')"),DB.prepare("INSERT INTO adapter_sources VALUES('test','console',1)"),DB.prepare("INSERT INTO access_grants VALUES('admin','excusal.submit','alpha','unit')")]);
 const env={DB,ENVIRONMENT:'staging',GENERATION:'1',BRIDGE_KEY_ID:'fixture',BRIDGE_SECRET:secret,OWNER_MAIL_REHEARSAL_ENABLED:'true',OWNER_MAIL_REHEARSAL_EMAIL:owner,OWNER_MAIL_REHEARSAL_PRINCIPAL:'admin'};
 const send=async(input,path='/v1/admin/commands',override=env)=>{const body=JSON.stringify(input),time=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(`POST\n${path}\n${time}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');const res=await worker.fetch(new Request('https://fixture.invalid'+path,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':'fixture','x-shamrock-timestamp':time,'x-shamrock-signature':signature}}),override);return{status:res.status,body:await res.json()};};
 const envelope=(operation,payload,id)=>({commandId:id,contractVersion:1,environment:'staging',generation:1,actor:{principalId:'admin',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'console',submissionId:id,revision:1},operation,payload});
 const setup=[envelope('directory.upsert',{personId:'cadet',expectedVersion:0,flightId:'alpha',profile},'profile'),envelope('leadership.upsert',{contactId:'commander',expectedVersion:0,personId:null,profile:{lastName:'Example',firstName:'Commander',rank:'Capt',role:'Blue Squadron Commander',email:'commander@example.invalid',cellPhone:''},reportsTo:'',officePhone:'',officeLocation:'',active:true},'leader'),envelope('event.upsert',{eventId:'event',expectedVersion:0,termId:'current',eventType:'llab',trainingWeek:1,displayOrder:1,label:'LLAB',columnLabel:'LLAB',expectedGroup:'All Cadets',flightIds:['alpha'],eligiblePersonIds:['cadet'],status:'active',startAt:'2026-01-01T12:00:00.000Z',endAt:'2026-01-01T13:00:00.000Z',location:'Fictional field',notes:''},'event')];
 for(const c of setup){const r=await send(c);assert.equal(r.status,200,JSON.stringify(r.body));}
 const now=new Date().toISOString();
 async function notice(n){const request='request-'+n;let r=await send(envelope('excusal.submit',{requestId:request,eventId:'event',personId:'cadet',requestedOutcome:'E',reason:'Fictional reason '+n},request),'/v1/commands');assert.equal(r.status,200,JSON.stringify(r.body));r=await send(envelope('notifications.plan',{kind:'excusal',asOf:now,requestId:request},'plan-'+n),'/v1/admin/notifications/plan');assert.equal(r.status,200,JSON.stringify(r.body));return DB.prepare('SELECT * FROM notification_intents WHERE origin_command_id=?').bind('plan-'+n).first();}
 const first=await notice(1),call=(action,extra={},override=env,at=now)=>ownerMailRehearsal(override,action,{...base,...extra},at);
 const prepare=(n=1,source=first)=>call('prepare',{caseId:'case-'+n,noticeId:source.notice_id,payloadHash:source.payload_hash});
 const claim=(review,n=1)=>call('claim',{caseId:'case-'+n,claimId:'claim-'+n,workerId:'native',reviewHash:review.reviewHash});
 const complete=(attempt,outcome,at=now)=>call('complete',{attemptId:attempt.attemptId,claimToken:attempt.claimToken,workerId:'native',outcome},env,at);
 return{DB,env,now,send,notice,first,call,prepare,claim,complete};
}
test('owner rehearsal substitutes only trusted owner routing and leaves suppressed operational evidence byte-identical',async t=>{
 const f=await fixture(t),before=(await f.DB.prepare('SELECT * FROM notification_intents').all()).results,review=await f.prepare();assert.deepEqual(await f.prepare(),review);
 const claim=await f.claim(review);assert.deepEqual(claim.message.to,[owner]);assert.deepEqual(claim.message.cc,[]);assert.equal(claim.message.replyTo,undefined);assert.match(claim.message.subject,/^\[STAGING REHEARSAL\]/);assert.deepEqual(await f.claim(review),claim);
 const receipt=await f.complete(claim,'confirmed');assert.equal(receipt.state,'sent');assert.deepEqual(await f.complete(claim,'confirmed'),receipt);assert.equal((await f.claim(review)).state,'sent');
 assert.deepEqual((await f.DB.prepare('SELECT * FROM notification_intents').all()).results,before);assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM notification_attempts').first()).n,0);assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM owner_mail_attempts').first()).n,1);assert.deepEqual((await f.DB.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
test('disabled gate, caller-supplied routing, different principal and stale/rerouted source cannot claim a send',async t=>{
 const f=await fixture(t);await assert.rejects(f.call('status',{caseId:'case-one'},{...f.env,OWNER_MAIL_REHEARSAL_ENABLED:'false'}),{code:'OWNER_REHEARSAL_DISABLED'});
 const forged=await f.send({...base,caseId:'case-one',noticeId:f.first.notice_id,payloadHash:f.first.payload_hash,to:[owner]},'/v1/admin/notifications/rehearsal/prepare');assert.equal(forged.status,400);
 await assert.rejects(f.call('status',{caseId:'case-one',principalId:'outsider'}),{code:'NOT_AUTHORIZED'});
 const review=await f.prepare();await f.DB.prepare("UPDATE leadership_contacts SET email='changed@example.invalid',version=version+1 WHERE contact_id='commander'").run();await assert.rejects(f.claim(review),{code:'REHEARSAL_SOURCE_CHANGED'});
 await f.DB.prepare("UPDATE notification_intents SET created_at='2000-01-01T00:00:00.000Z'").run();await assert.rejects(f.call('prepare',{caseId:'stale',noticeId:f.first.notice_id,payloadHash:f.first.payload_hash}),{code:'REHEARSAL_SOURCE_STALE'});
 assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM owner_mail_attempts').first()).n,0);
});
test('lost result and expired claims are terminal uncertain, while known no-send is terminal not-sent',async t=>{
 for(const result of ['lost-result','known-not-sent','expired']){const f=await fixture(t),review=await f.prepare(),claim=await f.claim(review);const at=result==='expired'?new Date(Date.parse(claim.expiresAt)+1).toISOString():f.now;const receipt=await f.complete(claim,result==='expired'?'confirmed':result,at);assert.equal(receipt.state,result==='known-not-sent'?'not-sent':'uncertain');assert.equal((await f.claim(review)).state,receipt.state);}
});
test('concurrent claims and result acknowledgements create one durable attempt and receipt',async t=>{
 const f=await fixture(t),reviews=await Promise.all([f.prepare(),f.prepare()]);assert.deepEqual(reviews[0],reviews[1]);const review=reviews[0],values=await Promise.all([f.claim(review),f.claim(review)]);assert.deepEqual(values[0],values[1]);const claim=values[0];assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM owner_mail_attempts').first()).n,1);
 const results=await Promise.all([f.complete(claim,'confirmed'),f.complete(claim,'confirmed')]);assert.deepEqual(results[0],results[1]);const expected=await f.complete(claim,'confirmed');assert.equal(expected.state,'sent');assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM owner_mail_audit WHERE action='sent'").first()).n,1);
});
test('daily budget permits at most three independent reviewed rehearsal attempts',async t=>{
 const f=await fixture(t);for(let i=1;i<=4;i++){const source=i===1?f.first:await f.notice(i),review=await f.prepare(i,source);if(i<=3){const c=await f.claim(review,i);await f.complete(c,'known-not-sent');}else await assert.rejects(f.claim(review,i),{code:'REHEARSAL_CLAIM_CONFLICT'});}assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM owner_mail_attempts').first()).n,3);
});

test('generation, owner and current authority changes fence retained reviews and attempts',async t=>{
 const f=await fixture(t),review=await f.prepare(),claim=await f.claim(review);
 await f.DB.prepare('UPDATE system_control SET generation=2').run();const next={...f.env,GENERATION:'2'};
 assert.equal((await f.call('status',{caseId:'case-1',generation:2},next)).case,null);
 await assert.rejects(f.call('claim',{caseId:'case-1',claimId:'claim-1',workerId:'native',reviewHash:review.reviewHash,generation:2},next),{code:'REHEARSAL_REVIEW_REQUIRED'});
 await assert.rejects(f.call('complete',{attemptId:claim.attemptId,claimToken:claim.claimToken,workerId:'native',outcome:'confirmed',generation:2},next),{code:'NOT_AUTHORIZED'});
 await assert.rejects(f.call('prepare',{caseId:'case-1',noticeId:f.first.notice_id,payloadHash:f.first.payload_hash,generation:2},next),{code:'REHEARSAL_ID_CONFLICT'});
 await f.DB.prepare('UPDATE system_control SET generation=1').run();
 assert.equal((await f.call('status',{caseId:'case-1'},{...f.env,OWNER_MAIL_REHEARSAL_EMAIL:'changed@example.invalid'})).case,null);
 await f.DB.prepare("DELETE FROM admin_grants WHERE capability='notifications.manage'").run();await assert.rejects(f.complete(claim,'confirmed'),{code:'NOT_AUTHORIZED'});
 assert.equal((await f.DB.prepare('SELECT state FROM owner_mail_attempts').first()).state,'sending');
});
test('an expired retained claim recovers as uncertain and paused intake does not silently disable the separate reviewed gate',async t=>{
 const f=await fixture(t),review=await f.prepare();await f.DB.prepare('UPDATE system_control SET accepting_commands=0').run();const claim=await f.claim(review);
 const extra={attemptId:claim.attemptId,claimToken:claim.claimToken,workerId:'native'};
 await assert.rejects(f.call('recover',extra),{code:'REHEARSAL_NOT_EXPIRED'});
 const expired=new Date(Date.parse(claim.expiresAt)+1).toISOString(),receipt=await f.call('recover',extra,f.env,expired);
 assert.equal(receipt.state,'uncertain');assert.deepEqual(await f.complete(claim,'confirmed',expired),receipt);
 assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM notification_intents WHERE state='suppressed'").first()).n,1);
});

test('freshly stored historical recipes cannot be replayed through an owner case',async t=>{
 const f=await fixture(t);await f.DB.prepare("UPDATE notification_intents SET recipe_json=json_set(recipe_json,'$.asOf','2000-01-01T00:00:00.000Z')").run();
 await assert.rejects(f.prepare(),{code:'REHEARSAL_SOURCE_STALE'});assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM owner_mail_cases').first()).n,0);
});
