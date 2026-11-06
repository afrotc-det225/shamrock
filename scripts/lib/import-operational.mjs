/** Separate reviewed adoption of retained current Leadership and Excusals; never replay old human actions. */
import {importDigest} from './import-capture.mjs';
import {verifyImportAccounting,proposeImportCrosswalk} from './import-parity.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);},norm=v=>String(v??'').trim().toLowerCase();
const stable=(kind,value)=>`${kind}:legacy:${importDigest(value).slice(0,32)}`;
const sql=(sql,...params)=>({sql,params});
const tuple=r=>[r.last_name,r.first_name,r.flight,r.squadron].map(norm);
const profileTuple=p=>[p.profile.lastName,p.profile.firstName,p.flightLabel,p.squadronLabel].map(norm);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export function reconcileOperationalAdoption(snapshot,initial,adoptedPlan,reconciliation){
  verifyImportAccounting(snapshot,initial);verifyImportAccounting(snapshot,adoptedPlan);
  const {reconciliationSha256,...body}=reconciliation;check(importDigest(body)===reconciliationSha256&&reconciliation.snapshotSha256===snapshot.snapshotSha256,'IMPORT_OPERATIONAL_RECONCILIATION');
  const proposals=new Map(proposeImportCrosswalk(initial).bindings.map(b=>[b.occurrenceId,b]));
  const people=adoptedPlan.records.filter(r=>r.kind==='directory'&&id(r.personId));
  const currentEvents=adoptedPlan.records.filter(r=>r.kind==='event'&&id(r.eventId));
  const byPerson=new Map(people.map(p=>[p.personId,p])),links=new Map(reconciliation.nativeProvenance.links.map(l=>[l.occurrenceId,l]));
  const forms=new Map(snapshot.resources.filter(r=>r.kind==='form').map(f=>[f.key,f]));
  const rows=initial.records.filter(r=>['leadership','excusal'].includes(r.kind)&&proposals.has(r.occurrenceId)).map(record=>{
    const proposal=proposals.get(record.occurrenceId),targets=proposal.targets;
    if(record.kind==='leadership'){
      const sameName=people.filter(p=>norm(p.profile.lastName)===norm(record.last_name)&&norm(p.profile.firstName)===norm(record.first_name));
      return {kind:'leadership',occurrenceId:record.occurrenceId,record,contactId:targets.contactId,personId:targets.personId??null,
        classification:targets.personId?'linked':sameName.length?'unresolved':'manual',evidence:{method:targets.personId?'exact-current-directory-email':'manual-contact-outside-directory',sameNameCandidates:sameName.map(p=>p.personId),verifiedHumanIdentity:false}};
    }
    const labels=tuple(record),candidates=labels.every(Boolean)?people.filter(p=>JSON.stringify(profileTuple(p))===JSON.stringify(labels)):[];
    const personId=targets.personId??(candidates.length===1?candidates[0].personId:null),person=personId?byPerson.get(personId):null;
    const link=links.get(record.occurrenceId),form=link?forms.get(link.formKey):null,response=form?.responses.find(r=>r.responseId===link.responseId);
    const answer=title=>{const questionId=form?.metadata.items.find(i=>i.title===title)?.questionItem?.question?.questionId;return response?.answers?.[questionId]?.textAnswers?.answers?.[0]?.value??null;};
    const typed=[answer('Last Name'),answer('First Name')];
    return {kind:'excusal',occurrenceId:record.occurrenceId,record,requestId:targets.requestId??null,eventId:targets.eventId??null,personId,flightId:targets.flightId??null,
      evidence:{method:targets.personId?'exact-current-directory-email':personId?'legacy-handler-canonical-subject-tuple':'unresolved-subject',sourceReference:'src/forms/handlers.ts:lookupCadetByEmail/onExcusalsFormSubmit',completeTuple:labels.every(Boolean),candidatePersonIds:candidates.map(p=>p.personId),sourceLabels:[record.last_name,record.first_name,record.flight,record.squadron],nativeResponse:link??null,canonicalNameChanged:typed.every(v=>v!==null)?typed.some((v,i)=>v!==[record.last_name,record.first_name][i]):null,typedNames:typed,verifiedHumanIdentity:false,subjectCurrentlyActive:person?!['Inactive','Commissioned','Dropped'].includes(person.profile.flightPathStatus):false}};
  });
  check(rows.length>0&&rows.length<=1500&&new Set(rows.map(r=>r.occurrenceId)).size===rows.length,'IMPORT_OPERATIONAL_BOUND');
  const result={formatVersion:1,snapshotSha256:snapshot.snapshotSha256,initialPlanSha256:initial.planSha256,adoptedPlanSha256:adoptedPlan.planSha256,reconciliationSha256,people,currentEvents,rows};
  return {...result,evidenceSha256:importDigest(result)};
}
export function buildOperationalAdoptionModel(evidence,review){
  const {evidenceSha256,...body}=evidence;check(importDigest(body)===evidenceSha256,'IMPORT_OPERATIONAL_EVIDENCE');
  check(review?.formatVersion===1&&review.evidenceSha256===evidenceSha256&&review.snapshotSha256===evidence.snapshotSha256&&typeof review.reviewReference==='string'&&review.reviewReference.length>0&&review.reviewReference.length<=240,'IMPORT_OPERATIONAL_REVIEW');
  check(review.adoptLinkedLeadership===true&&review.adoptManualLeadership===true&&review.adoptExactEmailSubjects===true&&review.adoptCanonicalSubjectTuples===true&&review.preserveUnresolved===true,'IMPORT_OPERATIONAL_CONSENT');
  check(Array.isArray(review.retiredEvents)&&review.retiredEvents.length<=128,'IMPORT_OPERATIONAL_RETIRED');const retired=new Map(review.retiredEvents.map(e=>{check(typeof e.label==='string'&&e.label.length<=512&&typeof e.reason==='string'&&e.reason.length>0&&e.reason.length<=512&&typeof e.sourceReference==='string'&&e.sourceReference.length>0,'IMPORT_OPERATIONAL_RETIRED');return [e.label,e];}));check(retired.size===review.retiredEvents.length,'IMPORT_OPERATIONAL_RETIRED');
  const dispositions=evidence.rows.map(r=>{let disposition='adopted',issues=[];
    if(r.kind==='leadership'){if(r.classification==='unresolved'||!id(r.contactId)||r.personId!==null&&!id(r.personId))issues.push('unresolved-contact');}
    else {
      if(!r.eventId&&retired.has(r.record.event))return {...r,disposition:'retired',issues:[],retirement:retired.get(r.record.event)};
      if(!id(r.eventId))issues.push('unresolved-event');if(!id(r.personId))issues.push('unresolved-subject');if(!id(r.flightId))issues.push('unresolved-flight');if(!id(r.requestId))issues.push('unresolved-request-id');
      if(!['Submitted','Approved','Denied','Withdrawn','Superseded'].includes(r.record.status)||r.record.decision&&r.record.decision!==r.record.status||!['P','T','E','ES','MED'].includes(r.record.requested_outcome))issues.push('invalid-request-state');
      for(const value of [r.record.submittedAt,r.record.updatedAt])if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))issues.push('invalid-request-time');
      if(typeof r.record.reason!=='string'||r.record.reason.length>4000)issues.push('invalid-request-reason');
    }
    if(issues.length)disposition='quarantined';return {...r,disposition,issues};
  });
  const contacts=dispositions.filter(r=>r.kind==='leadership'&&r.disposition==='adopted'),requests=dispositions.filter(r=>r.kind==='excusal'&&r.disposition==='adopted');
  check(new Set(contacts.map(r=>r.contactId)).size===contacts.length&&new Set(contacts.filter(r=>r.personId).map(r=>r.personId)).size===contacts.filter(r=>r.personId).length&&new Set(requests.map(r=>r.requestId)).size===requests.length,'IMPORT_OPERATIONAL_COLLISION');
  const result={formatVersion:1,snapshotSha256:evidence.snapshotSha256,evidenceSha256,reviewReference:review.reviewReference,contacts,requests,dispositions,
    summary:{sourceRows:dispositions.length,sourceLeadership:dispositions.filter(r=>r.kind==='leadership').length,sourceRequests:dispositions.filter(r=>r.kind==='excusal').length,contacts:contacts.length,linkedContacts:contacts.filter(r=>r.personId).length,manualContacts:contacts.filter(r=>!r.personId).length,requests:requests.length,pendingRequests:requests.filter(r=>r.record.status==='Submitted').length,retiredRequests:dispositions.filter(r=>r.disposition==='retired').length,quarantinedRows:dispositions.filter(r=>r.disposition==='quarantined').length}};
  return {...result,modelSha256:importDigest(result)};
}
const paused=`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=0)
 AND EXISTS(SELECT 1 FROM notification_delivery_control WHERE singleton=1 AND mode='suppressed' AND daily_recipient_budget=0)
 AND NOT EXISTS(SELECT 1 FROM operation_commands) AND NOT EXISTS(SELECT 1 FROM outbox_jobs) AND NOT EXISTS(SELECT 1 FROM notification_intents) AND NOT EXISTS(SELECT 1 FROM admin_effects) AND NOT EXISTS(SELECT 1 FROM excusal_notification_tasks)`;
