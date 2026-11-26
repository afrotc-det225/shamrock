/** Reviewed, bounded refresh of an already imported paused staging database.
 * Provider-neutral: callers supply a verified backup and explicit reviewed row deltas.
 * Old evidence is append-only. Stable canonical keys and native Google bindings survive.
 */
import {importDigest} from './import-capture.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
const sql=(sql,...params)=>({sql,params});
const stable=(kind,value)=>`${kind}:legacy:${importDigest(value).slice(0,32)}`;
const keyOf=(row,keys)=>JSON.stringify(keys.map(k=>row[k]));
const same=(a,b)=>importDigest(a)===importDigest(b);
const specs={
  command_registry:{keys:['command_id'],mode:'append'},
  admin_commands:{keys:['command_id'],mode:'append'},
  admin_audit_events:{keys:['command_id'],mode:'append'},
  people:{keys:['person_id'],mode:'update'},
  directory_profiles:{keys:['person_id'],mode:'update',version:true},
  legacy_profile_sources:{keys:['person_id'],mode:'update'},
  events:{keys:['event_id'],mode:'update'},
  event_details:{keys:['event_id'],mode:'update',version:true},
  legacy_event_sources:{keys:['event_id'],mode:'update'},
  legacy_attendance_baselines:{keys:['baseline_id'],mode:'update'},
  leadership_contacts:{keys:['contact_id'],mode:'upsert',version:true},
  excusal_records:{keys:['request_id'],mode:'upsert',version:true},
  excusal_request_scopes:{keys:['request_id'],mode:'append'},
  event_roster_versions:{keys:['event_id','version'],mode:'append'},
  event_roster_members:{keys:['event_id','version','person_id'],mode:'append'},
  legacy_source_occurrences:{keys:['import_run_id','occurrence_id'],mode:'evidence'},
  legacy_matrix_snapshots:{keys:['matrix_snapshot_id'],mode:'evidence'},
  legacy_matrix_snapshot_rows:{keys:['matrix_snapshot_id','source_occurrence_id'],mode:'evidence'},
  legacy_native_response_provenance:{keys:['import_run_id','source_occurrence_id'],mode:'evidence'},
  legacy_operational_adoptions:{keys:['adoption_id'],mode:'evidence'},
  legacy_operational_adoption_rows:{keys:['adoption_id','source_occurrence_id'],mode:'evidence'},
};
export const INCREMENTAL_IMPORT_TABLES=Object.freeze(Object.keys(specs));
const paused=`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=0)
 AND EXISTS(SELECT 1 FROM notification_delivery_control WHERE singleton=1 AND mode='suppressed' AND daily_recipient_budget=0)
 AND NOT EXISTS(SELECT 1 FROM operation_commands) AND NOT EXISTS(SELECT 1 FROM outbox_jobs)
 AND NOT EXISTS(SELECT 1 FROM notification_intents) AND NOT EXISTS(SELECT 1 FROM admin_effects)
 AND NOT EXISTS(SELECT 1 FROM excusal_notification_tasks) AND NOT EXISTS(SELECT 1 FROM excusal_record_decisions)`;
