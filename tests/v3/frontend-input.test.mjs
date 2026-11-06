import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bindImmutableInputSlots,captureFrontendEdit,commandsForCapturedEdit,reconcileInputReceipt,nativeInputValue} from '../../.build/v3/apps/google-adapter/src/frontend-input.js';
const copy=x=>structuredClone(x),signer={sha256:x=>createHash('sha256').update(x).digest('hex')},principal={email:'editor@example.invalid',principalId:'editor'};
const scalar=v=>v===null?{}:typeof v==='number'?{userEnteredValue:{numberValue:v}}:{userEnteredValue:{stringValue:v}};
function fixture(){
 const headers=['last_name','event:event-one','person_id'],values={last_name:'Example','event:event-one':null,person_id:'person-one'};
 const row={key:'person-one',values,versions:{'event:event-one':4},eventVersions:{'event:event-one':9},commandBindings:{'event:event-one':{operation:'attendance.correct',entityId:'person-one',field:'event-one',expectedVersion:4}}};
 return {event:{spreadsheetId:'main',sheetId:1,row:3,column:2,rows:1,columns:1,value:'P',actorEmail:principal.email,triggerUid:'trigger'},binding:{surface:'attendance',spreadsheetId:'main',sheetId:1,tableId:'table',resourceKey:'main-attendance'},baseline:{generation:1,revision:{operations:4,administration:1},rows:[row],slots:{headers,keys:['person-one']}},drafts:[],current:{sheetId:1,tableId:'table',gridRowCount:20,gridColumnCount:3,headers,labels:['Last Name','LLAB','Person ID'],rows:[[scalar('Example'),scalar('P'),scalar('person-one')]],range:{sheetId:1,startRowIndex:1,endRowIndex:3,startColumnIndex:0,endColumnIndex:3},hiddenColumns:[2],machineRowHidden:true},snapshot:{environment:'staging',generation:1,people:[],leadership:[],flights:[]},principals:[principal],config:{environment:'staging',generation:1,baseUrl:'https://fixture.invalid',keyId:'fixture'},signer,providerCoordinatesVerified:true,automationEmail:'automation@example.invalid'};
}
const capture=f=>captureFrontendEdit(f),commands=edit=>commandsForCapturedEdit({edit,principals:[principal]});
test('single verified dropdown freezes protected target and original pair/catalog versions',()=>{
 const f=fixture(),e=capture(f),c=commands(e)[0];assert.equal(e.status,'ready');assert.equal(c.actor.evidence,'google-edit');assert.deepEqual(c.payload,{personId:'person-one',eventId:'event-one',expectedBaseVersion:4,expectedEventVersion:9,code:'P',reason:'Spreadsheet attendance correction.'});assert.deepEqual(capture(f),e);
 f.baseline.rows[0].versions['event:event-one']=100;assert.equal(c.payload.expectedBaseVersion,4);
});
test('slot/header reorder, overwritten identity and protected columns never become commands',()=>{
 for(const mutate of[f=>f.current.headers.reverse(),f=>f.current.rows[0][2]=scalar('person-two'),f=>delete f.baseline.slots,f=>{f.event.column=1;f.current.rows[0][0]=scalar('Tampered');f.event.value='Tampered';f.event.oldValue='Example';}]){const f=fixture();mutate(f);assert.throws(()=>capture(f));}
 const f=fixture();f.current.rows.push([scalar('Second'),scalar('P'),scalar('person-two')]);f.baseline.slots.keys.push('person-two');f.baseline.rows.push({...copy(f.baseline.rows[0]),key:'person-two',values:{...f.baseline.rows[0].values,person_id:'person-two'}});f.current.rows.reverse();assert.throws(()=>capture(f),e=>e.code==='input_slots');
});
test('missing identity, owner bypass, unverified FilterView coordinates and absent old-value evidence require confirmation',()=>{
 for(const mutate of[f=>delete f.event.actorEmail,f=>f.event.actorEmail=f.automationEmail,f=>f.providerCoordinatesVerified=false,f=>f.event.oldValue='unexpected']){const f=fixture();mutate(f);const e=capture(f);assert.equal(e.status,'confirmation-required');assert.throws(()=>commands(e),x=>x.code==='confirmation_required');const c=commandsForCapturedEdit({edit:e,principals:[principal],confirmation:{verified:true,verifiedEmail:principal.email,reference:e.editId,summary:e.summary,action:'Confirm these changes'}})[0];assert.equal(c.actor.evidence,'authenticated-confirmation');assert.equal(c.payload.expectedBaseVersion,4);}
});
test('confirmation cannot change target, summary, value, account identity or action',()=>{
 const f=fixture();delete f.event.actorEmail;const e=capture(f),confirmation={verified:true,verifiedEmail:principal.email,reference:e.editId,summary:e.summary,action:'Confirm these changes'};
 for(const patch of[{verified:false},{verifiedEmail:'other@example.invalid'},{reference:'different'},{summary:e.summary+' changed'},{action:'Cancel'}])assert.throws(()=>commandsForCapturedEdit({edit:e,principals:[principal],confirmation:{...confirmation,...patch}}));
});
test('single clears are explicit corrections; multi-cell edits freeze exact cells but need confirmation',()=>{
 const f=fixture();f.baseline.rows[0].values['event:event-one']='P';f.current.rows[0][1]={};delete f.event.value;f.event.oldValue='P';assert.equal(commands(capture(f))[0].payload.code,null);
 const m=fixture();m.event.rows=2;delete m.event.value;m.current.rows.push([scalar('Other'),scalar('A'),scalar('person-two')]);m.current.range.endRowIndex=4;m.baseline.slots.keys.push('person-two');m.baseline.rows.push({...copy(m.baseline.rows[0]),key:'person-two',values:{...m.baseline.rows[0].values,last_name:'Other',person_id:'person-two'},commandBindings:{'event:event-one':{...m.baseline.rows[0].commandBindings['event:event-one'],entityId:'person-two'}}});const e=capture(m);assert.equal(e.drafts.length,2);assert.equal(e.status,'confirmation-required');assert.equal(e.templates.length,2);
});
test('pending drafts retain their original base and cannot silently be replaced',()=>{
 const f=fixture(),first=capture(f);f.drafts=copy(first.drafts);assert.deepEqual(capture(f).drafts,first.drafts);f.current.rows[0][1]=scalar('A');f.event.value='A';assert.throws(()=>capture(f),e=>e.code==='input_pending');
});
test('receipt reconciliation checks the exact command target, value and version before advancing the draft',()=>{
 const f=fixture(),e=capture(f),command=commands(e)[0],base={baseline:f.baseline,drafts:e.drafts,template:e.templates[0],command},receipt={commandId:command.commandId,status:'committed',operation:'attendance.correct',result:{personId:'person-one',eventId:'event-one',version:12,code:'P'}};
 const result=reconcileInputReceipt({...base,receipt});assert.equal(result.drafts.length,0);assert.equal(result.baseline.rows[0].values['event:event-one'],'P');assert.equal(result.baseline.rows[0].versions['event:event-one'],12);assert.equal(f.baseline.rows[0].versions['event:event-one'],4);
 for(const patch of[{commandId:'wrong'},{status:'queued'},{result:{...receipt.result,eventId:'other'}},{result:{...receipt.result,code:'A'}},{result:{...receipt.result,version:4}}])assert.throws(()=>reconcileInputReceipt({...base,receipt:{...receipt,...patch}}));
});
test('formulas and ambiguous chips are rejected; native photo identity remains the file URI',()=>{
 assert.throws(()=>nativeInputValue({userEnteredValue:{formulaValue:'=1+1'}}));assert.throws(()=>nativeInputValue({chipRuns:[{chip:{personProperties:{email:'person@example.invalid'}}}]}));assert.deepEqual(nativeInputValue({userEnteredValue:{stringValue:'@'},chipRuns:[{chip:{richLinkProperties:{uri:'https://drive.google.com/file/d/fixture/view'}}}]}),{fileUri:'https://drive.google.com/file/d/fixture/view'});
});
function profileFixture(kind){
 const f=fixture(),profile={lastName:'Example',firstName:'Cadet',asYear:'AS200',rank:'C/AB',role:'',university:'School',email:'cadet@example.invalid',phone:'old',dorm:'',cipBroadArea:'',cipCode:'',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:null,flightPathStatus:'Active 3/4',photoLink:''};
 f.binding.surface=kind;f.binding.resourceKey=`main-${kind}`;f.current.headers=['last_name',kind==='directory'?'phone':'office_phone',kind==='directory'?'person_id':'contact_id'];f.current.labels=['Last Name','Phone','ID'];f.baseline.slots.headers=copy(f.current.headers);const header=f.current.headers[1],key=kind==='directory'?'person-one':'contact-one';f.baseline.slots.keys=[key];f.current.rows=[[scalar('Example'),scalar('new'),scalar(key)]];f.event.value='new';f.event.oldValue='old';f.baseline.rows=[{key,values:{last_name:'Example',[header]:'old',[f.current.headers[2]]:key},versions:{[header]:kind==='directory'?3:8},commandBindings:{[header]:{operation:`${kind}.upsert`,entityId:key,field:kind==='directory'?'phone':'officePhone',expectedVersion:3}}}];
 if(kind==='directory')f.snapshot.people=[{...profile,personId:key,version:3,flightId:'alpha',active:true}];else f.snapshot.leadership=[{contactId:key,contactVersion:3,publicationVersion:8,profileVersion:5,personId:'person-one',lastName:'Example',firstName:'Cadet',rank:'C/AB',role:'Alpha Flight Commander',email:'cadet@example.invalid',cellPhone:'',reportsTo:'',officePhone:'old',officeLocation:'',active:true}];return f;
}
test('Directory and linked Leadership commands use the frozen domain version without rebasing or guessing linked IDs',()=>{
 const d=profileFixture('directory'),e=capture(d),c=commands(e)[0];assert.equal(c.payload.profile.phone,'new');assert.equal(c.payload.profile.rank,'C/AB');assert.equal(c.payload.expectedVersion,3);d.snapshot.people[0].version=4;assert.throws(()=>capture(d),e=>e.code==='input_version');
 const l=profileFixture('leadership'),le=capture(l),lc=commands(le)[0];assert.equal(lc.payload.personId,'person-one');assert.equal(lc.payload.profile,null);assert.equal(lc.payload.expectedVersion,3);assert.equal(lc.payload.officePhone,'new');const result=reconcileInputReceipt({baseline:l.baseline,drafts:le.drafts,template:le.templates[0],command:lc,receipt:{commandId:lc.commandId,status:'committed',operation:'leadership.upsert',result:{targetId:'contact-one',version:4}}});assert.equal(result.baseline.rows[0].versions.office_phone,9);assert.equal(result.baseline.rows[0].commandBindings.office_phone.expectedVersion,4);
});


