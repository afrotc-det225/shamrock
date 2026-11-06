import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ledgerName = 'shamrock_migrations';
const bootstrapGuard = 'shamrock_bootstrap_guard';
const upgradeGuard = 'shamrock_migration_guard';
const initialName = '0001_prototype.sql';
const maxMigrations = 32;
const maxBatchStatements = 64; // Project review bound, not a provider quota claim.
const maxMigrationBytes = 64 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const commitPattern = /^[a-f0-9]{40,64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const inventorySql = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY name";
const isEngineObject = name => name.startsWith('sqlite_') || ['_cf_KV', '_cf_METADATA'].includes(name);
const legacyLedgerSql = `CREATE TABLE ${ledgerName} (
  version INTEGER PRIMARY KEY CHECK (version = 1),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_commit TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  applied_at TEXT NOT NULL
)`;
const ledgerSql = legacyLedgerSql.replace('CHECK (version = 1)', 'CHECK (version > 0)');
const ledgerUpgrade = [
  `ALTER TABLE ${ledgerName} RENAME TO shamrock_migrations_v1`,
  ledgerSql,
  `INSERT INTO ${ledgerName} SELECT * FROM shamrock_migrations_v1`,
  'DROP TABLE shamrock_migrations_v1',
];

/** Split reviewed SQL without splitting literal semicolons or changing literal whitespace. */
export function splitMigrationSql(sql) {
  if (typeof sql !== 'string' || Buffer.byteLength(sql) > maxMigrationBytes || sql.includes('\0')) {
    throw new Error('Migration SQL must be bounded text without NUL bytes.');
  }
  const statements = [];
  let current = '', quote = '', comment = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (comment === 'line') { if (ch === '\n') { comment = ''; current += ' '; } continue; }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; current += ' '; i++; } continue; }
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) { current += next; i++; } else quote = '';
      }
      continue;
    }
    if (ch === '-' && next === '-') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === ']') throw new Error('Bracket-quoted identifiers are outside the reviewed migration syntax.');
    if (ch === ';') { if (current.trim()) statements.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (quote || comment === 'block') throw new Error('Unterminated SQL literal or comment.');
  if (current.trim()) statements.push(current.trim());
  if (!statements.length || statements.length > maxBatchStatements - 12) throw new Error('Migration statement count is outside the bounded staging plan.');
  return statements;
}

function normalizeSql(sql) {
  // The splitter removes comments; collapse whitespace only outside string/identifier literals.
  const statement = splitMigrationSql(sql).join(';');
  let result = '', quote = '';
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (quote) {
      result += ch;
      if (ch === quote) {
        if (statement[i + 1] === quote) result += statement[++i];
        else quote = '';
      }
    } else if (["'", '"', '`'].includes(ch)) { quote = ch; result += ch; }
    else if (/\s/.test(ch)) { if (!result.endsWith(' ')) result += ' '; }
    else result += ch;
  }
  return result.trim();
}

function schemaObjects(inventory) {
  if (!Array.isArray(inventory)) throw new Error('Schema inventory must be an array.');
  return inventory.filter(row => !isEngineObject(String(row.name))).map(row => ({
    type: row.type, name: row.name, sqlSha256: typeof row.sql === 'string' ? sha256(normalizeSql(row.sql)) : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function reviewedStatements(sql, version) {
  const statements = splitMigrationSql(sql);
  const created = new Set();
  for (const statement of statements) {
    if (version === 1 && /^PRAGMA foreign_keys\s*=\s*ON$/i.test(statement)) continue;
    const create = statement.match(/^CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z][a-z0-9_]*)\s*(?=\(|ON\s)/i);
    const alter = statement.match(/^ALTER TABLE ([a-z][a-z0-9_]*) ADD COLUMN [a-z][a-z0-9_]*\s/i);
    const insert = statement.match(/^INSERT INTO ([a-z][a-z0-9_]*)\s*(?:\([^)]*\))?\s+SELECT\s/i);
    const name = (create?.[2] || alter?.[1] || insert?.[1] || '').toLowerCase();
    if (!name || /^(?:shamrock_|sqlite_|_cf_)/.test(name) || (version > 1 && name === 'system_control')
      || (version === 1 && !create) || (insert && !created.has(name))) {
      throw new Error('Only reviewed additive CREATE/ADD COLUMN and backfills into tables created by this migration are supported.');
    }
    if (create?.[1].toUpperCase() === 'TABLE') created.add(name);
  }
  return statements;
}

export async function readMigrationSources(directory) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !/^\d{4}_[a-z][a-z0-9_]*\.sql$/.test(entry.name))) {
    throw new Error('Migration directory must contain only regular, numbered SQL files.');
  }
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => ({
    name: entry.name, sql: await readFile(join(directory, entry.name), 'utf8'),
  })));
}

