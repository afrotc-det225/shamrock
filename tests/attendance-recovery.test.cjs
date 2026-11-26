'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { planAttendanceRecovery: plan } = require('../scripts/lib/attendance-recovery.cjs');

const names = ['Able','Baker','Cedar'];
const first = 'Example';
const e1 = 'TW-01 LLAB', e2 = 'TW-01 Secondary';
const fixed = ['last_name','first_name','as_year','flight','squadron','overall_attendance_pct','llab_attendance_pct'];
const before = '2026-11-01T12:00:00.000Z', edit = '2026-11-02T12:00:00.000Z', after = '2026-11-03T12:00:00.000Z';
function log(row,event,value,people,at=before) {
  return {row,submission_id:`fixture-${row}`,submitted_at:at,event,attendance_type:value,cadets:people.map(n=>`${n}, ${first}`).join('; '),name:'Admin'};
}
function fixture() {
  return {
    formatVersion:1,
    snapshot:{trusted:true,provenance:'Reviewed restored fixture',capturedAt:after,headers:[...fixed,e1,e2],
      rows:names.map(n=>[n,first,'AS400','Alpha','Blue','','','P','P'])},
    directory:names.map(n=>({last_name:n,first_name:first})),
    events:[{event_id:'llab-1',display_name:e1},{event_id:'secondary-1',display_name:e2}],
    attendanceLog:[log(3,e1,'A',names),log(4,e2,'A',names),log(5,e1,'P',['Able'],edit)],
    audit:[{row:3,timestamp:edit,result:'ok',action:'edit',source:'onFrontendEdit',target_sheet:'Attendance',target_range:'Attendance!H3:I5',target_key:'able,example',field:e1,new_value:'P'}],
    evidence:[{auditRow:3,anchorSubmissionId:'fixture-5',provenance:{reviewed:true,kind:'historical-cell-map',reference:'Reviewed immutable fixture'},
      cells:names.flatMap((n,i)=>[e1,e2].map((event,j)=>({row:i+3,column:j+8,last_name:n,first_name:first,event,value:'P'})))}],
  };
}
const difference = (report,last,event=e1) => report.results.find(r=>r.person.last_name===last && r.event===event);

test('proposes only proven omitted cells across cadets and events, retaining source fingerprints',()=>{
  const f=fixture(), report=plan(f);
  assert.deepEqual(report.summary,{unchanged:1,proposed:5,preserved:0,review:0,excluded:0,evidenceIssues:0});
  assert.equal(report.productionWrites,0); assert.equal(report.requiresHumanReview,true);
  assert.equal(report.refreshGate.automaticRefreshPermitted,false);
  assert.equal(report.results.every(r=>r.proposal.attendance_type==='P'),true);
  assert.equal(report.attendanceHighWatermark.row,5);
  assert.match(report.sourceSha256.attendanceLog,/^[a-f0-9]{64}$/);
  assert.deepEqual(f,fixture(),'input must not be mutated');
});

test('current row sorting never changes historical identity association',()=>{
  const f=fixture(); f.snapshot.rows.reverse();
  const report=plan(f);
  assert.equal(report.summary.proposed,5);
  assert.equal(difference(report,'Baker').proposal.cadets,'Baker, Example');
  f.evidence=[];
  const unproven=plan(f);
  assert.equal(unproven.summary.proposed,0); assert.equal(unproven.summary.review,5);
  assert.equal(unproven.refreshGate.status,'blocked');
});

test('an audit top-left value is not proof of other pasted cells or identities',()=>{
  const f=fixture(); f.evidence[0].cells=f.evidence[0].cells.slice(0,1);
  const report=plan(f);
  assert.equal(report.summary.proposed,0); assert.equal(report.evidenceIssues[0].reason,'unproven_historical_mapping');
  assert.equal(report.refreshGate.status,'blocked');
});

test('later attendance or excusal records are preserved even with a backdated submission timestamp',()=>{
  for (const at of [before,after]) {
    const f=fixture(); const newer=log(6,e1,'E',['Baker'],at); newer.name='Excusal decision'; f.attendanceLog.push(newer);
    const report=plan(f), result=difference(report,'Baker');
    assert.equal(result.status,'preserved'); assert.equal(result.effective,'E');
    assert.equal(result.disposition,'keep_authoritative_record'); assert.equal(result.proposal,undefined);
  }
});

