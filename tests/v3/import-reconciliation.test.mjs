import test from 'node:test';
import assert from 'node:assert/strict';
import {importDigest} from '../../scripts/lib/import-capture.mjs';
import {IMPORT_SCHEMAS,buildImportPlan} from '../../scripts/lib/import-parity.mjs';
import {reconcileImportEvidence,compareLegacyCredit,HISTORICAL_CODE_EVIDENCE} from '../../scripts/lib/import-reconciliation.mjs';
const cell=value=>value===null?{}:{userEnteredValue:{[typeof value==='number'?'numberValue':'stringValue']:value},effectiveValue:{[typeof value==='number'?'numberValue':'stringValue']:value}};
const formula=(credit,total)=>`=ARRAYFORMULA(BYROW(H3:I,LAMBDA(r,LET(cred,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{${credit.map(x=>`"${x}"`).join(',')}}))>0,1,0))),tot,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{${total.map(x=>`"${x}"`).join(',')}}))>0,1,0))),num,SUM(cred),den,SUM(tot),IF(den=0,1,num/den)))))`;
const currentFormula=formula(['P','T','E','ES','MED'],['P','T','A','U','E','ES','MED']);
function sheet(title,id,headers,records){return {metadata:{properties:{sheetId:id,title,gridProperties:{rowCount:records.length+2,columnCount:headers.length}}},rows:[headers.map(cell),headers.map(cell),...records.map(r=>headers.map(h=>r[h]?.effectiveValue?r[h]:cell(r[h]??'')))]};}
const person={last_name:'Example',first_name:'Fictional One',as_year:'AS100',flight:'Alpha',squadron:'Blue',email:'one@example.invalid',dob:'2006-01-01',flight_path_status:'Active 3/4'};
const matrixRow={...person,overall_attendance_pct:{userEnteredValue:{formulaValue:currentFormula},effectiveValue:{numberValue:1}},llab_attendance_pct:{userEnteredValue:{formulaValue:currentFormula},effectiveValue:{numberValue:1}},'TW-01 LLAB':'P'};
const event={event_id:'event-one',term:'Fall 2026',event_type:'LLAB',status:'Active',display_name:'TW-01 LLAB',attendance_column_label:'TW-01 LLAB'};
function book(role,sheets){return {key:role,role,providerId:`fictional-${role}`,kind:'workbook',coherent:true,metadata:{spreadsheetId:`fictional-${role}`,properties:{title:role==='archive-external'?'Fictional archive Spring 2026':'Fictional book',timeZone:'America/New_York'}},sheets};}
function snapshot(extra=[]){
  const body={formatVersion:1,consistent:true,writerFence:false,resources:[book('backend',[
    sheet('Directory Backend',1,IMPORT_SCHEMAS.directory,[person]),sheet('Events Backend',2,IMPORT_SCHEMAS.event,[event]),
    sheet('Attendance Matrix Backend',3,[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],[matrixRow]),
    sheet('Attendance Backend',4,IMPORT_SCHEMAS.attendance,[{submission_id:'att-source',submitted_at:'2026-09-01T12:00:00Z',event:'TW-01 LLAB',attendance_type:'P',email:'reporter@example.invalid',cadets:'Example, Fictional One'}]),
  ]),book('main',[sheet('Directory',1,IMPORT_SCHEMAS.directory,[person]),sheet('Attendance',2,[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],[matrixRow])]),
  {key:'form',role:'attendance',kind:'form',providerId:'fictional-form',coherent:true,metadata:{formId:'fictional-form'},responses:[{responseId:'native-one',respondentEmail:'reporter@example.invalid',createTime:'2026-09-01T12:00:00Z',lastSubmittedTime:'2026-09-01T12:00:00Z',answers:{q1:{textAnswers:{answers:[{value:'TW-01 LLAB'}]}},q2:{textAnswers:{answers:[{value:'Example, Fictional One'}]}}}}]},...extra]};return {...body,snapshotSha256:importDigest(body)};
}
test('same-workbook full identity tuple plus Directory email establishes current effective matrix parity without invented observations',()=>{
  const s=snapshot(),result=reconcileImportEvidence(s,buildImportPlan(s));
  assert.equal(result.summary.matrixPeopleResolved,2);assert.equal(result.summary.mirrorComparison.compared,1);assert.equal(result.summary.mirrorComparison.matched,1);
  assert.equal(result.summary.mirrorComparison.differences,0);
  const row=result.matrixSnapshots[0].rows[0];assert.equal(row.importAs,'legacy-effective-cell-snapshot');assert.equal(row.observations,undefined);assert.equal(row.eligiblePersonIds,null);
  assert.equal(result.matrixSnapshots[0].sourceRoster[0].eventEligibility,'not-reconstructable-from-term-roster');
});
test('different flight/cohort cannot be joined by a matching name',()=>{
  const s=snapshot();s.resources[1].sheets[1].rows[2][3]=cell('Bravo');const {snapshotSha256,...body}=s;s.snapshotSha256=importDigest(body);
  const result=reconcileImportEvidence(s,buildImportPlan(s));assert.equal(result.summary.matrixPeopleUnresolved,1);assert.equal(result.summary.mirrorComparison.matched,0);
});
test('native response linkage requires exact responder, timestamp, event and selected content, and never assumes a frozen roster',()=>{
  const s=snapshot(),result=reconcileImportEvidence(s,buildImportPlan(s));assert.equal(result.nativeProvenance.links.length,1);
  assert.equal(result.nativeProvenance.links[0].responseId,'native-one');assert.deepEqual(result.nativeProvenance.links[0].questionIds,['q1','q2']);
  assert.equal(result.nativeProvenance.links[0].historicalHumanIdentityVerified,false);
  const changed=snapshot();changed.resources[2].responses[0].answers.q2.textAnswers.answers[0].value='Another fictional selection';const {snapshotSha256,...body}=changed;changed.snapshotSha256=importDigest(body);
  assert.equal(reconcileImportEvidence(changed,buildImportPlan(changed)).nativeProvenance.links.length,0);
});
test('historical snapshot retains its own roster and event-column identity, not current event eligibility',()=>{
  const historical={...person,as_year:'AS200',flight:'Bravo',squadron:'Gold',email:'alumnus@example.invalid'};
  const extra=book('archive-external',[sheet('Directory',1,IMPORT_SCHEMAS.directory,[historical]),sheet('Attendance',2,[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],[{...matrixRow,...historical}])]);
  const s=snapshot([extra]),r=reconcileImportEvidence(s,buildImportPlan(s)),archive=r.matrixSnapshots.find(m=>!m.isCurrent);
  assert.equal(archive.periodLabel,'Spring 2026');assert.equal(archive.rows[0].events[0].eventId,null);assert.match(archive.rows[0].events[0].snapshotEventId,/snapshot-event:/);
  assert.notEqual(archive.rows[0].personId,r.matrixSnapshots[0].rows[0].personId);assert.equal(archive.sourceRoster[0].profile.flight,'Bravo');
});
test('an archived name change on an email remains reviewable without invalidating exact current identity',()=>{
  const old={...person,first_name:'Previous Fictional Name'};
  const extra=book('archive-external',[sheet('Directory',1,IMPORT_SCHEMAS.directory,[old]),sheet('Attendance',2,[...IMPORT_SCHEMAS.matrix,'TW-01 LLAB'],[{...matrixRow,...old}])]);
  const s=snapshot([extra]),r=reconcileImportEvidence(s,buildImportPlan(s));assert.equal(r.summary.ambiguousEmailHistories,1);assert.equal(r.summary.matrixPeopleResolved,2);assert.equal(r.summary.matrixPeopleUnresolved,1);assert.equal(r.summary.mirrorComparison.differences,0);
});
test('both historical UR denominator policies and pending MU prefix credit are preserved exactly',()=>{
  const credit=['P*','E','ES*','MU*','MRS*'],withUr=['P*','E','ES*','T*','U','UR','MU*','MRS*'],withoutUr=withUr.filter(p=>p!=='UR');
  const counted=compareLegacyCredit(['MUR','UR','ED','ER','MRS'],formula(credit,withUr),2/3);assert.equal(counted.matches,true);assert.equal(counted.policy,'legacy-pre-v2-ur-counted');
  const neutral=compareLegacyCredit(['MUR','UR','ED','ER','MRS'],formula(credit,withoutUr),1);assert.equal(neutral.matches,true);assert.equal(neutral.policy,'legacy-pre-v2-ur-neutral');
  assert.equal(compareLegacyCredit(['R','D','N/A'],currentFormula,1).matches,true);
  assert.equal(compareLegacyCredit(['P'],'=1+1',1).policy,'unavailable');assert.equal(HISTORICAL_CODE_EVIDENCE.automaticCurrentCodeRemap,false);
});
test('array formula evidence applies to spill cells while a manually entered percentage is not reinterpreted',()=>{
  const s=snapshot();for(const b of s.resources.filter(r=>r.kind==='workbook')){
    const dir=b.sheets.find(sh=>sh.metadata.properties.title.startsWith('Directory'));
    dir.rows.push(IMPORT_SCHEMAS.directory.map(h=>cell(({...person,email:'two@example.invalid',first_name:'Fictional Two'})[h]??'')));dir.metadata.properties.gridProperties.rowCount++;
    const matrix=b.sheets.find(sh=>sh.rows[0].some(c=>c.effectiveValue?.stringValue==='overall_attendance_pct'));const added=matrix.rows[2].map(c=>structuredClone(c));added[1]=cell('Fictional Two');added[5]={effectiveValue:{numberValue:1}};added[6]={effectiveValue:{numberValue:1}};matrix.rows.push(added);matrix.metadata.properties.gridProperties.rowCount++;
  }
  const {snapshotSha256,...body}=s;s.snapshotSha256=importDigest(body);const r=reconcileImportEvidence(s,buildImportPlan(s));assert.equal(r.summary.creditChecks.verified,4);
  const changed=structuredClone(s);changed.resources[0].sheets[2].rows[3][5]=cell(0.5);const {snapshotSha256:old,...rest}=changed;changed.snapshotSha256=importDigest(rest);
  assert.equal(reconcileImportEvidence(changed,buildImportPlan(changed)).summary.creditChecks.policyUnavailable,1);
});
test('saved formula range exclusions remain explicit while every excluded effective event value is preserved',()=>{
  const s=snapshot(),matrix=s.resources[0].sheets[2];
  matrix.rows[0].push(cell('Second event'),cell('Excluded event'));matrix.rows[1].push(cell('Second event'),cell('Excluded event'));matrix.rows[2].push(cell(''),cell('A'));matrix.metadata.properties.gridProperties.columnCount+=2;
  const {snapshotSha256,...body}=s;s.snapshotSha256=importDigest(body);
  const result=reconcileImportEvidence(s,buildImportPlan(s)),entry=result.matrixSnapshots[0].rows[0];
  assert.equal(entry.credit.overall.matches,true);assert.deepEqual(entry.formulaCoverage.excludedEventColumns,[9]);assert.equal(entry.events[2].code,'A');
});
