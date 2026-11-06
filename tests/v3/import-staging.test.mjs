import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {importDigest} from '../../scripts/lib/import-capture.mjs';
import {IMPORT_SCHEMAS,buildImportPlan} from '../../scripts/lib/import-parity.mjs';
import {reconcileImportEvidence} from '../../scripts/lib/import-reconciliation.mjs';
import {buildStagingImportModel,createStagingImportPlan,packStagingImportBatches,assertStagingImportTarget,verifyStagingImportReadback,STAGING_IMPORT_INDEX_COUNTS,estimateStagingImportWrites,assessStagingImportQuota,inspectStagingImportResume} from '../../scripts/lib/import-staging.mjs';
import {initializeLocalDatabase} from '../../scripts/lib/v3-local-database.mjs';
import {frontendSnapshot} from '../../.build/v3/apps/worker/src/admin.js';
import {buildFrontendReporting} from '../../.build/v3/packages/domain/src/frontend-reporting.js';

const at='2026-11-06T12:00:00.000Z';
const cell=v=>({effectiveValue:{[typeof v==='number'?'numberValue':'stringValue']:v},userEnteredValue:{[typeof v==='number'?'numberValue':'stringValue']:v}});
function source(){
  const people=['One','Two'].map((first_name,i)=>({last_name:'Example',first_name,as_year:'AS100',flight:'Alpha',squadron:'Blue',email:`cadet-${i}@example.invalid`,flight_path_status:'Active 3/4',dob:'2006-01-01'}));
  const event={event_id:'legacy-event',term:'2026-Fall',training_week:'TW-01',event_type:'LLAB',display_name:'TW-01 LLAB',attendance_column_label:'TW-01 LLAB',expected_group:'All Cadets',flight_scope:'All',status:'Active'};
  const matrix=people.map((p,i)=>({...p,overall_attendance_pct:1,llab_attendance_pct:1,'TW-01 LLAB':i?'':'P'}));
  const table=(id,title,headers,rows)=>({metadata:{properties:{sheetId:id,title,gridProperties:{rowCount:rows.length+2,columnCount:headers.length}}},rows:[headers.map(cell),headers.map(cell),...rows.map(r=>headers.map(h=>cell(r[h]??'')))]});
  const book=(role,sheets)=>({key:role,role,kind:'workbook',providerId:`fictional-${role}`,coherent:true,metadata:{spreadsheetId:`fictional-${role}`,properties:{title:`Fictional ${role}`,timeZone:'America/New_York'}},sheets});
  const body={formatVersion:1,consistent:true,writerFence:false,resources:[book('backend',[table(1,'Directory Backend',IMPORT_SCHEMAS.directory,people),table(2,'Events Backend',IMPORT_SCHEMAS.event,[event]),table(3,'Attendance Matrix Backend',[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],matrix)]),book('main',[table(1,'Directory',IMPORT_SCHEMAS.directory,people),table(2,'Attendance',[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],matrix)])]};
  return {...body,snapshotSha256:importDigest(body)};
}
function prepared(snapshot=source()){
  const initial=buildImportPlan(snapshot),reconciliation=reconcileImportEvidence(snapshot,initial),review={formatVersion:1,snapshotSha256:snapshot.snapshotSha256,planSha256:initial.planSha256,reconciliationSha256:reconciliation.reconciliationSha256,reviewReference:'fictional-explicit-review',adoptCurrentProfiles:true,adoptCurrentEvents:true,adoptCurrentEffectiveCells:true,freezeCurrentRoster:true,preserveHistoricalQuarantine:true};
  const model=buildStagingImportModel(snapshot,initial,reconciliation,review),plan=createStagingImportPlan(snapshot,model,{generation:1,importedAt:at,sourceCommit:'f'.repeat(40)});return {snapshot,initial,reconciliation,review,model,plan};
}
async function database(t){const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'import-staging-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await initializeLocalDatabase(db);await db.prepare("INSERT INTO system_control VALUES(1,'staging',1,0)").run();return db;}
const apply=(db,batch)=>db.batch(batch.map(s=>db.prepare(s.sql).bind(...s.params)));

test('reviewed initial import populates normal D1 profiles/events/rosters and exact independent baseline facts',async t=>{
  const {plan,model}=prepared(),db=await database(t);await apply(db,plan.init);for(const group of packStagingImportBatches(plan))await apply(db,group.batch);
  const before=await db.prepare('SELECT state FROM legacy_import_runs').first();assert.equal(before.state,'loading');
  assert.equal((await verifyStagingImportReadback(plan,{readBatch:batch=>apply(db,batch)})).verified,true);
  await apply(db,plan.finish);
  await db.batch([db.prepare("INSERT INTO principals VALUES('reader',NULL,1)"),db.prepare("INSERT INTO admin_grants VALUES('reader','frontend.read','wing','*')")]);
  const snapshot=await frontendSnapshot({DB:db,ENVIRONMENT:'staging',GENERATION:'1'},{environment:'staging',generation:1,principalId:'reader'});
  assert.equal(snapshot.people.length,2);assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].eligiblePersonIds.length,2);assert.deepEqual(snapshot.legacyBaselines.map(b=>b.code).sort(),['P',null].sort());
  assert.ok(snapshot.attendanceVersions.every(v=>v.version===0));assert.deepEqual(snapshot.observations,[]);assert.deepEqual(snapshot.corrections,[]);
  const reporting=buildFrontendReporting({policyVersion:'legacy-shamrock-credit-v1',asOfDate:'2026-11-06',currentTermId:snapshot.terms.find(t=>t.isCurrent).termId,people:snapshot.people,flights:snapshot.flights,squadrons:snapshot.squadrons,terms:snapshot.terms,events:snapshot.events.map(e=>({...e,type:e.eventType})),legacyBaselines:snapshot.legacyBaselines,observations:snapshot.observations,corrections:snapshot.corrections,requests:snapshot.requests});
  assert.equal(reporting.matrices[0].rows.length,2);assert.deepEqual(reporting.matrices[0].rows.map(r=>r.cells[0].effectiveCode).sort(),['P',null].sort());assert.equal(reporting.diagnostics.length,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM legacy_source_occurrences').first()).n,model.summary.occurrences);
  const effects=await db.prepare('SELECT (SELECT COUNT(*) FROM outbox_jobs) AS jobs,(SELECT COUNT(*) FROM notification_intents) AS notifications,(SELECT COUNT(*) FROM admin_effects) AS effects').first();assert.deepEqual(effects,{jobs:0,notifications:0,effects:0});
  assert.equal((await db.prepare('SELECT operation FROM admin_commands').first()).operation,'legacy.event-import');
});
test('readback detects changed raw evidence even when copied fingerprints and row counts are unchanged',async t=>{
  const {plan}=prepared(),db=await database(t);await apply(db,plan.init);for(const group of packStagingImportBatches(plan))await apply(db,group.batch);
  await db.prepare("UPDATE legacy_source_occurrences SET raw_json='{}' WHERE occurrence_id=(SELECT occurrence_id FROM legacy_source_occurrences LIMIT 1)").run();
  const result=await verifyStagingImportReadback(plan,{readBatch:batch=>apply(db,batch)});assert.equal(result.verified,false);assert.ok(result.differences.some(d=>d.code==='stored-value-mismatch'));
});
test('a repeated committed step is idempotent and a failed insert rolls back its guard and receipt',async t=>{
  const {plan}=prepared(),db=await database(t);await apply(db,plan.init);const step=plan.steps[0];await apply(db,step.batch);const first=await db.prepare('SELECT COUNT(*) AS n FROM legacy_source_occurrences').first();await apply(db,step.batch);assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM legacy_source_occurrences').first(),first);
  const next=plan.steps[1],invalid=structuredClone(next.batch);invalid[1].sql='INSERT INTO unavailable_import_table VALUES(1)';invalid[1].params=[];
  await assert.rejects(apply(db,invalid));assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM legacy_import_batches WHERE batch_index=?').bind(next.index).first()).n,0);
});
test('wrong generation, enabled intake, existing data or unsuppressed mail refuses initial adoption',async t=>{
  const {plan}=prepared(),db=await database(t);await db.prepare('UPDATE system_control SET accepting_commands=1').run();await assert.rejects(apply(db,plan.init));
  await db.prepare('UPDATE system_control SET accepting_commands=0,generation=2').run();await assert.rejects(apply(db,plan.init));
  await db.prepare('UPDATE system_control SET generation=1').run();await db.prepare("UPDATE notification_delivery_control SET daily_recipient_budget=1").run();await assert.rejects(apply(db,plan.init));await db.prepare("UPDATE notification_delivery_control SET daily_recipient_budget=0").run();await db.prepare("INSERT INTO people VALUES('existing','Existing fictional record')").run();await assert.rejects(apply(db,plan.init));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM legacy_import_runs').first()).n,0);
});
test('incomplete load cannot finalize or leak a partial baseline',async t=>{
  const {plan}=prepared(),db=await database(t);await apply(db,plan.init);await assert.rejects(apply(db,plan.finish));assert.equal((await db.prepare('SELECT state FROM legacy_import_runs').first()).state,'loading');
});
test('target binding and exact reviewed execution hash reject redirection or modified SQL',()=>{
  const {plan}=prepared(),target={databaseId:'fictional-db',accountId:'fictional-account',name:'Fictional parity',environment:'staging',generation:1},observed={...target,schemaVersion:8,acceptingCommands:false,notificationMode:'suppressed'};
  assert.equal(assertStagingImportTarget(plan,target,observed,plan.executionSha256),true);const localOnly=structuredClone(plan);localOnly.sourceCommit=null;localOnly.rehearsalOnly=true;delete localOnly.executionSha256;localOnly.executionSha256=importDigest(localOnly);assert.throws(()=>assertStagingImportTarget(localOnly,target,observed,localOnly.executionSha256),/IMPORT_SOURCE_COMMIT/);assert.throws(()=>assertStagingImportTarget(plan,target,{...observed,databaseId:'another'},plan.executionSha256),/IMPORT_TARGET_BINDING/);
  const modified=structuredClone(plan);modified.steps[0].batch[1].params[0]='[]';assert.throws(()=>assertStagingImportTarget(modified,target,observed,plan.executionSha256),/IMPORT_EXECUTION_HASH/);
});
test('current eligibility requires exact active roster equality and explicit All Cadets/All evidence',()=>{
  const f=prepared();f.review.freezeCurrentRoster=false;assert.throws(()=>buildStagingImportModel(f.snapshot,f.initial,f.reconciliation,f.review),/IMPORT_ADOPTION_CONSENT/);
  const changed=source();changed.resources[0].sheets[1].rows[2][IMPORT_SCHEMAS.event.indexOf('expected_group')]=cell('Unknown cohort');const {snapshotSha256,...body}=changed;changed.snapshotSha256=importDigest(body);assert.throws(()=>prepared(changed),/IMPORT_ELIGIBILITY_UNPROVEN/);
});

