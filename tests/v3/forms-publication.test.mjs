import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planNativeFormPublication, formReadFingerprint, retainFormEdition, verifyNativeFormPlan } from '../../.build/v3/apps/google-adapter/src/forms-publication.js';
import { consumeFormsRefresh } from '../../.build/v3/apps/google-adapter/src/forms-refresh.js';
import { commandsFromManagedForm, directoryDraftFromManagedForm, directoryReviewCommand, verifyDirectoryPhoto } from '../../.build/v3/apps/google-adapter/src/forms-intake.js';
const copy=x=>structuredClone(x), signer={sha256:x=>createHash('sha256').update(x).digest('hex'),hmacSha256:()=>''};
const person={personId:'person-one',version:4,lastName:'Example',firstName:'Cadet',asYear:'AS200',rank:'C/SSgt',role:'',university:'School',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'',cipCode:'',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:'',flightId:'alpha',active:true};
function snapshot(){return {contractVersion:1,environment:'local',generation:1,revision:{operations:5,administration:9},people:[copy(person)],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue',rosterVersion:2}],squadrons:[{squadronId:'blue',label:'Blue'}],terms:[{termId:'term-one',isCurrent:true}],events:[{eventId:'event-one',version:3,termId:'term-one',status:'active',eventType:'llab',displayOrder:1,label:'TW-1 LLAB'}],eventFlights:[{eventId:'event-one',flightId:'alpha'}]};}
function fixture(key='attendance'){
 const sources=key==='attendance'?[{kind:'events'},{kind:'flights'},{kind:'people',flightIds:['alpha']}]:key==='excusals'?[{kind:'events'}]:[{kind:'directory',field:'asYear',values:['AS100','AS200']},{kind:'directory',field:'rank',values:['C/SSgt','C/Col']}];
 const binding={key,formId:`form-${key}`,resourceKey:`source-${key}`,expectedTitle:`${key} Staging`,linkedSheetId:'response-book',choices:sources.map((source,i)=>({itemId:`item-${i}`,questionId:`q-${i}`,source}))};
 const current={formId:binding.formId,revisionId:'r1',info:{title:binding.expectedTitle,documentTitle:'Private Form'},settings:{emailCollectionType:'VERIFIED',quizSettings:{isQuiz:false}},linkedSheetId:'response-book',acceptingResponses:true,
 items:[...sources.map((_,i)=>({itemId:`item-${i}`,title:`Existing ${i}`,description:'Keep guidance',questionItem:{question:{questionId:`q-${i}`,required:true,choiceQuestion:{type:i===2?'CHECKBOX':'DROP_DOWN',options:[{value:'old'}]}}}})),{itemId:'fixed-text',title:'Keep me',questionItem:{question:{questionId:'plain',textQuestion:{paragraph:true}}}},{itemId:'existing-section',pageBreakItem:{},title:'Existing section'}]};
 return {binding,current,snapshot:snapshot()};
}
const plan=f=>planNativeFormPublication({...f,signer});
function submit(p,answers){return {formId:p.binding.formId,responseId:'native-response',lastSubmittedTime:'2026-11-06T12:00:00.000Z',respondentEmail:'cadet@example.invalid',verifiedResponder:true,answers};}
const principal=[{email:'cadet@example.invalid',principalId:'cadet',personId:'person-one'}],config={environment:'local',generation:1,baseUrl:'http://localhost',keyId:'fixture'};
const option=(p,n,index=0)=>p.expectedAfter.items[n].questionItem.question.choiceQuestion.options[index].value;

test('Form publication preserves every question ID, response destination, setting and unowned item',()=>{
 const f=fixture(),p=plan(f);assert.equal(p.requests.length,3);assert(p.requests.every(r=>Object.keys(r).join()==='updateItem'));
 for(const r of p.requests)assert.equal(r.updateItem.updateMask,'questionItem.question.choiceQuestion.options');
 assert.deepEqual(p.expectedAfter.items.map(i=>i.itemId),f.current.items.map(i=>i.itemId));assert.deepEqual(p.expectedAfter.items.slice(3),f.current.items.slice(3));
 assert.equal(p.expectedAfter.linkedSheetId,f.current.linkedSheetId);assert.deepEqual(p.expectedAfter.settings,f.current.settings);
 const read=copy(p.expectedAfter);read.revisionId='provider-new';assert(verifyNativeFormPlan(p,read));read.linkedSheetId='other';assert(!verifyNativeFormPlan(p,read));
 const renamed=copy(f);renamed.current.items[0].questionItem.question.questionId='wrong';assert.throws(()=>plan(renamed));
});

test('immutable catalogs retain old event and roster bindings without rebinding labels',()=>{
 const f=fixture(),first=plan(f),old=retainFormEdition({},first.edition);
 const newer=copy(f);newer.snapshot.revision.administration++;newer.snapshot.events[0].version++;newer.snapshot.flights[0].rosterVersion++;newer.snapshot.people[0].lastName='Changed';
 const second=plan(newer),catalog=retainFormEdition(old,second.edition);assert.equal(Object.keys(catalog).length,2);assert.notEqual(option(first,0),option(second,0));
 const command=commandsFromManagedForm({submission:submit(first,{'q-0':option(first,0),'q-1':option(first,1),'q-2':[option(first,2)],complete:'complete'}),binding:{...f.binding,kind:'attendance',events:['q-0'],scope:['q-1'],present:['q-2'],completeness:'complete'},editions:catalog,principals:principal,config,signer})[0];
 assert.equal(command.payload.eventId,'event-one');assert.equal(command.payload.expectedEventVersion,3);assert.equal(command.payload.rosterVersion,2);assert.deepEqual(command.payload.presentPersonIds,['person-one']);
 const bad=copy(first.edition);bad.people.push(person);assert.throws(()=>retainFormEdition(catalog,bad));
});

test('a response cannot mix editions, copy a token to another question, or use typed email as identity',()=>{
 const f=fixture(),p=plan(f),changed=copy(f);changed.snapshot.revision.operations++;changed.snapshot.events[0].version++;const p2=plan(changed),editions=retainFormEdition(retainFormEdition({},p.edition),p2.edition);
 const input={submission:submit(p,{'q-0':option(p,0),'q-1':option(p,1),'q-2':[option(p,2)],complete:'complete'}),binding:{...f.binding,kind:'attendance',events:['q-0'],scope:['q-1'],present:['q-2'],completeness:'complete'},editions,principals:principal,config,signer};
 const mixed={...copy({...input,signer:undefined}),signer};mixed.submission.answers['q-0']=option(p2,0);assert.throws(()=>commandsFromManagedForm(mixed),e=>e.code==='forms_reference');
 const moved={...copy({...input,signer:undefined}),signer};moved.submission.answers['q-0']=option(p,1);assert.throws(()=>commandsFromManagedForm(moved),e=>e.code==='forms_reference');
 const unknown={...copy({...input,signer:undefined}),signer};unknown.submission.respondentEmail='unknown@example.invalid';unknown.submission.answers.email='cadet@example.invalid';assert.throws(()=>commandsFromManagedForm(unknown),e=>e.code==='confirmation_required');
});

test('native response revision and each attendance event deterministically select distinct immutable commands',()=>{
 const f=fixture();f.snapshot.events.push({...f.snapshot.events[0],eventId:'event-two',displayOrder:2});f.snapshot.eventFlights.push({eventId:'event-two',flightId:'alpha'});const p=plan(f);
 const input={submission:submit(p,{'q-0':[option(p,0),option(p,0,1)],'q-1':option(p,1),'q-2':[option(p,2)],complete:'complete'}),binding:{...f.binding,kind:'attendance',events:['q-0'],scope:['q-1'],present:['q-2'],completeness:'complete'},editions:{[p.edition.editionId]:p.edition},principals:principal,config,signer};
 const first=commandsFromManagedForm(input);assert.equal(new Set(first.map(c=>c.source.submissionId)).size,2);assert.deepEqual(commandsFromManagedForm(input),first);
 const reorder={...copy({...input,signer:undefined}),signer};reorder.submission.answers['q-0'].reverse();assert.deepEqual(commandsFromManagedForm(reorder).sort((a,b)=>a.commandId.localeCompare(b.commandId)),copy(first).sort((a,b)=>a.commandId.localeCompare(b.commandId)));
 const edit={...copy({...input,signer:undefined}),signer};edit.submission.lastSubmittedTime='2026-11-06T12:01:00.000Z';const next=commandsFromManagedForm(edit);assert.notEqual(next[0].commandId,first[0].commandId);assert.equal(next[0].source.submissionId,first[0].source.submissionId);
});

test('Directory self-service preserves operational fields as proposals and retains new enrollment for review',()=>{
 const f=fixture('directory'),p=plan(f),input={submission:submit(p,{'q-0':option(p,0,1),'q-1':option(p,1,1),phone:'555-555-0101',flight:'bravo',email:'spoof@example.invalid'}),binding:{...f.binding,kind:'directory',directoryFields:{asYear:'q-0',rank:'q-1',phone:'phone',flightId:'flight',email:'email'}},editions:{[p.edition.editionId]:p.edition},principals:principal,config,signer};
 const draft=directoryDraftFromManagedForm(input);assert.equal(draft.status,'pending-review');assert.deepEqual(draft.proposedFields,['rank','flightId']);assert.deepEqual(draft.command.payload.changes,{phone:'555-555-0101'});assert.equal(draft.command.payload.expectedVersion,4);assert(!('email'in draft.submitted));
 const pending=directoryDraftFromManagedForm({...input,principals:[]});assert.equal(pending.status,'pending-review');assert.equal(pending.command,undefined);assert.equal(pending.source.respondentEmail,'cadet@example.invalid');
 const review={draft:pending,reviewerPrincipalId:'manager',authenticatedReviewer:true,reviewId:'review-one',resourceKey:'review-sheet',personId:'new-person',expectedVersion:0,flightId:'alpha',profile:Object.fromEntries(Object.entries(person).filter(([k])=>!['personId','version','flightId','active'].includes(k))),config,signer};
 assert.equal(directoryReviewCommand(review).operation,'directory.upsert');assert.throws(()=>directoryReviewCommand({...review,authenticatedReviewer:false}));
});

test('photo synchronization reads the actual image identity and preserves URI without sharing or names',()=>{
 const uri='https://drive.google.com/file/d/fictional-photo/view?resourcekey=private-fixture';let calls=0;
 const originalURL=globalThis.URL;try{globalThis.URL=undefined;assert.equal(verifyDirectoryPhoto(uri,(id,key)=>{calls++;assert.equal(key,'private-fixture');assert.equal(id,'fictional-photo');return{id,mimeType:'image/jpeg'};}),uri);}finally{globalThis.URL=originalURL;}
 assert.equal(calls,1);assert.equal(verifyDirectoryPhoto('',()=>assert.fail()),'');
 for(const bad of ['https://example.invalid/photo','https://drive.google.com@evil.invalid/file/d/id/view','javascript:alert(1)'])assert.throws(()=>verifyDirectoryPhoto(bad,()=>assert.fail()));
 assert.throws(()=>verifyDirectoryPhoto(uri,id=>({id,mimeType:'application/pdf'})));assert.throws(()=>verifyDirectoryPhoto(uri,id=>({id,mimeType:'image/jpeg',trashed:true})));
});

function runtimeFixture(){
 const base=[fixture('attendance'),fixture('excusals'),fixture('directory')],books=Object.fromEntries(base.map(f=>[f.binding.key,copy(f.current)]));
 const fx={state:{version:1,environment:'local',generation:1,editions:{},current:{}},writes:[],saved:[],ack:0,paused:0,locked:false,failKey:null,failAfter:false};
 const claim={effectId:'effect-one',claimToken:'claim-one',kind:'forms.refresh',leaseExpiresAt:'2026-11-06T12:10:00.000Z'};
 const io={config,enabled:()=>true,intakeEnabled:()=>true,now:()=>Date.parse('2026-11-06T12:00:00.000Z'),signer,bindings:base.map(f=>f.binding),lock:{tryLock:()=>{fx.locked=true;return true;},releaseLock:()=>{fx.locked=false;}},assertIsolation:()=>{},
 state:{load:()=>copy(fx.state),save:s=>{fx.state=copy(s);fx.saved.push(copy(s));}},effects:{claim:()=>copy(claim),project:()=>({effect:{effectId:claim.effectId,kind:claim.kind},snapshot:snapshot()}),ack:()=>{fx.ack++;}},
 forms:{read:b=>copy(books[b.key]),setAccepting:(b,enabled)=>{books[b.key].acceptingResponses=enabled;},write:(b,requests,revision)=>{assert(fx.state.pending);assert.equal(books[b.key].acceptingResponses,false);assert.equal(books[b.key].revisionId,revision);fx.writes.push(b.key);if(fx.failKey===b.key&&!fx.failAfter)throw Error('provider unavailable');for(const r of requests){const x=r.updateItem;books[b.key].items[x.location.index].questionItem.question.choiceQuestion.options=copy(x.item.questionItem.question.choiceQuestion.options);}books[b.key].revisionId+='x';if(fx.failKey===b.key&&fx.failAfter)throw Error('response lost');}},pause:()=>{fx.paused++;}};
 return{fx,io,books};
}

test('durable three-Form publication freezes catalogs first and ACKs only all verified destinations',()=>{
 const{fx,io,books}=runtimeFixture();assert.deepEqual(consumeFormsRefresh(io),{status:'published',forms:3});assert.equal(fx.ack,1);assert.equal(Object.keys(fx.state.current).length,3);assert.equal(Object.keys(fx.state.editions).length,3);assert.equal(fx.state.pending,undefined);assert(Object.values(books).every(b=>b.acceptingResponses));assert(!fx.locked);
});

test('partial and ambiguous Form writes retain all fences and retry only unfinished native work',()=>{
 for(const failAfter of[false,true]){const{fx,io,books}=runtimeFixture();fx.failKey='excusals';fx.failAfter=failAfter;assert.throws(()=>consumeFormsRefresh(io));assert.equal(fx.ack,0);assert(fx.state.pending);assert(Object.values(books).every(b=>!b.acceptingResponses));const saved=copy(fx.state.pending);fx.failKey=null;io.effects.project=()=>assert.fail('must use frozen plans');assert.equal(consumeFormsRefresh(io).status,'published');assert.equal(fx.writes.filter(k=>k==='attendance').length,1);assert.equal(fx.writes.filter(k=>k==='excusals').length,failAfter?1:2);assert.equal(fx.ack,1);assert.equal(saved.plans.length,3);}
});

test('an unexplained Form edit or expired claim cannot be replayed or acknowledged',()=>{
 const{fx,io,books}=runtimeFixture();fx.failKey='excusals';assert.throws(()=>consumeFormsRefresh(io));fx.failKey=null;books.directory.items[0].title='Unreviewed';assert.throws(()=>consumeFormsRefresh(io),e=>e.code==='forms_changed');assert.equal(fx.ack,0);assert(Object.values(books).every(b=>!b.acceptingResponses));
 const other=runtimeFixture();other.fx.failKey='excusals';assert.throws(()=>consumeFormsRefresh(other.io));other.io.now=()=>Date.parse('2026-11-06T13:00:00.000Z');assert.throws(()=>consumeFormsRefresh(other.io),e=>e.code==='forms_lease');assert.equal(other.fx.ack,0);
});

test('lost ACK retains completion and refuses to reopen a subsequently changed Form',()=>{
 const{fx,io,books}=runtimeFixture();io.effects.ack=()=>{throw Error('network lost');};assert.throws(()=>consumeFormsRefresh(io));assert(fx.state.completed);const writes=fx.writes.length;io.effects.project=()=>assert.fail();io.effects.ack=()=>{fx.ack++;};books.attendance.items[3].title='Later independent edit';assert.throws(()=>consumeFormsRefresh(io),e=>e.code==='forms_changed');assert.equal(fx.writes.length,writes);assert.equal(fx.ack,0);assert.equal(books.attendance.items[3].title,'Later independent edit');
});

test('verified new Directory respondents activate from bound Flight and AS year without self-granted authority',()=>{
 const f=fixture('directory');f.binding.choices.push({itemId:'flight-item',questionId:'flight',source:{kind:'flights'}});f.current.items.push({itemId:'flight-item',questionItem:{question:{questionId:'flight',choiceQuestion:{type:'DROP_DOWN',options:[{value:'old'}]}}}});
 f.snapshot.people=[];const p=plan(f),flight=p.expectedAfter.items.at(-1).questionItem.question.choiceQuestion.options[0].value;
 const input={submission:submit(p,{'q-0':option(p,0),'q-1':option(p,1,1),flight,first:'New',last:'Cadet',email:'spoof@example.invalid'}),binding:{...f.binding,kind:'directory',directoryFields:{asYear:'q-0',rank:'q-1',flightId:'flight',firstName:'first',lastName:'last',email:'email'}},editions:{[p.edition.editionId]:p.edition},principals:[],config,signer};
 const d=directoryDraftFromManagedForm(input);assert.equal(d.command.operation,'directory.enroll');assert.equal(d.command.actor.principalId,`google.${signer.sha256('cadet@example.invalid')}`);assert.equal(d.command.payload.profile.email,'cadet@example.invalid');assert.equal(d.command.payload.profile.rank,'C/AB');assert.equal(d.command.payload.profile.role,'');assert.equal(d.command.payload.profile.flightPathStatus,'Active 3/4');assert.equal(d.command.payload.flightId,'alpha');assert.deepEqual(d.proposedFields,['rank']);
 const raw={...input,submission:copy(input.submission)};raw.submission.answers.flight='alpha';assert.equal(directoryDraftFromManagedForm(raw).command,undefined);
});

test('native branch destinations cannot silently disappear during catalog publication',()=>{
 const f=fixture();f.current.items[0].questionItem.question.choiceQuestion.options[0].goToSectionId='existing-section';assert.throws(()=>plan(f));f.binding.choices[0].navigation={'event-one':{goToSectionId:'existing-section'}};const p=plan(f);assert.equal(p.expectedAfter.items[0].questionItem.question.choiceQuestion.options[0].goToSectionId,'existing-section');
});


test('unrelated attendance revisions neither grow retained Form catalogs nor rewrite choices',()=>{
 const f=fixture(),first=plan(f),next={...f,current:copy(first.expectedAfter),snapshot:copy(f.snapshot)};next.snapshot.revision.operations+=100;
 const second=plan(next);assert.equal(second.edition.editionId,first.edition.editionId);assert.equal(second.requests.length,0);assert.equal(Object.keys(retainFormEdition(retainFormEdition({},first.edition),second.edition)).length,1);
});

test('legacy crosstown and Secondary branches retain separate per-Flight and per-event attendance scopes',()=>{
 const f=fixture();f.snapshot.people.push({...person,personId:'person-two',flightId:'bravo',lastName:'Second',university:'Trine'});f.snapshot.people[0].university='Trine';f.snapshot.flights.push({flightId:'bravo',label:'Bravo',squadronId:'gold',rosterVersion:8});
 f.snapshot.events.push({...f.snapshot.events[0],eventId:'secondary',eventType:'secondary',displayOrder:2,label:'Secondary'});f.binding.choices[0].source={kind:'events',types:['llab']};f.binding.choices[1].source={kind:'profiles',profiles:[{key:'trine',label:'Trine',filter:{universities:['Trine']}}]};f.binding.choices[2].source={kind:'people',universities:['Trine']};
 f.binding.choices.push({itemId:'event-secondary',questionId:'secondary-q',source:{kind:'events',types:['secondary']}},{itemId:'people-secondary',questionId:'secondary-p',source:{kind:'people',flightIds:['alpha']}});f.current.items.push({itemId:'event-secondary',questionItem:{question:{questionId:'secondary-q',choiceQuestion:{type:'DROP_DOWN',options:[{value:'old'}]}}}},{itemId:'people-secondary',questionItem:{question:{questionId:'secondary-p',choiceQuestion:{type:'CHECKBOX',options:[{value:'old'}]}}}});f.binding.attendanceProfiles={secondary:{flightIds:['alpha','bravo']}};
 const p=plan(f),get=(q,i=0)=>p.expectedAfter.items.find(x=>x.questionItem?.question.questionId===q).questionItem.question.choiceQuestion.options[i].value;
 const input={submission:submit(p,{'q-0':get('q-0'),'q-1':get('q-1'),'q-2':[get('q-2',1)],'secondary-q':get('secondary-q'),'secondary-p':[get('secondary-p')]}),binding:{...f.binding,kind:'attendance',events:['q-0','secondary-q'],attendanceRules:[{eventQuestions:['q-0'],scopeQuestions:['q-1'],presentQuestions:['q-2'],completeness:'partial'},{eventQuestions:['secondary-q'],presentQuestions:['secondary-p'],implicitProfile:'secondary',completeness:'partial'}]},editions:{[p.edition.editionId]:p.edition},principals:principal,config,signer};
 const cmds=commandsFromManagedForm(input);assert.equal(cmds.length,4);assert.equal(new Set(cmds.map(c=>c.commandId)).size,4);assert(cmds.every(c=>c.payload.completeness==='partial'));assert.deepEqual(cmds.find(c=>c.payload.eventId==='event-one'&&c.payload.unitId==='bravo').payload.presentPersonIds,['person-two']);assert.deepEqual(cmds.find(c=>c.payload.eventId==='secondary'&&c.payload.unitId==='alpha').payload.presentPersonIds,['person-one']);assert.deepEqual(cmds.find(c=>c.payload.eventId==='secondary'&&c.payload.unitId==='bravo').payload.presentPersonIds,[]);
 const invalid={...input,submission:copy(input.submission)};invalid.submission.answers['secondary-p']=[get('q-2',1)];assert.throws(()=>commandsFromManagedForm(invalid),e=>e.code==='forms_reference');
});

test('category routing and a bound default section handle new events without rebuilding native questions',()=>{
 const f=fixture();f.binding.choices[0].navigationDefault={goToSectionId:'existing-section'};f.binding.choices.push({itemId:'category',questionId:'category-q',source:{kind:'categories',categories:[{key:'llab',label:'LLAB',types:['llab']},{key:'secondary',label:'Secondary',types:['secondary']}]},navigation:{llab:{goToSectionId:'existing-section'},secondary:{goToSectionId:'existing-section'}}});f.current.items.push({itemId:'category',questionItem:{question:{questionId:'category-q',choiceQuestion:{type:'RADIO',options:[{value:'old',goToSectionId:'existing-section'}]}}}});
 const p=plan(f);assert.equal(p.expectedAfter.items.at(-1).questionItem.question.choiceQuestion.options.length,1);f.snapshot.events.push({...f.snapshot.events[0],eventId:'new-event'});assert.equal(plan(f).expectedAfter.items[0].questionItem.question.choiceQuestion.options.length,2);
});


test('Google response timestamps retain native fractional precision without requiring millisecond formatting',()=>{
 const f=fixture(),p=plan(f),input={submission:submit(p,{'q-0':option(p,0),'q-1':option(p,1),'q-2':[option(p,2)],complete:'complete'}),binding:{...f.binding,kind:'attendance',events:['q-0'],scope:['q-1'],present:['q-2'],completeness:'complete'},editions:{[p.edition.editionId]:p.edition},principals:principal,config,signer};
 for(const stamp of ['2026-11-06T12:00:00Z','2026-11-06T12:00:00.123456Z','2026-11-06T12:00:00.123456789Z']){input.submission.lastSubmittedTime=stamp;assert.equal(commandsFromManagedForm(input)[0].source.revision,Date.parse(stamp));}
 const first=commandsFromManagedForm(input)[0];input.submission.lastSubmittedTime='2026-11-06T12:00:00.123456788Z';const second=commandsFromManagedForm(input)[0];assert.notEqual(first.commandId,second.commandId);assert.equal(first.source.revision,second.source.revision,'sub-millisecond collisions must conflict at backend source dedup, never silently replay');
});
