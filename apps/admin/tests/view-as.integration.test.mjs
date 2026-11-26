import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {createLocalBackend} from '../backend.mjs';
import {HostedBackend} from '../hosted/backend.mjs';
await build({absWorkingDir:resolve(import.meta.dirname,'../../..'),entryPoints:['apps/admin/snapshot-client.ts'],outfile:'.build/admin/view-as-client.mjs',bundle:true,format:'esm',platform:'browser'});
const {loadSnapshot,loadEventsList}=await import('../../../.build/admin/view-as-client.mjs');
await build({absWorkingDir:resolve(import.meta.dirname,'../../..'),entryPoints:['apps/admin/history-client.ts'],outfile:'.build/admin/view-as-history-client.mjs',bundle:true,format:'esm',platform:'browser'});
const {loadHistory}=await import('../../../.build/admin/view-as-history-client.mjs');
async function fixture(t,full){
 const local=await createLocalBackend();t.after(()=>local.dispose());
 const source=await local.backend.snapshot(),person=source.people[0],principal='preview-target';
 await local.db.batch([
  local.db.prepare("INSERT INTO command_registry VALUES('preview-binding','admin')"),
  local.db.prepare('INSERT INTO principals VALUES(?,?,1)').bind(principal,person.personId),
  local.db.prepare("INSERT INTO principal_accounts VALUES(?,?,'authenticated-confirmation','preview-binding')").bind(principal,person.email),
  local.db.prepare("INSERT INTO admin_grants VALUES(?,'frontend.read',?,?)").bind(principal,full?'wing':'flight',full?'*':'alpha'),
 ]);
 const entry=await local.backend.post('/v1/admin/panel/view-as/authorize',{...local.backend.identity(),action:'enter',auditId:'preview-entry',targetPersonId:person.personId});
 assert.equal(entry.status,'ready');
 const host=Object.create(HostedBackend.prototype);host.identity=()=>local.backend.identity();host.send=(path,input)=>local.backend.post(path,input);host.preview={person_id:person.personId,entry_audit_id:'preview-entry',status:'ready'};
 return {local,host,source,person};
}
test('actual backend full View as supports list, full snapshot and independent catalog/history transfers',async t=>{
 const {host,source,local,person}=await fixture(t,true);
 const manifest=await host.panelManifest(),state={manifest,snapshotManifest:host.snapshotManifest,viewAs:{status:'ready'}};
 assert.equal(manifest.access.capabilities.fullSnapshot,true);
 const calls=[];
 const request=(_path,body)=>{calls.push(body);return host.page(body);};
 const events=await loadEventsList(state,request);assert.equal(events.events.length,source.events.length);
 const complete=await loadSnapshot(state,request);assert.deepEqual(complete.people,source.people);
 const catalogStarts=calls.filter(body=>['directory-catalog','contacts-catalog'].includes(body.section)&&body.offset===0);
 assert.equal(catalogStarts.length,2);assert(catalogStarts.every(body=>body.revision===null&&body.viewRevision===null));
 const list=await host.historyPage(null);assert.deepEqual(list.snapshots,[]);
 await assert.rejects(()=>host.page({surface:'full',section:'directory-catalog',offset:0,revision:source.revision,viewRevision:manifest.viewRevision}),e=>e.status===409||e.status===400);
 await assert.rejects(()=>host.post('/v1/admin/commands',{}),e=>e.code==='VIEW_AS_READ_ONLY');
 await local.backend.post('/v1/admin/panel/view-as/authorize',{...local.backend.identity(),action:'enter',auditId:'another-entry',targetPersonId:person.personId});
 host.preview.entry_audit_id='another-entry';
 await assert.rejects(()=>host.page({surface:'full',section:'verify',offset:0,revision:source.revision,viewRevision:manifest.viewRevision}),e=>e.code==='VIEW_AS_CHANGED');
});
test('actual backend scoped View as preserves Flight privacy and rejects actor revocation mid-transfer',async t=>{
 const {host,local}=await fixture(t,false),manifest=await host.panelManifest();
 const snapshot=await loadSnapshot({manifest,viewAs:{status:'ready'}},(_path,body)=>host.page(body));
 assert(snapshot.people.every(person=>person.flightId==='alpha'&&!('email' in person)));
 await assert.rejects(()=>host.historyPage(null),e=>e.status===403);
 await local.db.prepare("DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability='frontend.read'").run();
 await assert.rejects(()=>host.page({surface:'scoped',section:'people',offset:0,revision:manifest.revision,viewRevision:manifest.viewRevision}),e=>e.status===403);
});


