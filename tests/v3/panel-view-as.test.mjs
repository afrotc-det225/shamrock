import {splitMigrationSql} from '../../scripts/lib/v3-migrations.mjs';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { buildRolePermissionPolicy } from '../../.build/v3/packages/domain/src/permissions.js';
import worker from '../../.build/v3/apps/worker/src/index.js';

const directory = new URL('../../database/migrations/', import.meta.url);
const migration = (await Promise.all((await readdir(directory)).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort().map(n => readFile(new URL(n, directory), 'utf8')))).flatMap(splitMigrationSql);
const secret = 'fictional-view-as-secret-not-for-deployment', keyId = 'fixture';
const base = { environment: 'local', generation: 1, principalId: 'owner' };
const manifest = { section: 'manifest', offset: 0, revision: null };
const enter = (targetPersonId, auditId = 'entry') => ({ ...base, action: 'enter', auditId, targetPersonId });
const preview = (targetPersonId = 'lead', kind = 'panel', entryAuditId = 'entry', page = manifest, viewRevision = null) => ({ ...base, targetPersonId, entryAuditId, kind, page, viewRevision });
async function fixture(t, {squadronCommand = false} = {}) {
  const mf = new Miniflare({ modules: true, scriptPath: resolve('.build/v3-artifacts/worker.mjs'), compatibilityDate: '2026-07-01', d1Databases: { DB: 'view-as' }, bindings: { ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: keyId, BRIDGE_SECRET: secret }, log: new Log(LogLevel.NONE) });
  t.after(() => mf.dispose()); const db = await mf.getD1Database('DB');
  await db.batch(migration.map(s => db.prepare(s)));
  await db.batch([
    db.prepare("INSERT INTO system_control VALUES(1,'local',1,0)"),
    db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)"),
    db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),
    db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold')"),
    db.prepare("INSERT INTO terms VALUES('current','Fictional current',1,1)"),
    db.prepare("INSERT INTO principals VALUES('owner',NULL,1),('outsider',NULL,1)"),
    db.prepare("INSERT OR IGNORE INTO permission_managers VALUES('owner',1)"),
    db.prepare("INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*')"),
    db.prepare("INSERT INTO command_registry VALUES('binding','admin')"),
  ]);
  for (const [person, flight, role, verified] of [['lead','alpha','Flight Commander',true],['cadet','alpha','Cadet',true],['other','bravo','Cadet',true],['administrator','bravo','Cadet',true],['unverified','alpha','Cadet',false]]) {
    await db.batch([
      db.prepare('INSERT INTO people VALUES(?,?)').bind(person, `Fictional ${person}`), db.prepare('INSERT INTO principals VALUES(?,?,1)').bind(person,person),
      db.prepare("INSERT INTO directory_profiles VALUES(?,1,?,'Fictional',?,'AS200','C/SSgt',?,'Example University',?,'private-phone','private-dorm','private-area','private-code','private-afsc','private-town','private-state','2030','2007-01-01','Active 3/4','https://example.invalid/private-photo','2026-01-01')").bind(person,flight,person,role,`${person}@example.invalid`),
      db.prepare('INSERT INTO memberships VALUES(?,?,1)').bind(person,flight),
      ...(verified ? [db.prepare("INSERT INTO principal_accounts VALUES(?,?,'authenticated-confirmation','binding')").bind(person,`${person}@example.invalid`)] : []),
    ]);
  }
  await db.batch([
    db.prepare("INSERT INTO people VALUES('unmapped','Fictional unmapped'),('ambiguous','Fictional ambiguous')"),
    db.prepare("INSERT INTO principals VALUES('duplicate-one','ambiguous',1),('duplicate-two','ambiguous',1)"),
    db.prepare("INSERT INTO principal_accounts VALUES('duplicate-one','duplicate-one@example.invalid','authenticated-confirmation','binding'),('duplicate-two','duplicate-two@example.invalid','authenticated-confirmation','binding')"),
    db.prepare("INSERT INTO admin_grants VALUES('administrator','frontend.read','wing','*')"),
  ]);
  if (squadronCommand) await db.batch([
    db.prepare("UPDATE directory_profiles SET email=person_id||'@nd.edu'"),
    db.prepare("UPDATE principal_accounts SET email=principal_id||'@nd.edu' WHERE principal_id IN ('lead','other','cadet')"),
    db.prepare("UPDATE directory_profiles SET role='Gold Squadron Commander' WHERE person_id='other'"),
  ]);
  const people = (await db.prepare('SELECT person_id AS personId,version,flight_id AS flightId,email,role,flight_path_status AS flightPathStatus,1 AS active FROM directory_profiles').all()).results;
  const flights = (await db.prepare('SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id').all()).results;
  const squadrons = (await db.prepare('SELECT squadron_id AS squadronId,label FROM squadrons').all()).results;
  const accounts = (await db.prepare('SELECT a.principal_id AS principalId,p.person_id AS personId,a.email,p.active FROM principal_accounts a JOIN principals p ON p.principal_id=a.principal_id').all()).results.map(a=>({...a,active:!!a.active}));
  const policy = buildRolePermissionPolicy({people,contacts:[],flights,squadrons,accounts,operationalSquadronIds:['blue','gold']});
  await db.batch([
    db.prepare('UPDATE permission_policy_control SET enabled=1,version=1,policy_json=?,policy_hash=?').bind(JSON.stringify(policy),createHash('sha256').update(JSON.stringify(policy)).digest('hex')),
    ...policy.members.map(m=>db.prepare('INSERT INTO role_permission_members VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(m.principalId,m.sourceKind,m.sourceId,m.sourceVersion,m.linkedContactId,m.linkedContactVersion,1,m.sourceRole,m.sourceFlightId,m.sourceStatus,m.linkedContactActive)),
    ...policy.adminGrants.map(g=>db.prepare('INSERT INTO role_admin_grants VALUES(?,?,?,?)').bind(g.principalId,g.capability,g.scopeKind,g.scopeKey)),
    ...policy.accessGrants.map(g=>db.prepare('INSERT INTO role_access_grants VALUES(?,?,?,?)').bind(g.principalId,g.capability,g.flightId,g.subjectScope)),
  ]);
  async function send(input,path='/v1/admin/panel/view-as/authorize',overrideDB) {
    const body=JSON.stringify(input),timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',secret).update(`POST\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
    const url='https://fixture.invalid'+path,init={method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signature}};
    const r=overrideDB?await worker.fetch(new Request(url,init),{DB:overrideDB,ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret}):await mf.dispatchFetch(url,init);
    return {status:r.status,body:await r.json()};
  }
  const page=(input,overrideDB)=>send(input,'/v1/admin/panel/view-as/page',overrideDB);
  const counts=async()=> (await db.prepare("SELECT (SELECT COUNT(*) FROM admin_audit_events) AS administration,(SELECT COUNT(*) FROM audit_events) AS operations,(SELECT COUNT(*) FROM command_registry) AS commands,(SELECT COUNT(*) FROM admin_effects) AS effects").first());
  return {db,send,page,counts};
}

