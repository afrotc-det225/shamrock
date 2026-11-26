import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';
import {createNativeFrontendInput,INPUT_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/frontend-input-native.js';
import {inputCanonical} from '../../.build/v3/apps/google-adapter/src/frontend-input.js';
import {HOST_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/staging-host.js';
import {FRONTEND_SECTIONS,FRONTEND_PAGE_VERSION} from '../../.build/v3/packages/domain/src/frontend-transport.js';
const copy=x=>structuredClone(x),sha=x=>createHash('sha256').update(x).digest('hex'),owner='automation@example.invalid',email='editor@example.invalid',secret='fictional-native-input-secret-with-32-characters';
const cell=v=>v===null?{}:{userEnteredValue:{stringValue:v}};
function fixture(){
 const fx={triggers:[],notes:[],prefilled:[],commands:[],fences:0,restores:0,frontendPaused:false,journal:{version:1,environment:'staging',generation:1,entries:{}},state:{version:1,environment:'staging',generation:1,baselines:{},drafts:{},supplemental:{dashboardRevision:{operations:0,administration:0},baselines:{},drafts:{}}},tables:{}};
 const surfaces=['directory','leadership','attendance','blue','gold'].map((surface,i)=>({surface,spreadsheetId:i<3?'main':'excusals',sheetId:i+1,tableId:`table-${surface}`,resourceKey:`source-${surface}`}));
 const main={spreadsheetId:'main',sheets:{}},excusals={spreadsheetId:'excusals',sheets:{}};
 for(const b of surfaces){const keyHeader=b.surface==='leadership'?'contact_id':['blue','gold'].includes(b.surface)?'request_id':'person_id',key=b.surface==='leadership'?'contact':['blue','gold'].includes(b.surface)?`request-${b.surface}`:'person',header=b.surface==='attendance'?'event:event':b.surface==='directory'?'phone':b.surface==='leadership'?'office_phone':'decision';
  const command={operation:b.surface==='attendance'?'attendance.correct':b.surface==='directory'?'directory.upsert':b.surface==='leadership'?'leadership.upsert':'excusal.decide',entityId:key,field:b.surface==='attendance'?'event':b.surface==='leadership'?'officePhone':header,expectedVersion:1},values={last_name:'Example',[header]:null,[keyHeader]:key};
  const baseline={generation:1,revision:{operations:1,administration:1},rows:[{key,values,versions:{[header]:1},commandBindings:{[header]:command},...(b.surface==='attendance'?{eventVersions:{[header]:1}}:{})}]};
  const target=b.surface==='blue'||b.surface==='gold'?fx.state.supplemental:fx.state;target.baselines[b.surface]=baseline;target.drafts[b.surface]=[];
  fx.tables[b.surface]={sheetId:b.sheetId,tableId:b.tableId,gridRowCount:10,gridColumnCount:3,headers:['last_name',header,keyHeader],labels:['Last Name',header,'ID'],rows:[[cell('Example'),{},cell(key)]],range:{sheetId:b.sheetId,startRowIndex:1,endRowIndex:3,startColumnIndex:0,endColumnIndex:3},hiddenColumns:[2],machineRowHidden:true};
  (b.surface==='blue'||b.surface==='gold'?excusals:main).sheets[b.surface]={sheetId:b.sheetId,tableId:b.tableId};
 }
 const config={confirmationResponderAccess:{version:1,allowedEmails:[owner,email]},version:1,environment:'staging',generation:1,enabled:true,resourceReview:'EXISTING_INPUT_SURFACES_REVIEWED_FOR_STAGING',journalFileId:'input-journal',principals:[{email,principalId:'editor'}],surfaces,
  providerReview:{reviewId:'fixture-review',bindingsSha256:sha(inputCanonical(surfaces)),filterViewCoordinatesVerified:true,protectedSortDenied:true},confirmation:{formId:'confirmation',expectedTitle:'Input confirmation Staging',allowedEditors:[],reference:{itemId:'ref-api',questionId:'ref-q'},summary:{itemId:'summary-api',questionId:'summary-q'},action:{itemId:'action-api',questionId:'action-q'}}};
 const form={formId:'confirmation',info:{title:config.confirmation.expectedTitle},settings:{emailCollectionType:'VERIFIED'},items:[{itemId:'ref-api',title:'Reference',questionItem:{question:{questionId:'ref-q',textQuestion:{},required:true}}},{itemId:'summary-api',title:'Frozen changes',questionItem:{question:{questionId:'summary-q',textQuestion:{paragraph:true},required:true}}},{itemId:'action-api',title:'Action',questionItem:{question:{questionId:'action-q',choiceQuestion:{type:'RADIO',options:[{value:'Confirm these changes'}]},required:true}}}]};
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'legacy-journal',sheetId:1},attendance:{formId:'legacy-form',resourceKey:'legacy',itemRoles:{event:'event',scope:'scope',present:['present'],completeness:'complete'}}};
 const props={[HOST_PROPERTIES.config]:JSON.stringify(host),[HOST_PROPERTIES.secret]:secret,[INPUT_PROPERTIES.config]:JSON.stringify(config)};
 const update=()=>props[INPUT_PROPERTIES.config]=JSON.stringify(config);
 const response=(body,status=200)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
 const nativeItems=form.items.map((item,i)=>({getId:()=>101+i,getIndex:()=>i,getTitle:()=>item.title,asTextItem(){return{createResponse:value=>({id:101+i,value})};},asParagraphTextItem(){return{createResponse:value=>({id:101+i,value})};}}));
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];}})},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()],getUuid:()=>`held-${Object.keys(fx.journal.held??{}).length}`},Session:{getEffectiveUser:()=>({getEmail:()=>owner}),getActiveUser:()=>({getEmail:()=>email})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},nowSeconds:()=>1793966400,ScriptApp:{getOAuthToken:()=> 'fixture-oauth',getProjectTriggers:()=>fx.triggers,EventType:{ON_EDIT:'edit',ON_FORM_SUBMIT:'submit'},TriggerSource:{SPREADSHEETS:'sheets',FORMS:'forms'},deleteTrigger:t=>{fx.triggers=fx.triggers.filter(x=>x!==t);},newTrigger:handler=>{const builder=(id,type,source)=>({create:()=>{const uid=`trigger-${fx.nextTriggerId??0}`;fx.nextTriggerId=(fx.nextTriggerId??0)+1;const t={getUniqueId:()=>uid,getHandlerFunction:()=>handler,getTriggerSourceId:()=>id,getEventType:()=>type,getTriggerSource:()=>source};fx.triggers.push(t);return t;}});return{forSpreadsheet:id=>({onEdit:()=>builder(id,'edit','sheets')}),forForm:id=>({onFormSubmit:()=>builder(id,'submit','forms')})};}},FormApp:{openById:()=>({getItems:()=>nativeItems,getItemById:id=>{const item=nativeItems.find(x=>x.getId()===id);assert(item,'must use native Script item ID, not API hex/string ID');return item;},createResponse:()=>{const answers=[];const r={withItemResponse:a=>{answers.push(a);return r;},toPrefilledUrl:()=>{fx.prefilled.push(copy(answers));return'https://docs.google.com/forms/d/e/fictional/viewform?prefilled=fixture';}};return r;}})},UrlFetchApp:{fetch:(url,options)=>{
   const u=new URL(url),body=options.payload?JSON.parse(options.payload):undefined;
   if(u.host==='worker.example.invalid'){
    assert.equal(options.headers['x-shamrock-signature'],createHmac('sha256',secret).update(`POST\n${u.pathname}\n${options.headers['x-shamrock-timestamp']}\n${sha(options.payload)}`).digest('hex'));
    if(u.pathname==='/v1/admin/effects/availability')return response({acceptingCommands:false,frontendPending:false,frontendLeased:false,formsPending:false,formsLeased:false});
    if(u.pathname==='/v1/admin/snapshot/page'){
      (fx.snapshotSections??=[]).push(body.section);fx.snapshotReads=(fx.snapshotReads??0)+1;
      if(fx.snapshotFault&&body.section===fx.snapshotFault.section)return response(fx.snapshotFault.body,fx.snapshotFault.status);
      if(fx.changeDuringRead&&body.section==='events')fx.changeDuringRead();
      const events=fx.events??[{eventId:'event',termId:'term',columnLabel:'event:event',label:'LLAB',version:1,status:'active'}];
      const shared={contractVersion:FRONTEND_PAGE_VERSION,section:body.section,revision:{operations:1,administration:1},scope:{termId:'term',currentTermId:'term'}};
      if(body.section==='manifest')return response({...shared,environment:'staging',generation:1,sections:(body.sections??FRONTEND_SECTIONS).map(section=>({section,count:section==='events'?events.length:section==='terms'?1:0})),diagnostics:[],...(body.sections?{partial:true}:{})});
      if(body.section==='verify')return response({...shared,verified:true});
      return response({...shared,offset:0,rows:body.section==='events'?events:body.section==='terms'?[{termId:'term',isCurrent:1}]:[],nextOffset:null});
    }
    assert.equal(u.pathname,'/v1/admin/commands');const entry=Object.values(fx.journal.entries).find(e=>e.commands.some(c=>c.command.commandId===body.commandId));assert(entry?.commands[0].attempted);assert(fx.state.drafts.attendance.some(d=>d.key===body.payload.personId&&d.header==='event:'+body.payload.eventId));fx.commands.push(copy(body));return response({commandId:body.commandId,status:'committed',operation:'attendance.correct',result:{personId:body.payload.personId,eventId:body.payload.eventId,version:body.payload.expectedBaseVersion+3,code:body.payload.code}});
   }
   assert.equal(options.headers.Authorization,'Bearer fixture-oauth');
   if(u.host==='sheets.googleapis.com'){
    if(fx.reorderHarness&&options.method==='get'){
      const tables=Object.entries(fx.tables).filter(([kind])=>['directory','leadership','attendance'].includes(kind));
      if(!u.searchParams.has('ranges'))return response({spreadsheetId:'main',sheets:tables.map(([kind,t])=>({properties:{sheetId:t.sheetId,title:kind,gridProperties:{rowCount:t.gridRowCount,columnCount:t.gridColumnCount}},tables:[{tableId:t.tableId,range:t.range}],filterViews:t.filterViews??[]}))});
      const title=u.searchParams.get('ranges').split('!')[0].replaceAll("'",''),t=fx.tables[title];assert(t);return response({sheets:[{properties:{sheetId:t.sheetId},data:[{rowData:[{values:t.headers.map(cell)},{values:t.labels.map(cell)},...t.rows.map(values=>({values}))],rowMetadata:[{hiddenByUser:true},{},...t.rows.map(()=>({pixelSize:21}))],columnMetadata:Array.from({length:t.gridColumnCount},(_,i)=>({pixelSize:90,...(t.hiddenColumns.includes(i)?{hiddenByUser:true}:{})}))}]}]});
    }
    if(fx.reorderHarness&&body.requests.every(r=>r.moveDimension)){
      assert.equal(props[INPUT_PROPERTIES.setup],undefined);assert(props.SHAMROCK_V3_INPUT_REORDER);fx.rowBatches??=[];fx.rowBatches.push(copy(body));
      for(const {moveDimension:m} of body.requests){const t=Object.values(fx.tables).find(t=>t.sheetId===m.source.sheetId);t.rows.splice(m.destinationIndex-2,0,t.rows.splice(m.source.startIndex-2,1)[0]);}return response({});
    }
    fx.notes.push(body);for(const {repeatCell} of body.requests){assert.equal(repeatCell.fields,'note');const {range}=repeatCell;
      const t=Object.values(fx.tables).find(t=>t.sheetId===range.sheetId);for(let r=range.startRowIndex;r<range.endRowIndex;r++)for(let c=range.startColumnIndex;c<range.endColumnIndex;c++)t.rows[r-2][c].note=repeatCell.cell.note;
    }return response({});
   }
   if(u.host==='forms.googleapis.com')return response(u.pathname.includes('/responses/')?fx.confirmationResponse:copy(form));
   if(u.pathname.endsWith('/permissions'))return response({permissions:fx.publishedPermissions??[{id:'editor',type:'user',role:'reader',view:'published',emailAddress:email}]});
   const id=u.pathname.split('/').at(-1);if(fx.retentionFiles&&['retention-folder',...Object.keys(fx.retentionFiles)].includes(id)){
    assert.equal(options.method,'get');if(u.searchParams.get('alt')==='media')return response(fx.retentionFiles[id]);
    return response({id,mimeType:id==='retention-folder'?'application/vnd.google-apps.folder':'application/json',parents:id==='retention-folder'?[]:['retention-folder'],size:JSON.stringify(fx.retentionFiles[id]??{}).length,version:'1',owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner}]});
   }if(fx.recoveryFiles&&Object.hasOwn(fx.recoveryFiles,id)){
    if(options.method==='patch'){fx.recoveryFiles[id]=copy(body);return response({id});}
    if(u.searchParams.get('alt')==='media')return response(fx.recoveryFiles[id]);
    return response({id,mimeType:'application/json',size:JSON.stringify(fx.recoveryFiles[id]).length,version:'1',owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner}]});
   }assert(['confirmation','input-journal'].includes(id));
   if(options.method==='patch'){assert.equal(id,'input-journal');fx.journal=copy(body);return response({id});}
   if(u.searchParams.get('alt')==='media')return response(copy(fx.journal));
   return response({id,name:id==='confirmation'?config.confirmation.expectedTitle:id,mimeType:id==='confirmation'?'application/vnd.google-apps.form':'application/json',size:JSON.stringify(fx.journal).length,version:'1',owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner}]});
 }}};
 fx.frontendConfig={generation:1,principalId:'publisher',enabled:true,stateFileId:'frontend-state',main,supplemental:{enabled:true,excusals}};
 const frontend={pause:()=>{fx.frontendPaused=true;},inputSession(operation,options={}){if(fx.frontendPaused&&!options.allowPaused)return{status:'disabled'};const session={config:fx.frontendConfig,automationEmail:owner,adapter:{environment:'staging',generation:1,baseUrl:host.workerOrigin,keyId:'fixture'},state:copy(fx.state),read:surface=>copy(fx.tables[surface]),save:value=>{fx.state=copy(value);},fence:()=>{fx.fences++;},restore:()=>{fx.restores++;}};return operation(session);}};
 const runtime=createNativeFrontendInput(services,frontend);
 const edit=(who=email)=>({source:{getId:()=> 'main'},range:{getSheet:()=>({getSheetId:()=>3}),getRow:()=>3,getColumn:()=>2,getNumRows:()=>1,getNumColumns:()=>1},value:'P',...(who?{user:{getEmail:()=>who}}:{}),triggerUid:fx.triggers.find(t=>t.getTriggerSourceId()==='main')?.getUniqueId()});
 return{fx,config,props,update,runtime,form,edit};
}
test('native setup binds verified slots under fences while preserving all cells and resumes explicitly',()=>{
 const f=fixture(),before=copy(f.fx.tables);f.fx.frontendPaused=true;assert.equal(f.runtime.setup().status,'ready-paused');assert.equal(f.fx.fences,1);assert.equal(f.fx.restores,1);assert.deepEqual(f.fx.tables,before);assert(f.fx.state.baselines.attendance.slots);assert.equal(f.fx.triggers.length,3);f.runtime.setup();assert.equal(f.fx.triggers.length,3);f.fx.frontendPaused=false;assert.equal(f.runtime.resume().status,'enabled');
 f.fx.tables.attendance.rows[0][1]=cell('P');assert.equal(f.runtime.onEdit(f.edit()).status,'committed');assert.equal(f.fx.commands.length,1);assert.equal(f.fx.commands[0].actor.principalId,'editor');assert.equal(f.fx.state.drafts.attendance.length,0);assert.equal(f.fx.notes.length,0);
});
test('unknown native editor receives a frozen prefilled Form and only verified matching confirmation dispatches',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');const held=f.runtime.onEdit(f.edit(null));assert.equal(held.status,'confirmation-required');assert.equal(f.fx.commands.length,0);assert.equal(f.fx.prefilled[0][0].id,101);assert.equal(f.fx.prefilled[0][1].id,102);const entry=f.fx.journal.entries[held.editId];
 const answers={'ref-q':held.editId,'summary-q':entry.edit.summary,'action-q':'Confirm these changes'};f.fx.confirmationResponse={formId:'confirmation',responseId:'native-response',lastSubmittedTime:'2026-11-06T12:00:00.123456Z',respondentEmail:email,answers:Object.fromEntries(Object.entries(answers).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 assert.equal(f.runtime.replayConfirmation('native-response').status,'committed');assert.equal(f.fx.commands[0].actor.evidence,'authenticated-confirmation');assert.equal(f.fx.commands.length,1);assert.equal(f.runtime.replayConfirmation('native-response').status,'committed');assert.equal(f.fx.commands.length,1);
});
test('private setup control is consumed once and cannot undo a later pause',()=>{
 const f=fixture();f.config.enabled=false;f.config.controlRequest={requestId:'setup-one',sequence:1,action:'setup',frontendSha256:sha(inputCanonical(f.fx.state)),journalSha256:sha(inputCanonical(f.fx.journal))};f.update();assert.equal(f.runtime.applyControl().status,'ready-paused');assert.equal(f.fx.fences,1);assert.equal(f.runtime.applyControl().status,'already-consumed');assert.equal(f.fx.fences,1);f.runtime.pause();assert.equal(f.runtime.applyControl().status,'already-consumed');assert.equal(f.props[INPUT_PROPERTIES.pause],'true');
 f.config.controlRequest.sequence=2;f.config.controlRequest.requestId='changed';f.update();assert.throws(()=>f.runtime.applyControl(),e=>e.code==='input_control');
});
test('a paused-period publisher draft is recovered for confirmation without inventing editor identity',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');const row=f.fx.state.baselines.attendance.rows[0];f.fx.state.drafts.attendance.push({key:'person',header:'event:event',value:'P',baseVersion:1,expectedEventVersion:1,command:copy(row.commandBindings['event:event'])});f.runtime.flush();assert.equal(f.fx.commands.length,0);const entry=Object.values(f.fx.journal.entries)[0];assert.equal(entry.edit.status,'confirmation-required');assert.equal(entry.edit.evidence.actorEmail,undefined);assert.equal(entry.edit.drafts[0].baseVersion,1);
});

