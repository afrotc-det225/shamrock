import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';
import {createInvocationConfigFetch} from '../../.build/v3/apps/google-adapter/src/invocation-cache.js';
import {runScheduledStaging,SCHEDULE_PROPERTIES} from '../../.build/v3/apps/google-adapter/src/scheduled-runtime.js';
const sha=s=>createHash('sha256').update(s).digest('hex'),canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const response=(x,status=200)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(x)});
function fixture(enabled=false){
 const owner='owner@example.invalid',now=1794000000;
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'legacy-journal',sheetId:1},attendance:{formId:'legacy-attendance',resourceKey:'attendance',itemRoles:{event:'event',scope:'scope',present:['present'],completeness:'complete'}}};
 const frontend={version:1,environment:'staging',generation:1,enabled,resourceReview:'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING',workerId:'publisher',principalId:'reader',stateFileId:'frontend-state',main:{spreadsheetId:'main',expectedTitle:'Main Staging',sheets:Object.fromEntries(['directory','leadership','attendance'].map((k,i)=>[k,{sheetId:i+1,tableId:k}]))},access:{ownerEmail:owner,automationEmail:owner},allowedFileEditors:[],seeds:[]};
 const forms={version:1,environment:'staging',generation:1,enabled,intakeEnabled:enabled,resourceReview:'EXISTING_FORMS_REVIEWED_FOR_STAGING',principalId:'reader',workerId:'forms',stateFileId:'form-state',intakeFileId:'form-intake',principals:[],forms:['attendance','excusals','directory'].map(key=>({key,formId:key,resourceKey:key,expectedTitle:`${key} Staging`,intake:{kind:key,formId:key,resourceKey:key}}))};
 const input={version:1,environment:'staging',generation:1,enabled,resourceReview:'EXISTING_INPUT_SURFACES_REVIEWED_FOR_STAGING',journalFileId:'input-journal',principals:[],surfaces:['directory','leadership','attendance','blue','gold'].map((surface,i)=>({surface,spreadsheetId:i<3?'main':'excusals',sheetId:i+1,tableId:surface,resourceKey:surface})),confirmation:{formId:'confirm',expectedTitle:'Confirm Staging'}};
 const root={SHAMROCK_V3_FRONTEND_CONFIG:JSON.stringify(frontend),SHAMROCK_V3_FORMS_CONFIG:JSON.stringify({version:1,configFileId:'forms-config'}),SHAMROCK_V3_INPUT_CONFIG:JSON.stringify({version:1,configFileId:'input-config'})};
 const docs={'root-config':root,'forms-config':forms,'input-config':input};
 const props={SHAMROCK_V3_HOST_CONFIG:JSON.stringify(host),SHAMROCK_V3_CONFIG_FILE_ID:'root-config',SHAMROCK_V3_BRIDGE_SECRET:'fictional-scheduler-key-long-enough-for-test',SHAMROCK_V3_ENABLED:'false',SHAMROCK_V3_MAINTENANCE_PAUSED:'true',SHAMROCK_V3_FORMS_PAUSED:enabled?'false':'true',SHAMROCK_V3_FORM_INTAKE_PAUSED:enabled?'false':'true',SHAMROCK_V3_INPUT_PAUSED:enabled?'false':'true',SHAMROCK_V3_FRONTEND_PAUSED:enabled?'false':'true',
  [SCHEDULE_PROPERTIES.reconciled]:String(Math.floor(now/3600)),[SCHEDULE_PROPERTIES.maintenance]:String(Math.floor(now/900)),SHAMROCK_V3_FORM_INTAKE_WORK:'idle:'+sha(canonical([1,'form-intake'])),SHAMROCK_V3_FORMS_WORK:'idle:'+sha(canonical([1,'form-state'])),SHAMROCK_V3_INPUT_WORK:'idle:'+sha(canonical([1,'input-journal']))};
 const fx={calls:[],owner,available:{acceptingCommands:true,frontendPending:false,frontendLeased:false,formsPending:false,formsLeased:false}};
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];}})},Session:{getEffectiveUser:()=>({getEmail:()=>owner}),getActiveUser:()=>({getEmail:()=>owner})},ScriptApp:{getOAuthToken:()=> 'fixture-oauth'},Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>[...createHash('sha256').update(s).digest()],computeHmacSha256Signature:(s,k)=>[...createHmac('sha256',k).update(s).digest()],getUuid:()=> 'fixture'},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},SpreadsheetApp:{},FormApp:{},UrlFetchApp:{fetch(url,options){fx.calls.push({url,method:options.method});if(url.startsWith(host.workerOrigin)){if(url.endsWith('/event-rosters/refresh'))return response({state:'review-required',pending:1});assert(url.endsWith('/availability'));const body=JSON.parse(options.payload);assert.equal(body.principalId,'reader');return response(fx.available);}
  assert.equal(options.method,'get');const u=new URL(url),id=u.pathname.split('/').at(-1);if(id==='permissions')return response({permissions:[{type:'user',role:'owner',emailAddress:fx.owner}]});assert(docs[id],`expensive idle request: ${id}`);if(id==='maintenance-archive'&&!u.searchParams.has('alt'))return response({id,name:'Private staging archives',mimeType:'application/vnd.google-apps.spreadsheet',size:100,version:'1',owners:[{emailAddress:fx.owner}]});return u.searchParams.get('alt')==='media'?response(docs[id]):response({id,name:id,mimeType:'application/json',size:100,version:'1',owners:[{emailAddress:fx.owner}],permissions:[{type:'user',role:'owner',emailAddress:fx.owner}]});
 }}};return{services,fx,props,root,forms,input,docs,now};
}
test('one paused configured timer shares config reads and never reads a journal, sheet or Worker',()=>{
 const f=fixture();const out=runScheduledStaging(f.services,()=>f.now);assert.equal(out.frontend.status,'disabled');assert.equal(out.formIntake.status,'paused');assert.equal(out.nativeInput.status,'paused');assert.equal(f.fx.calls.length,6);
 runScheduledStaging(f.services,()=>f.now+300);assert.equal(f.fx.calls.length,12);f.fx.owner='changed@example.invalid';assert.throws(()=>runScheduledStaging(f.services,()=>f.now+600));
});
test('enabled empty timer uses seven URL Fetch calls and one current-authority queue probe, not full snapshots',()=>{
 const f=fixture(true);const result=runScheduledStaging(f.services,()=>f.now);assert.equal(result.frontend.status,'idle');assert.equal(result.forms.status,'idle');assert.equal(result.formIntake.attempted,0);assert.equal(result.nativeInput.attempted,0);assert.equal(f.fx.calls.length,7);assert.equal(f.fx.calls.filter(c=>c.url.includes('worker.example')).length,1);
});
test('backend pause preserves retained work and avoids publication reads',()=>{
 const f=fixture(true);f.fx.available.acceptingCommands=false;f.fx.available.frontendLeased=true;f.fx.available.formsPending=true;
 f.props.SHAMROCK_V3_FORM_INTAKE_WORK='pending';f.props.SHAMROCK_V3_FORMS_WORK='pending';
 const out=runScheduledStaging(f.services,()=>f.now);assert.equal(out.frontend.status,'disabled');assert.equal(out.forms.status,'disabled');assert.equal(out.formIntake.status,'paused');
 assert.equal(f.props.SHAMROCK_V3_FORM_INTAKE_WORK,'pending');assert.equal(f.props.SHAMROCK_V3_FORMS_WORK,'pending');assert.equal(f.fx.calls.length,7);
});
test('a failed hourly reconciliation is retried and cannot advance its window marker',()=>{
 const f=fixture(true);f.props[SCHEDULE_PROPERTIES.reconciled]='older';
 assert.throws(()=>runScheduledStaging(f.services,()=>f.now));assert.equal(f.props[SCHEDULE_PROPERTIES.reconciled],'older');
 const before=f.fx.calls.length;assert.throws(()=>runScheduledStaging(f.services,()=>f.now+300));assert(f.fx.calls.length>before);assert.equal(f.props[SCHEDULE_PROPERTIES.reconciled],'older');
});
test('pending or retained work and periodic reconciliation cannot be skipped by a previous idle marker',()=>{
 for(const change of [f=>{f.fx.available.frontendPending=true;},f=>{f.fx.available.formsLeased=true;},f=>{f.props.SHAMROCK_V3_FORM_INTAKE_WORK='pending';},f=>{f.props.SHAMROCK_V3_INPUT_WORK='pending';},f=>{f.props[SCHEDULE_PROPERTIES.reconciled]='older';}]){
  const f=fixture(true);change(f);assert.throws(()=>runScheduledStaging(f.services,()=>f.now));assert(f.fx.calls.some(c=>/frontend-state|form-state|form-intake|main|attendance|input-journal/.test(c.url)),'must attempt actual checkpoint/isolation rather than report idle');
 }
});
test('config fetch cache excludes checkpoints and invalidates on Google mutation',()=>{
 let count=0;const fetcher={fetch:()=>{count++;return response({version:1});}},cached=createInvocationConfigFetch(fetcher,'root');
 cached.fetch('https://www.googleapis.com/drive/v3/files/root?alt=media',{method:'get'});cached.fetch('https://www.googleapis.com/drive/v3/files/root?alt=media',{method:'get'});assert.equal(count,1);
 cached.fetch('https://www.googleapis.com/drive/v3/files/state?alt=media',{method:'get'});cached.fetch('https://www.googleapis.com/drive/v3/files/state?alt=media',{method:'get'});assert.equal(count,3);
 cached.fetch('https://sheets.googleapis.com/v4/spreadsheets/book:batchUpdate',{method:'post'});cached.fetch('https://www.googleapis.com/drive/v3/files/root?alt=media',{method:'get'});assert.equal(count,5);
});