test('write estimates include every migration-8 index and enforce fresh account-wide free-tier headroom',async t=>{
  const {plan}=prepared(),db=await database(t);
  for(const [table,expected]of Object.entries(STAGING_IMPORT_INDEX_COUNTS)){const rows=await db.prepare(`PRAGMA index_list(${table})`).all();assert.equal(rows.results.length,expected,table);}
  const estimate=estimateStagingImportWrites(plan);assert.equal(estimate.total,estimate.initialization+estimate.completion+estimate.transportBatches.reduce((sum,b)=>sum+b.estimatedWrites,0));assert.ok(estimate.maximumTransportBatch>=estimate.maximumStep);
  const sample={accountId:'fictional-account',observedAt:at,rowsWritten:8000};
  assert.equal(assessStagingImportQuota({accountId:sample.accountId,usage:sample,now:at,estimatedWrites:60000}).allowed,true);
  assert.equal(assessStagingImportQuota({accountId:sample.accountId,usage:sample,now:at,estimatedWrites:60000,localWritesSinceObservation:23000}).allowed,false);
  assert.throws(()=>assessStagingImportQuota({accountId:sample.accountId,usage:sample,now:'2026-11-07T12:00:00.000Z',estimatedWrites:1}),/IMPORT_QUOTA_SAMPLE/);
  assert.throws(()=>assessStagingImportQuota({accountId:'wrong-account',usage:sample,now:at,estimatedWrites:1}),/IMPORT_QUOTA_SAMPLE/);
});
test('resume reads durable exact-plan receipts and skips only a verified committed prefix',async t=>{
  const {plan}=prepared(),db=await database(t),port={readBatch:batch=>apply(db,batch)};
  assert.equal((await inspectStagingImportResume(plan,port)).phase,'initialize');await apply(db,plan.init);await apply(db,plan.steps[0].batch);
  const resume=await inspectStagingImportResume(plan,port);assert.equal(resume.phase,'loading');assert.equal(resume.completedSteps,1);assert.equal(resume.pendingBatches[0].indices[0],1);
  for(const batch of resume.pendingBatches)await apply(db,batch.batch);assert.equal((await verifyStagingImportReadback(plan,port)).verified,true);await apply(db,plan.finish);
  assert.deepEqual(await inspectStagingImportResume(plan,port),{phase:'complete',completedSteps:plan.steps.length,pendingBatches:[]});
  await db.prepare("UPDATE legacy_import_batches SET payload_sha256='wrong' WHERE batch_index=0").run();await assert.rejects(inspectStagingImportResume(plan,port),/IMPORT_RESUME_RECEIPTS/);
});
