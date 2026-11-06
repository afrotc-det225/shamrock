import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {initializeLocalDatabase} from '../../scripts/lib/v3-local-database.mjs';
import {frontendSnapshot} from '../../.build/v3/apps/worker/src/admin.js';

test('Worker hides incomplete imports, then exposes exact baseline codes at initial pair version zero',async t=>{
  const mf=new Miniflare({modules:true,scriptPath:resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'legacy-baseline-fixture'},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');await initializeLocalDatabase(db);
  const insert=(table,row)=>db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row));
  await db.batch([
    db.prepare("INSERT INTO system_control VALUES(1,'staging',1,0)"),
    db.prepare("INSERT INTO principals VALUES('reader',NULL,1)"),
    db.prepare("INSERT INTO admin_grants VALUES('reader','frontend.read','wing','*')"),
    db.prepare("INSERT INTO squadrons VALUES('blue','Blue')"),db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1)"),db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue')"),
    db.prepare("INSERT INTO people VALUES('cadet','Fictional Cadet')"),
    insert('directory_profiles',{person_id:'cadet',version:1,flight_id:'alpha',last_name:'Example',first_name:'Fictional',as_year:'AS100',rank:'',role:'',university:'',email:'cadet@example.invalid',phone:'',dorm:'',cip_broad_area:'',cip_code:'',afsc:'',home_town:'',home_state:'',class_year:'',date_of_birth:null,flight_path_status:'Active 3/4',photo_link:'',updated_at:'2026-01-01T00:00:00.000Z'}),
    db.prepare("INSERT INTO terms VALUES('term','Fictional term',1,1)"),db.prepare("INSERT INTO events VALUES('event','Fictional event',1)"),
    insert('event_details',{event_id:'event',version:1,term_id:'term',event_type:'llab',training_week:1,display_order:0,column_label:'Fictional event',expected_group:'All Cadets',status:'active',start_at:null,end_at:null,location:'',notes:'',created_at:'2026-01-01T00:00:00.000Z',created_by:'reader',updated_at:'2026-01-01T00:00:00.000Z'}),
    insert('legacy_import_runs',{import_run_id:'import-fixture',snapshot_sha256:'0'.repeat(64),plan_sha256:'1'.repeat(64),reconciliation_sha256:'2'.repeat(64),review_reference:'fictional-review',environment:'staging',generation:1,state:'loading',expected_occurrences:1,expected_profiles:1,expected_events:1,expected_baselines:1,expected_batches:1,manifest_json:'{}',started_at:'2026-01-01T00:00:00.000Z',completed_at:null}),
    insert('legacy_source_occurrences',{import_run_id:'import-fixture',occurrence_id:'source-row',fingerprint:'3'.repeat(64),source_kind:'matrix',disposition:'evidence-only',locator_json:'{}',raw_json:'[]',normalized_json:null,diagnostics_json:'{}'}),
    insert('legacy_attendance_baselines',{baseline_id:'baseline-fixture',person_id:'cadet',event_id:'event',code:'P',import_run_id:'import-fixture',source_occurrence_id:'source-row',source_column_index:7}),
  ]);
  const env={DB:db,ENVIRONMENT:'staging',GENERATION:'1'},request={environment:'staging',generation:1,principalId:'reader'};
  let snapshot=await frontendSnapshot(env,request);assert.deepEqual(snapshot.legacyBaselines,[]);assert.deepEqual(snapshot.attendanceVersions,[]);
  await db.prepare("UPDATE legacy_import_runs SET state='complete',completed_at='2026-01-01T00:00:00.000Z' WHERE import_run_id='import-fixture'").run();
  snapshot=await frontendSnapshot(env,request);
  assert.deepEqual(snapshot.legacyBaselines,[{baselineId:'baseline-fixture',personId:'cadet',eventId:'event',code:'P'}]);
  assert.deepEqual(snapshot.attendanceVersions,[{personId:'cadet',eventId:'event',version:0}]);
  assert.deepEqual(snapshot.observations,[]);assert.deepEqual(snapshot.corrections,[]);
  assert.deepEqual(snapshot.revision,{operations:0,administration:0});
  const counts=await db.prepare('SELECT (SELECT COUNT(*) FROM operation_commands) AS commands,(SELECT COUNT(*) FROM outbox_jobs) AS jobs,(SELECT COUNT(*) FROM notification_intents) AS notices').first();
  assert.deepEqual(counts,{commands:0,jobs:0,notices:0});
});
