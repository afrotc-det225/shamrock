import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import {
  verifyGoogleToken,
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
async function fixture(t, backendScript) {
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
  const run = async (sql, ...values) => (await execute([{ sql, values }]))[0];
  const db = {
    prepare: (sql) => ({
      bind: (...values) => ({
        first: async () => (await run(sql, ...values)).results[0] || null,
        all: () => run(sql, ...values),
        run: () => run(sql, ...values),
      }),
    }),
  };
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
    .find((s) => s.startsWith("__Host-shamrock-auth="))
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
      return "verified-sub";
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
    .find((s) => s.startsWith("__Host-shamrock="))
    .split(";")[0];
  assert.match(success.headers.getSetCookie()[0], /Secure; HttpOnly/);
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
test("hosted runtime refuses anonymous sessions, spoofed identity, cross-origin writes and wrong host", async (t) => {
  const f = await fixture(t),
    send = (path, init = {}) => f.mf.dispatchFetch(origin + path, init);
  assert.equal((await send("/api/state")).status, 401);
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
  const cookie = "__Host-shamrock=" + token;
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
    cookie: "__Host-shamrock=" + token,
    origin,
    "content-type": "application/json",
    "x-shamrock-csrf": csrf,
  };
  const state = await f.mf.dispatchFetch(origin + "/api/state", { headers });
  assert.equal(state.status, 200);
  const data = await state.json();
  assert.equal(data.snapshot, undefined);
  assert.deepEqual(data.history, []);
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