function ledgerInsert(migration, commit) {
  return {
    sql: `INSERT INTO ${ledgerName}(version,name,sha256,source_commit,environment,applied_at) VALUES(?,?,?,?,'staging',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    params: [migration.version, migration.name, migration.sha256, commit],
  };
}

export function createMigrationPlan(input, commit, generation) {
  if (!commitPattern.test(commit) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('A committed source revision and positive staging generation are required.');
  }
  const sources = typeof input === 'string' ? [{ name: initialName, sql: input }] : input;
  if (!Array.isArray(sources) || !sources.length || sources.length > maxMigrations) throw new Error('Invalid ordered migration source list.');
  const db = new DatabaseSync(':memory:');
  const migrations = [];
  try {
    db.exec(legacyLedgerSql);
    for (const [index, source] of sources.entries()) {
      const version = index + 1;
      if (!new RegExp(`^${String(version).padStart(4, '0')}_[a-z][a-z0-9_]*\\.sql$`).test(source.name)
        || (version === 1 && source.name !== initialName)) throw new Error('Migrations must be ordered, contiguous and start with the established initial migration.');
      const statements = reviewedStatements(source.sql, version);
      if (version === 2) ledgerUpgrade.forEach(statement => db.exec(statement));
      statements.forEach(statement => db.exec(statement));
      migrations.push({ version, name: source.name, sha256: sha256(source.sql), statements,
        expectedObjects: schemaObjects(db.prepare(inventorySql).all()) });
    }
  } finally { db.close(); }
  const latest = migrations.at(-1);
  return {
    formatVersion: 2, environment: 'staging', generation, sourceCommit: commit,
    version: latest.version, name: latest.name, sha256: latest.sha256,
    migrations, expectedObjects: latest.expectedObjects,
    preflight: {
      inventory: { sql: inventorySql },
      ledger: { sql: `SELECT version,name,sha256,source_commit,environment,applied_at FROM ${ledgerName} ORDER BY version` },
      control: { sql: 'SELECT singleton,environment,generation,accepting_commands FROM system_control' },
      instructions: 'Read inventory first, then ledger/control together when present. Require exact ordered history and schema, paused staging and matching generation. Re-read after every version; do not send individual statements.',
    },
    bootstrap: { version: 1, batch: [
      { sql: `CREATE TABLE ${bootstrapGuard} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ok INTEGER NOT NULL CHECK(ok=1))` },
      { sql: `INSERT INTO ${bootstrapGuard} SELECT 1,CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA') AND name <> '${bootstrapGuard}') THEN 1 ELSE 0 END` },
      { sql: legacyLedgerSql },
      ...migrations[0].statements.map(sql => ({ sql })),
      { sql: "INSERT INTO system_control(singleton,environment,generation,accepting_commands) VALUES(1,'staging',?,0)", params: [generation] },
      ledgerInsert(migrations[0], commit),
      { sql: `DROP TABLE ${bootstrapGuard}` },
    ] },
    recovery: {
      automaticRollback: false,
      instructions: 'Before each upgrade, pause Google intake/dispatch/publication and database commands, capture a protected export and recovery point, and verify an isolated restore. Bind the reviewed recovery record to migrationEvidenceHash. The helper checks the attestation, not the backup contents. Prefer a reviewed forward fix; reverting Worker code does not revert data. Restore only while fenced, with no accepted writes after the backup, and revalidate generation, ledger, integrity and compatible code before reopening.',
    },
    verification: { inventory: { sql: inventorySql }, integrity: { sql: 'PRAGMA quick_check' }, foreignKeys: { sql: 'PRAGMA foreign_key_check' },
      instructions: 'Inspect every batch result and reclassify fresh evidence after success or an ambiguous response. Keep both systems paused; this tool never enables commands or restores a database.' },
  };
}

function assertPlan(plan) {
  if (plan?.formatVersion !== 2 || plan.environment !== 'staging' || !Number.isSafeInteger(plan.generation)
    || plan.generation < 1 || !commitPattern.test(plan.sourceCommit) || !Array.isArray(plan.migrations)
    || !plan.migrations.length || plan.migrations.length > maxMigrations) throw new Error('Only a reviewed staging migration plan is supported.');
}