test('a changed, never-dispatched draft can be cleared or replaced without reusing a frozen confirmation',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');const first=f.runtime.onEdit(f.edit(null));
 f.fx.tables.attendance.rows[0][1]={};const cleared=f.edit(null);delete cleared.value;cleared.oldValue='P';assert.equal(f.runtime.onEdit(cleared).status,'noop');
 assert.equal(f.fx.journal.entries[first.editId].superseded,true);assert.equal(f.fx.state.drafts.attendance.length,0);assert.equal(f.fx.commands.length,0);
 f.fx.tables.attendance.rows[0][1]=cell('P');const second=f.runtime.onEdit(f.edit(null));assert.notEqual(second.editId,first.editId);assert.equal(second.status,'confirmation-required');assert.equal(f.fx.state.drafts.attendance.length,1);
 const old=f.fx.journal.entries[first.editId];f.fx.confirmationResponse={formId:'confirmation',responseId:'old-response',lastSubmittedTime:'2026-11-06T12:00:00Z',respondentEmail:email,answers:Object.fromEntries(Object.entries({'ref-q':first.editId,'summary-q':old.edit.summary,'action-q':'Confirm these changes'}).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 assert.throws(()=>f.runtime.replayConfirmation('old-response'),e=>e.code==='input_confirmation');assert.equal(f.fx.commands.length,0);
});
test('idle scheduled input flush does not rewrite historical receipt notes',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');f.runtime.onEdit(f.edit());const count=f.fx.notes.length;f.runtime.flush();f.runtime.flush();assert.equal(f.fx.notes.length,count);assert.equal(f.fx.commands.length,1);
});

