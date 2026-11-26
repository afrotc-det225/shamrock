import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedPanelRead} from '../../.build/v3/apps/worker/src/panel-cache.js';

test('an unchanged primary version reuses only the exact private read; writes and revocations invalidate it', async t=>{
  const entries=new Map();
  const original=Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>({
    match:async key=>entries.get(key)?.clone(),put:async(key,r)=>entries.set(key,r),
  })}});
  t.after(()=>original?Object.defineProperty(globalThis,'caches',original):delete globalThis.caches);
  let version='one',calls=0;
  const env={ENVIRONMENT:'staging',GENERATION:'1',BRIDGE_KEY_ID:'fixture',DB:{withSession(mode){
    assert.equal(mode,'first-primary');let seen=null;
    return {prepare(sql){assert.equal(sql,'SELECT 1');return {run:async()=>{seen=version;return {meta:{rows_read:0}};}};},getBookmark:()=>seen};
  }}};
  const read=(actor,load)=>cachedPanelRead(env,new URL('https://fixture.invalid/v1/admin/panel/access'),actor,load);
  const load=async()=>new Response(String(++calls));
  assert.equal(await (await read('wing',load)).text(),'1');
  const hit=await read('wing',load);
  assert.equal(hit.headers.get('server-timing'),'panel;desc="edge"');
  assert.equal(hit.headers.get('x-shamrock-d1-rows-read'),'0');
  assert.equal(hit.headers.get('cache-control'),'no-store');
  assert.equal(await hit.text(),'1');
  assert.equal(await (await read('flight',load)).text(),'2');
  version='two';
  const revoked=()=>Promise.reject(Error('revoked'));
  await assert.rejects(read('wing',revoked),/revoked/);
  await assert.rejects(read('wing',async()=>{version='three';return load();}),{code:'SNAPSHOT_CHANGED'});
  assert.equal(await (await read('wing',load)).text(),'4');
  version=null;
  assert.equal(await (await read('wing',load)).text(),'5');
  assert.equal(await (await read('wing',load)).text(),'6');
});

test('a stored access check is bound to the exact signed caller and primary bookmark',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>({match:async()=>undefined,put:async()=>{}})}});
  t.after(()=>original?Object.defineProperty(globalThis,'caches',original):delete globalThis.caches);
  const entries=new Map();let version='before';
  const env={ENVIRONMENT:'staging',GENERATION:'1',BRIDGE_KEY_ID:'fixture',
    DB:{withSession:()=>({prepare:()=>({run:async()=>({meta:{rows_read:0}})}),getBookmark:()=>version})},
    WING_MATRICES:{get:async k=>entries.get(k)??null,put:async(k,v)=>entries.set(k,v)}};
  const read=(actor,load)=>cachedPanelRead(env,new URL('https://example.invalid/v1/admin/panel/access'),JSON.stringify({principalId:actor}),load);
  const denied=async()=>new Response(null,{status:403});
  await read('allowed',async()=>new Response('allowed'));
  assert.match((await read('allowed',denied)).headers.get('server-timing'),/stored/);
  assert.equal((await read('other',denied)).status,403);
  version='revoked';assert.equal((await read('allowed',denied)).status,403);
});