/** Exact schema and ordered-prefix history are required; never repair unknown state. */
export function classifyMigrationState(plan, inventory, ledger = [], controls = []) {
  assertPlan(plan);
  const objects = schemaObjects(inventory);
  if (!objects.length) {
    if (ledger.length || controls.length) throw new Error('Inconsistent empty-schema evidence.');
    return { action: 'apply' };
  }
  if (!ledger.length || ledger.length > plan.migrations.length) throw new Error('Unknown, partial or newer migration ledger.');
  for (const [index, row] of ledger.entries()) {
    const expected = plan.migrations[index];
    if (Number(row.version) !== index + 1 || row.name !== expected.name || row.sha256 !== expected.sha256
      || row.environment !== 'staging' || !commitPattern.test(row.source_commit) || typeof row.applied_at !== 'string'
      || !Number.isFinite(Date.parse(row.applied_at))) throw new Error('Migration ledger does not match ordered reviewed hashes and history.');
  }
  if (JSON.stringify(objects) !== JSON.stringify(plan.migrations[ledger.length - 1].expectedObjects)) {
    throw new Error('Unknown, partial or modified schema. Stop; do not apply or repair automatically.');
  }
  if (controls.length !== 1 || Number(controls[0].singleton) !== 1 || controls[0].environment !== 'staging'
    || Number(controls[0].generation) !== plan.generation || Number(controls[0].accepting_commands) !== 0) {
    throw new Error('Database must be paused in the intended isolated staging generation.');
  }
  return ledger.length === plan.migrations.length ? { action: 'noop' }
    : { action: 'upgrade', fromVersion: ledger.length, toVersion: ledger.length + 1 };
}

export function migrationEvidenceHash(inventory, ledger, controls) {
  const objects = inventory.filter(row => !isEngineObject(String(row.name)))
    .map(({ type, name, sql }) => ({ type, name, sql })).sort((a, b) => a.name.localeCompare(b.name));
  const history = ledger.map(({ version, name, sha256, source_commit, environment, applied_at }) =>
    ({ version, name, sha256, source_commit, environment, applied_at }));
  return sha256(JSON.stringify({ objects, history, controls: controls.map(({ singleton, environment, generation, accepting_commands }) =>
    ({ singleton, environment, generation, accepting_commands })) }));
}

function assertion(id, condition, params = []) {
  return { sql: `INSERT INTO ${upgradeGuard} SELECT ${id},CASE WHEN (${condition}) THEN 1 ELSE 0 END`, params };
}

/** Construct one atomic, reviewable upgrade; this function performs no IO or deployment. */
export function createUpgradeBatch(plan, inventory, ledger, controls, recovery) {
  const state = classifyMigrationState(plan, inventory, ledger, controls);
  if (state.action !== 'upgrade') throw new Error('A known previous schema version is required for an upgrade batch.');
  if (recovery?.environment !== 'staging' || recovery.generation !== plan.generation || recovery.fromVersion !== state.fromVersion
    || recovery.evidenceSha256 !== migrationEvidenceHash(inventory, ledger, controls) || !hashPattern.test(recovery.backupSha256)
    || !commitPattern.test(recovery.rollbackSourceCommit) || recovery.reviewed !== true || recovery.restoreVerified !== true
    || recovery.adaptersPaused !== true) throw new Error('A matching reviewed backup, isolated restore and paused-adapter attestation are required.');
  const objects = inventory.filter(row => !isEngineObject(String(row.name))).map(({ type, name, sql }) => ({ type, name, sql }));
  const batch = [
    { sql: `CREATE TABLE ${upgradeGuard} (check_id INTEGER PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1))` },
    assertion(1, "(SELECT COUNT(*) FROM system_control)=1 AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=0)", [plan.generation]),
    assertion(2, `(SELECT COUNT(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA','${upgradeGuard}'))=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema actual WHERE actual.name=json_extract(expected.value,'$.name') AND actual.type=json_extract(expected.value,'$.type') AND actual.sql=json_extract(expected.value,'$.sql')))`, [JSON.stringify(objects), JSON.stringify(objects)]),
    assertion(3, `(SELECT COUNT(*) FROM ${ledgerName})=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ${ledgerName} actual WHERE actual.version=json_extract(expected.value,'$.version') AND actual.name=json_extract(expected.value,'$.name') AND actual.sha256=json_extract(expected.value,'$.sha256') AND actual.source_commit=json_extract(expected.value,'$.source_commit') AND actual.environment=json_extract(expected.value,'$.environment') AND actual.applied_at=json_extract(expected.value,'$.applied_at')))`, [JSON.stringify(ledger), JSON.stringify(ledger)]),
    ...(state.fromVersion === 1 ? ledgerUpgrade.map(sql => ({ sql })) : []),
    ...plan.migrations[state.toVersion - 1].statements.map(sql => ({ sql })),
    ledgerInsert(plan.migrations[state.toVersion - 1], plan.sourceCommit),
    { sql: `DROP TABLE ${upgradeGuard}` },
  ];
  if (batch.length > maxBatchStatements) throw new Error('Upgrade exceeds the bounded atomic statement count.');
  return { ...state, recoveryEvidenceSha256: recovery.evidenceSha256, batch };
}