test('shared permission fence prevents native edit dispatch and leaves the input journal unchanged',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.props.SHAMROCK_V3_PERMISSION_FENCED='pending';const journal=copy(f.fx.journal);f.fx.tables.attendance.rows[0][1]=cell('P');
 assert.throws(()=>f.runtime.onEdit(f.edit()),e=>e.code==='permission_refresh');assert.deepEqual(f.fx.journal,journal);assert.equal(f.fx.commands.length,0);
});

 test('archived confirmation validates frozen identity and returns its prior receipt without another delivery',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');const held=f.runtime.onEdit(f.edit(null)),entry=f.fx.journal.entries[held.editId];
 f.fx.confirmationResponse={formId:'confirmation',responseId:'archived-response',lastSubmittedTime:'2026-11-06T12:00:00Z',respondentEmail:email,answers:Object.fromEntries(Object.entries({'ref-q':held.editId,'summary-q':entry.edit.summary,'action-q':'Confirm these changes'}).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 f.runtime.replayConfirmation('archived-response');assert.equal(f.fx.commands.length,1);const archived=copy(f.fx.journal.entries[held.editId]),key=`input-entry.${held.editId}`,keyHash=sha(key),text=inputCanonical(archived),prefix=keyHash[0];
 f.config.retention={version:1,archiveFolderId:'retention-folder',indexFileId:'retention-index'};f.update();f.fx.retentionFiles={'retention-index':{version:1,environment:'staging',generation:1,buckets:{[prefix]:'retention-bucket'}},'retention-bucket':{version:1,prefix,records:{[keyHash]:{key,hash:sha(text),bytes:Buffer.byteLength(text),inline:archived}}}};delete f.fx.journal.entries[held.editId];
 assert.deepEqual(f.runtime.replayConfirmation('archived-response'),{status:'committed',editId:held.editId,archived:true});assert.equal(f.fx.commands.length,1);assert.equal(Object.keys(f.fx.journal.entries).length,0);
 f.fx.confirmationResponse.respondentEmail='outsider@example.invalid';assert.throws(()=>f.runtime.replayConfirmation('archived-response'));assert.equal(f.fx.commands.length,1);
});

test('native-only host preserves immutable native inputs and exact signed dispatch without transport storage',()=>{
 const f=fixture(),host=JSON.parse(f.props[HOST_PROPERTIES.config]);delete host.journal;delete host.attendance;host.mode='native-only';f.props[HOST_PROPERTIES.config]=JSON.stringify(host);
 f.runtime.setup();f.runtime.resume();f.fx.tables.attendance.rows[0][1]=cell('P');f.runtime.onEdit(f.edit());
 assert.equal(f.fx.commands.length,1);assert.equal(f.fx.commands[0].operation,'attendance.correct');assert.equal(f.fx.triggers.length,3);assert.equal(Object.values(f.fx.journal.entries).length,1);
});

test('paused native setup allows an absent responder review but resume refuses it',()=>{
 const f=fixture();delete f.config.confirmationResponderAccess;f.config.enabled=false;f.update();assert.equal(f.runtime.setup().status,'ready-paused');f.config.enabled=true;f.update();
 assert.throws(()=>f.runtime.resume(),{code:'form_responder_access'});assert.equal(f.props[INPUT_PROPERTIES.pause],'true');assert.equal(f.fx.commands.length,0);
});
test('new broad confirmation access pauses native edits before capture or dispatch',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();const journal=copy(f.fx.journal);f.fx.publishedPermissions=[{id:'public',type:'anyone',role:'reader',view:'published'}];f.fx.tables.attendance.rows[0][1]=cell('P');
 assert.throws(()=>f.runtime.onEdit(f.edit()),{code:'form_responder_access'});assert.equal(f.props[INPUT_PROPERTIES.pause],'true');assert.deepEqual(f.fx.journal,journal);assert.equal(f.fx.commands.length,0);
});

