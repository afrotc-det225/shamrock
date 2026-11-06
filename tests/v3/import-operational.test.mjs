import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {importDigest} from '../../scripts/lib/import-capture.mjs';
import {IMPORT_SCHEMAS,buildImportPlan} from '../../scripts/lib/import-parity.mjs';
import {reconcileImportEvidence} from '../../scripts/lib/import-reconciliation.mjs';
import {buildStagingImportModel,createStagingImportPlan,packStagingImportBatches} from '../../scripts/lib/import-staging.mjs';
import {reconcileOperationalAdoption,buildOperationalAdoptionModel,createOperationalAdoptionPlan,verifyOperationalAdoption,assertOperationalAdoptionTarget,inspectOperationalAdoptionResume} from '../../scripts/lib/import-operational.mjs';
import {initializeLocalDatabase} from '../../scripts/lib/v3-local-database.mjs';
import {frontendSnapshot} from '../../.build/v3/apps/worker/src/admin.js';
import {listLegacyRequestHistory} from '../../.build/v3/apps/worker/src/legacy-history.js';
import {closeoutCode} from '../../.build/v3/packages/domain/src/closeout.js';
import {buildFrontendReporting} from '../../.build/v3/packages/domain/src/frontend-reporting.js';
import {snapshotToFrontendReportingInput} from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import {buildExcusalPublicationTables} from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';
const at='2026-11-06T12:00:00.000Z',secret='fictional-operational-import-test-secret',key='fixture-key';
const cell=v=>({effectiveValue:{[typeof v==='number'?'numberValue':'stringValue']:v},userEnteredValue:{[typeof v==='number'?'numberValue':'stringValue']:v}});
function prepared(){
 const people=['One','Two'].map((first_name,i)=>({last_name:'Example',first_name,as_year:'AS100',flight:i?'Bravo':'Alpha',squadron:i?'Gold':'Blue',email:`person-${i}@example.invalid`,flight_path_status:'Active 3/4',role:i?'':'Flight Commander',rank:'C/Capt'}));
 const event={event_id:'event-one',term:'2026-Fall',training_week:'TW-01',event_type:'LLAB',display_name:'TW-01 LLAB',attendance_column_label:'TW-01 LLAB',expected_group:'All Cadets',flight_scope:'All',status:'Active'};
 const leaders=[{...people[0],role:'Alpha Flight Commander',cell_phone:'',reports_to:'Squadron Commander'},{last_name:'Example',first_name:'Cadre',rank:'Capt',role:'Operations Flight Commander',email:'cadre@example.invalid',cell_phone:'',reports_to:''}];
 const requests=[{...people[0],request_id:'request-one',status:'Submitted',decision:'',event:event.display_name},{...people[1],email:'alternate@example.invalid',request_id:'request-two',status:'Approved',decision:'Approved',event:event.display_name},{...people[0],request_id:'retired-request',status:'Submitted',decision:'',event:'Retired fixture event'},{last_name:'Unknown',first_name:'Fictional',email:'unknown@example.invalid',request_id:'unresolved-request',status:'Submitted',decision:'',event:event.display_name}].map(r=>({...r,requested_outcome:'E',reason:'Fictional retained request',submitted_at:at,last_updated_at:at,decided_at:r.decision?at:'',decided_by:r.decision?'unverified-source@example.invalid':''}));
 const matrix=people.map((p,i)=>({...p,overall_attendance_pct:i?0:1,llab_attendance_pct:i?0:1,[event.display_name]:i?'A':'P'}));
 const table=(id,title,headers,rows)=>({metadata:{properties:{sheetId:id,title,gridProperties:{rowCount:rows.length+2,columnCount:headers.length}}},rows:[headers.map(cell),headers.map(cell),...rows.map(r=>headers.map(h=>cell(r[h]??'')))]});
 const book=(role,sheets)=>({key:role,role,kind:'workbook',providerId:`fictional-${role}`,coherent:true,metadata:{spreadsheetId:`fictional-${role}`,properties:{title:'Fictional import',timeZone:'America/New_York'}},sheets});
 const body={formatVersion:1,consistent:true,writerFence:false,resources:[book('backend',[table(1,'Directory Backend',IMPORT_SCHEMAS.directory,people),table(2,'Events Backend',IMPORT_SCHEMAS.event,[event]),table(3,'Attendance Matrix Backend',[...IMPORT_SCHEMAS.matrix,event.display_name],matrix),table(4,'Leadership Backend',IMPORT_SCHEMAS.leadership,leaders),table(5,'Excusals Backend',IMPORT_SCHEMAS.excusal,requests)]),book('main',[table(1,'Directory',IMPORT_SCHEMAS.directory,people),table(2,'Attendance',[...IMPORT_SCHEMAS.matrix,event.display_name],matrix)])]};
 const snapshot={...body,snapshotSha256:importDigest(body)},initial=buildImportPlan(snapshot),reconciliation=reconcileImportEvidence(snapshot,initial);
 const current=buildStagingImportModel(snapshot,initial,reconciliation,{formatVersion:1,snapshotSha256:snapshot.snapshotSha256,planSha256:initial.planSha256,reconciliationSha256:reconciliation.reconciliationSha256,reviewReference:'fictional-current-review',adoptCurrentProfiles:true,adoptCurrentEvents:true,adoptCurrentEffectiveCells:true,freezeCurrentRoster:true,preserveHistoricalQuarantine:true});
 const base=createStagingImportPlan(snapshot,current,{generation:1,sourceCommit:'f'.repeat(40),importedAt:at});
 const evidence=reconcileOperationalAdoption(snapshot,initial,current.plan,reconciliation),review={formatVersion:1,evidenceSha256:evidence.evidenceSha256,snapshotSha256:evidence.snapshotSha256,reviewReference:'fictional-explicit-subject-review',adoptLinkedLeadership:true,adoptManualLeadership:true,adoptExactEmailSubjects:true,adoptCanonicalSubjectTuples:true,preserveUnresolved:true,retiredEvents:[{label:'Retired fixture event',reason:'Explicitly retired in this fixture',sourceReference:'fictional reviewed policy'}]};
 const model=buildOperationalAdoptionModel(evidence,review),plan=createOperationalAdoptionPlan(model,{generation:1,sourceCommit:'f'.repeat(40),importedAt:at,importRunId:base.importRunId,baseExecutionSha256:base.executionSha256});return {base,evidence,review,model,plan};
}
const apply=(db,batch)=>db.batch(batch.map(s=>db.prepare(s.sql).bind(...s.params)));
async function database(t){const f=prepared(),mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'operational-import-fixture'},bindings:{ENVIRONMENT:'staging',GENERATION:'1',BRIDGE_KEY_ID:key,BRIDGE_SECRET:secret},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await initializeLocalDatabase(db);await db.prepare("INSERT INTO system_control VALUES(1,'staging',1,0)").run();await apply(db,f.base.init);for(const batch of packStagingImportBatches(f.base))await apply(db,batch.batch);await apply(db,f.base.finish);await db.batch([db.prepare("INSERT INTO principals VALUES('reader',NULL,1),('approver',NULL,1)"),db.prepare("INSERT INTO admin_grants VALUES('reader','frontend.read','wing','*')")]);
 const env={DB:db,ENVIRONMENT:'staging',GENERATION:'1'},snapshot=()=>frontendSnapshot(env,{environment:'staging',generation:1,principalId:'reader'});
 const send=async command=>{const body=JSON.stringify(command),path='/v1/commands',timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(`POST\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');const response=await mf.dispatchFetch(`https://fixture.invalid${path}`,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':key,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signature}});return {status:response.status,body:await response.json()};};return {...f,db,env,snapshot,send};}
const report=s=>buildFrontendReporting(snapshotToFrontendReportingInput(s,'2026-11-06'));
test('reviewed subject tuples preserve all source dispositions without authenticating responders or restoring retired events',()=>{
 const f=prepared();assert.equal(f.model.contacts.length,2);assert.equal(f.model.summary.linkedContacts,1);assert.equal(f.model.summary.manualContacts,1);assert.equal(f.model.requests.length,2);assert.equal(f.model.summary.retiredRequests,1);assert.equal(f.model.summary.quarantinedRows,1);
 const alt=f.model.requests.find(r=>r.requestId==='request-two');assert.equal(alt.evidence.method,'legacy-handler-canonical-subject-tuple');assert.equal(alt.evidence.verifiedHumanIdentity,false);assert.equal(alt.evidence.completeTuple,true);
 f.review.adoptCanonicalSubjectTuples=false;assert.throws(()=>buildOperationalAdoptionModel(f.evidence,f.review),/IMPORT_OPERATIONAL_CONSENT/);
});
test('adoption hides partial state, exposes editable versioned queues, and preserves imported matrix/unknown actors',async t=>{
 const f=await database(t),before=await f.snapshot();await apply(f.db,f.plan.load);assert.equal((await f.snapshot()).requests.length,0);assert.equal((await verifyOperationalAdoption(f.plan,{readBatch:batch=>apply(f.db,batch)})).verified,true);await apply(f.db,f.plan.finish);
 const after=await f.snapshot();assert.deepEqual(await inspectOperationalAdoptionResume(f.plan,{readBatch:batch=>apply(f.db,batch)}),{phase:'complete'});const history=await listLegacyRequestHistory(f.env,{environment:'staging',generation:1,principalId:'reader'});assert.equal(history.rows.length,4);assert.equal(history.rows.filter(r=>r.disposition==='quarantined').length,1);assert.equal(after.leadership.length,2);assert.equal(after.requests.length,2);assert.ok(after.requests.every(r=>r.legacyStateOnly&&r.order===0&&r.version===1&&r.submittedBy===null&&r.decidedBy===null));assert.deepEqual(report(after).matrices[0].rows.map(r=>r.cells[0].effectiveCode),report(before).matrices[0].rows.map(r=>r.cells[0].effectiveCode));
 const tables=buildExcusalPublicationTables({snapshot:after,blueSquadronId:after.squadrons.find(s=>s.label==='Blue').squadronId,goldSquadronId:after.squadrons.find(s=>s.label==='Gold').squadronId,timeZone:'America/New_York'});assert.deepEqual(tables.map(t=>t.rows.length),[1,1]);assert.ok(tables.every(t=>t.rows[0].commandBindings.decision.expectedVersion===1));
 const n=await f.db.prepare('SELECT (SELECT COUNT(*) FROM operation_commands) AS operations,(SELECT COUNT(*) FROM excusal_record_decisions) AS decisions,(SELECT COUNT(*) FROM excusal_notification_tasks) AS tasks,(SELECT COUNT(*) FROM admin_effects) AS effects').first();assert.deepEqual(n,{operations:0,decisions:0,tasks:0,effects:0});
});
test('a genuine decision on an adopted request uses current authority, audit/version and one normal suppressed notification task',async t=>{
 const f=await database(t);await apply(f.db,f.plan.load);await apply(f.db,f.plan.finish);const initial=await f.snapshot(),req=initial.requests.find(r=>r.requestId==='request-two');
 await f.db.batch([f.db.prepare('UPDATE system_control SET accepting_commands=1'),f.db.prepare("INSERT INTO access_grants VALUES('approver','excusal.decide',?,'unit')").bind(req.flightId),f.db.prepare("INSERT INTO adapter_sources VALUES('sheet','fixture-decisions',1)")]);
 const command={commandId:'new-decision',contractVersion:1,environment:'staging',generation:1,actor:{principalId:'approver',evidence:'google-edit'},source:{kind:'sheet',resourceKey:'fixture-decisions',submissionId:'edit-one',revision:1},operation:'excusal.decide',payload:{requestId:req.requestId,expectedVersion:1,decision:'Approved',reason:'New authenticated decision'}};
 const first=await f.send(command);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal((await f.send(command)).status,200);
 const snapshot=await f.snapshot(),updated=snapshot.requests.find(r=>r.requestId===req.requestId);assert.equal(updated.legacyStateOnly,false);assert.equal(updated.version,2);assert.equal(updated.order,1);assert.equal(updated.submittedBy,null);assert.equal(updated.decidedBy,'approver');assert.equal(report(snapshot).matrices[0].rows.find(r=>r.personId===req.personId).cells[0].effectiveCode,'E');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM excusal_record_decisions').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM excusal_notification_tasks').first()).n,1);
 await f.db.prepare("DELETE FROM access_grants WHERE principal_id='approver'").run();assert.equal((await f.send({...command,commandId:'forbidden-decision',source:{...command.source,submissionId:'edit-two'},payload:{...command.payload,expectedVersion:2}})).status,403);
});
test('target binding, unchanged evidence and exact-value readback prevent redirected, repeated or modified adoption',async t=>{
 const f=await database(t),target={environment:'staging',generation:1,databaseId:'fictional-db',accountId:'fictional-account',name:'Fictional parity'},observed={...target,schemaVersion:10,acceptingCommands:false,notificationMode:'suppressed'};assert.equal(assertOperationalAdoptionTarget(f.plan,target,observed,f.plan.executionSha256),true);assert.throws(()=>assertOperationalAdoptionTarget(f.plan,target,{...observed,databaseId:'different'},f.plan.executionSha256),/IMPORT_OPERATIONAL_TARGET/);
 await apply(f.db,f.plan.load);await assert.rejects(apply(f.db,f.plan.load));await f.db.prepare("UPDATE excusal_records SET reason='changed' WHERE request_id='request-one'").run();assert.equal((await verifyOperationalAdoption(f.plan,{readBatch:batch=>apply(f.db,batch)})).verified,false);
});

