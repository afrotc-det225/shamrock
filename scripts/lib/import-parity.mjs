/** Lossless, offline legacy import rehearsal. No provider writes or SQL execution. */
import { importDigest } from './import-capture.mjs';

export const IMPORT_POLICY_VERSION = 'legacy-occurrences-v1';
export const IMPORT_SCHEMAS = Object.freeze({
  directory: 'last_name first_name as_year flight squadron rank role university email phone dorm cip_broad_area cip_code desired_assigned_afsc home_town home_state class_year dob flight_path_status photo_link'.split(' '),
  leadership: 'last_name first_name rank role reports_to email cell_phone office_phone office_location'.split(' '),
  event: 'event_id term training_week event_type display_name attendance_column_label expected_group flight_scope status start_datetime end_datetime location notes created_at created_by'.split(' '),
  attendance: 'submission_id submitted_at event attendance_type email name flight cadets'.split(' '),
  excusal: 'request_id event email last_name first_name flight squadron status decision decided_by decided_at requested_outcome attendance_effect prior_attendance_code submitted_at last_updated_at reason'.split(' '),
  decision: 'timestamp decision event reason requested_outcome email last_name first_name flight request_id'.split(' '),
  matrix: 'last_name first_name as_year flight squadron overall_attendance_pct llab_attendance_pct'.split(' '),
});
const CODES = new Set(['P','T','A','U','E','ES','MED','R','D','N/A']);
const YEARS = new Set(['AS100','AS150','AS200','AS250','AS300','AS400','AS500','AS700','AS800','AS900','AF Civ']);
const STATUSES = new Set(['Participating 1/4','Enrolled 2/4','Active 3/4','Ready 4/4','Inactive','Commissioned','Dropped']);
const EXCUSAL_STATUSES = new Set(['Submitted','Approved','Denied','Withdrawn','Superseded']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const clone = value => JSON.parse(JSON.stringify(value));
const populated = cell => !!cell && ['userEnteredValue','effectiveValue','hyperlink','textFormatRuns','chipRuns','note'].some(k => Object.hasOwn(cell,k));
export const importCellValue = cell => {
  const value = cell?.effectiveValue ?? cell?.userEnteredValue ?? {};
  return value.stringValue ?? value.numberValue ?? value.boolValue ?? (value.errorValue ? {error:value.errorValue.type} : null);
};
function text(cell, issues, field) {
  const v = importCellValue(cell);
  if (v === null) return '';
  if (typeof v === 'object') { issues.push(`cell-error:${field}`); return ''; }
  if (typeof v === 'number') {
    // Display spelling retains leading zeros, phone formatting and CIP precision; raw numeric evidence remains in the snapshot.
    issues.push(`numeric-text:${field}`);
    return typeof cell.formattedValue === 'string' ? cell.formattedValue : String(v);
  }
  if (typeof v !== 'string') { issues.push(`invalid-text:${field}`); return String(v); }
  if (v !== v.trim()) issues.push(`surrounding-whitespace:${field}`);
  return v.trim();
}
function exactDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value ? value : null;
}
/** Spreadsheet serials represent local wall time, not UTC. Ambiguous/nonexistent DST wall times stay unresolved. */
export function normalizeLegacyDate(cell, {dateOnly=false,timeZone} = {}) {
  const value = importCellValue(cell);
  if (value === null || value === '') return {value:null,issue:null};
  if (typeof value === 'string') {
    if (dateOnly) return {value:exactDate(value),issue:exactDate(value) ? null : 'date-text-not-iso'};
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return {value:null,issue:'timestamp-text-not-iso'};
    const parsed = new Date(value);
    return {value:Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,issue:Number.isFinite(parsed.getTime()) ? null : 'invalid-timestamp'};
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 200000) return {value:null,issue:'invalid-date-serial'};
  const localMs = Math.round((value - 25569) * 86400000), local = new Date(localMs);
  if (dateOnly) return {value:local.toISOString().slice(0,10),issue:Math.abs(value - Math.round(value)) > 1e-8 ? 'date-has-time' : null};
  if (!timeZone) return {value:null,issue:'timestamp-timezone-missing'};
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}); }
  catch { return {value:null,issue:'timestamp-timezone-invalid'}; }
  const wall = ms => { const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p=>[p.type,p.value])); return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); };
  const offsets = new Set([-36,-12,0,12,36].map(h=>{const t=Math.floor((localMs+h*3600000)/1000)*1000;return wall(t)-t;}));
  const matches = [...offsets].map(offset=>localMs-offset).filter(ms=>wall(ms) === Math.floor(localMs/1000)*1000);
  return matches.length === 1 ? {value:new Date(matches[0]).toISOString(),issue:null} : {value:null,issue:matches.length ? 'timestamp-dst-ambiguous' : 'timestamp-dst-nonexistent'};
}
/** Actual rich-link evidence, never the visible filename of a file chip. */
export function extractLegacyPhoto(cell) {
  const links = [];
  const add = value => { if (typeof value === 'string' && value) links.push(value); };
  add(cell?.hyperlink); add(cell?.userEnteredFormat?.textFormat?.link?.uri);
  for (const run of cell?.textFormatRuns ?? []) add(run.format?.link?.uri);
  for (const run of cell?.chipRuns ?? []) add(run.chip?.richLinkProperties?.uri);
  const formula = cell?.userEnteredValue?.formulaValue;
  if (typeof formula === 'string') { const match = /^=HYPERLINK\(\s*"((?:[^"]|"")+)"\s*[,;]/i.exec(formula); if (match) add(match[1].replace(/""/g,'"')); }
  const raw = importCellValue(cell); if (typeof raw === 'string' && /^https:\/\//.test(raw)) add(raw);
  const distinct = [...new Set(links)];
  if (!distinct.length) return {value:'',issue:raw || formula || cell?.chipRuns?.length ? 'photo-uri-unresolved' : null};
  if (distinct.length !== 1) return {value:'',issue:'photo-uri-conflict'};
  let url; try { url = new URL(distinct[0]); } catch { return {value:'',issue:'photo-uri-invalid'}; }
  return url.protocol === 'https:' && !url.username && !url.password ? {value:distinct[0],issue:null} : {value:'',issue:'photo-uri-invalid'};
}
function classify(sheet) {
  const headers = (sheet.rows[0] ?? []).map(c=>importCellValue(c) ?? '');
  const has = list => list.every(h=>headers.includes(h));
  let kind = 'unclassified';
  if (has(['event_id','attendance_column_label','expected_group'])) kind='event';
  else if (has(['submission_id','attendance_type','cadets'])) kind='attendance';
  else if (has(['request_id','attendance_effect','prior_attendance_code'])) kind='excusal';
  else if (has(['request_id','timestamp','decision'])) kind='decision';
  else if (has(IMPORT_SCHEMAS.matrix)) kind='matrix';
  else if (has(['last_name','first_name','as_year','email','cip_code'])) kind='directory';
  else if (has(IMPORT_SCHEMAS.leadership)) kind='leadership';
  else if (has(['audit_id','action','actor_email'])) kind='audit';
  else if (/response/i.test(sheet.metadata.properties.title)) kind='raw-response';
  else if (/Data Legend/i.test(sheet.metadata.properties.title)) kind='legend';
  else if (/Dashboard/i.test(sheet.metadata.properties.title)) kind='dashboard';
  const schema = IMPORT_SCHEMAS[kind], issues=[];
  if (schema) {
    const nonblank=headers.filter(Boolean); if(new Set(nonblank).size!==nonblank.length) issues.push('duplicate-machine-header');
    for (const header of schema) if (!headers.includes(header)) issues.push(`missing-header:${header}`);
    const used=Math.max(headers.length,...sheet.rows.map(row=>row.length));
    for(let c=0;c<used;c++) if(!headers[c] && sheet.rows.slice(2).some(row=>populated(row[c]))) issues.push('populated-unheaded-column');
  }
  const authoritative = {
    directory:'Directory Backend',leadership:'Leadership Backend',event:'Events Backend',attendance:'Attendance Backend',excusal:'Excusals Backend',audit:'Audit Backend',matrix:'Attendance',
  }[kind] === sheet.metadata.properties.title;
  return {kind,headers,issues:[...new Set(issues)],authoritative};
}
function bindingsFor(crosswalk,snapshot) {
  check(crosswalk?.formatVersion===1 && crosswalk.snapshotSha256===snapshot.snapshotSha256 && Array.isArray(crosswalk.bindings) && crosswalk.bindings.length<=100000,'IMPORT_CROSSWALK');
  const map=new Map();
  for(const binding of crosswalk.bindings) {
    check(binding && /^occ_[a-f0-9]{64}$/.test(binding.occurrenceId) && HASH.test(binding.fingerprint) && !map.has(binding.occurrenceId),'IMPORT_CROSSWALK_BINDING');
    check(typeof binding.reviewReference==='string' && binding.reviewReference.length>0 && binding.reviewReference.length<=240,'IMPORT_CROSSWALK_REVIEW');
    for(const [key,value] of Object.entries(binding.targets ?? {})) {
      check(['personId','eventId','termId','flightId','squadronId','requestId','contactId','nativeResponseId','personIds','eventIds'].includes(key),'IMPORT_CROSSWALK_TARGET');
      if(value===null) {check(['flightId','squadronId','personId'].includes(key),'IMPORT_CROSSWALK_NULL');continue;}
      const ids=Array.isArray(value)?value:[value]; check(ids.length<=500 && ids.every(id=>typeof id==='string' && IDENTIFIER.test(id)),'IMPORT_CROSSWALK_ID');
      check(Array.isArray(value)===['personIds','eventIds'].includes(key),'IMPORT_CROSSWALK_SHAPE');
      if(Array.isArray(value)) check(new Set(value).size===value.length,'IMPORT_CROSSWALK_DUPLICATE_TARGET');
    }
    map.set(binding.occurrenceId,{occurrenceId:binding.occurrenceId,fingerprint:binding.fingerprint,reviewReference:binding.reviewReference,targets:clone(binding.targets??{})});
  }
  return map;
}
function normalizeRow(kind,headers,cells,timeZone,binding) {
  const issues=[],warnings=[],fields={},at=header=>cells[headers.indexOf(header)];
  for(const h of (IMPORT_SCHEMAS[kind] ?? []).filter(h=>headers.includes(h))) fields[h]=text(at(h),warnings,h);
  const targets=binding?.targets ?? {};
  const required = (key,nullable=false) => {if(!Object.hasOwn(targets,key)) issues.push(`unresolved-${key}`);else if(targets[key]===null&&!nullable)issues.push(`invalid-target:${key}`);};
  const date = (field,dateOnly=false) => {const result=normalizeLegacyDate(at(field),{dateOnly,timeZone});if(result.issue) issues.push(`${result.issue}:${field}`);return result.value;};
  if(kind==='directory') {
    required('personId'); if(fields.flight) required('flightId'); if(fields.squadron) required('squadronId');
    if(!fields.last_name || !fields.first_name) issues.push('missing-person-name');
    if(!YEARS.has(fields.as_year)) issues.push('unsupported-as-year');
    if(!STATUSES.has(fields.flight_path_status)) issues.push('unsupported-flight-path-status');
    if(fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) issues.push('invalid-email');
    const photo=extractLegacyPhoto(at('photo_link'));if(photo.issue) issues.push(photo.issue);
    const profile={lastName:fields.last_name,firstName:fields.first_name,asYear:fields.as_year,rank:fields.rank,role:fields.role,university:fields.university,email:fields.email.toLowerCase(),phone:fields.phone,dorm:fields.dorm,cipBroadArea:fields.cip_broad_area,cipCode:fields.cip_code,afsc:fields.desired_assigned_afsc,homeTown:fields.home_town,homeState:fields.home_state,classYear:fields.class_year,dateOfBirth:date('dob',true),flightPathStatus:fields.flight_path_status,photoLink:photo.value};
    if(profile.classYear && !/^\d{4}$/.test(profile.classYear)) issues.push('invalid-class-year');
    return {value:{kind,profile,flightLabel:fields.flight,squadronLabel:fields.squadron,...targets},issues,warnings};
  }
  if(kind==='event') {
    required('termId');required('eventId');
    if(!fields.event_id || !IDENTIFIER.test(fields.event_id)) issues.push('invalid-legacy-event-id');
    if(!['mando','secondary','llab','other'].includes(fields.event_type.toLowerCase())) issues.push('unsupported-event-type');
    if(!['active','cancelled','inactive','archived'].includes(fields.status.toLowerCase())) issues.push('unsupported-event-status');
    return {value:{kind,...fields,startAt:date('start_datetime'),endAt:date('end_datetime'),createdAt:date('created_at'),eligiblePersonIds:null,eligibilityEvidence:'unavailable',...targets},issues,warnings};
  }
  if(kind==='leadership') {
    required('contactId');required('personId',true); // Explicit null denotes a reviewed manual contact, never infer it from the name.
    return {value:{kind,...fields,...targets},issues,warnings};
  }
  if(kind==='attendance') {
    required('eventId');required('flightId');required('personIds');
    if(!fields.submission_id) issues.push('missing-submission-id');
    if(!targets.nativeResponseId) warnings.push('native-response-provenance-unresolved');
    // This is a legacy selected-cadet list; it is not a reconstructed frozen event roster or a list of absences.
    return {value:{kind,...fields,submittedAt:date('submitted_at'),rosterEvidence:'unavailable',nativeResponseEvidence:targets.nativeResponseId?'reviewed-crosswalk':'unresolved',...targets},issues,warnings};
  }
  if(kind==='excusal') {
    for(const key of ['personId','eventId','requestId','flightId']) required(key);
    if(!fields.request_id) issues.push('missing-request-id');
    if(!EXCUSAL_STATUSES.has(fields.status)) issues.push('unsupported-request-status');
    if(fields.decision && !['Approved','Denied','Withdrawn','Superseded'].includes(fields.decision)) issues.push('unsupported-decision');
    if(!['P','T','E','ES','MED'].includes(fields.requested_outcome)) issues.push('unsupported-requested-outcome');
    for(const field of ['attendance_effect','prior_attendance_code']) if(fields[field] && !CODES.has(fields[field])) issues.push(`unsupported-code:${field}`);
    if(fields.decision && fields.decision !== fields.status) issues.push('decision-status-conflict');
    return {value:{kind,...fields,submittedAt:date('submitted_at'),updatedAt:date('last_updated_at'),decidedAt:date('decided_at'),historyCompleteness:'current-state-only',...targets},issues,warnings};
  }
  if(kind==='matrix') {
    const events=headers.slice(7).map((header,i)=>({columnIndex:i+7,header,displayCode:importCellValue(cells[i+7]),eventId:targets.eventIds?.[i] ?? null}));
    for(const event of events) if(event.displayCode!==null && event.displayCode!=='' && !CODES.has(event.displayCode)) issues.push('unsupported-matrix-code');
    if(targets.eventIds && targets.eventIds.length!==events.length) issues.push('matrix-event-crosswalk-length');
    return {value:{kind,identityLabels:fields,events,overall:importCellValue(at('overall_attendance_pct')),llab:importCellValue(at('llab_attendance_pct')),historyCompleteness:'snapshot-only',...targets},issues,warnings};
  }
  return {value:{kind,...fields,...targets},issues,warnings};
}
function summaryOf(ledger,sources,notes) {
  const dispositions={},kinds={},issues={},warnings={};
  for(const row of ledger) {dispositions[row.disposition]=(dispositions[row.disposition]??0)+1;kinds[row.kind]=(kinds[row.kind]??0)+1;for(const issue of row.issues)issues[issue]=(issues[issue]??0)+1;for(const w of row.warnings)warnings[w]=(warnings[w]??0)+1;}
  return {policyVersion:IMPORT_POLICY_VERSION,totalOccurrences:ledger.length,dispositions,kinds,issues,warnings,sourceSurfaces:sources.length,
    physicalRows:sources.reduce((n,s)=>n+(s.physicalRows??0),0),emptyRows:sources.reduce((n,s)=>n+(s.emptyRows??0),0),notes};
}
/** Every occurrence has exactly one disposition. The immutable capture is the authoritative raw evidence. */
export function buildImportPlan(snapshot,crosswalk={formatVersion:1,snapshotSha256:snapshot?.snapshotSha256,bindings:[]}) {
  check(snapshot?.formatVersion===1 && snapshot.consistent===true && snapshot.writerFence===false && Array.isArray(snapshot.resources),'IMPORT_SNAPSHOT_CONSISTENCY');
  const {snapshotSha256,...hashed}=snapshot; check(HASH.test(snapshotSha256) && importDigest(hashed)===snapshotSha256,'IMPORT_SNAPSHOT_HASH');
  const bindings=bindingsFor(crosswalk,snapshot),used=new Set(),ledger=[],records=[],sources=[],naturalKeys=new Map(),directoryEmails=new Map();
  const add = ({locator,raw,kind,disposition='evidence-only',issues=[],warnings=[],normalized}) => {
    const occurrenceId=`occ_${importDigest(locator)}`,fingerprint=importDigest(raw),binding=bindings.get(occurrenceId);
    if(binding) {check(binding.fingerprint===fingerprint,'IMPORT_CROSSWALK_STALE');used.add(occurrenceId);}
    const row={occurrenceId,fingerprint,locator,kind,disposition,issues:[...new Set(issues)],warnings:[...new Set(warnings)],binding:binding?clone(binding):null};
    if(normalized) {row.normalizedIndex=records.length;records.push({occurrenceId,...normalized});}
    ledger.push(row);return {row,binding};
  };
  for(const resource of snapshot.resources) {
    check(resource.coherent===true,'IMPORT_INCOHERENT_RESOURCE');
    const root={resourceKey:resource.key,providerId:resource.providerId};
    add({locator:{...root,type:'resource-metadata'},raw:resource.metadata,kind:'resource-metadata'});
    if(resource.kind==='form') {
      for(const response of resource.responses) add({locator:{...root,type:'native-form-response',responseId:response.responseId},raw:response,kind:'native-form-response',normalized:{kind:'native-form-response',response:clone(response)}});
      sources.push({resourceKey:resource.key,kind:'form',responses:resource.responses.length});continue;
    }
    for(const sheet of resource.sheets) {
      const classification=classify(sheet),sheetRoot={...root,sheetId:sheet.metadata.properties.sheetId},schema=IMPORT_SCHEMAS[classification.kind];
      const authoritative=resource.role==='backend' && classification.authoritative && !['matrix','audit'].includes(classification.kind);
      add({locator:{...sheetRoot,type:'sheet-metadata'},raw:sheet.metadata,kind:'sheet-metadata'});
      let nonempty=0;
      for(let r=0;r<sheet.rows.length;r++) {
        const cells=sheet.rows[r];if(!cells.some(populated))continue;nonempty++;
        const locator={...sheetRoot,type:'sheet-row',rowIndex:r},occurrenceId=`occ_${importDigest(locator)}`,binding=bindings.get(occurrenceId);
        const isHeader=!!schema && r<2;
        let norm=isHeader?null:normalizeRow(classification.kind,classification.headers,cells,resource.metadata.properties.timeZone,binding);
        const issues=isHeader?[]:[...classification.issues,...(norm?.issues??[])];
        // Missing crosswalks are relevant only to authoritative migration candidates, not snapshot-only mirrors/archives.
        const effectiveIssues=authoritative?issues:issues.filter(i=>!i.startsWith('unresolved-'));
        const disposition=effectiveIssues.length?'quarantined':authoritative&&!isHeader?'normalized':'evidence-only';
        const {row}=add({locator,raw:cells,kind:isHeader?'schema-header':classification.kind,disposition,issues:effectiveIssues,warnings:norm?.warnings??[],normalized:norm?.value});
        if(authoritative && !isHeader) {
          const field={event:'event_id',attendance:'submission_id',excusal:'request_id'}[classification.kind];
          if(field) {const value=importCellValue(cells[classification.headers.indexOf(field)]);if(value) {const key=`${classification.kind}:${String(value)}`;const group=naturalKeys.get(key)??[];group.push(row);naturalKeys.set(key,group);}}
          if(classification.kind==='directory') {const email=String(importCellValue(cells[classification.headers.indexOf('email')])??'').trim().toLowerCase();if(email){const group=directoryEmails.get(email)??[];group.push(row);directoryEmails.set(email,group);}}
        }
      }
      sources.push({resourceKey:resource.key,sheetId:sheetRoot.sheetId,kind:classification.kind,authoritative,physicalRows:sheet.rows.length,nonemptyRows:nonempty,emptyRows:sheet.rows.length-nonempty,columns:sheet.metadata.properties.gridProperties.columnCount,headerIssues:classification.issues});
    }
  }
  check(used.size===bindings.size,'IMPORT_CROSSWALK_UNKNOWN_OCCURRENCE');
  const collisions=[];
  for(const [kind,groups] of [['natural-id',naturalKeys],['directory-email',directoryEmails]]) for(const group of groups.values()) if(group.length>1) {
    collisions.push({kind,occurrenceIds:group.map(r=>r.occurrenceId),identical:group.every(r=>r.fingerprint===group[0].fingerprint)});
    for(const row of group){row.disposition='quarantined';row.issues.push(`duplicate-${kind}`);}
  }
  check(new Set(ledger.map(r=>r.occurrenceId)).size===ledger.length,'IMPORT_OCCURRENCE_COLLISION');
  const summary=summaryOf(ledger,sources,['Optimistic read window; no production writer fence.','Archives/matrices are preserved snapshots, not inferred observations or historical rosters.','Native Forms current response state does not establish a complete response-edit history.','A normalized record is an offline import candidate, not permission to execute commands or send notifications.']);
  const canonicalCrosswalk={formatVersion:1,snapshotSha256,bindings:[...bindings.values()].sort((a,b)=>a.occurrenceId.localeCompare(b.occurrenceId))};
  const result={formatVersion:1,policyVersion:IMPORT_POLICY_VERSION,snapshotSha256,crosswalkSha256:importDigest(canonicalCrosswalk),ledger,records,sources,collisions,summary,readyForD1Write:false};
  result.planSha256=importDigest(result);return result;
}
export function verifyImportAccounting(snapshot,plan) {
  check(plan?.snapshotSha256===snapshot?.snapshotSha256,'IMPORT_ACCOUNTING_SNAPSHOT');
  const crosswalk={formatVersion:1,snapshotSha256:snapshot.snapshotSha256,bindings:plan.ledger.filter(r=>r.binding).map(r=>r.binding)};
  const expected=buildImportPlan(snapshot,crosswalk);
  const {planSha256,...body}=plan;
  check(planSha256===importDigest(body) && planSha256===expected.planSha256,'IMPORT_ACCOUNTING_MISMATCH');
  return {complete:true,totalOccurrences:plan.ledger.length,dispositionTotal:Object.values(plan.summary.dispositions).reduce((a,b)=>a+b,0),snapshotSha256:snapshot.snapshotSha256,planSha256};
}
/** Compare lossless staging readback; receipt hashes alone are insufficient without exact source-occurrence coverage. */
export function compareImportReadback(plan,readback) {
  check(readback?.formatVersion===1 && readback.snapshotSha256===plan.snapshotSha256 && Array.isArray(readback.occurrences),'IMPORT_READBACK');
  const expected=new Map(plan.ledger.map(r=>[r.occurrenceId,r])),actual=new Map(),differences=[];
  for(const row of readback.occurrences){if(actual.has(row.occurrenceId)) differences.push({code:'duplicate-readback-occurrence',occurrenceId:row.occurrenceId});else actual.set(row.occurrenceId,row);}
  let matched=0;
  for(const [id,row] of expected){const observed=actual.get(id);if(!observed)differences.push({code:'missing-occurrence',occurrenceId:id});else if(observed.fingerprint!==row.fingerprint||observed.disposition!==row.disposition)differences.push({code:'changed-occurrence',occurrenceId:id});else matched++;}
  for(const id of actual.keys())if(!expected.has(id))differences.push({code:'unexpected-occurrence',occurrenceId:id});
  return {complete:differences.length===0,matched,expected:expected.size,actual:readback.occurrences.length,differences};
}
/** Explicit matrix bindings only. Never join a person/event from a display name or column label. */
export function compareAttendanceSnapshots(plan,target) {
  check(target?.formatVersion===1 && target.policyVersion==='legacy-shamrock-credit-v1' && Array.isArray(target.rows),'IMPORT_REPORT_TARGET');
  const key=r=>`${r.termId}\u0000${r.personId}`,byId=new Map();
  for(const row of target.rows){check(IDENTIFIER.test(row.termId)&&IDENTIFIER.test(row.personId)&&!byId.has(key(row))&&Array.isArray(row.events),'IMPORT_REPORT_ID');check(new Set(row.events.map(e=>e.eventId)).size===row.events.length,'IMPORT_REPORT_EVENT_COLLISION');byId.set(key(row),row);}
  const differences=[],expectedRows=new Set();let compared=0,blocked=0;
  for(const row of plan.records.filter(r=>r.kind==='matrix')) {
    if(!row.personId||!row.termId||row.events.some(e=>!e.eventId)){blocked++;continue;}
    expectedRows.add(key(row));const observed=byId.get(key(row));if(!observed){differences.push({code:'missing-matrix-person',occurrenceId:row.occurrenceId});continue;}
    const events=new Map(observed.events.map(e=>[e.eventId,e.code]));
    for(const event of row.events){compared++;const expected=event.displayCode===''?null:event.displayCode;if(!events.has(event.eventId)||events.get(event.eventId)!==expected)differences.push({code:'attendance-cell-difference',occurrenceId:row.occurrenceId,eventId:event.eventId});}
    for(const eventId of events.keys())if(!row.events.some(e=>e.eventId===eventId))differences.push({code:'unexpected-matrix-event',occurrenceId:row.occurrenceId,eventId});
    for(const field of ['overall','llab'])if(typeof row[field]==='number'&&(typeof observed[field]!=='number'||Math.abs(row[field]-observed[field])>1e-9))differences.push({code:`${field}-percentage-difference`,occurrenceId:row.occurrenceId});
  }
  for(const [id,row] of byId)if(!expectedRows.has(id))differences.push({code:'unexpected-matrix-person',personId:row.personId,termId:row.termId});
  return {policyVersion:target.policyVersion,comparedCells:compared,blockedMatrixRows:blocked,differences,parityEstablished:compared>0&&blocked===0&&differences.length===0};
}

