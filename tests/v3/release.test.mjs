import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { classifyMigrationState, createMigrationPlan, createUpgradeBatch, migrationEvidenceHash,
  parseArguments, readMigrationSources, requireCleanCommit, resolveBuildPath, verifyRelease } from '../../scripts/prepare-v3-release.mjs';
import { splitMigrationSql } from '../../scripts/lib/v3-migrations.mjs';
import { parseMigrationArguments, prepareMigrationOperation } from '../../scripts/prepare-v3-migration.mjs';

const sql = await readFile(new URL('../../database/migrations/0001_prototype.sql', import.meta.url), 'utf8');
const commit = 'a'.repeat(40);
const plan = createMigrationPlan(sql, commit, 1);
const sources = await readMigrationSources(new URL('../../database/migrations', import.meta.url));
const upgradeCommit = 'b'.repeat(40);
const upgradePlan = createMigrationPlan(sources.slice(0, 2), upgradeCommit, 1);
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function database(t) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'migration-fixture' }, log: new Log(LogLevel.NONE) });
  t.after(() => mf.dispose());
  return mf.getD1Database('DB');
}
function apply(db, batch = plan.bootstrap.batch) {
  return db.batch(batch.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)));
}
async function evidence(db) {
  const [inventory, ledger, controls] = await db.batch([
    db.prepare(plan.preflight.inventory.sql), db.prepare(plan.preflight.ledger.sql), db.prepare(plan.preflight.control.sql),
  ]);
  return [inventory.results, ledger.results, controls.results];
}

test('release arguments reject production and unsafe generation values', () => {
  assert.deepEqual(parseArguments(['--generation', '1', '--verify']), { environment: 'staging', generation: 1, out: '.build/v3-release', verify: true });
  for (const args of [['--environment', 'production', '--generation', '1'], ['--generation', '0'], ['--generation', '1;DROP'], ['--unknown']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.throws(() => createMigrationPlan(sql, 'uncommitted', 1));
  assert.throws(() => createMigrationPlan(sql + '\nDROP TABLE people;', commit, 1));
});

test('source must be clean and committed, including untracked files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shamrock-release-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git(['init', '--quiet']);
  await writeFile(join(directory, 'source.txt'), 'fictional fixture\n');
  git(['add', 'source.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'test fixture']);
  assert.match(requireCleanCommit(directory), /^[a-f0-9]{40,64}$/);
  await writeFile(join(directory, 'untracked.txt'), 'pending\n');
  assert.throws(() => requireCleanCommit(directory), /clean committed/);
  await rm(join(directory, 'untracked.txt'));
  await writeFile(join(directory, 'source.txt'), 'changed\n');
  assert.throws(() => requireCleanCommit(directory), /clean committed/);
});

test('initial staging migration is atomic, fenced and repeatably classifies as a no-op', async t => {
  const db = await database(t);
  assert.deepEqual(classifyMigrationState(plan, []), { action: 'apply' });
  await apply(db);
  const rows = await evidence(db);
  assert.deepEqual(classifyMigrationState(plan, ...rows), { action: 'noop' });
  assert.equal(rows[2][0].accepting_commands, 0);
  assert.equal(rows[2][0].environment, 'staging');
  assert.equal(rows[1][0].sha256, plan.sha256);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check, 'ok');
  assert.ok(!rows[0].some(row => row.name === 'shamrock_bootstrap_guard'));
});

test('unknown/partial schema is rejected before apply and protected by the atomic bootstrap guard', async t => {
  const db = await database(t);
  await db.prepare('CREATE TABLE unrelated_data (value TEXT)').run();
  const before = (await db.prepare(plan.preflight.inventory.sql).all()).results;
  assert.throws(() => classifyMigrationState(plan, before), /Unknown, partial/);
  await assert.rejects(apply(db));
  assert.deepEqual((await db.prepare(plan.preflight.inventory.sql).all()).results, before);
});

test('failure late in initial migration leaves no partial schema or success ledger', async t => {
  const db = await database(t);
  const failing = structuredClone(plan.bootstrap.batch);
  failing.splice(-1, 0, { sql: 'INSERT INTO shamrock_bootstrap_guard VALUES(2,0)' });
  await assert.rejects(apply(db, failing));
  assert.deepEqual((await db.prepare(plan.preflight.inventory.sql).all()).results, []);
});

test('ledger mismatch, schema drift and different environment/generation stop repeat deployment', async t => {
  const db = await database(t);
  await apply(db);
  const rows = await evidence(db);
  assert.throws(() => classifyMigrationState(plan, rows[0], [{ ...rows[1][0], sha256: 'b'.repeat(64) }], rows[2]), /ledger/);
  assert.throws(() => classifyMigrationState(plan, rows[0], rows[1], [{ ...rows[2][0], environment: 'production' }]), /staging generation/);
  assert.throws(() => classifyMigrationState(plan, rows[0], rows[1], [{ ...rows[2][0], generation: 2 }]), /staging generation/);
  await db.prepare('CREATE INDEX unexpected_index ON people(display_name)').run();
  const drifted = (await db.prepare(plan.preflight.inventory.sql).all()).results;
  assert.throws(() => classifyMigrationState(plan, drifted, rows[1], rows[2]), /Unknown, partial/);
});

function recovery(rows) {
  return { environment: 'staging', generation: 1, fromVersion: rows[1].length,
    evidenceSha256: migrationEvidenceHash(...rows), backupSha256: 'c'.repeat(64),
    rollbackSourceCommit: commit, reviewed: true, restoreVerified: true, adaptersPaused: true };
}

async function seedCommand(db, id = 'fixture-command', revision = 1) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO people VALUES('fixture-person','Fictional Person')"),
    db.prepare("INSERT OR IGNORE INTO principals VALUES('fixture-principal','fixture-person',1)"),
    db.prepare("INSERT OR IGNORE INTO organizational_units VALUES('fixture-unit','Fictional Unit',1)"),
    db.prepare("INSERT OR IGNORE INTO events VALUES('fixture-event','Fictional Event',1)"),
    db.prepare(`INSERT INTO operation_commands(command_id,payload_hash,actor_id,operation,unit_id,event_id,target_person_id,
      source_kind,source_resource,source_submission,source_revision,accepted_at,receipt_json)
      VALUES(?,?,'fixture-principal','excusal.submit','fixture-unit','fixture-event','fixture-person',
      'form','fixture-form','fixture-response',?,'2026-01-01T00:00:00Z','{}')`).bind(id, 'd'.repeat(64), revision),
  ]);
}