test('a delayed edit from a retired native trigger is rejected before snapshot, journal capture or dispatch',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();const delayed=f.edit(),before=copy(f.fx.journal),setup=JSON.parse(f.props[INPUT_PROPERTIES.setup]);setup.ids.main='fresh-replacement-trigger';f.props[INPUT_PROPERTIES.setup]=JSON.stringify(setup);
 f.fx.tables.attendance.rows[0][1]=cell('P');assert.throws(()=>f.runtime.onEdit(delayed),{code:'input_identity'});assert.deepEqual(f.fx.journal,before);assert.equal(f.fx.commands.length,0);assert.equal(f.fx.snapshotReads??0,0);
});
test('retained physical maintenance prevents direct setup and resume from restoring an old binding',()=>{
 const f=fixture();f.runtime.setup();f.props.SHAMROCK_V3_INPUT_REORDER='retained-private-maintenance';const before=copy(f.fx.state);
 assert.throws(()=>f.runtime.setup(),{code:'input_reorder'});assert.throws(()=>f.runtime.resume(),{code:'input_reorder'});assert.deepEqual(f.fx.state,before);assert.equal(f.props[INPUT_PROPERTIES.pause],'true');
});
test('reorder controls require exact recovery bindings and disabled gates before provider maintenance',()=>{
 const f=fixture();f.runtime.setup();const request={requestId:'reorder-review',sequence:1,action:'reorder',frontendSha256:sha(inputCanonical(f.fx.state)),journalSha256:sha(inputCanonical(f.fx.journal)),recoveryFileId:'separate-recovery',recoverySha256:sha('empty')};
 f.config.controlRequest={...request,unreviewed:true};f.update();assert.throws(()=>f.runtime.applyControl(),{code:'input_control'});
 f.config.controlRequest=request;f.update();assert.throws(()=>f.runtime.applyControl(),{code:'input_reorder'});assert.equal(f.fx.commands.length,0);assert.equal(f.fx.triggers.length,3);assert(f.props[INPUT_PROPERTIES.setup]);
});
test('native reorder control verifies private recovery IO, complete cell metadata and one Main row batch without opening gates',()=>{
 const f=fixture();
 for(const kind of ['directory','leadership']){const old=f.fx.state.baselines[kind].rows[0],keyHeader=kind==='directory'?'person_id':'contact_id',next=copy(old);next.key+='-second';next.values.last_name='Able';next.values[keyHeader]=next.key;for(const binding of Object.values(next.commandBindings))binding.entityId=next.key;f.fx.state.baselines[kind].rows.push(next);
  const table=f.fx.tables[kind];table.rows.push(table.headers.map(h=>cell(next.values[h]??null)));table.rows[0][0].note='Preserve first note';table.rows[1][0].note='Preserve second note';table.rows[1][1].dataValidation={condition:{type:'ONE_OF_LIST',values:[{userEnteredValue:'fixture'}]},showCustomUi:true,strict:true};table.range.endRowIndex++;
 }
 f.runtime.setup();const before=copy(f.fx.state),oldSetup=JSON.parse(f.props[INPUT_PROPERTIES.setup]),nativeRows=copy(f.fx.tables);
 f.config.enabled=false;f.fx.frontendConfig.enabled=false;f.fx.frontendPaused=true;f.props.SHAMROCK_V3_FRONTEND_PAUSED='true';f.fx.reorderHarness=true;f.fx.recoveryFiles={'separate-recovery':{version:1,environment:'staging',generation:1,status:'empty'}};
 f.config.controlRequest={requestId:'native-reorder',sequence:1,action:'reorder',frontendSha256:sha(inputCanonical(f.fx.state)),journalSha256:sha(inputCanonical(f.fx.journal)),recoveryFileId:'separate-recovery',recoverySha256:sha(inputCanonical(f.fx.recoveryFiles['separate-recovery']))};f.update();
 assert.deepEqual(f.runtime.applyControl(),{status:'reordered-paused',rows:4});assert.equal(f.runtime.applyControl().status,'already-consumed');assert.equal(f.fx.rowBatches.length,1);assert.equal(f.fx.rowBatches[0].requests.length,2);
 for(const kind of ['directory','leadership']){assert.deepEqual(f.fx.tables[kind].rows,nativeRows[kind].rows.slice().reverse());assert.deepEqual(f.fx.state.baselines[kind].rows,before.baselines[kind].rows);assert.deepEqual(f.fx.state.baselines[kind].slots.keys,before.baselines[kind].slots.keys.slice().reverse());}
 assert.deepEqual(f.fx.state.supplemental,before.supplemental);assert.deepEqual(f.fx.tables.attendance,nativeRows.attendance);assert.equal(f.fx.commands.length,0);
 const receipt=JSON.parse(f.props[INPUT_PROPERTIES.setup]);assert.notEqual(receipt.ids.main,oldSetup.ids.main);assert.notEqual(receipt.ids.excusals,oldSetup.ids.excusals);assert.equal(receipt.ids.confirmation,oldSetup.ids.confirmation);assert.equal(f.fx.triggers.length,3);
 assert.equal(f.fx.recoveryFiles['separate-recovery'].phase,'complete');assert.equal(f.props.SHAMROCK_V3_INPUT_REORDER,undefined);assert.equal(f.props[INPUT_PROPERTIES.pause],'true');assert.equal(f.props.SHAMROCK_V3_FRONTEND_PAUSED,'true');assert.equal(f.config.enabled,false);assert.equal(f.fx.frontendConfig.enabled,false);
});

