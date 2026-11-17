import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {continueTransitionArchive,continueTransitionPreparation} from '../../.build/v3/apps/google-adapter/src/transition-runtime.js';
import {FRONTEND_PAGE_VERSION as version,FRONTEND_SECTIONS} from '../../.build/v3/packages/domain/src/frontend-transport.js';
import {assembleTransitionSnapshot,TRANSITION_SNAPSHOT_PAGE_VERSION} from '../../.build/v3/packages/domain/src/transition-transport.js';
const hash=value=>createHash('sha256').update(value).digest('hex'),clone=value=>value===undefined?undefined:structuredClone(value);
function fixture(){
 const revision={operations:2,administration:3},pages=FRONTEND_SECTIONS.map(section=>({contractVersion:version,section,offset:0,nextOffset:null,revision,rows:[]}));
 const manifest={contractVersion:version,section:'manifest',environment:'staging',generation:1,revision,sections:FRONTEND_SECTIONS.map(section=>({section,count:0})),diagnostics:[]};
 const descriptor={contractVersion:TRANSITION_SNAPSHOT_PAGE_VERSION,manifest,verify:{contractVersion:version,section:'verify',revision,verified:true},pages:pages.map((p,sequence)=>({sequence,section:p.section,offset:p.offset,sha256:hash(JSON.stringify(p)),bytes:Buffer.byteLength(JSON.stringify(p))}))};
 const descriptorHash=hash(JSON.stringify(descriptor)),{snapshot,assembledSnapshotHash}=assembleTransitionSnapshot(descriptor,pages,descriptorHash,hash);
 const f={now:1800000000,saved:undefined,writes:0,acks:0,claims:0,requests:[],serverDone:false,loseAck:false,loseSave:false,tamper:false,leaseToken:0};
 const api={config:{environment:'staging',generation:1,keyId:'fixture',baseUrl:'https://fixture.invalid'},principalId:'automation',workerId:'archive',signer:{sha256:hash,hmacSha256:hash},nowSeconds:()=>f.now,transport:{send(request){
  const path=new URL(request.url).pathname,body=JSON.parse(request.body);f.requests.push({path,body});let result;
  if(path.endsWith('/claim')){f.claims++;result={transitionId:'transition',asOfDate:'2026-11-06',planHash:'a'.repeat(64),claimToken:'token-'+(++f.leaseToken),leaseExpiresAt:new Date((f.now+600)*1000).toISOString(),snapshotTransport:descriptor,descriptorHash,snapshotHash:null};}
  else if(path.endsWith('/page')){const page=clone(pages[body.sequence]);if(f.tamper)page.revision.operations++;result={sequence:body.sequence,sha256:descriptor.pages[body.sequence].sha256,descriptorHash,page};}
  else if(path.endsWith('/status'))result={archive:{state:f.serverDone?'done':'leased'},snapshotHash:assembledSnapshotHash,descriptorHash};
  else if(path.endsWith('/ack')){assert.equal(body.proof.snapshotHash,assembledSnapshotHash);assert.equal(body.proof.descriptorHash,descriptorHash);f.acks++;f.serverDone=true;if(f.loseAck){f.loseAck=false;throw Error('lost ACK');}result={status:'done'};}
  else throw Error('Unexpected path '+path);
  return {status:200,body:JSON.stringify(result)};
 }}};
 f.ports={api,lock:{tryLock:()=>true,releaseLock(){}},enabled:()=>true,assertPrivateState(){},state:{load:()=>clone(f.saved),save(value){if(f.loseSave&&value.capture?.pages.length===2){f.loseSave=false;throw Error('lost checkpoint');}f.saved=clone(value);},clear:()=>f.saved=undefined},archive:{write(claim){f.writes++;assert.deepEqual(claim.snapshot,snapshot);assert.equal(claim.snapshotHash,assembledSnapshotHash);assert.equal(claim.descriptorHash,descriptorHash);assert.equal(f.saved.capture,undefined);assert.deepEqual(f.saved.claim.snapshot,snapshot);return {done:true};},verify(){return {snapshotHash:assembledSnapshotHash,descriptorHash,archiveBinding:'archive',private:true,protected:true,valuesOnly:true};}}};
 return f;
}
function finish(f){let result;for(let i=0;i<10;i++){result=continueTransitionArchive(f.ports,'transition');if(result.state==='ready-for-reviewed-acceptance')return result;}throw Error('did not finish');}
test('frozen archive persists four verified pages per invocation and separates descriptor and assembled hashes',()=>{
 const f=fixture();assert.equal(continueTransitionArchive(f.ports,'transition').state,'capturing');assert.equal(f.saved.capture.pages.length,4);assert.equal(f.writes,0);assert.equal(f.acks,0);
 assert.equal(continueTransitionArchive(f.ports,'transition').state,'capturing');assert.equal(f.saved.capture.pages.length,8);assert.equal(f.writes,0);
 finish(f);assert.equal(f.writes,1);assert.equal(f.acks,1);assert.equal(f.saved,undefined);assert.equal(f.requests.filter(r=>r.path.endsWith('/page')).length,13);
});
test('interrupted page checkpoint retries only its unretained page before any provider writes',()=>{
 const f=fixture();f.loseSave=true;assert.throws(()=>continueTransitionArchive(f.ports,'transition'),/lost checkpoint/);assert.equal(f.saved.capture.pages.length,1);assert.equal(f.writes,0);finish(f);
 assert.deepEqual(f.requests.filter(r=>r.path.endsWith('/page')).map(r=>r.body.sequence),[0,1,1,2,3,4,5,6,7,8,9,10,11,12]);assert.equal(f.writes,1);
});
test('changed frozen page and changed retained descriptor fail before Google writes',()=>{
 const f=fixture();f.tamper=true;assert.throws(()=>continueTransitionArchive(f.ports,'transition'),e=>e.code==='transition_snapshot');assert.equal(f.writes,0);assert.equal(f.saved.capture.pages.length,0);
 f.tamper=false;continueTransitionArchive(f.ports,'transition');f.saved.capture.descriptor.manifest.generation=2;
 assert.throws(()=>continueTransitionArchive(f.ports,'transition'),e=>e.code==='transition_snapshot');assert.equal(f.writes,0);
});
test('lease renewal preserves already captured pages and requires the same immutable descriptor',()=>{
 const f=fixture();continueTransitionArchive(f.ports,'transition');f.now+=700;continueTransitionArchive(f.ports,'transition');assert.equal(f.claims,2);assert.equal(f.saved.capture.pages.length,8);assert.equal(f.saved.capture.claimToken,'token-2');finish(f);assert.equal(f.requests.filter(r=>r.path.endsWith('/page')).length,13);
});
test('lost ACK reconciles both hashes after expiry and verifies without writing a second archive',()=>{
 const f=fixture();f.loseAck=true;assert.throws(()=>finish(f),/lost ACK/);assert.equal(f.writes,1);assert.equal(f.acks,1);assert.equal(f.saved.writeComplete,true);f.now+=700;
 assert.equal(continueTransitionArchive(f.ports,'transition').state,'ready-for-reviewed-acceptance');assert.equal(f.writes,1);assert.equal(f.acks,1);assert.equal(f.saved,undefined);
});
test('retained assembled snapshot corruption is rejected on resume',()=>{
 const f=fixture();f.loseAck=true;assert.throws(()=>finish(f));f.saved.claim.snapshot.generation=2;assert.throws(()=>continueTransitionArchive(f.ports,'transition'),e=>e.code==='transition_snapshot');assert.equal(f.writes,1);assert.equal(f.acks,1);
});
test('native preparation advances one durable step and submits only the exact completed reviewed command',()=>{
 const f=fixture(),command={commandId:'prepare',operation:'transition.prepare',payload:{plan:{transitionId:'transition'}}};let sequence=0,committed=false;const paths=[];
 f.ports.api.transport.send=request=>{const path=new URL(request.url).pathname,body=JSON.parse(request.body);paths.push(path);let result;
  if(path.endsWith('/begin')){assert.deepEqual(body,command);result=committed?{committed:true,receipt:{commandId:'prepare',status:'committed'}}:{preparation:{commandId:'prepare',sequence,state:sequence<2?'capturing':'complete'}};}
  else if(path.endsWith('/step')){assert.equal(body.expectedSequence,sequence);sequence++;result={preparation:{commandId:'prepare',sequence,state:sequence<2?'capturing':'complete'}};}
  else if(path.endsWith('/commands')){assert.deepEqual(body,command);committed=true;result={commandId:'prepare',status:'committed'};}
  return {status:200,body:JSON.stringify(result)};
 };
 assert.equal(continueTransitionPreparation(f.ports.api,command).status,'preparing');assert.equal(paths.length,2);
 assert.equal(continueTransitionPreparation(f.ports.api,command).status,'committed');assert.equal(paths.filter(p=>p.endsWith('/step')).length,2);assert.equal(paths.filter(p=>p.endsWith('/commands')).length,1);
 assert.equal(continueTransitionPreparation(f.ports.api,command).status,'committed');assert.equal(paths.filter(p=>p.endsWith('/commands')).length,1);
});