test('physical row order defines effective state; a later timestamp also protects an earlier-row decision',()=>{
  const f=fixture(); f.attendanceLog[0].submitted_at=after;
  const report=plan(f); assert.equal(difference(report,'Baker').status,'preserved');
  f.attendanceLog.push(log(6,e1,'U',['Baker'],before),log(7,e1,'E',['Baker'],before));
  assert.equal(difference(plan(f),'Baker').effective,'E');
  f.attendanceLog.reverse(); assert.throws(()=>plan(f),/INVALID_RECOVERY_INPUT/);
});

test('proven clear is proposed as blank while later authoritative clears are preserved',()=>{
  const f=fixture();
  f.snapshot.rows[1][7]=''; f.evidence[0].cells.find(c=>c.last_name==='Baker'&&c.event===e1).value='';
  let result=difference(plan(f),'Baker'); assert.equal(result.status,'proposed'); assert.equal(result.proposal.attendance_type,'');
  f.snapshot.rows[1][7]='P'; f.evidence[0].cells.find(c=>c.last_name==='Baker'&&c.event===e1).value='P';
  f.attendanceLog.push(log(6,e1,'',['Baker'],after));
  result=difference(plan(f),'Baker'); assert.equal(result.status,'preserved'); assert.equal(result.effective,'');
});

test('unproven blanks, differing restored values and untrusted snapshots never create proposals',()=>{
  const f=fixture(); f.snapshot.rows[1][7]='';
  assert.equal(difference(plan(f),'Baker').reason,'restoration_not_supported_by_evidence');
  f.snapshot.trusted=false; assert.throws(()=>plan(f),/INVALID_RECOVERY_INPUT/);
});

test('canceled, renamed and retired event labels are excluded instead of recreated',()=>{
  const f=fixture(); f.events=f.events.filter(e=>e.display_name!==e2);
  const report=plan(f); assert.equal(report.summary.excluded,3);
  assert.equal(report.results.filter(r=>r.event===e2).every(r=>r.status==='excluded'&&!r.proposal),true);
  f.events.push({event_id:'secondary-1',display_name:'Renamed event',attendance_column_label:e2});
  assert.equal(plan(f).summary.excluded,3,'stale aliases cannot be replayed as current headers');
});

test('same-name directory collisions and duplicate snapshot identities require review',()=>{
  const f=fixture(); f.directory.push({...f.directory[1]});
  assert.equal(difference(plan(f),'Baker').reason,'ambiguous_identity');
  f.directory.pop(); f.snapshot.rows.push([...f.snapshot.rows[1]]);
  assert.equal(difference(plan(f),'Baker').reason,'ambiguous_identity');
});

test('explicit canceled/inactive event status never produces a recovery correction',()=>{
  for(const status of ['canceled','Cancelled','inactive','archived','N/A']) {
    const f=fixture(); f.events[1].status=status;
    const report=plan(f);
    assert.equal(report.summary.excluded,3);
    assert.equal(report.results.filter(r=>r.event===e2).every(r=>r.status==='excluded'&&!r.proposal),true);
  }
});

test('fixed-header event collisions reject the input rather than hiding recoverable differences',()=>{
  for(const field of ['event_id','display_name','attendance_column_label']) {
    const f=fixture(); f.events[0][field]='last_name';
    assert.throws(()=>plan(f),/INVALID_RECOVERY_INPUT/);
  }
});

test('historic mapping rejects duplicate targets, mixed column events and inconsistent row identities',()=>{
  const duplicate=fixture(); duplicate.evidence[0].cells[2].last_name='Able';
  const column=fixture(); column.evidence[0].cells[2].event=e2;
  const row=fixture(); row.evidence[0].cells[3].last_name='Other';
  for(const f of [duplicate,column,row]) {
    const report=plan(f); assert.equal(report.summary.proposed,0);
    assert.equal(report.evidenceIssues[0].reason,'invalid_historical_cells');
    assert.equal(report.refreshGate.status,'blocked');
  }
});