test('actual second migration preserves history and accepted commands while backfilling every scope', async t => {
  const db = await database(t);
  await apply(db);
  await seedCommand(db);
  const before = await evidence(db);
  const originalCommands = (await db.prepare('SELECT * FROM operation_commands').all()).results;
  assert.deepEqual(classifyMigrationState(upgradePlan, ...before), { action: 'upgrade', fromVersion: 1, toVersion: 2 });
  const operation = createUpgradeBatch(upgradePlan, ...before, recovery(before));
  await apply(db, operation.batch);
  const after = await evidence(db);
  assert.deepEqual(classifyMigrationState(upgradePlan, ...after), { action: 'noop' });
  assert.deepEqual(after[1][0], before[1][0]);
  assert.equal(after[1][1].source_commit, upgradeCommit);
  assert.equal(after[1][1].sha256, upgradePlan.migrations[1].sha256);
  assert.deepEqual((await db.prepare('SELECT * FROM operation_commands').all()).results, originalCommands);
  assert.deepEqual((await db.prepare('SELECT * FROM command_event_scopes').all()).results,
    [{ command_id: 'fixture-command', event_id: 'fixture-event', unit_id: 'fixture-unit' }]);
  assert.equal((await db.prepare('PRAGMA quick_check').first()).quick_check, 'ok');
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  assert.equal(after[2][0].accepting_commands, 0);
  // A lost successful response must be reconciled as a no-op, never blindly replayed.
  const noOp = prepareMigrationOperation(upgradePlan, { inventory: after[0], ledger: after[1], controls: after[2] });
  assert.equal(noOp.action, 'noop');
  assert.deepEqual(noOp.batch, []);
  await assert.rejects(apply(db, operation.batch));
  assert.deepEqual(await evidence(db), after);
});

