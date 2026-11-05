import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationName = '0001_prototype.sql';
const compatibilityDate = '2026-11-05'; // Staging target; local workerd is older, so remote smoke verification is required.
const ledgerName = 'shamrock_migrations';
const guardName = 'shamrock_bootstrap_guard';
const releaseFiles = ['worker.mjs', 'GoogleAdapter.js', 'migration.sql', 'migration-plan.json', 'upload-metadata.template.json'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizeSql = value => value.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');
const isEngineObject = name => name.startsWith('sqlite_') || ['_cf_KV', '_cf_METADATA'].includes(name);

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function requireCleanCommit(cwd = root) {
  if (git(['status', '--porcelain', '--untracked-files=all'], cwd)) {
    throw new Error('Release preparation requires a clean committed source tree. Commit reviewed source changes first.');
  }
  const commit = git(['rev-parse', '--verify', 'HEAD'], cwd);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Cannot identify the committed source revision.');
  return commit;
}

const ledgerSql = `CREATE TABLE ${ledgerName} (
  version INTEGER PRIMARY KEY CHECK (version = 1),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_commit TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  applied_at TEXT NOT NULL
)`;

/** Narrow parser intentionally rejects future migration syntax it cannot handle safely. */
function initialStatements(sql) {
  const withoutComments = sql.replace(/^\s*--.*$/gm, '');
  const statements = withoutComments.split(';').map(value => value.trim()).filter(Boolean);
  if (statements.length === 0 || statements.some(value =>
    !/^PRAGMA foreign_keys = ON$/i.test(value) && !/^CREATE (TABLE|INDEX) [a-z_]+\s/i.test(value))) {
    throw new Error('This helper only handles the reviewed initial CREATE TABLE/INDEX migration.');
  }
  return statements;
}

export function createMigrationPlan(sql, commit, generation) {
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('A committed source revision and positive staging generation are required.');
  }
  const checksum = sha256(sql);
  const statements = initialStatements(sql);
  const expectedObjects = [ledgerSql, ...statements].flatMap(statement => {
    const match = statement.match(/^CREATE (TABLE|INDEX) ([a-z_]+)/i);
    return match ? [{ type: match[1].toLowerCase(), name: match[2], sqlSha256: sha256(normalizeSql(statement)) }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
  const inventorySql = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY name";
  return {
    formatVersion: 1,
    environment: 'staging',
    generation,
    version: 1,
    name: migrationName,
    sha256: checksum,
    expectedObjects,
    preflight: {
      inventory: { sql: inventorySql },
      ledger: { sql: `SELECT version,name,sha256,source_commit,environment,applied_at FROM ${ledgerName} ORDER BY version` },
      control: { sql: 'SELECT singleton,environment,generation,accepting_commands FROM system_control' },
      instructions: 'Read inventory first. Query ledger/control only when present. Empty user schema may apply bootstrap. Complete matching schema/hash/control is a no-op. Any other state stops for review.',
    },
    bootstrap: {
      batch: [
        { sql: `CREATE TABLE ${guardName} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ok INTEGER NOT NULL CHECK(ok=1))` },
        { sql: `INSERT INTO ${guardName} SELECT 1,CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA') AND name <> '${guardName}') THEN 1 ELSE 0 END` },
        { sql: ledgerSql },
        ...statements.map(sql => ({ sql })),
        { sql: "INSERT INTO system_control(singleton,environment,generation,accepting_commands) VALUES(1,'staging',?,0)", params: [String(generation)] },
        { sql: `INSERT INTO ${ledgerName}(version,name,sha256,source_commit,environment,applied_at) VALUES(1,?,?,?,'staging',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, params: [migrationName, checksum, commit] },
        { sql: `DROP TABLE ${guardName}` },
      ],
    },
    verification: {
      inventory: { sql: inventorySql },
      integrity: { sql: 'PRAGMA quick_check' },
      foreignKeys: { sql: 'PRAGMA foreign_key_check' },
      instructions: 'Inspect every API batch result. Re-read and classify schema, ledger and control. Initial control remains fenced; enable only after the isolated staging setup is verified.',
    },
  };
}

/** Fail closed before mutating an existing staging database; no partial-schema repair. */
export function classifyMigrationState(plan, inventory, ledger = [], controls = []) {
  if (plan.environment !== 'staging') throw new Error('This release helper only supports staging.');
  const objects = inventory.filter(row => !isEngineObject(row.name)).map(row => ({
    name: row.name, type: row.type, sqlSha256: typeof row.sql === 'string' ? sha256(normalizeSql(row.sql)) : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  if (objects.length === 0) {
    if (ledger.length || controls.length) throw new Error('Inconsistent empty-schema evidence.');
    return { action: 'apply' };
  }
  if (JSON.stringify(objects) !== JSON.stringify(plan.expectedObjects.map(row => ({ name: row.name, type: row.type, sqlSha256: row.sqlSha256 })))) {
    throw new Error('Unknown, partial or modified schema. Stop; do not apply or repair automatically.');
  }
  if (ledger.length !== 1 || Number(ledger[0].version) !== plan.version || ledger[0].name !== plan.name
    || ledger[0].sha256 !== plan.sha256 || ledger[0].environment !== 'staging'
    || !/^[a-f0-9]{40,64}$/.test(ledger[0].source_commit)) {
    throw new Error('Migration ledger does not match the reviewed schema version and checksum.');
  }
  if (controls.length !== 1 || Number(controls[0].singleton) !== 1 || controls[0].environment !== 'staging'
    || Number(controls[0].generation) !== plan.generation || ![0, 1].includes(Number(controls[0].accepting_commands))) {
    throw new Error('Database is not the intended isolated staging generation.');
  }
  return { action: 'noop' };
}

export function parseArguments(args) {
  const options = { environment: 'staging', generation: undefined, out: '.build/v3-release', verify: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verify') { options.verify = true; continue; }
    if (!['--environment', '--generation', '--out'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/prepare-v3-release.mjs --environment staging --generation NUMBER [--out .build/PATH] [--verify]');
    }
    options[arg.slice(2)] = args[++i];
  }
  if (options.environment !== 'staging' || !/^[1-9]\d*$/.test(String(options.generation))
    || !Number.isSafeInteger(Number(options.generation))) {
    throw new Error('Only staging and a positive safe generation are supported.');
  }
  options.generation = Number(options.generation);
  return options;
}

async function releaseDirectory(value) {
  const output = resolve(root, value);
  const buildRoot = resolve(root, '.build');
  const child = relative(buildRoot, output);
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    throw new Error('Release artifacts must be in a dedicated directory under ignored .build/.');
  }
  // Resolve existing ancestors to reject output redirected outside this repo by symlinks.
  let ancestor = output;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      if (canonical !== ancestor) throw new Error('Release output must not traverse a symbolic link.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  return output;
}

export async function verifyRelease(directory, commit, generation) {
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.formatVersion !== 1 || manifest.environment !== 'staging' || manifest.productionReady !== false
    || manifest.sourceCommit !== commit || manifest.generation !== generation || manifest.compatibilityDate !== compatibilityDate
    || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...releaseFiles].sort())) {
    throw new Error('Release manifest does not match committed source, target or supported artifact format.');
  }
  for (const name of releaseFiles) {
    const bytes = await readFile(resolve(directory, name));
    const expected = manifest.files[name];
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Artifact hash mismatch: ${name}`);
  }
  // Compare migration to committed source as well as the manifest, without rebuilding.
  const currentMigration = await readFile(resolve(root, 'database/migrations', migrationName));
  if (manifest.migration.sha256 !== sha256(currentMigration)) throw new Error('Migration source hash changed.');
  return { sourceCommit: commit, environment: 'staging', generation, manifestSha256: sha256(manifestBytes), verified: true };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const commit = requireCleanCommit();
  const output = await releaseDirectory(options.out);
  if (options.verify) {
    console.log(JSON.stringify(await verifyRelease(output, commit, options.generation), null, 2));
    return;
  }
  const build = spawnSync(process.execPath, ['scripts/build-v3.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Build failed; no release prepared.');
  if (requireCleanCommit() !== commit) throw new Error('Source changed during build.');
  const sql = await readFile(resolve(root, 'database/migrations', migrationName), 'utf8');
  const plan = createMigrationPlan(sql, commit, options.generation);
  const builtManifest = JSON.parse(await readFile(resolve(root, '.build/v3-artifacts/manifest.json'), 'utf8'));
  const files = {};
  await mkdir(output, { recursive: true });
  for (const name of ['worker.mjs', 'GoogleAdapter.js']) {
    const bytes = await readFile(resolve(root, '.build/v3-artifacts', name));
    if (sha256(bytes) !== builtManifest.files[name]?.sha256 || bytes.length !== builtManifest.files[name]?.bytes) {
      throw new Error('Build artifact and build manifest disagree.');
    }
    await writeFile(resolve(output, name), bytes);
  }
  await writeFile(resolve(output, 'migration.sql'), sql);
  await writeFile(resolve(output, 'migration-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await writeFile(resolve(output, 'upload-metadata.template.json'), JSON.stringify({
    main_module: 'worker.mjs', compatibility_date: compatibilityDate,
    bindings: [
      { type: 'd1', name: 'DB', database_id: '<STAGING_D1_DATABASE_ID>' },
      { type: 'plain_text', name: 'ENVIRONMENT', text: 'staging' },
      { type: 'plain_text', name: 'GENERATION', text: String(options.generation) },
      { type: 'plain_text', name: 'BRIDGE_KEY_ID', text: '<STAGING_BRIDGE_KEY_ID>' },
    ],
    keep_bindings: ['secret_text'],
  }, null, 2) + '\n');
  for (const name of releaseFiles) {
    const bytes = await readFile(resolve(output, name));
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const manifest = {
    formatVersion: 1, stage: 'isolated-prototype', productionReady: false,
    environment: 'staging', generation: options.generation, sourceCommit: commit, compatibilityDate,
    requiredSecrets: ['BRIDGE_SECRET'],
    migration: { version: 1, name: migrationName, sha256: plan.sha256 },
    files,
  };
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ...await verifyRelease(output, commit, options.generation), artifactDirectory: relative(root, output), deployed: false }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
