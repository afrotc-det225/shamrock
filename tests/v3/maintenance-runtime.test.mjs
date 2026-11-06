import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import test from 'node:test';
import {flushNotificationDelivery,createMailAppProvider,planNotificationWork} from '../../.build/v3/apps/google-adapter/src/notification-runtime.js';
import {continueTransitionArchive} from '../../.build/v3/apps/google-adapter/src/transition-runtime.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const signer={sha256:hash,hmacSha256:v=>createHmac('sha256','fictional-maintenance-signing-secret').update(v).digest('hex')};
const clone=v=>v===undefined?undefined:structuredClone(v);
function base(handler,environment='local') {
 const requests=[];const api={config:{environment,generation:1,keyId:'fixture',baseUrl:'https://fixture.invalid'},principalId:'automation',workerId:'adapter',nowSeconds:()=>1800000000,signer,transport:{send(request){requests.push(request);const url=new URL(request.url);assert.equal(request.headers['x-shamrock-signature'],signer.hmacSha256(`POST\n${url.pathname}\n${request.headers['x-shamrock-timestamp']}\n${hash(request.body)}`));return handler(url.pathname,JSON.parse(request.body));}}};
 return {api,requests};
}
function notificationFixture() {
 const claim={attempted:true,noticeId:'notice',attemptId:'attempt',claimToken:'token',expiresAt:new Date(1800000300*1000).toISOString(),mode:'local-test',message:{to:['cadet@example.invalid'],cc:[],subject:'Fictional',body:'Fictional message'}};
 let persisted={},calls=0,completeCalls=0,loseAck=false,loseCheckpoint=false;
 const {api,requests}=base((path,input)=>{
  if(path.endsWith('/claim'))return {status:200,body:JSON.stringify(claim)};
  if(path.endsWith('/complete')){completeCalls++;if(loseAck){loseAck=false;throw Error('fictional lost ACK');}return {status:200,body:JSON.stringify({attemptId:input.attemptId,state:input.outcome==='confirmed'?'sent':input.outcome==='known-not-sent'?'queued':'uncertain'})};}
  throw Error('Unexpected request');
 });
 const ports={api,lock:{tryLock:()=>true,releaseLock(){}},enabled:()=>true,assertPrivateState(){},state:{load:()=>clone(persisted),save(value){if(loseCheckpoint&&value.phase==='result'){loseCheckpoint=false;throw Error('fictional checkpoint loss');}persisted=clone(value);}},newClaimId:()=> 'claim',provider:{remainingRecipients:()=>100,send(){calls++;assert.equal(persisted.phase,'dispatching');return {outcome:'confirmed'};}}};
 return {ports,requests,get state(){return persisted;},get calls(){return calls;},get completeCalls(){return completeCalls;},loseAck:()=>loseAck=true,loseCheckpoint:()=>loseCheckpoint=true};
}
test('mail result acknowledgement can retry without another provider call',()=>{
 const f=notificationFixture();f.loseAck();assert.throws(()=>flushNotificationDelivery(f.ports));assert.equal(f.calls,1);assert.equal(f.state.phase,'result');
 assert.deepEqual(flushNotificationDelivery(f.ports),{state:'sent'});assert.equal(f.calls,1);assert.equal(f.completeCalls,2);assert.deepEqual(f.state,{});
});
test('a crash after provider dispatch becomes uncertain and never resends',()=>{
 const f=notificationFixture();f.loseCheckpoint();assert.throws(()=>flushNotificationDelivery(f.ports));assert.equal(f.state.phase,'dispatching');assert.equal(f.calls,1);
 assert.deepEqual(flushNotificationDelivery(f.ports),{state:'uncertain'});assert.equal(f.calls,1);
});
test('staging cannot claim mail or invoke provider even when enabled or holding local state',()=>{
 const f=notificationFixture();f.ports.api.config.environment='staging';assert.deepEqual(flushNotificationDelivery(f.ports),{state:'suppressed'});assert.equal(f.calls,0);assert.equal(f.requests.length,0);
});
test('quota is checked before dispatch and injected MailApp preserves routing without claiming inbox delivery',()=>{
 const f=notificationFixture();f.ports.provider.remainingRecipients=()=>0;assert.deepEqual(flushNotificationDelivery(f.ports),{state:'queued'});assert.equal(f.calls,0);
 let sent;const provider=createMailAppProvider({getRemainingDailyQuota:()=>10,sendEmail:m=>sent=m});
 assert.deepEqual(provider.send({to:['cadet@example.invalid'],cc:['commander@example.invalid'],replyTo:'commander@example.invalid',subject:'Fictional',body:'Fictional'}),{outcome:'confirmed'});
 assert.equal(sent.name,'SHAMROCK Automations');assert.equal(sent.cc,'commander@example.invalid');assert.equal(sent.replyTo,'commander@example.invalid');
});
test('schedule retries use one canonical local window and bounded five-task processing',()=>{
 let plans=[];const f=base((path,input)=>{
  if(path.endsWith('/plan')){plans.push(input);return {status:200,body:'{}'};}
  if(path.endsWith('/status'))return {status:200,body:JSON.stringify({pendingTasks:Array.from({length:20},(_,i)=>({taskId:'task-'+i}))})};
  return {status:200,body:'{}'};
 },'staging');
 f.api.nowSeconds=()=>Date.parse('2026-11-01T23:00:00Z')/1000;
 assert.deepEqual(planNotificationWork(f.api,{kind:'sheet',resourceKey:'maintenance'},true),{planned:true,processed:5});
 f.api.nowSeconds=()=>Date.parse('2026-11-01T23:05:00Z')/1000;planNotificationWork(f.api,{kind:'sheet',resourceKey:'maintenance'},true);
 assert.deepEqual(plans[0],plans[1]);assert.equal(plans[0].payload.asOf,'2026-11-01T22:00:00.000Z');
});
function archiveFixture(){
 const snapshot={fictional:'immutable archive data'},snapshotHash=hash(JSON.stringify(snapshot));
 let saved,done=false,ack=0,now=1800000000,serverDone=false;
 const f=base((path)=>{
  if(path.endsWith('/claim'))return {status:200,body:JSON.stringify({transitionId:'transition',snapshotHash,planHash:'a'.repeat(64),claimToken:'token',leaseExpiresAt:new Date((now+600)*1000).toISOString(),snapshot})};
  if(path.endsWith('/status'))return {status:200,body:JSON.stringify({snapshotHash,archive:{state:serverDone?'done':'leased'}})};
  if(path.endsWith('/ack')){ack++;serverDone=true;return {status:200,body:'{"status":"done"}'};}
 });
 f.api.nowSeconds=()=>now;
 const ports={api:f.api,lock:{tryLock:()=>true,releaseLock(){}},enabled:()=>true,assertPrivateState(){},state:{load:()=>clone(saved),save:v=>saved=clone(v),clear:()=>saved=undefined},archive:{write(){return done?{done:true}:{done:false,continuation:'page-two'};},verify(){return {snapshotHash,archiveBinding:'archive',protected:true,private:true,valuesOnly:true};}}};
 return {ports,get ack(){return ack;},get saved(){return saved;},finish:()=>done=true,serverDone:()=>serverDone=true,expire:()=>now+=700};
}
test('archive continuation is retained and cannot satisfy completion before verified finalization',()=>{
 const f=archiveFixture();assert.deepEqual(continueTransitionArchive(f.ports,'transition'),{state:'continuing'});assert.equal(f.ack,0);assert.equal(f.saved.continuation,'page-two');
 f.finish();assert.deepEqual(continueTransitionArchive(f.ports,'transition'),{state:'ready-for-reviewed-acceptance'});assert.equal(f.ack,1);assert.equal(f.saved,undefined);
});
test('archive lost ACK reconciles verified completed snapshot after lease expiry without recreating it',()=>{
 const f=archiveFixture();continueTransitionArchive(f.ports,'transition');f.serverDone();f.expire();let writes=0;f.ports.archive.write=()=>{writes++;throw Error('must not rewrite');};
 assert.deepEqual(continueTransitionArchive(f.ports,'transition'),{state:'ready-for-reviewed-acceptance'});assert.equal(writes,0);assert.equal(f.ack,0);
});
