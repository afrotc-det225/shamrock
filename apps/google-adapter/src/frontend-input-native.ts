/** Optional native edit and verified-email confirmation host. No IO during module loading. */
import {AdapterError,type Signer} from './index.js';
import {createGoogleSigner} from './apps-script.js';
import {HOST_PROPERTIES,parseStagingHostConfig} from './staging-host.js';
import {CONFIG_FILE_ID_PROPERTY} from './staging-config.js';
import {createNativeFrontendRuntime,type NativeFrontendInputSession,type NativeFrontendServices} from './frontend-runtime.js';
import {assertImmutableInputSlots,bindImmutableInputSlots,captureFrontendEdit,commandsForCapturedEdit,inputCanonical,nativeInputValue,type InputPrincipal,type InputSurfaceBinding,type NativeEditEvidence,type CapturedFrontendEdit} from './frontend-input.js';
import {deliverFrontendInputs,inputSurfaceState,retainCapturedInput,supersedeUnattemptedInput,type FrontendInputJournal,type InputJournalPorts,type InputJournalEntry} from './frontend-input-journal.js';

export const INPUT_PROPERTIES={config:'SHAMROCK_V3_INPUT_CONFIG',pause:'SHAMROCK_V3_INPUT_PAUSED',setup:'SHAMROCK_V3_INPUT_SETUP',controlReceipt:'SHAMROCK_V3_INPUT_CONTROL_RECEIPT',work:'SHAMROCK_V3_INPUT_WORK'} as const;
export const INPUT_HANDLERS={edit:'shamrockV3NativeFrontendEdit',confirmation:'shamrockV3NativeFrontendConfirm'} as const;
export interface NativeInputConfig {
  version:1;environment:'staging';generation:number;enabled:boolean;resourceReview:'EXISTING_INPUT_SURFACES_REVIEWED_FOR_STAGING';
  journalFileId:string;principals:InputPrincipal[];surfaces:InputSurfaceBinding[];
  controlRequest?:{requestId:string;sequence:number;action:'setup'|'resume'|'pause';frontendSha256:string;journalSha256:string};
  providerReview?:{reviewId:string;bindingsSha256:string;filterViewCoordinatesVerified:true;protectedSortDenied:true};
  confirmation:{formId:string;expectedTitle:string;allowedEditors:string[];reference:{itemId:string;questionId:string};summary:{itemId:string;questionId:string};action:{itemId:string;questionId:string}};
}
export interface NativeInputServices extends NativeFrontendServices {
  Utilities:NativeFrontendServices['Utilities']&{getUuid():string};
  ScriptApp:NativeFrontendServices['ScriptApp']&Record<string,any>;
  Session:NativeFrontendServices['Session']&{getActiveUser():{getEmail():string}};
  FormApp:{openById(id:string):any};
}
function fail(code:string,message:string):never{throw new AdapterError(code,message);}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const bytes=(v:string)=>encodeURIComponent(v).replace(/%[A-F0-9]{2}/g,'x').length;
export function snapshotNativeEdit(e:any):NativeEditEvidence{
  // Read native event evidence immediately, before obtaining a lock or touching a Sheet.
  let actorEmail:string|undefined;try{const email=e.user?.getEmail?.();if(typeof email==='string'&&email.trim())actorEmail=email.trim().toLowerCase();}catch{/* Missing editor identity requires authenticated confirmation. */}
  return {spreadsheetId:String(e.source.getId()),sheetId:e.range.getSheet().getSheetId(),row:e.range.getRow(),column:e.range.getColumn(),rows:e.range.getNumRows(),columns:e.range.getNumColumns(),
    ...(e.value!==undefined?{value:String(e.value)}:{}),...(e.oldValue!==undefined?{oldValue:String(e.oldValue)}:{}),...(actorEmail?{actorEmail}:{}),triggerUid:String(e.triggerUid??'')};
}
export function createNativeFrontendInput(services:NativeInputServices,frontend=createNativeFrontendRuntime(services)){
  const properties=services.PropertiesService.getScriptProperties(),now=services.nowSeconds??(()=>Math.floor(Date.now()/1000));
  const drive=(id:string)=>`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  const form=(id:string)=>`https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}`;
  function api(url:string,body?:unknown,method:'post'|'patch'='post'){
    const response=services.UrlFetchApp.fetch(url,{method:body===undefined?'get':method,headers:{Authorization:`Bearer ${services.ScriptApp.getOAuthToken()}`},...(body===undefined?{}:{contentType:'application/json',payload:JSON.stringify(body)}),muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});
    if(response.getResponseCode()!==200)fail('input_google',`Native input provider operation failed (HTTP ${response.getResponseCode()}).`);
    const text=response.getContentText();if(bytes(text)>5*1024*1024)fail('input_capacity','The provider response exceeds its reviewed bound.');
    try{return JSON.parse(text);}catch{return fail('input_google','The provider response was ambiguous.');}
  }
  function inspect(id:string,owner:string,editors:string[]=[]){
    const f=api(`${drive(id)}?fields=id,name,mimeType,size,version,trashed,owners(emailAddress),permissions(type,role,emailAddress,deleted)`);
    if(f.id!==id||f.trashed||f.owners?.length!==1||f.owners[0].emailAddress!==owner||f.permissions?.length!==new Set([owner,...editors]).size
      ||f.permissions.some((p:any)=>p.deleted||p.type!=='user'||![owner,...editors].includes(p.emailAddress)||p.role!==(p.emailAddress===owner?'owner':'writer')))fail('input_isolation','Input configuration, journal or confirmation Form sharing changed.');
    return f;
  }
  function privateRead(id:string,owner:string){const metadata=inspect(id,owner);if(metadata.mimeType!=='application/json'||Number(metadata.size)>5*1024*1024)fail('input_state','A bounded private JSON file is required.');return api(`${drive(id)}?alt=media`);}
  function context(){
    const hostRaw=properties.getProperty(HOST_PROPERTIES.config);if(!hostRaw)return undefined;const host=parseStagingHostConfig(JSON.parse(hostRaw)),owner=services.Session.getEffectiveUser().getEmail().trim().toLowerCase();
    if(owner!==host.expectedAutomationEmail)fail('input_identity','Use the configured staging automation account.');
    let raw:any=properties.getProperty(INPUT_PROPERTIES.config);if(!raw){const id=properties.getProperty(CONFIG_FILE_ID_PROPERTY);if(id)raw=privateRead(id,owner)[INPUT_PROPERTIES.config];}if(!raw)return undefined;
    const doc=typeof raw==='string'?JSON.parse(raw):raw,config=(doc.configFileId?privateRead(doc.configFileId,owner):doc) as NativeInputConfig;
    if(config.version!==1||config.environment!=='staging'||config.generation!==host.generation||config.resourceReview!=='EXISTING_INPUT_SURFACES_REVIEWED_FOR_STAGING'||typeof config.enabled!=='boolean'
      ||!Array.isArray(config.surfaces)||config.surfaces.length!==5||new Set(config.surfaces.map(s=>s.surface)).size!==5||config.surfaces.some(s=>!['directory','leadership','attendance','blue','gold'].includes(s.surface))
      ||!Array.isArray(config.principals)||new Set(config.principals.map(p=>p.email.toLowerCase())).size!==config.principals.length||!config.confirmation?.expectedTitle.includes('Staging')
      ||config.journalFileId===config.confirmation.formId)fail('input_configuration','An exact reviewed staging input configuration is required.');
    const signer=createGoogleSigner(services.Utilities,properties.getProperty(HOST_PROPERTIES.secret)??'');
    const fingerprint=signer.sha256(inputCanonical({surfaces:config.surfaces,confirmation:config.confirmation}));
    const enabled=()=>config.enabled&&properties.getProperty(INPUT_PROPERTIES.pause)!=='true';
    function request(path:string,body:unknown){
      const payload=JSON.stringify(body),timestamp=String(now());if(bytes(payload)>65536)fail('input_capacity','The frozen command exceeds its request bound.');
      const response=services.UrlFetchApp.fetch(host.workerOrigin+path,{method:'post',contentType:'application/json',payload,headers:{'x-shamrock-key-id':host.keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(payload)}`)},muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});
      const text=response.getContentText();if(bytes(text)>5*1024*1024)fail('input_capacity','The backend response exceeds its reviewed bound.');
      let value:any;try{value=JSON.parse(text);}catch{return fail('input_transport','The signed delivery result is ambiguous.');}return {status:response.getResponseCode(),body:value};
    }
    function journal(){let previous:string|undefined;return{load():FrontendInputJournal{
      const value=privateRead(config.journalFileId,owner);if(value.version!==1||value.environment!=='staging'||value.generation!==config.generation||!value.entries)fail('input_state','The input journal belongs to another generation.');previous=inputCanonical(value);return value;
    },save(value:FrontendInputJournal){const text=inputCanonical(value);if(bytes(text)>5*1024*1024)fail('input_capacity','Archive completed input evidence before exceeding the private journal limit.');
      if(previous===undefined||inputCanonical(privateRead(config.journalFileId,owner))!==previous)fail('input_state','The private input journal changed outside this lock.');
      api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.journalFileId)}?uploadType=media&fields=id`,value,'patch');if(inputCanonical(privateRead(config.journalFileId,owner))!==text)fail('input_state','The private input journal did not persist.');previous=text;
    }};}
    function confirmationRead(){const b=config.confirmation,metadata=inspect(b.formId,owner,b.allowedEditors),read=api(form(b.formId));
      if(metadata.mimeType!=='application/vnd.google-apps.form'||metadata.name!==b.expectedTitle||read.info?.title!==b.expectedTitle||read.settings?.emailCollectionType!=='VERIFIED')fail('input_confirmation','The staging confirmation Form must collect verified identity.');
      for(const field of ['reference','summary','action'] as const){const item=read.items?.find((i:any)=>i.itemId===b[field].itemId);if(item?.questionItem?.question?.questionId!==b[field].questionId)fail('input_confirmation','A bound confirmation question changed.');}
      const question=(name:'reference'|'summary'|'action')=>read.items.find((i:any)=>i.itemId===b[name].itemId).questionItem.question;
      if(!question('reference').textQuestion||question('reference').textQuestion.paragraph||question('summary').textQuestion?.paragraph!==true
        ||!['RADIO','DROP_DOWN'].includes(question('action').choiceQuestion?.type)||inputCanonical(question('action').choiceQuestion.options)!==inputCanonical([{value:'Confirm these changes'}]))fail('input_confirmation','Use the reviewed reference, summary and explicit confirmation controls.');
      return read;
    }
    function setupReceipt(){const setup=JSON.parse(properties.getProperty(INPUT_PROPERTIES.setup)??'null');if(!setup||setup.fingerprint!==fingerprint)fail('input_setup','Verify the native input triggers before processing edits.');return setup;}
    return{host,owner,config,signer,fingerprint,enabled,request,journal,confirmationRead,setupReceipt};
  }
  function pause(){properties.setProperty(INPUT_PROPERTIES.pause,'true');if(properties.getProperty(INPUT_PROPERTIES.pause)!=='true')fail('input_pause','The input pause did not persist.');return{status:'paused'};}
  function note(edit:NativeEditEvidence,text:string){if(!Number.isSafeInteger(edit.row)||!Number.isSafeInteger(edit.column)||edit.row<3||edit.column<1||edit.rows*edit.columns>250)return;
    api(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(edit.spreadsheetId)}:batchUpdate`,{requests:[{repeatCell:{range:{sheetId:edit.sheetId,startRowIndex:edit.row-1,endRowIndex:edit.row-1+edit.rows,startColumnIndex:edit.column-1,endColumnIndex:edit.column-1+edit.columns},cell:{note:text},fields:'note'}}]});}
  function checkSession(ctx:NonNullable<ReturnType<typeof context>>,session:NativeFrontendInputSession){
    if(session.config.generation!==ctx.config.generation||session.automationEmail!==ctx.owner)fail('input_configuration','Input and frontend generations must agree.');
    for(const b of ctx.config.surfaces){const exc=b.surface==='blue'||b.surface==='gold',book=exc&&session.config.supplemental?.enabled?session.config.supplemental.excusals:session.config.main;
      const binding=(book.sheets as Record<string,{sheetId:number;tableId:string}>)[b.surface];if(book.spreadsheetId!==b.spreadsheetId||binding?.sheetId!==b.sheetId||binding.tableId!==b.tableId)fail('input_configuration','An input surface differs from the reviewed native publisher.');}
    ctx.confirmationRead();
  }
  function work(value='pending'){properties.setProperty(INPUT_PROPERTIES.work,value);if(properties.getProperty(INPUT_PROPERTIES.work)!==value)fail('input_state','The input work marker did not persist.');}
  const idleMarker=(ctx:NonNullable<ReturnType<typeof context>>)=>'idle:'+ctx.signer.sha256(inputCanonical([ctx.config.generation,ctx.config.journalFileId]));
  function finish(ctx:NonNullable<ReturnType<typeof context>>,io:InputJournalPorts){work(Object.values(io.journal.entries).some(e=>!e.superseded&&e.commands.some(c=>c.status==='queued'||c.status==='committed'&&!c.applied)||e.superseded&&!e.supersededApplied)?'pending':idleMarker(ctx));}
  function ports(ctx:NonNullable<ReturnType<typeof context>>,session:NativeFrontendInputSession):InputJournalPorts{
    const store=ctx.journal(),journal=store.load();return{journal,state:session.state,saveJournal:value=>{work();store.save(value);},saveState:value=>session.save(value),sha256:text=>ctx.signer.sha256(text),send:(path,command)=>ctx.request(path,command),stillVisible(edit){
      const read=session.read(edit.surface),table=inputSurfaceState(session.state,edit.surface);assertImmutableInputSlots(table.baseline,read,edit.surface);return edit.drafts.every(d=>{const row=table.baseline.slots?.keys.indexOf(d.key),column=read.headers.indexOf(d.header);return row!==undefined&&row>=0&&column>=0&&inputCanonical(nativeInputValue(read.rows[row]?.[column]))===inputCanonical(d.value);});
    }};
  }
  function link(ctx:NonNullable<ReturnType<typeof context>>,edit:CapturedFrontendEdit){const b=ctx.config.confirmation,f=services.FormApp.openById(b.formId),read=ctx.confirmationRead(),setup=ctx.setupReceipt();
    if(setup.confirmationShape!==ctx.signer.sha256(inputCanonical({items:read.items,settings:read.settings})))fail('input_confirmation','The confirmation Form changed after setup.');
    let response=f.createResponse();
    response=response.withItemResponse(f.getItemById(setup.confirmationNativeItems.reference).asTextItem().createResponse(edit.editId));
    response=response.withItemResponse(f.getItemById(setup.confirmationNativeItems.summary).asParagraphTextItem().createResponse(edit.summary));
    return response.toPrefilledUrl();
  }

  function status(entry:InputJournalEntry){return entry.superseded?'superseded':entry.commands.length?entry.commands.every(c=>c.applied)?'committed':entry.commands.some(c=>c.status==='conflict')?'conflict':entry.commands.some(c=>c.status==='rejected')?'rejected':'queued':'confirmation-required';}
  function updateNote(ctx:NonNullable<ReturnType<typeof context>>,entry:InputJournalEntry,io:InputJournalPorts){const s=status(entry);if(entry.superseded||entry.noteStatus===s)return;note(entry.edit.evidence,s==='committed'?'':s==='confirmation-required'?`SHAMROCK: Review and confirm these frozen changes: ${link(ctx,entry.edit)}`:s==='queued'?'SHAMROCK: Saved for delivery. Keep this input while processing finishes.':'SHAMROCK: This change was not saved. The record or your authority changed; ask Wing staff to review the retained draft.');entry.noteStatus=s;io.saveJournal(io.journal);}
  function recoverUnclaimed(ctx:NonNullable<ReturnType<typeof context>>,session:NativeFrontendInputSession,io:InputJournalPorts){
    const candidates=ctx.config.surfaces.flatMap(binding=>inputSurfaceState(session.state,binding.surface).drafts.map(draft=>({binding,draft}))).filter(({binding,draft})=>!Object.values(io.journal.entries).some(e=>!e.superseded&&e.edit.surface===binding.surface&&e.edit.drafts.some(d=>inputCanonical(d)===inputCanonical(draft)))).slice(0,10);
    if(!candidates.length)return;
    const response=ctx.request('/v1/admin/snapshot',{environment:'staging',generation:ctx.config.generation,principalId:session.config.principalId});if(response.status!==200)fail('input_snapshot','The recovery context is unavailable.');
    for(const {binding,draft} of candidates){const table=inputSurfaceState(session.state,binding.surface),read=session.read(binding.surface),row=table.baseline.slots?.keys.indexOf(draft.key),column=read.headers.indexOf(draft.header),heldId=`recovery.${ctx.signer.sha256(inputCanonical({binding,draft}))}`;
      try{if(row===undefined||row<0||column<0)fail('input_slots','The retained draft has no physical input slot.');
        const event:NativeEditEvidence={spreadsheetId:binding.spreadsheetId,sheetId:binding.sheetId,row:row+3,column:column+1,rows:1,columns:1,triggerUid:'retained-draft-recovery'};
        const edit=captureFrontendEdit({event,binding,baseline:table.baseline,drafts:table.drafts,current:read,snapshot:response.body,principals:ctx.config.principals,config:session.adapter,signer:ctx.signer,providerCoordinatesVerified:false,automationEmail:ctx.owner});
        if(edit.status!=='noop'){const entry=retainCapturedInput(io,edit,[]);updateNote(ctx,entry,io);}delete io.journal.held?.[heldId];
      }catch(error){io.journal.held??={};io.journal.held[heldId]={event:{surface:binding.surface,key:draft.key,header:draft.header},issue:error instanceof AdapterError?error.code:'input-review'};}
    }
    io.saveJournal(io.journal);
  }
  function sessionRun(operation:(ctx:NonNullable<ReturnType<typeof context>>,session:NativeFrontendInputSession)=>unknown){const ctx=context();if(!ctx||!ctx.enabled())return{status:'paused'};
    return frontend.inputSession(session=>{if(!ctx.enabled()||services.scheduled&&!services.scheduled.availability(session.config.principalId).acceptingCommands)return{status:'paused'};checkSession(ctx,session);ctx.setupReceipt();return operation(ctx,session);});}
  return{
    applyControl(){const ctx=context(),request=ctx?.config.controlRequest;if(!ctx||!request)return{status:'none'};
      if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.requestId)||!Number.isSafeInteger(request.sequence)||request.sequence<1||!['setup','resume','pause'].includes(request.action)
        ||![request.frontendSha256,request.journalSha256].every(h=>/^[a-f0-9]{64}$/.test(h))||Object.keys(request).sort().join(',')!=='action,frontendSha256,journalSha256,requestId,sequence')fail('input_control','Use an exact reviewed private input control request.');
      const prior=properties.getProperty(INPUT_PROPERTIES.controlReceipt);if(prior===inputCanonical(request))return{status:'already-consumed'};
      if(prior){const p=JSON.parse(prior);if(p.sequence>=request.sequence||p.requestId===request.requestId)fail('input_control','A consumed input control request cannot be reused.');}
      let consumed=false;frontend.inputSession(session=>{checkSession(ctx,session);
        if(ctx.signer.sha256(inputCanonical(session.state))!==request.frontendSha256||ctx.signer.sha256(inputCanonical(ctx.journal().load()))!==request.journalSha256)fail('input_control','The private input checkpoints changed after review.');
        pause();properties.setProperty(INPUT_PROPERTIES.controlReceipt,inputCanonical(request));if(properties.getProperty(INPUT_PROPERTIES.controlReceipt)!==inputCanonical(request))fail('input_control','Input control consumption did not persist.');consumed=true;
      },{allowPaused:true});
      if(!consumed)return{status:'waiting-frontend'};
      if(request.action==='setup')return this.setup();if(request.action==='resume')return this.resume();return this.pause();
    },
    pause,
    setup(){pause();work();const ctx=context();if(!ctx)fail('input_configuration','Configure the isolated input resources first.');let verified=false;frontend.inputSession(session=>{
        checkSession(ctx,session);
        if(ctx.config.surfaces.some(b=>inputSurfaceState(session.state,b.surface).drafts.length))fail('input_slots','Resolve all frozen frontend drafts before establishing input slots.');
        session.fence();try{
          for(const binding of ctx.config.surfaces){const table=inputSurfaceState(session.state,binding.surface);table.set({baseline:bindImmutableInputSlots({baseline:table.baseline,current:session.read(binding.surface),keyHeader:binding.surface==='leadership'?'contact_id':['blue','gold'].includes(binding.surface)?'request_id':'person_id',editFenceVerified:true}),drafts:[]});}
          session.save(session.state);session.restore();verified=true;
        }catch(error){frontend.pause();throw error;}
      },{allowPaused:true});if(!verified)fail('input_configuration','Verify the native frontend surfaces before installing input triggers.');const lock=services.LockService.getScriptLock();if(!lock.tryLock(25000))fail('input_busy','Another adapter operation is active.');try{
      const confirmation=ctx.confirmationRead(),nativeItems=services.FormApp.openById(ctx.config.confirmation.formId).getItems(),confirmationNativeItems:Record<string,number>={};
      if(nativeItems.length!==confirmation.items.length)fail('input_confirmation','Native and API confirmation item lists differ.');
      for(const field of ['reference','summary','action'] as const){const i=confirmation.items.findIndex((item:any)=>item.itemId===ctx.config.confirmation[field].itemId),native=nativeItems[i];
        if(!native||native.getIndex()!==i||native.getTitle()!==(confirmation.items[i].title??'')||!Number.isSafeInteger(native.getId()))fail('input_confirmation','Native confirmation item identity changed during setup.');confirmationNativeItems[field]=native.getId();}
      ctx.journal().load();const ids:Record<string,string>={};const books=[...new Set(ctx.config.surfaces.map(s=>s.spreadsheetId))];
      for(const trigger of services.ScriptApp.getProjectTriggers())if(Object.values(INPUT_HANDLERS).includes(trigger.getHandlerFunction())&&!([...books,ctx.config.confirmation.formId].includes(trigger.getTriggerSourceId())))services.ScriptApp.deleteTrigger(trigger);
      for(const target of [...books.map(id=>({id,handler:INPUT_HANDLERS.edit,kind:'sheet'})),{id:ctx.config.confirmation.formId,handler:INPUT_HANDLERS.confirmation,kind:'form'}]){
        for(const t of services.ScriptApp.getProjectTriggers().filter((t:any)=>t.getHandlerFunction()===target.handler&&t.getTriggerSourceId()===target.id)){
          const valid=t.getEventType()===(target.kind==='sheet'?services.ScriptApp.EventType.ON_EDIT:services.ScriptApp.EventType.ON_FORM_SUBMIT)&&t.getTriggerSource()===(target.kind==='sheet'?services.ScriptApp.TriggerSource.SPREADSHEETS:services.ScriptApp.TriggerSource.FORMS);
          if(valid&&!ids[target.id])ids[target.id]=t.getUniqueId();else services.ScriptApp.deleteTrigger(t);
        }
        if(!ids[target.id]){const builder=services.ScriptApp.newTrigger(target.handler);ids[target.id]=(target.kind==='sheet'?builder.forSpreadsheet(target.id).onEdit():builder.forForm(target.id).onFormSubmit()).create().getUniqueId();}
      }
      const finalShape=ctx.confirmationRead();if(inputCanonical({items:confirmation.items,settings:confirmation.settings})!==inputCanonical({items:finalShape.items,settings:finalShape.settings}))fail('input_confirmation','The confirmation Form changed during setup.');
      properties.setProperty(INPUT_PROPERTIES.setup,JSON.stringify({fingerprint:ctx.fingerprint,ids,confirmationNativeItems,confirmationShape:ctx.signer.sha256(inputCanonical({items:confirmation.items,settings:confirmation.settings}))}));ctx.setupReceipt();return{status:'ready-paused',triggers:Object.keys(ids).length};
    }finally{lock.releaseLock();}},
    resume(){const ctx=context();if(!ctx||!ctx.config.enabled)fail('input_configuration','Enable the reviewed private input configuration first.');ctx.confirmationRead();ctx.setupReceipt();let verified=false;frontend.inputSession(session=>{checkSession(ctx,session);verified=true;});if(!verified)fail('input_configuration','The frontend is paused or unavailable.');properties.deleteProperty(INPUT_PROPERTIES.pause);if(properties.getProperty(INPUT_PROPERTIES.pause)!==null)fail('input_pause','Input did not resume.');return{status:'enabled'};},
    onEdit(event:any){const evidence=snapshotNativeEdit(event);return sessionRun((ctx,session)=>{
      const b=ctx.config.surfaces.find(s=>s.spreadsheetId===evidence.spreadsheetId&&s.sheetId===evidence.sheetId);if(!b)return{status:'ignored'};
      if(ctx.setupReceipt().ids[b.spreadsheetId]!==evidence.triggerUid)fail('input_identity','Unexpected native edit trigger.');const io=ports(ctx,session);
      try{
        const initial=session.read(b.surface);const captureSequence=supersedeUnattemptedInput(io,b.surface,evidence,initial);deliverFrontendInputs(io);const table=inputSurfaceState(session.state,b.surface),read=session.read(b.surface);
        const result=ctx.request('/v1/admin/snapshot',{environment:'staging',generation:ctx.config.generation,principalId:session.config.principalId});if(result.status!==200)fail('input_snapshot','The coherent input context is unavailable.');
        const review=ctx.config.providerReview,verified=Boolean(review?.reviewId&&review.bindingsSha256===ctx.signer.sha256(inputCanonical(ctx.config.surfaces))&&review.filterViewCoordinatesVerified===true&&review.protectedSortDenied===true);
        const edit=captureFrontendEdit({event:evidence,binding:b,baseline:table.baseline,drafts:table.drafts,current:read,snapshot:result.body,principals:ctx.config.principals,config:session.adapter,signer:ctx.signer,providerCoordinatesVerified:verified,automationEmail:ctx.owner,captureSequence});
        if(edit.status==='noop'){note(evidence,'');finish(ctx,io);return{status:'noop'};}
        const entry=retainCapturedInput(io,edit,edit.status==='ready'?commandsForCapturedEdit({edit,principals:ctx.config.principals}):[]);deliverFrontendInputs(io);updateNote(ctx,entry,io);finish(ctx,io);return{status:status(entry),editId:edit.editId};
      }catch(error){const issue=error instanceof AdapterError?error.code:'input-review';io.journal.held??={};io.journal.held[services.Utilities.getUuid()]={event:copy(evidence),issue};io.saveJournal(io.journal);note(evidence,'SHAMROCK: This edit was retained for review and was not confirmed as saved. Ask Wing staff to resolve the original version before retrying.');throw error;}
    });},
    flush(options:{force?:boolean}={}){this.applyControl();const configured=context();if(!configured||!configured.enabled())return{status:'paused'};
      if(services.scheduled&&!services.scheduled.reconcile&&!options.force&&properties.getProperty(INPUT_PROPERTIES.work)===idleMarker(configured))return{status:'idle',attempted:0};
      return sessionRun((ctx,session)=>{const io=ports(ctx,session);recoverUnclaimed(ctx,session,io);const result=deliverFrontendInputs(io);for(const entry of Object.values(io.journal.entries))updateNote(ctx,entry,io);finish(ctx,io);return result;});},
    confirm(event:any){const sourceId=String(event.source.getId()),responseId=String(event.response.getId()),trigger=String(event.triggerUid??'');return sessionRun((ctx,session)=>{
      const b=ctx.config.confirmation;if(sourceId!==b.formId||ctx.setupReceipt().ids[sourceId]!==trigger)fail('input_identity','Unexpected confirmation trigger.');
      const native=api(`${form(b.formId)}/responses/${encodeURIComponent(responseId)}`);if(native.formId!==b.formId||native.responseId!==responseId||!native.respondentEmail||!Number.isFinite(Date.parse(native.lastSubmittedTime)))fail('input_confirmation','Verified native confirmation identity is missing.');
      const answer=(id:string)=>{const a=native.answers?.[id];if(a?.questionId!==id||a.textAnswers?.answers?.length!==1||typeof a.textAnswers.answers[0].value!=='string')fail('input_confirmation','A frozen confirmation answer is missing.');return a.textAnswers.answers[0].value;};
      const reference=answer(b.reference.questionId),summary=answer(b.summary.questionId),action=answer(b.action.questionId),io=ports(ctx,session),entry=io.journal.entries[reference];
      if(!entry||entry.superseded)fail('input_confirmation','The referenced frozen edit is unavailable or was replaced before dispatch.');
      const commands=commandsForCapturedEdit({edit:entry.edit,principals:ctx.config.principals,confirmation:{verified:true,verifiedEmail:native.respondentEmail,reference,summary,action}});
      if(entry.commands.length&&inputCanonical(entry.commands.map(c=>c.command))!==inputCanonical(commands))fail('input_confirmation','A dispatched edit cannot change its confirmed actor or command.');
      if(!entry.commands.length){entry.commands=commands.map((command,templateIndex)=>({command,templateIndex,status:'queued',attempted:false}));entry.confirmation={responseId,submittedAt:native.lastSubmittedTime,email:native.respondentEmail};io.saveJournal(io.journal);}
      deliverFrontendInputs(io);updateNote(ctx,entry,io);finish(ctx,io);return{status:status(entry),editId:reference};
    });},
    reviewQueue(){const ctx=context();if(!ctx)fail('input_configuration','Input is not configured.');const email=services.Session.getActiveUser().getEmail().trim().toLowerCase(),actor=ctx.config.principals.find(p=>p.email.toLowerCase()===email);if(!actor)fail('confirmation_required','Authenticate as a current Wing reviewer.');const result=ctx.request('/v1/admin/snapshot',{environment:'staging',generation:ctx.config.generation,principalId:actor.principalId});if(result.status!==200)fail('confirmation_required','Current Wing frontend authority is required.');return ctx.journal().load();},
    replayConfirmation(responseId:string){const ctx=context();if(!ctx||!ctx.enabled())return{status:'paused'};return this.confirm({source:{getId:()=>ctx.config.confirmation.formId},response:{getId:()=>responseId},triggerUid:ctx.setupReceipt().ids[ctx.config.confirmation.formId]});},
    status(){const ctx=context();if(!ctx)return{status:'disabled'};const journal=ctx.journal().load();return{enabled:ctx.enabled(),held:Object.keys(journal.held??{}).length,counts:Object.values(journal.entries).reduce((out,e)=>{const s=status(e);out[s]=(out[s]??0)+1;return out;},{} as Record<string,number>)};},
  };
}
