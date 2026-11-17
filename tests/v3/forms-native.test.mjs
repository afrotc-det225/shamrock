import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createNativeFormsRuntime,FORMS_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/forms-native.js';
import {HOST_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/staging-host.js';
import {FRONTEND_SECTIONS,FRONTEND_PAGE_VERSION} from '../../.build/v3/packages/domain/src/frontend-transport.js';
const clone=x=>structuredClone(x),hash=x=>createHash('sha256').update(x).digest('hex'),owner='automation@example.invalid',secret='fictional-bridge-key-with-at-least-32-characters';
function fixture(){
 const fx={log:[],files:{},forms:{},open:{},triggers:[],responses:{},claim:true,failWrite:false,commands:[]};
 const config={version:1,environment:'staging',generation:1,enabled:true,intakeEnabled:true,resourceReview:'EXISTING_FORMS_REVIEWED_FOR_STAGING',principalId:'publisher',workerId:'worker',stateFileId:'state-file',intakeFileId:'intake-file',reviewResourceKey:'review',principals:[{email:'manager@example.invalid',principalId:'manager'}],forms:[]};
 for(const key of ['attendance','excusals','directory']){
  const sources=key==='directory'?[{kind:'directory',field:'asYear',values:['AS100']},{kind:'flights'}]:[{kind:'events'}];
  const binding={key,formId:`form-${key}`,resourceKey:`source-${key}`,expectedTitle:`${key} Staging`,allowedEditors:[],choices:sources.map((source,i)=>({itemId:`item-${i}`,questionId:`q-${i}`,source})),intake:{kind:key,formId:`form-${key}`,resourceKey:`source-${key}`,...(key==='directory'?{directoryFields:{asYear:'q-0',flightId:'q-1',firstName:'first',lastName:'last',photoLink:'photo'}}:{events:['q-0'],outcome:'outcome',reason:'reason'})}};
  config.forms.push(binding);fx.forms[binding.formId]={formId:binding.formId,revisionId:'r1',info:{title:binding.expectedTitle},settings:{emailCollectionType:'VERIFIED'},items:[...sources.map((_,i)=>({itemId:`item-${i}`,questionItem:{question:{questionId:`q-${i}`,required:true,choiceQuestion:{type:'DROP_DOWN',options:[{value:'old'}]}}}})),...['first','last','photo','outcome','reason'].map(id=>({itemId:id,questionItem:{question:{questionId:id,textQuestion:{}}}}))]};fx.open[binding.formId]=false;
  fx.files[binding.formId]={id:binding.formId,name:binding.expectedTitle,mimeType:'application/vnd.google-apps.form'};
 }
 const state={version:1,environment:'staging',generation:1,editions:{},current:{}},intake={version:1,environment:'staging',generation:1,entries:{}};
 for(const[id,value]of[['state-file',state],['intake-file',intake],['config-file',config],['root-config',{[FORMS_PROPERTIES.config]:JSON.stringify({version:1,configFileId:'config-file'})}]])fx.files[id]={id,name:id,mimeType:'application/json',value,version:1};
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'legacy-journal',sheetId:1},attendance:{formId:'legacy-attendance',resourceKey:'legacy',itemRoles:{event:'event',scope:'scope',present:['present'],completeness:'complete'}}};
 const values={[HOST_PROPERTIES.config]:JSON.stringify(host),[HOST_PROPERTIES.secret]:secret,[HOST_PROPERTIES.enabled]:'false',SHAMROCK_V3_CONFIG_FILE_ID:'root-config'};
 const props={getProperty:k=>values[k]??null,setProperty:(k,v)=>{values[k]=v;}};
 const snapshot={contractVersion:1,environment:'staging',generation:1,revision:{administration:1,operations:1},people:[],flights:[{flightId:'alpha',label:'Alpha',rosterVersion:1}],terms:[{termId:'term',isCurrent:true}],events:[{eventId:'event',version:1,termId:'term',status:'active',displayOrder:1,eventType:'llab',label:'LLAB'}],eventFlights:[{eventId:'event',flightId:'alpha'}]};
 const claim={effectId:'effect',claimToken:'token',kind:'forms.refresh',leaseExpiresAt:'2026-11-06T12:10:00.000Z'};
 const response=(v,status=200)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(v)});
 const services={PropertiesService:{getScriptProperties:()=>props},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()],getUuid:()=>''},Session:{getEffectiveUser:()=>({getEmail:()=>owner}),getActiveUser:()=>({getEmail:()=> 'manager@example.invalid'})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},now:()=>Date.parse('2026-11-06T12:00:00.000Z'),FormApp:{openById:id=>({isAcceptingResponses:()=>fx.open[id],setAcceptingResponses:open=>{fx.open[id]=open;fx.forms[id].revisionId+='s';}})},ScriptApp:{getOAuthToken:()=> 'fictional-oauth',EventType:{ON_FORM_SUBMIT:'submit'},TriggerSource:{FORMS:'forms'},getProjectTriggers:()=>fx.triggers,deleteTrigger:t=>{fx.triggers=fx.triggers.filter(x=>x!==t);},newTrigger:handler=>({forForm:id=>({onFormSubmit:()=>({create:()=>{const uid=`trigger-${fx.triggers.length}`;const t={getUniqueId:()=>uid,getHandlerFunction:()=>handler,getTriggerSourceId:()=>id,getEventType:()=> 'submit',getTriggerSource:()=> 'forms'};fx.triggers.push(t);return t;}})})})},UrlFetchApp:{fetch:(url,options)=>{
  fx.log.push({url,method:options.method});const u=new URL(url),body=options.payload?JSON.parse(options.payload):undefined;
  if(u.host==='worker.example.invalid'){
   const path=u.pathname;assert.equal(options.headers['x-shamrock-signature'],createHmac('sha256',secret).update(`POST\n${path}\n${options.headers['x-shamrock-timestamp']}\n${hash(options.payload)}`).digest('hex'));
   if(path.endsWith('/claim'))return response({effect:fx.claim?clone(claim):null});
   if(path.endsWith('/project/page')){const data=Object.fromEntries(FRONTEND_SECTIONS.map(s=>[s,snapshot[s]??[]]));data.people=data.people.map(p=>({role:'Cadet',flightPathStatus:'Active',version:1,...p}));data.events=data.events.map(e=>({...e,hasRoster:Array.isArray(e.eligiblePersonIds)?1:0}));data.eventRosters=snapshot.events.flatMap(e=>(e.eligiblePersonIds??[]).map(personId=>({eventId:e.eventId,personId})));
    const shared={contractVersion:FRONTEND_PAGE_VERSION,section:body.section,revision:snapshot.revision},effect={effectId:'effect',kind:'forms.refresh'};
    return response(body.section==='manifest'?{...shared,environment:'staging',generation:1,effect,sections:FRONTEND_SECTIONS.map(section=>({section,count:data[section].length})),diagnostics:[]}:body.section==='verify'?{...shared,verified:true,effect}:{...shared,offset:0,rows:data[body.section],nextOffset:null});}
   if(path.endsWith('/ack')){assert(Object.values(fx.forms).every(f=>f.items[0].questionItem.question.choiceQuestion.options[0].value.includes('[sr:')));fx.claim=false;return response({acknowledged:true});}
   if(path.endsWith('/review-authorize'))return response({authorized:true});
   if(path==='/v1/admin/commands'){
    const entry=Object.values(fx.files['intake-file'].value.entries).find(e=>e.commands.some(c=>c.command.commandId===body.commandId));assert(entry,'command must be durably journaled before dispatch');fx.commands.push(clone(body));return response({commandId:body.commandId,status:'committed',operation:body.operation,result:{targetId:'person-enrolled',version:1}});
   }
   if(path==='/v1/commands'){fx.commands.push(clone(body));return response({commandId:body.commandId,status:'committed',operation:body.operation,result:{}});}
   assert.fail(path);
  }
  assert.equal(options.headers.Authorization,'Bearer fictional-oauth');
  if(u.host==='forms.googleapis.com'){
   const id=u.pathname.split('/')[3].replace(':batchUpdate','');
   if(u.pathname.includes('/responses/'))return response(fx.responses[id]);
   if(u.pathname.endsWith(':batchUpdate')){assert(fx.files['state-file'].value.pending);assert.equal(fx.open[id],false);assert.equal(body.writeControl.requiredRevisionId,fx.forms[id].revisionId);for(const r of body.requests){if(r.createItem){const{item,location}=r.createItem;fx.forms[id].items.splice(location.index,0,clone(item));if(item.pageBreakItem)(fx.nativeNavigation??={})[item.itemId]='CONTINUE';continue;}assert.equal(r.updateItem.updateMask,'questionItem.question.choiceQuestion.options');fx.forms[id].items[r.updateItem.location.index].questionItem.question.choiceQuestion.options=clone(r.updateItem.item.questionItem.question.choiceQuestion.options);}fx.forms[id].revisionId+='b';return response({});}
   return response(clone(fx.forms[id]));
  }
  const id=u.pathname.split('/').at(-1),file=fx.files[id];assert(file,`unknown file ${id}`);
  if(options.method==='patch'){if(fx.failWrite)return response({},503);file.value=clone(body);file.version++;return response({id,version:String(file.version)});}
  if(u.searchParams.get('alt')==='media')return response(clone(file.value));
  return response({id:file.id,name:file.name,mimeType:file.mimeType,size:JSON.stringify(file.value??{}).length,version:String(file.version??1),owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner}]});
 }}};
 return{fx,config,values,services,snapshot,runtime:createNativeFormsRuntime(services)};
}