/** Suggestions require review before becoming bindings; names are never an identity join. */
export function proposeImportCrosswalk(plan) {
  const sourceKeys=new Set(plan.sources.filter(s=>s.authoritative).map(s=>`${s.resourceKey}:${s.sheetId}`));
  const ledger=new Map(plan.ledger.map(r=>[r.occurrenceId,r]));
  const records=plan.records.filter(r=>{const l=ledger.get(r.occurrenceId);return sourceKeys.has(`${l.locator.resourceKey}:${l.locator.sheetId}`);});
  const drafts=new Map(records.map(record=>{const l=ledger.get(record.occurrenceId);return [record.occurrenceId,{occurrenceId:record.occurrenceId,fingerprint:l.fingerprint,reviewReference:'',targets:{},evidence:[],unresolved:l.issues.filter(i=>i.startsWith('unresolved-')).map(i=>i.slice(11))}];}));
  const emails=new Map(),aliases=new Map(),flightSquadrons=new Map();
  const stable=(kind,value)=>`${kind}:legacy:${importDigest(value).slice(0,32)}`;
  const group=(map,key,value)=>{const rows=map.get(key)??[];rows.push(value);map.set(key,rows);};
  for(const r of records.filter(r=>r.kind==='directory')){
    if(r.profile.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.profile.email))group(emails,r.profile.email.toLowerCase(),r);
    if(r.flightLabel&&r.squadronLabel)group(flightSquadrons,r.flightLabel,r.squadronLabel);
  }
  const flight=(label,draft)=>{
    const squads=new Set(flightSquadrons.get(label)??[]);
    if(!label||squads.size!==1)return;
    draft.targets.flightId=stable('flight',label);draft.targets.squadronId=stable('squadron',[...squads][0]);draft.evidence.push('explicit-current-flight-and-squadron');
  };
  for(const r of records.filter(r=>r.kind==='directory')){
    const draft=drafts.get(r.occurrenceId),matches=emails.get(r.profile.email.toLowerCase());
    if(matches?.length===1){draft.targets.personId=stable('person',r.occurrenceId);draft.evidence.push('unique-current-directory-email-anchor');}
    flight(r.flightLabel,draft);
  }
  const eventIds=new Map();for(const r of records.filter(r=>r.kind==='event'))group(eventIds,r.event_id,r);
  for(const r of records.filter(r=>r.kind==='event')) {
    const draft=drafts.get(r.occurrenceId);
    if(IDENTIFIER.test(r.event_id)&&eventIds.get(r.event_id).length===1){draft.targets.eventId=r.event_id;draft.evidence.push('explicit-legacy-event-id');}
    if(r.term){draft.targets.termId=stable('term',r.term);draft.evidence.push('explicit-legacy-term-label');}
    for(const alias of new Set([r.event_id,r.display_name,r.attendance_column_label].filter(Boolean)))group(aliases,alias,r);
  }
  const person=(email,draft)=>{
    const rows=emails.get(email?.toLowerCase());if(rows?.length!==1)return;
    const target=drafts.get(rows[0].occurrenceId).targets.personId;
    if(target){draft.targets.personId=target;draft.evidence.push('unique-exact-current-directory-email');}
  };
  for(const r of records){
    const draft=drafts.get(r.occurrenceId);
    if(['excusal','attendance'].includes(r.kind)){
      const candidates=aliases.get(r.event)??[];
      if(candidates.length===1){const event=drafts.get(candidates[0].occurrenceId);if(event.targets.eventId){draft.targets.eventId=event.targets.eventId;draft.targets.termId=event.targets.termId;draft.evidence.push('unique-exact-catalog-event-alias');}}
      flight(r.flight,draft);
    }
    if(r.kind==='excusal') {person(r.email,draft);if(IDENTIFIER.test(r.request_id)){draft.targets.requestId=r.request_id;draft.evidence.push('explicit-legacy-request-id');}}
    if(r.kind==='leadership') {person(r.email,draft);draft.targets.contactId=stable('contact',r.occurrenceId);draft.evidence.push('source-occurrence-contact-anchor');}
    draft.unresolved=draft.unresolved.filter(key=>!Object.hasOwn(draft.targets,key));
  }
  const bindings=[...drafts.values()];
  return {formatVersion:1,snapshotSha256:plan.snapshotSha256,reviewRequired:true,bindings,
    summary:{suggestedBindings:bindings.length,fullySuggested:bindings.filter(b=>!b.unresolved.length).length,unresolved:bindings.reduce((counts,b)=>{for(const key of b.unresolved)counts[key]=(counts[key]??0)+1;return counts;},{})}};
}