test('View as preserves exact Flight capabilities, redacts other Flights, and audits the real actor without operational writes',async t=>{
  const f=await fixture(t),before=await f.counts();
  const entry=await f.send(enter('lead'));assert.equal(entry.status,200,JSON.stringify(entry));
  assert.equal(entry.body.readOnly,true);assert.equal(entry.body.targetPrincipalId,'lead');assert.equal(entry.body.status,'ready');assert.equal(entry.body.access.capabilities.fullSnapshot,false);assert.deepEqual(entry.body.access.flightIds,['alpha']);
  const normal=await f.send({...base,principalId:'lead',...manifest},'/v1/admin/panel/page');
  const head=await f.page(preview());assert.equal(head.status,200,JSON.stringify(head));assert.deepEqual(head.body.page,normal.body);
  const people=await f.page(preview('lead','panel','entry',{section:'people',offset:0,revision:head.body.page.revision},head.body.viewRevision));
  assert.equal(people.status,200,JSON.stringify(people));assert.deepEqual(people.body.page.rows.map(p=>p.personId),['cadet','lead','unverified']);
  for(const forbidden of ['other','private-phone','private-dorm','@example.invalid','2007-01-01'])assert.equal(JSON.stringify(people.body).includes(forbidden),false,forbidden);
  assert.equal((await f.page(preview('lead','snapshot'))).status,403);
  assert.deepEqual(await f.counts(),before);
  const audit=await f.db.prepare('SELECT actor_id,target_person_id,target_principal_id,status FROM panel_view_as_audit').first();assert.deepEqual(audit,{actor_id:'owner',target_person_id:'lead',target_principal_id:'lead',status:'ready'});
});

