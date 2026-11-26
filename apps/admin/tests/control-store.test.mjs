import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { ProposalStore } from "../hosted/store.mjs";
import { changePreview, getPreview } from "../hosted/view-as.mjs";
import { panelControlStore } from "../hosted/control-store.mjs";

const root = resolve(import.meta.dirname, "../../..");
const origin = "https://panel-staging.example.invalid";
const hash = value => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
await build({
  absWorkingDir: root,
  entryPoints: ["apps/admin/tests/control-store-fixture.mjs"],
  outfile: resolve(root, ".build/admin/control-store-test.mjs"),
  bundle: true, platform: "node", format: "esm", target: "es2022",
  external: ["node:*", "cloudflare:*"], loader: {".sql":"text",".md":"text"},
  plugins: [{name:"source-domain", setup(b) {
    b.onResolve({filter:/\.build\/(admin|v3)\//}, a => ({
      path: a.path.endsWith("/admin/domain.mjs") ? resolve(root,"apps/admin/domain-entry.ts") :
        resolve(a.resolveDir,a.path).replace("/.build/v3/","/").replace(/\.js$/,".ts"),
    }));
  }}],
});

function seed(change = () => {}) {
  const payload = {
    contractVersion:1, environment:"staging", origin, generation:1,
    sourceCommit:"a".repeat(40), capturedAt:new Date().toISOString(),
    tables:{identity_bindings:[{google_sub:"owner-sub",principal_id:"owner",active:1}],login_invitations:[],proposals:[]},
  };
  change(payload);
  return JSON.stringify({sha256:hash(JSON.stringify(payload)),payload});
}

async function fixture(t, {bootstrap = seed(), persist, bindings = {}, namespace = true} = {}) {
  const mf = new Miniflare({
    ...(persist ? {durableObjectsPersist:persist} : {}),
    workers: [{
      name:"panel", modules:true, modulesRoot:root,
      scriptPath:resolve(root,".build/admin/control-store-test.mjs"),
      compatibilityDate:"2026-07-01", compatibilityFlags:["nodejs_compat"],
      durableObjects:namespace ? {AUTH_STORE:{className:"StagingPanelStore",useSQLite:true}} : {},
      serviceBindings:{BACKEND:"backend",ASSETS:"assets"},
      bindings:{
        TEST_SECRET:"fictional-local-secret", APP_ORIGIN:origin, ENVIRONMENT:"staging",
        AUTH_STORE_VERSION:"1", ...(bootstrap === null ? {} : {AUTH_STORE_BOOTSTRAP:bootstrap}),
        GOOGLE_CLIENT_ID:"test-client", GOOGLE_CLIENT_SECRET:"test-secret",
        BACKEND_ORIGIN:"https://backend-staging.example.invalid",
        BRIDGE_SECRET:"fictional-bridge-secret-with-more-than-thirty-two-chars",
        BRIDGE_KEY_ID:"test-key", SOURCE_KIND:"test", SOURCE_RESOURCE:"panel-source",
        GENERATION:"1", VIEW_AS_ENABLED:"1", ...bindings,
      },
    }, {
      name:"backend",modules:true,compatibilityDate:"2026-07-01",
      script:'export default {fetch(){return Response.json({error:{code:"SERVICE_LIMIT_REACHED",message:"Database quota exhausted"}},{status:503,headers:{"Retry-After":"3600"}})}}',
    }, {
      name:"assets",modules:true,compatibilityDate:"2026-07-01",
      script:'export default {fetch(){return new Response("SHAMROCK")}}',
    }],
    log:new Log(LogLevel.NONE),
  });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await mf.dispose(); } };
  t.after(dispose);
  const request = input => mf.dispatchFetch((bindings.APP_ORIGIN || origin) + "/__fixture", {
    method:"POST",redirect:"manual",headers:{"x-fixture-secret":"fictional-local-secret"},body:JSON.stringify(input),
  });
  const execute = async statements => {
    const response = await request({statements});
    if (!response.ok) {
      const error = await response.json();
      throw Object.assign(new Error(error.error.code),{code:error.error.code,status:response.status});
    }
    return response.json();
  };
  const prepare = (sql, values = []) => ({
    sql,values, bind:(...next) => prepare(sql,next),
    run:async () => (await execute([{sql,values}]))[0],
    all:async () => (await execute([{sql,values}]))[0],
    first:async () => (await execute([{sql,values}]))[0].results[0] || null,
  });
  const db = {prepare,batch:statements=>execute(statements.map(({sql,values})=>({sql,values})))};
  return {mf, dispose, request, db, run:(sql,...values)=>prepare(sql,values).run()};
}

