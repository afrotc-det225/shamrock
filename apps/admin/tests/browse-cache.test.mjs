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