test('a restored row for a nonoperational cadet requires roster review instead of a correction proposal',()=>{
  for(const status of ['Inactive','Commissioned','Dropped']) {
    const f=fixture(); f.directory[1].flight_path_status=status;
    const result=difference(plan(f),'Baker');
    assert.equal(result.status,'review');
    assert.equal(result.reason,'nonoperational_roster_identity');
    assert.equal(result.proposal,undefined);
  }
});

test('missing timestamps and equal-time authority remain ambiguous',()=>{
  for(const at of ['',edit]) {
    const f=fixture(); f.attendanceLog[0].submitted_at=at;
    assert.equal(difference(plan(f),'Baker').status,'review');
    assert.equal(plan(f).refreshGate.status,'blocked');
  }
});

test('later unmapped edit cannot be dismissed based on current sorted rows',()=>{
  const f=fixture(); f.audit.push({...f.audit[0],row:4,timestamp:after,target_range:'Attendance!H99:H100'});
  assert.equal(difference(plan(f),'Baker').reason,'later_unmapped_manual_edit');
  f.audit[1].timestamp='unavailable';
  assert.equal(difference(plan(f),'Baker').reason,'unusable_manual_audit');
  f.audit[1].timestamp=after; f.audit[1].field='Unresolved old label';
  assert.equal(difference(plan(f),'Baker').reason,'later_unmapped_manual_edit');
});

test('fresh source changes invalidate report hashes even when the effective value is unchanged',()=>{
  const f=fixture(), original=plan(f);
  f.attendanceLog.push(log(6,e1,'A',['Baker'],after));
  const current=plan(f);
  assert.notEqual(current.inputSha256,original.inputSha256);
  assert.notEqual(current.sourceSha256.attendanceLog,original.sourceSha256.attendanceLog);
  assert.equal(current.attendanceHighWatermark.row,6);
  assert.equal(difference(current,'Baker').status,'preserved');
});

test('invalid anchors, duplicate evidence and unknown codes fail closed',()=>{
  const f=fixture(); f.evidence[0].anchorSubmissionId='missing';
  assert.equal(plan(f).summary.proposed,0);
  f.evidence[0].anchorSubmissionId='fixture-5'; f.evidence.push(structuredClone(f.evidence[0]));
  assert.equal(plan(f).refreshGate.status,'blocked');
  f.evidence.pop(); f.snapshot.rows[1][7]='UNKNOWN';
  assert.equal(difference(plan(f),'Baker').reason,'unrecognized_code_or_log_identity');
});

test('planner replay agrees with actual Apps Script physical-row replay including explicit clears',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/services/attendance.ts'),'utf8').replace('  function buildMatrixRows(','  export function buildMatrixRows(');
  const context=vm.createContext({Schemas:{getTabSchema:()=>undefined},Set,Map,Date});
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.None}}).outputText,context);
  const f=fixture(); f.attendanceLog.push(log(6,e1,'',['Baker'],before),log(7,e2,'U',['Cedar'],before));
  const replay=context.AttendanceService.buildMatrixRows(f.directory,f.events.map(e=>({name:e.display_name})),f.attendanceLog);
  for(const r of plan(f).results) assert.equal(r.effective,replay.find(p=>p.last_name===r.person.last_name)[r.event]);
});

test('CLI writes only a new private ignored report and prints aggregate counts',()=>{
  const root=path.join(__dirname,'..'), base=path.join(root,'.build'); fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'attendance-recovery-test-')); fs.chmodSync(dir,0o700);
  const input=path.join(dir,'input.json'), output=path.join(dir,'report.json');
  try {
    fs.writeFileSync(input,JSON.stringify(fixture()),{mode:0o600});
    const run=()=>spawnSync(process.execPath,['scripts/rehearse-attendance-recovery.cjs','--input',input,'--output',output],{cwd:root,encoding:'utf8'});
    const child=run(); assert.equal(child.status,0,child.stderr); assert.equal(JSON.parse(child.stdout).productionWrites,0);
    assert.doesNotMatch(child.stdout,/Able|Baker|Example|LLAB/);
    assert.equal(fs.statSync(output).mode&0o077,0);
    assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).summary.proposed,5);
    assert.equal(run().status,1,'existing reports cannot be overwritten');
    fs.unlinkSync(output); fs.chmodSync(input,0o644); assert.equal(run().status,1,'shared input is rejected');
    assert.equal(fs.existsSync(output),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