test('uniqueness conflict in an existing record rolls back DDL, backfill and ledger conversion', async t => {
  const db = await database(t);
  await apply(db);
  await seedCommand(db);
  await seedCommand(db, 'fixture-conflicting-command', 2);
  const before = await evidence(db);
  const operation = createUpgradeBatch(upgradePlan, ...before, recovery(before));
  await assert.rejects(apply(db, operation.batch), /UNIQUE/);
  assert.deepEqual(await evidence(db), before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_commands').first()).n, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='command_event_scopes'").first()).n, 0);
});

test('late upgrade failure restores the exact previous schema and ledger without touching records', async t => {
  const db = await database(t);
  await apply(db);
  await seedCommand(db);
  const before = await evidence(db);
  const operation = createUpgradeBatch(upgradePlan, ...before, recovery(before));
  operation.batch.splice(-1, 0, { sql: 'INSERT INTO shamrock_migration_guard VALUES(99,0)' });
  await assert.rejects(apply(db, operation.batch));
  assert.deepEqual(await evidence(db), before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_commands').first()).n, 1);
});

test('upgrade requires bound recovery evidence and paused staging even for repeat state', async t => {
  const db = await database(t);
  await apply(db);
  const rows = await evidence(db);
  for (const changed of [{}, { reviewed: false }, { restoreVerified: false }, { adaptersPaused: false },
    { backupSha256: '' }, { rollbackSourceCommit: 'unreviewed' }, { generation: 2 }, { fromVersion: 2 },
    { environment: 'production' }, { evidenceSha256: 'e'.repeat(64) }]) {
    const candidate = Object.keys(changed).length ? { ...recovery(rows), ...changed } : undefined;
    assert.throws(() => createUpgradeBatch(upgradePlan, ...rows, candidate), /attestation/);
  }
  assert.throws(() => classifyMigrationState({ ...upgradePlan, environment: 'production' }, ...rows), /staging/);
  await db.prepare('UPDATE system_control SET accepting_commands=1').run();
  const active = await evidence(db);
  assert.throws(() => classifyMigrationState(upgradePlan, ...active), /paused/);
  assert.throws(() => classifyMigrationState(plan, ...active), /paused/);
});

test('atomic upgrade assertions reject control, generation, schema and ledger races', async t => {
  for (const mutation of [
    'UPDATE system_control SET accepting_commands=1',
    'UPDATE system_control SET generation=2',
    "UPDATE system_control SET environment='local'",
    'CREATE TABLE unexpected_after_review(value TEXT)',
    "UPDATE shamrock_migrations SET source_commit='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'",
  ]) await t.test(mutation.split(' ').slice(0, 3).join(' '), async child => {
    const db = await database(child);
    await apply(db);
    const rows = await evidence(db);
    const operation = createUpgradeBatch(upgradePlan, ...rows, recovery(rows));
    await db.prepare(mutation).run();
    const drifted = await evidence(db);
    await assert.rejects(apply(db, operation.batch));
    assert.deepEqual(await evidence(db), drifted);
  });
});

test('ordered migration history rejects gaps, future versions and modified earlier hashes', async t => {
  const db = await database(t);
  await apply(db);
  const rows = await evidence(db);
  const changed = sources.map((source, index) => index ? source : { ...source, sql: source.sql + '\n-- changed historical bytes\n' });
  assert.throws(() => classifyMigrationState(createMigrationPlan(changed, commit, 1), ...rows), /ledger/);
  assert.throws(() => createMigrationPlan([sources[1], sources[0]], commit, 1), /ordered/);
  assert.throws(() => createMigrationPlan([sources[0], { name: '0003_gap.sql', sql: 'CREATE TABLE gap (value TEXT);' }], commit, 1), /ordered/);
  await apply(db, createUpgradeBatch(upgradePlan, ...rows, recovery(rows)).batch);
  const upgraded = await evidence(db);
  assert.throws(() => classifyMigrationState(plan, ...upgraded), /newer/);
  assert.throws(() => classifyMigrationState(upgradePlan, upgraded[0], [...upgraded[1]].reverse(), upgraded[2]), /ordered/);
  assert.throws(() => classifyMigrationState(upgradePlan, upgraded[0], [upgraded[1][1]], upgraded[2]), /ordered/);
});

test('third version upgrades append history without repeating the legacy-ledger conversion', async t => {
  const future = createMigrationPlan([...sources.slice(0, 2), { name: '0003_fixture.sql', sql:
    "ALTER TABLE people ADD COLUMN fixture_tag TEXT NOT NULL DEFAULT 'fixture';\nCREATE TABLE fixture_upgrade (key TEXT PRIMARY KEY, note TEXT DEFAULT 'two  spaces; it''s safe');\nINSERT INTO fixture_upgrade(key) SELECT person_id FROM people;" }], 'f'.repeat(40), 1);
  const db = await database(t);
  await apply(db);
  await seedCommand(db);
  let rows = await evidence(db);
  await apply(db, createUpgradeBatch(future, ...rows, recovery(rows)).batch);
  rows = await evidence(db);
  const operation = createUpgradeBatch(future, ...rows, recovery(rows));
  assert.equal(operation.toVersion, 3);
  assert.equal(operation.batch.some(({ sql }) => /RENAME TO shamrock_migrations_v1/.test(sql)), false);
  await apply(db, operation.batch);
  const after = await evidence(db);
  assert.deepEqual(classifyMigrationState(future, ...after), { action: 'noop' });
  assert.deepEqual(after[1].slice(0, 2), rows[1]);
  assert.equal((await db.prepare('SELECT fixture_tag FROM people').first()).fixture_tag, 'fixture');
  assert.equal((await db.prepare('SELECT note FROM fixture_upgrade').first()).note, "two  spaces; it's safe");
  const drifted = after[0].map(row => row.name === 'fixture_upgrade' ? { ...row, sql: row.sql.replace('two  spaces', 'two spaces') } : row);
  assert.throws(() => classifyMigrationState(future, drifted, after[1], after[2]), /modified schema/);
});

test('migration SQL parser handles quoted separators but refuses destructive or unbounded migrations', () => {
  assert.deepEqual(splitMigrationSql("-- start\nCREATE TABLE x(note TEXT DEFAULT 'x; -- y'); /* split */ CREATE INDEX i ON x(note);"),
    ["CREATE TABLE x(note TEXT DEFAULT 'x; -- y')", 'CREATE INDEX i ON x(note)']);
  for (const invalid of ['DROP TABLE people;', 'UPDATE people SET display_name=display_name;', 'DELETE FROM people;',
    'BEGIN;', 'PRAGMA foreign_keys=OFF;', 'CREATE TABLE IF NOT EXISTS hidden(value TEXT);',
    'INSERT INTO people SELECT person_id,display_name FROM people;',
    'ALTER TABLE system_control ADD COLUMN override INTEGER;', 'CREATE TABLE shamrock_repair(value TEXT);',
    "CREATE TABLE x(note TEXT DEFAULT 'unterminated);", '/* unterminated', 'x'.repeat(65537)]) {
    assert.throws(() => createMigrationPlan([...sources, { name: '0003_invalid.sql', sql: invalid }], commit, 1));
  }
});

test('offline migration operation and arguments remain staging-only and reject extra evidence', () => {
  const options = parseMigrationArguments(['--generation', '1', '--evidence', '.build/evidence.json', '--out', '.build/batch.json']);
  assert.equal(options.environment, 'staging');
  for (const args of [['--environment', 'production', '--generation', '1'], ['--generation', '0'],
    ['--generation', '1', '--generation', '2'], ['--apply'], ['--out']]) assert.throws(() => parseMigrationArguments(args));
  const bootstrap = prepareMigrationOperation(upgradePlan, { inventory: [], ledger: [], controls: [] });
  assert.equal(bootstrap.action, 'bootstrap');
  assert.equal(bootstrap.toVersion, 1);
  assert.equal(bootstrap.applied, false);
  assert.throws(() => prepareMigrationOperation(upgradePlan, { inventory: [], ledger: [], controls: [], records: [] }));
});

test('release artifacts bind the entire ordered migration source and regenerated plan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shamrock-release-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'migrations'));
  const artifacts = { 'worker.mjs': '// fictional build\n', 'GoogleAdapter.js': '// fictional build\n', 'appsscript.json': '{}\n',
    'upload-metadata.template.json': '{}\n', 'migration-plan.json': JSON.stringify(createMigrationPlan(sources, upgradeCommit, 1), null, 2) + '\n' };
  for (const source of sources) artifacts[`migrations/${source.name}`] = source.sql;
  const files = {};
  for (const [name, content] of Object.entries(artifacts)) {
    await writeFile(join(directory, name), content);
    files[name] = { bytes: Buffer.byteLength(content), sha256: sha256(content) };
  }
  const migrations = sources.map((source, index) => ({ version: index + 1, name: source.name, sha256: sha256(source.sql) }));
  const manifest = { formatVersion: 2, environment: 'staging', productionReady: false, sourceCommit: upgradeCommit,
    generation: 1, compatibilityDate: '2026-11-05', files, migrations, migration: migrations.at(-1) };
  const saveManifest = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest();
  assert.equal((await verifyRelease(directory, upgradeCommit, 1)).verified, true);
  const tampered = JSON.stringify({ ...createMigrationPlan(sources, upgradeCommit, 1), generation: 2 });
  await writeFile(join(directory, 'migration-plan.json'), tampered);
  files['migration-plan.json'] = { bytes: Buffer.byteLength(tampered), sha256: sha256(tampered) };
  await saveManifest();
  await assert.rejects(verifyRelease(directory, upgradeCommit, 1), /reviewed source/);
  await writeFile(join(directory, 'migration-plan.json'), artifacts['migration-plan.json']);
  files['migration-plan.json'] = { bytes: Buffer.byteLength(artifacts['migration-plan.json']), sha256: sha256(artifacts['migration-plan.json']) };
  const name = `migrations/${sources[0].name}`;
  const edited = sources[0].sql + '\n-- edited artifact\n';
  await writeFile(join(directory, name), edited);
  files[name] = { bytes: Buffer.byteLength(edited), sha256: sha256(edited) };
  await saveManifest();
  await assert.rejects(verifyRelease(directory, upgradeCommit, 1), /source hash/);
});

test('artifact paths and migration sources reject symlink escapes', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'shamrock-release-outside-'));
  const inside = await mkdtemp(new URL('../../.build/migration-path-', import.meta.url));
  t.after(() => Promise.all([rm(outside, { recursive: true, force: true }), rm(inside, { recursive: true, force: true })]));
  await symlink(outside, join(inside, 'escape'));
  await assert.rejects(resolveBuildPath(join(inside, 'escape', 'batch.json')), /symbolic link/);
  await assert.rejects(resolveBuildPath(outside), /ignored/);
  await symlink(new URL('../../database/migrations/0001_prototype.sql', import.meta.url), join(outside, '0001_prototype.sql'));
  await assert.rejects(readMigrationSources(outside), /regular/);
});


test('all checked-in additive upgrades preserve existing receipts and leave staging fenced', async t => {
  const all = createMigrationPlan(sources, upgradeCommit, 1);
  const db = await database(t);
  await apply(db);
  await seedCommand(db);
  const accepted = (await db.prepare('SELECT * FROM operation_commands').all()).results;
  for (let version = 2; version <= sources.length; version++) {
    const before = await evidence(db);
    const operation = createUpgradeBatch(all, ...before, recovery(before));
    assert.equal(operation.toVersion, version);
    if (version > 2) assert.equal(operation.batch.some(({ sql }) => /RENAME TO shamrock_migrations_v1/.test(sql)), false);
    await apply(db, operation.batch);
    const after = await evidence(db);
    assert.deepEqual(after[1].slice(0, version - 1), before[1]);
    assert.deepEqual((await db.prepare('SELECT * FROM operation_commands').all()).results, accepted);
    assert.equal(after[2][0].accepting_commands, 0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  }
  assert.deepEqual(classifyMigrationState(all, ...await evidence(db)), { action: 'noop' });
});
