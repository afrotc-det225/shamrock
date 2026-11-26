import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnifiedSite, recordsEnvironment, storeEnvironment, siteOrigin } from '../hosted/site.mjs';
import { HostedBackend } from '../hosted/backend.mjs';

const db={}, rehearsal={}, cache={};
const env={APP_ORIGIN:siteOrigin,BACKEND_ORIGIN:siteOrigin,BACKEND_SERVICE_NAME:'shamrock',ENVIRONMENT:'staging',STAGING_DATASET:'real',
  DB:db,REHEARSAL_DB:rehearsal,WING_MATRICES:cache,GENERATION:'1',REHEARSAL_GENERATION:'1',BRIDGE_KEY_ID:'primary',BRIDGE_SECRET:'a'.repeat(32),
  REHEARSAL_KEY_ID:'fictional',REHEARSAL_SECRET:'b'.repeat(32),AUTH_STORE_ORIGIN:'https://shamrock-admin-staging.det225.workers.dev',
  RECEIPT_BINDING_ORIGIN:'https://shamrock-real-parity.det225.workers.dev',BACKEND:{},SOURCE_KIND:'test',SOURCE_RESOURCE:'console'};
const req=key=>new Request(siteOrigin+'/v1/commands',{headers:{'x-shamrock-key-id':key}});
test('the canonical name retains the original session and proposal identities',()=>{
  assert(isUnifiedSite(env));assert(!isUnifiedSite({...env,APP_ORIGIN:siteOrigin+'.invalid'}));
  assert.equal(storeEnvironment(env).APP_ORIGIN,env.AUTH_STORE_ORIGIN);
  const legacy={...env,APP_ORIGIN:env.AUTH_STORE_ORIGIN,BACKEND_ORIGIN:env.RECEIPT_BINDING_ORIGIN,BACKEND_SERVICE_NAME:'shamrock-real-parity'};
  assert.equal(new HostedBackend(env,'operator').binding,new HostedBackend(legacy,'operator').binding);
});
test('signed records handlers receive only the selected data and verification key',()=>{
  const live=recordsEnvironment(req('primary'),env),fixture=recordsEnvironment(req('fictional'),env);
  assert.equal(live.DB,db);assert.equal(live.WING_MATRICES,cache);assert.equal(live.BRIDGE_SECRET,env.BRIDGE_SECRET);
  assert.equal(fixture.DB,rehearsal);assert.equal(fixture.WING_MATRICES,undefined);assert.equal(fixture.BRIDGE_SECRET,env.REHEARSAL_SECRET);
  assert.equal(fixture.AUTH_STORE,undefined);assert.equal(fixture.ASSISTANT_KEY,undefined);
  assert.throws(()=>recordsEnvironment(req('primary'),{...env,REHEARSAL_KEY_ID:'primary'}));
});