test('one-time physical slot binding requires a fence and exact native values, and never changes cell presentation',()=>{
 const f=fixture();delete f.baseline.slots;f.current.rows[0][1]={};const before=copy(f.current),bound=bindImmutableInputSlots({baseline:f.baseline,current:f.current,keyHeader:'person_id',editFenceVerified:true});assert.deepEqual(bound.slots,{headers:f.current.headers,keys:['person-one']});assert.deepEqual(f.current,before);assert.equal(f.baseline.slots,undefined);
 assert.throws(()=>bindImmutableInputSlots({baseline:f.baseline,current:f.current,keyHeader:'person_id',editFenceVerified:false}));f.current.rows[0][1]=scalar('P');assert.throws(()=>bindImmutableInputSlots({baseline:f.baseline,current:f.current,keyHeader:'person_id',editFenceVerified:true}));
});

test('native empty cells match published empty strings without changing baselines or hiding nonblank edits',()=>{
 for(const kind of ['directory','leadership']){
  const f=profileFixture(kind),header=f.current.headers[1];f.baseline.rows[0].values[header]='';f.current.rows[0][1]={};delete f.event.value;delete f.event.oldValue;
  const original=copy(f.baseline),bound=bindImmutableInputSlots({baseline:f.baseline,current:f.current,keyHeader:f.current.headers[2],editFenceVerified:true});
  assert.deepEqual(f.baseline,original);assert.equal(bound.rows[0].values[header],'');assert.equal(capture(f).status,'noop');
  f.current.rows[0][1]=scalar('new');f.event.value='new';assert.equal(capture(f).status,'ready');
  f.current.rows[0][1]=scalar(' ');f.event.value=' ';assert.throws(()=>bindImmutableInputSlots({baseline:f.baseline,current:f.current,keyHeader:f.current.headers[2],editFenceVerified:true}));
 }
});

test('Blue and Gold decisions bind request/version and cannot clear a committed status implicitly',()=>{
 const f=fixture();f.binding.surface='blue';f.binding.resourceKey='blue-decisions';f.current.headers=['last_name','decision','request_id'];f.current.labels=['Last Name','Decision','Request'];f.baseline.slots={headers:f.current.headers,keys:['request-one']};f.baseline.rows=[{key:'request-one',values:{last_name:'Example',decision:null,request_id:'request-one'},versions:{decision:2},commandBindings:{decision:{operation:'excusal.decide',entityId:'request-one',field:'decision',expectedVersion:2}}}];f.current.rows=[[scalar('Example'),scalar('Denied'),scalar('request-one')]];f.event.value='Denied';const e=capture(f),c=commands(e)[0];assert.equal(c.operation,'excusal.decide');assert.equal(c.payload.requestId,'request-one');assert.equal(c.payload.expectedVersion,2);
 f.baseline.rows[0].values.decision='Denied';f.current.rows[0][1]={};delete f.event.value;f.event.oldValue='Denied';assert.throws(()=>capture(f));
});
