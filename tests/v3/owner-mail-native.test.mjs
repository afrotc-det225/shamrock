import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createNativeOwnerMailRuntime,OWNER_MAIL_PROPERTIES,parseNativeOwnerMailConfig} from '../../.build/v3/apps/google-adapter/src/owner-mail-native.js';
import {HOST_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/staging-host.js';
const copy=structuredClone,sha=v=>createHash('sha256').update(v).digest('hex'),canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const owner='owner@example.invalid',secret='fictional-owner-mail-key-never-deployed',reviewHash='a'.repeat(64);
function fixture(){
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fictional',expectedAutomationEmail:owner,journal:{spreadsheetId:'transport',sheetId:1},attendance:{formId:'attendance-form',resourceKey:'source',itemRoles:{event:'event',scope:'scope',present:['cadets'],completeness:'complete'}}};
 const config={version:1,environment:'staging',generation:1,enabled:true,resourceReview:'OWNER_ONLY_MAIL_REHEARSAL_REVIEWED',principalId:'mail-principal',workerId:'mail-worker',stateFileId:'mail-state'};
 const files={'mail-config':config,'mail-state':{version:1,environment:'staging',generation:1}};
 const props={[HOST_PROPERTIES.config]:JSON.stringify(host),[HOST_PROPERTIES.secret]:secret,[OWNER_MAIL_PROPERTIES.config]:JSON.stringify({version:1,configFileId:'mail-config'})};
 const f={files,props,config,calls:[],sends:[],now:1800000000,version:1,seq:0,shared:false,owner,workerOwner:owner,quota:100,lostClaim:false,lostAck:false,lostControl:false,terminalClaim:false,throwSend:false,lostDispatchResult:false,changedContent:false,misroute:false};
 const response=(body,status=200)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
 let prepared=false,receipt;
 const claim={attempted:true,mode:'owner-rehearsal',caseId:'case-one',attemptId:'attempt-one',claimToken:'token-one',expiresAt:new Date((f.now+600)*1000).toISOString(),message:{to:[owner],cc:[],subject:'[STAGING REHEARSAL] Fictional attendance',body:'Fictional rehearsal'}};
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{if(f.lostControl&&k===OWNER_MAIL_PROPERTIES.control){f.lostControl=false;throw Error('control receipt lost');}props[k]=v;},deleteProperty:k=>delete props[k]})},Session:{getEffectiveUser:()=>({getEmail:()=>f.owner})},ScriptApp:{getOAuthToken:()=> 'fictional-oauth'},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()]},nowSeconds:()=>f.now,
 MailApp:{getRemainingDailyQuota:()=>f.quota,sendEmail(message){assert.equal(files['mail-state'].delivery.phase,'dispatching');f.sends.push(copy(message));if(f.throwSend)throw Error('provider result lost');}},
 UrlFetchApp:{fetch(url,options){const u=new URL(url),body=options.payload?JSON.parse(options.payload):undefined;f.calls.push({path:u.pathname,body});
  if(u.hostname==='worker.example.invalid'){
   assert.equal(options.headers['x-shamrock-signature'],createHmac('sha256',secret).update(`POST\n${u.pathname}\n${options.headers['x-shamrock-timestamp']}\n${sha(options.payload)}`).digest('hex'));
   assert.equal(body.principalId,'mail-principal');assert.equal(body.environment,'staging');assert.equal(body.generation,1);
   if(u.pathname.endsWith('/prepare')){prepared=true;return response({caseId:body.caseId,state:'ready',reviewHash});}
   if(u.pathname.endsWith('/status'))return response({enabled:true,ownerEmail:f.workerOwner,case:prepared?{caseId:'case-one',reviewHash,state:receipt?.state??'ready'}:null});
   if(u.pathname.endsWith('/claim')){assert.equal(body.reviewHash,reviewHash);if(f.terminalClaim)return response({attempted:false,caseId:'case-one',attemptId:'attempt-one',state:'uncertain'});if(f.lostClaim){f.lostClaim=false;throw Error('claim response lost');}const c=copy(claim);if(f.misroute)c.message.to=['cadet@example.invalid'];return response(c);}
   if(u.pathname.endsWith('/complete')){receipt={caseId:'case-one',attemptId:'attempt-one',state:body.outcome==='confirmed'?'sent':body.outcome==='known-not-sent'?'not-sent':'uncertain'};if(f.lostAck){f.lostAck=false;throw Error('ack response lost');}return response(receipt);}
   assert.fail(u.pathname);
  }
  assert.equal(options.headers.Authorization,'Bearer fictional-oauth');const id=u.pathname.split('/files/')[1].split('/')[0];
  if(options.method==='patch'){if(f.lostDispatchResult&&body.delivery?.phase==='result'){f.lostDispatchResult=false;throw Error('save interrupted');}files[id]=copy(body);f.version++;return response({id});}
  if(u.searchParams.get('alt')==='media'){if(f.changedContent&&files[id].delivery)files[id].externalEdit=true;return response(copy(files[id]));}
  return response({id,mimeType:'application/json',size:JSON.stringify(files[id]).length,version:String(f.version),owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner},...(f.shared?[{type:'anyone',role:'reader'}]:[])]});
 }}};
 f.runtime=()=>createNativeOwnerMailRuntime(services);
 f.control=(action,extra={})=>{config.controlRequest={requestId:'control-'+ ++f.seq,sequence:f.seq,action,stateSha256:sha(canonical(files['mail-state'])),...extra};return f.runtime().applyControl();};
 f.ready=()=>{assert.equal(f.control('setup').status,'setup-paused');assert.equal(f.control('prepare',{caseId:'case-one',noticeId:'notice-one',payloadHash:'b'.repeat(64)}).status,'prepared-paused');assert.equal(f.control('resume').status,'ready');};
 return f;
}
test('owner rehearsal remains opt-in and checkpoints its exact dispatch before one MailApp acceptance',()=>{
 const f=fixture();assert.equal(f.runtime().flush().status,'paused');assert.equal(f.calls.length,0);f.ready();assert.equal(f.runtime().flush().status,'sent');assert.equal(f.sends.length,1);assert.equal(f.sends[0].to,owner);assert.equal(f.sends[0].cc,undefined);assert.equal(f.sends[0].replyTo,undefined);assert.equal(f.props[OWNER_MAIL_PROPERTIES.pause],'true');assert.equal(f.runtime().flush().status,'paused');assert.equal(f.sends.length,1);assert(!f.files['mail-state'].delivery);assert.equal(f.files['mail-state'].receipt.state,'sent');
});
test('ambiguous claim and lost ACK reuse the same immutable identity without another provider send',()=>{
 const f=fixture();f.ready();f.lostClaim=true;assert.throws(()=>f.runtime().flush(),/claim response/);const claimId=f.files['mail-state'].delivery.claimId;
 f.lostAck=true;assert.throws(()=>f.runtime().flush(),/ack response/);assert.equal(f.sends.length,1);assert.equal(f.files['mail-state'].delivery.phase,'result');assert.equal(f.runtime().flush().status,'sent');assert.equal(f.sends.length,1);assert(f.calls.filter(c=>c.path.endsWith('/claim')).every(c=>c.body.claimId===claimId));
});
test('crash after dispatch and provider exceptions become terminal uncertainty, never an automatic retry',()=>{
 for(const mode of ['save','provider']){const f=fixture();f.ready();if(mode==='save'){f.lostDispatchResult=true;assert.throws(()=>f.runtime().flush(),/save interrupted/);assert.equal(f.files['mail-state'].delivery.phase,'dispatching');}else f.throwSend=true;
  assert.equal(f.runtime().flush().status,'uncertain');assert.equal(f.sends.length,1);assert.equal(f.files['mail-state'].receipt.state,'uncertain');assert.equal(f.runtime().flush().status,'paused');}
});
test('quota exhaustion proves no send and preserves a terminal no-send receipt',()=>{const f=fixture();f.ready();f.quota=0;assert.equal(f.runtime().flush().status,'not-sent');assert.equal(f.sends.length,0);});
test('owner mismatch, broad sharing, stale configuration and tampered recipients cannot reach MailApp',()=>{
 for(const change of [f=>f.owner='stranger@example.invalid',f=>f.workerOwner='stranger@example.invalid',f=>f.shared=true,f=>f.config.workerId='changed-worker',f=>f.misroute=true]){const f=fixture();f.ready();change(f);assert.throws(()=>f.runtime().flush());assert.equal(f.sends.length,0);}
 const f=fixture();assert.throws(()=>parseNativeOwnerMailConfig({...f.config,to:'cadet@example.invalid'},1));assert.throws(()=>parseNativeOwnerMailConfig({...f.config,environment:'production'},1));
});
test('consumed resume never unpauses a later manual pause and new controls bind the checkpoint hash',()=>{
 const f=fixture();f.ready();f.runtime().pause();assert.equal(f.runtime().applyControl().status,'already-consumed');assert.equal(f.props[OWNER_MAIL_PROPERTIES.pause],'true');f.config.controlRequest={...f.config.controlRequest,requestId:'changed',sequence:99,stateSha256:'0'.repeat(64)};assert.throws(()=>f.runtime().applyControl(),/changed after review/);assert.equal(f.sends.length,0);
});

test('interrupted prepare control reuses its exact review after the private checkpoint has advanced',()=>{
 const f=fixture();f.control('setup');f.lostControl=true;assert.throws(()=>f.control('prepare',{caseId:'case-one',noticeId:'notice-one',payloadHash:'b'.repeat(64)}),/control receipt lost/);
 assert.equal(f.files['mail-state'].review.reviewHash,reviewHash);assert.equal(f.runtime().applyControl().status,'prepared-paused');assert.equal(f.runtime().applyControl().status,'already-consumed');assert.equal(f.sends.length,0);
});
test('a recovered terminal claim and an expired provider lease never dispatch another message',()=>{
 for(const terminal of [true,false]){const f=fixture();f.ready();if(terminal)f.terminalClaim=true;else f.now+=601;
  assert.equal(f.runtime().flush().status,'uncertain');assert.equal(f.files['mail-state'].receipt.state,'uncertain');assert.equal(f.props[OWNER_MAIL_PROPERTIES.pause],'true');assert.equal(f.sends.length,0);
 }
});
