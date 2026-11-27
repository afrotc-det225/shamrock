import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import {
  verifyGoogleToken,
  verifyGoogleIdentity,
  authRoute,
  sha,
  random,
  session,
} from "../hosted/auth.mjs";
import { AdminService as CoreService } from "../service-core.mjs";
import { ProposalStore } from "../hosted/store.mjs";
import { createLocalBackend } from "../backend.mjs";
import { installPanelSchema, digest } from "../hosted/setup.mjs";
import { splitMigrationSql } from "../../../scripts/lib/v3-migrations.mjs";
const root = resolve(import.meta.dirname, "../../..");
await build({
  absWorkingDir: root,
  entryPoints: ["apps/admin/tests/hosted-fixture.mjs"],
  outfile: resolve(root, ".build/admin/hosted-test.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["node:*"],
  plugins: [
    {
      name: "source-domain",
      setup(b) {
        b.onResolve({ filter: /\.build\/(admin|v3)\// }, (a) => ({
          path: a.path.endsWith("/admin/domain.mjs")
            ? resolve(root, "apps/admin/domain-entry.ts")
            : resolve(a.resolveDir, a.path)
                .replace("/.build/v3/", "/")
                .replace(/\.js$/, ".ts"),
        }));
      },
    },
  ],
});
const origin = "https://panel-staging.example.invalid";
async function fixture(t, backendScript, viewAsEnabled = false, envOverrides = {}) {
  const mf = new Miniflare({
    workers: [
      {
        name: "panel",
        modules: true,
        modulesRoot: root,
        scriptPath: resolve(root, ".build/admin/hosted-test.mjs"),
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { PANEL_DB: "panel-test" },
        serviceBindings: { BACKEND: "backend", ASSETS: "assets" },
        bindings: {
          TEST_SECRET: "fictional-local-secret",
          APP_ORIGIN: origin,
          ENVIRONMENT: "staging",
          GOOGLE_CLIENT_ID: "test-client",
          GOOGLE_CLIENT_SECRET: "test-secret",
          BACKEND_ORIGIN: "https://backend-staging.example.invalid",
          BRIDGE_SECRET:
            "fictional-bridge-secret-with-more-than-thirty-two-chars",
          BRIDGE_KEY_ID: "test-key",
          SOURCE_KIND: "sheet",
          SOURCE_RESOURCE: "panel-source",
          GENERATION: "1",
          VIEW_AS_ENABLED: viewAsEnabled ? "1" : "0",
          ...envOverrides,
        },
      },
      {
        name: "backend",
        modules: true,
        compatibilityDate: "2026-07-01",
        script:
          backendScript ||
          'export default {fetch(){return Response.json({error:{code:"NOT_AUTHORIZED",message:"No current permission"}},{status:403})}}',
      },
      {
        name: "assets",
        modules: true,
        compatibilityDate: "2026-07-01",
        script: 'export default {fetch(){return new Response("SHAMROCK")}}',
      },
    ],
    log: new Log(LogLevel.NONE),
  });
  t.after(() => mf.dispose());
  const execute = async (statements) => {
    const response = await mf.dispatchFetch(origin + "/__fixture", {
      method: "POST",
      headers: { "x-fixture-secret": "fictional-local-secret" },
      body: JSON.stringify({ statements }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await execute(
    splitMigrationSql(
      await readFile(new URL("../hosted/schema.sql", import.meta.url), "utf8"),
    ).map((sql) => ({ sql })),
  );
  await execute(splitMigrationSql(await readFile(new URL("../hosted/migrations/0002_view_as.sql", import.meta.url), "utf8")).map(sql => ({sql})));
  await execute(splitMigrationSql(await readFile(new URL("../hosted/migrations/0003_preview_intents.sql", import.meta.url), "utf8")).map(sql => ({sql})));
  await execute(splitMigrationSql(await readFile(new URL("../hosted/migrations/0004_login_invitations.sql", import.meta.url), "utf8")).map(sql => ({sql})));
  const run = async (sql, ...values) => (await execute([{ sql, values }]))[0];
  const db = {
    prepare: (sql) => ({
      bind: (...values) => ({
        sql, values,
        first: async () => (await run(sql, ...values)).results[0] || null,
        all: () => run(sql, ...values),
        run: () => run(sql, ...values),
      }),
    }),
  };
  db.batch = statements => execute(statements.map(({sql,values})=>({sql,values})));
  return { mf, run, db };
}
test("Google JWT requires verified signature, audience, nonce, issuer, time and subject", async () => {
  const pair = await generateKeyPair("RS256"),
    jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const token = async (claims) =>
    new SignJWT({
      sub: "google-sub",
      nonce: "nonce",
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience("test-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  assert.equal(
    await verifyGoogleToken(await token({}), "test-client", "nonce", keys),
    "google-sub",
  );
  for (const claims of [
    { nonce: "wrong" },
    { email_verified: false },
    { azp: "another-client" },
    { sub: "" },
  ])
    await assert.rejects(
      verifyGoogleToken(await token(claims), "test-client", "nonce", keys),
    );
  await assert.rejects(
    verifyGoogleToken(await token({}), "other-client", "nonce", keys),
  );
  const forged = (await token({})).slice(0, -8) + "abcdefgh";
  await assert.rejects(verifyGoogleToken(forged, "test-client", "nonce", keys));
});
test("OAuth state is browser-bound, single-use and PKCE-protected; only subject bindings grant sessions", async (t) => {
  const f = await fixture(t),
    env = {
      PANEL_DB: f.db,
      APP_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    };
  await f.run(
    "INSERT INTO identity_bindings VALUES('verified-sub','operator',1)",
  );
  const start = await authRoute(new Request(origin + "/auth/login"), env);
  const auth = new URL(start.headers.get("location"));
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.equal(auth.searchParams.get("scope"), "openid email");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    auth.searchParams.get("redirect_uri"),
    origin + "/auth/callback",
  );
  const browser = start.headers
    .getSetCookie()
    .find((s) => s.startsWith("__Host-shamrock-auth-v2="))
    .split(";")[0];
  let exchanged = false;
  const fake = {
    fetcher: async (url, options) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.ok(options.body.get("code_verifier"));
      exchanged = true;
      return Response.json({ id_token: "signed-test-token" });
    },
    verify: async (_token, client, nonce) => {
      assert.equal(client, "test-client");
      assert.equal(nonce, auth.searchParams.get("nonce"));
      return {subject:"verified-sub",emailHash:null};
    },
  };
  const callback =
    origin +
    "/auth/callback?state=" +
    auth.searchParams.get("state") +
    "&code=code";
  await assert.rejects(authRoute(new Request(callback), env, fake));
  assert.equal(exchanged, false);
  const success = await authRoute(
    new Request(callback, { headers: { cookie: browser } }),
    env,
    fake,
  );
  assert.equal(success.status, 303);
  const sessionCookie = success.headers
    .getSetCookie()
    .find((s) => s.startsWith("__Host-shamrock-v2="))
    .split(";")[0];
  assert.match(success.headers.getSetCookie()[0], /Secure; HttpOnly/);
  const resume = await authRoute(new Request(origin + "/auth/login", { headers:{cookie:sessionCookie} }),env);
  assert.equal(resume.headers.get("location"),origin + "/");
  assert.deepEqual(resume.headers.getSetCookie(),[]);
  assert.equal(
    (
      await session(
        new Request(origin, { headers: { cookie: sessionCookie } }),
        env,
      )
    ).principal_id,
    "operator",
  );
  await assert.rejects(
    authRoute(
      new Request(callback, { headers: { cookie: browser } }),
      env,
      fake,
    ),
  );
  await f.run("UPDATE identity_bindings SET active=0");
  await assert.rejects(
    session(new Request(origin, { headers: { cookie: sessionCookie } }), env),
  );
});

async function invitationLogin(f) {
  const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);
  jwk.kid='invitation-test';
  const jwks=createLocalJWKSet({keys:[jwk]});
  const env={PANEL_DB:f.db,APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret'};
  return async (subject,email,extra={})=>{
    const start=await authRoute(new Request(origin+'/auth/login'),env);
    const auth=new URL(start.headers.get('location'));
    const browser=start.headers.getSetCookie().find(value=>value.startsWith('__Host-shamrock-auth-v2=')).split(';')[0];
    const token=await new SignJWT({sub:subject,email,email_verified:true,nonce:auth.searchParams.get('nonce'),...extra})
      .setProtectedHeader({alg:'RS256',kid:'invitation-test'}).setIssuer('https://accounts.google.com')
      .setAudience('test-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    return authRoute(new Request(origin+'/auth/callback?state='+auth.searchParams.get('state')+'&code=fictional-code',
      {headers:{cookie:browser}}),env,{fetcher:async()=>Response.json({id_token:token}),
      verify:(value,client,nonce)=>verifyGoogleIdentity(value,client,nonce,jwks)});
  };
}
const invite = async (f,email,principal='invited-flight-reader',expires=Date.now()+60000) => {
  const hash=await sha(email.toLowerCase());
  await f.run('INSERT INTO login_invitations(email_sha256,principal_id,created,expires) VALUES(?,?,?,?)',hash,principal,Date.now()-120000,expires);
  return hash;
};
test('invitation schema bounds expiry and requires complete consumption evidence',async t=>{
  const f=await fixture(t),now=Date.now(),hash=await sha('bounded@example.invalid');
  await assert.rejects(()=>f.run('INSERT INTO login_invitations(email_sha256,principal_id,created,expires) VALUES(?,?,?,?)',hash,'bounded-principal',now,now+86400001));
  await invite(f,'bounded@example.invalid','bounded-principal');
  await assert.rejects(()=>f.run('UPDATE login_invitations SET consumed_at=? WHERE email_sha256=?',now,hash));
  await assert.rejects(()=>f.run('UPDATE login_invitations SET consumed_subject=? WHERE email_sha256=?','incomplete-sub',hash));
  assert.equal((await f.run('SELECT consumed_subject FROM login_invitations WHERE email_sha256=?',hash)).results[0].consumed_subject,null);
});
test('reviewed invitation binds only a signed verified email and actual Google subject',async t=>{
  const f=await fixture(t),login=await invitationLogin(f),hash=await invite(f,'invited@example.invalid');
  const result=await login('verified-invite-sub','Invited@Example.Invalid');
  assert.equal(result.status,303);
  const binding=(await f.run('SELECT * FROM identity_bindings')).results;
  assert.deepEqual(binding,[{google_sub:'verified-invite-sub',principal_id:'invited-flight-reader',active:1}]);
  const saved=(await f.run('SELECT * FROM login_invitations WHERE email_sha256=?',hash)).results[0];
  assert.equal(saved.consumed_subject,'verified-invite-sub');assert(saved.consumed_at>=saved.created);
  assert.equal((await f.run('SELECT COUNT(*) AS n FROM sessions WHERE google_sub=?','verified-invite-sub')).results[0].n,1);
  const again=await login('verified-invite-sub','invited@example.invalid');assert.equal(again.status,303,'later login uses the established subject');
});
test('wrong, unverified, missing, expired and already consumed invitations fail closed',async t=>{
  const f=await fixture(t),login=await invitationLogin(f),hash=await invite(f,'invited@example.invalid');
  await assert.rejects(()=>login('unknown-sub','other@example.invalid'),e=>e.code==='ACCESS_NOT_GRANTED');
  await assert.rejects(()=>login('unverified-sub','invited@example.invalid',{email_verified:false}),e=>e.code==='INVALID_IDENTITY');
  await assert.rejects(()=>login('missing-sub',undefined),e=>e.code==='ACCESS_NOT_GRANTED');
  assert.equal((await f.run('SELECT consumed_subject FROM login_invitations WHERE email_sha256=?',hash)).results[0].consumed_subject,null);
  await invite(f,'expired@example.invalid','expired-principal',Date.now()-1000);
  await assert.rejects(()=>login('expired-sub','expired@example.invalid'),e=>e.code==='ACCESS_NOT_GRANTED');
  await login('first-sub','invited@example.invalid');
  await assert.rejects(()=>login('second-sub','invited@example.invalid'),e=>e.code==='ACCESS_NOT_GRANTED');
  assert.equal((await f.run('SELECT COUNT(*) AS n FROM identity_bindings')).results[0].n,1);
});
test('invitations cannot rebind existing subjects or add logins to an already bound principal',async t=>{
  const f=await fixture(t),login=await invitationLogin(f);
  await f.run("INSERT INTO identity_bindings VALUES('existing-sub','existing-principal',1)");
  await f.run("INSERT INTO identity_bindings VALUES('disabled-sub','disabled-principal',0)");
  const hash=await invite(f,'new@example.invalid');
  assert.equal((await login('existing-sub','new@example.invalid')).status,303);
  assert.equal((await f.run("SELECT principal_id FROM identity_bindings WHERE google_sub='existing-sub'")).results[0].principal_id,'existing-principal');
  assert.equal((await f.run('SELECT consumed_subject FROM login_invitations WHERE email_sha256=?',hash)).results[0].consumed_subject,null);
  await assert.rejects(()=>login('disabled-sub','new@example.invalid'),e=>e.code==='ACCESS_NOT_GRANTED');
  await invite(f,'another@example.invalid','existing-principal');
  await assert.rejects(()=>login('other-sub','another@example.invalid'),e=>e.code==='ACCESS_NOT_GRANTED');
  assert.equal((await f.run('SELECT COUNT(*) AS n FROM identity_bindings')).results[0].n,2);
});
test('concurrent invitation claims admit one subject and transaction failure retains the invitation',async t=>{
  const f=await fixture(t),login=await invitationLogin(f);
  await invite(f,'race@example.invalid');
  const outcomes=await Promise.allSettled([login('racer-one','race@example.invalid'),login('racer-two','race@example.invalid')]);
  assert.equal(outcomes.filter(value=>value.status==='fulfilled'&&value.value.status===303).length,1);
  assert.equal(outcomes.filter(value=>value.status==='rejected'&&value.reason.code==='ACCESS_NOT_GRANTED').length,1);
  assert.equal((await f.run('SELECT COUNT(*) AS n FROM identity_bindings')).results[0].n,1);
  const hash=await invite(f,'rollback@example.invalid','rollback-principal');
  await f.run("CREATE TRIGGER fixture_reject_invite BEFORE UPDATE ON login_invitations WHEN NEW.principal_id='rollback-principal' BEGIN SELECT RAISE(ABORT,'fictional interrupted consume'); END");
  await assert.rejects(()=>login('rollback-sub','rollback@example.invalid'));
  assert.equal((await f.run("SELECT COUNT(*) AS n FROM identity_bindings WHERE google_sub='rollback-sub'")).results[0].n,0);
  assert.equal((await f.run('SELECT consumed_subject FROM login_invitations WHERE email_sha256=?',hash)).results[0].consumed_subject,null);
});

test("hosted runtime refuses anonymous sessions, spoofed identity, cross-origin writes and wrong host", async (t) => {
  const f = await fixture(t),
    send = (path, init = {}) => f.mf.dispatchFetch(origin + path, init);
  assert.match((await send("/")).headers.get("content-type"), /^text\/html/);
  assert.equal((await send("/api/state")).status, 401);
  assert.equal((await send("/api/receipts")).status, 401);
  assert.equal(
    (
      await send("/api/session", {
        method: "POST",
        headers: { origin },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send("/api/state", {
        headers: {
          "x-user-email": "operator@example.invalid",
          "x-principal-id": "operator",
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.mf.dispatchFetch("https://production.example.invalid/api/state"))
      .status,
    403,
  );
  const token = random(),
    csrf = random();
  await f.run("INSERT INTO identity_bindings VALUES('test-sub','operator',1)");
  await f.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    await sha(token),
    "test-sub",
    csrf,
    Date.now() + 60000,
  );
  const cookie = "__Host-shamrock-v2=" + token;
  assert.equal(
    (
      await send("/api/session", {
        method: "POST",
        headers: { origin: "https://evil.invalid", cookie },
        body: "{}",
      })
    ).status,
    403,
  );
  const sessionResponse = await send("/api/session", {
    method: "POST",
    headers: { origin, cookie },
    body: "{}",
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).csrf, csrf);
  assert.equal(
    (
      await send("/api/proposals", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  // Authenticated panel sessions do not replace backend per-operation authority.
  const denied = await send("/api/state", { headers: { cookie } });
  assert.equal(denied.status, 403, await denied.text());
  const out = await send("/auth/logout", {
    method: "POST",
    headers: { origin, cookie, "x-shamrock-csrf": csrf },
  });
  assert.equal(out.status, 200);
  assert.equal((await send("/api/state", { headers: { cookie } })).status, 401);
});

test("durable proposals survive isolates, fence concurrent applies and retain actor scope", async (t) => {
  const f = await fixture(t),
    local = await createLocalBackend();
  t.after(() => local.dispose());
  const one = new CoreService(
    local.backend,
    new ProposalStore(f.db, local.backend.binding, local.backend.principalId),
  );
  const s = await one.snapshot(),
    event = s.events.find((e) => e.eventId === "wolfe"),
    { version, ...rest } = event;
  const p = await one.propose("event.upsert", {
    ...rest,
    label: "Wolfe Talk updated",
    expectedVersion: version,
    flightIds: ["alpha", "bravo"],
  });
  const two = new CoreService(
    local.backend,
    new ProposalStore(f.db, local.backend.binding, local.backend.principalId),
  );
  const replies = await Promise.allSettled([
    one.apply(p.id, true),
    two.apply(p.id, true),
  ]);
  assert.ok(replies.some((r) => r.status === "fulfilled"));
  assert.equal(
    (await one.snapshot()).events.find((e) => e.eventId === "wolfe").version,
    2,
  );
  await two.apply(p.id, true);
  assert.equal(
    (await one.snapshot()).events.find((e) => e.eventId === "wolfe").version,
    2,
  );
  const outsider = new CoreService(
    { ...local.backend, principalId: "different-person" },
    new ProposalStore(f.db, local.backend.binding, "different-person"),
  );
  await assert.rejects(outsider.apply(p.id, true), { code: "NOT_FOUND" });
  assert.equal((await two.history())[0].state, "complete");
});

test("setup refuses nonempty or mismatched databases and pins immutable schema identity", async () => {
  const target = {
      workerName: "shamrock-admin-staging",
      origin: "https://shamrock-admin-staging.det225.workers.dev",
      databaseName: "shamrock-admin-staging",
      databaseId: "00000000-0000-0000-0000-000000000001",
    },
    schema = await readFile(
      new URL("../hosted/schema.sql", import.meta.url),
      "utf8",
    ),
    sourceCommit = "a".repeat(40);
  let applied = 0;
  const base = {
    target,
    schema,
    sourceCommit,
    apply: async () => {
      applied++;
    },
  };
  await assert.rejects(
    installPanelSchema({
      ...base,
      inspect: async () => ({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        tables: ["people"],
      }),
    }),
    /NOT_EMPTY/,
  );
  assert.equal(applied, 0);
  await assert.rejects(
    installPanelSchema({
      ...base,
      inspect: async () => ({
        databaseId: "wrong",
        databaseName: target.databaseName,
        tables: [],
      }),
    }),
    /TARGET_MISMATCH/,
  );
  let installation;
  const inspect = async () => ({
    databaseId: target.databaseId,
    databaseName: target.databaseName,
    tables: installation ? ["panel_schema"] : [],
    installation,
  });
  const apply = async (received, statements, guard) => {
    assert.deepEqual(received, target);
    assert.equal(guard.expectedEmpty, true);
    assert.match(statements[1].sql, /NOT EXISTS/);
    const pin = statements.find((s) =>
      s.sql.startsWith("INSERT INTO panel_schema"),
    );
    installation = {
      sha256: pin.params[0],
      database_id: pin.params[1],
      worker_name: pin.params[2],
      origin: pin.params[3],
    };
    applied++;
  };
  assert.equal(
    (await installPanelSchema({ ...base, inspect, apply })).status,
    "installed",
  );
  assert.equal(
    (await installPanelSchema({ ...base, inspect, apply })).status,
    "already-installed",
  );
  assert.equal(applied, 1);
  await assert.rejects(
    installPanelSchema({
      ...base,
      schema: schema + "--changed",
      inspect,
      apply,
    }),
    /SCHEMA_CHANGED/,
  );
});
test("public login is bounded and cleanup retains uncertain proposals", async (t) => {
  const f = await fixture(t),
    env = {
      PANEL_DB: f.db,
      APP_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    };
  for (let i = 0; i < 10; i++)
    await authRoute(new Request(origin + "/auth/login"), env);
  await assert.rejects(authRoute(new Request(origin + "/auth/login"), env), {
    code: "SIGN_IN_LIMIT",
  });
  await f.run(
    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1999) INSERT INTO auth_limits SELECT 'capacity-'||x,1,? FROM n",
    Date.now() + 600000,
  );
  await assert.rejects(
    authRoute(
      new Request(origin + "/auth/login", {
        headers: { "cf-connecting-ip": "192.0.2.5" },
      }),
      env,
    ),
    { code: "SIGN_IN_LIMIT" },
  );
  assert.equal(
    (await f.run("SELECT COUNT(*) AS n FROM auth_limits")).results[0].n,
    2000,
  );
  const now = Date.now();
  for (const [id, state, age] of [
    ["unfinished", "retryable", 100],
    ["completed", "complete", 100],
    ["recent", "complete", 1],
    ["discarded", "cancelled", 40],
  ])
    await f.run(
      "INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES(?,?,?,?,?,?,?)",
      id,
      "binding",
      "actor",
      "{}",
      "{}",
      now - age * 86400000,
      state,
    );
  await f.run(
    "INSERT INTO oauth_states VALUES(?,?,?,?,?)",
    "expired",
    "browser",
    "verifier",
    "nonce",
    now - 1000,
  );
  const response = await f.mf.dispatchFetch(origin + "/__fixture", {
    method: "POST",
    headers: { "x-fixture-secret": "fictional-local-secret" },
    body: JSON.stringify({ cleanup: true }),
  });
  assert.equal(response.status, 200);
  const retained = await f.run("SELECT id FROM proposals ORDER BY id");
  assert.deepEqual(
    retained.results.map((r) => r.id),
    ["recent", "unfinished"],
  );
  assert.equal(
    (
      await f.run(
        "SELECT COUNT(*) AS n FROM oauth_states WHERE state_hash='expired'",
      )
    ).results[0].n,
    0,
  );
});

test("scoped HTTP sessions cannot reach full pages, management or transition routes", async (t) => {
  const script = `export default {async fetch(request){
    const body=await request.json();
    if(new URL(request.url).pathname==='/v1/admin/panel/page' && body.section==='manifest')
      return Response.json({contractVersion:'panel-pages-v1',section:'manifest',revision:{operations:1,administration:1,access:'a'.repeat(64)},access:{mode:'scoped',flightIds:['alpha'],capabilities:{fullSnapshot:false,attendanceReportFlightIds:['alpha'],attendanceCorrectionFlightIds:[]}}});
    return Response.json({error:{code:'FORBIDDEN',message:'Unavailable'}},{status:403});
  }};`;
  const f = await fixture(t, script),
    token = random(),
    csrf = random();
  await f.run(
    "INSERT INTO identity_bindings VALUES('scoped-sub','scoped-principal',1)",
  );
  await f.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    await sha(token),
    "scoped-sub",
    csrf,
    Date.now() + 60000,
  );
  const headers = {
    cookie: "__Host-shamrock-v2=" + token,
    origin,
    "content-type": "application/json",
    "x-shamrock-csrf": csrf,
  };
  const state = await f.mf.dispatchFetch(origin + "/api/state", { headers });
  assert.equal(state.status, 200);
  const data = await state.json();
  assert.equal(data.snapshot, undefined);
  assert.equal(data.history, undefined);
  assert.equal(data.receiptsDeferred, false);
  assert.equal(data.transport, "paged-v1");
  for (const [path, body] of [
    [
      "/api/page",
      {
        surface: "full",
        section: "directory-catalog",
        offset: 0,
        revision: null,
        accessRevision: data.manifest.revision,
        principalId: "owner",
      },
    ],
    [
      "/api/proposals",
      {
        operation: "directory.upsert",
        payload: { personId: "private-target" },
      },
    ],
    ["/api/proposals", { operation: "transition.prepare", payload: {} }],
  ]) {
    const r = await f.mf.dispatchFetch(origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 403, path);
  }
  assert.equal(
    (
      await f.mf.dispatchFetch(origin + "/api/transition?id=private-plan", {
        headers,
      })
    ).status,
    403,
  );
  assert.equal((await f.mf.dispatchFetch(origin + "/api/receipts", { headers })).status, 403);
  assert.equal(
    (
      await f.mf.dispatchFetch(origin + "/api/page", {
        method: "POST",
        headers: { ...headers, "x-shamrock-csrf": "invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
});

test("hosted state defers receipts; receipt reads retain the authenticated principal and backend binding", async t => {
  const script = `export default {async fetch(request){
    const body=await request.json();
    if(!['/v1/admin/panel/page','/v1/admin/panel/access'].includes(new URL(request.url).pathname)||body.principalId!=='operator')
      return Response.json({error:{code:'FORBIDDEN',message:'Unavailable'}},{status:403});
    return Response.json({section:'manifest',revision:{operations:1,administration:1,access:'a'.repeat(64)},access:{capabilities:{fullSnapshot:true}}});
  }};`;
  const f=await fixture(t,script),token=random(),hash=await sha(token);
  await f.run("INSERT INTO identity_bindings VALUES('receipt-sub','operator',1)");
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",hash,'receipt-sub',random(),Date.now()+60000);
  const headers={cookie:'__Host-shamrock-v2='+token,'x-principal-id':'someone-else'};
  const binding=digest(JSON.stringify(['https://backend-staging.example.invalid',1,'operator','sheet','panel-source','test-key']));
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES('own',?,'operator','{}','not-json',1,'complete')",binding);
  const state=await f.mf.dispatchFetch(origin+'/api/state',{headers});
  assert.equal(state.status,200,'state must not parse stored receipt payloads');
  const data=await state.json();assert.equal(data.history,undefined);assert.equal(data.receiptsDeferred,true);
  await f.run("UPDATE proposals SET summary=? WHERE id='own'",JSON.stringify({title:'Fictional saved event',target:'Event'}));
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES('other-person',?,'someone-else','{}','not-json',2,'complete')",binding);
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES('other-backend','other-binding','operator','{}','not-json',3,'complete')");
  const response=await f.mf.dispatchFetch(origin+'/api/receipts',{headers});
  assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.contractVersion,'admin-receipts-v1');
  assert.deepEqual(body.receipts.map(row=>row.id),['own']);
  await f.run("UPDATE identity_bindings SET active=0 WHERE google_sub='receipt-sub'");
  assert.equal((await f.mf.dispatchFetch(origin+'/api/receipts',{headers})).status,401);
});

test('unchanged state uses fresh authority without recounting, and never reuses another binding or stale revision',async t=>{
  const script=`let manifests=0;export default{async fetch(request){
    const input=await request.json(),path=new URL(request.url).pathname;
    if(input.principalId!=='operator')return Response.json({error:{code:'NOT_AUTHORIZED'}},{status:403});
    const value={revision:{operations:1,administration:1,access:'a'.repeat(64)},access:{capabilities:{fullSnapshot:true}}};
    if(path==='/v1/admin/panel/access')return Response.json({...value,section:'verify',verified:true});
    if(path==='/v1/admin/panel/page')return Response.json({...value,section:'manifest',manifests:++manifests});
    return new Response(null,{status:404});}};`;
  const f=await fixture(t,script),token=random();
  await f.run("INSERT INTO identity_bindings VALUES('cached-sub','operator',1)");
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",await sha(token),'cached-sub',random(),Date.now()+60000);
  const headers={cookie:'__Host-shamrock-v2='+token};
  const first=await(await f.mf.dispatchFetch(origin+'/api/state',{headers})).json();assert.equal(first.manifest.manifests,1);
  const capture={captureKey:first.captureKey,revision:first.manifest.revision,viewAsRevision:null};
  const refresh=async value=>f.mf.dispatchFetch(origin+'/api/state',{headers:{...headers,'x-shamrock-capture':encodeURIComponent(JSON.stringify(value))}});
  const same=await(await refresh(capture)).json();assert.equal(same.captureUnchanged,true);assert.equal(same.manifest,undefined);assert.equal(same.snapshot,undefined);
  const changed=await(await refresh({...capture,revision:{...capture.revision,operations:0}})).json();assert.equal(changed.captureUnchanged,undefined);assert.equal(changed.manifest.manifests,2);
  const other=await(await refresh({...capture,captureKey:'other-binding'})).json();assert.equal(other.manifest.manifests,3);
  assert.equal((await refresh({...capture,extra:true})).status,400);
  await f.run("UPDATE identity_bindings SET active=0 WHERE google_sub='cached-sub'");
  assert.equal((await refresh(capture)).status,401);
});

test("receipt reads discard results when authority is revoked before the final access check",async t=>{
  const script=`let reads=0;export default {async fetch(){
    if(++reads>1)return Response.json({error:{code:'NOT_AUTHORIZED',message:'Access revoked'}},{status:403});
    return Response.json({revision:{operations:1,administration:1,access:'a'.repeat(64)},access:{capabilities:{fullSnapshot:true}}});
  }};`;
  const f=await fixture(t,script),token=random();
  await f.run("INSERT INTO identity_bindings VALUES('receipt-sub','operator',1)");
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",await sha(token),'receipt-sub',random(),Date.now()+60000);
  const response=await f.mf.dispatchFetch(origin+'/api/receipts',{headers:{cookie:'__Host-shamrock-v2='+token}});
  assert.equal(response.status,403);assert.equal((await response.json()).receipts,undefined);
});

test('View as keeps the verified actor, wraps reads, and blocks every mutation even without preview headers', async t => {
  const script=`export default {async fetch(request){
    const b=await request.json(),path=new URL(request.url).pathname;
    if(b.principalId!=='actual-admin')return Response.json({error:{code:'WRONG_ACTOR'}},{status:403});
    if(path==='/v1/admin/panel/view-as/authorize') {
      if(b.action==='exit')return Response.json({error:{code:'REVOKED'}},{status:403});
      return Response.json({contractVersion:'panel-view-as-v1',readOnly:true,action:'enter',entryAuditId:b.auditId,targetPersonId:b.targetPersonId,targetPrincipalId:'flight-reader',status:'ready',access:{mode:'scoped',flightIds:['alpha'],capabilities:{fullSnapshot:false,attendanceCorrectionFlightIds:[],attendanceReportFlightIds:['alpha']}}});
    }
    if(path==='/v1/admin/panel/view-as/access'&&b.targetPersonId==='selected-cadet')return Response.json({contractVersion:'panel-view-as-access-v1',readOnly:true,environment:'staging',generation:1,entryAuditId:b.entryAuditId,targetPersonId:b.targetPersonId,viewRevision:'a'.repeat(64),access:{capabilities:{fullSnapshot:false}}});
    if(path==='/v1/admin/panel/view-as/page'&&b.targetPersonId==='selected-cadet')return Response.json({contractVersion:'panel-view-as-page-v1',readOnly:true,environment:'staging',generation:1,entryAuditId:b.entryAuditId,targetPersonId:b.targetPersonId,targetPrincipalId:'flight-reader',viewRevision:'a'.repeat(64),kind:b.kind,page:{contractVersion:'panel-pages-v1',section:'manifest',revision:{access:'scoped'},access:{mode:'scoped',flightIds:['alpha'],capabilities:{fullSnapshot:false,attendanceCorrectionFlightIds:[],attendanceReportFlightIds:['alpha']}}}});
    return Response.json({error:{code:'UNWRAPPED_ROUTE',message:'Unexpected route'}},{status:403});
  }};`;
  const f=await fixture(t,script,true), token=random(),csrf=random(),hash=await sha(token);
  await f.run("INSERT INTO identity_bindings VALUES('actual-sub','actual-admin',1)");
  await f.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,'actual-sub',csrf,Date.now()+60000);
  const headers={cookie:'__Host-shamrock-v2='+token,origin,'content-type':'application/json','x-shamrock-csrf':csrf};
  const post=(path,body)=>f.mf.dispatchFetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});
  const entered=await post('/api/view-as',{personId:'selected-cadet'});assert.equal(entered.status,200);
  const state=await f.mf.dispatchFetch(origin+'/api/state',{headers});assert.equal(state.status,200);
  const data=await state.json();assert.equal(data.viewAs.personId,'selected-cadet');assert.equal(data.manifest.access.capabilities.fullSnapshot,false);assert.equal(data.viewAsRevision,'a'.repeat(64));
  const menu=await f.mf.dispatchFetch(origin+'/api/navigation?include=leadership',{headers});
  assert.equal(menu.status,200);
  assert.deepEqual(await menu.json(),{leadership:{full:false,assistantAvailable:false,canViewAs:false}});
  const chartResponse=await f.mf.dispatchFetch(origin+'/api/wing-charts',{headers});
  assert.equal(chartResponse.status,403);
  assert.equal((await chartResponse.json()).error.code,'FORBIDDEN');
  const binding=await f.run('SELECT principal_id FROM identity_bindings WHERE google_sub=?','actual-sub');assert.equal(binding.results[0].principal_id,'actual-admin');
  for(const path of ['/api/cadet','/api/proposals','/api/proposals/00000000-0000-4000-8000-000000000001/apply','/api/proposals/00000000-0000-4000-8000-000000000001/cancel','/api/chat']){
    const r=await post(path,{operation:'excusal.decide',approved:true,payload:{}});assert.equal(r.status,403);assert.equal((await r.json()).error.code,'VIEW_AS_READ_ONLY');
  }
  assert.equal((await f.mf.dispatchFetch(origin+'/api/transition?id=saved',{headers})).status,403);
  assert.equal((await f.mf.dispatchFetch(origin+'/api/receipts',{headers})).status,403);
  assert.equal((await post('/api/page',{surface:'full',section:'people',offset:0})).status,409,'missing revision cannot bypass preview');
  const exited=await post('/api/view-as',{personId:null});assert.equal(exited.status,200,'exit succeeds despite revoked audit authority');assert.equal((await exited.json()).viewAs,null);
  assert.equal((await f.run('SELECT count(*) AS n FROM session_previews')).results[0].n,0);
});

test('View as entry and proposal apply leases exclude each other',async t=>{
  const f=await fixture(t),hash='fictional-session';
  await f.run("INSERT INTO identity_bindings VALUES('sub','owner',1)");
  await f.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,'sub','csrf',Date.now()+60000);
  await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES('saved','binding','owner','{}','{}',?,'prepared')",Date.now());
  await f.run("INSERT INTO session_previews VALUES(?,?,?,'ready')",hash,'cadet','audit-entry');
  const store=new ProposalStore(f.db,'binding','owner',hash);
  assert.equal(await store.acquire('saved'),false);
  await f.run('DELETE FROM session_previews WHERE token_hash=?',hash);
  assert.equal(await store.acquire('saved'),true);
  const {changePreview}=await import('../hosted/view-as.mjs');
  const backend={identity:()=>({principalId:'owner'}),post:async()=>({contractVersion:'panel-view-as-v1',readOnly:true,action:'enter',entryAuditId:'entry',targetPersonId:'cadet',status:'ready'})};
  await assert.rejects(()=>changePreview({VIEW_AS_ENABLED:'1',PANEL_DB:f.db},{token_hash:hash,principal_id:'owner'},backend,{personId:'cadet'}),e=>e.code==='CHANGE_IN_PROGRESS');
  assert.equal((await f.run('SELECT count(*) AS n FROM session_previews')).results[0].n,0);
});

test('preview audit requests retain IDs before network calls and resume lost entry/exit replies',async t=>{
 const f=await fixture(t),hash='retry-preview';
 await f.run("INSERT INTO identity_bindings VALUES('retry-sub','owner',1)");
 await f.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,'retry-sub','csrf',Date.now()+60000);
 const {changePreview,getPreview}=await import('../hosted/view-as.mjs'),env={VIEW_AS_ENABLED:'1',PANEL_DB:f.db},user={token_hash:hash,principal_id:'owner'},calls=[];
 let failEnter=true,failExit=true;
 const backend={identity:()=>({principalId:'owner'}),post:async(_path,input)=>{
  calls.push(input);
  if(input.action==='enter'&&failEnter){failEnter=false;throw Error('Lost entry response');}
  if(input.action==='exit'&&failExit){failExit=false;throw Error('Lost exit response');}
  return {contractVersion:'panel-view-as-v1',readOnly:true,action:input.action,entryAuditId:input.entryAuditId||input.auditId,targetPersonId:'cadet',status:input.action==='enter'?'ready':'exited'};
 }};
 await assert.rejects(()=>changePreview(env,user,backend,{personId:'cadet'}),/Lost entry/);
 assert.equal((await getPreview(env,user)).status,'starting');
 await f.run("INSERT INTO proposals(id,binding,principal,command,summary,created,state) VALUES('pending','binding','owner','{}','{}',?,'prepared')",Date.now());
 assert.equal(await new ProposalStore(f.db,'binding','owner',hash).acquire('pending'),false,'pending entry blocks mutation leases');
 assert.equal((await changePreview(env,user,backend,{personId:'cadet'})).viewAs.status,'ready');
 assert.equal(calls[0].auditId,calls[1].auditId);
 const firstExit=await changePreview(env,user,backend,{personId:null});assert.equal(firstExit.auditRecorded,false);assert.equal(await getPreview(env,user),null);
 assert.equal((await changePreview(env,user,backend,{personId:null})).auditRecorded,true);
 assert.equal(calls[2].auditId,calls[3].auditId);assert.equal(calls[2].entryAuditId,calls[0].auditId);
 assert.equal((await f.run('SELECT count(*) AS n FROM session_preview_intents')).results[0].n,0);
});

test('a delayed entry reply cannot restore preview after Exit',async t=>{
 const f=await fixture(t),hash='cancel-preview';
 await f.run("INSERT INTO identity_bindings VALUES('cancel-sub','owner',1)");
 await f.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,'cancel-sub','csrf',Date.now()+60000);
 const {changePreview,getPreview}=await import('../hosted/view-as.mjs'),env={VIEW_AS_ENABLED:'1',PANEL_DB:f.db},user={token_hash:hash,principal_id:'owner'};
 let release,started;const held=new Promise(r=>{release=r;}),observed=new Promise(r=>{started=r;});
 const backend={identity:()=>({principalId:'owner'}),post:async(_path,input)=>{
  if(input.action==='enter'){started();await held;}
  return {contractVersion:'panel-view-as-v1',readOnly:true,action:input.action,entryAuditId:input.entryAuditId||input.auditId,targetPersonId:'cadet',status:input.action==='enter'?'ready':'exited'};
 }};
 const entering=changePreview(env,user,backend,{personId:'cadet'});await observed;
 await changePreview(env,user,backend,{personId:null});release();
 await assert.rejects(entering,e=>e.code==='VIEW_AS_CANCELLED');
 assert.equal(await getPreview(env,user),null);
});


test("operational database quota retains a bounded retry deadline through the panel", async t => {
  const script = `export default {fetch(request){const input=new URL(request.url).pathname;
    return Response.json({error:{code:'SERVICE_LIMIT_REACHED',message:'Database daily allowance reached.'}},
      {status:503,headers:{'Retry-After':'3600','x-private-provider':'never-forward'}});
  }};`;
  const f=await fixture(t,script),token=random();
  await f.run("INSERT INTO identity_bindings VALUES('quota-sub','operator',1)");
  await f.run("INSERT INTO sessions VALUES(?,?,?,?)",await sha(token),'quota-sub',random(),Date.now()+60000);
  const headers={cookie:'__Host-shamrock-v2='+token};
  const response=await f.mf.dispatchFetch(origin+'/api/state',{headers});
  assert.equal(response.status,503);
  assert.equal(response.headers.get('retry-after'),'3600');
  assert.equal(response.headers.get('x-private-provider'),null);
  assert.equal((await response.json()).error.code,'SERVICE_LIMIT_REACHED');
  assert.equal((await f.mf.dispatchFetch(origin+'/api/session',{method:'POST',headers:{...headers,origin}})).status,200);
});

test("backend retry deadlines reject unbounded or malformed provider values", async () => {
  const {HostedBackend}=await import('../hosted/backend.mjs');
  for(const [header,expected] of [['1',1],['86400',86400],['0',undefined],['86401',undefined],['1.5',undefined],['tomorrow',undefined],['',undefined]]) {
    const backend=new HostedBackend({ENVIRONMENT:'staging',GENERATION:'1',BACKEND_ORIGIN:'https://backend-staging.example.invalid',
      BACKEND:{fetch:async()=>Response.json({error:{code:'SERVICE_LIMIT_REACHED',message:'Unavailable'}},{status:503,headers:{'Retry-After':header}})},
      BRIDGE_SECRET:'fictional-bridge-secret-with-more-than-thirty-two-chars',BRIDGE_KEY_ID:'test-key',SOURCE_KIND:'test',SOURCE_RESOURCE:'fixture'},'operator');
    await assert.rejects(backend.send('/v1/admin/panel/access',backend.identity()),error=>error.retryAfterSeconds===expected&&error.status===503);
  }
});

test("canonical sign-in is restricted to the reviewed real-data installation", async t => {
  const canonical = "https://shamrock.det225.workers.dev";
  const config = {
    APP_ORIGIN: "https://shamrock-admin-staging.det225.workers.dev",
    STAGING_DATASET: "real",
    BACKEND_SERVICE_NAME: "shamrock-real-parity",
    BACKEND_ORIGIN: "https://shamrock-real-parity.det225.workers.dev",
  };
  const {mf} = await fixture(t, undefined, false, config);
  const login = await mf.dispatchFetch(canonical + "/auth/login", {redirect:"manual"});
  assert.equal(login.status, 303);
  assert.equal(new URL(login.headers.get("location")).searchParams.get("redirect_uri"),
    canonical + "/auth/callback");
  assert.equal((await mf.dispatchFetch(canonical + ".example.invalid/health")).status, 403);
  const wrong = await fixture(t, undefined, false, {...config, STAGING_DATASET:"fictional"});
  assert.equal((await wrong.mf.dispatchFetch(canonical + "/health")).status, 403);
});

test("Wing charts share a revision across Wing readers and close on revocation or revision drift", async t => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  const browse = await local.backend.post("/v1/admin/panel/browse", {...local.backend.identity(), profile:"attendance"});
  const script = `let loads=0,drift=0; export default {async fetch(req) {
    const {principalId} = await req.json(), browse=${JSON.stringify(browse)};
    if (new URL(req.url).pathname.endsWith("/browse")) {
      if (++loads !== (principalId === "updated" ? 2 : 1)) return Response.json({error:{code:"EXTRA_MATRIX_READ"}},{status:503});
      if (principalId === "updated") browse.revision.operations++;
      return Response.json(browse);
    }
    const changed = principalId === "updated" || principalId === "drifting" && ++drift > 1;
    return Response.json({scope:browse.scope, revision:{...browse.revision, operations:browse.revision.operations + Number(changed)},
      access:{capabilities:{fullSnapshot:principalId !== "flight"}}});
  }}`;
  const f = await fixture(t, script);
  async function visit(actor) {
    const token = random();
    await f.run("INSERT INTO identity_bindings VALUES(?,?,1)", actor, actor);
    await f.run("INSERT INTO sessions VALUES(?,?,?,?)", await sha(token), actor, random(), Date.now()+60000);
    return f.mf.dispatchFetch(origin+"/api/wing-charts",{headers:{cookie:"__Host-shamrock-v2="+token}});
  }
  assert.equal((await f.mf.dispatchFetch(origin+"/api/wing-charts")).status,401);
  const one = await visit("wing-1");
  assert.equal(one.status,200);
  const first = await one.json();
  assert(first.dashboard.attendanceByFlight.length);
  assert.equal(first.dashboard.birthdays,undefined);
  assert.equal(first.dashboard.matrices,undefined);
  const next=await (await visit("wing-2")).json();
  assert.deepEqual(next.dashboard,first.dashboard);
  assert.notEqual(next.captureKey,first.captureKey);
  assert.equal((await visit("flight")).status,403);
  assert.equal((await visit("drifting")).status,409);
  const updated = await visit("updated");
  assert.equal(updated.status,200);
  assert.equal((await updated.json()).revision.operations,first.revision.operations+1);
});

test('campus sign-in binds a verified school subject once, outside operational D1',async t=>{
  const f=await fixture(t),login=await invitationLogin(f);
  const addr='fictional-cadet@nd.edu',sub='fictional-managed-subject';
  await assert.rejects(login(sub,addr),e=>e.code==='ACCESS_NOT_GRANTED');
  const reviewedAddress='reviewed-fictional@valpo.edu', reviewedSubject='custodian-confirmed-subject';
  await f.run('INSERT INTO identity_bindings VALUES(?,?,1)',reviewedSubject,'reviewed-test-principal');
  const reviewedLogin=await login(reviewedSubject,reviewedAddress);
  const reviewedCookie=reviewedLogin.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const reviewedUser=await session(new Request(origin+'/api/cadet',{headers:{cookie:reviewedCookie}}),{PANEL_DB:f.db,APP_ORIGIN:origin,GOOGLE_CLIENT_SECRET:'test-secret'});
  assert.equal(reviewedUser.schoolEmail,reviewedAddress);assert.equal(reviewedUser.principal_id,'reviewed-test-principal');
  const first=await login(sub,addr,{hd:'nd.edu'});assert.equal(first.status,303);
  const cookies=first.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const env={PANEL_DB:f.db,APP_ORIGIN:origin,GOOGLE_CLIENT_SECRET:'test-secret'};
  const user=await session(new Request(origin+'/api/cadet',{headers:{cookie:cookies}}),env);
  assert.equal(user.schoolEmail,addr);assert.equal(user.principal_id,'school.'+await sha(addr));
  await assert.rejects(login('fictional-second-subject',addr,{hd:'nd.edu'}),e=>e.code==='ACCESS_NOT_GRANTED');
  await assert.rejects(login(sub,'different@nd.edu',{hd:'nd.edu'}),e=>e.code==='ACCESS_NOT_GRANTED');
  await assert.rejects(session(new Request(origin+'/api/cadet',{headers:{cookie:cookies.replace(/__Host-shamrock-school=[^;]*/,'__Host-shamrock-school=invalid')}}),env));
  await f.run('UPDATE identity_bindings SET active=0 WHERE google_sub=?',sub);
  await assert.rejects(session(new Request(origin+'/api/cadet',{headers:{cookie:cookies}}),env));
});
