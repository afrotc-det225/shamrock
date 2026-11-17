/** Operational CSV/bulk planning uses ordinary audited commands, never direct SQL or log replacement. */
import {createHash} from 'node:crypto';
import {parseAdminCommand,DIRECTORY_FIELDS,operationallyActive,directoryLeadershipRole} from '../../.build/v3/packages/domain/src/admin.js';
import {parseAttendanceCorrection} from '../../.build/v3/packages/domain/src/corrections.js';
import {parseCommand,ATTENDANCE_CODES} from '../../.build/v3/packages/domain/src/index.js';
import {buildFrontendReporting} from '../../.build/v3/packages/domain/src/frontend-reporting.js';
import {snapshotToFrontendReportingInput} from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import {assembleFrontendSnapshotPages,FRONTEND_SECTIONS,FRONTEND_PAGE_VERSION,FRONTEND_PAGE_MAX_BYTES} from '../../.build/v3/packages/domain/src/frontend-transport.js';
import {category,readOperationalCsv,writeOperationalCsv} from './operational-csv.mjs';
import {selectRecords} from './operational-selectors.mjs';
export const operationalCanonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const operationalHash=v=>createHash('sha256').update(operationalCanonical(v)).digest('hex');
const check=(ok,code)=>{if(!ok)throw Error(code);},clone=structuredClone,identifier=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const snake=v=>v.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),same=(a,b)=>operationalCanonical(a)===operationalCanonical(b),pair=(person,event)=>JSON.stringify([person,event]);
const number=(s)=>{check(typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s)&&Number.isSafeInteger(Number(s)),'CSV_INTEGER');return Number(s);};
const nullable=s=>s===''?null:s;
const array=s=>{let v;try{v=JSON.parse(s);}catch{throw Error('CSV_JSON_ARRAY');}check(Array.isArray(v)&&v.every(identifier)&&new Set(v).size===v.length,'CSV_JSON_ARRAY');return v.sort();};
const bool=s=>{check(s==='true'||s==='false','CSV_BOOLEAN');return s==='true';};
const validDate=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00.000Z'))&&new Date(v+'T00:00:00.000Z').toISOString().slice(0,10)===v;
const commandPath=op=>['directory.upsert','leadership.upsert','event.upsert','attendance.correct'].includes(op)?'/v1/admin/commands':'/v1/commands';
const parse=c=>c.operation==='attendance.correct'?parseAttendanceCorrection(c):['directory.upsert','leadership.upsert','event.upsert'].includes(c.operation)?parseAdminCommand(c):parseCommand(c);
function verifySnapshot(snapshot){
 check(snapshot?.contractVersion===1&&['local','staging'].includes(snapshot.environment)&&Number.isSafeInteger(snapshot.generation)&&snapshot.generation>0,'ADMIN_SNAPSHOT');
 for(const key of ['people','leadership','events','eventFlights','flights','squadrons','terms','attendanceVersions','requests','observations','corrections','diagnostics'])check(Array.isArray(snapshot[key]),'ADMIN_SNAPSHOT');
 check(!snapshot.diagnostics.some(d=>d.count>0),'ADMIN_SNAPSHOT_DIAGNOSTICS');
 check(snapshot.terms.filter(t=>t.isCurrent).length===1,'ADMIN_CURRENT_TERM');
 if(snapshot.captureScope){const scope=snapshot.captureScope;check(Object.keys(scope).sort().join(',')==='contacts,currentTermId,directory,termId'&&scope.contacts==='lifetime'&&scope.directory==='lifetime'&&snapshot.terms.some(t=>t.termId===scope.termId)&&snapshot.terms.find(t=>t.isCurrent).termId===scope.currentTermId,'ADMIN_CAPTURE_SCOPE');}
 for(const [key,id] of [['people','personId'],['leadership','contactId'],['events','eventId'],['flights','flightId'],['squadrons','squadronId'],['terms','termId'],['requests','requestId']])check(snapshot[key].every(r=>identifier(r[id]))&&new Set(snapshot[key].map(r=>r[id])).size===snapshot[key].length,'ADMIN_SNAPSHOT_IDENTITIES');
}
function reporting(snapshot,asOfDate){check(validDate(asOfDate),'ADMIN_AS_OF_DATE');return buildFrontendReporting(snapshotToFrontendReportingInput(snapshot,asOfDate));}
function attendanceRows(snapshot,asOfDate){
 const result=reporting(snapshot,asOfDate),matrix=result.matrices.find(m=>m.termId===(snapshot.captureScope?.termId??result.currentTermId)),versions=new Map(snapshot.attendanceVersions.map(v=>[pair(v.personId,v.eventId),v.version])),events=new Map(snapshot.events.map(e=>[e.eventId,e]));
 return matrix.rows.flatMap(row=>row.cells.map(cell=>({person_id:row.personId,event_id:cell.eventId,expected_base_version:versions.get(pair(row.personId,cell.eventId))??0,expected_event_version:events.get(cell.eventId).version,code:cell.effectiveCode??'',reason:'',eligible:cell.eligible,needsReview:cell.needsReview})));
}
function directoryPayload(p){return {personId:p.personId,expectedVersion:p.version,flightId:p.flightId,profile:Object.fromEntries(DIRECTORY_FIELDS.map(key=>[key,p[key]]))};}
function leadershipPayload(p){return {contactId:p.contactId,expectedVersion:p.contactVersion,personId:p.personId,profile:p.personId===null?Object.fromEntries(['lastName','firstName','rank','role','email','cellPhone'].map(key=>[key,p[key]])):null,reportsTo:p.reportsTo,officePhone:p.officePhone,officeLocation:p.officeLocation,active:p.active};}
function eventPayload(p,snapshot){const {version,eligiblePersonIds,...rest}=p;check(Array.isArray(eligiblePersonIds),'ADMIN_EVENT_ROSTER');return {...rest,expectedVersion:version,flightIds:snapshot.eventFlights.filter(f=>f.eventId===p.eventId).map(f=>f.flightId).sort(),eligiblePersonIds:[...eligiblePersonIds].sort()};}
export function exportOperationalCsv(snapshot,kind,{asOfDate,legend}={}){
 kind=category(kind);verifySnapshot(snapshot);let rows;
 if(kind==='directory')rows=snapshot.people.map(p=>({person_id:p.personId,expected_version:p.version,flight_id:p.flightId,...Object.fromEntries(DIRECTORY_FIELDS.map(key=>[snake(key),p[key]]))}));
 else if(kind==='leadership')rows=snapshot.leadership.map(p=>({contact_id:p.contactId,expected_version:p.contactVersion,person_id:p.personId,...Object.fromEntries(['lastName','firstName','rank','role','email','cellPhone','reportsTo','officePhone','officeLocation','active'].map(key=>[snake(key),p[key]]))}));
 else if(kind==='events')rows=snapshot.events.map(p=>{const value=eventPayload(p,snapshot);return Object.fromEntries(Object.entries(value).map(([key,v])=>[key==='expectedVersion'?'expected_version':key==='flightIds'?'flight_ids_json':key==='eligiblePersonIds'?'eligible_person_ids_json':snake(key),Array.isArray(v)?JSON.stringify(v):v]));});
 else if(kind==='attendance')rows=attendanceRows(snapshot,asOfDate);
 else if(kind==='excusals'){const events=new Map(snapshot.events.map(e=>[e.eventId,e]));rows=snapshot.requests.map(r=>({request_id:r.requestId,expected_version:r.version,person_id:r.personId,event_id:r.eventId,expected_event_version:events.get(r.eventId)?.version??'',requested_outcome:r.requestedOutcome,request_reason:r.reason,status:r.status,decision_reason:r.decisionReason??''}));}
 else {check(legend&&typeof legend==='object'&&!Array.isArray(legend),'ADMIN_LEGEND_REQUIRED');rows=Object.entries(legend).flatMap(([list,values])=>{check(Array.isArray(values)&&values.every(v=>typeof v==='string'),'ADMIN_LEGEND');return values.map((value,position)=>({list,position,value}));});}
 return writeOperationalCsv(kind,rows);
}
function planBase(snapshot,context,kind){
 verifySnapshot(snapshot);check(!snapshot.captureScope||snapshot.captureScope.termId===snapshot.captureScope.currentTermId,'ADMIN_HISTORICAL_CAPTURE_READ_ONLY');check(context&&['batchId','principalId','resourceKey'].every(key=>identifier(context[key]))&&['sheet','test'].includes(context.sourceKind)&&validDate(context.asOfDate)&&typeof context.reason==='string'&&context.reason.trim()===context.reason&&context.reason.length>0&&context.reason.length<=4000,'ADMIN_PLAN_CONTEXT');
 check(context.sourceKind!=='test'||snapshot.environment==='local','ADMIN_STAGING_SOURCE');
 return {formatVersion:1,kind,batchId:context.batchId,environment:snapshot.environment,generation:snapshot.generation,principalId:context.principalId,resourceKey:context.resourceKey,sourceKind:context.sourceKind,...(context.targetFingerprint?{targetFingerprint:context.targetFingerprint}:{}),...(context.sourceCommit?{sourceCommit:context.sourceCommit}:{}),asOfDate:context.asOfDate,reason:context.reason,snapshotHash:operationalHash(snapshot),sourceRevision:clone(snapshot.revision),changes:[]};
}
function change(plan,operation,payload,before,target){
 const withoutVersion=value=>{if(!value)return value;const {expectedVersion,...rest}=value;return rest;};
 if(before&&same(withoutVersion(before),withoutVersion(payload)))return;
 const commandId='ops.'+operationalHash([plan.batchId,plan.snapshotHash,operation,target,payload]);
 const command=parse({contractVersion:1,commandId,environment:plan.environment,generation:plan.generation,actor:{principalId:plan.principalId,evidence:'authenticated-confirmation'},source:{kind:plan.sourceKind,resourceKey:plan.resourceKey,submissionId:commandId,revision:1},operation,payload});
 check(Buffer.byteLength(JSON.stringify(command))<=65536,'ADMIN_COMMAND_SIZE');
 plan.changes.push({target,operation,path:commandPath(operation),before:clone(before),after:clone(command.payload),command});
}
function finish(plan,summary){
 check(plan.changes.length<=25000&&new Set(plan.changes.map(c=>c.command.commandId)).size===plan.changes.length,'ADMIN_PLAN_SIZE');
 const result={...plan,summary:{...summary,commands:plan.changes.length,planningRowWriteEstimate:plan.changes.reduce((n,c)=>n+100+(c.operation==='event.upsert'?10*(c.command.payload.eligiblePersonIds.length+c.command.payload.flightIds.length):0),0),execution:'bounded individual audited transactions; partial progress is retained'}};
 check(Buffer.byteLength(JSON.stringify(result))<=64*1024*1024,'ADMIN_PLAN_SIZE');return {...result,planHash:operationalHash(result)};
}
function checkMode(mode,exists){check(['create','update','merge','replace'].includes(mode),'CSV_IMPORT_MODE');check(mode!=='create'||!exists,'CSV_CREATE_EXISTS');check(mode!=='update'||exists,'CSV_UPDATE_MISSING');}
export function planOperationalCsvImport(snapshot,csv,kind,context,{mode,replaceScopeIds=[]}={}){
 kind=category(kind);check(kind!=='data_legend','ADMIN_LEGEND_CONFIGURATION_CHANGE');
 const plan=planBase(snapshot,context,'csv-import'),rows=readOperationalCsv(csv,kind);Object.assign(plan,{category:kind,mode,csvHash:createHash('sha256').update(csv).digest('hex')});
 check(['create','update','merge','replace'].includes(mode),'CSV_IMPORT_MODE');
 const scope=new Set(replaceScopeIds);check(Array.isArray(replaceScopeIds)&&scope.size===replaceScopeIds.length&&replaceScopeIds.every(identifier),'CSV_REPLACE_SCOPE');
 check(mode==='replace'?scope.size>0:scope.size===0,'CSV_REPLACE_SCOPE');check(mode!=='replace'||['directory','leadership','events','excusals'].includes(kind),'CSV_REPLACE_UNSUPPORTED');
 const existing=new Map((kind==='directory'?snapshot.people:kind==='leadership'?snapshot.leadership:kind==='events'?snapshot.events:kind==='excusals'?snapshot.requests:attendanceRows(snapshot,context.asOfDate)).map(r=>[kind==='directory'?r.personId:kind==='leadership'?r.contactId:kind==='events'?r.eventId:kind==='excusals'?r.requestId:pair(r.person_id,r.event_id),r]));
 const seen=new Set();
 for(const row of rows){
  const target=kind==='directory'?row.person_id:kind==='leadership'?row.contact_id:kind==='events'?row.event_id:kind==='excusals'?row.request_id:pair(row.person_id,row.event_id),prior=existing.get(target);
  check(!seen.has(target),'CSV_DUPLICATE_TARGET');seen.add(target);checkMode(mode,!!prior);if(mode==='replace')check(scope.has(target),'CSV_OUTSIDE_REPLACE_SCOPE');
  if(kind==='directory'){
   check(number(row.expected_version)===(prior?.version??0),'CSV_STALE_VERSION');
   const payload={personId:row.person_id,expectedVersion:number(row.expected_version),flightId:nullable(row.flight_id),profile:Object.fromEntries(DIRECTORY_FIELDS.map(key=>[key,key==='dateOfBirth'?nullable(row[snake(key)]):row[snake(key)]]))};
   change(plan,'directory.upsert',payload,prior?directoryPayload(prior):null,target);
  }else if(kind==='leadership'){
   check(number(row.expected_version)===(prior?.contactVersion??0),'CSV_STALE_VERSION');const personId=nullable(row.person_id),fields=['lastName','firstName','rank','role','email','cellPhone'];
   if(personId!==null){const person=snapshot.people.find(p=>p.personId===personId);check(person,'CSV_LINKED_PERSON');const shown=prior?.personId===personId?prior:{...person,cellPhone:person.phone};check(fields.every(key=>row[snake(key)]===shown[key]),'CSV_LINKED_IDENTITY_READ_ONLY');}
   const payload={contactId:row.contact_id,expectedVersion:number(row.expected_version),personId,profile:personId===null?Object.fromEntries(fields.map(key=>[key,row[snake(key)]])):null,reportsTo:row.reports_to,officePhone:row.office_phone,officeLocation:row.office_location,active:bool(row.active)};
   change(plan,'leadership.upsert',payload,prior?leadershipPayload(prior):null,target);
  }else if(kind==='events'){
   check(number(row.expected_version)===(prior?.version??0),'CSV_STALE_VERSION');check(!prior||row.term_id===prior.termId,'CSV_EVENT_TERM_IMMUTABLE');
   const payload={eventId:row.event_id,expectedVersion:number(row.expected_version),termId:row.term_id,eventType:row.event_type,trainingWeek:row.training_week===''?null:number(row.training_week),displayOrder:number(row.display_order),label:row.label,columnLabel:row.column_label,expectedGroup:row.expected_group,flightIds:array(row.flight_ids_json),eligiblePersonIds:array(row.eligible_person_ids_json),status:row.status,startAt:nullable(row.start_at),endAt:nullable(row.end_at),location:row.location,notes:row.notes};
   change(plan,'event.upsert',payload,prior?eventPayload(prior,snapshot):null,target);
  }else if(kind==='attendance'){
   check(prior,'CSV_ATTENDANCE_TARGET');check(number(row.expected_base_version)===prior.expected_base_version&&number(row.expected_event_version)===prior.expected_event_version,'CSV_STALE_VERSION');
   if(row.code===prior.code)continue;check(prior.eligible===true&&!prior.needsReview,'CSV_ATTENDANCE_ELIGIBILITY');
   change(plan,'attendance.correct',{personId:row.person_id,eventId:row.event_id,expectedBaseVersion:number(row.expected_base_version),expectedEventVersion:number(row.expected_event_version),code:nullable(row.code),reason:row.reason},prior,target);
  }else{
   check(number(row.expected_version)===(prior?.version??0),'CSV_STALE_VERSION');const event=snapshot.events.find(e=>e.eventId===row.event_id);check(event&&number(row.expected_event_version)===event.version,'CSV_STALE_EVENT');
   if(!prior){check(row.status==='Submitted'&&row.decision_reason==='','CSV_NEW_REQUEST_STATE');change(plan,'excusal.submit',{requestId:row.request_id,personId:row.person_id,eventId:row.event_id,expectedEventVersion:event.version,requestedOutcome:row.requested_outcome,reason:row.request_reason},null,target);}
   else {check(row.person_id===prior.personId&&row.event_id===prior.eventId&&row.requested_outcome===prior.requestedOutcome&&row.request_reason===prior.reason,'CSV_REQUEST_EVIDENCE_READ_ONLY');
    if(row.status===prior.status&&row.decision_reason===(prior.decisionReason??''))continue;
    change(plan,'excusal.decide',{requestId:row.request_id,expectedVersion:prior.version,decision:row.status,reason:row.decision_reason},prior,target);
   }
  }
 }
 let deactivated=0;
 if(mode==='replace')for(const id of scope){if(seen.has(id))continue;const prior=existing.get(id);check(prior,'CSV_REPLACE_UNKNOWN_TARGET');const before=plan.changes.length;
  if(kind==='directory'){const p=directoryPayload(prior);change(plan,'directory.upsert',{...p,profile:{...p.profile,flightPathStatus:'Inactive'}},p,id);}
  else if(kind==='leadership'){const p=leadershipPayload(prior);change(plan,'leadership.upsert',{...p,active:false},p,id);}
  else if(kind==='events'){const p=eventPayload(prior,snapshot);change(plan,'event.upsert',{...p,status:'inactive'},p,id);}
  else if(!['Withdrawn','Superseded'].includes(prior.status))change(plan,'excusal.decide',{requestId:id,expectedVersion:prior.version,decision:'Withdrawn',reason:context.reason},prior,id);
  if(plan.changes.length>before)deactivated++;
 }
 plan.replaceScopeIds=[...scope].sort();return finish(plan,{sourceRows:rows.length,unchangedRows:rows.length-(plan.changes.length-deactivated),deactivated});
}
export function planBulkAttendance(snapshot,context,selection){
 const plan=planBase(snapshot,context,'bulk-attendance');
 check(selection&&Object.keys(selection).sort().join(',')==='abroad,cadets,code,events,outsideRoster,termId'&&['include','exclude','only'].includes(selection.abroad)&&['reject','exclude'].includes(selection.outsideRoster)&&(selection.code===null||ATTENDANCE_CODES.includes(selection.code)),'BULK_SELECTION');
 const current=snapshot.terms.find(t=>t.isCurrent);check(selection.termId===current.termId,'BULK_CURRENT_TERM_REQUIRED');
 const flights=new Map(snapshot.flights.map(f=>[f.flightId,f])),squadrons=new Map(snapshot.squadrons.map(s=>[s.squadronId,s]));
 const people=snapshot.people.filter(operationallyActive).map(p=>({...p,name:`${p.lastName.trim()},${p.firstName.trim()}`,flight:flights.get(p.flightId)?.label??'',squadronId:flights.get(p.flightId)?.squadronId??'',squadron:squadrons.get(flights.get(p.flightId)?.squadronId)?.label??''}));
 const cadets=selectRecords(people,selection.cadets,'cadets').filter(p=>selection.abroad==='include'||(p.flight.toLowerCase()==='abroad')===(selection.abroad==='only'));
 const events=selectRecords(snapshot.events.filter(e=>e.termId===selection.termId),selection.events,'events');check(cadets.length&&events.length,'BULK_EMPTY_SELECTION');
 const cells=new Map(attendanceRows(snapshot,context.asOfDate).map(r=>[pair(r.person_id,r.event_id),r]));let excluded=0,unchanged=0;
 for(const event of events)for(const person of cadets){const target=pair(person.personId,event.eventId),cell=cells.get(target);check(cell&&!cell.needsReview,'BULK_AMBIGUOUS_ATTENDANCE');
  if(cell.eligible!==true){check(selection.outsideRoster==='exclude','BULK_OUTSIDE_EVENT_ROSTER');excluded++;continue;}
  if((selection.code??'')===cell.code){unchanged++;continue;}
  change(plan,'attendance.correct',{personId:person.personId,eventId:event.eventId,expectedBaseVersion:cell.expected_base_version,expectedEventVersion:cell.expected_event_version,code:selection.code,reason:context.reason},cell,target);
 }
 plan.selection=clone(selection);plan.selectedPeople=cadets.map(p=>({personId:p.personId,name:p.name,flight:p.flight,asYear:p.asYear,university:p.university}));plan.selectedEvents=events.map(e=>({eventId:e.eventId,label:e.label,version:e.version}));
 return finish(plan,{selectedPeople:cadets.length,selectedEvents:events.length,selectedCells:cadets.length*events.length,excludedOutsideRoster:excluded,unchangedCells:unchanged});
}
export function verifyOperationalPlan(plan){
 const {planHash,...body}=plan??{};check(/^[a-f0-9]{64}$/.test(planHash??'')&&operationalHash(body)===planHash,'ADMIN_PLAN_HASH');
 check(['csv-import','bulk-attendance'].includes(plan.kind)&&['local','staging'].includes(plan.environment)&&Array.isArray(plan.changes)&&plan.changes.length<=25000,'ADMIN_PLAN');
 for(const c of plan.changes){check(c.path===commandPath(c.operation)&&c.operation===c.command.operation&&same(c.after,c.command.payload)&&same(parse(c.command),c.command)&&c.command.environment===plan.environment&&c.command.generation===plan.generation&&c.command.actor.principalId===plan.principalId&&c.command.source.resourceKey===plan.resourceKey&&c.command.source.kind===plan.sourceKind&&c.command.source.submissionId===c.command.commandId&&c.command.source.revision===1&&c.command.actor.evidence==='authenticated-confirmation','ADMIN_PLAN_COMMAND');}
 return true;
}
/** One bounded step; persist dispatching before IO and retry the exact frozen command after ambiguity. */
export async function executeOperationalPlan(plan,{approvedHash,state,request,maximumCommands=5}){
 verifyOperationalPlan(plan);check(approvedHash===plan.planHash,'ADMIN_REVIEW_REQUIRED');check(Number.isSafeInteger(maximumCommands)&&maximumCommands>=1&&maximumCommands<=10,'ADMIN_STEP_BOUND');
 let journal=await state.load();if(!journal){journal={formatVersion:1,planHash:plan.planHash,entries:plan.changes.map(c=>({commandId:c.command.commandId,status:'queued'}))};await state.save(clone(journal));}
 check(journal.formatVersion===1&&journal.planHash===plan.planHash&&journal.entries.length===plan.changes.length&&journal.entries.every((e,i)=>e.commandId===plan.changes[i].command.commandId&&['queued','dispatching','committed','conflict','rejected'].includes(e.status)&&(e.status!=='committed'||e.receipt?.commandId===e.commandId&&e.receipt?.operation===plan.changes[i].command.operation&&e.receipt?.status==='committed'&&e.receiptHash===operationalHash(e.receipt))),'ADMIN_CHECKPOINT');
 let attempted=0;
 for(let i=0;i<journal.entries.length;i++){
  const entry=journal.entries[i],change=plan.changes[i];if(entry.status==='committed')continue;
  if(['conflict','rejected'].includes(entry.status))return {status:'needs-review',attempted,committed:journal.entries.filter(e=>e.status==='committed').length};
  if(attempted>=maximumCommands)break;
  entry.status='dispatching';await state.save(clone(journal));attempted++;
  let response;try{response=await request(change.path,clone(change.command));}catch{return {status:'retry-retained-command',attempted,committed:journal.entries.filter(e=>e.status==='committed').length};}
  if(response.status===200&&response.body?.status==='committed'&&response.body.commandId===entry.commandId&&response.body.operation===change.command.operation){entry.status='committed';entry.receipt=clone(response.body);entry.receiptHash=operationalHash(response.body);}
  else if(response.status===409){entry.status='conflict';entry.errorCode=String(response.body?.error?.code??'CONFLICT');}
  else if([400,403,404,422].includes(response.status)){entry.status='rejected';entry.errorCode=String(response.body?.error?.code??'REJECTED');}
  else {await state.save(clone(journal));return {status:'retry-retained-command',attempted,committed:journal.entries.filter(e=>e.status==='committed').length};}
  await state.save(clone(journal));
  if(entry.status!=='committed')return {status:'needs-review',attempted,committed:journal.entries.filter(e=>e.status==='committed').length};
 }
 const committed=journal.entries.filter(e=>e.status==='committed').length;return {status:committed===plan.changes.length?'committed-awaiting-publication':'continuing',attempted,committed};
}
/** Complete operational catalogs keep inactive profiles editable without expanding native publications. */
function mergeOperationalCatalogs(snapshot,people,contacts){
 check(people.every(p=>identifier(p.personId)&&Number.isSafeInteger(p.version)&&p.version>0&&p.active===operationallyActive(p))&&new Set(people.map(p=>p.personId)).size===people.length,'ADMIN_CAPTURE_DIRECTORY');
 check(contacts.every(c=>identifier(c.contactId)&&Number.isSafeInteger(c.version)&&c.version>0&&typeof c.active==='boolean'&&(c.personId===null||identifier(c.personId)))&&new Set(contacts.map(c=>c.contactId)).size===contacts.length,'ADMIN_CAPTURE_CONTACTS');
 const peopleById=new Map(people.map(p=>[p.personId,p])),linked=new Map(),flights=new Map(snapshot.flights.map(f=>[f.flightId,f])),squadrons=new Map(snapshot.squadrons.map(s=>[s.squadronId,s]));
 for(const person of snapshot.people)check(same(peopleById.get(person.personId),person),'ADMIN_CAPTURE_DIRECTORY_CHANGED');
 const leadership=contacts.map(({version,...contact})=>{
  if(contact.personId===null)return {...contact,contactVersion:version,profileVersion:null,publicationVersion:version};
  const person=peopleById.get(contact.personId);check(person&&!linked.has(contact.personId),'ADMIN_CAPTURE_LINKED_PERSON');linked.set(contact.personId,contact);
  const flight=flights.get(person.flightId),role=directoryLeadershipRole(person.role,flight?.label??'',squadrons.get(flight?.squadronId)?.label??'')??'';
  return {...contact,lastName:person.lastName,firstName:person.firstName,rank:person.rank,role,email:person.email,cellPhone:person.phone,contactVersion:version,profileVersion:person.version,publicationVersion:person.version+version};
 });
 for(const person of people){
  if(!person.active||linked.has(person.personId))continue;
  const flight=flights.get(person.flightId),role=directoryLeadershipRole(person.role,flight?.label??'',squadrons.get(flight?.squadronId)?.label??'');if(!role)continue;
  leadership.push({contactId:'cadet:'+createHash('sha256').update(person.personId).digest('hex'),personId:person.personId,lastName:person.lastName,firstName:person.firstName,rank:person.rank,role,email:person.email,cellPhone:person.phone,reportsTo:'',officePhone:'',officeLocation:'',active:true,contactVersion:0,profileVersion:person.version,publicationVersion:person.version});
 }
 check(new Set(leadership.map(c=>c.contactId)).size===leadership.length,'ADMIN_CAPTURE_CONTACT_IDENTITIES');
 return {...snapshot,people,leadership};
}
/** Coherent read-only capture: every data/catalog page and final verify retain one revision. */
export async function captureOperationalSnapshot(identity,request,{termId=null}={}){
 check(['local','staging'].includes(identity.environment)&&Number.isSafeInteger(identity.generation)&&identifier(identity.principalId)&&(termId===null||identifier(termId)),'ADMIN_CAPTURE_IDENTITY');
 let pageCount=0,totalBytes=0;
 const get=async(section,offset,revision,catalog=false)=>{
  const response=await request('/v1/admin/snapshot/page',{...identity,...(!catalog&&termId!==null?{termId}:{}),section,offset,revision});check(response.status===200,'ADMIN_CAPTURE_RETRY');
  const page=response.body,size=Buffer.byteLength(JSON.stringify(page));check(++pageCount<=512&&size<=FRONTEND_PAGE_MAX_BYTES&&(totalBytes+=size)<=16*1024*1024,'ADMIN_CAPTURE_SIZE');
  check(page.contractVersion===FRONTEND_PAGE_VERSION&&page.section===section&&(revision===null||same(page.revision,revision)),'ADMIN_CAPTURE_REVISION');return page;
 };
 const manifest=await get('manifest',0,null),pages=[];
 for(const section of FRONTEND_SECTIONS){let offset=0;do{const page=await get(section,offset,manifest.revision);check(page.offset===offset&&Array.isArray(page.rows),'ADMIN_CAPTURE_PAGE');pages.push(page);if(page.nextOffset===null)break;check(Number.isSafeInteger(page.nextOffset)&&page.nextOffset>offset,'ADMIN_CAPTURE_CURSOR');offset=page.nextOffset;}while(true);}
 const catalog=async section=>{const rows=[];let offset=0;do{const page=await get(section,offset,manifest.revision,true);check(Array.isArray(page.rows)&&page.rows.length<=32,'ADMIN_CAPTURE_CATALOG');rows.push(...page.rows);if(page.nextOffset===null)break;check(page.rows.length>0&&page.nextOffset===offset+page.rows.length,'ADMIN_CAPTURE_CURSOR');offset=page.nextOffset;}while(true);return rows;};
 const people=await catalog('directory-catalog'),contacts=await catalog('contacts-catalog'),verify=await get('verify',0,manifest.revision);
 const scoped=assembleFrontendSnapshotPages(manifest,pages,verify),snapshot=mergeOperationalCatalogs(scoped,people,contacts),current=scoped.terms.find(t=>t.isCurrent);
 check(current&&manifest.scope?.currentTermId===current.termId&&manifest.scope.termId===(termId??current.termId),'ADMIN_CAPTURE_SCOPE');
 snapshot.captureScope={termId:manifest.scope.termId,currentTermId:current.termId,directory:'lifetime',contacts:'lifetime'};
 verifySnapshot(snapshot);return snapshot;
}