async function login(f, identity = {subject:"owner-sub",emailHash:null}) {
  const response = await f.mf.dispatchFetch(origin+"/auth/login",{redirect:"manual"});
  assert.equal(response.status,303);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin,"https://accounts.google.com");
  assert.equal(location.searchParams.get("code_challenge_method"),"S256");
  const cookie = response.headers.getSetCookie().find(v=>v.startsWith("__Host-shamrock-auth-v2=")).split(";")[0];
  const callback = {
    url:origin+"/auth/callback?code=fictional-code&state="+location.searchParams.get("state"),
    cookie,nonce:location.searchParams.get("nonce"),identity,
  };
  return {response,callback,complete:()=>f.request({callback})};
}

test("SQLite control storage authenticates, retains revocation and signs out without D1", async t => {
  const f = await fixture(t);
  const status = await (await f.request({status:true})).json();
  assert.equal(status.ready,true);
  assert.match(status.bootstrapSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(status).sort(),["bootstrapSha256","ready","schemaSha256","version"]);
  const attempt = await login(f);
  const wrong = await f.request({callback:{...attempt.callback,cookie:"__Host-shamrock-auth-v2="+random()}});
  assert.equal(wrong.status,401,"a wrong browser cannot consume another browser's OAuth state");
  const completed = await attempt.complete();
  assert.equal(completed.status,303);
  const cookie = completed.headers.getSetCookie().find(v=>v.startsWith("__Host-shamrock-v2=")).split(";")[0];
  assert.equal((await attempt.complete()).status,401,"OAuth state is single use");
  const session = await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie}});
  assert.equal(session.status,200);
  const body = await session.json();
  assert.equal(body.authenticated,true);
  assert.equal(body.hosted,true);
  assert.equal(body.viewAs,null);
  assert.match(body.csrf,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie:cookie.replace("-v2=","=")}})).status,401);
  const state = await f.mf.dispatchFetch(origin+"/api/state",{headers:{cookie}});
  assert.equal(state.status,503,"records remain unavailable while the operational backend quota is exhausted");
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie}})).status,200);
  const logout = headers => f.mf.dispatchFetch(origin+"/auth/logout",{method:"POST",redirect:"manual",headers:{cookie,origin,...headers}});
  assert.equal((await logout({})).status,403,"logout requires CSRF and returns an actual error, not a login redirect");
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie}})).status,200);
  assert.equal((await logout({"x-shamrock-csrf":body.csrf})).status,200);
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie}})).status,401);
  const second = await (await login(f)).complete();
  const secondCookie = second.headers.getSetCookie().find(v=>v.startsWith("__Host-shamrock-v2=")).split(";")[0];
  await f.run("UPDATE identity_bindings SET active=0 WHERE google_sub=?","owner-sub");
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie:secondCookie}})).status,401);
});

test("DO batches are atomic, changes exclude index writes, and competing OAuth claims admit once", async t => {
  const f = await fixture(t);
  const inserted = await f.run("INSERT INTO identity_bindings VALUES(?,?,1)","new-sub","new-principal");
  assert.equal(inserted.meta.changes,1);
  assert.equal((await f.run("UPDATE identity_bindings SET active=0 WHERE google_sub=?","missing")).meta.changes,0);
  await assert.rejects(f.db.batch([
    f.db.prepare("INSERT INTO identity_bindings VALUES(?,?,1)").bind("rollback-sub","rollback-principal"),
    f.db.prepare("INSERT INTO identity_bindings VALUES(?,?,1)").bind("owner-sub","duplicate-principal"),
  ]),{code:"AUTH_STORE_UNAVAILABLE"});
  assert.equal(await f.db.prepare("SELECT * FROM identity_bindings WHERE google_sub=?").bind("rollback-sub").first(),null);
  const attempt = await login(f);
  const results = await Promise.all([attempt.complete(),attempt.complete()]);
  assert.deepEqual(results.map(r=>r.status).sort(),[303,401]);
  assert.equal((await f.run("SELECT COUNT(*) AS n FROM sessions")).results[0].n,1);
});