function split(rows){const chunks=[];let chunk=[];for(const r of rows){check(Buffer.byteLength(JSON.stringify(r))<900000,'REFRESH_ROW_BOUND');if(chunk.length&&(chunk.length>=100||Buffer.byteLength(JSON.stringify([...chunk,r]))>240000)){chunks.push(chunk);chunk=[];}chunk.push(r);}if(chunk.length)chunks.push(chunk);return chunks;}
const loading=`EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND state='loading')`;
function insertRows(group,runId){return sql(`INSERT INTO ${group.table}(${group.columns.join(',')}) SELECT ${group.columns.map((_,i)=>`json_extract(j.value,'$[${i}]')`).join(',')} FROM json_each(?) j WHERE ${loading}`,JSON.stringify(group.rows),runId);}
function validateRows(table,rows){check(specs[table]&&Array.isArray(rows)&&rows.length<=30000,'REFRESH_TABLE');const columns=Object.keys(rows[0]??{});check(columns.length>0&&columns.every(c=>/^[a-z][a-z0-9_]*$/.test(c))&&specs[table].keys.every(k=>columns.includes(k)),'REFRESH_COLUMNS');check(rows.every(r=>same(Object.keys(r).sort(),[...columns].sort())&&Object.values(r).every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v))),'REFRESH_VALUES');check(new Set(rows.map(r=>keyOf(r,specs[table].keys))).size===rows.length,'REFRESH_DUPLICATE_KEY');return columns;}
/** Contact IDs in the first importer were row-derived. Preserve them after source row insertion/sorting. */
export function matchRefreshContacts(existing,incoming){
  const by=(items,key)=>{const out=new Map();for(const item of items){const v=key(item);if(v){const a=out.get(v)??[];a.push(item);out.set(v,a);}}return out;};
  const norm=v=>String(v??'').trim().toLowerCase(),identity=r=>[r.last_name,r.first_name,r.email].map(norm).join('|');
  const persons=by(existing,r=>r.person_id),manual=by(existing.filter(r=>!r.person_id),identity),used=new Set();
  return incoming.map(r=>{const matches=r.person_id?persons.get(r.person_id)??[]:manual.get(identity(r))??[];check(matches.length<=1,'REFRESH_CONTACT_AMBIGUOUS');const contact_id=matches[0]?.contact_id??stable('contact-refresh',[r.person_id??null,identity(r)]);check(!used.has(contact_id),'REFRESH_CONTACT_COLLISION');used.add(contact_id);return {...r,contact_id};});
}
/** No deletes, no key replacement, no initial-import replay, no notification effects. */
export function createIncrementalImportPlan({before,desired,evidence,context,review}){
  check(context?.environment==='staging'&&Number.isSafeInteger(context.generation)&&context.generation>0&&context.schemaVersion===16,'REFRESH_CONTEXT');
  check(/^[a-f0-9]{64}$/.test(context.backupSha256??'')&&/^[a-f0-9]{40,64}$/.test(context.sourceCommit??'')&&Number.isSafeInteger(context.administrationRevision)&&context.administrationRevision>=0&&new Date(context.importedAt).toISOString()===context.importedAt,'REFRESH_BACKUP');
  check(review?.reviewReference&&review.preserveCanonicalKeys===true&&review.preserveOriginalEvidence===true&&review.suppressNotifications===true&&Array.isArray(review.sourceSnapshots)&&review.sourceSnapshots.length>0&&review.sourceSnapshots.every(s=>/^[a-f0-9]{64}$/.test(s.snapshotSha256)&&s.consistent===true),'REFRESH_REVIEW');
  check(evidence?.run&&Array.isArray(evidence.groups)&&evidence.groups.length>0&&/^[a-f0-9]{64}$/.test(evidence.run.snapshot_sha256??''),'REFRESH_EVIDENCE');
  const permission=before.permission_policy_control?.[0];check(permission&&permission.singleton===1&&Number.isSafeInteger(permission.version),'REFRESH_PERMISSION_BASELINE');
  const schema=before.shamrock_migrations;check(Array.isArray(schema)&&schema.length===16&&schema.map(r=>r.version).sort((a,b)=>a-b).every((v,i)=>v===i+1),'REFRESH_SCHEMA');
  const runId=evidence.run.import_run_id,commandId=stable('refresh-audit',[runId,context.backupSha256]),groups=[],changes=[];
  for(const [table,rows]of Object.entries(desired)){
    if(!rows.length)continue;if(table==='admin_commands')check(rows.every(r=>r.operation==='legacy.refresh-event'&&r.actor_id==='service:legacy-import'&&r.source_resource===runId),'REFRESH_ADMIN_COMMAND');const columns=validateRows(table,rows),spec=specs[table];check(spec.mode!=='evidence','REFRESH_EVIDENCE_PHASE');
    const oldRows=before[table];check(Array.isArray(oldRows),'REFRESH_BEFORE_MISSING');const old=new Map(oldRows.map(r=>[keyOf(r,spec.keys),r]));
    const inserts=[];for(const row of rows){const prior=old.get(keyOf(row,spec.keys));if(prior){check(!['append'].includes(spec.mode),'REFRESH_APPEND_COLLISION');check(same(Object.keys(prior).sort(),[...columns].sort()),'REFRESH_BEFORE_COLUMNS');if(same(prior,row))continue;
        if(spec.version)check(row.version===prior.version+1,'REFRESH_VERSION');
        if(table==='legacy_attendance_baselines'){
          check(row.person_id===prior.person_id&&row.event_id===prior.event_id,'REFRESH_BASELINE_TARGET');
          check(row.import_run_id===runId,'REFRESH_BASELINE_EVIDENCE');
        }
        if(table==='leadership_contacts')check(row.person_id===prior.person_id,'REFRESH_CONTACT_TARGET');
        if(table==='excusal_records')check(['person_id','event_id','unit_id','origin','submitted_by','command_id','last_command_id'].every(k=>row[k]===prior[k])&&row.origin==='legacy'&&row.last_command_id===null,'REFRESH_REQUEST_TARGET');
        changes.push({table,columns,keys:spec.keys,before:columns.map(c=>prior[c]),after:columns.map(c=>row[c])});
      }else{if(table==='legacy_attendance_baselines')check(row.import_run_id===runId,'REFRESH_BASELINE_EVIDENCE');check(['append','upsert'].includes(spec.mode),'REFRESH_EXISTING_KEY_REQUIRED');if(spec.version)check(row.version===1,'REFRESH_VERSION');inserts.push(columns.map(c=>row[c]));}}
    for(const rows of split(inserts))groups.push({table,columns,rows});
  }
  check(changes.length+groups.reduce((n,g)=>n+g.rows.length,0)>0,'REFRESH_EMPTY');
  const evidenceGroups=[];for(const group of evidence.groups){check(specs[group.table]?.mode==='evidence','REFRESH_EVIDENCE_TABLE');const rows=group.rows.map(r=>Object.fromEntries(group.columns.map((c,i)=>[c,r[i]])));validateRows(group.table,rows);for(const chunk of split(group.rows))evidenceGroups.push({...group,rows:chunk});}
  check(new Set(evidenceGroups.flatMap(g=>g.rows.map(r=>`${g.table}:${keyOf(Object.fromEntries(g.columns.map((c,i)=>[c,r[i]])),specs[g.table].keys)}`))).size===evidenceGroups.reduce((n,g)=>n+g.rows.length,0),'REFRESH_DUPLICATE_EVIDENCE');
  const patchGroups=[];for(const table of Object.keys(specs)){const selected=changes.filter(c=>c.table===table);for(const chunk of split(selected)){patchGroups.push({table,columns:chunk[0].columns,keys:chunk[0].keys,changes:chunk});}}
  groups.sort((a,b)=>(['command_registry','admin_commands','admin_audit_events'].includes(a.table)?-1:0)-(['command_registry','admin_commands','admin_audit_events'].includes(b.table)?-1:0));
  const administrationDelta=1+(desired.admin_commands?.length??0);
  const manifest={permissionPolicyVersion:permission.version,permissionPolicyHash:permission.policy_hash,schemaLedgerSha256:importDigest(schema),administrationDelta,kind:'reviewed-incremental-staging-refresh',backupSha256:context.backupSha256,sourceSnapshots:review.sourceSnapshots,sourceCommit:context.sourceCommit,reviewReference:review.reviewReference,administrationRevision:context.administrationRevision,changes:changes.length,inserts:groups.reduce((n,g)=>n+g.rows.length,0),evidenceRows:evidenceGroups.reduce((n,g)=>n+g.rows.length,0),reviewSha256:importDigest(review),desiredSha256:importDigest(desired),evidenceSha256:importDigest(evidence)};
  const bindingSha256=importDigest(manifest),completed=`EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND state='complete' AND plan_sha256=?)`;
  const assertion=(suffix,condition,params)=>sql(`INSERT INTO legacy_import_assertions VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END) ON CONFLICT(assertion_id) DO UPDATE SET ok=excluded.ok`,`${runId}:${suffix}`,...params);
  const fence=()=>assertion('fence',`${paused} AND EXISTS(SELECT 1 FROM permission_policy_control WHERE singleton=1 AND enabled=? AND version=? AND policy_hash IS ? AND last_command_id IS ?) AND NOT EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE state='leased') AND (SELECT COUNT(*) FROM shamrock_migrations)=16 AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM shamrock_migrations m WHERE m.version=json_extract(j.value,'$.version') AND m.name=json_extract(j.value,'$.name') AND m.sha256=json_extract(j.value,'$.sha256') AND m.source_commit=json_extract(j.value,'$.source_commit') AND m.environment=json_extract(j.value,'$.environment') AND m.applied_at=json_extract(j.value,'$.applied_at'))) AND ((SELECT COUNT(*) FROM admin_commands)=? OR (${completed} AND (SELECT COUNT(*) FROM admin_commands)=?))`,[context.generation,permission.enabled,permission.version,permission.policy_hash,permission.last_command_id,JSON.stringify(schema),context.administrationRevision,runId,bindingSha256,context.administrationRevision+administrationDelta]);
  const run={...evidence.run,plan_sha256:bindingSha256,review_reference:review.reviewReference,environment:'staging',generation:context.generation,state:'loading',expected_batches:evidenceGroups.length,manifest_json:JSON.stringify(manifest),started_at:context.importedAt,completed_at:null};
  check(run.expected_occurrences===evidenceGroups.filter(g=>g.table==='legacy_source_occurrences').reduce((n,g)=>n+g.rows.length,0),'REFRESH_OCCURRENCE_COUNT');
  const runColumns=Object.keys(run);const initialize=[fence(),assertion('binding',`NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND (plan_sha256<>? OR snapshot_sha256<>?))`,[runId,bindingSha256,run.snapshot_sha256]),sql(`INSERT INTO legacy_import_runs(${runColumns.join(',')}) SELECT ${runColumns.map(()=>'?').join(',')} WHERE NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=?)`,...runColumns.map(c=>run[c]),runId)];
  const steps=evidenceGroups.map((group,index)=>{const payloadSha256=importDigest(group);return {index,table:group.table,columns:group.columns,rows:group.rows,payloadSha256,batch:[fence(),assertion(`batch:${index}`,`EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND plan_sha256=?) AND NOT EXISTS(SELECT 1 FROM legacy_import_batches WHERE import_run_id=? AND batch_index=? AND payload_sha256<>?)`,[runId,bindingSha256,runId,index,payloadSha256]),sql(`${insertRows(group,runId).sql} AND NOT EXISTS(SELECT 1 FROM legacy_import_batches WHERE import_run_id=? AND batch_index=?)`,...insertRows(group,runId).params,runId,index),sql(`INSERT INTO legacy_import_batches VALUES(?,?,?,?) ON CONFLICT(import_run_id,batch_index) DO NOTHING`,runId,index,payloadSha256,context.importedAt)]};});
  const finish=[fence(),assertion('all-evidence',`EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND plan_sha256=?) AND (SELECT COUNT(*) FROM legacy_import_batches WHERE import_run_id=?)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM legacy_import_batches b WHERE b.import_run_id=? AND b.batch_index=json_extract(j.value,'$.index') AND b.payload_sha256=json_extract(j.value,'$.hash')))`,[runId,bindingSha256,runId,steps.length,JSON.stringify(steps.map(s=>({index:s.index,hash:s.payloadSha256}))),runId])];
  for(const [i,g]of patchGroups.entries()){
    const match=prefix=>g.keys.map(k=>`t.${k} IS json_extract(j.value,'$.${prefix}[${g.columns.indexOf(k)}]')`).join(' AND '),values=g.columns.map(c=>`t.${c}`).join(',');
    finish.push(assertion(`patch:${i}`,`${completed} OR NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM ${g.table} t WHERE ${match('before')} AND json_array(${values})=json_extract(j.value,'$.before')))`,[runId,bindingSha256,JSON.stringify(g.changes)]));
    // json_each drives the update and each target is an indexed primary-key lookup.
    // UPDATE FROM avoids rescanning the full table and repeating the JSON parse for every assigned field.
    const set=g.columns.filter(c=>!g.keys.includes(c)).map(c=>`${c}=json_extract(j.value,'$.after[${g.columns.indexOf(c)}]')`);
    finish.push(sql(`UPDATE ${g.table} AS t SET ${set.join(',')} FROM json_each(?) AS j WHERE ${match('before')} AND ${loading}`,JSON.stringify(g.changes),runId));
  }
  for(const [i,g]of groups.entries()){
    const spec=specs[g.table],match=spec.keys.map(k=>`t.${k} IS json_extract(j.value,'$[${g.columns.indexOf(k)}]')`).join(' AND ');
    if(g.table!=='command_registry')finish.push(assertion(`insert:${i}`,`${completed} OR NOT EXISTS(SELECT 1 FROM json_each(?) j JOIN ${g.table} t ON ${match})`,[runId,bindingSha256,JSON.stringify(g.rows)]));
    finish.push(insertRows(g,runId));
  }
  const receipt={commandId,status:'committed',operation:'legacy.incremental-refresh',result:{importRunId:runId,...manifest},pendingEffects:false};
  finish.push(sql(`INSERT INTO command_registry SELECT ?,'admin' WHERE ${loading}`,commandId,runId),sql(`INSERT INTO admin_commands SELECT ?,?,'service:legacy-import','legacy.incremental-refresh',?,'frontend.read','[]','legacy-snapshot',?,?,1,?,? WHERE ${loading}`,commandId,bindingSha256,runId,runId,runId,context.importedAt,JSON.stringify(receipt),runId),sql(`INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) SELECT ?,'service:legacy-import','reviewed-staging-refresh','legacy.incremental-refresh',?,?,?,? WHERE ${loading}`,commandId,runId,context.importedAt,JSON.stringify({backupSha256:context.backupSha256,administrationRevision:context.administrationRevision}),JSON.stringify(manifest),runId),sql("UPDATE legacy_import_runs SET state='complete',completed_at=? WHERE import_run_id=? AND state='loading'",context.importedAt,runId));
  const audit=finish.splice(finish.length-4,3);finish.splice(2,0,...audit);
  finish.splice(finish.length-1,0,sql("UPDATE legacy_operational_adoptions SET state='complete',completed_at=? WHERE import_run_id=? AND state='loading'",context.importedAt,runId));
  const result={formatVersion:1,environment:'staging',requiredSchemaVersion:16,generation:context.generation,sourceCommit:context.sourceCommit,importRunId:runId,commandId,bindingSha256,manifest,initialize,steps,finish,patchGroups,insertGroups:groups,writeEstimate:{evidence:evidenceGroups.reduce((n,g)=>n+g.rows.length*(g.table==='legacy_operational_adoption_rows'?3:2),0)+steps.length*6+12,canonical:changes.length*8+manifest.inserts*8+patchGroups.length*2+groups.length*2+20},requirements:{paused:true,notifications:'suppressed',productionAllowed:false,freshBackupRequired:true,exactReadbackRequired:true,atomicFinalBatchRequired:true}};
  check(finish.length<=100,'REFRESH_FINAL_STATEMENT_BOUND');for(const batch of [initialize,...steps.map(s=>s.batch),finish]){check(Buffer.byteLength(JSON.stringify(batch))<1_800_000,'REFRESH_BATCH_BOUND');for(const s of batch)check(s.params.length<=100&&Buffer.byteLength(s.sql)<100000,'REFRESH_SQL_BOUND');}
  result.executionSha256=importDigest(result);return result;
}
export function assertIncrementalImportTarget(plan,target,observed,approvedHash){const {executionSha256,...body}=plan;check(importDigest(body)===executionSha256&&executionSha256===approvedHash,'REFRESH_EXECUTION_HASH');check(target?.environment==='staging'&&['accountId','databaseId','name'].every(k=>typeof target[k]==='string'&&target[k]&&target[k]===observed?.[k])&&observed.environment==='staging'&&observed.generation===plan.generation&&observed.schemaVersion===16&&observed.acceptingCommands===false&&observed.notificationMode==='suppressed','REFRESH_TARGET');return true;}
export async function verifyIncrementalImport(plan,{readBatch,phase='complete'}){
 const {executionSha256,...body}=plan;check(importDigest(body)===executionSha256,'REFRESH_EXECUTION_HASH');const groups=[...plan.steps.map(g=>({table:g.table,columns:g.columns,rows:phase==='complete'&&g.table==='legacy_operational_adoptions'?g.rows.map(r=>r.map((v,i)=>g.columns[i]==='state'?'complete':g.columns[i]==='completed_at'?plan.finish.at(-1).params[0]:v)):g.rows})),...(phase==='complete'?plan.patchGroups.map(g=>({table:g.table,columns:g.columns,rows:g.changes.map(c=>c.after)})):[]),...(phase==='complete'?plan.insertGroups:[])],differences=[];let checkedRows=0;
 for(const g of groups){const keys=specs[g.table].keys,query=sql(`SELECT ${g.columns.map(c=>`t.${c}`).join(',')} FROM json_each(?) j CROSS JOIN ${g.table} t WHERE ${keys.map(k=>`t.${k} IS json_extract(j.value,'$[${g.columns.indexOf(k)}]')`).join(' AND ')}`,JSON.stringify(g.rows)),result=await readBatch([query]),rows=result[0].results??result[0];checkedRows+=rows.length;if(!same(rows.map(r=>importDigest(g.columns.map(c=>r[c]))).sort(),g.rows.map(importDigest).sort()))differences.push({table:g.table,code:'exact-row-mismatch'});}
 const result=await readBatch([sql('SELECT state,plan_sha256 FROM legacy_import_runs WHERE import_run_id=?',plan.importRunId),sql('SELECT COUNT(*) AS n FROM admin_commands WHERE command_id=?',plan.commandId),sql('SELECT COUNT(*) AS n FROM legacy_import_batches WHERE import_run_id=?',plan.importRunId)]),rows=result.map(r=>r.results??r);
 if(rows[0][0]?.state!==(phase==='complete'?'complete':'loading')||rows[0][0]?.plan_sha256!==plan.bindingSha256||rows[1][0]?.n!==(phase==='complete'?1:0)||rows[2][0]?.n!==plan.steps.length)differences.push({code:'refresh-completion-mismatch'});
 return {verified:!differences.length,checkedRows,differences,executionSha256};
}