test('native Attendance paste clips a full-column selection and freezes exactly the changed cadet/event pairs, including a clear',()=>{
 const f=fixture(),t=f.fx.tables.attendance,base=f.fx.state.baselines.attendance;
 const headers=['last_name','event:llab','event:mando','person_id'];
 t.headers=headers;t.labels=['Last Name','TW-1 LLAB','TW-1 Mando','ID'];t.gridColumnCount=4;t.range.endColumnIndex=4;t.range.endRowIndex=4;t.hiddenColumns=[3];
 f.fx.events=['llab','mando'].map((id,i)=>({eventId:id,termId:'term',columnLabel:t.labels[i+1],label:id,version:2+i,status:'active'}));
 base.rows=['first','second'].map((key,i)=>{
   const values={last_name:key,'event:llab':i?'P':null,'event:mando':i?null:'N/A',person_id:key};
   const versions={'event:llab':3,'event:mando':4},eventVersions={'event:llab':2,'event:mando':3};
   return {key,values,versions,eventVersions,commandBindings:Object.fromEntries(f.fx.events.map(e=>['event:'+e.eventId,{operation:'attendance.correct',entityId:key,field:e.eventId,expectedVersion:versions['event:'+e.eventId]}]))};
 });
 t.rows=base.rows.map(r=>headers.map(h=>cell(r.values[h])));
 t.rows[0][0].note='Fixed name note';t.rows[0][2].note='Existing N/A note';t.rows[1][1].note='Training staff note';
 f.runtime.setup();f.runtime.resume();
 t.rows[0][1].userEnteredValue={stringValue:'P'};delete t.rows[1][1].userEnteredValue;t.rows[1][2].userEnteredValue={stringValue:'N/A'};
 const e=f.edit();delete e.value;
 Object.assign(e.range,{getRow:()=>1,getColumn:()=>1,getNumRows:()=>1000,getNumColumns:()=>6});
 const result=f.runtime.onEdit(e),entry=f.fx.journal.entries[result.editId];
 assert.equal(result.status,'confirmation-required');assert.equal(f.fx.commands.length,0);assert.deepEqual(f.fx.snapshotSections,['manifest','events','verify']);
 assert.deepEqual(entry.edit.templates.map(t=>[t.payload.personId,t.payload.eventId,t.payload.code]),[['first','llab','P'],['second','llab',null],['second','mando','N/A']]);
 assert.equal(t.rows[0][0].note,'Fixed name note');assert.equal(t.rows[0][2].note,'Existing N/A note');assert.match(t.rows[1][1].note,/^Training staff note\nSHAMROCK:/);
 assert.equal(f.fx.notes.length,1);assert.deepEqual(f.fx.notes[0].requests.map(r=>[r.repeatCell.range.startRowIndex,r.repeatCell.range.startColumnIndex]),[[2,1],[3,1],[3,2]]);
 // Native redelivery of the same range reuses its journal and existing notes.
 assert.equal(f.runtime.onEdit(e).editId,result.editId);assert.equal(Object.keys(f.fx.journal.entries).length,1);assert.equal(f.fx.notes.length,1);
 const answers={'ref-q':entry.edit.editId,'summary-q':entry.edit.summary,'action-q':'Confirm these changes'};
 f.fx.confirmationResponse={formId:'confirmation',responseId:'multi-response',lastSubmittedTime:'2026-11-06T12:00:00Z',respondentEmail:email,answers:Object.fromEntries(Object.entries(answers).map(([questionId,value])=>[questionId,{questionId,textAnswers:{answers:[{value}]}}]))};
 assert.equal(f.runtime.replayConfirmation('multi-response').status,'committed');
 assert.deepEqual(f.fx.commands.map(c=>[c.payload.personId,c.payload.eventId,c.payload.code]),[['first','llab','P'],['second','llab',null],['second','mando','N/A']]);
 assert.equal(t.rows[1][1].note,'Training staff note');assert.equal(t.rows[0][2].note,'Existing N/A note');assert.equal(f.fx.state.drafts.attendance.length,0);
 assert.equal(f.runtime.replayConfirmation('multi-response').status,'committed');assert.equal(f.fx.commands.length,3);

});

