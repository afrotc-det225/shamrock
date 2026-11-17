import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';

test('staging bundle loads without Google IO and exposes native trigger entry points', async () => {
  const source = await readFile(new URL('../../.build/v3-artifacts/GoogleAdapter.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.SHAMROCKV3.createNativeStagingHost, 'function');
  for (const name of Object.values(context.SHAMROCKV3.STAGING_HANDLERS)) {
    assert.equal(typeof context[name], 'function', name);
  }
  for (const name of ['Setup', 'Pause', 'Resume', 'ImportConfig', 'RepairPresentation', 'FrontendRefresh', 'FrontendPause', 'FrontendResume', 'MaintenancePause', 'MaintenanceResume', 'NotificationsPlan', 'TransitionArchive', 'TransitionCommand']) assert.equal(typeof context[`shamrockV3Staging${name}`], 'function');
  assert.equal(typeof context.SHAMROCKV3.createNativeFrontendRuntime, 'function');
  assert.equal(typeof context.SHAMROCKV3.planPresentationRepair, 'function');
  assert.equal(typeof context.SHAMROCKV3.verifyPresentation, 'function');
  assert.equal(context.onOpen, undefined);
  assert.equal(context.onFormSubmit, undefined);
});

test('staging manifest grants send-only rehearsal scope without Gmail access or execution deployment', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../.build/v3-artifacts/appsscript.json', import.meta.url), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'America/Indiana/Indianapolis');
  for (const scope of ['drive', 'forms.body', 'forms.responses.readonly']) assert.ok(manifest.oauthScopes.includes(`https://www.googleapis.com/auth/${scope}`));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.send_mail'));
  assert.ok(!manifest.oauthScopes.some(scope => /gmail|mail\.google/.test(scope)));
  assert.equal(manifest.executionApi, undefined);
  assert.equal(manifest.webapp, undefined);
});

test('operator setup pauses and validates projection outputs before installing triggers', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = [];
  const context = vm.createContext({});
  vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({
    pause() { calls.push('pause'); },
    initializeProjections() { calls.push('outputs'); },
    repairPresentation() { calls.push('presentation'); },
    setup() { calls.push('triggers'); return 'ready-paused'; },
  });
  context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend-pause'); } });
  context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance-pause');}});
  assert.equal(context.shamrockV3StagingSetup(), 'ready-paused');
  assert.deepEqual(calls, ['pause', 'frontend-pause', 'maintenance-pause', 'outputs', 'presentation', 'triggers']);
});

test('installed scheduled flush delegates once to the shared invocation scheduler',async()=>{
 const source=await readFile(new URL('../../apps/google-adapter/staging-globals.js',import.meta.url),'utf8');let calls=0;
 const services=Object.fromEntries(['PropertiesService','Utilities','UrlFetchApp','ScriptApp','Session','FormApp','SpreadsheetApp','LockService','MailApp'].map(name=>[name,{}]));
 const context=vm.createContext({...services,SHAMROCKV3:{runScheduledStaging(s){calls++;assert.equal(s.UrlFetchApp,services.UrlFetchApp);assert.equal(s.MailApp,services.MailApp);return{status:'paused',reconciled:true};}}});vm.runInContext(source,context);
 assert.deepEqual(context.shamrockV3StagingFlush(),{status:'paused',reconciled:true});assert.equal(calls,1);
});

test('global staging pause stops both planes while each resume remains explicit and separate', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = [], context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ pause() { calls.push('intake-pause'); return { status: 'paused' }; }, resume() { calls.push('intake-resume'); } });
  context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend-pause'); }, resume() { calls.push('frontend-resume'); }, refresh() { calls.push('frontend-refresh'); } });
  context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance-pause');}});
  context.shamrockV3StagingPause(); assert.deepEqual(calls, ['intake-pause', 'frontend-pause', 'maintenance-pause']); calls.length = 0;
  context.shamrockV3StagingResume(); assert.deepEqual(calls, ['intake-resume']); calls.length = 0;
  context.shamrockV3StagingFrontendResume(); assert.deepEqual(calls, ['frontend-resume']); calls.length = 0;
  context.shamrockV3StagingFrontendRefresh(); assert.deepEqual(calls, ['frontend-refresh']);
});