test('native host uses owner-only Drive fallback/checkpoints and fresh Form revisions with idempotent trigger setup',()=>{
 const f=fixture();assert.deepEqual(f.runtime.setup(),{status:'ready-paused',triggers:3});f.runtime.setup();assert.equal(f.fx.triggers.length,3);f.runtime.resumePublication();assert.equal(f.runtime.refresh().status,'published');assert(!f.fx.claim);assert.equal(Object.keys(f.fx.files['state-file'].value.editions).length,3);assert(Object.values(f.fx.open).every(x=>!x));assert.equal(f.runtime.resumeIntake().status,'intake-enabled');assert(Object.values(f.fx.open).every(Boolean));f.runtime.pause();assert(Object.values(f.fx.open).every(x=>!x));
});

test('native failed private checkpoint cannot publish new choices or acknowledge a lease',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resumePublication();f.fx.failWrite=true;assert.throws(()=>f.runtime.refresh(),e=>e.code==='forms_google');assert.equal(f.fx.log.filter(x=>x.url.endsWith(':batchUpdate')).length,0);assert(f.fx.claim);assert(Object.values(f.fx.open).every(x=>!x));assert.equal(f.values[FORMS_PROPERTIES.pause],'true');
});

test('native Directory response is reread by ID, activated, journaled and linked for later self excusals',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resumePublication();f.runtime.refresh();f.runtime.resumeIntake();const options=id=>f.fx.forms['form-directory'].items.find(i=>i.questionItem?.question.questionId===id).questionItem.question.choiceQuestion.options[0].value;
 f.fx.responses['form-directory']={responseId:'response',lastSubmittedTime:'2026-11-06T12:00:00.000Z',respondentEmail:'new@example.invalid',answers:Object.fromEntries(Object.entries({'q-0':options('q-0'),'q-1':options('q-1'),first:'New',last:'Cadet'}).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 const result=f.runtime.replay('directory','response');assert.equal(result.status,'committed');assert.equal(f.fx.commands.length,1);assert.equal(f.fx.commands[0].operation,'directory.enroll');assert.equal(f.fx.commands[0].payload.profile.email,'new@example.invalid');assert.equal(f.fx.files['intake-file'].value.enrollments['new@example.invalid'].personId,'person-enrolled');assert.deepEqual(f.runtime.replay('directory','response'),result);assert.equal(f.fx.commands.length,1);
 const event=f.fx.forms['form-excusals'].items[0].questionItem.question.choiceQuestion.options[0].value;
 f.fx.responses['form-excusals']={responseId:'excusal-response',lastSubmittedTime:'2026-11-06T12:01:00.000Z',respondentEmail:'new@example.invalid',answers:Object.fromEntries(Object.entries({'q-0':event,outcome:'E',reason:'Fictional reason'}).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 assert.equal(f.runtime.replay('excusals','excusal-response').status,'committed');assert.equal(f.fx.commands[1].payload.personId,'person-enrolled');assert.equal(f.fx.commands[1].actor.principalId,`google.${hash('new@example.invalid')}`);
});

const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function control(f,action,sequence){f.config.controlRequest={requestId:`review-${sequence}`,sequence,action,stateSha256:hash(canonical(f.fx.files['state-file'].value)),intakeSha256:hash(canonical(f.fx.files['intake-file'].value))};}
test('private reviewed control requests set up and resume Forms once without overriding a later pause',()=>{
 const f=fixture();f.config.enabled=false;f.config.intakeEnabled=false;control(f,'setup',1);assert.equal(f.runtime.refresh().status,'disabled');assert.equal(f.fx.triggers.length,3);
 f.config.enabled=true;control(f,'resume-publication',2);assert.equal(f.runtime.refresh().status,'published');f.runtime.pause();assert.equal(f.runtime.refresh().status,'disabled');assert.equal(f.fx.triggers.length,3);
 f.config.controlRequest.sequence=1;assert.throws(()=>f.runtime.refresh(),{code:'forms_control'});
});
test('private control refuses changed checkpoints before installing triggers or opening Forms',()=>{
 const f=fixture();control(f,'setup',1);f.fx.files['intake-file'].value.entries.changed={};assert.throws(()=>f.runtime.refresh(),{code:'forms_control'});assert.equal(f.fx.triggers.length,0);assert(Object.values(f.fx.open).every(x=>!x));
});

test('native additive layout creates stable cohorts and verifies new Submit continuations through FormApp',()=>{
 const f=fixture(),binding=f.config.forms[0],form=f.fx.forms[binding.formId];
 const q=(id,type)=>({itemId:`i-${id}`,title:id,questionItem:{question:{questionId:id,choiceQuestion:{type,options:[{value:'old'}]}}}});
 for(const[id,source]of[['mando-scope',{kind:'profiles',profiles:[]}],['llab-scope',{kind:'flights'}]]){form.items.push(q(id,'RADIO'));binding.choices.push({itemId:`i-${id}`,questionId:id,source});}
 f.fx.nativeNavigation={};for(const branch of['mando','llab','secondary','other','trine']){const id=`page-${branch}`;form.items.push({itemId:id,title:id,pageBreakItem:{}});f.fx.nativeNavigation[id]='SUBMIT';if(branch==='mando'){form.items.push(q('template','CHECKBOX'));binding.choices.push({itemId:'i-template',questionId:'template',source:{kind:'people',flightIds:['alpha'],asYears:['AS100']}});}}
 binding.attendanceLayout={version:1,review:'OPTIONAL_UNVALIDATED_CHECKBOX_AND_SUBMIT_SECTIONS_REVIEWED',questionTemplateItemId:'i-template',sectionTemplateItemId:'page-mando',excludedFlightLabels:['Abroad'],mando:{scopeQuestionId:'mando-scope',eventQuestions:[],flights:[{flightId:'alpha',sectionId:'page-mando'}],crosstown:[{key:'trine',label:'Trine',universities:['Trine'],sectionId:'page-trine'}]},llab:{scopeQuestionId:'llab-scope',eventQuestions:['q-0'],flights:[{flightId:'alpha',sectionId:'page-llab'}]},secondary:{sectionId:'page-secondary',eventQuestions:[]},other:{sectionId:'page-other',eventQuestions:[]}};
 f.snapshot.people=[{personId:'alpha-one',firstName:'One',lastName:'Example',flightId:'alpha',asYear:'AS100',university:'Notre Dame',active:true},{personId:'bravo-one',firstName:'Two',lastName:'Example',flightId:'bravo',asYear:'AS200',university:'Notre Dame',active:true}];f.snapshot.flights.push({flightId:'bravo',label:'Bravo',rosterVersion:1});
 const open=f.services.FormApp.openById;let changes=0;
 f.services.FormApp.PageNavigationType={SUBMIT:'SUBMIT'};
 f.services.FormApp.openById=id=>({...open(id),getItems:()=>f.fx.forms[id].items.map((item,index)=>({getIndex:()=>index,getTitle:()=>item.title??'',getType:()=>item.pageBreakItem?'PAGE_BREAK':item.questionItem?.question?.choiceQuestion?.type==='CHECKBOX'?'CHECKBOX':'TEXT',asCheckboxItem:()=>({isRequired:()=>Boolean(item.questionItem?.question?.required),hasOtherOption:()=>false}),asPageBreakItem:()=>({getPageNavigationType:()=>f.fx.nativeNavigation[item.itemId],setGoToPage:value=>{assert.equal(f.fx.open[id],false);assert(f.fx.files['state-file'].value.pending);f.fx.nativeNavigation[item.itemId]=value;f.fx.forms[id].revisionId+='n';changes++;}})}))});
 f.runtime.setup();f.runtime.resumePublication();assert.equal(f.runtime.refresh().status,'published');assert.equal(changes,2);assert.equal(f.fx.claim,false);assert(Object.values(f.fx.nativeNavigation).every(x=>x==='SUBMIT'));const state=f.fx.files['state-file'].value;assert.equal(Object.values(state.editions).find(e=>e.formId===binding.formId).attendanceRules.length,4);
});

function pendingFixture(kind='excusals'){
 const f=fixture(),binding=f.config.forms.find(b=>b.key===kind),form=f.fx.forms[binding.formId];
 if(kind==='attendance'){
  binding.intake.scope=['scope'];binding.intake.present=['present'];binding.intake.completeness='complete';
  for(const [questionId,source,type] of [['scope',{kind:'flights'},'RADIO'],['present',{kind:'people'},'CHECKBOX']]){
   binding.choices.push({itemId:`i-${questionId}`,questionId,source});form.items.push({itemId:`i-${questionId}`,questionItem:{question:{questionId,choiceQuestion:{type,options:[{value:'old'}]}}}});
  }
  form.items.push({itemId:'complete',questionItem:{question:{questionId:'complete',textQuestion:{}}}});
  f.snapshot.people=[{personId:'cadet-one',firstName:'One',lastName:'Example',flightId:'alpha',asYear:'AS100',active:true}];
 }
 f.runtime.setup();f.runtime.resumePublication();f.runtime.refresh();f.runtime.resumeIntake();
 const choice=q=>form.items.find(i=>i.questionItem?.question.questionId===q).questionItem.question.choiceQuestion.options[0].value;
 const answers=kind==='excusals'?{'q-0':choice('q-0'),outcome:'E',reason:'Fictional reason'}:{'q-0':choice('q-0'),scope:choice('scope'),present:[choice('present')],complete:'complete'};
 f.fx.responses[binding.formId]={responseId:'held-response',lastSubmittedTime:'2026-11-06T12:01:00.000Z',respondentEmail:'cadet@example.invalid',answers:Object.fromEntries(Object.entries(answers).map(([questionId,v])=>[questionId,{questionId,textAnswers:{answers:(Array.isArray(v)?v:[v]).map(value=>({value}))}}]))};
 const held=f.runtime.replay(kind,'held-response');assert.equal(held.status,'pending-review');assert.equal(f.fx.commands.length,0);
 f.services.Session.getActiveUser=()=>({getEmail:()=>owner});
 f.config.principals.push({email:'cadet@example.invalid',principalId:'cadet',personId:'cadet-one'});
 f.intakeId=held.intakeId;f.binding=binding;return f;
}
function replayReview(f,reviewId='review-one'){
 const e=f.runtime.pendingReplayQueue().find(e=>e.id===f.intakeId);assert(e);
 return {intakeId:e.id,reviewId,sourceHash:e.sourceHash,entryHash:e.entryHash,bindingHash:e.bindingHash,principalHash:e.principalHash,reason:'Verified original responder enrollment and retained Form binding.'};
}
test('reviewed pending Attendance and Excusal replay preserves original source, issue and actor and only queues exact commands',()=>{
 for(const kind of ['attendance','excusals']){
  const f=pendingFixture(kind),original=clone(f.fx.files['intake-file'].value.entries[f.intakeId]),request=replayReview(f);
  const result=f.runtime.reviewReplay(request);assert.equal(result.status,'queued');assert.equal(f.fx.commands.length,0);
  const e=f.fx.files['intake-file'].value.entries[f.intakeId];assert.deepEqual(e.source,original.source);assert.equal(e.sourceHash,original.sourceHash);assert.equal(e.reviews.length,1);assert.equal(e.reviews[0].previousIssue,'confirmation_required');assert.equal(e.reviews[0].reviewedBy.kind,'active-account');
  assert.equal(e.commands[0].command.actor.principalId,'cadet');assert.equal(e.commands[0].command.actor.evidence,'google-form');assert.equal(e.commands[0].command.payload.expectedEventVersion??e.commands[0].command.payload.events[0].expectedEventVersion,1);
  assert.equal(f.runtime.reviewReplay(request).replayed,true);assert.equal(f.fx.commands.length,0);assert.equal(f.runtime.flush().attempted,1);assert.equal(f.fx.commands.length,1);assert.equal(f.runtime.reviewReplay(request).status,'committed');assert.equal(f.fx.commands.length,1);
  assert.throws(()=>f.runtime.reviewReplay({...request,reason:'Changed instructions'}),e=>e.code==='forms_review');
 }
});
test('review rejects missing active identity, changed native response, changed binding and any prepared command',()=>{
 const f=pendingFixture(),request=replayReview(f);f.services.Session.getActiveUser=()=>({getEmail:()=>''});assert.throws(()=>f.runtime.reviewReplay(request),e=>e.code==='confirmation_required');
 f.services.Session.getActiveUser=()=>({getEmail:()=>owner});f.fx.responses['form-excusals'].answers.reason.textAnswers.answers[0].value='Changed native response';assert.throws(()=>f.runtime.reviewReplay(request),e=>e.code==='forms_revision');assert.equal(f.fx.commands.length,0);
 const g=pendingFixture(),r=replayReview(g);g.binding.intake.reason='changed';assert.throws(()=>g.runtime.reviewReplay(r),e=>e.code==='forms_revision');
 const h=pendingFixture(),q=replayReview(h);h.fx.files['intake-file'].value.entries[h.intakeId].commands=[{status:'queued',command:{commandId:'ambiguous'},path:'/v1/commands'}];assert.throws(()=>h.runtime.reviewReplay(q),e=>e.code==='forms_review');assert.equal(h.fx.commands.length,0);
});
test('unresolved interpretation stays pending and retains both source and review history',()=>{
 const f=pendingFixture(),entry=f.fx.files['intake-file'].value.entries[f.intakeId];f.config.principals=f.config.principals.filter(p=>p.principalId!=='cadet');
 const original=clone(entry.source),request=replayReview(f);assert.equal(f.runtime.reviewReplay(request).status,'pending-review');const held=f.fx.files['intake-file'].value.entries[f.intakeId];assert.deepEqual(held.source,original);assert.equal(held.commands.length,0);assert.equal(held.reviews[0].issue,'confirmation_required');assert.equal(held.issue,'confirmation_required');
 f.config.principals.push({email:'cadet@example.invalid',principalId:'cadet',personId:'cadet-one'});assert.equal(f.runtime.reviewReplay(replayReview(f,'review-two')).status,'queued');assert.equal(f.fx.files['intake-file'].value.entries[f.intakeId].reviews.length,2);
});
test('owner-only monotonic replay control works with no active user, consumes once, and retains explicit automation review evidence',()=>{
 const f=pendingFixture(),replay=replayReview(f);f.services.Session.getActiveUser=()=>({getEmail:()=>''});control(f,'review-replay',1);f.config.controlRequest.replay=replay;
 assert.equal(f.runtime.applyControl().status,'queued');assert.equal(f.fx.commands.length,0);assert.equal(f.runtime.applyControl().status,'already-consumed');
 const e=f.fx.files['intake-file'].value.entries[f.intakeId];assert.deepEqual(e.reviews[0].reviewedBy,{kind:'private-control',principalId:'publisher',requestId:'review-1',sequence:1});assert.equal(e.commands[0].command.actor.principalId,'cadet');
 f.runtime.pause();assert.equal(f.runtime.applyControl().status,'already-consumed');assert.equal(f.runtime.flush().status,'paused');assert.equal(f.fx.commands.length,0);
});
test('background replay refuses a Script-Property-owned request and changed private checkpoint',()=>{
 const f=pendingFixture(),replay=replayReview(f);control(f,'review-replay',1);f.config.controlRequest.replay=replay;f.values[FORMS_PROPERTIES.config]=JSON.stringify(f.config);
 assert.throws(()=>f.runtime.applyControl(),e=>e.code==='forms_control');assert.equal(f.fx.commands.length,0);
 const g=pendingFixture(),other=replayReview(g);control(g,'review-replay',1);g.config.controlRequest.replay=other;g.fx.files['intake-file'].value.entries[g.intakeId].issue='changed';
 assert.throws(()=>g.runtime.applyControl(),e=>e.code==='forms_control');assert.equal(g.fx.commands.length,0);
});

test('review checkpoint interruption queues no command and the same exact review can retry safely',()=>{
 const f=pendingFixture(),request=replayReview(f),original=clone(f.fx.files['intake-file'].value.entries[f.intakeId]);f.fx.failWrite=true;
 assert.throws(()=>f.runtime.reviewReplay(request),e=>e.code==='forms_google');assert.deepEqual(f.fx.files['intake-file'].value.entries[f.intakeId],original);assert.equal(f.fx.commands.length,0);
 f.fx.failWrite=false;assert.equal(f.runtime.reviewReplay(request).status,'queued');assert.equal(f.fx.files['intake-file'].value.entries[f.intakeId].reviews.length,1);f.runtime.flush();assert.equal(f.fx.commands.length,1);
});
test('reviewed delayed response keeps its original event version after a new catalog publication',()=>{
 const f=pendingFixture();f.snapshot.events[0].version=2;f.snapshot.revision.operations++;f.fx.claim=true;f.runtime.refresh();
 assert.equal(f.runtime.reviewReplay(replayReview(f)).status,'queued');assert.equal(f.fx.files['intake-file'].value.entries[f.intakeId].commands[0].command.payload.events[0].expectedEventVersion,1);
});