test('an invalid replacement leaves the prior confirmation, frozen hold and operator notes intact',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();const t=f.fx.tables.attendance.rows[0][1];t.userEnteredValue={stringValue:'P'};t.note='Operator note';
 const first=f.runtime.onEdit(f.edit(null)),held=copy(f.fx.journal.entries[first.editId]),drafts=copy(f.fx.state.drafts.attendance),note=t.note;
 t.userEnteredValue={stringValue:'unsupported'};
 const replacement=f.edit(null);replacement.value='unsupported';replacement.oldValue='P';
 assert.throws(()=>f.runtime.onEdit(replacement));assert.deepEqual(f.fx.journal.entries[first.editId],held);assert.deepEqual(f.fx.state.drafts.attendance,drafts);
 assert.equal(t.note,note);assert.equal(f.fx.commands.length,0);assert.equal(Object.keys(f.fx.journal.held).length,1);
});

test('failed catalog reads preserve the observed bulk values and never approve a partial or unauthorized catalog',()=>{
 for(const [fault,code] of [
   [{section:'events',status:429,body:{error:{code:'quota'}}},'input_snapshot_retry'],
   [{section:'verify',status:409,body:{error:{code:'SNAPSHOT_CHANGED'}}},'input_snapshot_retry'],
   [{section:'verify',status:403,body:{error:{code:'NOT_AUTHORIZED'}}},'input_snapshot_access'],
   [{section:'manifest',status:200,body:{partial:true}},'input_snapshot']
 ]){
   const f=fixture();f.runtime.setup();f.runtime.resume();f.fx.snapshotFault=fault;
   f.fx.tables.attendance.rows[0][1].userEnteredValue={stringValue:'N/A'};
   const e=f.edit(null);delete e.value;e.range.getRow=()=>2;e.range.getNumRows=()=>2;
   assert.throws(()=>f.runtime.onEdit(e),{code});
   assert.throws(()=>f.runtime.onEdit(e),{code});const held=Object.values(f.fx.journal.held);
   assert.equal(held.length,1);assert.equal(held[0].issue,code);
   assert.deepEqual(held[0].event.attendanceCells,[{key:'person',header:'event:event',label:'event:event',before:null,entered:'N/A',pairVersion:1,eventVersion:1}]);
   assert.equal(f.fx.commands.length,0);assert.equal(f.fx.notes.length,0);
 }
});

test('an overlapping human edit during the catalog read keeps the original paste evidence for review',()=>{
 const f=fixture();f.runtime.setup();f.runtime.resume();const cell=f.fx.tables.attendance.rows[0][1];
 cell.userEnteredValue={stringValue:'P'};f.fx.changeDuringRead=()=>{cell.userEnteredValue={stringValue:'A'};};
 assert.throws(()=>f.runtime.onEdit(f.edit()),{code:'input_changed'});
 const held=Object.values(f.fx.journal.held)[0];assert.equal(held.event.attendanceCells[0].entered,'P');
 assert.equal(cell.userEnteredValue.stringValue,'A');assert.equal(f.fx.commands.length,0);assert.equal(f.fx.notes.length,0);
});
