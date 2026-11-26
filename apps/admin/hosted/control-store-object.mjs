import { reserve } from "./openai-assistant.mjs";
import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import baseSchema from "./schema.sql";
import previewSchema from "./migrations/0002_view_as.sql";
import intentSchema from "./migrations/0003_preview_intents.sql";
import invitationSchema from "./migrations/0004_login_invitations.sql";

const digest = value => createHash("sha256").update(value).digest("hex");
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).length;
const fail = () => { throw new Error("AUTH_STORE_UNAVAILABLE"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const tableColumns = {
  identity_bindings: ["google_sub", "principal_id", "active"],
  login_invitations: ["email_sha256", "principal_id", "created", "expires", "consumed_subject", "consumed_at"],
  proposals: ["id", "binding", "principal", "command", "summary", "created", "state", "result", "lease_token", "lease_until"],
};
const metaSchema = `CREATE TABLE auth_store_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1),
  environment TEXT NOT NULL CHECK(environment='staging'), origin TEXT NOT NULL, generation INTEGER NOT NULL,
  schema_sha256 TEXT NOT NULL, inventory_sha256 TEXT NOT NULL, bootstrap_sha256 TEXT NOT NULL,
  source_commit TEXT NOT NULL, captured_at TEXT NOT NULL
);`;
const schema = [baseSchema, previewSchema, intentSchema, invitationSchema, metaSchema].join("\n");
const schemaSha256 = digest(schema);
const inventorySql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('__cf_kv','_cf_KV','_cf_METADATA') ORDER BY name";

function bootstrap(env, now, fresh) {
  const source = env.AUTH_STORE_BOOTSTRAP;
  if (typeof source !== "string" || bytes(source) > 5000) fail();
  let value;
  try { value = JSON.parse(source); } catch { fail(); }
  if (!exact(value, ["sha256", "payload"]) || !sha(value.sha256) ||
      value.sha256 !== digest(JSON.stringify(value.payload))) fail();
  const p = value.payload;
  if (!exact(p, ["contractVersion", "environment", "origin", "generation", "sourceCommit", "capturedAt", "tables"]) ||
      p.contractVersion !== 1 || p.environment !== "staging" || p.origin !== env.APP_ORIGIN ||
      p.generation !== Number(env.GENERATION) || !/^[a-f0-9]{40}$/.test(p.sourceCommit) ||
      typeof p.capturedAt !== "string" || !Number.isFinite(Date.parse(p.capturedAt)) ||
      fresh && (Date.parse(p.capturedAt) > now + 30000 || now - Date.parse(p.capturedAt) > 1800000) ||
      !exact(p.tables, Object.keys(tableColumns))) fail();
  for (const [table, columns] of Object.entries(tableColumns)) {
    const rows = p.tables[table];
    if (!Array.isArray(rows) || rows.length > 2000) fail();
    for (const row of rows) {
      if (!exact(row, columns)) fail();
      if (table === "identity_bindings" && (!text(row.google_sub, 255) || !identifier(row.principal_id) || ![0, 1].includes(row.active))) fail();
      if (table === "login_invitations" && (!sha(row.email_sha256) || !identifier(row.principal_id) ||
          !integer(row.created) || !integer(row.expires) || row.expires <= row.created || row.expires - row.created > 86400000 ||
          !(row.consumed_subject === null && row.consumed_at === null || text(row.consumed_subject, 255) && integer(row.consumed_at)))) fail();
      if (table === "proposals" && (!text(row.id, 128) || !sha(row.binding) || !identifier(row.principal) ||
          !text(row.command, 128000) || !text(row.summary, 128000) || !integer(row.created) ||
          !["proposed", "continuing", "complete", "cancelled", "conflict", "rejected", "retryable"].includes(row.state) ||
          !(row.result === null || text(row.result, 128000)) || !(row.lease_token === null || text(row.lease_token, 128)) ||
          !integer(row.lease_until) || fresh && row.lease_until > now)) fail();
    }
  }
  return value;
}

function validateCall(statements) {
  if (!Array.isArray(statements) || !statements.length || statements.length > 32 || bytes(JSON.stringify(statements)) > 262144) fail();
  for (const s of statements) {
    if (!exact(s, ["sql", "values"]) || typeof s.sql !== "string" || bytes(s.sql) > 16384 ||
        !/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(s.sql) || /;|\0|\b(?:auth_store_meta|sqlite_schema|sqlite_master|PRAGMA|ATTACH|DETACH)\b/i.test(s.sql) ||
        !Array.isArray(s.values) || s.values.length > 100 ||
        s.values.some(value => value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))) fail();
  }
}

// One object is the transaction boundary for one staging panel installation.
// Its session/preview/proposal lease invariants deliberately share one store;
// operational cadet data, records and audit receipts remain in the separate D1 backend.
export class StagingPanelStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      try {
        const origin = new URL(env.APP_ORIGIN);
        if (env.AUTH_STORE_VERSION !== "1" || env.ENVIRONMENT !== "staging" ||
            origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN || !origin.hostname.includes("staging") ||
            !Number.isSafeInteger(Number(env.GENERATION)) || Number(env.GENERATION) < 1) fail();
        const inventory = ctx.storage.sql.exec(inventorySql).toArray();
        if (!inventory.length) {
          const seed = bootstrap(env, Date.now(), true);
          ctx.storage.transactionSync(() => {
            if (ctx.storage.sql.exec(inventorySql).toArray().length) fail();
            ctx.storage.sql.exec(schema);
            for (const [table, columns] of Object.entries(tableColumns)) {
              for (const row of seed.payload.tables[table]) {
                ctx.storage.sql.exec(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`, ...columns.map(c => row[c]));
              }
              const actual = ctx.storage.sql.exec(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns[0]}`).toArray();
              const expected = seed.payload.tables[table].map(row => Object.fromEntries(columns.map(c => [c, row[c]])))
                .sort((a, b) => a[columns[0]] < b[columns[0]] ? -1 : a[columns[0]] > b[columns[0]] ? 1 : 0);
              if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
            }
            const inventoryHash = digest(JSON.stringify(ctx.storage.sql.exec(inventorySql).toArray()));
            ctx.storage.sql.exec("INSERT INTO auth_store_meta VALUES(1,1,'staging',?,?,?,?,?,?,?)",
              env.APP_ORIGIN, Number(env.GENERATION), schemaSha256, inventoryHash, seed.sha256,
              seed.payload.sourceCommit, seed.payload.capturedAt);
          });
        }
        const meta = ctx.storage.sql.exec("SELECT * FROM auth_store_meta WHERE singleton=1").toArray()[0];
        if (!meta || meta.version !== 1 || meta.environment !== "staging" || meta.origin !== env.APP_ORIGIN ||
            meta.generation !== Number(env.GENERATION) || meta.schema_sha256 !== schemaSha256 ||
            meta.inventory_sha256 !== digest(JSON.stringify(ctx.storage.sql.exec(inventorySql).toArray()))) fail();
        if (env.AUTH_STORE_BOOTSTRAP && bootstrap(env, Date.now(), false).sha256 !== meta.bootstrap_sha256) fail();
        this.ready = {ready:true,version:1,schemaSha256,bootstrapSha256:meta.bootstrap_sha256};
      } catch { fail(); }
    });
  }

  reserveAssistant() { return reserve(this.ctx.storage, Date.now()); }

  status() { return this.ready; }

  execute(statements) {
    try {
      validateCall(statements);
      return this.ctx.storage.transactionSync(() => {
        const results = statements.map(s => {
          const cursor = this.ctx.storage.sql.exec(s.sql, ...s.values);
          const rows = cursor.toArray();
          const changes = /^\s*SELECT\b/i.test(s.sql) ? 0 : this.ctx.storage.sql.exec("SELECT changes() AS changes").one().changes;
          return {success:true,results:rows,meta:{changes,rows_read:cursor.rowsRead,rows_written:cursor.rowsWritten}};
        });
        if (bytes(JSON.stringify(results)) > 4 * 1024 * 1024) fail();
        return results;
      });
    } catch { fail(); }
  }
}
