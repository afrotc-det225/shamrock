import test from 'node:test';
import assert from 'node:assert/strict';
import {browseState} from '../hosted/browse.mjs';
test('private views reuse only matching profile, actor, preview, term and revisions',async()=>{
 const a={scope:{termId:'fall'},access:{capabilities:{fullSnapshot:true}},revision:{operations:1,administration:2,access:'a'}};
 let loads=0, after=a;
 const b={binding:'actor-one',identity:()=>({}),send:async(_,r)=>{loads++;return {profile:r.profile,scope:a.scope,revision:a.revision,tables:{}};},panelAuthority:async()=>after};
 await browseState(b,a,'cadets');await browseState(b,a,'cadets');assert.equal(loads,1);
 await browseState(b,a,'leadership');assert.equal(loads,2);
 b.binding='actor-two';await browseState(b,a,'cadets');assert.equal(loads,3);
 b.preview={entry_audit_id:'entry',person_id:'target'};b.binding='actor-two-entry';b.viewRevision='view';
 await browseState(b,a,'cadets');assert.equal(loads,4);
 after={...a,revision:{...a.revision,operations:3}};
 await assert.rejects(()=>browseState(b,a,'overview'),e=>e.code==='SNAPSHOT_CHANGED');
});

test('private edge hits require identical authority across isolates and cache outages still serve authorized views', async t=>{
 const entries=new Map();let loads=0,fail=false;
 const original=globalThis.caches;
 globalThis.caches={open:async name=>{
   assert.equal(name,'shamrock-private-browse-v1');
   if(fail)throw Error('unavailable');
   return {match:async key=>entries.get(key)?.clone(),put:async(key,v)=>entries.set(key,v)};
 }};
 t.after(()=>{if(original)globalThis.caches=original;else delete globalThis.caches;});
 const a={scope:{termId:'fall'},access:{capabilities:{fullSnapshot:true}},revision:{operations:1,administration:2,access:'private'}};
 const b={binding:'example-actor',env:{APP_ORIGIN:'https://fixture.invalid'},identity:()=>({}),
   send:async(_,r)=>{loads++;return {profile:r.profile,scope:a.scope,revision:{...a.revision},tables:{}};},panelAuthority:async()=>a};
 const fresh=async n=>(await import('../hosted/browse.mjs?test='+n)).browseState(b,a,'attendance');
 await fresh(1);assert.equal(b.browseSource,'database');
 await fresh(2);assert.equal(b.browseSource,'edge');assert.equal(loads,1);
 assert.match([...entries.keys()][0],/^https:\/\/fixture\.invalid\/_private\/browse\/[a-f0-9]{64}$/);
 a.revision.operations++;await fresh(3);assert.equal(loads,2);
 b.binding='different-actor';await fresh(4);assert.equal(loads,3);
 fail=true;await fresh(5);assert.equal(loads,4);
});
