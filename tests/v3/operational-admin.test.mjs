import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsv,encodeCsv,readOperationalCsv,writeOperationalCsv} from '../../scripts/lib/operational-csv.mjs';
import {selectorPredicate,selectRecords,translateLegacySelectors} from '../../scripts/lib/operational-selectors.mjs';
import {exportOperationalCsv,planOperationalCsvImport,planBulkAttendance,executeOperationalPlan,operationalHash,verifyOperationalPlan} from '../../scripts/lib/operational-admin.mjs';
const copy=structuredClone;
const context={batchId:'reviewed-batch',principalId:'operator',resourceKey:'operational-console',sourceKind:'test',asOfDate:'2026-11-16',reason:'Reviewed operational correction.'};
function snapshot(){
 const profile=(id,flightId,year,school,status='Active 3/4')=>({personId:id,version:1,flightId,active:status==='Active 3/4',lastName:'Example '+id,firstName:'Cadet',asYear:year,rank:'C/AB',role:'',university:school,email:id+'@example.invalid',phone:'001234567890',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-02-29',flightPathStatus:status,photoLink:''});
 const event=(eventId,eventType,eligiblePersonIds)=>({eventId,version:1,termId:'current',eventType,trainingWeek:1,displayOrder:eventType==='llab'?1:2,label:'TW1 '+eventType.toUpperCase(),columnLabel:'TW1 '+eventType.toUpperCase(),expectedGroup:'Reviewed event roster',eligiblePersonIds,status:'active',startAt:'2026-11-20T12:00:00.000Z',endAt:'2026-11-20T13:00:00.000Z',location:'Field, East',notes:'Bring "equipment"'});
 return {contractVersion:1,environment:'local',generation:1,revision:{operations:2,administration:5},people:[profile('person-a','alpha','AS100','Notre Dame'),profile('person-b','bravo','AS200','Trine'),profile('person-c','abroad','AS100','Trine'),profile('person-inactive','alpha','AS400','Notre Dame','Inactive')],leadership:[{contactId:'contact',contactVersion:1,profileVersion:null,publicationVersion:1,personId:null,lastName:'Example',firstName:'Cadre',rank:'Capt',role:'Cadre',email:'cadre@example.invalid',cellPhone:'001234',reportsTo:'Wing Commander',officePhone:'',officeLocation:'Hall',active:true}],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue',rosterVersion:1},{flightId:'bravo',label:'Bravo',squadronId:'gold',rosterVersion:1},{flightId:'abroad',label:'Abroad',squadronId:'gold',rosterVersion:1}],squadrons:[{squadronId:'blue',label:'Blue'},{squadronId:'gold',label:'Gold'}],terms:[{termId:'current',label:'Current term',sortOrder:1,isCurrent:true}],events:[event('llab','llab',['person-a','person-b']),event('other','other',['person-a','person-b','person-c'])],eventFlights:[{eventId:'llab',flightId:'alpha'},{eventId:'llab',flightId:'bravo'},{eventId:'other',flightId:'alpha'},{eventId:'other',flightId:'bravo'},{eventId:'other',flightId:'abroad'}],observations:[{factId:'observation',personId:'person-a',eventId:'llab',order:2,code:'P'}],corrections:[],requests:[{requestId:'request',personId:'person-b',eventId:'llab',flightId:'bravo',order:1,status:'Submitted',requestedOutcome:'E',version:1,reason:'Fictional request',submittedAt:'2026-11-16T12:00:00.000Z',submittedBy:'cadet',updatedAt:'2026-11-16T12:00:00.000Z',decidedAt:null,decidedBy:null,decisionReason:null}],attendanceVersions:[{personId:'person-a',eventId:'llab',version:2},{personId:'person-b',eventId:'llab',version:1}],diagnostics:[]};
}
const selection=()=>({termId:'current',events:{include:{all:true}},cadets:{include:{all:true}},abroad:'include',outsideRoster:'exclude',code:'T'});
const replaceRow=(csv,kind,mutate)=>{const rows=readOperationalCsv(csv,kind);mutate(rows);return writeOperationalCsv(kind,rows);};
test('CSV preserves quotes, commas, CRLF, Unicode, blanks, dates and leading zeros without trimming or executing text',()=>{
 const rows=[['value','notes'],['000001',' line\n"quoted",é '],['2000-02-29','=literal-formula-text'],['','']];assert.deepEqual(parseCsv(encodeCsv(rows)),rows);
 assert.deepEqual(parseCsv('\ufeff'+encodeCsv(rows)),rows);
 for(const text of ['a,"open','a,un"quoted','"closed"junk,b'])assert.throws(()=>parseCsv(text));
 assert.throws(()=>readOperationalCsv('person_id,expected_version\na,1\n','directory'),/CSV_HEADERS/);
});
test('all operational CSV categories roundtrip without changing the immutable snapshot or emitting commands',()=>{
 const s=snapshot(),original=copy(s);
 for(const kind of ['directory','leadership','events','attendance','excusals']){
  const csv=exportOperationalCsv(s,kind,{asOfDate:context.asOfDate}),plan=planOperationalCsvImport(s,csv,kind,context,{mode:'update'});assert.equal(plan.changes.length,0,kind);assert(verifyOperationalPlan(plan));
 }
 assert.deepEqual(s,original);assert(exportOperationalCsv(s,'directory').includes('001234567890'));
});
test('Directory import uses exact IDs, versions and full profiles; invalid rows fail before a plan exists',()=>{
 const s=snapshot(),base=exportOperationalCsv(s,'directory'),csv=replaceRow(base,'directory',rows=>rows[0].phone='009999');
 const plan=planOperationalCsvImport(s,csv,'directory',context,{mode:'update'});assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].command.payload.profile.phone,'009999');assert.equal(plan.changes[0].command.payload.expectedVersion,1);
 for(const mutate of [rows=>rows[0].expected_version='0',rows=>rows.push(copy(rows[0])),rows=>rows[0].date_of_birth='2001-02-29'])assert.throws(()=>planOperationalCsvImport(s,replaceRow(base,'directory',mutate),'directory',context,{mode:'update'}));
 assert.throws(()=>planOperationalCsvImport(s,csv,'directory',context,{mode:'create'}),/CSV_CREATE_EXISTS/);
});
test('reviewed replacement only deactivates explicitly scoped missing rows and preserves all source history',()=>{
 const s=snapshot(),csv=writeOperationalCsv('directory',[]);assert.throws(()=>planOperationalCsvImport(s,csv,'directory',context,{mode:'replace'}),/CSV_REPLACE_SCOPE/);
 const plan=planOperationalCsvImport(s,csv,'directory',context,{mode:'replace',replaceScopeIds:['person-a']});assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].command.payload.profile.flightPathStatus,'Inactive');assert.equal(plan.changes[0].command.payload.personId,'person-a');assert.equal(s.observations.length,1);assert.equal(s.requests.length,1);
 assert.throws(()=>planOperationalCsvImport(s,csv,'directory',context,{mode:'replace',replaceScopeIds:['unknown']}),/CSV_REPLACE_UNKNOWN/);
});
test('event imports preserve explicit rosters, canonical timestamps and immutable term identity',()=>{
 const s=snapshot(),csv=replaceRow(exportOperationalCsv(s,'events'),'events',rows=>rows[0].location='New field');const plan=planOperationalCsvImport(s,csv,'events',context,{mode:'merge'});
 assert.deepEqual(plan.changes[0].command.payload.eligiblePersonIds,['person-a','person-b']);assert.equal(plan.changes[0].command.payload.startAt,'2026-11-20T12:00:00.000Z');
 assert.throws(()=>planOperationalCsvImport(s,replaceRow(csv,'events',rows=>rows[0].term_id='another'),'events',context,{mode:'merge'}),/CSV_EVENT_TERM_IMMUTABLE/);
});
test('Attendance CSV changes are corrections with explicit base/event versions, never fabricated report submissions',()=>{
 const s=snapshot(),csv=replaceRow(exportOperationalCsv(s,'attendance',{asOfDate:context.asOfDate}),'attendance',rows=>{const target=rows.find(r=>r.person_id==='person-a'&&r.event_id==='llab');target.code='T';target.reason='Reviewed change';});
 const plan=planOperationalCsvImport(s,csv,'attendance',context,{mode:'update'});assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].operation,'attendance.correct');assert.equal(plan.changes[0].command.payload.expectedBaseVersion,2);
 assert.throws(()=>planOperationalCsvImport(s,replaceRow(csv,'attendance',rows=>rows.find(r=>r.person_id==='person-a'&&r.event_id==='llab').reason=''),'attendance',context,{mode:'update'}));
});
test('Excusal imports preserve submitted evidence and make reviewed decisions or explicit withdrawals',()=>{
 const s=snapshot(),csv=replaceRow(exportOperationalCsv(s,'excusals'),'excusals',rows=>{rows[0].status='Approved';rows[0].decision_reason='Reviewed approval';});
 const plan=planOperationalCsvImport(s,csv,'excusals',context,{mode:'update'});assert.equal(plan.changes[0].operation,'excusal.decide');assert.equal(plan.changes[0].command.payload.expectedVersion,1);
 assert.throws(()=>planOperationalCsvImport(s,replaceRow(csv,'excusals',rows=>rows[0].request_reason='Rewritten evidence'),'excusals',context,{mode:'update'}),/CSV_REQUEST_EVIDENCE_READ_ONLY/);
 const replacement=planOperationalCsvImport(s,writeOperationalCsv('excusals',[]),'excusals',context,{mode:'replace',replaceScopeIds:['request']});assert.equal(replacement.changes[0].command.payload.decision,'Withdrawn');
});
test('explicit AND/OR/include/exclude and Abroad rules freeze reviewed stable targets',()=>{
 const s=snapshot(),spec=selection();spec.cadets.include={and:[{field:'asYear',op:'in',values:['AS100']},{field:'university',op:'in',values:['Notre Dame']}]};
 let plan=planBulkAttendance(s,context,spec);assert.equal(plan.summary.selectedPeople,1);assert.equal(plan.changes.length,2);
 spec.cadets.include={or:[{field:'asYear',op:'in',values:['AS100']},{field:'university',op:'in',values:['Trine']}]};spec.cadets.includeIds=['person-a'];spec.cadets.excludeIds=['person-b'];spec.abroad='exclude';plan=planBulkAttendance(s,context,spec);assert.deepEqual(plan.selectedPeople.map(p=>p.personId),['person-a']);
 spec.abroad='only';plan=planBulkAttendance(s,context,spec);assert.deepEqual(plan.selectedPeople.map(p=>p.personId),['person-c']);assert.equal(plan.summary.excludedOutsideRoster,1);assert.equal(plan.changes.length,1);
 spec.outsideRoster='reject';assert.throws(()=>planBulkAttendance(s,context,spec),/BULK_OUTSIDE_EVENT_ROSTER/);
});
test('legacy selectors retain OR semantics, case-insensitive labels and no-filter inclusion of Abroad',()=>{
 const s=snapshot(),translated=translateLegacySelectors({eventSelector:{startsWith:['TW1']},cadetSelector:{asYears:['AS200'],includeAbroad:true}});let plan=planBulkAttendance(s,context,{...selection(),...translated});assert.deepEqual(plan.selectedPeople.map(p=>p.personId),['person-b','person-c']);
 const all=translateLegacySelectors({eventSelector:{all:true}});plan=planBulkAttendance(s,context,{...selection(),...all});assert.equal(plan.summary.selectedPeople,3);
 assert(selectorPredicate({field:'name',op:'in',values:['EXAMPLE, Cadet']},'cadets')({name:'example,cadet'}));
 assert(!selectorPredicate({field:'personId',op:'in',values:['Person-A']},'cadets')({personId:'person-a'}));
 assert.throws(()=>selectRecords([{personId:'a'}],{include:{all:true},excludeIds:['missing']},'cadets'),/SELECTOR_UNKNOWN_ID/);
});
test('bulk plans are immutable, deterministic and never re-evaluate selectors while applying',async()=>{
 const s=snapshot(),plan=planBulkAttendance(s,context,selection());assert.equal(plan.planHash,planBulkAttendance(s,context,selection()).planHash);const original=copy(plan);s.people[0].flightId='abroad';let saved,calls=0;
 const state={load:()=>copy(saved),save:v=>saved=copy(v)},request=async(_path,c)=>{calls++;assert.equal(saved.entries.find(e=>e.commandId===c.commandId).status,'dispatching');return {status:200,body:{commandId:c.commandId,status:'committed',operation:c.operation,result:{}}};};
 assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request,maximumCommands:1})).status,'continuing');assert.equal(calls,1);
 while((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request})).status==='continuing'){}
 assert.equal(calls,plan.changes.length);assert.deepEqual(plan,original);assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request})).attempted,0);
 const tampered=copy(plan);tampered.changes[0].command.payload.code='A';assert.throws(()=>verifyOperationalPlan(tampered),/ADMIN_PLAN_HASH/);
});
test('lost acknowledgement retries the exact command and conflict stops remaining work without rebasing',async()=>{
 const plan=planBulkAttendance(snapshot(),context,selection());let saved,lose=true,calls=[],accepted=new Set();const state={load:()=>copy(saved),save:v=>saved=copy(v)};
 const request=async(_p,c)=>{calls.push(copy(c));accepted.add(c.commandId);if(lose){lose=false;throw Error('lost response');}return {status:200,body:{commandId:c.commandId,status:'committed',operation:c.operation}};};
 assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request})).status,'retry-retained-command');assert.equal(saved.entries[0].status,'dispatching');await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request,maximumCommands:1});assert.deepEqual(calls[0],calls[1]);assert.equal(accepted.size,1);
 const before=calls.length;const conflict=await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request:async()=>({status:409,body:{error:{code:'VERSION_CONFLICT'}}})});assert.equal(conflict.status,'needs-review');assert.equal(saved.entries[1].status,'conflict');assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request})).attempted,0);assert.equal(calls.length,before);
 saved.entries[0].receipt.status='changed';await assert.rejects(executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request}),/ADMIN_CHECKPOINT/);
});

