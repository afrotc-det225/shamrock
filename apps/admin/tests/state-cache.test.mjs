import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {build} from 'esbuild';
await build({absWorkingDir:resolve(import.meta.dirname,'../../..'),entryPoints:['apps/admin/src/api.js'],outfile:'.build/admin/state-api-test.mjs',bundle:true,platform:'browser',format:'esm'});

test('conditional access refresh reuses only the captured in-memory state and clears it on account changes',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
  const {api,startSession}=await import('../../../.build/admin/state-api-test.mjs?cache-test');
  const manifest={revision:{operations:1,administration:2,access:'a'.repeat(64)},access:{capabilities:{fullSnapshot:true}}};
  const state={transport:'paged-v1',captureKey:'binding-one',viewAs:null,viewAsRevision:null,manifest,reportingTime:1};
  let requests=[];globalThis.fetch=async(path,init)=>{requests.push({path,init});return Response.json(state)};
  assert.equal((await api('/state',undefined,{profile:'access'})).captureKey,'binding-one');
  assert.equal(requests[0].path,'/api/state?profile=access','state carries the lightweight read profile to the server');
  assert.equal(requests[0].init.headers['x-shamrock-capture'],undefined);
  globalThis.fetch=async(path,init)=>{requests.push({path,init});assert.deepEqual(JSON.parse(decodeURIComponent(init.headers['x-shamrock-capture'])),{captureKey:'binding-one',revision:manifest.revision,viewAsRevision:null});return Response.json({captureUnchanged:true,captureKey:'binding-one',viewAs:null,viewAsRevision:null,reportingTime:2})};
  const reused=await api('/state',undefined,{profile:'access'});assert.deepEqual(reused.manifest,manifest);assert.equal(reused.reportingTime,2);
  globalThis.fetch=async()=>Response.json({error:{code:'NOT_AUTHORIZED'}},{status:403});
  await assert.rejects(api('/state',undefined,{profile:'access'}),{status:403});
  globalThis.fetch=async(path,init)=>{assert.equal(init.headers['x-shamrock-capture'],undefined);return Response.json({...state,captureKey:'binding-two'})};
  await api('/state',undefined,{profile:'access'});
  globalThis.fetch=async()=>Response.json({captureUnchanged:true,captureKey:'wrong-binding',viewAsRevision:null});
  await assert.rejects(api('/state',undefined,{profile:'access'}),{code:'SNAPSHOT_CHANGED'});
  globalThis.fetch=async()=>Response.json({csrf:'fixture'});await startSession();
  globalThis.fetch=async(path,init)=>{assert.equal(init.headers['x-shamrock-capture'],undefined);return Response.json(state)};
  await api('/state',undefined,{profile:'access'});
});

test('quota errors preserve only bounded retry delay from the response',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
  const {api}=await import('../../../.build/admin/state-api-test.mjs?retry-test');
  for(const [raw,expected]of [['60',60],['86400',86400],['0',undefined],['86401',undefined],['not-a-number',undefined]]){
    globalThis.fetch=async()=>Response.json({error:{code:'SERVICE_LIMIT_REACHED'}},{status:503,headers:{'Retry-After':raw}});
    await assert.rejects(api('/state'),error=>error.code==='SERVICE_LIMIT_REACHED'&&error.retryAfterSeconds===expected);
  }
});