test('unmapped, ambiguous, unverified and ordinary cadets have explicit no-access results without administrator grants',async t=>{
  const f=await fixture(t);
  for(const [target,status] of [['unmapped','no-active-principal'],['ambiguous','ambiguous-principal'],['unverified','no-verified-login'],['cadet','no-panel-access']]){
    const response=await f.send(enter(target,'entry-'+target));assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.status,status);assert.equal(response.body.access,null);
    assert.equal((await f.page(preview(target,'panel','entry-'+target))).status,403);
  }
  assert.equal((await f.send({...enter('lead'),principalId:'lead'})).status,403); // derived Wing Sheets grant is insufficient
  assert.equal((await f.send({...enter('lead'),principalId:'outsider'})).status,403);
  assert.equal((await f.send(enter('missing'))).status,404);
});

test('cheap preview authority preserves current transfer tokens without writing audit or exposing records',async t=>{
  const f=await fixture(t),path='/v1/admin/panel/view-as/access';
  for(const [person,kind]of [['lead','panel'],['administrator','snapshot']]){
    const entry='entry-'+person;assert.equal((await f.send(enter(person,entry))).status,200);
    const manifest=await f.page(preview(person,kind,entry));
    const request={...base,targetPersonId:person,entryAuditId:entry};
    const before=await f.db.prepare('SELECT COUNT(*) AS n FROM panel_view_as_audit').first();
    const access=await f.send(request,path);assert.equal(access.status,200,JSON.stringify(access));
    assert.equal(access.body.viewRevision,manifest.body.viewRevision);
    assert.deepEqual(access.body.scope,manifest.body.page.scope);
    assert.equal(access.body.rows,undefined);assert.equal(access.body.sections,undefined);assert.equal(access.body.readOnly,true);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS n FROM panel_view_as_audit').first(),before);
    assert.equal((await f.send({...request,viewRevision:manifest.body.viewRevision},path)).status,400);
    let calls=0;const race={prepare:sql=>f.db.prepare(sql),async batch(s){if(++calls===3)await f.db.prepare("DELETE FROM admin_grants WHERE principal_id='owner'").run();return f.db.batch(s);}};
    assert.equal((await f.send(request,path,race)).status,409);
    await f.db.prepare("INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*')").run();
    await f.send({...base,action:'exit',auditId:'exit-'+person,entryAuditId:entry});
    assert.equal((await f.send(request,path)).status,403);
  }
});

test('fullSnapshot targets use original full snapshot and history transports; no silently restricted Wing preview',async t=>{
  const f=await fixture(t);assert.equal((await f.send(enter('administrator'))).status,200);
  const head=await f.page(preview('administrator','snapshot'));assert.equal(head.status,200,JSON.stringify(head));
  const normal=await f.send({...base,principalId:'administrator',...manifest},'/v1/admin/snapshot/page');assert.deepEqual(head.body.page,normal.body);
  const people=await f.page(preview('administrator','snapshot','entry',{section:'people',offset:0,revision:head.body.page.revision},head.body.viewRevision));assert.equal(people.status,200,JSON.stringify(people));assert(people.body.page.rows.some(p=>p.phone==='private-phone'));assert(people.body.page.rows.some(p=>p.personId==='other'));
  const history=await f.page(preview('administrator','history-list','entry',{}));assert.equal(history.status,200,JSON.stringify(history));assert.deepEqual(history.body.page.snapshots,[]);
  assert.equal((await f.page(preview('administrator','panel'))).status,400);
  const catalog=await f.page(preview('administrator','snapshot','entry',{section:'directory-catalog',offset:0,revision:null}));assert.equal(catalog.status,200,JSON.stringify(catalog));assert(catalog.body.page.rows.length>0);
  assert.equal((await f.page(preview('administrator','commands'))).status,400);
  assert.equal((await f.page(preview('administrator','snapshot','entry',{...manifest,principalId:'owner'}))).status,400);
  assert.equal((await f.send(enter('lead'),'/v1/admin/panel/view-as/commands')).status,404);
});

