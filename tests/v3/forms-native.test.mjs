import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createNativeFormsRuntime,FORMS_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/forms-native.js';
import {HOST_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/staging-host.js';
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
   if(path.endsWith('/project'))return response({effect:{effectId:'effect',kind:'forms.refresh'},snapshot});
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
   if(u.pathname.endsWith(':batchUpdate')){assert(fx.files['state-file'].value.pending);assert.equal(fx.open[id],false);assert.equal(body.writeControl.requiredRevisionId,fx.forms[id].revisionId);for(const r of body.requests){assert.equal(r.updateItem.updateMask,'questionItem.question.choiceQuestion.options');fx.forms[id].items[r.updateItem.location.index].questionItem.question.choiceQuestion.options=clone(r.updateItem.item.questionItem.question.choiceQuestion.options);}fx.forms[id].revisionId+='b';return response({});}
   return response(clone(fx.forms[id]));
  }
  const id=u.pathname.split('/').at(-1),file=fx.files[id];assert(file,`unknown file ${id}`);
  if(options.method==='patch'){if(fx.failWrite)return response({},503);file.value=clone(body);file.version++;return response({id,version:String(file.version)});}
  if(u.searchParams.get('alt')==='media')return response(clone(file.value));
  return response({id:file.id,name:file.name,mimeType:file.mimeType,size:JSON.stringify(file.value??{}).length,version:String(file.version??1),owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner}]});
 }}};
 return{fx,config,values,services,runtime:createNativeFormsRuntime(services)};
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
