import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMigrationPlan, readMigrationSources } from './lib/v3-migrations.mjs';
export { classifyMigrationState, createMigrationPlan, createUpgradeBatch, migrationEvidenceHash, readMigrationSources } from './lib/v3-migrations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const compatibilityDate = '2026-11-05'; // Staging target; local workerd is older, so remote smoke verification is required.
const baseReleaseFiles = ['worker.mjs', 'GoogleAdapter.js', 'appsscript.json', 'migration-plan.json', 'upload-metadata.template.json'];
const migrationDirectory = resolve(root, 'database/migrations');
const migrationCatalog = sources => sources.map(({ name, sql }, index) => ({ version: index + 1, name, sha256: sha256(sql) }));
const artifactNames = sources => [...baseReleaseFiles, ...sources.map(({ name }) => `migrations/${name}`)];
const sha256 = value => createHash('sha256').update(value).digest('hex');

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

export async function resolveBuildPath(value) {
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

export async function verifyRelease(directory, commit, generation, sourceDirectory = migrationDirectory) {
  const sources = await readMigrationSources(sourceDirectory);
  const reviewedPlan = createMigrationPlan(sources, commit, generation);
  const releaseFiles = artifactNames(sources);
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.formatVersion !== 2 || manifest.environment !== 'staging' || manifest.productionReady !== false
    || manifest.sourceCommit !== commit || manifest.generation !== generation || manifest.compatibilityDate !== compatibilityDate
    || JSON.stringify(manifest.migrations) !== JSON.stringify(migrationCatalog(sources))
    || JSON.stringify(manifest.migration) !== JSON.stringify(migrationCatalog(sources).at(-1))
    || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...releaseFiles].sort())) {
    throw new Error('Release manifest does not match committed source, target or supported artifact format.');
  }
  for (const name of releaseFiles) {
    const bytes = await readFile(resolve(directory, name));
    const expected = manifest.files[name];
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Artifact hash mismatch: ${name}`);
  }
  for (const source of sources) {
    const bytes = await readFile(resolve(directory, 'migrations', source.name), 'utf8');
    if (bytes !== source.sql) throw new Error('Migration source hash changed.');
  }
  const preparedPlan = JSON.parse(await readFile(resolve(directory, 'migration-plan.json'), 'utf8'));
  if (JSON.stringify(preparedPlan) !== JSON.stringify(reviewedPlan)) throw new Error('Migration plan differs from reviewed source.');
  return { sourceCommit: commit, environment: 'staging', generation, manifestSha256: sha256(manifestBytes), verified: true };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const commit = requireCleanCommit();
  const output = await resolveBuildPath(options.out);
  if (options.verify) {
    console.log(JSON.stringify(await verifyRelease(output, commit, options.generation), null, 2));
    return;
  }
  const build = spawnSync(process.execPath, ['scripts/build-v3.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Build failed; no release prepared.');
  if (requireCleanCommit() !== commit) throw new Error('Source changed during build.');
  const sources = await readMigrationSources(migrationDirectory);
  const plan = createMigrationPlan(sources, commit, options.generation);
  const releaseFiles = artifactNames(sources);
  const builtManifest = JSON.parse(await readFile(resolve(root, '.build/v3-artifacts/manifest.json'), 'utf8'));
  const files = {};
  await mkdir(output, { recursive: true });
  for (const name of ['worker.mjs', 'GoogleAdapter.js', 'appsscript.json']) {
    const bytes = await readFile(resolve(root, '.build/v3-artifacts', name));
    if (sha256(bytes) !== builtManifest.files[name]?.sha256 || bytes.length !== builtManifest.files[name]?.bytes) {
      throw new Error('Build artifact and build manifest disagree.');
    }
    await writeFile(resolve(output, name), bytes);
  }
  await mkdir(resolve(output, 'migrations'), { recursive: true });
  for (const source of sources) await writeFile(resolve(output, 'migrations', source.name), source.sql);
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
    formatVersion: 2, stage: 'isolated-prototype', productionReady: false,
    environment: 'staging', generation: options.generation, sourceCommit: commit, compatibilityDate,
    requiredSecrets: ['BRIDGE_SECRET'],
    migration: migrationCatalog(sources).at(-1),
    migrations: migrationCatalog(sources),
    files,
  };
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ...await verifyRelease(output, commit, options.generation), artifactDirectory: relative(root, output), deployed: false }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
