import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCleanCommit, resolveBuildPath, verifyRelease } from './prepare-v3-release.mjs';
import { classifyMigrationState, createUpgradeBatch, migrationEvidenceHash } from './lib/v3-migrations.mjs';

export function parseMigrationArguments(args) {
  const options = { environment: 'staging', release: '.build/v3-release' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !['environment', 'generation', 'release', 'evidence', 'recovery', 'out'].includes(key)
      || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or duplicate migration option.');
    seen.add(key);
    options[key] = args[++i];
  }
  if (options.environment !== 'staging' || !/^[1-9]\d*$/.test(options.generation)
    || !Number.isSafeInteger(Number(options.generation)) || !options.evidence || !options.out) {
    throw new Error('Required: --environment staging --generation NUMBER --evidence .build/FILE --out .build/FILE [--recovery .build/FILE] [--release .build/DIRECTORY].');
  }
  options.generation = Number(options.generation);
  return options;
}

export function prepareMigrationOperation(plan, evidence, recovery) {
  if (!evidence || Object.keys(evidence).sort().join(',') !== 'controls,inventory,ledger'
    || !['inventory', 'ledger', 'controls'].every(key => Array.isArray(evidence[key]))) throw new Error('Expected inventory, ledger and controls evidence arrays only.');
  const { inventory, ledger, controls } = evidence;
  const state = classifyMigrationState(plan, inventory, ledger, controls);
  const evidenceSha256 = migrationEvidenceHash(inventory, ledger, controls);
  const operation = state.action === 'upgrade' ? createUpgradeBatch(plan, inventory, ledger, controls, recovery)
    : state.action === 'apply' ? { action: 'bootstrap', fromVersion: 0, toVersion: 1, batch: plan.bootstrap.batch }
      : { action: 'noop', fromVersion: ledger.length, toVersion: ledger.length, batch: [] };
  return {
    formatVersion: 1, environment: 'staging', generation: plan.generation, sourceCommit: plan.sourceCommit,
    ...operation, evidenceSha256, applied: false,
    ...(state.action === 'upgrade' ? { recovery: {
      backupSha256: recovery.backupSha256, rollbackSourceCommit: recovery.rollbackSourceCommit,
      restoreVerified: true, reviewed: true, adaptersPaused: true,
    } } : {}),
    instructions: 'Review the entire batch and target database identity. Submit once as one transactional D1 batch; never split statements. Inspect every result and re-read schema, ledger, paused control, quick_check and foreign_key_check. After timeout, classify fresh evidence before any retry. This file neither applies a migration nor proves the supplied backup was restored.',
  };
}

async function readEvidence(path) {
  const file = await resolveBuildPath(path);
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Evidence must be a regular JSON file smaller than 1 MiB under .build/.');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const options = parseMigrationArguments(process.argv.slice(2));
  const commit = requireCleanCommit();
  const release = await resolveBuildPath(options.release);
  const verified = await verifyRelease(release, commit, options.generation);
  const plan = JSON.parse(await readFile(resolve(release, 'migration-plan.json'), 'utf8'));
  const evidence = await readEvidence(options.evidence);
  const recovery = options.recovery ? await readEvidence(options.recovery) : undefined;
  const operation = { ...prepareMigrationOperation(plan, evidence, recovery), releaseManifestSha256: verified.manifestSha256 };
  const output = await resolveBuildPath(options.out);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // An existing reviewed batch is never silently replaced with different evidence.
  await writeFile(output, JSON.stringify(operation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action: operation.action, fromVersion: operation.fromVersion,
    toVersion: operation.toVersion, environment: 'staging', generation: options.generation,
    evidenceSha256: operation.evidenceSha256, statements: operation.batch.length, applied: false }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
