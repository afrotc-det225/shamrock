#!/usr/bin/env node
/** Staging-only operational console. Default commands create private review artifacts; apply is explicit. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {captureOperationalSnapshot,exportOperationalCsv,planOperationalCsvImport,planBulkAttendance,executeOperationalPlan,operationalHash,verifyOperationalPlan} from './lib/operational-admin.mjs';
import {exportCanonicalLegend,planCanonicalLegend} from './lib/operational-legend.mjs';
process.umask(0o077);
const fail=code=>{throw Error(code);},root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const HELP=`SHAMROCK operational administration (staging only)
  capture --config PRIVATE_CONFIG --private-dir PRIVATE_DIRECTORY [--term TERM_ID]
  export --snapshot PRIVATE_SNAPSHOT --category CATEGORY --private-dir PRIVATE_DIRECTORY [--as-of YYYY-MM-DD]
  plan-import --config PRIVATE_CONFIG --snapshot PRIVATE_SNAPSHOT --csv CSV --category CATEGORY --spec PRIVATE_SPEC --private-dir PRIVATE_DIRECTORY
  plan-bulk --config PRIVATE_CONFIG --snapshot PRIVATE_SNAPSHOT --spec PRIVATE_SPEC --private-dir PRIVATE_DIRECTORY
  apply --config PRIVATE_CONFIG --plan PRIVATE_PLAN --review-sha SHA256 --private-dir PRIVATE_DIRECTORY [--max-commands 5]
  export-legend --private-dir PRIVATE_DIRECTORY
  plan-legend --csv CSV --spec PRIVATE_SPEC --private-dir PRIVATE_DIRECTORY [--forms-config PRIVATE_FORM_CONFIG]
  recover-lock --plan PRIVATE_PLAN --review-sha SHA256 --private-dir PRIVATE_DIRECTORY
  report --plan PRIVATE_PLAN
Categories: directory, leadership (cadre alias), events, attendance, excusals.
Build with npm run build:v3 first. No command changes production. Apply commits only the bounded reviewed commands; normal native publishers finish the Sheets and Forms updates.`;
function args(argv){
 if(!argv.length||argv[0]==='--help'||argv[0]==='help')return {command:'help'};
 const [command,...rest]=argv,out={command};if(!['capture','export','plan-import','plan-bulk','apply','report','export-legend','plan-legend','recover-lock'].includes(command))fail('ADMIN_CLI_COMMAND');
 for(let i=0;i<rest.length;i+=2){if(!['--config','--private-dir','--snapshot','--category','--as-of','--csv','--spec','--plan','--review-sha','--max-commands','--forms-config','--term'].includes(rest[i])||!rest[i+1]||Object.hasOwn(out,rest[i].slice(2)))fail('ADMIN_CLI_ARGUMENT');out[rest[i].slice(2)]=rest[i+1];}return out;
}
export async function readPrivateOperationalFile(file,{json=true}={}){
 if(!file)fail('ADMIN_CLI_INPUT_REQUIRED');const info=await fs.lstat(file);
 if(info.isSymbolicLink()||!info.isFile()||info.size>64*1024*1024||(info.mode&0o077)!==0||info.uid!==process.getuid())fail('ADMIN_CLI_PRIVATE_FILE');
 const text=await fs.readFile(file,'utf8');return json?JSON.parse(text):text;
}
export async function privateOperationalDirectory(value){
 if(!value)fail('ADMIN_CLI_PRIVATE_DIR_REQUIRED');const absolute=path.resolve(value);await fs.mkdir(absolute,{recursive:true,mode:0o700});
 if((await fs.lstat(absolute)).isSymbolicLink())fail('ADMIN_CLI_SYMLINK');const real=await fs.realpath(absolute),info=await fs.stat(real);
 if((info.mode&0o077)!==0||info.uid!==process.getuid())fail('ADMIN_CLI_PRIVATE_DIR');
 let repository;try{repository=execFileSync('git',['-C',real,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 if(repository)try{execFileSync('git',['-C',repository,'check-ignore','-q','--',path.join(real,'operational-plan.json')],{stdio:'ignore'});}catch{fail('ADMIN_CLI_OUTPUT_NOT_IGNORED');}
 return real;
}
const writeNew=(dir,name,value,json=true)=>fs.writeFile(path.join(dir,name),json?JSON.stringify(value,null,2)+'\n':value,{flag:'wx',mode:0o600});
function configuration(value){
 if(!value||value.version!==1||value.environment!=='staging'||!Number.isSafeInteger(value.generation)||value.generation<1||value.sourceKind!=='sheet'||['keyId','principalId','resourceKey'].some(k=>typeof value[k]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[k])))fail('ADMIN_CLI_CONFIGURATION');
 const origin=new URL(value.workerOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)fail('ADMIN_CLI_ORIGIN');
 if(Object.keys(value).some(k=>!['version','environment','generation','sourceKind','keyId','principalId','resourceKey','workerOrigin','secretReference'].includes(k)))fail('ADMIN_CLI_CONFIGURATION');
 return {...value,workerOrigin:origin.origin};
}
const fingerprint=c=>operationalHash(Object.fromEntries(['environment','generation','sourceKind','keyId','principalId','resourceKey','workerOrigin'].map(key=>[key,c[key]])));
function sourceCommit(requireClean=false){
 const owning=['scripts/operational-admin.mjs','scripts/lib/operational-admin.mjs','scripts/lib/operational-csv.mjs','scripts/lib/operational-selectors.mjs','packages/domain/src/admin.ts','packages/domain/src/corrections.ts','packages/domain/src/index.ts','packages/domain/src/frontend-reporting.ts','packages/domain/src/frontend-transport.ts','apps/google-adapter/src/frontend-publication.ts'];
 if(requireClean){execFileSync('git',['ls-files','--error-unmatch',...owning],{cwd:root,stdio:'ignore'});execFileSync('git',['diff','--quiet','HEAD','--',...owning],{cwd:root,stdio:'ignore'});}
 return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
}
function signedClient(config){
 if(typeof config.secretReference!=='string'||!config.secretReference.startsWith('op://')||config.secretReference.length>1000)fail('ADMIN_CLI_SECRET_REFERENCE');
 let secret;try{secret=execFileSync('op',['read',config.secretReference],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:16384}).trim();}catch{fail('ADMIN_CLI_VAULT_UNAVAILABLE');}
 if(secret.length<32||secret.length>4096)fail('ADMIN_CLI_SECRET_BOUND');
 return async(endpoint,input)=>{
  if(!['/v1/admin/snapshot/page','/v1/admin/commands','/v1/commands'].includes(endpoint))fail('ADMIN_CLI_ENDPOINT');const body=JSON.stringify(input);
  if(Buffer.byteLength(body)>65536)fail('ADMIN_CLI_REQUEST_SIZE');const timestamp=String(Math.floor(Date.now()/1000));const digest=createHash('sha256').update(body).digest('hex');
  const response=await fetch(config.workerOrigin+endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json','x-shamrock-key-id':config.keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':createHmac('sha256',secret).update(`POST\n${endpoint}\n${timestamp}\n${digest}`).digest('hex')},body});
  const text=await response.text();if(Buffer.byteLength(text)>150000)fail('ADMIN_CLI_RESPONSE_SIZE');return {status:response.status,body:JSON.parse(text)};
 };
}
async function savedSnapshot(file){const saved=await readPrivateOperationalFile(file);if(saved?.formatVersion!==1||saved.snapshotHash!==operationalHash(saved.snapshot)||!/^[a-f0-9]{64}$/.test(saved.targetFingerprint??''))fail('ADMIN_CLI_SNAPSHOT');return saved;}
async function main(){
 const opts=args(process.argv.slice(2));if(opts.command==='help'){console.log(HELP);return;}
 if(opts.command==='report'){const plan=await readPrivateOperationalFile(opts.plan);verifyOperationalPlan(plan);console.log(JSON.stringify({planHash:plan.planHash,...plan.summary},null,2));return;}
 const dir=await privateOperationalDirectory(opts['private-dir']);
 if(opts.command==='recover-lock'){
  const plan=await readPrivateOperationalFile(opts.plan);verifyOperationalPlan(plan);if(opts['review-sha']!==plan.planHash)fail('ADMIN_REVIEW_REQUIRED');
  const file=path.join(dir,'journal.lock'),saved=await readPrivateOperationalFile(file);if(saved.planHash!==plan.planHash||saved.hostname!==hostname()||!Number.isSafeInteger(saved.pid)||saved.pid<=0)fail('ADMIN_CLI_LOCK_IDENTITY');
  try{process.kill(saved.pid,0);fail('ADMIN_CLI_LOCK_ACTIVE');}catch(error){if(error.code!=='ESRCH')throw error;}
  await fs.unlink(file);console.log(JSON.stringify({status:'stale-local-lock-removed',planHash:plan.planHash,journalChanged:false}));return;
 }
 if(['export-legend','plan-legend'].includes(opts.command)){
  const source=await fs.readFile(path.join(root,'src/utils/arrays.ts'),'utf8');
  if(opts.command==='export-legend'){await writeNew(dir,'export.csv',exportCanonicalLegend(source),false);console.log(JSON.stringify({status:'exported',category:'data_legend',providerWrites:0}));return;}
  const spec=await readPrivateOperationalFile(opts.spec),result=planCanonicalLegend(await readPrivateOperationalFile(opts.csv,{json:false}),source,{reason:spec.reason,formsConfig:opts['forms-config']?await readPrivateOperationalFile(opts['forms-config']):undefined});
  await writeNew(dir,'legend-plan.json',result.plan);await writeNew(dir,'arrays.proposed.ts',result.proposedSource,false);await writeNew(dir,'legend-values.json',result.legendValues);if(result.proposedFormsConfig)await writeNew(dir,'forms-config.proposed.json',result.proposedFormsConfig);
  console.log(JSON.stringify({status:'reviewable-configuration-change',planHash:result.plan.planHash,changedLists:result.plan.changes.length,privateConfigChanges:result.plan.privateConfigChanges.length,providerWrites:0}));return;
 }
 if(opts.command==='capture'){
  const config=configuration(await readPrivateOperationalFile(opts.config)),snapshot=await captureOperationalSnapshot({environment:config.environment,generation:config.generation,principalId:config.principalId},signedClient(config),{termId:opts.term??null});
  await writeNew(dir,'snapshot.json',{formatVersion:1,targetFingerprint:fingerprint(config),capturedAt:new Date().toISOString(),snapshotHash:operationalHash(snapshot),snapshot});
  console.log(JSON.stringify({status:'captured',people:snapshot.people.length,events:snapshot.events.length,scope:snapshot.captureScope,revision:snapshot.revision,providerWrites:0}));return;
 }
 if(opts.command==='export'){
  const saved=await savedSnapshot(opts.snapshot),csv=exportOperationalCsv(saved.snapshot,opts.category,{asOfDate:opts['as-of']});await writeNew(dir,'export.csv',csv,false);console.log(JSON.stringify({status:'exported',category:opts.category,bytes:Buffer.byteLength(csv),providerWrites:0}));return;
 }
 if(['plan-import','plan-bulk'].includes(opts.command)){
  const config=configuration(await readPrivateOperationalFile(opts.config)),saved=await savedSnapshot(opts.snapshot),spec=await readPrivateOperationalFile(opts.spec);
  if(saved.targetFingerprint!==fingerprint(config)||saved.snapshot.environment!==config.environment||saved.snapshot.generation!==config.generation||spec.formatVersion!==1)fail('ADMIN_CLI_TARGET_BINDING');
  const context={batchId:spec.batchId,principalId:config.principalId,resourceKey:config.resourceKey,sourceKind:config.sourceKind,asOfDate:spec.asOfDate,reason:spec.reason,targetFingerprint:fingerprint(config),sourceCommit:sourceCommit()};
  const plan=opts.command==='plan-import'?planOperationalCsvImport(saved.snapshot,await readPrivateOperationalFile(opts.csv,{json:false}),opts.category,context,{mode:spec.mode,replaceScopeIds:spec.replaceScopeIds??[]}):planBulkAttendance(saved.snapshot,context,spec.selection);
  await writeNew(dir,'operational-plan.json',plan);await writeNew(dir,'summary.json',{planHash:plan.planHash,...plan.summary});console.log(JSON.stringify({planHash:plan.planHash,...plan.summary},null,2));return;
 }
 const config=configuration(await readPrivateOperationalFile(opts.config)),plan=await readPrivateOperationalFile(opts.plan);verifyOperationalPlan(plan);
 if(plan.environment!=='staging'||plan.targetFingerprint!==fingerprint(config)||plan.sourceCommit!==sourceCommit(true)||['generation','principalId','resourceKey','sourceKind'].some(k=>plan[k]!==config[k]))fail('ADMIN_CLI_TARGET_BINDING');
 if(opts['review-sha']!==plan.planHash)fail('ADMIN_REVIEW_REQUIRED');const lockPath=path.join(dir,'journal.lock'),handle=await fs.open(lockPath,'wx',0o600);
 try{
  await handle.writeFile(JSON.stringify({pid:process.pid,hostname:hostname(),planHash:plan.planHash,startedAt:new Date().toISOString()})+'\n');await handle.sync();
  const journalPath=path.join(dir,'journal.json');let priorHash;
  const state={async load(){try{const value=await readPrivateOperationalFile(journalPath);priorHash=operationalHash(value);return value;}catch(error){if(error.code==='ENOENT'){priorHash=null;return undefined;}throw error;}},async save(value){
   let current=null;try{current=operationalHash(await readPrivateOperationalFile(journalPath));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(current!==priorHash)fail('ADMIN_CLI_CHECKPOINT_CHANGED');const temporary=path.join(dir,`.journal-${randomUUID()}.json`),file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
   await fs.rename(temporary,journalPath);const observed=await readPrivateOperationalFile(journalPath);if(operationalHash(observed)!==operationalHash(value))fail('ADMIN_CLI_CHECKPOINT_READBACK');priorHash=operationalHash(value);
  }};
  const result=await executeOperationalPlan(plan,{approvedHash:opts['review-sha'],state,request:signedClient(config),maximumCommands:opts['max-commands']===undefined?5:Number(opts['max-commands'])});console.log(JSON.stringify({...result,planHash:plan.planHash,productionChanges:false}));
 }finally{await handle.close();await fs.unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(/^(ADMIN_|CSV_|BULK_|SELECTOR_)/.test(error.message)?error.message:'ADMIN_CLI_FAILED: retained private evidence; no automatic rollback or rebase');process.exitCode=1;});
