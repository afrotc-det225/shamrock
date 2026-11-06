/** Source-backed reconciliation. Preserved matrix state is not re-labelled as an observed submission. */
import {importDigest} from './import-capture.mjs';
import {importCellValue,normalizeLegacyDate,proposeImportCrosswalk} from './import-parity.mjs';
const val=cell=>importCellValue(cell);
const str=cell=>String(val(cell)??'').trim();
const norm=value=>String(value??'').trim().toLowerCase();
const stable=(kind,value)=>`${kind}:legacy:${importDigest(value).slice(0,32)}`;
const group=(map,key,value)=>{const values=map.get(key)??[];values.push(value);map.set(key,values);};
const tuple=(headers,cells)=>['last_name','first_name','as_year','flight','squadron'].map(h=>norm(val(cells[headers.indexOf(h)])));
const literalValue=cell=>{const v=val(cell);return v===''?null:v;};
const occurrence=(resource,sheet,rowIndex)=>`occ_${importDigest({resourceKey:resource.key,providerId:resource.providerId,sheetId:sheet.metadata.properties.sheetId,type:'sheet-row',rowIndex})}`;
function formulaColumns(formula){
  const match=/BYROW\(\$?([A-Z]{1,3})\$?3:\$?([A-Z]{1,3})(?:\$?\d+)?,LAMBDA\(r,/.exec(formula??'');
  const number=label=>[...label].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
  return match?{startColumnIndex:number(match[1])-1,endColumnIndex:number(match[2])}:null;
}
export const HISTORICAL_CODE_EVIDENCE=Object.freeze({
  sourceCommit:'39117a897e3416e19d4fd729233f396fbf0ae5e7^',
  definitionsSource:'docs/system/DATA_LEGEND_RANGES.md',
  pendingSource:'src/services/excusals.ts:updateAttendanceOnExcusalSubmission',
  creditSource:'src/services/attendance.ts:CREDIT_PATTERNS/TOTAL_PATTERNS',
  codes:{ER:'Excusal Requested',ED:'Excusal Denied',UR:'Unexcused – Report Submitted',MU:'Make-Up',MRS:'Medical / No PT',MUR:'MU request pending (requested type plus R in historical code)'},
  automaticCurrentCodeRemap:false,
});
/** Only the policy demonstrated by a retained formula can explain a historical percentage. */
export function compareLegacyCredit(codes,formula,stored) {
  let policy='unavailable',numerator=0,denominator=0;
  const patterns=name=>{const match=new RegExp(`${name},BYCOL\\(r,LAMBDA\\(c,IF\\(SUM\\(COUNTIF\\(c,\\{([^}]+)\\}`).exec(formula??'');return match?[...match[1].matchAll(/"([A-Z/*]+)"/g)].map(m=>m[1]):null;};
  const credit=patterns('cred'),total=patterns('tot');
  if(typeof formula==='string'&&formula.includes('IF(den=0,1,num/den)')){
    if(JSON.stringify(credit)===JSON.stringify(['P','T','E','ES','MED'])&&JSON.stringify(total)===JSON.stringify(['P','T','A','U','E','ES','MED']))policy='legacy-shamrock-credit-v1';
    if(JSON.stringify(credit)===JSON.stringify(['P*','E','ES*','MU*','MRS*'])){
      if(JSON.stringify(total)===JSON.stringify(['P*','E','ES*','T*','U','UR','MU*','MRS*']))policy='legacy-pre-v2-ur-counted';
      if(JSON.stringify(total)===JSON.stringify(['P*','E','ES*','T*','U','MU*','MRS*']))policy='legacy-pre-v2-ur-neutral';
    }
  }
  if(policy==='unavailable')return {policy,stored,calculated:null,matches:null};
  const matches=(code,list)=>list.some(p=>p.endsWith('*')?code.startsWith(p.slice(0,-1)):code===p);
  for(const raw of codes){const code=String(raw??'').toUpperCase();if(matches(code,credit))numerator++;if(matches(code,total))denominator++;}
  const calculated=denominator?numerator/denominator:1;
  return {policy,creditPatterns:credit,totalPatterns:total,zeroDenominatorResult:1,numerator,denominator,stored,calculated,matches:typeof stored==='number'&&Math.abs(stored-calculated)<1e-9};
}
/** Reconcile snapshots by their same-workbook Directory provenance plus all five matrix identity columns. */
export function reconcileImportEvidence(snapshot,plan) {
  if(snapshot.snapshotSha256!==plan.snapshotSha256)throw new Error('IMPORT_RECONCILIATION_SNAPSHOT');
  const proposals=proposeImportCrosswalk(plan),drafts=new Map(proposals.bindings.map(b=>[b.occurrenceId,b]));
  const ledger=new Map(plan.ledger.map(l=>[l.occurrenceId,l]));
  const currentDirectories=plan.records.filter(r=>r.kind==='directory'&&drafts.has(r.occurrenceId));
  const emailAnchors=new Map(),anchorNames=new Map();for(const r of currentDirectories)if(drafts.get(r.occurrenceId).targets.personId){emailAnchors.set(norm(r.profile.email),drafts.get(r.occurrenceId).targets.personId);anchorNames.set(norm(r.profile.email),[norm(r.profile.lastName),norm(r.profile.firstName)]);}
  const allDirectories=[];
  for(const resource of snapshot.resources.filter(r=>r.kind==='workbook'))for(const sheet of resource.sheets){
    const headers=(sheet.rows[0]??[]).map(str);if(!['last_name','first_name','as_year','email','cip_code'].every(h=>headers.includes(h)))continue;
    const rows=[];
    for(let r=2;r<sheet.rows.length;r++){
      const cells=sheet.rows[r],email=norm(val(cells[headers.indexOf('email')])),identity=tuple(headers,cells);if(!identity[0]&&!identity[1])continue;
      const personId=email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?emailAnchors.get(email)??stable('historical-person',email):null;
      rows.push({occurrenceId:occurrence(resource,sheet,r),email,identity,personId,anchorKind:emailAnchors.has(email)?'unique-current-email':'historical-email-anchor',cells});
    }
    allDirectories.push({resource,sheet,headers,rows});
  }
  // An email occurring with different first/last names in the retained archive is a conflict, not a silent merge.
  const byEmail=new Map();for(const dir of allDirectories)for(const row of dir.rows)if(row.personId)group(byEmail,row.email,row);
  const ambiguousEmails=new Set([...byEmail].filter(([,rows])=>new Set(rows.map(r=>JSON.stringify(r.identity.slice(0,2)))).size>1).map(([email])=>email));
  const identityProven=row=>!!row.personId&&(!ambiguousEmails.has(row.email)||JSON.stringify(anchorNames.get(row.email))===JSON.stringify(row.identity.slice(0,2)));
  const events=plan.records.filter(r=>r.kind==='event'&&drafts.has(r.occurrenceId));
  const eventAliases=new Map();for(const event of events)for(const alias of new Set([event.event_id,event.display_name,event.attendance_column_label].filter(Boolean)))group(eventAliases,alias,event);
  const matrices=[],matrixRows=[],issues=[],historicalPeople=[];
  for(const resource of snapshot.resources.filter(r=>r.kind==='workbook'))for(const sheet of resource.sheets){
    const headers=(sheet.rows[0]??[]).map(str);if(!['last_name','first_name','as_year','flight','squadron','overall_attendance_pct','llab_attendance_pct'].every(h=>headers.includes(h)))continue;
    const title=sheet.metadata.properties.title;
    const directoryTitle=title==='Attendance Matrix Backend'?'Directory Backend':title.replace(/Attendance$/,'Directory');
    const companions=allDirectories.filter(d=>d.resource.key===resource.key&&d.sheet.metadata.properties.title===directoryTitle);
    const companion=companions.length===1?companions[0]:null;
    const isCurrent=resource.role==='backend'&&title==='Attendance Matrix Backend'||resource.role==='main'&&title==='Attendance';
    const catalogTerms=[...new Set(events.map(e=>e.term).filter(Boolean))];
    const periodLabel=title.endsWith(' Attendance')?title.slice(0,-11):isCurrent&&catalogTerms.length===1?catalogTerms[0]:resource.metadata.properties.title.match(/\b(?:Fall|Spring|Summer) 20\d{2}\b/)?.[0]??null;
    const periodId=isCurrent?'current-capture':stable('snapshot-period',[resource.key,periodLabel??resource.metadata.properties.title]);
    const currentEventHeaders=headers.slice(7).map(header=>{const candidates=eventAliases.get(header)??[];return candidates.length===1?candidates[0]:null;});
    const columns=headers.slice(7).map((header,index)=>({columnIndex:index+7,header,snapshotEventId:stable('snapshot-event',[resource.key,sheet.metadata.properties.sheetId,index+7]),eventId:isCurrent&&currentEventHeaders[index]?drafts.get(currentEventHeaders[index].occurrenceId).targets.eventId??null:null}));
    const sourceRoster=(companion?.rows??[]).map(r=>({personId:identityProven(r)?r.personId:null,directoryOccurrenceId:r.occurrenceId,
      profile:Object.fromEntries(['last_name','first_name','as_year','flight','squadron','flight_path_status'].filter(h=>companion.headers.includes(h)).map(h=>[h,val(r.cells[companion.headers.indexOf(h)])])),
      dateOfBirth:normalizeLegacyDate(r.cells[companion.headers.indexOf('dob')],{dateOnly:true}),
      identityEvidence:'retained-companion-directory-email',eventEligibility:'not-reconstructable-from-term-roster'}));
    const matrix={resourceKey:resource.key,sheetId:sheet.metadata.properties.sheetId,sourceTitle:title,periodId,periodLabel,termCandidateId:periodLabel?stable('term',periodLabel):null,isCurrent,
      authority:resource.role==='backend'&&isCurrent?'current-backend':'retained-source-copy',companionDirectoryFound:!!companion,sourceRoster,columns,rows:[]};
    for(let r=2;r<sheet.rows.length;r++){
      const cells=sheet.rows[r],identity=tuple(headers,cells);if(!identity[0]&&!identity[1])continue;
      const candidates=(companion?.rows??[]).filter(d=>JSON.stringify(d.identity)===JSON.stringify(identity));
      const exact=candidates.length===1&&identity[0]&&identity[1]&&identity[2]&&(identity[3]||identity[4])&&identityProven(candidates[0])?candidates[0]:null;
      const entry={occurrenceId:occurrence(resource,sheet,r),personId:exact?.personId??null,personEvidence:exact?{directoryOccurrenceId:exact.occurrenceId,method:'same-workbook-directory-five-field-tuple-and-email-anchor',anchorKind:exact.anchorKind}:null,
        periodId,identityLabels:identity,events:columns.map(c=>({...c,code:literalValue(cells[c.columnIndex])})),historyCompleteness:'matrix-snapshot-only',importAs:'legacy-effective-cell-snapshot',eligiblePersonIds:null,
        overall:val(cells[headers.indexOf('overall_attendance_pct')]),llab:val(cells[headers.indexOf('llab_attendance_pct')])};
      const formulaFor=field=>{const index=headers.indexOf(field),current=cells[index],anchor=sheet.rows[2]?.[index]?.userEnteredValue?.formulaValue;return current?.userEnteredValue?.formulaValue??(!current?.userEnteredValue&&/^=ARRAYFORMULA\(/.test(anchor??'')?anchor:null);};
      const overallRange=formulaColumns(formulaFor('overall_attendance_pct')),llabRange=formulaColumns(formulaFor('llab_attendance_pct'));
      const inside=(e,range)=>range&&e.columnIndex>=range.startColumnIndex&&e.columnIndex<range.endColumnIndex;
      const allCodes=entry.events.filter(e=>inside(e,overallRange)).map(e=>e.code),llabCodes=entry.events.filter(e=>inside(e,llabRange)&&/llab/i.test(e.header)).map(e=>e.code);
      entry.credit={overall:compareLegacyCredit(allCodes,overallRange?formulaFor('overall_attendance_pct'):null,entry.overall),llab:compareLegacyCredit(llabCodes,llabRange?formulaFor('llab_attendance_pct'):null,entry.llab)};
      entry.formulaCoverage={overall:overallRange,llab:llabRange,excludedEventColumns:entry.events.filter(e=>overallRange&&!inside(e,overallRange)).map(e=>e.columnIndex)};
      entry.creditFormulaEvidence={overall:formulaFor('overall_attendance_pct'),llab:formulaFor('llab_attendance_pct'),arrayAnchorRowIndex:2};
      if(!exact)issues.push({code:candidates.length>1?'ambiguous-matrix-directory-tuple':candidates.length===1?'matrix-email-history-conflict':'matrix-directory-tuple-unresolved',occurrenceId:entry.occurrenceId});
      matrix.rows.push(entry);matrixRows.push(entry);
      if(exact&&exact.anchorKind==='historical-email-anchor')historicalPeople.push({personId:exact.personId,directoryOccurrenceId:exact.occurrenceId});
    }
    matrices.push(matrix);
  }
  const native=matchNativeProvenance(snapshot,plan);
  const liveMatrices=matrices.filter(m=>m.isCurrent),backend=liveMatrices.find(m=>m.resourceKey==='backend'),frontend=liveMatrices.find(m=>m.resourceKey==='main');
  const mirrorComparison=compareMatrices(backend,frontend);
  const codeCounts={};for(const row of matrixRows)for(const e of row.events){const code=typeof e.code==='string'&&/^[A-Z/]{1,8}$/.test(e.code)?e.code:e.code===null?'blank':'unrecognized';codeCounts[code]=(codeCounts[code]??0)+1;}
  const reportFor=matrix=>{
    const rows=matrix?.rows??[],mean=key=>{const values=rows.map(r=>r[key]).filter(n=>typeof n==='number');return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;};
    const counts={flights:{},squadrons:{},asYears:{}};for(const row of rows)for(const [key,index]of[['asYears',2],['flights',3],['squadrons',4]]){const label=row.identityLabels[index];counts[key][label]=(counts[key][label]??0)+1;}
    return {cadets:rows.length,overallMean:mean('overall'),llabMean:mean('llab'),...counts};
  };
  const result={formatVersion:1,snapshotSha256:snapshot.snapshotSha256,policyVersion:'legacy-source-reconciliation-v1',matrixSnapshots:matrices,nativeProvenance:native,mirrorComparison,
    currentReports:{backend:reportFor(backend),frontend:reportFor(frontend)},historicalPeople,issues,historicalCodeEvidence:HISTORICAL_CODE_EVIDENCE,
    summary:{matrixSnapshots:matrices.length,matrixRows:matrixRows.length,matrixPeopleResolved:matrixRows.filter(r=>r.personId).length,matrixPeopleUnresolved:matrixRows.filter(r=>!r.personId).length,ambiguousEmailHistories:ambiguousEmails.size,
      currentMatrixColumnsWithCatalogIds:liveMatrices.reduce((n,m)=>n+m.columns.filter(c=>c.eventId).length,0),currentMatrixColumnsWithoutCatalogIds:liveMatrices.reduce((n,m)=>n+m.columns.filter(c=>!c.eventId).length,0),
      nativeProvenance:native.summary,mirrorComparison:mirrorComparison.summary,codeCounts,creditChecks:{verified:matrixRows.filter(r=>r.credit.overall.matches===true).length,different:matrixRows.filter(r=>r.credit.overall.matches===false).length,policyUnavailable:matrixRows.filter(r=>r.credit.overall.matches===null).length,rowsWithExcludedEventColumns:matrixRows.filter(r=>r.formulaCoverage.excludedEventColumns.length).length}},readyForD1Write:false};
  result.reconciliationSha256=importDigest(result);return result;
}
function compareMatrices(backend,frontend){
  const differences=[];let compared=0,matched=0;
  if(!backend||!frontend)return {differences,summary:{available:false,compared,matched,differences:0}};
  const people=new Map();for(const row of backend.rows)if(row.personId)group(people,row.personId,row);
  for(const front of frontend.rows){const candidates=people.get(front.personId)??[];if(candidates.length!==1){differences.push({code:'frontend-person-unresolved',occurrenceId:front.occurrenceId});continue;}
    const back=candidates[0],events=new Map();for(const e of back.events)if(e.eventId)group(events,e.eventId,e);
    for(const fe of front.events){const be=events.get(fe.eventId)??[];if(!fe.eventId||be.length!==1){differences.push({code:'frontend-event-unresolved',occurrenceId:front.occurrenceId,columnIndex:fe.columnIndex});continue;}compared++;if(JSON.stringify(fe.code)===JSON.stringify(be[0].code))matched++;else differences.push({code:'effective-code-mismatch',frontendOccurrenceId:front.occurrenceId,backendOccurrenceId:back.occurrenceId,eventId:fe.eventId,frontendCode:fe.code,backendCode:be[0].code});}
    for(const key of ['overall','llab'])if(front[key]!==back[key])differences.push({code:`${key}-summary-mismatch`,frontendOccurrenceId:front.occurrenceId,backendOccurrenceId:back.occurrenceId});
  }
  return {differences,summary:{available:true,backendPeople:backend.rows.length,frontendPeople:frontend.rows.length,compared,matched,differences:differences.length}};
}
function matchNativeProvenance(snapshot,plan){
  const responses=[];
  for(const form of snapshot.resources.filter(r=>r.kind==='form'))for(const response of form.responses){
    const answers=Object.values(response.answers??{}).flatMap(a=>(a.textAnswers?.answers??[]).map(v=>v.value)).filter(v=>typeof v==='string');
    const times=[response.createTime,response.lastSubmittedTime].filter(Boolean).map(t=>Date.parse(t));
    responses.push({formKey:form.key,formRole:form.role,responseId:response.responseId,email:norm(response.respondentEmail),times,answers,questionIds:Object.keys(response.answers??{})});
  }
  const index=new Map();for(const response of responses)for(const time of new Set(response.times))if(Number.isFinite(time)&&response.email)group(index,`${response.formRole}:${response.email}:${time}`,response);
  const links=[],unresolved=[];
  for(const row of plan.records.filter(r=>['attendance','excusal'].includes(r.kind))){
    const role=row.kind==='attendance'?'attendance':'excusal',time=Date.parse(row.submittedAt);
    const candidates=(index.get(`${role}:${norm(row.email)}:${time}`)??[]).filter(r=>r.answers.includes(row.event));
    const cadets=role==='attendance'?String(row.cadets??'').split(';').map(s=>s.trim()).filter(Boolean):[];
    const exact=candidates.filter(r=>cadets.every(c=>r.answers.includes(c))&&(role!=='excusal'||!row.reason||r.answers.includes(row.reason)));
    if(exact.length===1)links.push({occurrenceId:row.occurrenceId,formKey:exact[0].formKey,responseId:exact[0].responseId,questionIds:exact[0].questionIds,method:'exact-responder-time-event-and-selection-content',responseHistory:'current-native-response-state-only'});
    else unresolved.push({occurrenceId:row.occurrenceId,kind:row.kind,code:exact.length>1?'ambiguous-native-response':'native-response-not-proven',generatedWorkflow:/^(excusal-|excusal-decision-|bulk-fill-|fill-)/.test(row.submission_id??'')});
  }
  return {links,unresolved,summary:{linked:links.length,unresolved:unresolved.length,generatedWorkflow:unresolved.filter(r=>r.generatedWorkflow).length,ambiguous:unresolved.filter(r=>r.code==='ambiguous-native-response').length}};
}
