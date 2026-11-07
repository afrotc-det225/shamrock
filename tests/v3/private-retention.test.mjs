import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createPrivateRetention,combineRetentionVolumes,retentionCanonical} from '../../.build/v3/apps/google-adapter/src/private-retention.js';
import {createFormCatalogArchive,compactFormsIntake} from '../../.build/v3/apps/google-adapter/src/forms-retention.js';
import {compactInputJournal,archivedInputReceipt,archivedInputEntry} from '../../.build/v3/apps/google-adapter/src/input-retention.js';
const copy=x=>structuredClone(x),sha=x=>createHash('sha256').update(x).digest('hex'),signer={sha256:sha};
function fixture(limits){const fx={root:{version:1,environment:'staging',generation:1,buckets:{}},files:new Map(),reserved:[],updates:0,creates:[],failCreate:false};
 const ports={generation:1,sha256:sha,root:{load:()=>copy(fx.root),save:x=>{fx.root=copy(x);}},reserveIds:n=>Array.from({length:n},()=>{const id='file-'+fx.reserved.length;fx.reserved.push(id);return id;}),read:id=>fx.files.get(id)??null,
 create(id,text,label){fx.creates.push({id,text,label});assert(fx.reserved.includes(id));if(fx.failCreate&&label==='SHAMROCK retained evidence'){fx.failCreate=false;throw Error('lost create');}if(fx.files.has(id))assert.equal(fx.files.get(id),text);else fx.files.set(id,text);},replaceIndex(id,before,after){assert.equal(fx.files.get(id),before);fx.files.set(id,after);fx.updates++;}};
 return{fx,ports,restart:()=>createPrivateRetention(ports,limits),store:createPrivateRetention(ports,limits)};
}
test('immutable private records survive restart and batched token indexing avoids per-token writes',()=>{
 const f=fixture(),records=Array.from({length:1000},(_,i)=>({key:'token-'+i,value:{edition:'same',token:i}}));f.store.put(records);assert(f.fx.updates<=16);const restart=f.restart();for(const i of [0,19,399,999])assert.deepEqual(restart.get(records[i].key),records[i].value);
 assert.throws(()=>restart.put([{key:'token-0',value:{different:true}}]),/cannot be rebound/);assert.equal(restart.get('unknown'),undefined);
});
test('an interrupted blob creation retries its persisted ID and exact payload after restart',()=>{
 const f=fixture(),value={evidence:'x'.repeat(4000)};f.fx.failCreate=true;assert.throws(()=>f.store.put([{key:'receipt',value}]),/lost create/);const planned=f.fx.creates.find(c=>c.label==='SHAMROCK retained evidence');assert(planned);
 const idsBefore=f.fx.reserved.length;assert.deepEqual(f.restart().get('receipt'),value);assert.equal(f.fx.reserved.length,idsBefore);assert.equal(f.fx.creates.filter(c=>c.label==='SHAMROCK retained evidence').at(-1).id,planned.id);
 f.fx.files.set(planned.id,'{"tampered":true}');assert.throws(()=>f.restart().get('receipt'),/missing or changed/);
});
test('bounded index rotation retains old shards and makes every old key available after restart',()=>{
 const f=fixture({bucketBytes:10000,bucketRecords:2});let n=0;const records=[];while(records.length<12){const key='collision-bucket-'+n++;if(sha(key).startsWith('a'))records.push({key,value:{n}});}
 for(const r of records)f.store.put([r]);assert(f.fx.root.retired.length>0);assert(f.fx.root.retired.every(r=>f.fx.files.has(r.fileId)));const again=f.restart();for(const r of records)assert.deepEqual(again.get(r.key),r.value);
 assert.equal(f.fx.root.split,undefined);
});
test('interrupted index rotation resumes the exact reserved children without deleting the old index',()=>{
 const f=fixture({bucketBytes:10000,bucketRecords:2});let n=0;const keys=[];while(keys.length<3){const k='rotation-'+n++;if(sha(k).startsWith('b'))keys.push(k);}
 f.store.put(keys.slice(0,2).map(key=>({key,value:key})));const normal=f.ports.create;let failed=false;f.ports.create=(id,text,label)=>{if(!failed&&JSON.parse(text).prefix?.length===2){failed=true;throw Error('interrupted split');}normal(id,text,label);};
 assert.throws(()=>f.store.put([{key:keys[2],value:keys[2]}]),/interrupted split/);const pending=copy(f.fx.root.split);assert(pending);f.ports.create=normal;const again=f.restart();assert.equal(again.get(keys[0]),keys[0]);assert.equal(f.fx.root.split,undefined);assert(f.fx.files.has(pending.fileId));again.put([{key:keys[2],value:keys[2]}]);assert.equal(again.get(keys[2]),keys[2]);
});
function memoryStore(){const values=new Map();return{values,get:key=>copy(values.get(key)),put(records){for(const r of records){const prior=values.get(r.key);if(prior!==undefined)assert.equal(retentionCanonical(prior),retentionCanonical(r.value));else values.set(r.key,copy(r.value));}}};}
test('reviewed volume rollover preserves exact old lookup and writes only new evidence to the new volume',()=>{
 const old=memoryStore(),next=memoryStore();old.put([{key:'historical',value:{version:1}}]);const combined=combineRetentionVolumes(next,[old]);assert.deepEqual(combined.get('historical'),{version:1});combined.put([{key:'historical',value:{version:1}},{key:'new',value:{version:2}}]);assert.equal(old.values.size,1);assert.equal(next.values.size,1);assert.throws(()=>combined.put([{key:'historical',value:{version:3}}]),/cannot be rebound/);
 next.put([{key:'historical',value:{version:4}}]);assert.throws(()=>combined.get('historical'),/disagree/);
});
function edition(sequence){const editionId=sha('edition-'+sequence),token=sha('token-'+sequence).slice(0,12);return{editionId,formId:'directory-form',resourceKey:'directory',generation:1,revision:{operations:sequence,administration:sequence},references:{[token]:{editionId,questionId:'flight',kind:'scope',unitId:'alpha',rosterVersion:1,coveredPersonIds:['person-0']}},people:Array.from({length:113},(_,i)=>({personId:'person-'+i,version:i===0?sequence:0,firstName:'Fictional',lastName:'Cadet '+i,phone:i===0?String(sequence):'',photoLink:'https://drive.google.com/file/d/fictional/view'}))};}
test('eighty Directory editions stay bounded while shared profile blocks and old choice bindings remain exact',()=>{
 const store=memoryStore(),archive=createFormCatalogArchive(store,signer),state={version:1,environment:'staging',generation:1,editions:{},current:{}};
 for(let n=0;n<80;n++){const next=edition(n);state.editions=archive.retain(state,[next]);state.current.directory=next.editionId;assert(Object.keys(state.editions).length<=2);assert(retentionCanonical(state).length<100000);}
 assert.equal([...store.values.keys()].filter(k=>k.startsWith('form-people.')).length,83);
 const first=edition(0),token=Object.keys(first.references)[0],restarted=createFormCatalogArchive(store,signer);
 const resolved=restarted.forSubmission(state,{formId:'directory-form',answers:{flight:`Alpha [sr:${token}]`}},{kind:'directory',directoryFields:{flightId:'flight'}});assert.deepEqual(resolved[first.editionId],first);assert.equal(resolved[first.editionId].people[0].version,0);
 const changed=copy(first);changed.people[0].phone='changed';assert.throws(()=>restarted.save(changed),/cannot change/);
});
test('catalog token collisions fail before an old response can bind another edition',()=>{
 const store=memoryStore(),archive=createFormCatalogArchive(store,signer),first=edition(0),second=edition(1);archive.save(first);const token=Object.keys(first.references)[0];second.references={[token]:{...Object.values(second.references)[0]}};assert.throws(()=>archive.save(second));assert.equal(archive.load(first.editionId).editionId,first.editionId);
});
test('only verified committed intake is compacted and replay evidence remains retrievable',()=>{
 const store=memoryStore(),state={entries:Object.fromEntries(Array.from({length:150},(_,i)=>['entry-'+i,{status:'committed',commands:[{status:'committed',receipt:{commandId:'command-'+i}}],sourceHash:sha('source-'+i)}]))};
 state.entries.pending={status:'queued',commands:[{status:'queued'}]};state.entries.conflict={status:'conflict',commands:[{status:'conflict'}]};state.entries.review={status:'pending-review',commands:[]};
 const result=compactFormsIntake(state,store);assert.equal(result.archived,32);assert(result.state.entries.pending&&result.state.entries.conflict&&result.state.entries.review);assert(state.entries['entry-0']);assert(!result.state.entries['entry-0']);assert.deepEqual(store.get('form-intake.entry-0'),state.entries['entry-0']);
});
function inputFixture(){const store=memoryStore(),journal={version:1,environment:'staging',generation:1,entries:{}},state={inputReceipts:{}};
 for(let i=0;i<150;i++){const command={commandId:'command-'+i},receipt={commandId:command.commandId,status:'committed'},edit={editId:'edit-'+i,surface:'attendance'};journal.entries[edit.editId]={edit,noteStatus:'committed',commands:[{command,receipt,status:'committed',applied:true,attempted:true}]};state.inputReceipts[command.commandId]=sha(retentionCanonical({command,receipt}));}
 journal.entries.queued={edit:{editId:'queued',surface:'attendance'},commands:[{command:{commandId:'pending'},status:'queued',attempted:true}]};const fx={journal:copy(journal),state:copy(state),failState:false};
 const open=()=>({journal:copy(fx.journal),state:copy(fx.state),sha256:sha,saveJournal:j=>{fx.journal=copy(j);},saveState:s=>{if(fx.failState)throw Error('state interruption');fx.state=copy(s);}});return{store,fx,open};}
test('input compaction preserves frozen attempts and archives exact applied receipt markers before pruning',()=>{
 const f=inputFixture(),io=f.open();assert.equal(compactInputJournal(io,f.store),32);assert(f.fx.journal.entries.queued);assert(!f.fx.journal.entries['edit-0']);assert(!f.fx.state.inputReceipts['command-0']);assert.equal(archivedInputEntry(f.store,'edit-0').commands[0].applied,true);assert.match(archivedInputReceipt(f.store,'command-0'),/^[a-f0-9]{64}$/);
});
test('input retention resumes after journal removal but before receipt pruning, without losing original evidence',()=>{
 const f=inputFixture();f.fx.failState=true;assert.throws(()=>compactInputJournal(f.open(),f.store),/state interruption/);assert(!f.fx.journal.entries['edit-0']);assert(f.fx.state.inputReceipts['command-0']);assert(archivedInputEntry(f.store,'edit-0'));f.fx.failState=false;
 compactInputJournal(f.open(),f.store);assert(!f.fx.state.inputReceipts['command-0']);assert(f.fx.journal.entries.queued);
});