test('pause and setup attempt both independent pauses when either provider write fails', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  for (const failing of ['intake', 'frontend', 'maintenance']) for (const action of ['Pause', 'Setup']) {
    const calls = [], context = vm.createContext({}); vm.runInContext(source, context);
    context.shamrockV3StagingHost_ = () => ({ pause() { calls.push('intake'); if (failing === 'intake') throw Error('Pause failed'); }, initializeProjections() { throw Error('Setup must stop'); } });
    context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend'); if (failing === 'frontend') throw Error('Pause failed'); } });
    context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance');if(failing==='maintenance')throw Error('Pause failed');}});
    assert.throws(() => context[`shamrockV3Staging${action}`](), /Pause failed/);
    assert.deepEqual(calls, ['intake', 'frontend', 'maintenance']);
  }
});

test('presentation repair has a dedicated entry point that does not install triggers or resume processing', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = []; const context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ repairPresentation() { calls.push('repair'); return 'presentation-ready-paused'; } });
  assert.equal(context.shamrockV3StagingRepairPresentation(), 'presentation-ready-paused'); assert.deepEqual(calls, ['repair']);
});


test('bundled scheduled flush with no owner-mail config never invokes provider or network IO',async()=>{
 const source=await readFile(new URL('../../.build/v3-artifacts/GoogleAdapter.js',import.meta.url),'utf8'),properties={};let providerCalls=0,networkCalls=0;
 const context=vm.createContext({
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>properties[k]=v,deleteProperty:k=>delete properties[k]})},
  Utilities:{},FormApp:{},SpreadsheetApp:{},Session:{},ScriptApp:{},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  UrlFetchApp:{fetch(){networkCalls++;assert.fail('unconfigured flush must not call a provider');}},
  MailApp:{getRemainingDailyQuota(){providerCalls++;assert.fail('unconfigured mail quota access');},sendEmail(){providerCalls++;assert.fail('unconfigured mail send');}}
 });vm.runInContext(source,context);
 assert.equal(context.shamrockV3StagingFlush().ownerMail.status,'paused');
 properties.SHAMROCK_V3_OWNER_MAIL_PAUSED='false';
 assert.equal(context.shamrockV3StagingFlush().ownerMail.status,'disabled');
 assert.equal(providerCalls,0);assert.equal(networkCalls,0);
});

test('bundled native-only setup pauses every consumer and installs only the shared scheduler',async()=>{
 const source=await readFile(new URL('../../.build/v3-artifacts/GoogleAdapter.js',import.meta.url),'utf8'),owner='owner@example.invalid';
 const properties={SHAMROCK_V3_HOST_CONFIG:JSON.stringify({version:1,environment:'staging',mode:'native-only',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fixture',expectedAutomationEmail:owner}),SHAMROCK_V3_BRIDGE_SECRET:'fictional-native-bootstrap-secret-material',SHAMROCK_V3_ENABLED:'true'};
 const triggers=[];let created=0;
 const context=vm.createContext({
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>properties[k]=v,deleteProperty:k=>delete properties[k]})},
  Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>[...createHash('sha256').update(s).digest()],computeHmacSha256Signature:(s,k)=>[...createHmac('sha256',k).update(s).digest()]},
  Session:{getEffectiveUser:()=>({getEmail:()=>owner})},FormApp:{openById(){assert.fail('legacy Form open');}},SpreadsheetApp:{openById(){assert.fail('legacy workbook open');}},
  ScriptApp:{TriggerSource:{CLOCK:'clock'},EventType:{CLOCK:'clock'},getProjectTriggers:()=>triggers.slice(),deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),newTrigger(handler){return {timeBased:()=>({everyMinutes(minutes){assert.equal(minutes,5);return {create(){const id=`clock-${++created}`,t={getUniqueId:()=>id,getHandlerFunction:()=>handler,getTriggerSource:()=> 'clock',getEventType:()=> 'clock',getTriggerSourceId:()=>null};triggers.push(t);return t;}};}})};}},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  UrlFetchApp:{fetch(){assert.fail('paused native bootstrap must not read provider resources');}},MailApp:{}
 });vm.runInContext(source,context);
 assert.equal(context.shamrockV3StagingSetup().mode,'native-only');assert.equal(context.shamrockV3StagingSetup().triggers,1);assert.equal(created,1);assert.equal(triggers[0].getHandlerFunction(),'shamrockV3StagingFlush');
 for(const key of ['FRONTEND','INPUT','PERMISSION','HISTORY','OWNER_MAIL','FORMS','FORM_INTAKE','MAINTENANCE'])assert.equal(properties[`SHAMROCK_V3_${key}_PAUSED`],'true');
 assert.equal(properties.SHAMROCK_V3_ENABLED,'false');assert.equal(context.shamrockV3StagingFlush().status,'native-only');
 assert.equal(context.shamrockV3StagingAttendanceSubmit().status,'paused');assert.equal(context.shamrockV3StagingDecisionEdit().status,'paused');
});