test('native MailApp availability alone leaves owner mail paused and adds no idle fetch calls',()=>{
 const f=fixture(true);f.services.MailApp={getRemainingDailyQuota(){assert.fail('unreviewed mail quota access');},sendEmail(){assert.fail('unreviewed provider send');}};
 const result=runScheduledStaging(f.services,()=>f.now);assert.equal(result.ownerMail.status,'paused');assert.equal(f.fx.calls.length,7);
});

test('unresolved managed future rosters defer publication and retain the hourly reconciliation marker',()=>{
 const f=fixture(true);f.props.SHAMROCK_V3_MAINTENANCE_PAUSED='false';f.props[SCHEDULE_PROPERTIES.reconciled]='older';
 f.root.SHAMROCK_V3_MAINTENANCE_CONFIG=JSON.stringify({version:1,environment:'staging',generation:1,enabled:true,rosterRefreshEnabled:true,resourceReview:'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING',principalId:'maintenance',workerId:'maintenance',sourceResource:'maintenance',stateFileId:'maintenance-state',archiveSpreadsheetId:'maintenance-archive',archiveExpectedTitle:'Private staging archives'});
 f.docs['maintenance-state']={version:1};f.docs['maintenance-archive']={version:1};
 // Intake is independently paused; this verifies the scheduler publication ordering.
 f.props.SHAMROCK_V3_FORM_INTAKE_PAUSED='true';
 const out=runScheduledStaging(f.services,()=>f.now);assert.equal(out.eventRosters.reviewRequired,true);assert.equal(out.frontend.status,'waiting-event-rosters');assert.equal(out.forms.status,'waiting-event-rosters');assert.equal(out.nativeInput.status,'waiting-event-rosters');assert.equal(f.props[SCHEDULE_PROPERTIES.reconciled],'older');assert.equal(out.reconciled,false);
 assert.equal(f.fx.calls.some(c=>/frontend-state|form-state|input-journal/.test(c.url)),false);
});
