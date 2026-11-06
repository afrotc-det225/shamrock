import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planNativeFormPublication,verifyNativeFormPlan,verifyFormBeforeContinuations} from '../../.build/v3/apps/google-adapter/src/forms-publication.js';
import {commandsFromManagedForm} from '../../.build/v3/apps/google-adapter/src/forms-intake.js';
import {consumeFormsRefresh} from '../../.build/v3/apps/google-adapter/src/forms-refresh.js';
const clone=x=>structuredClone(x),signer={sha256:s=>createHash('sha256').update(s).digest('hex'),hmacSha256:()=>''};
const person={personId:'one',lastName:'Example',firstName:'One',asYear:'AS100',flightId:'alpha',university:'Notre Dame',active:true,version:1};
const config={environment:'local',generation:1,baseUrl:'http://localhost',keyId:'fixture'};
function fixture(){
 const snapshot={environment:'local',generation:1,revision:{administration:1,operations:1},people:[person],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue',rosterVersion:1}],terms:[{termId:'term',isCurrent:true}],events:['mando','llab','secondary','other'].map((eventType,i)=>({eventId:eventType,eventType,termId:'term',status:'active',label:eventType,displayOrder:i,version:1})),eventFlights:[]};
 const items=[],choices=[],navigation={};const q=(id,type='CHECKBOX')=>({itemId:`i-${id}`,title:id,questionItem:{question:{questionId:id,choiceQuestion:{type,options:[{value:'old'}]}}}});
 const question=(id,source,type='CHECKBOX')=>{items.push(q(id,type));choices.push({itemId:`i-${id}`,questionId:id,source});};
 const page=id=>{items.push({itemId:id,title:id,pageBreakItem:{}});navigation[id]={action:'SUBMIT'};};
 for(const type of['mando','llab','secondary','other'])question(`event-${type}`,{kind:'events',types:[type]},'DROP_DOWN');
 question('mando-scope',{kind:'profiles',profiles:[{key:'flight:alpha',label:'Alpha',filter:{flightIds:['alpha']}}]},'RADIO');question('llab-scope',{kind:'flights'},'RADIO');
 for(const type of['mando','llab','secondary','other']){page(`page-${type}`);question(`present-${type}`,{kind:'people',flightIds:['alpha'],asYears:['AS100']});}
 page('page-trine');page('page-valparaiso');
 const attendanceLayout={version:1,review:'OPTIONAL_UNVALIDATED_CHECKBOX_AND_SUBMIT_SECTIONS_REVIEWED',questionTemplateItemId:'i-present-mando',sectionTemplateItemId:'page-mando',excludedFlightLabels:['Abroad'],mando:{scopeQuestionId:'mando-scope',eventQuestions:['event-mando'],flights:[{flightId:'alpha',sectionId:'page-mando'}],crosstown:[{key:'cross:trine',label:'Trine',universities:['Trine'],sectionId:'page-trine'},{key:'cross:valparaiso',label:'Valparaiso',universities:['Valparaiso'],sectionId:'page-valparaiso'}]},llab:{scopeQuestionId:'llab-scope',eventQuestions:['event-llab'],flights:[{flightId:'alpha',sectionId:'page-llab'}]},secondary:{sectionId:'page-secondary',eventQuestions:['event-secondary']},other:{sectionId:'page-other',eventQuestions:['event-other']}};
 const binding={key:'attendance',formId:'fixture-attendance',resourceKey:'attendance-form',expectedTitle:'Attendance Staging',linkedSheetId:'response-sheet',choices,attendanceLayout};
 return{snapshot,binding,current:{formId:binding.formId,revisionId:'r1',info:{title:binding.expectedTitle},settings:{emailCollectionType:'VERIFIED'},linkedSheetId:'response-sheet',items,acceptingResponses:false,pageBreakNavigation:navigation},signer};
}
function grow(f){f.snapshot.flights.push({flightId:'bravo',label:'Bravo',squadronId:'gold',rosterVersion:1});f.snapshot.people.push({...person,personId:'two',flightId:'bravo',asYear:'AS250'});}
function apply(read,requests){for(const request of requests){if(request.createItem){const{item,location}=request.createItem;read.items.splice(location.index,0,clone(item));if(item.pageBreakItem)read.pageBreakNavigation[item.itemId]={action:'CONTINUE'};}else{const{item,location}=request.updateItem;assert.equal(read.items[location.index].itemId,item.itemId);read.items[location.index].questionItem.question.choiceQuestion.options=clone(item.questionItem.question.choiceQuestion.options);}}read.revisionId+='x';}
const option=(p,predicate)=>{const[token,r]=Object.entries(p.edition.references).find(([,r])=>predicate(r));return{questionId:r.questionId,value:p.expectedAfter.items.flatMap(i=>i.questionItem?.question?.choiceQuestion?.options??[]).find(o=>o.value.endsWith(`[sr:${token}]`)).value};};
test('a missing AS-year cohort is added in all applicable existing sections without replacing history',()=>{
 const f=fixture();f.snapshot.people.push({...person,personId:'two',asYear:'AS150'});const p=planNativeFormPublication(f);assert.equal(p.requests.filter(r=>r.createItem).length,4);assert.equal(p.continuations,undefined);assert(f.current.items.every(i=>p.expectedAfter.items.some(after=>after.itemId===i.itemId)));assert.equal(p.expectedAfter.linkedSheetId,f.current.linkedSheetId);assert.deepEqual(p.expectedAfter.pageBreakNavigation,f.current.pageBreakNavigation);
 const event=option(p,r=>r.kind==='event'&&r.eventId==='mando'),scope=option(p,r=>r.kind==='scope-group'&&r.key==='flight:alpha'),cadet=option(p,r=>r.kind==='person'&&r.personId==='two'&&p.edition.attendanceRules[0].presentQuestions.includes(r.questionId));
 const binding={formId:f.binding.formId,resourceKey:f.binding.resourceKey,kind:'attendance',events:['event-mando','event-llab','event-secondary','event-other']};
 const commands=commandsFromManagedForm({submission:{formId:f.binding.formId,responseId:'response-one',lastSubmittedTime:'2026-11-06T12:00:00Z',respondentEmail:'operator@example.invalid',verifiedResponder:true,answers:{[event.questionId]:event.value,[scope.questionId]:scope.value,[cadet.questionId]:[cadet.value]}},binding,editions:{[p.edition.editionId]:p.edition},principals:[{email:'operator@example.invalid',principalId:'operator'}],config,signer});assert.deepEqual(commands[0].payload.presentPersonIds,['two']);assert.equal(commands[0].payload.completeness,'partial');
});
test('a new Flight adds two native sections, freezes Submit continuations, and replans without duplicate creation',()=>{
 const f=fixture();grow(f);const p=planNativeFormPublication(f);assert.equal(p.continuations.length,2);assert.equal(p.requests.filter(r=>r.createItem).length,6);const read=clone(f.current);apply(read,p.requests);assert(verifyFormBeforeContinuations(p,read));assert(!verifyNativeFormPlan(p,read));for(const id of p.continuations)read.pageBreakNavigation[id]={action:'SUBMIT'};assert(verifyNativeFormPlan(p,read));const next=planNativeFormPublication({...f,current:read,previousEdition:p.edition});assert.equal(next.requests.length,0);assert.equal(next.edition.editionId,p.edition.editionId);assert.equal(next.continuations,undefined);
 const ids=read.items.flatMap(i=>[i.itemId,i.questionItem?.question?.questionId].filter(Boolean));assert.equal(new Set(ids).size,ids.length);
});
test('old response editions retain the original cohort bindings after a newer cohort is created',()=>{
 const f=fixture(),old=planNativeFormPublication(f);f.snapshot.people.push({...person,personId:'two',asYear:'AS150'});const newer=planNativeFormPublication(f);assert.notEqual(old.edition.editionId,newer.edition.editionId);assert.equal(old.edition.attendanceRules[0].presentQuestions.length,1);assert.equal(newer.edition.attendanceRules[0].presentQuestions.length,2);
});
test('layout rejects uncovered unassigned cadets, changed templates, conflicting IDs and bounded growth',()=>{
 const f=fixture();f.snapshot.people[0]={...person,flightId:null};assert.throws(()=>planNativeFormPublication(f),e=>e.code==='forms_layout');
 const changed=fixture();changed.current.items.find(i=>i.itemId==='i-present-mando').questionItem.question.required=true;assert.throws(()=>planNativeFormPublication(changed),e=>e.code==='forms_layout');
 const collision=fixture();grow(collision);assert.throws(()=>planNativeFormPublication({...collision,signer:{...signer,sha256:()=> 'a'.repeat(64)}}),e=>e.code==='forms_layout');
 const large=fixture();for(let i=0;i<75;i++)large.snapshot.people.push({...person,personId:`new-${i}`,asYear:`AS${1000+i}`});assert.throws(()=>planNativeFormPublication(large),e=>e.code==='forms_layout');
});
function runtime(){
 const f=fixture();grow(f);const bindings=[f.binding,...['excusals','directory'].map(key=>({key,formId:`fixture-${key}`,resourceKey:`${key}-form`,expectedTitle:`${key} Staging`,choices:[]}))];
 const books={attendance:clone(f.current),...Object.fromEntries(bindings.slice(1).map(b=>[b.key,{formId:b.formId,revisionId:'r1',info:{title:b.expectedTitle},settings:{emailCollectionType:'VERIFIED'},items:[],acceptingResponses:false}]))};
 const fx={state:{version:1,environment:'local',generation:1,editions:{},current:{}},writes:0,navigations:0,ack:0,failAfterApi:false,failAfterNavigation:false};const claim={effectId:'effect',claimToken:'token',kind:'forms.refresh',leaseExpiresAt:'2026-11-06T12:10:00Z'};
 const io={config,enabled:()=>true,intakeEnabled:()=>false,now:()=>Date.parse('2026-11-06T12:00:00Z'),signer,bindings,lock:{tryLock:()=>true,releaseLock(){}},assertIsolation(){},state:{load:()=>clone(fx.state),save:s=>{fx.state=clone(s);}},effects:{claim:()=>clone(claim),project:()=>({effect:claim,snapshot:f.snapshot}),ack:()=>{fx.ack++;}},forms:{read:b=>clone(books[b.key]),setAccepting:(b,v)=>{books[b.key].acceptingResponses=v;},write:(b,rs)=>{assert(fx.state.pending);assert.equal(books[b.key].acceptingResponses,false);fx.writes++;apply(books[b.key],rs);if(fx.failAfterApi)throw Error('lost REST response');},setSubmitContinuation:(b,id)=>{fx.navigations++;books[b.key].pageBreakNavigation[id]={action:'SUBMIT'};if(fx.failAfterNavigation)throw Error('lost native response');}},pause(){}};
 return{f,fx,io,books};
}
test('ambiguous REST creation resumes the frozen plan and never creates duplicate questions',()=>{
 const{fx,io,books}=runtime();fx.failAfterApi=true;assert.throws(()=>consumeFormsRefresh(io));assert(fx.state.pending);const count=books.attendance.items.length;fx.failAfterApi=false;io.effects.project=()=>assert.fail('frozen snapshot must not be regenerated');assert.equal(consumeFormsRefresh(io).status,'published');assert.equal(fx.writes,1);assert.equal(books.attendance.items.length,count);assert.equal(fx.navigations,2);assert.equal(fx.ack,1);
});
test('interrupted native navigation resumes only unfinished continuations before shared acknowledgement',()=>{
 const{fx,io,books}=runtime();fx.failAfterNavigation=true;assert.throws(()=>consumeFormsRefresh(io));assert.equal(fx.ack,0);assert.equal(fx.writes,1);assert(Object.values(books).every(b=>!b.acceptingResponses));fx.failAfterNavigation=false;assert.equal(consumeFormsRefresh(io).status,'published');assert.equal(fx.navigations,2);assert.equal(fx.writes,1);assert.equal(fx.ack,1);
});
test('unrelated section navigation drift is never overwritten during interrupted growth',()=>{
 const{fx,io,books}=runtime();fx.failAfterApi=true;assert.throws(()=>consumeFormsRefresh(io));fx.failAfterApi=false;books.attendance.pageBreakNavigation['page-other']={action:'RESTART'};assert.throws(()=>consumeFormsRefresh(io),e=>e.code==='forms_changed');assert.equal(fx.navigations,0);assert.equal(fx.ack,0);assert.equal(books.attendance.pageBreakNavigation['page-other'].action,'RESTART');
});

test('an added cohort becomes empty without retaining inactive cadets or losing its question identity',()=>{
 const f=fixture();f.snapshot.people.push({...person,personId:'two',asYear:'AS150'});const first=planNativeFormPublication(f);const read=clone(first.expectedAfter);f.snapshot.people[1].active=false;const next=planNativeFormPublication({...f,current:read,previousEdition:first.edition});assert.equal(next.requests.filter(r=>r.createItem).length,0);assert(!Object.values(next.edition.references).some(r=>r.kind==='person'&&r.personId==='two'));assert.deepEqual(next.expectedAfter.items.map(i=>i.itemId),read.items.map(i=>i.itemId));assert.throws(()=>planNativeFormPublication({...f,current:read}),e=>e.code==='forms_layout');
});