import {readFile,mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {exportCanonicalLegend,planCanonicalLegend} from '../../scripts/lib/operational-legend.mjs';
import {readPrivateOperationalFile,privateOperationalDirectory} from '../../scripts/operational-admin.mjs';
test('canonical legend CSV retains existing choices, rejects operational-code changes and produces exact source/private-config patches',async()=>{
 const source=await readFile(new URL('../../src/utils/arrays.ts',import.meta.url),'utf8'),csv=exportCanonicalLegend(source),rows=readOperationalCsv(csv,'data_legend');
 const dorms=rows.filter(r=>r.list==='dorm_options').map(r=>r.value),index=rows.findIndex(r=>r.list==='dorm_options')+dorms.length;rows.splice(index,0,{list:'dorm_options',position:String(dorms.length),value:'Fictional New Hall'});
 const result=planCanonicalLegend(writeOperationalCsv('data_legend',rows),source,{reason:'Reviewed new residence option.',formsConfig:{forms:[{choices:[{source:{kind:'directory',field:'dorm',values:dorms}}]}]}});
 assert.equal(result.plan.changes.length,1);assert.equal(result.plan.privateConfigChanges.length,1);assert(result.proposedSource.includes('Fictional New Hall'));assert.equal(result.proposedFormsConfig.forms[0].choices[0].source.values.at(-1),'Fictional New Hall');
 assert.throws(()=>planCanonicalLegend(replaceRow(csv,'data_legend',rows=>rows.find(r=>r.list==='attendance_code_options').value='OTHER'),source,{reason:'Unsupported policy edit'}),/ADMIN_LEGEND_EXISTING_CHOICES/);
 assert.throws(()=>planCanonicalLegend(replaceRow(csv,'data_legend',rows=>rows.splice(rows.findIndex(r=>r.list==='dorm_options'),1)),source,{reason:'Remove option'}));
});
test('private operational files reject public modes and symlinks without changing their contents',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'shamrock-ops-'));await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));assert.equal(await privateOperationalDirectory(directory),await import('node:fs/promises').then(m=>m.realpath(directory)));
 const file=path.join(directory,'input.json');await writeFile(file,'{"fictional":true}',{mode:0o600});assert.deepEqual(await readPrivateOperationalFile(file),{fictional:true});
 await chmod(file,0o644);await assert.rejects(readPrivateOperationalFile(file),/ADMIN_CLI_PRIVATE_FILE/);await chmod(file,0o600);await symlink(file,path.join(directory,'alias.json'));await assert.rejects(readPrivateOperationalFile(path.join(directory,'alias.json')),/ADMIN_CLI_PRIVATE_FILE/);
});