test("invitation claim is atomic in DO and does not reactivate a disabled subject", async t => {
  const now = Date.now(), emailHash = hash("invited@example.invalid");
  const f = await fixture(t,{bootstrap:seed(p=>{
    p.tables.identity_bindings.push({google_sub:"disabled-sub",principal_id:"disabled",active:0});
    p.tables.login_invitations.push({email_sha256:emailHash,principal_id:"invited",created:now,expires:now+60000,consumed_subject:null,consumed_at:null});
  })});
  const [a,b] = await Promise.all([login(f,{subject:"invite-a",emailHash}),login(f,{subject:"invite-b",emailHash})]);
  const responses = await Promise.all([a.complete(),b.complete()]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[303,403]);
  assert.equal((await f.run("SELECT COUNT(*) AS n FROM identity_bindings WHERE principal_id=?","invited")).results[0].n,1);
  assert.equal((await (await login(f,{subject:"disabled-sub",emailHash})).complete()).status,403);
  assert.equal((await f.run("SELECT active FROM identity_bindings WHERE google_sub=?","disabled-sub")).results[0].active,0);
});

test("preview intents and applying leases remain mutually exclusive in the same DO", async t => {
  const f = await fixture(t), token = random(), tokenHash = hash(token);
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",tokenHash,"owner-sub",random(),Date.now()+60000);
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES(?,?,?,?,?,?,'proposed')","proposal","binding","owner","{}","{}",Date.now());
  const env = {PANEL_DB:f.db,VIEW_AS_ENABLED:"1"}, user = {token_hash:tokenHash,principal_id:"owner"};
  const backend = {identity:()=>({principalId:"owner"}),post:async(_path,input)=>({
    contractVersion:"panel-view-as-v1",readOnly:true,action:input.action,entryAuditId:input.entryAuditId || input.auditId,
    targetPersonId:"cadet",status:input.action==="enter"?"ready":"exited",
  })};
  const store = new ProposalStore(f.db,"binding","owner",tokenHash);
  assert.equal(await store.acquire("proposal"),true);
  await assert.rejects(changePreview(env,user,backend,{personId:"cadet"}),{code:"CHANGE_IN_PROGRESS"});
  await store.release("proposal");
  assert.equal((await changePreview(env,user,backend,{personId:"cadet"})).viewAs.readOnly,true);
  assert.equal(await store.acquire("proposal"),false);
  const headers = {cookie:"__Host-shamrock-v2="+token,origin,"content-type":"application/json",
    "x-shamrock-csrf":(await f.db.prepare("SELECT csrf FROM sessions WHERE token_hash=?").bind(tokenHash).first()).csrf};
  const mutation = await f.mf.dispatchFetch(origin+"/api/proposals",{method:"POST",headers,body:"{}"});
  assert.equal(mutation.status,403);
  assert.equal((await mutation.json()).error.code,"VIEW_AS_READ_ONLY");
  await changePreview(env,user,backend,{personId:null});
  assert.equal(await getPreview(env,user),null);
  assert.equal(await store.acquire("proposal"),true);
  await f.run("DELETE FROM sessions WHERE token_hash=?",tokenHash);
  assert.equal((await f.run("SELECT count(*) AS n FROM session_preview_intents")).results[0].n,0);
});

test("simultaneous preview entry and proposal lease cannot both win", async t => {
  const f = await fixture(t), tokenHash = hash(random());
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",tokenHash,"owner-sub",random(),Date.now()+60000);
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES(?,?,?,?,?,?,'proposed')","race-proposal","binding","owner","{}","{}",Date.now());
  const env = {PANEL_DB:f.db,VIEW_AS_ENABLED:"1"}, user = {token_hash:tokenHash,principal_id:"owner"};
  const backend = {identity:()=>({principalId:"owner"}),post:async(_path,input)=>({
    contractVersion:"panel-view-as-v1",readOnly:true,action:input.action,entryAuditId:input.entryAuditId || input.auditId,
    targetPersonId:"cadet",status:input.action==="enter"?"ready":"exited",
  })};
  const store = new ProposalStore(f.db,"binding","owner",tokenHash);
  for (let i = 0; i < 3; i++) {
    const [apply,preview] = await Promise.allSettled([
      store.acquire("race-proposal"),changePreview(env,user,backend,{personId:"cadet"}),
    ]);
    assert.equal(apply.status,"fulfilled");
    assert.equal(Number(apply.value) + Number(preview.status === "fulfilled"),1);
    if (preview.status === "rejected") assert.equal(preview.reason.code,"CHANGE_IN_PROGRESS");
    await store.release("race-proposal");
    await changePreview(env,user,backend,{personId:null});
  }
});