test('migration preserves genuine request actors, versions, decisions and pending notice tasks exactly',async()=>{
 const db=new DatabaseSync(':memory:'),directory=new URL('../../database/migrations/',import.meta.url),files=(await readdir(directory)).filter(f=>/^\d{4}_/.test(f)).sort();
 try{for(const name of files.filter(n=>Number(n.slice(0,4))<10))db.exec(await readFile(new URL(name,directory),'utf8'));
 db.exec("INSERT INTO people VALUES('p','Example');INSERT INTO principals VALUES('actor','p',1);INSERT INTO organizational_units VALUES('alpha','Alpha',1);INSERT INTO events VALUES('event','Fictional',1);INSERT INTO command_registry VALUES('submit','operation'),('decision','operation');");
 const insert=(table,values)=>db.prepare(`INSERT INTO ${table} VALUES(${values.map(()=>'?').join(',')})`).run(...values);
 for(const command of ['submit','decision'])insert('operation_commands',[command,'hash','actor',command==='submit'?'excusal.submit':'excusal.decide','alpha','event','p','test','fixture',command,1,at,'{}']);
 insert('excusal_requests',['request','event','p','alpha','E','Reason','Approved','Approved',2,at,'actor',at,at,'actor','Decision reason','{}','submit','decision']);insert('excusal_decisions',['request',2,'Approved','Decision reason','actor',at,'decision']);insert('notification_tasks',['task','decision','request',2,'{}','pending','suppressed',at,null,null]);
 db.exec(await readFile(new URL(files.find(n=>n.startsWith('0010_')),directory),'utf8'));
 const record=db.prepare('SELECT * FROM excusal_records').get(),original=db.prepare('SELECT * FROM excusal_requests').get();for(const key of Object.keys(original))assert.equal(record[key],original[key]);assert.equal(record.origin,'native');assert.deepEqual(db.prepare('SELECT * FROM excusal_record_decisions').get(),db.prepare('SELECT * FROM excusal_decisions').get());assert.deepEqual(db.prepare('SELECT * FROM excusal_notification_tasks').get(),db.prepare('SELECT * FROM notification_tasks').get());assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close();}
});
test('old denied request state cannot replay a closeout change over saved baseline A',()=>{
 const cell={effectiveCode:'A',needsReview:false,eligible:true};assert.equal(closeoutCode({cell,latestAttendanceOrder:0,requests:[{status:'Denied',order:0,legacyStateOnly:true}]}),null);assert.equal(closeoutCode({cell:{...cell,effectiveCode:'D'},latestAttendanceOrder:0,requests:[]}), 'U');
});
