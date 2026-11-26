#!/usr/bin/env node
/** Offline only. Never accepts provider credentials or a remote database target. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { instrumentDatabase } from './lib/v3-capacity.mjs';
import { readMigrationSources, createMigrationPlan } from './lib/v3-migrations.mjs';
import { readBackupEvidence } from './lib/staging-backup.mjs';
import { validateReadBudgets, evaluateReadBudgets } from './lib/panel-read-rehearsal.mjs';
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let phase = 'arguments';
const check = (ok, code) => { if (!ok) throw Error(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const ident = value => { check(/^[a-z][a-z0-9_]*$/.test(value), 'READ_REHEARSAL_IDENTIFIER'); return '"' + value + '"'; };
async function privateFile(file) {
  const info = await fs.lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 128 * 1024 * 1024, 'READ_REHEARSAL_PRIVATE_FILE');
  return fs.realpath(file);
}
async function main() {
  const args = process.argv.slice(2), options = {};
  if (!args.length || args[0] === '--help') {
    console.log('Offline only: node scripts/rehearse-panel-reads.mjs --source-db PRIVATE_SQLITE_EXPORT --budgets PRIVATE_JSON --out-dir NEW_PRIVATE_DIRECTORY');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    check(['--source-db','--budgets','--out-dir'].includes(args[i]) && args[i + 1] && !options[args[i]], 'READ_REHEARSAL_ARGUMENT');
    options[args[i]] = args[i + 1];
  }
  check(Object.keys(options).length === 3, 'READ_REHEARSAL_ARGUMENT');
  const sourceFile = await privateFile(options['--source-db']);
  const config = validateReadBudgets(JSON.parse(await fs.readFile(await privateFile(options['--budgets']), 'utf8')));
  await fs.mkdir(options['--out-dir'], {mode:0o700});
  const dir = await fs.realpath(options['--out-dir']);
  let repository;
  try { repository = execFileSync('git',['-C',dir,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  if (repository) {
    try { execFileSync('git',['-C',repository,'check-ignore','-q','--',path.join(dir,'proof.private.json')],{stdio:'ignore'}); }
    catch { throw Error('READ_REHEARSAL_OUTPUT_NOT_IGNORED'); }
  }
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  phase = 'source-validation';
  const source = new DatabaseSync(sourceFile,{readOnly:true,allowExtension:false});
  let mf;
  try {
    source.exec('BEGIN');
    const plan = createMigrationPlan(await readMigrationSources(path.join(root,'database/migrations')),sourceCommit,config.generation);
    const evidence = await readBackupEvidence(async (sql,values=[])=>source.prepare(sql).all(...values),plan);
    const tables = evidence.inventory.filter(r=>r.type==='table' && !/^(sqlite_|_cf_)/.test(r.name));
    const tableNames = new Set(tables.map(r=>r.name));
    const dependencies = new Map(tables.map(r=>[r.name,new Set(source.prepare('PRAGMA foreign_key_list('+ident(r.name)+')').all().map(k=>k.table))]));
    const pending = new Set(tableNames), ordered=[];
    while (pending.size) {
      const ready=[...pending].filter(name=>[...dependencies.get(name)].every(parent=>parent===name || !pending.has(parent)));
      check(ready.length,'READ_REHEARSAL_SCHEMA_CYCLE');
      for (const name of ready) { pending.delete(name); ordered.push(name); }
    }
    phase = 'runtime-build';
    const artifact = path.join(dir,'runtime.mjs');
    const built = await build({absWorkingDir:root,stdin:{contents:`export { default as worker } from './apps/worker/src/index.ts'; export { HostedBackend } from './apps/admin/hosted/backend.mjs'; export { eventsState } from './apps/admin/hosted/events-list.mjs'; export { loadEventsList } from './apps/admin/snapshot-client.ts';`,resolveDir:root,loader:'ts'},outfile:artifact,bundle:true,platform:'node',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],metafile:true});
    const sourceInputs = {};
    for (const name of Object.keys(built.metafile.inputs).filter(n=>n!=='<stdin>' && !n.includes('node_modules/')).sort()) sourceInputs[name]=sha(await fs.readFile(path.resolve(root,name)));
    const {worker,HostedBackend,eventsState,loadEventsList} = await import(pathToFileURL(artifact));
    mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("Offline read rehearsal")}}',compatibilityDate:'2026-07-01',d1Databases:{DB:'offline-panel-rehearsal'},log:new Log(LogLevel.NONE)});
    const native = await mf.getD1Database('DB');
    phase = 'clone-schema';
    for (const row of tables) await native.prepare(row.sql).run();
    for (const row of evidence.inventory.filter(r=>r.type==='index' && r.sql && !/^(sqlite_|_cf_)/.test(r.name))) await native.prepare(row.sql).run();
    let copiedRows=0;
    phase = 'clone-records';
    for (const name of ordered) {
      const columns=source.prepare('PRAGMA table_info('+ident(name)+')').all().map(c=>c.name);
      const insert='INSERT INTO '+ident(name)+'('+columns.map(ident).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')';
      let batch=[];
      const self=dependencies.get(name).has(name);
      for (const row of source.prepare('SELECT * FROM '+ident(name)).iterate()) {
        batch.push(native.prepare(insert).bind(...columns.map(c=>row[c]))); copiedRows++;
        if (!self && batch.length===64) { await native.batch(batch); batch=[]; }
      }
      if (batch.length) await native.batch(self ? [native.prepare('PRAGMA defer_foreign_keys=ON'),...batch] : batch);
    }
    check((await native.prepare('PRAGMA foreign_key_check').all()).results.length===0,'READ_REHEARSAL_CLONE_FOREIGN_KEYS');
    const meter=instrumentDatabase(native), runtime={DB:meter.db,ENVIRONMENT:'staging',GENERATION:String(config.generation),BRIDGE_KEY_ID:'offline-rehearsal',BRIDGE_SECRET:randomBytes(32).toString('base64url')};
    let requests=0;
    const env={...runtime,BACKEND_ORIGIN:'https://offline-staging.example.invalid',SOURCE_KIND:'sheet',SOURCE_RESOURCE:'offline-rehearsal',BACKEND:{fetch:request=>{
      check(new URL(request.url).origin==='https://offline-staging.example.invalid','READ_REHEARSAL_REMOTE_REQUEST');
      requests++; return worker.fetch(request,runtime);
    }}};
    const backend=()=>new HostedBackend(env,config.principalId), samples=[];
    const measure=async(label,run)=>{
      phase = label;requests=0;meter.begin(label);const value=await run();const sample={...meter.end(),backendRequests:requests};samples.push(sample);return value;
    };
    const state=await measure('initial',async()=>{const b=backend();const manifest=await b.panelManifest([]);return {manifest,captureKey:b.binding,...(b.snapshotManifest?{snapshotManifest:b.snapshotManifest}:{})};});
    let first;
    await measure('events',async()=>{first=(await eventsState(backend())).eventsList;});
    await measure('repeatEvents',async()=>{const repeat=(await eventsState(backend())).eventsList;check(JSON.stringify(first)===JSON.stringify(repeat),'READ_REHEARSAL_REPEAT_CHANGED');});
    await measure('unchanged',async()=>{check(await backend().captureUnchanged(encodeURIComponent(JSON.stringify({captureKey:state.captureKey,revision:state.manifest.revision,viewAsRevision:null}))),'READ_REHEARSAL_REVISION_CHANGED');});
    meter.begin('reference');
    const reference=await loadEventsList(state,(_path,input)=>backend().page(input));
    const referenceCost=meter.end();
    check(JSON.stringify(reference)===JSON.stringify(first),'READ_REHEARSAL_OUTPUT_CHANGED');
    const assessed=evaluateReadBudgets(samples,config);
    const sourceDirty = !!execFileSync('git',['status','--porcelain','--',...Object.keys(sourceInputs)],{cwd:root,encoding:'utf8'}).trim();
    const proof={formatVersion:1,kind:'offline-panel-read-rehearsal',sourceCommit,sourceDirty,runtimeSha256:sha(await fs.readFile(artifact)),sourceInputsSha256:sha(JSON.stringify(sourceInputs)),sourceSha256:sha(await fs.readFile(sourceFile)),schemaVersion:evidence.ledger.length,tables:tables.length,copiedRows,profiles:assessed,referenceRows:referenceCost.localRowsRead,passed:assessed.every(s=>s.passed),providerCalls:0,productionChanges:0,limitations:['Repeat reads use the same warm isolate; cold isolates repeat the bounded initial load.','Cross-principal, View as, revocation and mutation invalidation are not covered by this rehearsal.','Local D1 row counters are not hosted CPU or daily-capacity acceptance.']};
    await fs.writeFile(path.join(dir,'proof.private.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify(proof));if(!proof.passed)process.exitCode=1;
  } finally {source.close();await mf?.dispose();}
}
main().catch(error=>{console.error(/^READ_REHEARSAL_[A-Z_]+$/.test(error.message)?error.message:'READ_REHEARSAL_FAILED ('+phase+'): no provider request was made');process.exitCode=1;});