test("missing auth binding or seed never falls back to D1; static assets remain available", async t => {
  let touched = false;
  assert.throws(()=>panelControlStore({ENVIRONMENT:"staging",APP_ORIGIN:origin,GENERATION:"1",AUTH_STORE_VERSION:"1",
    PANEL_DB:{prepare(){touched=true;throw Error("D1 must not be read");}}}),{code:"AUTH_STORE_UNAVAILABLE"});
  assert.equal(touched,false);
  for (const options of [{namespace:false},{bootstrap:null}]) {
    const f = await fixture(t,options);
    assert.equal((await f.mf.dispatchFetch(origin+"/")).status,200);
    const response = await f.request({status:true});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error.code,"AUTH_STORE_UNAVAILABLE");
  }
});

test("bootstrap rollback, immutable fingerprints, cold restart and generation isolation", async t => {
  const persist = await mkdtemp(join(tmpdir(),"shamrock-control-test-"));
  t.after(()=>rm(persist,{recursive:true,force:true}));
  const preservedProposal = {id:"saved-command",binding:"b".repeat(64),principal:"owner",command:'{"id":"original-command"}',
    summary:"{}",created:0,state:"retryable",result:null,lease_token:null,lease_until:0};
  const valid = seed(p=>{
    p.tables.identity_bindings.push({google_sub:"retained-inactive",principal_id:"retained",active:0});
    p.tables.proposals.push(preservedProposal);
  });
  const duplicate = seed(p=>p.tables.identity_bindings.push({...p.tables.identity_bindings[0]}));
  let f = await fixture(t,{persist,bootstrap:duplicate});
  assert.equal((await f.request({status:true})).status,503,"second insert failure rolls back all schema and rows");
  await f.dispose();
  f = await fixture(t,{persist,bootstrap:valid});
  assert.equal((await f.request({status:true})).status,200,"retry can initialize the same object after failed bootstrap");
  const sessionToken = random();
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",hash(sessionToken),"owner-sub",random(),Date.now()+60000);
  await f.dispose();
  f = await fixture(t,{persist,bootstrap:null});
  assert.equal((await f.request({status:true})).status,200,"cold existing object does not need the bootstrap secret");
  assert.equal((await f.run("SELECT active FROM identity_bindings WHERE google_sub=?","retained-inactive")).results[0].active,0);
  assert.deepEqual((await f.run("SELECT * FROM proposals WHERE id=?","saved-command")).results[0],preservedProposal);
  assert.equal((await f.mf.dispatchFetch(origin+"/api/session",{method:"POST",headers:{origin,cookie:"__Host-shamrock-v2="+sessionToken}})).status,200);
  await f.dispose();
  f = await fixture(t,{persist,bootstrap:seed()});
  assert.equal((await f.request({status:true})).status,503,"different reviewed seed cannot rebind initialized storage");
  await f.dispose();
  f = await fixture(t,{persist,bootstrap:null,bindings:{GENERATION:"2"}});
  assert.equal((await f.request({status:true})).status,503,"new generation does not inherit the old object or sessions");
});

test("bootstrap rejects unreviewed destinations, sessions and active or ambiguous applies", async t => {
  const badSeeds = [
    seed(p=>{p.origin="https://other-staging.example.invalid";}),
    seed(p=>{p.tables.sessions=[];}),
    seed(p=>{p.capturedAt="2020-01-01T00:00:00Z";}),
    seed(p=>{p.tables.proposals.push({id:"proposal",binding:"b".repeat(64),principal:"owner",command:"{}",summary:"{}",created:0,state:"applying",result:null,lease_token:null,lease_until:0});}),
    seed(p=>{p.tables.proposals.push({id:"proposal",binding:"b".repeat(64),principal:"owner",command:"{}",summary:"{}",created:0,state:"proposed",result:null,lease_token:"active-lease",lease_until:Date.now()+60000});}),
  ];
  const tampered = JSON.parse(seed()); tampered.sha256="0".repeat(64);badSeeds.push(JSON.stringify(tampered));
  for (const bootstrap of badSeeds) {
    const f = await fixture(t,{bootstrap});
    assert.equal((await f.request({status:true})).status,503);
    await f.dispose();
  }
});

test("two simultaneous staging sessions share one durable assistant reservation", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request({reserve:true}), f.request({reserve:true})]);
  assert.deepEqual((await Promise.all(results.map(r => r.json()))).sort(), [false,true]);
  assert.equal((await (await f.request({status:true})).json()).ready,true);
});