test('entry/exit audit IDs are idempotent and exit still succeeds after administrator revocation',async t=>{
  const f=await fixture(t);assert.equal((await f.send(enter('lead'))).status,200);assert.equal((await f.send(enter('lead'))).status,200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM panel_view_as_audit').first()).n,1);
  assert.equal((await f.send(enter('administrator'))).status,409);
  const exit={...base,action:'exit',auditId:'exit',entryAuditId:'entry'};
  assert.equal((await f.send({...exit,principalId:'outsider'})).status,403);
  await f.db.prepare("DELETE FROM admin_grants WHERE principal_id='owner'").run();
  assert.equal((await f.send(exit)).status,200);assert.equal((await f.send(exit)).status,200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM panel_view_as_audit').first()).n,2);
  await f.db.prepare("INSERT INTO admin_grants VALUES('owner','frontend.read','wing','*')").run();
  assert.equal((await f.page(preview())).status,403);
  assert.equal((await f.send(enter('lead'))).status,409); // a closed audit entry cannot reopen a preview
  assert.equal((await f.send({...exit,entryAuditId:'missing'})).status,403);
});

test('preview revisions bind the real actor, audited entry, target and current target scope',async t=>{
  const f=await fixture(t);assert.equal((await f.send(enter('lead'))).status,200);assert.equal((await f.send(enter('lead','second'))).status,200);
  const head=await f.page(preview());assert.equal(head.status,200);
  const page={section:'people',offset:0,revision:head.body.page.revision};
  assert.equal((await f.page(preview('lead','panel','second',page,head.body.viewRevision))).status,409);
  assert.equal((await f.page(preview('other','panel','entry',page,head.body.viewRevision))).status,403);
  assert.equal((await f.page(preview('lead','panel','entry',page,null))).status,400);
  await f.db.prepare("UPDATE directory_profiles SET flight_id='bravo',version=2 WHERE person_id='lead'").run();
  const changed=await f.page(preview('lead','panel','entry',page,head.body.viewRevision));assert([403,409].includes(changed.status));assert.equal(JSON.stringify(changed.body).includes('private-phone'),false);
});

test('authority or target mapping loss inside the data batch returns no preview data',async t=>{
  const f=await fixture(t);assert.equal((await f.send(enter('administrator'))).status,200);
  for(const mutation of ["DELETE FROM admin_grants WHERE principal_id='owner'","DELETE FROM principal_accounts WHERE principal_id='administrator'"]){
    let batches=0,statements=0;
    const racing={prepare:sql=>f.db.prepare(sql),async batch(s){statements+=s.length;if(++batches===2)await f.db.prepare(mutation).run();return f.db.batch(s);}};
    const response=await f.page(preview('administrator','snapshot'),racing);assert.equal(response.status,409,JSON.stringify(response));assert.equal(response.body.error.code,'VIEW_AS_CHANGED');assert.equal(JSON.stringify(response.body).includes('private-phone'),false);assert(statements<=50);
    await f.db.prepare("INSERT OR IGNORE INTO admin_grants VALUES('owner','frontend.read','wing','*')").run();
    await f.db.prepare("INSERT OR IGNORE INTO principal_accounts VALUES('administrator','administrator@example.invalid','authenticated-confirmation','binding')").run();
  }
});

test('scope loss at the final panel data batch and account rebinding invalidate the captured preview',async t=>{
  const f=await fixture(t);assert.equal((await f.send(enter('lead'))).status,200);
  const head=await f.page(preview());let batches=0,statements=0;
  const racing={prepare:sql=>f.db.prepare(sql),async batch(s){statements+=s.length;if(++batches===3)await f.db.prepare("UPDATE directory_profiles SET version=2,role='Cadet' WHERE person_id='lead'").run();return f.db.batch(s);}};
  const response=await f.page(preview('lead','panel','entry',{section:'people',offset:0,revision:head.body.page.revision},head.body.viewRevision),racing);
  assert.equal(response.status,409,JSON.stringify(response));assert(statements<=50);assert.equal(JSON.stringify(response.body).includes('Fictional'),false);
  await f.db.prepare("UPDATE directory_profiles SET version=1,role='Flight Commander' WHERE person_id='lead'").run();
  await f.db.prepare("UPDATE principal_accounts SET email='changed@example.invalid' WHERE principal_id='lead'").run();
  assert([403,409].includes((await f.page(preview('lead','panel','entry',{section:'people',offset:0,revision:head.body.page.revision},head.body.viewRevision))).status));
});

test('audit insertion rechecks the real administrator within the write transaction',async t=>{
  const f=await fixture(t);let batches=0;
  const racing={prepare:sql=>f.db.prepare(sql),async batch(s){if(++batches===4)await f.db.prepare("DELETE FROM admin_grants WHERE principal_id='owner'").run();return f.db.batch(s);}};
  const response=await f.send(enter('lead'),undefined,racing);assert.equal(response.status,409,JSON.stringify(response));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM panel_view_as_audit').first()).n,0);
});

test('historical previews preserve the original source/hash pages and stop when the preview closes mid-read',async t=>{
  const f=await fixture(t),at='2026-01-01T00:00:00.000Z',hash='a'.repeat(64);
  const insert=(table,row)=>f.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row));
  const labels=['Fictional','Archive Cadet','AS100','Alpha','Blue'];
  await f.db.batch([
    insert('legacy_import_runs',{import_run_id:'import',snapshot_sha256:hash,plan_sha256:'b'.repeat(64),reconciliation_sha256:'c'.repeat(64),review_reference:'fictional-review',environment:'staging',generation:1,state:'complete',expected_occurrences:1,expected_profiles:1,expected_events:1,expected_baselines:1,expected_batches:1,manifest_json:'{}',started_at:at,completed_at:at}),
    insert('legacy_source_occurrences',{import_run_id:'import',occurrence_id:'row-one',fingerprint:'d'.repeat(64),source_kind:'matrix',disposition:'evidence-only',locator_json:'{"rowIndex":2}',raw_json:JSON.stringify(labels.map(stringValue=>({effectiveValue:{stringValue}}))),normalized_json:null,diagnostics_json:'{}'}),
    insert('legacy_matrix_snapshots',{matrix_snapshot_id:'archive',import_run_id:'import',source_resource_key:'fictional-archive',source_sheet_id:1,metadata_json:JSON.stringify({sourceTitle:'Fictional retained archive',periodLabel:'Fictional old term',isCurrent:false,authority:'retained-source-copy',companionDirectoryFound:false,columns:[]}),roster_json:'[]'}),
    insert('legacy_matrix_snapshot_rows',{matrix_snapshot_id:'archive',source_occurrence_id:'row-one',person_id:null,payload_json:JSON.stringify({occurrenceId:'row-one',personId:null,identityLabels:labels.map(s=>s.toLowerCase()),events:[],overall:.5,llab:1,creditFormulaEvidence:{overall:null,llab:null,arrayAnchorRowIndex:2},personEvidence:null})}),
  ]);
  assert.equal((await f.send(enter('administrator'))).status,200);
  const body={snapshotId:'archive',section:'manifest',offset:0,sourceSnapshotSha256:null};
  const head=await f.page(preview('administrator','history','entry',body));assert.equal(head.status,200,JSON.stringify(head));
  const normal=await f.send({...base,principalId:'administrator',...body},'/v1/admin/history/page');assert.deepEqual(head.body.page,normal.body);
  const rows={...body,section:'rows',sourceSnapshotSha256:hash};
  const report=await f.page(preview('administrator','history','entry',rows,head.body.viewRevision));assert.equal(report.status,200,JSON.stringify(report));assert.equal(report.body.page.rows[0].row.overall.stored,.5);
  assert.equal((await f.page(preview('administrator','history','entry',{...rows,sourceSnapshotSha256:'f'.repeat(64)},head.body.viewRevision))).status,409);
  let batches=0;
  const racing={prepare:sql=>f.db.prepare(sql),async batch(s){if(++batches===2)assert.equal((await f.send({...base,action:'exit',auditId:'exit',entryAuditId:'entry'})).status,200);return f.db.batch(s);}};
  const closed=await f.page(preview('administrator','history','entry',rows,head.body.viewRevision),racing);assert.equal(closed.status,409,JSON.stringify(closed));assert.equal(closed.body.error.code,'VIEW_AS_CHANGED');assert.equal(JSON.stringify(closed.body).includes('Archive Cadet'),false);
});

