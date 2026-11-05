import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { classifyMigrationState, createMigrationPlan, parseArguments, requireCleanCommit } from '../../scripts/prepare-v3-release.mjs';

const sql = await readFile(new URL('../../database/migrations/0001_prototype.sql', import.meta.url), 'utf8');
const commit = 'a'.repeat(40);
const plan = createMigrationPlan(sql, commit, 1);

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
