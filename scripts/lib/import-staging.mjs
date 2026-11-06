/** Guarded initial adoption into a new paused staging database. No provider credentials or implicit execution. */
import {importDigest,canonicalImportJson} from './import-capture.mjs';
import {buildImportPlan,verifyImportAccounting,proposeImportCrosswalk} from './import-parity.mjs';
const check=(condition,code)=>{if(!condition)throw new Error(code);};
const clone=value=>JSON.parse(JSON.stringify(value));
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const stable=(kind,value)=>`${kind}:legacy:${importDigest(value).slice(0,32)}`;
const inactive=new Set(['Inactive','Commissioned','Dropped']);
const sql=(sql,...params)=>({sql,params});
function rawOccurrences(snapshot){
  const values=new Map(),put=(locator,value)=>values.set(`occ_${importDigest(locator)}`,value);
  for(const r of snapshot.resources){const root={resourceKey:r.key,providerId:r.providerId};put({...root,type:'resource-metadata'},r.metadata);
    if(r.kind==='form'){for(const response of r.responses)put({...root,type:'native-form-response',responseId:response.responseId},response);continue;}
    for(const sheet of r.sheets){const base={...root,sheetId:sheet.metadata.properties.sheetId};put({...base,type:'sheet-metadata'},sheet.metadata);sheet.rows.forEach((row,rowIndex)=>put({...base,type:'sheet-row',rowIndex},row));}
  }return values;
}
/** Explicit review authorizes the proved current-state adoption, never a name-only or historical-roster guess. */
export function buildStagingImportModel(snapshot,initial,reconciliation,review){
  verifyImportAccounting(snapshot,initial);
  check(review?.formatVersion===1&&review.snapshotSha256===snapshot.snapshotSha256&&review.planSha256===initial.planSha256&&review.reconciliationSha256===reconciliation.reconciliationSha256,'IMPORT_ADOPTION_REVIEW');
  check(typeof review.reviewReference==='string'&&review.reviewReference.trim().length>0&&review.reviewReference.length<=240&&review.adoptCurrentProfiles===true&&review.adoptCurrentEvents===true&&review.adoptCurrentEffectiveCells===true&&review.freezeCurrentRoster===true&&review.preserveHistoricalQuarantine===true,'IMPORT_ADOPTION_CONSENT');
  const {reconciliationSha256,...body}=reconciliation;check(importDigest(body)===reconciliationSha256&&reconciliation.snapshotSha256===snapshot.snapshotSha256,'IMPORT_RECONCILIATION_HASH');
  const proposal=proposeImportCrosswalk(initial),drafts=new Map(proposal.bindings.map(b=>[b.occurrenceId,b]));
  const kinds=new Map(initial.records.map(r=>[r.occurrenceId,r.kind]));
  const adopted=proposal.bindings.filter(b=>!b.unresolved.length&&['directory','event'].includes(kinds.get(b.occurrenceId))).map(b=>({...b,reviewReference:review.reviewReference}));
  const plan=buildImportPlan(snapshot,{formatVersion:1,snapshotSha256:snapshot.snapshotSha256,bindings:adopted});
  const ledger=new Map(plan.ledger.map(r=>[r.occurrenceId,r]));
  const profiles=plan.records.filter(r=>r.kind==='directory'&&drafts.has(r.occurrenceId));
  const events=plan.records.filter(r=>r.kind==='event'&&drafts.has(r.occurrenceId));
  check(profiles.length>0&&profiles.length<=500&&events.length>0&&events.length<=128,'IMPORT_CURRENT_BOUND');
  check([...profiles,...events].every(r=>ledger.get(r.occurrenceId).disposition==='normalized'),'IMPORT_CURRENT_QUARANTINE');
  const current=reconciliation.matrixSnapshots.filter(m=>m.authority==='current-backend');
  check(current.length===1&&current[0].rows.every(r=>safeId(r.personId))&&current[0].columns.every(c=>safeId(c.eventId)),'IMPORT_CURRENT_MATRIX_IDENTITY');
  check(reconciliation.mirrorComparison.summary.available&&reconciliation.mirrorComparison.summary.differences===0,'IMPORT_CURRENT_MIRROR_PARITY');
  const peopleById=new Map(profiles.map(p=>[p.personId,p]));check(peopleById.size===profiles.length,'IMPORT_PERSON_COLLISION');
  const roster=profiles.filter(p=>!inactive.has(p.profile.flightPathStatus)).map(p=>p.personId).sort(),matrixPeople=current[0].rows.map(r=>r.personId).sort();
  check(JSON.stringify(roster)===JSON.stringify(matrixPeople),'IMPORT_CURRENT_ROSTER_MISMATCH');
  check(roster.every(id=>safeId(peopleById.get(id).flightId)),'IMPORT_CURRENT_FLIGHT_MISSING');
  check(events.every(e=>e.expected_group==='All Cadets'&&e.flight_scope==='All'&&e.status==='Active'),'IMPORT_ELIGIBILITY_UNPROVEN');
  const termIds=new Set(events.map(e=>e.termId));check(termIds.size===1,'IMPORT_CURRENT_TERM_AMBIGUOUS');
  const columns=new Map(current[0].columns.map((c,index)=>[c.eventId,{...c,displayOrder:index}]));
  check(columns.size===events.length&&events.every(e=>columns.has(e.eventId)),'IMPORT_EVENT_CATALOG_MISMATCH');
  const flights=new Map(),squadrons=new Map();
  for(const p of profiles)if(p.flightId){check(safeId(p.squadronId),'IMPORT_FLIGHT_SQUADRON_MISSING');const prior=flights.get(p.flightId);check(!prior||prior.squadronId===p.squadronId,'IMPORT_FLIGHT_HIERARCHY_CONFLICT');flights.set(p.flightId,{flightId:p.flightId,label:p.flightLabel,squadronId:p.squadronId});squadrons.set(p.squadronId,{squadronId:p.squadronId,label:p.squadronLabel});}
  const baseline=[];for(const row of current[0].rows)for(const event of row.events){check(event.eventId&&(event.code===null||['P','T','A','U','E','ES','MED','R','D','N/A'].includes(event.code)),'IMPORT_BASELINE_CODE');baseline.push({baselineId:stable('baseline',[snapshot.snapshotSha256,row.personId,event.eventId]),personId:row.personId,eventId:event.eventId,code:event.code,sourceOccurrenceId:row.occurrenceId,sourceColumnIndex:event.columnIndex});}
  check(baseline.length<=25000&&new Set(baseline.map(b=>`${b.personId}:${b.eventId}`)).size===baseline.length,'IMPORT_BASELINE_BOUND');
  const canonicalEvents=events.map(event=>{const week=/^(?:TW-)?(\d+)$/i.exec(event.training_week);check(!event.training_week||week,'IMPORT_TRAINING_WEEK');return {...event,trainingWeek:week?Number(week[1]):null,displayOrder:columns.get(event.eventId).displayOrder,eligiblePersonIds:roster,
    eligibilityEvidence:{kind:'import-time-current-matrix-and-directory',sourceMatrixResource:current[0].resourceKey,sourceMatrixSheetId:current[0].sheetId,expectedGroup:event.expected_group,flightScope:event.flight_scope,originalEventDayRoster:false}};});
  return {formatVersion:1,plan,profiles,events:canonicalEvents,flights:[...flights.values()],squadrons:[...squadrons.values()],term:{termId:[...termIds][0],label:events[0].term},baseline,roster,
    matrixSnapshots:reconciliation.matrixSnapshots,nativeProvenance:reconciliation.nativeProvenance.links,reviewReference:review.reviewReference,reconciliationSha256,
    summary:{profiles:profiles.length,activePeople:roster.length,events:events.length,baselines:baseline.length,occurrences:plan.ledger.length,matrixSnapshots:reconciliation.matrixSnapshots.length,matrixRows:reconciliation.matrixSnapshots.reduce((n,m)=>n+m.rows.length,0),nativeProvenance:reconciliation.nativeProvenance.links.length,historicalUnresolvedRows:reconciliation.summary.matrixPeopleUnresolved}};
}
function insert(table,columns,rows,runId,index){
  check(/^[a-z_]+$/.test(table)&&columns.every(c=>/^[a-z_]+$/.test(c)),'IMPORT_SQL_IDENTIFIER');
  return sql(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((_,i)=>`json_extract(j.value,'$[${i}]')`).join(',')} FROM json_each(?) j
    WHERE NOT EXISTS(SELECT 1 FROM legacy_import_batches WHERE import_run_id=? AND batch_index=?)`,JSON.stringify(rows),runId,index);
}
function splitRows(rows,maxBytes=240000){const groups=[];let group=[];for(const row of rows){check(Buffer.byteLength(JSON.stringify(row),'utf8')<=1_000_000,'IMPORT_ROW_TOO_LARGE');if(group.length&&(group.length>=100||Buffer.byteLength(JSON.stringify([...group,row]),'utf8')>maxBytes)){groups.push(group);group=[];}group.push(row);}if(group.length)groups.push(group);return groups;}
const pausedGuard=`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=0)
 AND EXISTS(SELECT 1 FROM notification_delivery_control WHERE singleton=1 AND mode='suppressed' AND daily_recipient_budget=0)
 AND NOT EXISTS(SELECT 1 FROM operation_commands) AND NOT EXISTS(SELECT 1 FROM outbox_jobs) AND NOT EXISTS(SELECT 1 FROM notification_intents) AND NOT EXISTS(SELECT 1 FROM admin_effects)`;
/** Each step is one atomic D1 batch. The caller must verify the explicit target binding and reviewed digest. */
export function createStagingImportPlan(snapshot,model,{generation,importedAt,sourceCommit=null}={}){
  check(Number.isSafeInteger(generation)&&generation>0&&typeof importedAt==='string'&&new Date(importedAt).toISOString()===importedAt,'IMPORT_EXECUTION_CONTEXT');
  check(sourceCommit===null||/^[a-f0-9]{40,64}$/.test(sourceCommit),'IMPORT_SOURCE_COMMIT');
  const runId=stable('import',snapshot.snapshotSha256),actorId='service:legacy-import',raw=rawOccurrences(snapshot),records=new Map(model.plan.records.map(r=>[r.occurrenceId,r]));
  const steps=[],pending=[];
  const add=(kind,table,columns,rows)=>{for(const group of splitRows(rows))pending.push({kind,table,columns,rows:group});};
  add('evidence','legacy_source_occurrences',['import_run_id','occurrence_id','fingerprint','source_kind','disposition','locator_json','raw_json','normalized_json','diagnostics_json'],model.plan.ledger.map(l=>{const value=raw.get(l.occurrenceId);check(value!==undefined&&importDigest(value)===l.fingerprint,'IMPORT_RAW_EVIDENCE_MISMATCH');return[runId,l.occurrenceId,l.fingerprint,l.kind,l.disposition,JSON.stringify(l.locator),JSON.stringify(value),records.has(l.occurrenceId)?JSON.stringify(records.get(l.occurrenceId)):null,JSON.stringify({issues:l.issues,warnings:l.warnings,binding:l.binding})];}));
  add('catalog','squadrons',['squadron_id','label'],model.squadrons.map(s=>[s.squadronId,s.label]));
  add('catalog','organizational_units',['unit_id','label','roster_version'],model.flights.map(f=>[f.flightId,f.label,1]));
  add('catalog','flight_hierarchy',['unit_id','squadron_id'],model.flights.map(f=>[f.flightId,f.squadronId]));
  add('catalog','terms',['term_id','label','sort_order','is_current'],[[model.term.termId,model.term.label,1,1]]);
  add('profiles','people',['person_id','display_name'],model.profiles.map(p=>[p.personId,`${p.profile.lastName}, ${p.profile.firstName}`]));
  const fields=['lastName','firstName','asYear','rank','role','university','email','phone','dorm','cipBroadArea','cipCode','afsc','homeTown','homeState','classYear','dateOfBirth','flightPathStatus','photoLink'];
  add('profiles','directory_profiles',['person_id','version','flight_id','last_name','first_name','as_year','rank','role','university','email','phone','dorm','cip_broad_area','cip_code','afsc','home_town','home_state','class_year','date_of_birth','flight_path_status','photo_link','updated_at'],model.profiles.map(p=>[p.personId,1,p.flightId??null,...fields.map(k=>p.profile[k]),importedAt]));
  add('profiles','memberships',['person_id','unit_id','active'],model.profiles.filter(p=>p.flightId).map(p=>[p.personId,p.flightId,inactive.has(p.profile.flightPathStatus)?0:1]));
  add('profiles','legacy_profile_sources',['person_id','import_run_id','source_occurrence_id'],model.profiles.map(p=>[p.personId,runId,p.occurrenceId]));
  add('events','events',['event_id','label','active'],model.events.map(e=>[e.eventId,e.display_name||e.attendance_column_label,1]));
  const eventCommand=e=>stable('import-event',[runId,e.eventId]);
  add('events','command_registry',['command_id','ledger'],model.events.map(e=>[eventCommand(e),'admin']));
  add('events','admin_commands',['command_id','payload_hash','actor_id','operation','target_id','capability','scopes_json','source_kind','source_resource','source_submission','source_revision','accepted_at','receipt_json'],model.events.map(e=>[eventCommand(e),importDigest(e),actorId,'legacy.event-import',e.eventId,'events.manage','[]','legacy-snapshot',runId,e.occurrenceId,1,importedAt,JSON.stringify({commandId:eventCommand(e),status:'committed',operation:'legacy.event-import',result:{eventId:e.eventId,version:1,importRunId:runId},pendingEffects:false})]));
  add('events','admin_audit_events',['command_id','actor_id','actor_evidence','operation','target_id','accepted_at','before_json','after_json'],model.events.map(e=>[eventCommand(e),actorId,'reviewed-initial-staging-import','legacy.event-import',e.eventId,importedAt,'{}',JSON.stringify({importRunId:runId,sourceOccurrenceId:e.occurrenceId,eligibilityEvidence:e.eligibilityEvidence})]));
  add('events','event_details',['event_id','version','term_id','event_type','training_week','display_order','column_label','expected_group','status','start_at','end_at','location','notes','created_at','created_by','updated_at'],model.events.map(e=>[e.eventId,1,e.termId,e.event_type.toLowerCase(),e.trainingWeek,e.displayOrder,e.attendance_column_label,e.expected_group,e.status.toLowerCase(),e.startAt,e.endAt,e.location,e.notes,importedAt,actorId,importedAt]));
  add('events','event_units',['event_id','unit_id'],model.events.flatMap(e=>model.flights.map(f=>[e.eventId,f.flightId])));
  add('events','event_roster_versions',['event_id','version','command_id','accepted_at'],model.events.map(e=>[e.eventId,1,eventCommand(e),importedAt]));
  const byId=new Map(model.profiles.map(p=>[p.personId,p]));
  add('events','event_roster_members',['event_id','version','person_id','flight_id','last_name','first_name','as_year','flight_path_status','date_of_birth'],model.events.flatMap(e=>e.eligiblePersonIds.map(id=>{const p=byId.get(id);return[e.eventId,1,id,p.flightId,p.profile.lastName,p.profile.firstName,p.profile.asYear,p.profile.flightPathStatus,p.profile.dateOfBirth];})));
  add('events','legacy_event_sources',['event_id','import_run_id','source_occurrence_id','eligibility_evidence_json'],model.events.map(e=>[e.eventId,runId,e.occurrenceId,JSON.stringify(e.eligibilityEvidence)]));
  add('baselines','legacy_attendance_baselines',['baseline_id','person_id','event_id','code','import_run_id','source_occurrence_id','source_column_index'],model.baseline.map(b=>[b.baselineId,b.personId,b.eventId,b.code,runId,b.sourceOccurrenceId,b.sourceColumnIndex]));
  const matrixId=m=>stable('matrix',[runId,m.resourceKey,m.sheetId]);
  add('history','legacy_matrix_snapshots',['matrix_snapshot_id','import_run_id','source_resource_key','source_sheet_id','metadata_json','roster_json'],model.matrixSnapshots.map(m=>{const {rows,sourceRoster,...metadata}=m;return[matrixId(m),runId,m.resourceKey,m.sheetId,JSON.stringify(metadata),JSON.stringify(sourceRoster)];}));
  add('history','legacy_matrix_snapshot_rows',['matrix_snapshot_id','source_occurrence_id','person_id','payload_json'],model.matrixSnapshots.flatMap(m=>m.rows.map(r=>[matrixId(m),r.occurrenceId,r.personId,JSON.stringify(r)])));
  add('provenance','legacy_native_response_provenance',['import_run_id','source_occurrence_id','form_resource_key','response_id','evidence_json'],model.nativeProvenance.map(p=>[runId,p.occurrenceId,p.formKey,p.responseId,JSON.stringify(p)]));
  for(const [index,group] of pending.entries()){
    const payloadSha256=importDigest(group),assertionId=`${runId}:batch:${index}`;
    const guard=sql(`INSERT INTO legacy_import_assertions(assertion_id,ok) SELECT ?,CASE WHEN ${pausedGuard}
      AND EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND state='loading' AND snapshot_sha256=?)
      AND NOT EXISTS(SELECT 1 FROM legacy_import_batches WHERE import_run_id=? AND batch_index=? AND payload_sha256<>?) THEN 1 ELSE 0 END
      ON CONFLICT(assertion_id) DO UPDATE SET ok=excluded.ok`,assertionId,generation,runId,snapshot.snapshotSha256,runId,index,payloadSha256);
    steps.push({index,kind:group.kind,payloadSha256,rows:group.rows.length,table:group.table,columns:group.columns,batch:[guard,insert(group.table,group.columns,group.rows,runId,index),sql('INSERT INTO legacy_import_batches VALUES(?,?,?,?) ON CONFLICT(import_run_id,batch_index) DO NOTHING',runId,index,payloadSha256,importedAt)]});
  }
  const manifest={counts:model.summary,batches:steps.map(s=>({index:s.index,payloadSha256:s.payloadSha256,table:s.table,rows:s.rows}))};
  const init=[sql(`INSERT INTO legacy_import_assertions VALUES(?,CASE WHEN ${pausedGuard}
    AND NOT EXISTS(SELECT 1 FROM people) AND NOT EXISTS(SELECT 1 FROM events) AND NOT EXISTS(SELECT 1 FROM principals)
    AND NOT EXISTS(SELECT 1 FROM organizational_units) AND NOT EXISTS(SELECT 1 FROM terms)
    AND NOT EXISTS(SELECT 1 FROM admin_commands) AND NOT EXISTS(SELECT 1 FROM legacy_import_runs) THEN 1 ELSE 0 END)`,`${runId}:initialize`,generation),
    sql('INSERT INTO legacy_import_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',runId,snapshot.snapshotSha256,model.plan.planSha256,model.reconciliationSha256,model.reviewReference,'staging',generation,'loading',model.summary.occurrences,model.summary.profiles,model.summary.events,model.summary.baselines,steps.length,JSON.stringify(manifest),importedAt,null),
    sql('INSERT INTO principals VALUES(?,NULL,0)',actorId)];
  // Counts plus complete batch hashes are checked before the baseline becomes visible to the Worker.
  const finishGuard=`${pausedGuard} AND EXISTS(SELECT 1 FROM legacy_import_runs r WHERE r.import_run_id=? AND r.state='loading'
    AND r.expected_occurrences=(SELECT COUNT(*) FROM legacy_source_occurrences WHERE import_run_id=r.import_run_id)
    AND r.expected_profiles=(SELECT COUNT(*) FROM legacy_profile_sources WHERE import_run_id=r.import_run_id)
    AND r.expected_events=(SELECT COUNT(*) FROM legacy_event_sources WHERE import_run_id=r.import_run_id)
    AND r.expected_baselines=(SELECT COUNT(*) FROM legacy_attendance_baselines WHERE import_run_id=r.import_run_id)
    AND r.expected_batches=(SELECT COUNT(*) FROM legacy_import_batches WHERE import_run_id=r.import_run_id)
    AND NOT EXISTS(SELECT 1 FROM json_each(r.manifest_json,'$.batches') e WHERE NOT EXISTS(SELECT 1 FROM legacy_import_batches b WHERE b.import_run_id=r.import_run_id AND b.batch_index=json_extract(e.value,'$.index') AND b.payload_sha256=json_extract(e.value,'$.payloadSha256'))))`;
  const finish=[sql(`INSERT INTO legacy_import_assertions VALUES(?,CASE WHEN ${finishGuard} THEN 1 ELSE 0 END)`,`${runId}:complete`,generation,runId),sql("UPDATE legacy_import_runs SET state='complete',completed_at=? WHERE import_run_id=? AND state='loading'",importedAt,runId)];
  const result={formatVersion:1,environment:'staging',generation,requiredSchemaVersion:8,sourceCommit,rehearsalOnly:sourceCommit===null,importRunId:runId,snapshotSha256:snapshot.snapshotSha256,reviewReference:model.reviewReference,summary:model.summary,init,steps,finish,
    requirements:{newEmptyDatabase:true,acceptingCommands:false,notificationMode:'suppressed',atomicBatchRequired:true,providerTargetBindingRequired:true,readbackBeforeFinish:true,productionAllowed:false}};
  for(const step of [...[init],...steps.map(s=>s.batch),finish]){check(Buffer.byteLength(JSON.stringify(step),'utf8')<=1_800_000,'IMPORT_BATCH_BYTES');for(const statement of step){check(statement.params.length<=100&&Buffer.byteLength(statement.sql,'utf8')<=100000,'IMPORT_SQL_BOUND');}}
  result.executionSha256=importDigest(result);return result;
}
/** Inspect-only helper for the operator runner; payload values are intentionally omitted. */
export function stagingImportSummary(plan){return {importRunId:plan.importRunId,executionSha256:plan.executionSha256,schemaVersion:plan.requiredSchemaVersion,generation:plan.generation,...plan.summary,batches:plan.steps.length,sourceCommit:plan.sourceCommit,rehearsalOnly:plan.rehearsalOnly,transportBatches:packStagingImportBatches(plan).length,maximumBatchStatements:Math.max(plan.init.length,...packStagingImportBatches(plan).map(s=>s.batch.length),plan.finish.length),writeEstimate:estimateStagingImportWrites(plan),notifications:'suppressed',productionChanges:false};}
/** Pack ordered idempotent steps, without widening any guard, under a conservative transport bound. */
export function packStagingImportBatches(plan){
  const groups=[];let batch=[],indices=[];
  for(const step of plan.steps){if(batch.length&&(batch.length+step.batch.length>48||Buffer.byteLength(JSON.stringify([...batch,...step.batch]),'utf8')>1_800_000)){groups.push({indices,batch});batch=[];indices=[];}batch.push(...step.batch);indices.push(step.index);}
  if(batch.length)groups.push({indices,batch});return groups;
}
export function assertStagingImportTarget(plan,target,observed,approvedHash){
  const {executionSha256,...body}=plan;check(executionSha256===importDigest(body)&&approvedHash===executionSha256,'IMPORT_EXECUTION_HASH');
  check(plan.rehearsalOnly===false&&/^[a-f0-9]{40,64}$/.test(plan.sourceCommit),'IMPORT_SOURCE_COMMIT');
  check(target?.environment==='staging'&&['databaseId','accountId','name'].every(k=>typeof target[k]==='string'&&target[k].length>0&&target[k]===observed?.[k])&&target.generation===plan.generation&&observed.environment==='staging'&&observed.generation===plan.generation&&observed.acceptingCommands===false&&observed.notificationMode==='suppressed'&&observed.schemaVersion===8,'IMPORT_TARGET_BINDING');
  return true;
}
const PRIMARY_KEYS={legacy_source_occurrences:['import_run_id','occurrence_id'],squadrons:['squadron_id'],organizational_units:['unit_id'],flight_hierarchy:['unit_id'],terms:['term_id'],people:['person_id'],directory_profiles:['person_id'],memberships:['person_id','unit_id'],legacy_profile_sources:['person_id'],events:['event_id'],command_registry:['command_id'],admin_commands:['command_id'],admin_audit_events:['command_id'],event_details:['event_id'],event_units:['event_id','unit_id'],event_roster_versions:['event_id','version'],event_roster_members:['event_id','version','person_id'],legacy_event_sources:['event_id'],legacy_attendance_baselines:['baseline_id'],legacy_matrix_snapshots:['matrix_snapshot_id'],legacy_matrix_snapshot_rows:['matrix_snapshot_id','source_occurrence_id'],legacy_native_response_provenance:['import_run_id','source_occurrence_id']};
/** Compare actual stored values (including raw typed evidence), not copied hash columns or counts alone. */
export async function verifyStagingImportReadback(plan,{readBatch,expectedRunState='loading'}){
  const {executionSha256,...body}=plan;check(importDigest(body)===executionSha256,'IMPORT_EXECUTION_HASH');
  check(['loading','complete'].includes(expectedRunState),'IMPORT_READBACK_STATE');
  const tables=new Map(),differences=[];let checkedRows=0,checkedSteps=0;
  const queries=plan.steps.map(step=>{
    const keys=PRIMARY_KEYS[step.table];check(keys&&step.columns.every(c=>/^[a-z_]+$/.test(c)),'IMPORT_READBACK_TABLE');
    const rows=JSON.parse(step.batch[1].params[0]);tables.set(step.table,(tables.get(step.table)??0)+rows.length);
    const keyIndexes=keys.map(k=>step.columns.indexOf(k));check(keyIndexes.every(i=>i>=0),'IMPORT_READBACK_KEY');
    const ids=rows.map(r=>keyIndexes.map(i=>r[i]));
    const statement=sql(`SELECT ${step.columns.map(c=>`t.${c}`).join(',')} FROM json_each(?) k JOIN ${step.table} t ON ${keys.map((key,i)=>`t.${key}=json_extract(k.value,'$[${i}]')`).join(' AND ')}`,JSON.stringify(ids));
    return {step,rows,keyIndexes,statement,bytes:Buffer.byteLength(JSON.stringify(rows),'utf8')};
  });
  let cursor=0;
  while(cursor<queries.length){const group=[];let bytes=0;while(cursor<queries.length&&group.length<32&&(!group.length||bytes+queries[cursor].bytes<8_000_000)){bytes+=queries[cursor].bytes;group.push(queries[cursor++]);}
    const results=await readBatch(group.map(g=>g.statement));check(Array.isArray(results)&&results.length===group.length,'IMPORT_READBACK_RESPONSE');
    for(let index=0;index<group.length;index++){
      const {step,rows,keyIndexes}=group[index],observed=results[index].results??results[index];check(Array.isArray(observed),'IMPORT_READBACK_RESPONSE');
      const expected=new Map(rows.map(r=>[JSON.stringify(keyIndexes.map(i=>r[i])),importDigest(r)])),seen=new Set();
      for(const value of observed){const actual=step.columns.map(c=>value[c]),key=JSON.stringify(keyIndexes.map(i=>actual[i]));if(seen.has(key)||expected.get(key)!==importDigest(actual))differences.push({code:'stored-value-mismatch',table:step.table,stepIndex:step.index});seen.add(key);}
      if(observed.length!==rows.length||[...expected.keys()].some(key=>!seen.has(key)))differences.push({code:'stored-row-coverage-mismatch',table:step.table,stepIndex:step.index});
      checkedRows+=observed.length;checkedSteps++;
    }
  }
  const counts=await readBatch([...tables].map(([table])=>sql(`SELECT COUNT(*) AS count FROM ${table}`)));
  check(counts.length===tables.size,'IMPORT_READBACK_RESPONSE');let index=0;for(const [table,expected]of tables){const values=counts[index++].results??counts[index-1];if(values[0]?.count!==expected)differences.push({code:'stored-table-count-mismatch',table});}
  const control=await readBatch([sql(`SELECT (${pausedGuard}) AS paused`,plan.generation),sql('SELECT state,snapshot_sha256 AS snapshotSha256,expected_batches AS expectedBatches FROM legacy_import_runs WHERE import_run_id=?',plan.importRunId)]);
  const rows=control.map(r=>r.results??r);if(rows[0][0]?.paused!==1||rows[1][0]?.state!==expectedRunState||rows[1][0]?.snapshotSha256!==plan.snapshotSha256||rows[1][0]?.expectedBatches!==plan.steps.length)differences.push({code:'import-fence-or-binding-mismatch'});
  return {verified:differences.length===0,executionSha256,checkedRows,checkedSteps,differences};
}

// Reviewed migration-8 indexes, including automatic PRIMARY KEY/UNIQUE indexes.
// The fixture checks these against SQLite; count partial indexes conservatively for every inserted row.
export const STAGING_IMPORT_INDEX_COUNTS=Object.freeze({legacy_source_occurrences:1,squadrons:2,organizational_units:1,flight_hierarchy:1,terms:3,people:1,directory_profiles:2,memberships:2,legacy_profile_sources:1,events:1,command_registry:1,admin_commands:2,admin_audit_events:1,event_details:2,event_units:1,event_roster_versions:2,event_roster_members:2,legacy_event_sources:1,legacy_attendance_baselines:3,legacy_matrix_snapshots:1,legacy_matrix_snapshot_rows:1,legacy_native_response_provenance:1,legacy_import_assertions:1,legacy_import_runs:2,legacy_import_batches:1,principals:1});
/** Conservative planning estimate; actual provider rows_written and account-wide usage remain authoritative. */
export function estimateStagingImportWrites(plan){
  const {executionSha256,...body}=plan;check(executionSha256===importDigest(body),'IMPORT_EXECUTION_HASH');
  const cost=table=>{check(Number.isInteger(STAGING_IMPORT_INDEX_COUNTS[table]),'IMPORT_WRITE_ESTIMATE_SCHEMA');return 1+STAGING_IMPORT_INDEX_COUNTS[table];};
  const guardAndReceipt=cost('legacy_import_assertions')+cost('legacy_import_batches');
  const steps=plan.steps.map(step=>({index:step.index,estimatedWrites:step.rows*cost(step.table)+guardAndReceipt}));
  const byIndex=new Map(steps.map(s=>[s.index,s.estimatedWrites]));
  const transportBatches=packStagingImportBatches(plan).map(group=>({indices:group.indices,estimatedWrites:group.indices.reduce((sum,index)=>sum+byIndex.get(index),0)}));
  const initialization=cost('legacy_import_assertions')+cost('legacy_import_runs')+cost('principals'),completion=cost('legacy_import_assertions')+cost('legacy_import_runs');
  return {schemaVersion:8,initialization,completion,total:initialization+completion+steps.reduce((sum,s)=>sum+s.estimatedWrites,0),maximumStep:Math.max(0,...steps.map(s=>s.estimatedWrites)),maximumTransportBatch:Math.max(initialization,completion,...transportBatches.map(b=>b.estimatedWrites)),retryGuardAndReceiptPerStep:guardAndReceipt,transportBatches};
}
/** Require a fresh account-wide UTC-day sample; never enable billing or treat an estimate as actual usage. */
export function assessStagingImportQuota({accountId,usage,now,estimatedWrites,localWritesSinceObservation=0,reserve=10000}){
  const at=Date.parse(now),sample=Date.parse(usage?.observedAt);
  check(typeof accountId==='string'&&accountId.length>0&&usage?.accountId===accountId&&Number.isFinite(at)&&Number.isFinite(sample)&&at>=sample&&at-sample<=300000&&new Date(at).toISOString().slice(0,10)===new Date(sample).toISOString().slice(0,10),'IMPORT_QUOTA_SAMPLE');
  check([usage.rowsWritten,estimatedWrites,localWritesSinceObservation,reserve].every(v=>Number.isSafeInteger(v)&&v>=0)&&reserve>=10000&&reserve<=100000,'IMPORT_QUOTA_INPUT');
  const accountedWrites=usage.rowsWritten+localWritesSinceObservation,remaining=100000-reserve-accountedWrites;
  return {allowed:estimatedWrites<=remaining,utcDate:new Date(at).toISOString().slice(0,10),dailyLimit:100000,reserve,accountedWrites,estimatedWrites,remainingBeforeBatch:Math.max(0,remaining),remainingAfterBatch:Math.max(0,remaining-estimatedWrites)};
}
/** Inspect the durable prefix after an ambiguous response or quota pause. Never initialize a resumed run again. */
export async function inspectStagingImportResume(plan,{readBatch}){
  const {executionSha256,...body}=plan;check(executionSha256===importDigest(body),'IMPORT_EXECUTION_HASH');
  const results=await readBatch([sql(`SELECT (${pausedGuard}) AS paused`,plan.generation),sql('SELECT * FROM legacy_import_runs WHERE import_run_id=?',plan.importRunId),sql('SELECT batch_index,payload_sha256 FROM legacy_import_batches WHERE import_run_id=? ORDER BY batch_index',plan.importRunId)]);
  check(Array.isArray(results)&&results.length===3,'IMPORT_RESUME_RESPONSE');const values=results.map(r=>r.results??r);check(values.every(Array.isArray),'IMPORT_RESUME_RESPONSE');
  check(values[0][0]?.paused===1,'IMPORT_RESUME_FENCE');
  const run=values[1][0],receipts=values[2];
  if(!run){check(receipts.length===0,'IMPORT_RESUME_RECEIPTS');return {phase:'initialize',completedSteps:0,pendingBatches:packStagingImportBatches(plan)};}
  const columns=['import_run_id','snapshot_sha256','plan_sha256','reconciliation_sha256','review_reference','environment','generation','state','expected_occurrences','expected_profiles','expected_events','expected_baselines','expected_batches','manifest_json','started_at','completed_at'];
  const expected=Object.fromEntries(columns.map((name,index)=>[name,plan.init[1].params[index]]));
  check(values[1].length===1&&['loading','complete'].includes(run.state)&&columns.filter(c=>!['state','completed_at'].includes(c)).every(c=>run[c]===expected[c]),'IMPORT_RESUME_BINDING');
  check(receipts.length<=plan.steps.length&&receipts.every((r,index)=>r.batch_index===index&&r.payload_sha256===plan.steps[index].payloadSha256),'IMPORT_RESUME_RECEIPTS');
  if(run.state==='complete'){check(receipts.length===plan.steps.length&&run.completed_at===plan.finish[1].params[0],'IMPORT_RESUME_COMPLETION');return {phase:'complete',completedSteps:receipts.length,pendingBatches:[]};}
  const remaining={...plan,steps:plan.steps.slice(receipts.length)};
  return {phase:'loading',completedSteps:receipts.length,pendingBatches:packStagingImportBatches(remaining)};
}