test('an active Directory assignment supports a read-only admin preview before first login',async t=>{
  const f=await fixture(t),email='fictional-unbound@nd.edu';
  await f.db.batch([
    f.db.prepare("INSERT INTO directory_profiles SELECT 'unmapped',1,'alpha',last_name,first_name,as_year,rank,'Blue Squadron Commander',university,?,phone,dorm,cip_broad_area,cip_code,afsc,home_town,home_state,class_year,date_of_birth,flight_path_status,photo_link,updated_at FROM directory_profiles WHERE person_id='lead'").bind(email),
    f.db.prepare("INSERT INTO memberships VALUES('unmapped','alpha',1)"),
    f.db.prepare("UPDATE permission_policy_control SET config_json=?").bind(JSON.stringify({operationalSquadronIds:['blue','gold']})),
    f.db.prepare("INSERT INTO admin_grants VALUES('outsider','frontend.read','wing','*')"),
  ]);
  assert.equal((await f.send({...enter('unmapped'),principalId:'outsider'})).status,403);
  const entry=await f.send(enter('unmapped'));assert.equal(entry.body.directoryWorkspace,true);
  const target={...base,targetPersonId:'unmapped',entryAuditId:'entry'};
  const preview=await f.send(target,'/v1/cadet/preview');
  assert.equal(preview.status,200);assert.equal(preview.body.readOnly,true);
  const principalId='google.'+createHash('sha256').update(email).digest('hex');
  const actual=await f.send({...base,email,principalId},'/v1/cadet/workspace');
  const {readOnly,...same}=preview.body;assert.deepEqual(same,actual.body);
  for(const section of ['profile','attendance','directory']){
    const personal=await f.send({...target,section},'/v1/cadet/preview');
    const direct=await f.send({...base,email,principalId,section},'/v1/cadet/workspace');
    assert.equal(personal.status,200);
    const {readOnly,...visible}=personal.body;
    assert.equal(readOnly,true);assert.deepEqual(visible,direct.body);
  }
  const picker='/v1/admin/panel/view-as/people';
  assert.equal((await f.send(base,picker)).status,200);
  assert.equal((await f.send({...base,principalId:'outsider'},picker)).status,403);
  assert.equal((await f.send({...target,action:{kind:'decide'}},'/v1/cadet/preview')).status,400);
  await f.db.prepare("UPDATE memberships SET active=0 WHERE person_id='unmapped'").run();
  assert.equal((await f.send(target,'/v1/cadet/preview')).status,403);
});

