import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {importDigest} from '../../scripts/lib/import-capture.mjs';
import {IMPORT_SCHEMAS,buildImportPlan,verifyImportAccounting,compareImportReadback,compareAttendanceSnapshots,extractLegacyPhoto,normalizeLegacyDate,proposeImportCrosswalk} from '../../scripts/lib/import-parity.mjs';

const cell=value=>value===null?{}:{userEnteredValue:{[typeof value==='number'?'numberValue':'stringValue']:value},effectiveValue:{[typeof value==='number'?'numberValue':'stringValue']:value}};
const row=values=>values.map(cell);
function sheet(title,kind,records,id=1) {const headers=IMPORT_SCHEMAS[kind];return {metadata:{properties:{sheetId:id,title,gridProperties:{rowCount:records.length+4,columnCount:headers.length}}},rows:[row(headers),row(headers.map(h=>h.replaceAll('_',' '))),...records.map(r=>headers.map(h=>r[h]?.effectiveValue?r[h]:cell(r[h]??''))),[],[]]};}
const directory={last_name:'Example',first_name:'Cadet One',as_year:'AS100',flight:'Alpha',squadron:'Blue',rank:'C/4C',role:'Cadet',university:'Example College',email:'one@example.invalid',phone:'',dorm:'',cip_broad_area:'14 - Engineering',cip_code:'14.0901',desired_assigned_afsc:'',home_town:'',home_state:'',class_year:'2029',dob:'2005-01-02',flight_path_status:'Active 3/4',photo_link:''};
const event={event_id:'legacy-event-1',term:'Fall fictional',training_week:'1',event_type:'LLAB',display_name:'Fictional LLAB',attendance_column_label:'TW-01 LLAB',expected_group:'All Cadets',flight_scope:'All',status:'Active',start_datetime:'2026-09-01T12:00:00Z',end_datetime:'2026-09-01T13:00:00Z',location:'',notes:'',created_at:'2026-08-01T00:00:00Z',created_by:''};
const excusal={request_id:'legacy-request-1',event:'TW-01 LLAB',email:'one@example.invalid',last_name:'Example',first_name:'Cadet One',flight:'Alpha',squadron:'Blue',status:'Approved',decision:'Approved',decided_by:'',decided_at:'2026-09-01T10:00:00Z',requested_outcome:'E',attendance_effect:'E',prior_attendance_code:'P',submitted_at:'2026-08-31T10:00:00Z',last_updated_at:'2026-09-01T10:00:00Z',reason:'Fictional reason'};
function capture(sheets=[sheet('Directory Backend','directory',[directory]),sheet('Events Backend','event',[event],2),sheet('Excusals Backend','excusal',[excusal],3)]) {
  const body={formatVersion:1,consistent:true,writerFence:false,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:01:00Z',passes:1,resources:[{key:'backend',role:'backend',providerId:'fictional-book',kind:'workbook',coherent:true,versionBefore:'1',versionAfter:'1',metadata:{spreadsheetId:'fictional-book',properties:{title:'Fictional backend',timeZone:'America/New_York'}},sheets},{key:'form',role:'attendance',providerId:'fictional-form',kind:'form',coherent:true,metadata:{formId:'fictional-form'},responses:[{responseId:'native-response-1',lastSubmittedTime:'2026-01-01T00:00:00Z',answers:{}}]}]};
  return {...body,snapshotSha256:importDigest(body)};
}
function reviewed(plan,selector,targets){return {formatVersion:1,snapshotSha256:plan.snapshotSha256,bindings:plan.ledger.filter(selector).map(l=>({occurrenceId:l.occurrenceId,fingerprint:l.fingerprint,reviewReference:'fictional-reviewed-fixture',targets}))};}

test('every metadata object, nonempty source row and native response is accounted, including blank physical rows',()=>{
  const snapshot=capture(),plan=buildImportPlan(snapshot),accounting=verifyImportAccounting(snapshot,plan);
  assert.equal(accounting.complete,true);assert.equal(accounting.totalOccurrences,accounting.dispositionTotal);
  assert.equal(plan.summary.emptyRows,6);assert.equal(plan.summary.kinds['native-form-response'],1);
  assert.equal(plan.ledger.filter(l=>l.kind==='directory').length,1);
  assert.equal(plan.ledger.find(l=>l.kind==='directory').disposition,'quarantined');
  assert.equal(plan.records.find(r=>r.kind==='directory').personId,undefined);
  assert.equal(plan.readyForD1Write,false);assert.equal(plan.planSha256,buildImportPlan(snapshot).planSha256);
});
test('reviewed exact occurrence and fingerprint resolve a candidate without making its source email the stable ID',()=>{
  const snapshot=capture(),initial=buildImportPlan(snapshot),crosswalk=reviewed(initial,l=>l.kind==='directory',{personId:'person-one',flightId:'flight-alpha',squadronId:'squadron-blue'});
  const plan=buildImportPlan(snapshot,crosswalk),l=plan.ledger.find(l=>l.kind==='directory');
  assert.equal(l.disposition,'normalized');assert.equal(plan.records[l.normalizedIndex].personId,'person-one');
  assert.equal(plan.records[l.normalizedIndex].profile.email,'one@example.invalid');
  assert.equal(verifyImportAccounting(snapshot,plan).complete,true);
  const withSuggestions={...crosswalk,reviewRequired:false,bindings:crosswalk.bindings.map(b=>({...b,evidence:['reviewed-suggestion']}))};
  assert.equal(verifyImportAccounting(snapshot,buildImportPlan(snapshot,withSuggestions)).complete,true);
  const stale=structuredClone(crosswalk);stale.bindings[0].fingerprint='0'.repeat(64);assert.throws(()=>buildImportPlan(snapshot,stale),/IMPORT_CROSSWALK_STALE/);
  const unreviewed=structuredClone(crosswalk);unreviewed.bindings[0].reviewReference='';assert.throws(()=>buildImportPlan(snapshot,unreviewed),/IMPORT_CROSSWALK_REVIEW/);
});
test('crosswalk binding order does not change the deterministic reviewed plan',()=>{
  const snapshot=capture(),initial=buildImportPlan(snapshot);
  const crosswalk=reviewed(initial,l=>['directory','event'].includes(l.kind),{personId:'person-one',eventId:'event-one',termId:'term-one',flightId:'alpha',squadronId:'blue'});
  const first=buildImportPlan(snapshot,crosswalk);crosswalk.bindings.reverse();const reversed=buildImportPlan(snapshot,crosswalk);
  assert.equal(first.planSha256,reversed.planSha256);assert.equal(verifyImportAccounting(snapshot,reversed).complete,true);
});
test('same names do not establish identity; suggestions use unique exact email and remain unreviewed',()=>{
  const snapshot=capture([sheet('Directory Backend','directory',[directory,{...directory,email:'two@example.invalid'}]),sheet('Leadership Backend','leadership',[{last_name:'Example',first_name:'Cadet One',email:''}],2)]);
  const plan=buildImportPlan(snapshot),proposal=proposeImportCrosswalk(plan);
  const people=proposal.bindings.filter(b=>b.evidence.includes('unique-current-directory-email-anchor'));
  assert.equal(people.length,2);assert.notEqual(people[0].targets.personId,people[1].targets.personId);
  const leadership=proposal.bindings.find(b=>b.evidence.includes('source-occurrence-contact-anchor'));
  assert.equal(leadership.targets.personId,undefined);assert.ok(leadership.unresolved.includes('personId'));
  assert.throws(()=>buildImportPlan(snapshot,proposal),/IMPORT_CROSSWALK_REVIEW/);
});
test('duplicate natural IDs and duplicate email anchors are retained as separate quarantined occurrences',()=>{
  const plan=buildImportPlan(capture([sheet('Directory Backend','directory',[directory,{...directory,first_name:'Another Cadet'}]),sheet('Events Backend','event',[event,{...event,notes:'changed'}],2)]));
  assert.equal(plan.collisions.length,2);assert.equal(plan.ledger.filter(l=>l.issues.includes('duplicate-natural-id')).length,2);
  assert.equal(plan.ledger.filter(l=>l.issues.includes('duplicate-directory-email')).length,2);
  assert.equal(proposeImportCrosswalk(plan).bindings.filter(b=>b.targets.personId).length,0);
});
test('duplicate machine headers, unknown historical codes and unheaded values are never collapsed into objects',()=>{
  const matrix=sheet('Attendance','matrix',[],4);matrix.rows=[row([...IMPORT_SCHEMAS.matrix,'TW-01','TW-01']),row([...IMPORT_SCHEMAS.matrix,'Week 1','Week 1']),row(['Example','Cadet One','AS100','Alpha','Blue',1,1,'MRS','P','unheaded']),[],[]];matrix.metadata.properties.gridProperties={rowCount:5,columnCount:10};
  const snapshot=capture([matrix]),plan=buildImportPlan(snapshot),l=plan.ledger.find(l=>l.kind==='matrix');
  assert.equal(l.disposition,'quarantined');assert.ok(l.issues.includes('duplicate-machine-header'));assert.ok(l.issues.includes('populated-unheaded-column'));assert.ok(l.issues.includes('unsupported-matrix-code'));
  assert.equal(plan.records[l.normalizedIndex].events[0].displayCode,'MRS');assert.equal(verifyImportAccounting(snapshot,plan).complete,true);
});
test('file chip URI wins over its visible filename, and conflicting or unsupported links require review',()=>{
  const chip={...cell('Fictional photo'),chipRuns:[{chip:{richLinkProperties:{uri:'https://drive.google.com/file/d/fictional-photo/view'}}}]};
  assert.deepEqual(extractLegacyPhoto(chip),{value:'https://drive.google.com/file/d/fictional-photo/view',issue:null});
  assert.equal(extractLegacyPhoto(cell('Photo filename')).issue,'photo-uri-unresolved');
  assert.equal(extractLegacyPhoto({...chip,hyperlink:'https://example.invalid/other'}).issue,'photo-uri-conflict');
  assert.equal(extractLegacyPhoto({userEnteredValue:{formulaValue:'=HYPERLINK("https://example.invalid/p";"Photo")'}}).value,'https://example.invalid/p');
  assert.equal(extractLegacyPhoto({hyperlink:'http://example.invalid/photo'}).issue,'photo-uri-invalid');
});
test('dates use date-only identity and explicit spreadsheet timezone, with DST ambiguity rejected',()=>{
  assert.equal(normalizeLegacyDate(cell('2026-02-30'),{dateOnly:true}).issue,'date-text-not-iso');
  assert.equal(normalizeLegacyDate(cell('11/06/2026'),{dateOnly:true}).value,null);
  const serial=Date.parse('2026-07-01T12:00:00Z')/86400000+25569;
  assert.equal(normalizeLegacyDate(cell(serial),{timeZone:'America/New_York'}).value,'2026-07-01T16:00:00.000Z');
  assert.equal(normalizeLegacyDate(cell(serial)).issue,'timestamp-timezone-missing');
  const fall=Date.parse('2026-11-01T01:30:00Z')/86400000+25569;
  assert.equal(normalizeLegacyDate(cell(fall),{timeZone:'America/New_York'}).issue,'timestamp-dst-ambiguous');
  const spring=Date.parse('2026-03-08T02:30:00Z')/86400000+25569;
  assert.equal(normalizeLegacyDate(cell(spring),{timeZone:'America/New_York'}).issue,'timestamp-dst-nonexistent');
  assert.equal(normalizeLegacyDate(cell(25569),{dateOnly:true}).value,'1970-01-01');
});
test('numeric CIP/phone display spelling and explicit empty values survive normalization with diagnostic',()=>{
  const phone={...cell(1234),formattedValue:'001234'};
  const snapshot=capture([sheet('Directory Backend','directory',[{...directory,phone}])]);
  const plan=buildImportPlan(snapshot),l=plan.ledger.find(l=>l.kind==='directory'),record=plan.records[l.normalizedIndex];
  assert.equal(record.profile.phone,'001234');assert.equal(record.profile.photoLink,'');assert.ok(l.warnings.includes('numeric-text:phone'));
});
test('current excusal state does not invent observed absence or lost decision history',()=>{
  const plan=buildImportPlan(capture()),request=plan.records.find(r=>r.kind==='excusal');
  assert.equal(request.prior_attendance_code,'P');assert.equal(request.attendance_effect,'E');assert.equal(request.historyCompleteness,'current-state-only');assert.equal(request.observedCode,undefined);
});
test('tampered snapshot, lost ledger row, unknown binding and null person cannot pass as complete',()=>{
  const snapshot=capture(),plan=buildImportPlan(snapshot);const changed=structuredClone(snapshot);changed.resources[0].sheets[0].rows[2][0]=cell('Changed');
  assert.throws(()=>buildImportPlan(changed),/IMPORT_SNAPSHOT_HASH/);
  const lost=structuredClone(plan);lost.ledger.pop();assert.throws(()=>verifyImportAccounting(snapshot,lost),/IMPORT_ACCOUNTING_MISMATCH/);
  const crosswalk=reviewed(plan,l=>l.kind==='directory',{personId:null,flightId:'alpha',squadronId:'blue'});
  assert.ok(buildImportPlan(snapshot,crosswalk).ledger.find(l=>l.kind==='directory').issues.includes('invalid-target:personId'));
});
test('readback compares exact occurrence sets, dispositions and fingerprints, never only row counts',()=>{
  const plan=buildImportPlan(capture()),readback={formatVersion:1,snapshotSha256:plan.snapshotSha256,occurrences:plan.ledger.map(({occurrenceId,fingerprint,disposition})=>({occurrenceId,fingerprint,disposition}))};
  assert.equal(compareImportReadback(plan,readback).complete,true);
  const missing=structuredClone(readback);missing.occurrences.pop();assert.equal(compareImportReadback(plan,missing).complete,false);
  const changed=structuredClone(readback);changed.occurrences[0].fingerprint='0'.repeat(64);assert.equal(compareImportReadback(plan,changed).differences[0].code,'changed-occurrence');
  const duplicate=structuredClone(readback);duplicate.occurrences.push(duplicate.occurrences[0]);assert.ok(compareImportReadback(plan,duplicate).differences.some(d=>d.code==='duplicate-readback-occurrence'));
});
test('matrix parity requires explicit person/term/event bindings; blank is distinct from absent data',()=>{
  const matrix=sheet('Attendance','matrix',[],4);matrix.rows=[row([...IMPORT_SCHEMAS.matrix,'TW-01','TW-02']),row([...IMPORT_SCHEMAS.matrix,'Week 1','Week 2']),row(['Example','Cadet One','AS100','Alpha','Blue',1,1,'P','']),[],[]];matrix.metadata.properties.gridProperties={rowCount:5,columnCount:9};
  const snapshot=capture([matrix]),initial=buildImportPlan(snapshot),target={formatVersion:1,policyVersion:'legacy-shamrock-credit-v1',rows:[{personId:'person-one',termId:'term-one',overall:1,llab:1,events:[{eventId:'event-one',code:'P'},{eventId:'event-two',code:null}]}]};
  assert.equal(compareAttendanceSnapshots(initial,target).blockedMatrixRows,1);
  const crosswalk=reviewed(initial,l=>l.kind==='matrix',{personId:'person-one',termId:'term-one',eventIds:['event-one','event-two']}),plan=buildImportPlan(snapshot,crosswalk);
  assert.equal(compareAttendanceSnapshots(plan,target).parityEstablished,true);
  const changed=structuredClone(target);changed.rows[0].events.pop();assert.equal(compareAttendanceSnapshots(plan,changed).parityEstablished,false);
});
test('CLI writes private evidence outside source control and prints no personal record values',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shamrock-import-test-'));await fs.chmod(dir,0o700);
  try {
    const file=path.join(dir,'input.json');await fs.writeFile(file,JSON.stringify(capture()),{mode:0o600});
    const output=path.join(dir,'out');const stdout=execFileSync(process.execPath,['scripts/import-parity.mjs','plan','--snapshot',file,'--private-dir',output],{encoding:'utf8'});
    assert.ok(!stdout.includes('one@example.invalid'));assert.ok(!stdout.includes('Cadet One'));
    assert.equal((await fs.stat(path.join(output,'import-plan.json'))).mode&0o077,0);
    const repeat=spawnSync(process.execPath,['scripts/import-parity.mjs','plan','--snapshot',file,'--private-dir',output],{encoding:'utf8'});assert.notEqual(repeat.status,0);assert.ok(!repeat.stderr.includes('one@example.invalid'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
