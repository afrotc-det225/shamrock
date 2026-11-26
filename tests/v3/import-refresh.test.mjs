import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createIncrementalImportPlan,assertIncrementalImportTarget,verifyIncrementalImport,inspectIncrementalImportResume,matchRefreshContacts} from '../../scripts/lib/import-refresh.mjs';
const at='2026-11-17T00:00:00.000Z';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const file of readdirSync('database/migrations').filter(f=>/^\d{4}_/.test(f)).sort())db.exec(readFileSync('database/migrations/'+file,'utf8'));
 const schema=Array.from({length:16},(_,i)=>({version:i+1,name:`${String(i+1).padStart(4,'0')}_fixture.sql`,sha256:'a'.repeat(64),source_commit:'b'.repeat(40),environment:'staging',applied_at:at}));db.exec('CREATE TABLE shamrock_migrations(version INTEGER PRIMARY KEY,name TEXT,sha256 TEXT,source_commit TEXT,environment TEXT,applied_at TEXT)');for(const r of schema)db.prepare('INSERT INTO shamrock_migrations VALUES(?,?,?,?,?,?)').run(...Object.values(r));
 db.exec("INSERT INTO system_control VALUES(1,'staging',1,0);INSERT INTO people VALUES('p','Fictional Cadet');INSERT INTO events VALUES('e','Fictional LLAB',1);INSERT INTO principals VALUES('service:legacy-import',NULL,0);");
 const insert=(table,row)=>{const c=Object.keys(row);db.prepare(`INSERT INTO ${table}(${c.join(',')}) VALUES(${c.map(()=>'?').join(',')})`).run(...c.map(k=>row[k]));};
 const oldRun={import_run_id:'old',snapshot_sha256:'a'.repeat(64),plan_sha256:'b'.repeat(64),reconciliation_sha256:'c'.repeat(64),review_reference:'fictional-old',environment:'staging',generation:1,state:'complete',expected_occurrences:1,expected_profiles:1,expected_events:1,expected_baselines:1,expected_batches:1,manifest_json:'{}',started_at:at,completed_at:at};insert('legacy_import_runs',oldRun);
 const oldSource={import_run_id:'old',occurrence_id:'source',fingerprint:'d'.repeat(64),source_kind:'matrix',disposition:'evidence-only',locator_json:'{}',raw_json:'["A"]',normalized_json:null,diagnostics_json:'{}'};insert('legacy_source_occurrences',oldSource);
 const old={baseline_id:'stable-baseline',person_id:'p',event_id:'e',code:'A',import_run_id:'old',source_occurrence_id:'source',source_column_index:7};insert('legacy_attendance_baselines',old);
 const source={...oldSource,import_run_id:'new',fingerprint:'e'.repeat(64),raw_json:'["P"]'},columns=Object.keys(source),input={before:{permission_policy_control:db.prepare('SELECT * FROM permission_policy_control').all(),shamrock_migrations:schema,legacy_attendance_baselines:[old]},desired:{legacy_attendance_baselines:[{...old,code:'P',import_run_id:'new'}]},evidence:{run:{import_run_id:'new',snapshot_sha256:'f'.repeat(64),reconciliation_sha256:'a'.repeat(64),expected_occurrences:1,expected_profiles:1,expected_events:1,expected_baselines:1},groups:[{table:'legacy_source_occurrences',columns,rows:[columns.map(c=>source[c])]}]},context:{environment:'staging',generation:1,schemaVersion:16,backupSha256:'1'.repeat(64),sourceCommit:'2'.repeat(40),administrationRevision:0,importedAt:at},review:{reviewReference:'fictional-reviewed-refresh',preserveCanonicalKeys:true,preserveOriginalEvidence:true,suppressNotifications:true,sourceSnapshots:[{snapshotSha256:'f'.repeat(64),consistent:true}]}};
 const plan=createIncrementalImportPlan(input),batch=statements=>{db.exec('BEGIN');try{for(const s of statements)db.prepare(s.sql).run(...s.params);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}},readBatch=async statements=>statements.map(s=>({results:db.prepare(s.sql).all(...s.params)}));return {db,input,plan,batch,readBatch,old,oldSource};
}
test('refresh stages append-only evidence, swaps canonical state atomically, and safely resumes/replays',async t=>{
 const f=fixture(t);assert.equal((await inspectIncrementalImportResume(f.plan,f)).phase,'initialize');f.batch(f.plan.initialize);assert.equal((await inspectIncrementalImportResume(f.plan,f)).phase,'loading');assert.throws(()=>f.batch(f.plan.finish));assert.equal(f.db.prepare('SELECT code FROM legacy_attendance_baselines').get().code,'A');
 for(const step of f.plan.steps){f.batch(step.batch);f.batch(step.batch);}assert.equal((await inspectIncrementalImportResume(f.plan,f)).phase,'verify-evidence-before-finish');assert.equal((await verifyIncrementalImport(f.plan,{...f,phase:'evidence'})).verified,true);f.batch(f.plan.finish);f.batch(f.plan.finish);assert.equal((await verifyIncrementalImport(f.plan,f)).verified,true);assert.equal((await inspectIncrementalImportResume(f.plan,f)).phase,'complete');
 assert.deepEqual({...f.db.prepare("SELECT * FROM legacy_source_occurrences WHERE import_run_id='old'").get()},f.oldSource);assert.equal(f.db.prepare('SELECT baseline_id FROM legacy_attendance_baselines').get().baseline_id,'stable-baseline');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admin_commands').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM operation_commands').get().n,0);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('a stale reviewed row or newly accepted command rolls back the entire final batch',t=>{
 const f=fixture(t);f.batch(f.plan.initialize);for(const s of f.plan.steps)f.batch(s.batch);f.db.exec("UPDATE legacy_attendance_baselines SET code='E'");assert.throws(()=>f.batch(f.plan.finish));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admin_commands').get().n,0);assert.equal(f.db.prepare("SELECT state FROM legacy_import_runs WHERE import_run_id='new'").get().state,'loading');
 f.db.exec("UPDATE legacy_attendance_baselines SET code='A';UPDATE system_control SET accepting_commands=1");assert.throws(()=>f.batch(f.plan.finish));
});
test('exact readback rejects corrupted evidence without trusting its stored fingerprint',async t=>{
 const f=fixture(t);f.batch(f.plan.initialize);for(const s of f.plan.steps)f.batch(s.batch);f.db.exec("UPDATE legacy_source_occurrences SET raw_json='[]' WHERE import_run_id='new'");assert.equal((await verifyIncrementalImport(f.plan,{...f,phase:'evidence'})).verified,false);
});
test('target/hash binding and stable target identities reject redirect or retargeting',t=>{
 const f=fixture(t),target={accountId:'fictional-account',databaseId:'fictional-database',name:'Fictional staging',environment:'staging'},observed={...target,generation:1,schemaVersion:16,acceptingCommands:false,notificationMode:'suppressed'};assert.equal(assertIncrementalImportTarget(f.plan,target,observed,f.plan.executionSha256),true);assert.throws(()=>assertIncrementalImportTarget(f.plan,target,{...observed,environment:'production'},f.plan.executionSha256));const changed=structuredClone(f.input);changed.desired.legacy_attendance_baselines[0].person_id='other';assert.throws(()=>createIncrementalImportPlan(changed),/REFRESH_BASELINE_TARGET/);
});
test('changed and newly imported attendance cells use evidence from this refresh', t => {
 const {input}=fixture(t);
 const row=input.desired.legacy_attendance_baselines[0];
 row.import_run_id='old';
 assert.throws(()=>createIncrementalImportPlan(input),/REFRESH_BASELINE_EVIDENCE/);
 row.baseline_id='new-baseline';
 assert.throws(()=>createIncrementalImportPlan(input),/REFRESH_BASELINE_EVIDENCE/);
});
test('inserted or sorted source contact rows preserve existing person/manual contact IDs',()=>{
 const existing=[{contact_id:'stable-one',person_id:'person-one',last_name:'Example',first_name:'One',email:'one@example.invalid'},{contact_id:'stable-cadre',person_id:null,last_name:'Example',first_name:'Cadre',email:'cadre@example.invalid'}],incoming=[{contact_id:'old-row-one',person_id:'new-person',last_name:'Example',first_name:'New',email:'new@example.invalid'},{...existing[0],contact_id:'old-row-two'},{...existing[1],contact_id:'old-row-three'}];const next=matchRefreshContacts(existing,incoming);assert.deepEqual(next.slice(1).map(r=>r.contact_id),['stable-one','stable-cadre']);assert.notEqual(next[0].contact_id,'stable-one');assert.throws(()=>matchRefreshContacts([...existing,existing[0]],incoming),/REFRESH_CONTACT_AMBIGUOUS/);
});

test('a changed migration ledger blocks loading and finalization',t=>{const f=fixture(t);f.db.exec("UPDATE shamrock_migrations SET sha256='unexpected' WHERE version=16");assert.throws(()=>f.batch(f.plan.initialize));assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_import_runs WHERE import_run_id='new'").get().n,0);});

test('a changed role policy blocks finalization until a fresh backup is reviewed',t=>{const f=fixture(t);f.batch(f.plan.initialize);for(const s of f.plan.steps)f.batch(s.batch);f.db.exec('UPDATE permission_policy_control SET version=version+1');assert.throws(()=>f.batch(f.plan.finish));assert.equal(f.db.prepare('SELECT code FROM legacy_attendance_baselines').get().code,'A');});