test('a linked cadet permits an audited profile edit through View as, with the same write pause and exit fence',async t=>{
  const f=await fixture(t),path='/v1/cadet/preview';
  const email='fixture'+ '@nd.edu';
  await f.db.batch([
    f.db.prepare("UPDATE permission_policy_control SET config_json=?").bind(JSON.stringify({operationalSquadronIds:["blue","gold"]})),
    f.db.prepare("UPDATE principal_accounts SET email=? WHERE principal_id='cadet'").bind(email),
    f.db.prepare("UPDATE directory_profiles SET email=? WHERE person_id='cadet'").bind(email),
    f.db.prepare("INSERT INTO adapter_sources VALUES('test','admin-staging-web',1)"),
  ]);
  const entry=await f.send(enter('cadet'));
  assert.equal(entry.body.directoryWorkspace,true);
  const target={...base,targetPersonId:'cadet',entryAuditId:'entry'};
  assert.equal((await f.send(target,path)).body.readOnly,false);
  const action={id:crypto.randomUUID(),kind:'profile',fields:{changes:{dorm:'Off-Campus'},version:1}};
  const input={...target,action};
  assert.equal((await f.send(input,path)).body.error.code,'WRITES_PAUSED');
  await f.db.prepare('UPDATE system_control SET accepting_commands=1').run();
  const saved=await f.send(input,path);
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(saved.body.commandId,'portal.entry.'+action.id);
  assert.equal((await f.send(input,path)).status,200);
  assert.equal(await f.db.prepare("SELECT dorm FROM directory_profiles WHERE person_id='cadet'").first('dorm'),'Off-Campus');
  assert.equal((await f.send({...input,action:{...action,kind:'link'}},path)).status,403);
  assert.equal((await f.send({...input,targetPersonId:'lead'},path)).status,403);
  assert.equal((await f.send({...base,action:'exit',auditId:'exit',entryAuditId:'entry'})).status,200);
  assert.equal((await f.send(input,path)).status,403);
});