function insertRows(table,columns,rows){const chunks=[];let group=[];for(const row of rows){if(group.length&&(group.length>=100||Buffer.byteLength(JSON.stringify([...group,row]))>240000)){chunks.push(group);group=[];}group.push(row);}if(group.length)chunks.push(group);return chunks.map(rows=>({table,columns,rows,batch:sql(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`,JSON.stringify(rows))}));}
/** Load in one atomic bounded batch, exact readback, then separately audit/complete. No mail or refresh effects. */
export function createOperationalAdoptionPlan(model,{generation,importRunId,sourceCommit,importedAt,baseExecutionSha256}){
  const {modelSha256,...body}=model;check(importDigest(body)===modelSha256,'IMPORT_OPERATIONAL_MODEL');check(Number.isSafeInteger(generation)&&generation>0&&id(importRunId)&&/^[a-f0-9]{40,64}$/.test(sourceCommit)&&/^[a-f0-9]{64}$/.test(baseExecutionSha256)&&new Date(importedAt).toISOString()===importedAt,'IMPORT_OPERATIONAL_CONTEXT');
  const adoptionId=stable('adoption',[importRunId,model.evidenceSha256]),commandId=stable('adoption-audit',adoptionId),groups=[];
  groups.push(...insertRows('legacy_operational_adoption_rows',['adoption_id','import_run_id','source_occurrence_id','kind','disposition','target_id','evidence_json'],model.dispositions.map(r=>[adoptionId,importRunId,r.occurrenceId,r.kind,r.disposition,r.disposition==='adopted'?(r.kind==='leadership'?r.contactId:r.requestId):null,JSON.stringify(r)])));
  groups.push(...insertRows('leadership_contacts',['contact_id','version','person_id','last_name','first_name','rank','role','email','cell_phone','reports_to','office_phone','office_location','active','updated_at'],model.contacts.map(c=>[c.contactId,1,c.personId,c.record.last_name,c.record.first_name,c.record.rank,c.record.role,c.record.email,c.record.cell_phone,c.record.reports_to,c.record.office_phone,c.record.office_location,1,importedAt])));
  groups.push(...insertRows('excusal_records',['request_id','event_id','person_id','unit_id','requested_outcome','reason','status','decision','version','submitted_at','submitted_by','updated_at','decided_at','decided_by','decision_reason','source_json','command_id','last_command_id','origin','legacy_adoption_id','legacy_occurrence_id'],model.requests.map(r=>[r.requestId,r.eventId,r.personId,r.flightId,r.record.requested_outcome,r.record.reason,r.record.status,r.record.decision||null,1,r.record.submittedAt,null,r.record.updatedAt,r.record.decidedAt,null,null,JSON.stringify({kind:'legacy-import',resourceKey:importRunId,submissionId:r.occurrenceId,revision:1,humanIdentityVerified:false}),null,null,'legacy',adoptionId,r.occurrenceId])));
  const guard=sql(`INSERT INTO legacy_import_assertions VALUES(?,CASE WHEN ${paused} AND EXISTS(SELECT 1 FROM legacy_import_runs WHERE import_run_id=? AND snapshot_sha256=? AND state='complete') AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions) AND NOT EXISTS(SELECT 1 FROM leadership_contacts) AND NOT EXISTS(SELECT 1 FROM excusal_records) AND NOT EXISTS(SELECT 1 FROM excusal_record_decisions)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM legacy_source_occurrences o WHERE o.import_run_id=? AND o.occurrence_id=json_extract(j.value,'$.occurrenceId')))
    THEN 1 ELSE 0 END)`,`${adoptionId}:load`,generation,importRunId,model.snapshotSha256,JSON.stringify(model.dispositions.map(r=>({occurrenceId:r.occurrenceId}))),importRunId);
  const run=sql('INSERT INTO legacy_operational_adoptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',adoptionId,importRunId,model.evidenceSha256,modelSha256,model.reviewReference,sourceCommit,'loading',model.summary.sourceRows,model.summary.contacts,model.summary.requests,importedAt,null);
  const receipt={commandId,status:'committed',operation:'legacy.operational-adopt',result:{adoptionId,...model.summary},pendingEffects:false};
  const finish=[sql(`INSERT INTO legacy_import_assertions VALUES(?,CASE WHEN ${paused} AND EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE adoption_id=? AND plan_sha256=? AND state='loading' AND expected_rows=(SELECT COUNT(*) FROM legacy_operational_adoption_rows WHERE adoption_id=?) AND expected_contacts=(SELECT COUNT(*) FROM leadership_contacts) AND expected_requests=(SELECT COUNT(*) FROM excusal_records)) THEN 1 ELSE 0 END)`,`${adoptionId}:complete`,generation,adoptionId,modelSha256,adoptionId),sql("INSERT INTO command_registry VALUES(?,'admin')",commandId),sql('INSERT INTO admin_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',commandId,modelSha256,'service:legacy-import','legacy.operational-adopt',adoptionId,'frontend.read','[]','legacy-snapshot',importRunId,adoptionId,1,importedAt,JSON.stringify(receipt)),sql('INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)',commandId,'service:legacy-import','reviewed-staging-adoption','legacy.operational-adopt',adoptionId,importedAt,'{}',JSON.stringify({modelSha256,...model.summary,historicalActorsVerified:false})),sql("UPDATE legacy_operational_adoptions SET state='complete',completed_at=? WHERE adoption_id=? AND state='loading'",importedAt,adoptionId)];
  const result={formatVersion:1,environment:'staging',generation,requiredSchemaVersion:10,sourceCommit,adoptionId,importRunId,snapshotSha256:model.snapshotSha256,baseExecutionSha256,modelSha256,summary:model.summary,load:[guard,run,...groups.map(g=>g.batch)],groups,finish,writeEstimate:{load:2+3+model.summary.sourceRows*3+model.summary.contacts*3+model.summary.requests*4,finish:2+2+3+2+3},requirements:{paused:true,notificationMode:'suppressed',baseReadbackRequired:true,exactReadbackBeforeFinish:true,productionAllowed:false}};
  for(const batch of [result.load,result.finish]){check(batch.length<=48&&Buffer.byteLength(JSON.stringify(batch))<=1800000,'IMPORT_OPERATIONAL_BATCH_BOUND');for(const s of batch)check(s.params.length<=100&&Buffer.byteLength(s.sql)<=100000&&s.params.every(p=>typeof p!=='string'||Buffer.byteLength(p)<=1000000),'IMPORT_OPERATIONAL_SQL_BOUND');}
  result.executionSha256=importDigest(result);return result;
}
export function assertOperationalAdoptionTarget(plan,target,observed,approvedHash){const {executionSha256,...body}=plan;check(executionSha256===importDigest(body)&&approvedHash===executionSha256,'IMPORT_OPERATIONAL_EXECUTION');check(target?.environment==='staging'&&['databaseId','accountId','name'].every(k=>typeof target[k]==='string'&&target[k]&&target[k]===observed?.[k])&&target.generation===plan.generation&&observed.generation===plan.generation&&observed.environment==='staging'&&observed.schemaVersion===10&&observed.acceptingCommands===false&&observed.notificationMode==='suppressed','IMPORT_OPERATIONAL_TARGET');return true;}
export async function verifyOperationalAdoption(plan,{readBatch}){
  const {executionSha256,...body}=plan;check(executionSha256===importDigest(body),'IMPORT_OPERATIONAL_EXECUTION');
  const keyFor=table=>({legacy_operational_adoption_rows:'source_occurrence_id',leadership_contacts:'contact_id',excusal_records:'request_id'})[table];
  const results=await readBatch(plan.groups.map(g=>{const key=keyFor(g.table);check(key,'IMPORT_OPERATIONAL_READBACK');return sql(`SELECT ${g.columns.join(',')} FROM ${g.table} WHERE ${key} IN(SELECT value FROM json_each(?))${g.table==='legacy_operational_adoption_rows'?' AND adoption_id=?':''}`,JSON.stringify(g.rows.map(r=>r[g.columns.indexOf(key)])),...(g.table==='legacy_operational_adoption_rows'?[plan.adoptionId]:[]));}));check(results.length===plan.groups.length,'IMPORT_OPERATIONAL_READBACK');
  const differences=[];let checkedRows=0;for(let i=0;i<results.length;i++){const g=plan.groups[i],rows=results[i].results??results[i],expected=g.rows.map(importDigest).sort(),actual=rows.map(r=>importDigest(g.columns.map(c=>r[c]))).sort();checkedRows+=rows.length;if(JSON.stringify(expected)!==JSON.stringify(actual))differences.push({table:g.table,code:'stored-value-mismatch'});}
  const r=await readBatch([sql(`SELECT (${paused}) AS paused`,plan.generation),sql('SELECT * FROM legacy_operational_adoptions WHERE adoption_id=?',plan.adoptionId),sql('SELECT (SELECT COUNT(*) FROM legacy_operational_adoption_rows WHERE adoption_id=?) AS sourceRows,(SELECT COUNT(*) FROM leadership_contacts) AS contacts,(SELECT COUNT(*) FROM excusal_records) AS requests',plan.adoptionId)]);const values=r.map(x=>x.results??x),run=values[1][0];if(values[0][0]?.paused!==1||!run||run.plan_sha256!==plan.modelSha256||run.import_run_id!==plan.importRunId||run.source_commit!==plan.sourceCommit||run.state!=='loading')differences.push({code:'adoption-fence-or-binding-mismatch'});
  if(['sourceRows','contacts','requests'].some(k=>values[2][0]?.[k]!==plan.summary[k]))differences.push({code:'adoption-row-coverage-mismatch'});
  return {verified:!differences.length,executionSha256,checkedRows,differences};
}

/** Load is one transaction. After an ambiguous response, inspect it rather than replaying initialization. */
export async function inspectOperationalAdoptionResume(plan,{readBatch}){
  const {executionSha256,...body}=plan;check(importDigest(body)===executionSha256,'IMPORT_OPERATIONAL_EXECUTION');
  const result=await readBatch([sql(`SELECT (${paused}) AS paused`,plan.generation),sql('SELECT * FROM legacy_operational_adoptions WHERE adoption_id=?',plan.adoptionId)]),values=result.map(r=>r.results??r);
  check(values[0][0]?.paused===1,'IMPORT_OPERATIONAL_RESUME_FENCE');const run=values[1][0];if(!run)return {phase:'load'};
  const fields=['adoption_id','import_run_id','evidence_sha256','plan_sha256','review_reference','source_commit','state','expected_rows','expected_contacts','expected_requests','started_at','completed_at'];
  const expected=Object.fromEntries(fields.map((key,index)=>[key,plan.load[1].params[index]]));
  check(['loading','complete'].includes(run.state)&&fields.filter(k=>!['state','completed_at'].includes(k)).every(k=>run[k]===expected[k]),'IMPORT_OPERATIONAL_RESUME_BINDING');
  if(run.state==='complete'){check(run.completed_at===plan.finish.at(-1).params[0],'IMPORT_OPERATIONAL_RESUME_BINDING');return {phase:'complete'};}
  return {phase:'verify-before-finish'};
}
