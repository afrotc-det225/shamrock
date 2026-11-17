import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';
import {summarizeNativeTerm,summarizeRetainedTerm,buildCoherentFrontendReporting} from '../../.build/v3/apps/google-adapter/src/frontend-history-summary.js';
import {createPagedFrontendTransport} from '../../.build/v3/apps/google-adapter/src/frontend-page-client.js';
import {buildFrontendReporting} from '../../.build/v3/packages/domain/src/frontend-reporting.js';
import {snapshotToFrontendReportingInput} from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import {FRONTEND_SECTIONS,FRONTEND_PAGE_VERSION} from '../../.build/v3/packages/domain/src/frontend-transport.js';
import {buildRetainedHistorySummary,retainedHistoryCanonical,RETAINED_HISTORY_SUMMARY_VERSION} from '../../.build/v3/packages/domain/src/retained-history-summary.js';
const revision={operations:5,administration:7};
const person={personId:'cadet',version:1,lastName:'Example',firstName:'Cadet',asYear:'AS300',rank:'',role:'',university:'',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'',cipCode:'',afsc:'',homeTown:'',homeState:'',classYear:'',dateOfBirth:'2000-01-01',photoLink:'',flightId:'alpha',flightPathStatus:'Active 3/4',active:true};
const roster={personId:'cadet',lastName:'Example',firstName:'Cadet',asYear:'AS100',flightId:'alpha',flightPathStatus:'Active 3/4',dateOfBirth:'2000-01-01'};
const terms=[{termId:'oldest',label:'Oldest',sortOrder:1,isCurrent:false,roster:[roster]},{termId:'prior',label:'Prior',sortOrder:2,isCurrent:false,roster:[{...roster,asYear:'AS200'}]},{termId:'current',label:'Current',sortOrder:3,isCurrent:true}];
const events=terms.map((t,i)=>({eventId:'event-'+t.termId,termId:t.termId,version:1,eventType:'llab',trainingWeek:1,displayOrder:i,label:'LLAB',columnLabel:'LLAB',eligiblePersonIds:['cadet'],status:'active',startAt:'2026-01-01T00:00:00.000Z',endAt:'2026-01-01T01:00:00.000Z',expectedGroup:'All Cadets',location:'',notes:''}));
function full(){return {contractVersion:1,environment:'staging',generation:2,revision,people:[person],leadership:[],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue',rosterVersion:1}],squadrons:[{squadronId:'blue',label:'Blue'}],terms:structuredClone(terms),events:structuredClone(events),eventFlights:events.map(e=>({eventId:e.eventId,flightId:'alpha'})),observations:[],requests:[],corrections:events.map((e,i)=>({factId:'correction-'+i,personId:'cadet',eventId:e.eventId,order:i+1,code:i===0?'A':'P'})),legacyBaselines:[],attendanceVersions:[],diagnostics:[]};}
function scoped(termId){const s=full();s.terms=s.terms.filter(t=>t.isCurrent||t.termId===termId);s.events=s.events.filter(e=>e.termId===termId);s.eventFlights=s.eventFlights.filter(f=>s.events.some(e=>e.eventId===f.eventId));s.corrections=s.corrections.filter(f=>s.events.some(e=>e.eventId===f.eventId));return s;}
const date='2026-01-03';
test('separately read native term summaries reproduce full historical Dashboard percentages using frozen years',()=>{
 const current=scoped('current');current.dashboardHistory={revision,currentTermId:'current',terms:['prior','oldest'].map(t=>summarizeNativeTerm(scoped(t),t))};
 const expected=buildFrontendReporting(snapshotToFrontendReportingInput(full(),date)),actual=buildCoherentFrontendReporting(current,date);
 assert.deepEqual(actual.dashboard,expected.dashboard);assert.equal(actual.matrices.length,1);assert.equal(actual.matrices[0].termId,'current');assert.deepEqual(actual.diagnostics,expected.diagnostics);
 assert.equal(actual.dashboard.attendanceByYear.find(y=>y.asYear==='AS100').terms.find(t=>t.termId==='oldest').percentage,0);
 assert.equal(actual.dashboard.attendanceByYear.find(y=>y.asYear==='AS200').terms.find(t=>t.termId==='prior').percentage,1);
});
test('missing frozen roster remains unavailable instead of substituting current membership; corrupt summaries fail closed',()=>{
 const old=scoped('prior');delete old.terms.find(t=>t.termId==='prior').roster;const summary=summarizeNativeTerm(old,'prior');assert.equal(summary.rosterSource,'unavailable');assert.equal(summary.percentage,null);
 const current=scoped('current');current.dashboardHistory={revision,currentTermId:'current',terms:[summary]};const result=buildCoherentFrontendReporting(current,date);assert(result.needsReview);assert.equal(result.dashboard.termTrend[0].percentage,null);
 for(const change of [s=>s.dashboardHistory.revision={...revision,operations:6},s=>s.dashboardHistory.currentTermId='other',s=>s.dashboardHistory.terms.push(s.dashboardHistory.terms[0]),s=>s.dashboardHistory.terms[0].attendanceByYear[0].percentage=1.1]){const bad=structuredClone(current);change(bad);assert.throws(()=>buildCoherentFrontendReporting(bad,date),/INVALID_DASHBOARD_HISTORY/);}
});
const config={environment:'staging',generation:2,baseUrl:'https://worker.example.invalid',keyId:'test'};
const sha=x=>createHash('sha256').update(x).digest('hex'),signer={sha256:sha,hmacSha256:x=>createHmac('sha256','fixture').update(x).digest('hex')};
function transfer(kind='frontend.refresh',mutate=x=>x,options={}){
 const calls=[];const effect={effectId:'effect',kind};
 const transport={send(request){const b=JSON.parse(request.body),path=new URL(request.url).pathname;calls.push({b,path});
  if(path==='/v1/admin/history/summary'){assert.equal(request.headers['x-shamrock-signature'],signer.hmacSha256(`POST\n${path}\n${request.headers['x-shamrock-timestamp']}\n${sha(request.body)}`));const result={contractVersion:RETAINED_HISTORY_SUMMARY_VERSION,environment:'staging',generation:2,summaries:b.selections.map(s=>structuredClone(options.retainedSummaries.find(r=>r.snapshotId===s.snapshotId)))};return{status:200,body:JSON.stringify(mutate(result,b,calls))};}
  const historical=path==='/v1/admin/snapshot/page',termId=b.termId??'current',s=scoped(termId);
  assert.equal(request.headers['x-shamrock-signature'],signer.hmacSha256(`POST\n${path}\n${request.headers['x-shamrock-timestamp']}\n${sha(request.body)}`));
  if(historical)assert.equal(b.claimToken,undefined);else assert.equal(b.claimToken,'claim');
  const data={people:s.people.map(p=>({...p,virtualContactId:'cadet:'+sha(p.personId)})),contacts:[],flights:s.flights,squadrons:s.squadrons,terms:s.terms.map(({roster,...t})=>({...t,isCurrent:Number(t.isCurrent)})),events:s.events.map(({eligiblePersonIds,...e})=>({...e,hasRoster:1})),eventRosters:s.events.map(e=>({eventId:e.eventId,personId:'cadet'})),eventFlights:s.eventFlights,observations:s.observations,requests:s.requests,corrections:s.corrections,termRosters:s.terms.flatMap(t=>(t.roster??[]).map(p=>({...p,termId:t.termId}))),legacyBaselines:[]};
  const common={contractVersion:FRONTEND_PAGE_VERSION,section:b.section,revision,scope:{termId,currentTermId:'current'}};
  const result=b.section==='manifest'?{...common,environment:'staging',generation:2,sections:FRONTEND_SECTIONS.map(section=>({section,count:data[section].length})),previousTerms:options.nativeTerms??terms.filter(t=>!t.isCurrent).map(({roster,isCurrent,...t})=>t).reverse(),diagnostics:[],...(!historical?{effect}:{})}:b.section==='verify'?{...common,verified:true,...(!historical?{effect}:{})}:{...common,offset:0,rows:data[b.section],nextOffset:null};
  return {status:200,body:JSON.stringify(mutate(result,b,calls))};
 }};
 const original={method:'POST',url:config.baseUrl+'/v1/admin/effects/project',headers:{},body:JSON.stringify({environment:'staging',generation:2,principalId:'reader',workerId:'worker',effectId:'effect',claimToken:'claim'})};
 return {calls,run:()=>JSON.parse(createPagedFrontendTransport(transport,config,signer,()=>100,options.reviewed).send(original).body)};
}
test('native frontend fetches two bounded historical terms and rechecks its lease; Forms only fetch current semester',()=>{
 const f=transfer(),result=f.run();assert.equal(result.snapshot.events.length,1);assert.equal(result.snapshot.dashboardHistory.terms.length,2);assert.deepEqual(buildCoherentFrontendReporting(result.snapshot,date).dashboard,buildFrontendReporting(snapshotToFrontendReportingInput(full(),date)).dashboard);
 assert.equal(f.calls.filter(c=>c.b.section==='manifest').length,3);assert.equal(f.calls.at(-1).path,'/v1/admin/effects/project/page');assert.equal(f.calls.at(-1).b.section,'verify');
 const forms=transfer('forms.refresh');assert.equal(forms.run().snapshot.dashboardHistory,undefined);assert.equal(forms.calls.length,15);assert(forms.calls.every(c=>!c.b.termId));
});
test('historical revision, current-term drift or lost final effect verification cannot return a partial Dashboard',()=>{
 const changes=[(p,b)=>b.termId&&p.section==='manifest'?{...p,revision:{...revision,operations:6}}:p,
  (p,b)=>b.termId?{...p,scope:{...p.scope,currentTermId:'next'}}:p,
  (p,b,calls)=>calls.length>40&&p.section==='verify'&&!b.termId?{...p,verified:false}:p];
 for(const mutate of changes){const f=transfer('frontend.refresh',mutate);assert.throws(()=>f.run(),e=>e.code==='frontend_pages');}
});

function retainedOptions() {
 const terms=[{termId:'retained-earlier',label:'Earlier source',sortOrder:0,snapshotId:'source-earlier',sourceSnapshotSha256:'a'.repeat(64),expectedPeriodLabel:'Earlier source'},
  {termId:'retained-latest',label:'Latest source',sortOrder:1,snapshotId:'source-latest',sourceSnapshotSha256:'b'.repeat(64),expectedPeriodLabel:'Latest source'}];
 const body={version:1,reviewId:'fictional-source-review',terms};
 return {nativeTerms:[],reviewed:{...body,selectionSha256:sha(retainedHistoryCanonical(body))},retainedSummaries:terms.map((term,i)=>buildRetainedHistorySummary({snapshotId:term.snapshotId,sourceSnapshotSha256:term.sourceSnapshotSha256,expectedPeriodLabel:term.expectedPeriodLabel},2,[{asYear:i?'AS200':'AS100',rows:2,unresolvedRows:1,overallSum:i?1.5:1,overallCount:2,llabSum:2,llabCount:2,invalidRows:0}]))};
}
test('retained saved-value summaries persist across refreshes and supply past AS-year comparisons without current identities',()=>{
 const options=retainedOptions(),f=transfer('frontend.refresh',x=>x,options);
 const first=f.run(),second=f.run();assert.deepEqual(first,second);
 assert.equal(f.calls.filter(call=>call.path==='/v1/admin/history/summary').length,2);
 assert.equal(f.calls.filter(call=>call.path==='/v1/admin/snapshot/page').length,0);
 const report=buildCoherentFrontendReporting(first.snapshot,date);
 assert.deepEqual(report.dashboard.termTrend.map(t=>[t.termId,t.percentage]),[['retained-earlier',.5],['retained-latest',.75],['current',1]]);
 assert.deepEqual(report.dashboard.attendanceByYear.find(y=>y.asYear==='AS100').terms.map(t=>[t.termId,t.percentage]),[['current',null],['retained-latest',null],['retained-earlier',.5]]);
 assert.deepEqual(report.dashboard.retainedHistory.map(t=>[t.termId,t.rows,t.unresolvedRows]),[['retained-earlier',2,1],['retained-latest',2,1]]);
 assert.equal(report.matrices.length,1);assert.equal(first.snapshot.people[0].asYear,'AS300');
 const wrong=structuredClone(first.snapshot);wrong.dashboardHistory.terms[0].percentage=.1;assert.throws(()=>buildCoherentFrontendReporting(wrong,date));
});
test('new native semesters displace older retained sources and only latest two comparisons are fetched',()=>{
 const options=retainedOptions();options.nativeTerms=[{termId:'prior',label:'Prior',sortOrder:2}];
 const f=transfer('frontend.refresh',x=>x,options),result=f.run();
 assert.deepEqual(result.snapshot.dashboardHistory.terms.map(t=>t.termId),['prior','retained-latest']);
 const summary=f.calls.find(call=>call.path==='/v1/admin/history/summary');assert.deepEqual(summary.b.selections.map(s=>s.snapshotId),['source-latest']);
 const report=buildCoherentFrontendReporting(result.snapshot,date);assert.deepEqual(report.dashboard.termTrend.map(t=>t.termId),['retained-latest','prior','current']);
});
test('changed selected digest, duplicate native period, malformed counts or final lease drift cannot blank historical charts',()=>{
 const options=retainedOptions();
 for(const mutate of [value=>{if(value.summaries)value.summaries[0].sourceSnapshotSha256='f'.repeat(64);return value;},value=>{if(value.summaries)value.summaries[0].unresolvedRows=501;return value;},(value,b,calls)=>{if(value.section==='verify'&&calls.some(c=>c.path==='/v1/admin/history/summary'))value.verified=false;return value;}])assert.throws(()=>transfer('frontend.refresh',mutate,options).run());
 const overlapping=retainedOptions();overlapping.nativeTerms=[{termId:'native-overlap',label:'Latest source',sortOrder:2}];assert.throws(()=>transfer('frontend.refresh',x=>x,overlapping).run(),/overlap/);
 const bad=retainedOptions();bad.reviewed.terms[0].snapshotId='unreviewed-copy';assert.throws(()=>transfer('frontend.refresh',x=>x,bad).run());
 const forms=transfer('forms.refresh',x=>x,retainedOptions());forms.run();assert.equal(forms.calls.filter(c=>c.path==='/v1/admin/history/summary').length,0);
});