test('a Wing panel edit uses the target grants and the entry-linked command in the transaction',async t=>{
  const f=await fixture(t);
  await f.db.batch([
    f.db.prepare("UPDATE system_control SET accepting_commands=1"),
    f.db.prepare("UPDATE permission_policy_control SET config_json=?").bind(JSON.stringify({operationalSquadronIds:["blue","gold"]})),
    f.db.prepare("INSERT INTO adapter_sources VALUES('test','admin-staging-web',1)"),
  ]);
  await f.send(enter('administrator'));
  const path='/v1/admin/panel/view-as/action';
  const payload={contractVersion:1,environment:'local',generation:1,commandId:'edit',actor:{principalId:'owner',evidence:'authenticated-confirmation'},
    source:{kind:'test',resourceKey:'admin-staging-web',submissionId:'edit',revision:1},operation:'directory.selfUpdate',
    payload:{personId:'administrator',expectedVersion:1,changes:{dorm:'Sorin Hall'}}};
  const input={...base,targetPersonId:'administrator',entryAuditId:'entry',path:'/v1/admin/commands',payload};
  const saved=await f.send(input,path);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(saved.body.commandId,'view.entry.edit');
  assert.equal(await f.db.prepare("SELECT actor_id FROM admin_commands WHERE command_id='view.entry.edit'").first('actor_id'),'administrator');
  assert.equal((await f.send({...input,payload:{...payload,commandId:'outside',payload:{...payload.payload,personId:'other'}}},path)).status,403);
});

test('school and View as queues honor captured flight and squadron ownership, including decision writes',async t=>{
  const {db,send}=await fixture(t,{squadronCommand:true});
  const route='/v1/cadet/workspace';
  const direct=(person,extra)=>send({...base,principalId:person,email:person+'@nd.edu',...extra},route);
  await db.batch([
    db.prepare("UPDATE system_control SET accepting_commands=1"),
    db.prepare("UPDATE permission_policy_control SET config_json=?").bind(JSON.stringify({operationalSquadronIds:['blue','gold']})),
    db.prepare("INSERT INTO adapter_sources VALUES('test','admin-staging-web',1)"),
    db.prepare("INSERT INTO events VALUES('lab','Fictional LLAB',1)"),
    db.prepare("INSERT INTO event_units VALUES('lab','alpha'),('lab','bravo')"),
    db.prepare("INSERT INTO event_details VALUES('lab',1,'current','llab',1,1,'LLAB','','active',NULL,NULL,'','','2026-01-01','owner','2026-01-01')"),
  ]);
  for(const [flight,squadron,person] of [['alpha','blue','cadet'],['bravo','gold','other']]) {
    await db.batch([
      db.prepare("INSERT INTO operation_commands VALUES(?,'hash','owner','excusal.submit',?,'lab',?,'test','fixture',?,1,'2026-01-01','{}')").bind(flight,flight,person,flight),
      db.prepare("INSERT INTO excusal_records(request_id,event_id,person_id,unit_id,requested_outcome,reason,status,version,submitted_at,submitted_by,updated_at,source_json,command_id,last_command_id) VALUES(?,'lab',?,?,'E','Fictional exam','Submitted',1,'2026-01-01','owner','2026-01-01','{}',?,?)").bind(flight,person,flight,flight,flight),
      db.prepare("INSERT INTO excusal_request_scopes VALUES(?,?,?,?,?,'submission','2026-01-01')").bind(flight,flight,squadron,flight,squadron),
    ]);
  }
  const action=requestId=>({kind:'decide',id:crypto.randomUUID(),fields:{requestId,version:1,decision:'Approved',reason:'Reviewed'}});
  for(const [person,expected] of [['lead','alpha'],['other','bravo']]){
    const read=await direct(person,{section:'excusals'});
    assert.equal(read.status,200,JSON.stringify(read));
    assert.deepEqual(read.body.queue.map(r=>r.requestId),[expected]);
    const auditId='entry-'+person;
    assert.equal((await send(enter(person,auditId))).status,200);
    const delegated={...base,targetPersonId:person,entryAuditId:auditId};
    const preview=await send({...delegated,section:'excusals'},'/v1/cadet/preview');
    assert.equal(preview.status,200,JSON.stringify(preview));
    assert.deepEqual(preview.body.queue,read.body.queue);
    if(person==='lead')assert.equal((await send({...delegated,action:action('alpha')},'/v1/cadet/preview')).status,403);
    assert.equal((await send({...base,action:'exit',entryAuditId:auditId,auditId:'exit-'+person})).status,200);
  }
  assert.equal((await direct('cadet',{section:'excusals'})).status,403);
  assert.equal((await direct('lead',{action:action('alpha')})).status,403);
  assert.equal((await direct('other',{action:action('alpha')})).status,403);
  const approved=await direct('other',{action:action('bravo')});
  assert.equal(approved.status,200,JSON.stringify(approved));
  assert.deepEqual((await db.prepare("SELECT status FROM excusal_records ORDER BY request_id").all()).results.map(r=>r.status),['Submitted','Approved']);
});
