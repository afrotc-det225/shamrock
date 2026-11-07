import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac} from 'node:crypto';
import {createNativePermissionRuntime} from '../../.build/v3/apps/google-adapter/src/permissions-host.js';
import {createPermissionContext,parseNativePermissionConfig,permissionCanonical,PERMISSION_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/permissions-context.js';
import {PERMISSION_FENCE_PROPERTY} from '../../.build/v3/apps/google-adapter/src/permissions-refresh.js';
import {HOST_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/staging-host.js';
const clone=v=>structuredClone(v),sha=v=>createHash('sha256').update(v).digest('hex'),owner='automation@example.invalid',secret='fictional-native-permission-secret-never-deployed';
const policy={policyVersion:'det225-leadership-permissions-v1',members:[],accounts:[{principalId:'manager',personId:null,email:'manager@example.invalid',active:true}],accessGrants:[],adminGrants:[],google:{permissionManagers:['manager@example.invalid'],leadershipEditors:['leader@example.invalid'],attendanceEditors:['leader@example.invalid'],squadronCommanders:[{squadronId:'blue',email:'blue@example.invalid'}],excusalViewers:['leader@example.invalid']},diagnostics:[]};
function fixture(){
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fictional',expectedAutomationEmail:owner,journal:{spreadsheetId:'transport',sheetId:1},attendance:{formId:'attendance-form',resourceKey:'source',itemRoles:{event:'event',scope:'scope',present:['cadets'],completeness:'complete'}}};
 const config={version:1,environment:'staging',generation:1,enabled:true,resourceReview:'NATIVE_PERMISSION_POLICY_REVIEWED_FOR_STAGING',workerId:'permission-worker',principalId:'publisher',stateFileId:'permission-state',mainReaders:[],excusalReaders:[],forbiddenSpreadsheetIds:['production-book']};
 const files={'permission-config':config,'permission-state':{version:1,environment:'staging',generation:1}};
 const props={[HOST_PROPERTIES.config]:JSON.stringify(host),[HOST_PROPERTIES.secret]:secret,[PERMISSION_PROPERTIES.config]:JSON.stringify({version:1,configFileId:'permission-config'})};
 const sharing=Object.fromEntries(['main','excusals'].map(id=>[id,[{id:'owner',type:'user',role:'owner',emailAddress:owner},{id:'old',type:'user',role:'writer',emailAddress:'old@example.invalid'}]]));
 const metadata=Object.fromEntries(['main','excusals'].map(id=>[id,{sheets:[{properties:{sheetId:1,gridProperties:{rowCount:10,columnCount:5}},protectedRanges:[]}]}]));
 let seq=1,revision=0,verifiedFence=false,receipt,job=null,done=false,lost=false;const calls=[];
 const response=(body,status=200)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
 const access={ownerEmail:owner,automationEmail:owner,supportEditors:[],directoryEditors:[],leadershipEditors:[],attendanceEditors:[],squadronCommanders:[]};
 const session={automationEmail:owner,config:{generation:1,stateFileId:'frontend-state',main:{spreadsheetId:'main'},access,supplemental:{enabled:true,excusals:{spreadsheetId:'excusals',access}}},protectionInput(id){return{metadata:clone(metadata[id]),surfaces:[{sheetId:1,kind:id==='main'?'leadership':'excusal',headers:id==='main'?['assignment_id','role','email','office_phone']:['request_id','decision'],...(id==='excusals'?{squadronId:'blue'}:{}),dataEndRow:4,gridRowCount:10,gridColumnCount:5}],access};}};
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];}})},Session:{getEffectiveUser:()=>({getEmail:()=>owner})},ScriptApp:{getOAuthToken:()=> 'fictional-oauth'},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()]},nowSeconds:()=>1793966400,
 UrlFetchApp:{fetch(url,options){const u=new URL(url),body=options.payload?JSON.parse(options.payload):undefined;calls.push({url,method:options.method});
  if(u.hostname==='worker.example.invalid'){
   assert.equal(options.headers['x-shamrock-signature'],createHmac('sha256',secret).update(`POST\n${u.pathname}\n${options.headers['x-shamrock-timestamp']}\n${sha(options.payload)}`).digest('hex'));
   if(u.pathname.endsWith('/commands')){
    if(receipt)return response(receipt);if(!verifiedFence)return response({error:{code:'PERMISSION_FENCE_REQUIRED'}},409);
    assert(props[PERMISSION_FENCE_PROPERTY]);revision=1;job={jobId:'permissions.1',version:1,claimToken:'claim-one',leaseExpiresAt:'2099-01-01T00:00:00.000Z'};receipt={commandId:body.commandId,status:'committed',version:1};if(lost){lost=false;throw Error('committed response lost');}return response(receipt);
   }
   assert.equal(body.principalId,'publisher');
   if(u.pathname.endsWith('/fence')){assert(props[PERMISSION_FENCE_PROPERTY]);assert(files['permission-state'].pendingChange?.providerEvidence);assert.equal(body.payloadSha256,sha(JSON.stringify(files['command'])));verifiedFence=true;return response({commandId:body.commandId,expiresAt:'2099-01-01T00:00:00.000Z'});}
   if(u.pathname.endsWith('/status'))return response({enabled:revision>0,version:revision,policyHash:sha(JSON.stringify(policy)),policy:JSON.stringify(policy),applied:done||revision===0});
   if(u.pathname.endsWith('/claim'))return response({job:done?null:job});
   if(u.pathname.endsWith('/project'))return response({version:1,current:true,policyHash:sha(JSON.stringify(policy)),policy});
   if(u.pathname.endsWith('/ack')){assert(files['permission-state'].applied);done=true;return response({acknowledged:true,version:1,current:true});}
   assert.fail(u.pathname);
  }
  assert.equal(options.headers.Authorization,'Bearer fictional-oauth');
  if(u.hostname==='sheets.googleapis.com'){
   const id=u.pathname.split('/').at(-1).split(':')[0];for(const r of body.requests){if(r.addProtectedRange)metadata[id].sheets[0].protectedRanges.push({...clone(r.addProtectedRange.protectedRange),protectedRangeId:seq++});else if(r.updateProtectedRange){const p=r.updateProtectedRange.protectedRange;Object.assign(metadata[id].sheets[0].protectedRanges.find(v=>v.protectedRangeId===p.protectedRangeId),clone(p));}else if(r.deleteProtectedRange)metadata[id].sheets[0].protectedRanges=metadata[id].sheets[0].protectedRanges.filter(p=>p.protectedRangeId!==r.deleteProtectedRange.protectedRangeId);else assert.fail('Permission host must not write business cells');}return response({});
  }
  const parts=u.pathname.split('/'),fileIndex=parts.indexOf('files'),id=parts[fileIndex+1];
  if(parts[fileIndex+2]==='permissions'){
   if(options.method==='delete'){sharing[id]=sharing[id].filter(p=>p.id!==parts[fileIndex+3]);return response({});}
   if(options.method==='post'){assert.equal(u.searchParams.get('sendNotificationEmail'),'false');sharing[id].push({id:'permission-'+seq++,...body});return response({id:'created'});}
   return response({permissions:clone(sharing[id])});
  }
  if(options.method==='patch'){assert.equal(id,'permission-state');files[id]=clone(body);return response({id});}
  if(u.searchParams.get('alt')==='media')return response(clone(files[id]));
  return response({id,mimeType:files[id]?'application/json':'application/vnd.google-apps.spreadsheet',size:JSON.stringify(files[id]??{}).length,version:String(seq),owners:[{emailAddress:owner}],permissions:files[id]?[{type:'user',role:'owner',emailAddress:owner}]:clone(sharing[id])});
 }}};
 const frontend={permissionSession:fn=>fn(session)},runtime=()=>createNativePermissionRuntime(services,frontend);
 function control(action,extra={}){config.controlRequest={requestId:'control-'+seq++,sequence:seq,action,stateSha256:sha(permissionCanonical(files['permission-state'])),...extra};return runtime().applyControl();}
 return {files,props,config,calls,sharing,metadata,services,runtime,control,get state(){return files['permission-state'];},loseNextReceipt(){lost=true;}};
}
test('private setup/enable/command/refresh controls wire the complete signed native permission path without cell writes',()=>{
 const f=fixture();assert.equal(f.control('setup').status,'setup-paused');assert.equal(f.props[PERMISSION_PROPERTIES.pause],'true');assert.equal(f.control('resume').status,'ready');
 f.files.command={environment:'staging',generation:1,principalId:'manager',commandId:'enable-one',expectedVersion:0,accounts:[],revokePrincipalIds:[],operationalSquadronIds:['blue']};
 assert.equal(f.control('command',{commandFileId:'command',commandSha256:sha(permissionCanonical(f.files.command))}).status,200);assert(f.props[PERMISSION_FENCE_PROPERTY]);assert(f.state.pendingChange.receipt);
 assert.equal(f.control('resume').status,'ready');assert.equal(f.runtime().refresh().status,'complete');assert.equal(f.props[PERMISSION_FENCE_PROPERTY],undefined);assert.equal(f.state.applied.version,1);
 assert.equal(f.sharing.main.some(p=>p.emailAddress==='old@example.invalid'),false);assert.equal(f.sharing.excusals.find(p=>p.emailAddress==='leader@example.invalid').role,'reader');
 const applied=createPermissionContext(f.services).applied();assert.equal(applied.policy.accounts[0].principalId,'manager');const before=f.calls.length;assert.equal(f.runtime().refresh().status,'idle');assert.equal(f.calls.slice(before).some(c=>c.url.includes('sheets.googleapis.com')),false);
});
test('ambiguous command acceptance resumes the same reviewed control using its durable checkpoint and receipt',()=>{
 const f=fixture();f.control('setup');f.files.command={environment:'staging',generation:1,principalId:'manager',commandId:'enable-lost',expectedVersion:0,accounts:[],revokePrincipalIds:[],operationalSquadronIds:['blue']};f.loseNextReceipt();
 assert.throws(()=>f.control('command',{commandFileId:'command',commandSha256:sha(permissionCanonical(f.files.command))}),/lost/);assert(f.props[PERMISSION_FENCE_PROPERTY]);assert(!f.state.pendingChange.receipt);
 assert.equal(f.runtime().applyControl().status,200);assert(f.state.pendingChange.receipt);assert.equal(f.runtime().applyControl().status,'already-consumed');
});
test('permission controls cannot replay old resumes, bypass generation/ACL or silently accept config changes',()=>{
 const f=fixture();f.control('setup');f.control('resume');f.runtime().pause();assert.equal(f.runtime().applyControl().status,'already-consumed');assert.equal(f.props[PERMISSION_PROPERTIES.pause],'true');
 assert.throws(()=>parseNativePermissionConfig({...f.config,generation:2},1));assert.throws(()=>parseNativePermissionConfig({...f.config,untrusted:true},1));
 f.config.stateFileId='changed-private-state';f.files['changed-private-state']={version:1,environment:'staging',generation:1};assert.throws(()=>f.control('resume'),/exact permission setup/);
});
