/** Read-only history publication advances by one bounded D1 page and retains its cursor privately. */
import { AdapterError, type AdapterConfig, type Signer, type Transport } from './index.js';
import type { ScriptLockPort } from './apps-script.js';
import { HISTORY_PAGE_VERSION, type HistoryPageManifest, type HistoryRowsPage } from '../../../packages/domain/src/legacy-history-transport.js';
export interface HistoryCatalogEntry {snapshotId:string;title:string;periodLabel:string|null;sourceSnapshotSha256:string;importedAt:string;rowCount:number;eventCount:number;unresolvedRows:number;}
export interface HistoryPublicationState {version:1;environment:'staging';generation:number;bindingHash:string;catalog:HistoryCatalogEntry[];completed:number;phase:'scan'|'write'|'verify'|'publish'|'complete';offset:number;positions:{rowId:string;sourceRowIndex:number}[];manifest?:HistoryPageManifest;verificationVersion?:string;verificationRestarts?:number;}
export interface HistoryPorts {
  config:AdapterConfig;principalId:string;signer:Signer;transport:Transport;nowSeconds():number;lock:ScriptLockPort;bindingHash:string;
  enabled():boolean;assertPrivate():void;state:{load():HistoryPublicationState;save(state:HistoryPublicationState):void};
  report:{ensure(manifest:HistoryPageManifest):void;write(manifest:HistoryPageManifest,page:HistoryRowsPage,positions:HistoryPublicationState['positions']):void;
    version():string;verifyHeaders(manifest:HistoryPageManifest):void;verify(manifest:HistoryPageManifest,page:HistoryRowsPage,positions:HistoryPublicationState['positions']):void;
    publish(manifest:HistoryPageManifest,index:number,catalog:HistoryCatalogEntry[]):void;};
}
function fail(message:string):never{throw new AdapterError('history_publication',message);}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const integer=(v:unknown,max:number)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const dataStart=(manifest:HistoryPageManifest|undefined):number=>{const row=manifest?.report?.sourceDataStartRowIndex??2;if(row!==1&&row!==2)fail('The historical source layout is invalid.');return row;};
const bytes=(v:string)=>encodeURIComponent(v).replace(/%[A-F0-9]{2}/g,'x').length;
export function validateHistoryState(input:unknown,generation:number,bindingHash:string):HistoryPublicationState {
  if(!object(input)||input.version!==1||input.environment!=='staging'||input.generation!==generation||input.bindingHash!==bindingHash||!Array.isArray(input.catalog)||input.catalog.length>100||!integer(input.completed,input.catalog.length)||!['scan','write','verify','publish','complete'].includes(input.phase)||!integer(input.offset,500)||!Array.isArray(input.positions)||input.positions.length>500||bytes(JSON.stringify(input))>128000)fail('The private history cursor is invalid or belongs to a different binding.');
  if(input.verificationRestarts!==undefined&&!integer(input.verificationRestarts,3))fail('The historical verification restart count is invalid.');
  for(const c of input.catalog)if(!object(c)||!id(c.snapshotId)||!sha(c.sourceSnapshotSha256)||typeof c.importedAt!=='string'||!Number.isFinite(Date.parse(c.importedAt))||typeof c.title!=='string'||c.title.length>512||!(c.periodLabel===null||typeof c.periodLabel==='string'&&c.periodLabel.length<=512)||!integer(c.rowCount,500)||!integer(c.eventCount,128)||!integer(c.unresolvedRows,c.rowCount))fail('The historical source catalog is invalid.');
  if(new Set(input.catalog.map((c:any)=>c.snapshotId)).size!==input.catalog.length||new Set(input.positions.map((p:any)=>p.rowId)).size!==input.positions.length||new Set(input.positions.map((p:any)=>p.sourceRowIndex)).size!==input.positions.length||input.positions.some((p:any)=>!object(p)||!id(p.rowId)||!Number.isSafeInteger(p.sourceRowIndex)||p.sourceRowIndex<dataStart(input.manifest)))fail('Historical row identities are missing or duplicated.');
  if(input.phase==='complete'&&(input.completed!==input.catalog.length||input.manifest||input.positions.length||input.offset))fail('History completion has an unfinished source report.');
  if(input.manifest){const c=input.catalog[input.completed],m=input.manifest;if(!c||!object(m)||m.contractVersion!==HISTORY_PAGE_VERSION||m.section!=='manifest'||m.snapshotId!==c.snapshotId||m.sourceSnapshotSha256!==c.sourceSnapshotSha256||m.importedAt!==c.importedAt||m.rowCount!==c.rowCount||!object(m.report)||m.report.snapshotId!==c.snapshotId||m.report.sourceSnapshotSha256!==c.sourceSnapshotSha256||m.report.importedAt!==c.importedAt||m.report.contractVersion!=='legacy-source-report-v1'||m.report.readOnly!==true||!Array.isArray(m.report.eventColumns)||m.report.eventColumns.length!==c.eventCount)fail('The saved historical manifest does not match its immutable source.');
    if(input.offset>c.rowCount||input.phase==='scan'&&input.positions.length!==input.offset||['write','verify','publish'].includes(input.phase)&&(input.positions.length!==c.rowCount||input.positions.some((p:any,i:number)=>i>0&&p.sourceRowIndex<=input.positions[i-1].sourceRowIndex))||['verify','publish'].includes(input.phase)&&(typeof input.verificationVersion!=='string'||!input.verificationVersion))fail('The source row index or publication cursor is incomplete.');}
  return input as unknown as HistoryPublicationState;
}
function call(ports:HistoryPorts,path:'/v1/admin/history/list'|'/v1/admin/history/page',fields:Record<string,unknown>):Record<string,any>{
  if(ports.config.environment!=='staging'||!/^https:\/\/[A-Za-z0-9.-]+$/.test(ports.config.baseUrl)||!id(ports.principalId)||!id(ports.config.keyId))fail('Use the explicitly bound staging history reader.');
  const body=JSON.stringify({environment:'staging',generation:ports.config.generation,principalId:ports.principalId,...fields}),timestamp=String(ports.nowSeconds());
  const response=ports.transport.send({method:'POST',url:ports.config.baseUrl+path,body,headers:{'content-type':'application/json','x-shamrock-key-id':ports.config.keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':ports.signer.hmacSha256(`POST\n${path}\n${timestamp}\n${ports.signer.sha256(body)}`)}});
  if(response.status!==200||typeof response.body!=='string'||bytes(response.body)>160000)fail(`A bounded history read failed (HTTP ${response.status}); its saved cursor is retained.`);
  let value:unknown;try{value=JSON.parse(response.body);}catch{return fail('The history response was not structured data.');}if(!object(value))fail('The history response was not structured data.');return value;
}
/** One invocation uses at most a manifest, one eight-row page, and final source verification. */
export function continueHistoryPublication(ports:HistoryPorts):{state:string;completed?:number;reports?:number}{
  if(!ports.enabled())return {state:'disabled'};if(!ports.lock.tryLock(1000))return {state:'busy'};
  try{
    ports.assertPrivate();let state=validateHistoryState(ports.state.load(),ports.config.generation,ports.bindingHash);
    const save=()=>{validateHistoryState(state,ports.config.generation,ports.bindingHash);ports.assertPrivate();ports.state.save(state);};
    if(state.phase==='complete')return {state:'complete',completed:state.completed,reports:state.catalog.length};
    if(!state.catalog.length){const response=call(ports,'/v1/admin/history/list',{});if(response.contractVersion!=='legacy-source-report-v1'||response.readOnly!==true||!Array.isArray(response.snapshots))fail('The retained source catalog is unavailable.');
      state={...state,catalog:response.snapshots.map((r:any)=>({snapshotId:r.snapshotId,title:r.title,periodLabel:r.periodLabel,sourceSnapshotSha256:r.sourceSnapshotSha256,importedAt:r.importedAt,rowCount:r.rowCount,eventCount:r.eventCount,unresolvedRows:r.unresolvedRows}))};
      if(!state.catalog.length){state.phase='complete';save();return {state:'complete',completed:0,reports:0};}save();}
    const source=state.catalog[state.completed];if(!source)fail('The next source report is missing.');
    const page=(section:'manifest'|'rows'|'verify',offset=0)=>{const value=call(ports,'/v1/admin/history/page',{snapshotId:source.snapshotId,section,offset,sourceSnapshotSha256:section==='manifest'?null:source.sourceSnapshotSha256});
      if(value.contractVersion!==HISTORY_PAGE_VERSION||value.section!==section||value.snapshotId!==source.snapshotId||value.sourceSnapshotSha256!==source.sourceSnapshotSha256||value.importedAt!==source.importedAt)fail('The immutable historical source changed during publication.');return value;};
    if(!state.manifest){state={...state,manifest:page('manifest') as HistoryPageManifest};save();}
    const manifest=state.manifest!;
    const read=()=>{const value=page('rows',state.offset);if(value.offset!==state.offset||!Array.isArray(value.rows)||value.rows.length>8||value.rows.length===0&&state.offset<source.rowCount||state.offset+value.rows.length>source.rowCount||value.nextOffset!==(state.offset+value.rows.length<source.rowCount?state.offset+value.rows.length:null)||value.rows.some((entry:any)=>!object(entry)||!Number.isSafeInteger(entry.sourceRowIndex)||entry.sourceRowIndex<dataStart(manifest)||!object(entry.row)||!id(entry.row.rowId)||!Array.isArray(entry.diagnostics)))fail('A historical row page was repeated, missing or oversized.');return value as HistoryRowsPage;};
    if(state.phase==='scan'){
      const rows=read();state={...state,positions:[...state.positions,...rows.rows.map(r=>({rowId:r.row.rowId,sourceRowIndex:r.sourceRowIndex}))]};
      if(rows.nextOffset!==null)state.offset=rows.nextOffset;else{if(state.positions.length!==source.rowCount||page('verify').verified!==true)fail('The complete historical row index could not be verified.');state.positions.sort((a,b)=>a.sourceRowIndex-b.sourceRowIndex);state.offset=0;state.phase='write';}save();
    }else if(state.phase==='write'){
      ports.report.ensure(manifest);const rows=read();ports.report.write(manifest,rows,state.positions);
      if(rows.nextOffset!==null)state.offset=rows.nextOffset;else{state.offset=0;state.phase='verify';state.verificationVersion=ports.report.version();}save();
    }else if(state.phase==='verify'){
      // Drive can publish a delayed revision after our own Sheets writes. A new
      // revision invalidates every prior read; it never authorizes new values.
      const restart=(version:string)=>{
        if((state.verificationRestarts??0)>=3)fail('The report keeps changing during verification. Retain the checkpoint for review.');
        state={...state,offset:0,verificationVersion:version,verificationRestarts:(state.verificationRestarts??0)+1};save();
        return {state:state.phase,completed:state.completed,reports:state.catalog.length};
      };
      const before=ports.report.version();
      if(before!==state.verificationVersion)return restart(before);
      ports.report.verifyHeaders(manifest);const rows=read();ports.report.verify(manifest,rows,state.positions);
      const after=ports.report.version();
      if(after!==state.verificationVersion)return restart(after);
      if(rows.nextOffset!==null)state.offset=rows.nextOffset;else{
        if(page('verify').verified!==true)fail('Final immutable source verification failed.');
        // Persist before exposing the report. A lost final write response re-verifies every
        // literal page against the new provider version instead of guessing completion.
        state.phase='publish';save();ports.assertPrivate();ports.report.publish(manifest,state.completed,state.catalog);
        state={version:1,environment:'staging',generation:state.generation,bindingHash:state.bindingHash,catalog:state.catalog,completed:state.completed+1,phase:state.completed+1===state.catalog.length?'complete':'scan',offset:0,positions:[]};
      }save();
    }else if(state.phase==='publish'){
      state.phase='verify';state.offset=0;state.verificationVersion=ports.report.version();save();
    }
    return {state:state.phase,completed:state.completed,reports:state.catalog.length};
  }finally{ports.lock.releaseLock();}
}
