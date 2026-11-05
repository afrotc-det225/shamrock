import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.v3.json'], {
  cwd: root, stdio: 'inherit',
});
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);

await mkdir(new URL('../.build/v3/', import.meta.url), { recursive: true });
await writeFile(new URL('../.build/v3/package.json', import.meta.url), '{"type":"module"}\n');
const artifacts = new URL('../.build/v3-artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ['apps/worker/src/index.ts'],
  outfile: fileURLToPath(new URL('worker.mjs', artifacts)),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  sourcemap: false, legalComments: 'none',
});
await build({
  absWorkingDir: root,
  entryPoints: ['apps/google-adapter/src/apps-script.ts'],
  outfile: fileURLToPath(new URL('GoogleAdapter.js', artifacts)),
  bundle: true, format: 'iife', globalName: 'SHAMROCKV3', platform: 'browser', target: 'es2019',
  sourcemap: false, legalComments: 'none',
});

const files = {};
for (const name of ['worker.mjs', 'GoogleAdapter.js']) {
  const bytes = await readFile(new URL(name, artifacts));
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(new URL('manifest.json', artifacts), JSON.stringify({
  formatVersion: 1,
  stage: 'isolated-prototype',
  productionReady: false,
  files,
}, null, 2) + '\n');
console.log('Built isolated v3 Worker and Google adapter artifacts; no deployment performed.');