import {createHmac,createHash} from 'node:crypto';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {initializeLocalDatabase} from '../../scripts/lib/v3-local-database.mjs';
import {captureOperationalSnapshot} from '../../scripts/lib/operational-admin.mjs';
test('operational CSV creation and interrupted bulk correction run through actual D1 authorization, receipts and refresh effects',async t=>{
 const secret='fictional-operational-console-test-secret',keyId='fixture',mf=new Miniflare({modules:true,scriptPath:path.resolve('.build/v3-artifacts/worker.mjs'),compatibilityDate:'2026-07-01',d1Databases:{DB:'operational-console'},bindings:{ENVIRONMENT:'local',GENERATION:'1',BRIDGE_KEY_ID:keyId,BRIDGE_SECRET:secret},log:new Log(LogLevel.NONE)});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await initializeLocalDatabase(db);
 await db.batch([
  db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),db.prepare("INSERT INTO principals VALUES('operator',NULL,1)"),
  db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1),('abroad','Abroad',1)"),db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),db.prepare("INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold'),('abroad','gold')"),db.prepare("INSERT INTO terms VALUES('current','Current term',1,1)"),
  db.prepare("INSERT INTO admin_grants SELECT 'operator',value,'wing','*' FROM json_each(?)").bind(JSON.stringify(['directory.manage','leadership.manage','events.manage','frontend.read','attendance.correct'])),db.prepare("INSERT INTO adapter_sources VALUES('test','operational-console',1)")
 ]);
 const request=async(endpoint,input)=>{const body=JSON.stringify(input),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(`POST\n${endpoint}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');const response=await mf.dispatchFetch('https://operational.invalid'+endpoint,{method:'POST',body,headers:{'content-type':'application/json','x-shamrock-key-id':keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signature}});return {status:response.status,body:await response.json()};};
 const identity={environment:'local',generation:1,principalId:'operator'},source=snapshot();let current=await captureOperationalSnapshot(identity,request);
 for(const category of ['directory','events']){
  const csv=replaceRow(exportOperationalCsv(source,category),category,rows=>rows.forEach(r=>r.expected_version='0'));
  const plan=planOperationalCsvImport(current,csv,category,{...context,batchId:'seed-'+category},{mode:'create'});let journal;const state={load:()=>copy(journal),save:v=>journal=copy(v)};
  const outcome=await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request,maximumCommands:10});assert.equal(outcome.status,'committed-awaiting-publication',JSON.stringify(journal));current=await captureOperationalSnapshot(identity,request);
 }
 assert.equal(current.people.length,4);assert.equal(current.events.length,2);
 const spec=selection();spec.cadets={include:{field:'personId',op:'in',values:['person-a']}};spec.code='P';const plan=planBulkAttendance(current,{...context,batchId:'actual-bulk'},spec);assert.equal(plan.changes.length,2);
 let journal,lose=true;const state={load:()=>copy(journal),save:v=>journal=copy(v)},ambiguous=async(endpoint,input)=>{const result=await request(endpoint,input);assert.equal(result.status,200,JSON.stringify(result.body));if(lose){lose=false;throw Error('response lost after actual commit');}return result;};
 assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request:ambiguous})).status,'retry-retained-command');assert.equal((await db.prepare('SELECT COUNT(*) n FROM attendance_corrections').first()).n,1);
 assert.equal((await executeOperationalPlan(plan,{approvedHash:plan.planHash,state,request:ambiguous})).status,'committed-awaiting-publication');assert.equal((await db.prepare('SELECT COUNT(*) n FROM attendance_corrections').first()).n,2);assert.equal((await db.prepare('SELECT COUNT(*) n FROM audit_events').first()).n,2);assert.equal((await db.prepare('SELECT COUNT(*) n FROM attendance_reports').first()).n,0);
 current=await captureOperationalSnapshot(identity,request);assert.equal(planBulkAttendance(current,{...context,batchId:'verified-no-op'},spec).changes.length,0);assert((await db.prepare("SELECT COUNT(*) n FROM admin_effects WHERE kind='frontend.refresh'").first()).n>=2);
 const revoked=planBulkAttendance(current,{...context,batchId:'revoked'}, {...spec,code:'T'});await db.prepare("DELETE FROM admin_grants WHERE capability='attendance.correct'").run();let rejected;const blocked=await executeOperationalPlan(revoked,{approvedHash:revoked.planHash,state:{load:()=>rejected,save:v=>rejected=copy(v)},request});assert.equal(blocked.status,'needs-review');assert.equal(rejected.entries[0].status,'rejected');assert.equal((await db.prepare('SELECT COUNT(*) n FROM attendance_corrections').first()).n,2);
});