test('actual backend historical preview pages retain a separate archive token and saved values',async t=>{
 const {host,local}=await fixture(t,true),at='2026-01-01T00:00:00Z';
 const insert=(table,row)=>local.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row));
 const column={columnIndex:7,header:'Fictional LLAB',snapshotEventId:'old-event',eventId:null};
 const row={occurrenceId:'old-row',personId:null,identityLabels:['historical','cadet','as400','alpha','blue'],events:[{...column,code:'UR'}],overall:.75,llab:1,creditFormulaEvidence:{overall:null,llab:null,arrayAnchorRowIndex:2},personEvidence:null};
 await local.db.batch([
  insert('legacy_import_runs',{import_run_id:'preview-history',snapshot_sha256:'a'.repeat(64),plan_sha256:'b'.repeat(64),reconciliation_sha256:'c'.repeat(64),review_reference:'fictional-review',environment:'staging',generation:1,state:'complete',expected_occurrences:1,expected_profiles:1,expected_events:1,expected_baselines:1,expected_batches:1,manifest_json:'{}',started_at:at,completed_at:at}),
  insert('legacy_source_occurrences',{import_run_id:'preview-history',occurrence_id:'old-row',fingerprint:'d'.repeat(64),source_kind:'matrix',disposition:'evidence-only',locator_json:'{"rowIndex":2}',raw_json:JSON.stringify(row.identityLabels.map(v=>({effectiveValue:{stringValue:v}}))),normalized_json:null,diagnostics_json:'{}'}),
  insert('legacy_matrix_snapshots',{matrix_snapshot_id:'preview-archive',import_run_id:'preview-history',source_resource_key:'fictional-archive',source_sheet_id:1,metadata_json:JSON.stringify({sourceTitle:'Fictional archive',periodLabel:'Fictional term',isCurrent:false,authority:'retained-source-copy',companionDirectoryFound:false,columns:[column]}),roster_json:'[]'}),
  insert('legacy_matrix_snapshot_rows',{matrix_snapshot_id:'preview-archive',source_occurrence_id:'old-row',person_id:null,payload_json:JSON.stringify(row)}),
 ]);
 const normal=await host.panelManifest(),calls=[];
 const report=await loadHistory('preview-archive',(_path,body)=>{calls.push(body);return host.historyPage(body);});
 assert.equal(report.rows[0].overall.stored,.75);assert.equal(report.rows[0].cells[0].code,'UR');
 assert(calls.slice(1).every(body=>body.viewRevision===calls[1].viewRevision));
 assert.notEqual(calls[1].viewRevision,normal.viewRevision);
 await assert.rejects(()=>host.historyPage({...calls[1],viewRevision:normal.viewRevision}),e=>e.code==='VIEW_AS_CHANGED');
});

test('browse profiles use effective View as scope for lists, attendance and excusals',async t=>{
 const {host,local,person}=await fixture(t,false);
 const input={...local.backend.identity(),targetPersonId:person.personId,entryAuditId:host.preview.entry_audit_id};
 const read=profile=>local.backend.post('/v1/admin/panel/browse',{...input,profile});
 for(const profile of ['cadets','cadet-details','leadership','overview']) await assert.rejects(()=>read(profile),e=>e.status===403);
 const list=await read('attendance');
 assert.deepEqual(JSON.parse(list.tables.flights).map(f=>f[0]),['alpha']);
 assert(JSON.parse(list.tables.people).every(p=>p[5]==='alpha'));
 assert(!('contacts' in list.tables));
 const queue=await read('excusals');assert.equal(queue.profile,'excusals');
 await local.db.prepare('UPDATE principals SET active=0 WHERE principal_id=?').bind(input.principalId).run();
 await assert.rejects(()=>read('excusals'),e=>e.status===403);
});
