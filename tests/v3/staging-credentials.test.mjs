import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importStagingCredential,CREDENTIAL_IMPORT_PROPERTY as C} from '../../.build/v3/apps/google-adapter/src/staging-credentials.js';
function fixture(){
 const owner='automation@example.invalid',now=1800000000,secret='fixture-staging-bridge-material-private';
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://stage.example.invalid',keyId:'stage-key',expectedAutomationEmail:owner,journal:{spreadsheetId:'journal',sheetId:1},attendance:{formId:'attendance',resourceKey:'attendance',itemRoles:{event:'1',scope:'2',present:['3'],completeness:'4'}}};
 const pointer={version:1,fileId:'delivery',requestId:'reviewed-key-import',sequence:1},root={[C]:JSON.stringify(pointer)};
 const delivery={version:1,environment:'staging',generation:1,requestId:pointer.requestId,targetProperty:'SHAMROCK_V3_BRIDGE_SECRET',workerOrigin:host.workerOrigin,keyId:host.keyId,secret,expiresAt:now+600};
 const f={root,delivery,secret,active:owner,owner,shared:false,trashed:false,version:1,drift:false,lost:false,ignore:false,fetches:0,props:{SHAMROCK_V3_HOST_CONFIG:JSON.stringify(host),SHAMROCK_V3_CONFIG_FILE_ID:'root'},released:0};
 const s={PropertiesService:{getScriptProperties:()=>({getProperty:k=>f.props[k]??null,setProperty:(k,v)=>{if(!f.ignore||k!=='SHAMROCK_V3_BRIDGE_SECRET')f.props[k]=v;}})},Session:{getEffectiveUser:()=>({getEmail:()=>owner}),getActiveUser:()=>({getEmail:()=>f.active})},ScriptApp:{getOAuthToken:()=> 'fixture-token'},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>f.released++})},UrlFetchApp:{fetch(raw,options){f.fetches++;const u=new URL(raw),id=u.pathname.split('/').at(-1);assert.ok(['root','delivery'].includes(id));let data;
  if(options.method==='patch'){assert.equal(id,'delivery');assert.deepEqual(JSON.parse(options.payload),{trashed:true});f.trashed=true;if(f.lost){f.lost=false;throw Error('lost trash response');}data={id,trashed:true};}
  else if(u.searchParams.get('alt')==='media'){data=id==='root'?root:delivery;if(id==='delivery'&&f.drift)f.version++;}
  else data={id,mimeType:'application/json',size:String(JSON.stringify(id==='root'?root:delivery).length),version:String(f.version),trashed:id==='delivery'&&f.trashed,owners:[{emailAddress:f.owner}],permissions:[{type:'user',role:'owner',emailAddress:f.owner},...(f.shared?[{type:'anyone',role:'reader'}]:[])]};
  return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};
 }},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_algorithm,value)=>Array.from(createHash('sha256').update(value).digest())}};f.run=()=>importStagingCredential(s,()=>now);return f;
}
test('private key delivery verifies owner and target, pauses all processing, verifies Script Properties and trashes delivery',()=>{
 const f=fixture();assert.deepEqual(f.run(),{status:'imported-paused'});assert.equal(f.props.SHAMROCK_V3_BRIDGE_SECRET,f.secret);assert.equal(f.trashed,true);assert.equal(f.props.SHAMROCK_V3_ENABLED,'false');assert.equal(f.props.SHAMROCK_V3_OWNER_MAIL_PAUSED,'true');assert.equal(f.props.SHAMROCK_V3_HISTORY_PAUSED,'true');assert.ok(!f.props.SHAMROCK_V3_CREDENTIAL_IMPORT_RECEIPT.includes(f.secret));assert.deepEqual(f.run(),{status:'already-imported-paused'});assert.equal(f.released,2);
});
test('shared or changed files, missing human owner, stale/oversized expiry and wrong target never set a key',()=>{
 for(const change of [f=>f.shared=true,f=>f.owner='stranger@example.invalid',f=>f.active='',f=>f.drift=true,f=>f.delivery.expiresAt=1800000000,f=>f.delivery.expiresAt=1800004000,f=>f.delivery.workerOrigin='https://other.example.invalid',f=>f.delivery.targetProperty='UNBOUND_SECRET',f=>f.delivery.environment='production',f=>f.delivery.generation=2,f=>f.delivery.extra='not allowed']){
  const f=fixture();change(f);assert.throws(()=>f.run());assert.equal(f.props.SHAMROCK_V3_BRIDGE_SECRET,undefined);assert.equal(f.trashed,false);assert.equal(f.props.SHAMROCK_V3_ENABLED,'false');
 }
});
test('separate history key must match exactly its reviewed optional reader binding',()=>{
 const f=fixture();f.delivery.targetProperty='SHAMROCK_V3_HISTORY_READER_SECRET';f.delivery.workerOrigin='https://history.example.invalid';f.delivery.keyId='history-key';f.root.SHAMROCK_V3_HISTORY_CONFIG=JSON.stringify({api:{secretProperty:f.delivery.targetProperty,baseUrl:f.delivery.workerOrigin,keyId:f.delivery.keyId}});f.run();assert.equal(f.props.SHAMROCK_V3_BRIDGE_SECRET,undefined);assert.equal(f.props.SHAMROCK_V3_HISTORY_READER_SECRET,f.secret);
});
test('lost cleanup response resumes only cleanup and consumed requests cannot be rebound',()=>{
 const f=fixture();f.lost=true;assert.throws(()=>f.run(),/lost trash/);assert.equal(f.props.SHAMROCK_V3_BRIDGE_SECRET,f.secret);assert.deepEqual(f.run(),{status:'already-imported-paused'});
 const pointer=JSON.parse(f.root[C]);pointer.requestId='different-review';f.root[C]=JSON.stringify(pointer);assert.throws(()=>f.run());
 const g=fixture();g.ignore=true;assert.throws(()=>g.run());assert.equal(g.trashed,false);assert.equal(g.props.SHAMROCK_V3_CREDENTIAL_IMPORT_RECEIPT,undefined);
});
test('cleanup retry rejects a missing or changed installed key and a rebound host or History reader',()=>{
 for(const change of [f=>delete f.props.SHAMROCK_V3_BRIDGE_SECRET,f=>f.props.SHAMROCK_V3_BRIDGE_SECRET='replacement-credential-material-needs-review',f=>{const h=JSON.parse(f.props.SHAMROCK_V3_HOST_CONFIG);h.keyId='new-key';f.props.SHAMROCK_V3_HOST_CONFIG=JSON.stringify(h);},f=>{const h=JSON.parse(f.props.SHAMROCK_V3_HOST_CONFIG);h.workerOrigin='https://renamed.example.invalid';f.props.SHAMROCK_V3_HOST_CONFIG=JSON.stringify(h);}]){const f=fixture();f.run();change(f);assert.throws(()=>f.run());assert.equal(f.props.SHAMROCK_V3_ENABLED,'false');}
 const f=fixture();f.delivery.targetProperty='SHAMROCK_V3_HISTORY_READER_SECRET';f.root.SHAMROCK_V3_HISTORY_CONFIG=JSON.stringify({api:{secretProperty:f.delivery.targetProperty,baseUrl:f.delivery.workerOrigin,keyId:f.delivery.keyId}});f.run();delete f.root.SHAMROCK_V3_HISTORY_CONFIG;assert.throws(()=>f.run());
});

test('native-only host uses the same private credential delivery without legacy resource bindings',()=>{
 const f=fixture(),host=JSON.parse(f.props.SHAMROCK_V3_HOST_CONFIG);delete host.journal;delete host.attendance;host.mode='native-only';f.props.SHAMROCK_V3_HOST_CONFIG=JSON.stringify(host);
 assert.deepEqual(f.run(),{status:'imported-paused'});assert.equal(f.props.SHAMROCK_V3_BRIDGE_SECRET,f.secret);assert.equal(f.trashed,true);assert.equal(f.props.SHAMROCK_V3_ENABLED,'false');
});