export async function inspectIncrementalImportResume(plan,{readBatch}){
 const {executionSha256,...body}=plan;check(importDigest(body)===executionSha256,'REFRESH_EXECUTION_HASH');const result=await readBatch([sql('SELECT state,plan_sha256 FROM legacy_import_runs WHERE import_run_id=?',plan.importRunId),sql('SELECT batch_index,payload_sha256 FROM legacy_import_batches WHERE import_run_id=? ORDER BY batch_index',plan.importRunId)]),rows=result.map(r=>r.results??r),run=rows[0][0];
 if(!run){check(rows[1].length===0,'REFRESH_RESUME_BINDING');return {phase:'initialize',pendingSteps:plan.steps.map(s=>s.index)};}check(run.plan_sha256===plan.bindingSha256&&['loading','complete'].includes(run.state),'REFRESH_RESUME_BINDING');const completed=new Set();for(const row of rows[1]){check(plan.steps[row.batch_index]?.payloadSha256===row.payload_sha256,'REFRESH_RESUME_BINDING');completed.add(row.batch_index);}if(run.state==='complete')check(completed.size===plan.steps.length,'REFRESH_RESUME_BINDING');return {phase:run.state==='complete'?'complete':completed.size===plan.steps.length?'verify-evidence-before-finish':'loading',pendingSteps:plan.steps.filter(s=>!completed.has(s.index)).map(s=>s.index)};
}
