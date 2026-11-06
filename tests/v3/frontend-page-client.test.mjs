import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';
import {createPagedFrontendTransport,FRONTEND_TRANSFER_LIMITS} from '../../.build/v3/apps/google-adapter/src/frontend-page-client.js';
import {FRONTEND_SECTIONS,FRONTEND_PAGE_VERSION,FRONTEND_PAGE_MAX_BYTES} from '../../.build/v3/packages/domain/src/frontend-transport.js';
const sha=x=>createHash('sha256').update(x).digest('hex'),secret='fictional-page-test-key';
const signer={sha256:sha,hmacSha256:x=>createHmac('sha256',secret).update(x).digest('hex')};
const config={environment:'staging',generation:2,baseUrl:'https://worker.example.invalid',keyId:'test'};
function fixture({effect=false,records={},chunk=512,mutate=x=>x}={}){
 const revision={operations:11,administration:17},data=Object.fromEntries(FRONTEND_SECTIONS.map(s=>[s,records[s]??[]])),calls=[];
 const identity=effect?{effectId:'effect',kind:'frontend.refresh'}:undefined;
 const base={environment:'staging',generation:2,principalId:'reader',...(effect?{workerId:'worker',effectId:'effect',claimToken:'claim'}:{})};
 const original={url:config.baseUrl+(effect?'/v1/admin/effects/project':'/v1/admin/snapshot'),method:'POST',headers:{},body:JSON.stringify(base)};
 const fx={now:1000,calls};
 const transport={send(request){calls.push(request);const path=new URL(request.url).pathname,b=JSON.parse(request.body);assert.equal(path,effect?'/v1/admin/effects/project/page':'/v1/admin/snapshot/page');
   assert.equal(request.headers['x-shamrock-signature'],signer.hmacSha256(`POST\n${path}\n${request.headers['x-shamrock-timestamp']}\n${sha(request.body)}`));
   for(const key of Object.keys(base))assert.equal(b[key],base[key]);const shared={contractVersion:FRONTEND_PAGE_VERSION,section:b.section,revision};
   const out=b.section==='manifest'?{...shared,environment:'staging',generation:2,sections:FRONTEND_SECTIONS.map(section=>({section,count:data[section].length})),diagnostics:[],...(effect?{effect:identity}:{})}
    :b.section==='verify'?{...shared,verified:true,...(effect?{effect:identity}:{})}
    :{...shared,offset:b.offset,rows:data[b.section].slice(b.offset,b.offset+chunk),nextOffset:b.offset+chunk<data[b.section].length?b.offset+chunk:null};
   const changed=mutate(structuredClone(out),b,fx);return typeof changed==='string'?{status:200,body:changed}:changed?.httpStatus?{status:changed.httpStatus,body:'{}'}:{status:200,body:JSON.stringify(changed)};
 }};
 return{...fx,fx,original,client:createPagedFrontendTransport(transport,config,signer,()=>fx.now)};
}
test('snapshot transfers only signed bounded pages and final verification precedes returned data',()=>{
 const f=fixture({records:{people:[{personId:'person',firstName:'Example',lastName:'Cadet',role:'Cadet',status:'Active',active:1,version:1,flightId:null}]},chunk:1});
 const snapshot=JSON.parse(f.client.send(f.original).body);assert.equal(snapshot.people[0].personId,'person');assert.equal(f.calls.length,15);assert.equal(JSON.parse(f.calls.at(-1).body).section,'verify');assert.deepEqual(snapshot.revision,{operations:11,administration:17});
 assert(f.calls.every(c=>c.url.endsWith('/snapshot/page')));
});
test('leased projection retains the exact effect and claim on every page',()=>{
 const f=fixture({effect:true,records:{flights:[{flightId:'a',label:'Alpha',squadronId:'blue'},{flightId:'b',label:'Bravo',squadronId:'blue'}]},chunk:1});
 const result=JSON.parse(f.client.send(f.original).body);assert.deepEqual(result.effect,{effectId:'effect',kind:'frontend.refresh'});assert.equal(result.snapshot.flights.length,2);assert.equal(f.calls.length,16);
});
test('commands and receipts pass through unchanged without snapshot calls',()=>{
 const original={url:config.baseUrl+'/v1/admin/commands',method:'POST',headers:{signature:'unchanged'},body:'frozen'},result={status:409,body:'conflict'};
 let calls=0;const client=createPagedFrontendTransport({send:r=>{calls++;assert.equal(r,original);return result;}},config,signer,()=>0);assert.equal(client.send(original),result);assert.equal(calls,1);
});
test('changed revision, wrong generation/effect, duplicate offsets and failed final verification never return partial data',()=>{
 const cases=[
  (p)=>p.section==='people'?{...p,revision:{operations:12,administration:17}}:p,
  (p)=>p.section==='manifest'?{...p,generation:3}:p,
  (p)=>p.section==='people'?{...p,offset:1}:p,
  (p)=>p.section==='people'?{...p,nextOffset:0}:p,
  (p)=>p.section==='verify'?{...p,verified:false}:p,
  (p)=>p.section==='verify'?{httpStatus:409}:p,
  (p)=>p.section==='manifest'?{...p,sections:p.sections.slice(1)}:p,
 ];
 for(const mutate of cases){const f=fixture({mutate});assert.throws(()=>f.client.send(f.original),e=>e.code==='frontend_pages');}
 const f=fixture({effect:true,mutate:p=>p.section==='verify'?{...p,effect:{effectId:'another',kind:'frontend.refresh'}}:p});assert.throws(()=>f.client.send(f.original),e=>e.code==='frontend_pages');
});
test('page bytes, aggregate bytes, page count and time each have explicit fail-closed bounds',()=>{
 const oversize=fixture({mutate:p=>p.section==='people'?'x'.repeat(FRONTEND_PAGE_MAX_BYTES+1):p});assert.throws(()=>oversize.client.send(oversize.original),/response bound/);
 const large=fixture({records:{requests:Array.from({length:5000},()=>({note:'x'.repeat(1150)}))},chunk:100});assert.throws(()=>large.client.send(large.original),/total response bound/);
 const many=fixture({records:{people:Array.from({length:500},()=>({})),contacts:Array.from({length:200},()=>({}))},chunk:1});assert.throws(()=>many.client.send(many.original),/page budget/);assert.equal(many.calls.length,FRONTEND_TRANSFER_LIMITS.pages);
 const slow=fixture({mutate:(p,_b,f)=>{if(p.section==='verify')f.now+=120;return p;}});assert.throws(()=>slow.client.send(slow.original),/time budget/);
});
test('unsupported request identity fails before provider access',()=>{
 const f=fixture();f.original.body=JSON.stringify({environment:'staging',generation:2,principalId:'reader',unreviewed:true});assert.throws(()=>f.client.send(f.original),/bound request/);assert.equal(f.calls.length,0);
});
