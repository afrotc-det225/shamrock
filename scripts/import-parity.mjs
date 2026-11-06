#!/usr/bin/env node
/** Offline/private import tooling. This executable has no provider credentials or write client. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { captureLegacySources } from './lib/import-capture.mjs';
import { buildImportPlan, verifyImportAccounting, compareImportReadback, compareAttendanceSnapshots, proposeImportCrosswalk } from './lib/import-parity.mjs';
import {reconcileImportEvidence} from './lib/import-reconciliation.mjs';
import {buildStagingImportModel,createStagingImportPlan,stagingImportSummary} from './lib/import-staging.mjs';

process.umask(0o077);
const fail=code=>{throw new Error(code);};
function args(argv) {
  const [command,...rest]=argv,out={command};
  if(!['capture','plan','compare','report','crosswalk-template','reconcile','prepare-staging'].includes(command))fail('IMPORT_CLI_COMMAND');
  for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!['--snapshot','--crosswalk','--plan','--readback','--attendance','--manifest','--reader','--private-dir','--review','--reconciliation','--generation','--imported-at'].includes(key)||!rest[i+1]||Object.hasOwn(out,key.slice(2)))fail('IMPORT_CLI_ARGUMENT');out[key.slice(2)]=rest[i+1];}
  return out;
}
async function read(file) {
  if(!file)fail('IMPORT_CLI_INPUT_REQUIRED');
  const info=await fs.stat(file);if(!info.isFile()||info.size>128*1024*1024)fail('IMPORT_CLI_INPUT_BOUND');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
async function privateDir(value) {
  if(!value)fail('IMPORT_CLI_PRIVATE_DIR_REQUIRED');
  const absolute=path.resolve(value);await fs.mkdir(absolute,{recursive:true,mode:0o700});
  if((await fs.lstat(absolute)).isSymbolicLink())fail('IMPORT_CLI_SYMLINK_OUTPUT');
  // Resolve platform aliases such as macOS /var -> /private/var before enforcing Git/privacy boundaries.
  const real=await fs.realpath(absolute);
  const info=await fs.stat(real);if((info.mode&0o077)!==0)fail('IMPORT_CLI_PRIVATE_DIR_PERMISSIONS');
  // An in-repository output must actually be ignored; a merely named "private" directory is insufficient.
  let root;try{root=execFileSync('git',['-C',real,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  if(root){try{execFileSync('git',['-C',root,'check-ignore','-q','--',`${real}/import-plan.json`],{stdio:'ignore'});}catch{fail('IMPORT_CLI_OUTPUT_NOT_IGNORED');}}
  return real;
}
async function write(dir,name,data){await fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});}
async function main() {
  const options=args(process.argv.slice(2));
  if(options.command==='report'){const plan=await read(options.plan);if(plan?.formatVersion!==1||!plan.summary)fail('IMPORT_CLI_PLAN');console.log(JSON.stringify(plan.summary,null,2));return;}
  const dir=await privateDir(options['private-dir']);
  if(options.command==='capture') {
    if(!options.reader)fail('IMPORT_CLI_READER_REQUIRED');
    const module=await import(pathToFileURL(path.resolve(options.reader)).href);
    const snapshot=await captureLegacySources({manifest:await read(options.manifest),port:module.readOnlyImportPort});
    await write(dir,'snapshot.json',snapshot);
    console.log(JSON.stringify({consistent:snapshot.consistent,resources:snapshot.resources.length,passes:snapshot.passes,writerFence:false,snapshotSha256:snapshot.snapshotSha256}));return;
  }
  if(options.command==='plan') {
    const snapshot=await read(options.snapshot),crosswalk=options.crosswalk?await read(options.crosswalk):undefined;
    const plan=buildImportPlan(snapshot,crosswalk),accounting=verifyImportAccounting(snapshot,plan);
    await write(dir,'import-plan.json',plan);await write(dir,'accounting.json',accounting);await write(dir,'summary.json',plan.summary);
    console.log(JSON.stringify({accounting,summary:plan.summary},null,2));return;
  }
  const plan=await read(options.plan);
  if(options.command==='prepare-staging') {
    const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const owningFiles=['scripts/import-parity.mjs','scripts/lib/import-staging.mjs','scripts/lib/import-parity.mjs','scripts/lib/import-capture.mjs','scripts/lib/import-reconciliation.mjs','database/migrations/0008_legacy_import_evidence.sql','packages/domain/src/admin.ts','packages/domain/src/frontend-reporting.ts','apps/worker/src/admin.ts','apps/worker/src/corrections.ts'];
    let sourceCommit;try{execFileSync('git',['ls-files','--error-unmatch',...owningFiles],{cwd:sourceRoot,stdio:'ignore'});execFileSync('git',['diff','--quiet','HEAD','--',...owningFiles],{cwd:sourceRoot,stdio:'ignore'});sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{fail('IMPORT_CLI_UNCOMMITTED_SOURCE');}
    const snapshot=await read(options.snapshot),reconciliation=await read(options.reconciliation),review=await read(options.review);
    const model=buildStagingImportModel(snapshot,plan,reconciliation,review),execution=createStagingImportPlan(snapshot,model,{generation:Number(options.generation),importedAt:options['imported-at']??new Date().toISOString(),sourceCommit});
    await write(dir,'model.json',model);await write(dir,'execution.json',execution);await write(dir,'summary.json',stagingImportSummary(execution));
    console.log(JSON.stringify(stagingImportSummary(execution),null,2));return;
  }
  if(options.command==='reconcile') {
    const snapshot=await read(options.snapshot);verifyImportAccounting(snapshot,plan);
    const result=reconcileImportEvidence(snapshot,plan);
    await write(dir,'reconciliation.json',result);await write(dir,'summary.json',result.summary);
    console.log(JSON.stringify(result.summary,null,2));return;
  }
  if(options.command==='crosswalk-template') {
    const proposal=proposeImportCrosswalk(plan);
    await write(dir,'crosswalk-template.json',proposal);
    console.log(JSON.stringify({...proposal.summary,reviewRequired:true}));return;
  }
  if(!options.readback&&!options.attendance)fail('IMPORT_CLI_COMPARISON_REQUIRED');
  const result={};
  if(options.readback)result.accounting=compareImportReadback(plan,await read(options.readback));
  if(options.attendance)result.attendance=compareAttendanceSnapshots(plan,await read(options.attendance));
  await write(dir,'comparison.json',result);
  console.log(JSON.stringify({accounting:result.accounting?{complete:result.accounting.complete,expected:result.accounting.expected,matched:result.accounting.matched,differences:result.accounting.differences.length}:null,attendance:result.attendance?{parityEstablished:result.attendance.parityEstablished,comparedCells:result.attendance.comparedCells,blockedMatrixRows:result.attendance.blockedMatrixRows,differences:result.attendance.differences.length}:null}));
}
main().catch(error=>{console.error(JSON.stringify({error:/^(IMPORT|CAPTURE)_[A-Z_]+$/.test(error?.message)?error.message:'IMPORT_CLI_FAILED',detail:'No private source records are printed. Inspect private evidence locally.'}));process.exitCode=1;});
