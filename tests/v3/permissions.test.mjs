import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {parseAdminCommand} from '../../.build/v3/packages/domain/src/admin.js';
import {buildRolePermissionPolicy} from '../../.build/v3/packages/domain/src/permissions.js';
import {acceptAdminCommand} from '../../.build/v3/apps/worker/src/admin.js';
import {permissionCommand} from '../../.build/v3/apps/worker/src/permissions.js';
import {effectiveAccessGrants,effectiveAdminGrants} from '../../.build/v3/apps/worker/src/permission-grants.js';
const secret='fictional-permission-secret-never-for-deployment',keyId='fixture';
const dir=new URL('../../database/migrations/',import.meta.url);
const sql=(await Promise.all((await readdir(dir)).sort().map(n=>readFile(new URL(n,dir),'utf8')))).join('\n');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const profile=()=>({lastName:'Example',firstName:'Cadet',asYear:'AS200',rank:'C/SSgt',role:'Flight Commander',university:'Notre Dame',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:null,flightPathStatus:'Active 3/4',photoLink:''});
const admin=(id='profile-one',version=0,p=profile())=>({commandId:id,contractVersion:1,environment:'local',generation:1,actor:{principalId:'manager',evidence:'authenticated-confirmation'},source:{kind:'test',resourceKey:'console',submissionId:id,revision:1},operation:'directory.upsert',payload:{personId:'cadet-person',expectedVersion:version,flightId:'alpha',profile:p}});
const envelope=(principalId='manager')=>({environment:'local',generation:1,principalId});
async function fixture(t){
 const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'permissions'},bindings:{ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.batch(sql.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 await db.batch([
  db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),db.prepare("INSERT INTO people VALUES('cadet-person','Cadet')"),
  db.prepare("INSERT INTO principals VALUES('manager',NULL,1),('publisher',NULL,1),('cadet','cadet-person',1),('contact',NULL,1)"),
  db.prepare("INSERT INTO permission_managers VALUES('manager',1)"),db.prepare("INSERT INTO permission_publishers VALUES('publisher',1)"),
  db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)"),db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold')"),
  db.prepare("INSERT INTO terms VALUES('current','Fictional Current',1,1)"),
  db.prepare("INSERT INTO admin_grants SELECT 'manager',value,'wing','*' FROM json_each('[\"directory.manage\",\"leadership.manage\",\"frontend.read\"]')"),
  db.prepare("INSERT INTO adapter_sources VALUES('test','console',1),('form','directory-form',1)")]);
 const env={DB:db,ENVIRONMENT:'local',GENERATION:'1'};
 const send=async(input,path='/v1/admin/commands')=>{const body=JSON.stringify(input),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(`POST\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');const res=await mf.dispatchFetch(`https://fixture.invalid${path}`,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signature}});return {status:res.status,body:await res.json()};};
 const fence=async(command,version,permission=false)=>{const r=await send({...envelope('publisher'),commandId:command.commandId,payloadSha256:hash(permission?command:parseAdminCommand(command)),expectedVersion:version,checkpointSha256:'a'.repeat(64)},'/v1/admin/permissions/fence');assert.equal(r.status,200,JSON.stringify(r.body));};
 const configure=()=>({...envelope(),commandId:'bind-one',expectedVersion:0,accounts:[{principalId:'cadet',personId:'cadet-person',email:'cadet@example.invalid'}],revokePrincipalIds:[],operationalSquadronIds:['blue','gold']});
 const enable=async()=>{assert.equal((await send(admin())).status,200);const c=configure();await fence(c,0,true);const r=await send(c,'/v1/admin/permissions/commands');assert.equal(r.status,200,JSON.stringify(r.body));return c;};
 const grants=async()=> (await db.prepare(`SELECT capability FROM ${effectiveAdminGrants} WHERE principal_id='cadet' ORDER BY capability`).all()).results.map(g=>g.capability);
 return {db,env,send,fence,configure,enable,grants};
}
test('trusted policy preserves wing-wide Leadership attendance and exact operational Squadron decisions',()=>{
 const p={...profile(),personId:'p',flightId:'alpha',version:1,active:true};
 const base={people:[p],contacts:[],accounts:[{principalId:'a',email:p.email,personId:'p',active:true}],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue'},{flightId:'bravo',label:'Bravo',squadronId:'gold'}],squadrons:[{squadronId:'blue',label:'Blue'},{squadronId:'gold',label:'Gold'}],operationalSquadronIds:['blue','gold']};
 let r=buildRolePermissionPolicy(base);assert.equal(r.accessGrants.filter(g=>g.capability==='attendance.report').length,2);assert.equal(r.accessGrants.filter(g=>g.capability==='excusal.decide').length,0);assert.deepEqual(r.google.excusalViewers,[p.email]);
 r=buildRolePermissionPolicy({...base,people:[{...p,role:'Blue Squadron Commander'}]});assert.deepEqual(r.google.squadronCommanders,[{squadronId:'blue',email:p.email}]);assert.deepEqual(r.accessGrants.filter(g=>g.capability==='excusal.decide').map(g=>g.flightId),['alpha']);
 r=buildRolePermissionPolicy({...base,people:[{...p,role:'Mission Support Squadron Commander'}]});assert.equal(r.adminGrants.length,0);
 const duplicate={...base,people:[{...p,role:'Blue Squadron Commander'},{...p,personId:'p2',email:'other@example.invalid',role:'Blue Squadron Commander'}],accounts:[...base.accounts,{principalId:'b',personId:'p2',email:'other@example.invalid',active:true}]};r=buildRolePermissionPolicy(duplicate);assert.equal(r.google.squadronCommanders.length,0);assert.equal(r.diagnostics[0].code,'ambiguous_squadron_commander');
});
test('first enable requires publisher-attested exact native fence; a human manager cannot self-attest',async t=>{
 const f=await fixture(t);assert.equal((await f.send(admin())).status,200);const c=f.configure();
 assert.equal((await f.send(c,'/v1/admin/permissions/commands')).body.error.code,'PERMISSION_FENCE_REQUIRED');
 const fake=await f.send({...envelope(),commandId:c.commandId,payloadSha256:hash(c),expectedVersion:0,checkpointSha256:'a'.repeat(64)},'/v1/admin/permissions/fence');assert.equal(fake.status,403);
 await f.fence(c,0,true);assert.equal((await f.send(c,'/v1/admin/permissions/commands')).status,200);
 assert.deepEqual(await f.grants(),['attendance.correct','frontend.read','leadership.manage']);
});
test('benign profile and contact changes atomically retain authority; role revocation removes it immediately',async t=>{
 const f=await fixture(t);await f.enable();let p={...profile(),phone:'fictional-phone'};let c=admin('phone-edit',1,p);assert.equal((await f.send(c)).status,200);assert.equal((await f.grants()).length,3);
 const before=(await f.db.prepare('SELECT COUNT(*) AS n FROM permission_refresh_jobs').first()).n;assert.equal(before,2);
 c=admin('revoke-role',2,{...p,role:''});assert.equal((await f.send(c)).body.error.code,'PERMISSION_FENCE_REQUIRED');await f.fence(c,2);assert.equal((await f.send(c)).status,200);assert.deepEqual(await f.grants(),[]);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM permission_policy_audit').first()).n,3);
});
test('ordinary Leadership cannot promote itself or another contact but may edit phone/office fields',async t=>{
 const f=await fixture(t);await f.enable();
 const lead={...admin('link-contact'),operation:'leadership.upsert',payload:{contactId:'linked',personId:'cadet-person',expectedVersion:0,profile:null,active:true,reportsTo:'',officePhone:'',officeLocation:''}};
 await f.fence(lead,1);assert.equal((await f.send(lead)).status,200);
 const benign={...lead,commandId:'office-edit',actor:{principalId:'cadet',evidence:'authenticated-confirmation'},source:{...lead.source,submissionId:'office-edit'},payload:{...lead.payload,expectedVersion:1,officeLocation:'Fictional office'}};
 assert.equal((await f.send(benign)).status,200);assert.equal((await f.grants()).length,3);
 const privilege={...benign,commandId:'disable-contact',source:{...lead.source,submissionId:'disable-contact'},payload:{...benign.payload,expectedVersion:2,active:false}};await f.fence(privilege,3);assert.equal((await f.send(privilege)).status,403);
 assert.equal((await f.db.prepare("SELECT active FROM leadership_contacts WHERE contact_id='linked'").first()).active,1);
});
test('source drift revokes derived capabilities without waiting for Google and explicit grants remain explicit',async t=>{
 const f=await fixture(t);await f.enable();await f.db.prepare("UPDATE directory_profiles SET email='changed@example.invalid' WHERE person_id='cadet-person'").run();assert.deepEqual(await f.grants(),[]);
 await f.db.prepare("INSERT INTO admin_grants VALUES('cadet','frontend.read','wing','*')").run();assert.deepEqual(await f.grants(),['frontend.read']);
});
test('permission replay rechecks root authority and any stale/raced write rolls back audit, receipts and grant replacement',async t=>{
 const f=await fixture(t);const c=await f.enable();assert.equal((await f.send(c,'/v1/admin/permissions/commands')).status,200);
 await f.db.prepare("UPDATE permission_managers SET active=0 WHERE principal_id='manager'").run();assert.equal((await f.send(c,'/v1/admin/permissions/commands')).status,403);await f.db.prepare("UPDATE permission_managers SET active=1").run();
 const edit=admin('late-revocation',1,{...profile(),phone:'changed'});let seen=0;
 const DB={prepare:s=>f.db.prepare(s),batch:async items=>{seen++;if(seen===4)await f.db.prepare("UPDATE permission_managers SET active=0").run();return f.db.batch(items);}};
 // A source mutation after policy capture must fail its atomic assertion, independently of caller checks.
 let batches=0;const raceDB={prepare:s=>f.db.prepare(s),batch:async items=>{batches++;if(batches===4)await f.db.prepare("UPDATE directory_profiles SET version=version+1 WHERE person_id='cadet-person'").run();return f.db.batch(items);}};
 await assert.rejects(acceptAdminCommand({...f.env,DB:raceDB},edit),{code:'ADMIN_CONFLICT'});
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM command_registry WHERE command_id='late-revocation'").first()).n,0);assert.equal((await f.grants()).length,0);
});
test('permission refresh leases latest revision, coalesces only covered jobs, and keeps later changes pending',async t=>{
 const f=await fixture(t);await f.enable();const claim=(await f.send({...envelope('publisher'),workerId:'worker'},'/v1/admin/permissions/claim')).body.job;assert.ok(claim);
 const project={...envelope('publisher'),workerId:'worker',jobId:claim.jobId,claimToken:claim.claimToken};assert.equal((await f.send(project,'/v1/admin/permissions/project')).body.current,true);
 assert.equal((await f.send(admin('phone-later',1,{...profile(),phone:'later'}))).status,200);
 assert.equal((await f.send(project,'/v1/admin/permissions/project')).body.current,false);
 const ack=await f.send(project,'/v1/admin/permissions/ack');assert.equal(ack.body.current,false);assert.deepEqual((await f.db.prepare('SELECT version,state FROM permission_refresh_jobs ORDER BY version').all()).results,[{version:1,state:'done'},{version:2,state:'pending'}]);
});
test('policy commands and enabled profile edits remain below the Free per-invocation query limit',async t=>{
 const f=await fixture(t);assert.equal((await f.send(admin())).status,200);const c=f.configure();await f.fence(c,0,true);let queries=0;const DB={prepare:s=>{queries++;return f.db.prepare(s);},batch:items=>f.db.batch(items)};
 await permissionCommand({...f.env,DB},c);assert.ok(queries<50,`permission command prepared ${queries} queries`);
 queries=0;await acceptAdminCommand({...f.env,DB},admin('bounded-phone',1,{...profile(),phone:'bounded'}));assert.ok(queries<50,`enabled profile command prepared ${queries} queries`);
});

test('expired permission leases require reviewed exact recovery and retain the original token and projection',async t=>{
 const f=await fixture(t);await f.enable();const claim=(await f.send({...envelope('publisher'),workerId:'worker'},'/v1/admin/permissions/claim')).body.job;
 const old='2020-01-01T00:00:00.000Z';await f.db.prepare('UPDATE permission_refresh_jobs SET lease_expires_at=? WHERE job_id=?').bind(old,claim.jobId).run();
 const recover={...envelope('publisher'),recoveryId:'recovery-one',workerId:'worker',jobId:claim.jobId,claimToken:claim.claimToken,previousExpiry:old,checkpointSha256:'b'.repeat(64)};
 assert.equal((await f.send({...recover,workerId:'steal'},'/v1/admin/permissions/recover')).status,409);
 const result=await f.send(recover,'/v1/admin/permissions/recover');assert.equal(result.status,200);assert.equal(result.body.claimToken,claim.claimToken);assert.deepEqual(await f.send(recover,'/v1/admin/permissions/recover'),result);
 const project={...envelope('publisher'),workerId:'worker',jobId:claim.jobId,claimToken:claim.claimToken};assert.equal((await f.send(project,'/v1/admin/permissions/project')).status,200);
 const ack=await f.send(project,'/v1/admin/permissions/ack');assert.equal(ack.status,200);assert.deepEqual(await f.send(project,'/v1/admin/permissions/ack'),ack);
 await f.db.prepare("UPDATE permission_publishers SET active=0").run();assert.equal((await f.send(recover,'/v1/admin/permissions/recover')).status,403);
});

test('even unversioned role or Flight drift fails closed against retained source context',async t=>{
 const f=await fixture(t);await f.enable();await f.db.prepare("UPDATE directory_profiles SET role='' WHERE person_id='cadet-person'").run();assert.deepEqual(await f.grants(),[]);
 await f.db.prepare("UPDATE directory_profiles SET role='Flight Commander',flight_id='bravo' WHERE person_id='cadet-person'").run();await f.db.prepare("UPDATE memberships SET unit_id='bravo' WHERE person_id='cadet-person'").run();assert.deepEqual(await f.grants(),[]);
});
