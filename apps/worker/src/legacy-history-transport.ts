import { buildLegacyHistoryReport, LegacyHistoryError, type LegacyHistoryInput } from '../../../packages/domain/src/legacy-history.js';
import { HISTORY_PAGE_VERSION,type HistoryPage,type HistoryPageBinding,type HistoryRowsPage } from '../../../packages/domain/src/legacy-history-transport.js';
import { HttpError } from './http-error.js';
interface Env {DB:D1Database;ENVIRONMENT:string;GENERATION:string}
type Value=string|number|null;
const stmt=(db:D1Database,sql:string,...values:Value[])=>db.prepare(sql).bind(...values);
const fail=(status:number,code:string):never=>{throw new HttpError(status,code,'The historical report is unavailable.');};
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
/** Calculate only a bounded page of history, rather than calculating then slicing the entire archive. */
export async function legacyHistoryPage(env:Env,input:unknown):Promise<HistoryPage>{
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'INVALID_HISTORY_REQUEST');const r=input as Record<string,unknown>,keys=['environment','generation','principalId','snapshotId','section','offset','sourceSnapshotSha256'];
  if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||!identifier(r.principalId)||!identifier(r.snapshotId)||!['manifest','rows','roster','verify'].includes(String(r.section))||!Number.isSafeInteger(r.offset)||Number(r.offset)<0||Number(r.offset)>500)fail(400,'INVALID_HISTORY_REQUEST');
  if(r.environment!==env.ENVIRONMENT||r.generation!==Number(env.GENERATION))fail(409,'WRONG_GENERATION');
  if(r.section==='manifest'?r.sourceSnapshotSha256!==null||r.offset!==0:typeof r.sourceSnapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceSnapshotSha256))fail(400,'INVALID_HISTORY_REQUEST');if(r.section==='verify'&&r.offset!==0)fail(400,'INVALID_HISTORY_REQUEST');
  const guard=`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?) AND EXISTS(SELECT 1 FROM principals p JOIN admin_grants g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')`,auth=[env.ENVIRONMENT,Number(env.GENERATION),String(r.principalId)];
  const source=`FROM legacy_matrix_snapshots m JOIN legacy_import_runs i ON i.import_run_id=m.import_run_id AND i.state='complete' WHERE m.matrix_snapshot_id=?`;
  const statements=[stmt(env.DB,`SELECT (${guard}) AS allowed`,...auth),stmt(env.DB,`SELECT m.matrix_snapshot_id AS snapshotId,i.snapshot_sha256 AS sourceSnapshotSha256,i.completed_at AS importedAt,
    CASE WHEN length(CAST(m.metadata_json AS BLOB))<=64000 THEN m.metadata_json END AS metadata,
    json_array_length(m.roster_json) AS rosterCount,(SELECT COUNT(*) FROM legacy_matrix_snapshot_rows r WHERE r.matrix_snapshot_id=m.matrix_snapshot_id) AS rowCount ${source}`,String(r.snapshotId))];
  const label=(index:number)=>`substr(CAST(COALESCE(json_extract(o.raw_json,'$[${index}].effectiveValue.stringValue'),json_extract(o.raw_json,'$[${index}].effectiveValue.numberValue'),json_extract(o.raw_json,'$[${index}].userEnteredValue.stringValue'),json_extract(o.raw_json,'$[${index}].userEnteredValue.numberValue'),'') AS TEXT),1,513)`;
  if(r.section==='rows')statements.push(stmt(env.DB,`SELECT r.source_occurrence_id AS rowId,r.person_id AS personId,CASE WHEN length(CAST(r.payload_json AS BLOB))<=128000 THEN r.payload_json END AS payload,CAST(json_extract(o.locator_json,'$.rowIndex') AS INTEGER) AS sourceRowIndex,json_array(${[0,1,2,3,4].map(label).join(',')}) AS labels FROM legacy_matrix_snapshot_rows r JOIN legacy_matrix_snapshots m ON m.matrix_snapshot_id=r.matrix_snapshot_id JOIN legacy_source_occurrences o ON o.import_run_id=m.import_run_id AND o.occurrence_id=r.source_occurrence_id WHERE r.matrix_snapshot_id=? ORDER BY r.source_occurrence_id LIMIT 5 OFFSET ?`,String(r.snapshotId),Number(r.offset)));
  if(r.section==='roster')statements.push(stmt(env.DB,`SELECT j.value AS payload FROM legacy_matrix_snapshots m,json_each(m.roster_json) j WHERE m.matrix_snapshot_id=? ORDER BY CAST(j.key AS INTEGER) LIMIT 65 OFFSET ?`,String(r.snapshotId),Number(r.offset)));
  const results=await env.DB.batch<Record<string,unknown>>(statements);if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');const meta=results[1].results[0];if(!meta)fail(404,'NOT_FOUND');
  if(typeof meta.metadata!=='string'||Number(meta.rowCount)>500||Number(meta.rosterCount)>500)fail(409,'LEGACY_HISTORY_CAPACITY');if(r.sourceSnapshotSha256!==null&&r.sourceSnapshotSha256!==meta.sourceSnapshotSha256)fail(409,'SNAPSHOT_CHANGED');
  const binding:HistoryPageBinding={contractVersion:HISTORY_PAGE_VERSION,snapshotId:String(meta.snapshotId),sourceSnapshotSha256:String(meta.sourceSnapshotSha256),importedAt:String(meta.importedAt)};
  if(r.section==='verify')return {...binding,section:'verify',verified:true};
  try{
    const base={snapshotId:binding.snapshotId,sourceSnapshotSha256:binding.sourceSnapshotSha256,importedAt:binding.importedAt,metadata:JSON.parse(String(meta.metadata)),sourceRoster:[],rows:[]} as LegacyHistoryInput;
    if(r.section==='manifest'){const {rows,sourceRoster,summary,diagnostics,...report}=buildLegacyHistoryReport(base);return {...binding,section:'manifest',report,rowCount:Number(meta.rowCount),rosterCount:Number(meta.rosterCount)};}
    const sourceRows=results[2].results;
    if(r.section==='roster'){
      const report=buildLegacyHistoryReport({...base,sourceRoster:sourceRows.slice(0,64).map(row=>JSON.parse(String(row.payload)))});const rows:typeof report.sourceRoster=[];let bytes=1000;
      for(const row of report.sourceRoster){const size=new TextEncoder().encode(JSON.stringify(row)).length+1;if(bytes+size>128000){if(!rows.length)fail(409,'LEGACY_HISTORY_CAPACITY');break;}bytes+=size;rows.push(row);}
      if(!rows.length&&Number(r.offset)<Number(meta.rosterCount))fail(409,'INVALID_LEGACY_HISTORY');return {...binding,section:'roster',offset:Number(r.offset),nextOffset:Number(r.offset)+rows.length<Number(meta.rosterCount)?Number(r.offset)+rows.length:null,rows};
    }
    const rows:HistoryRowsPage['rows']=[];let bytes=1000;
    for(const value of sourceRows.slice(0,4)){
      if(typeof value.payload!=='string')fail(409,'LEGACY_HISTORY_CAPACITY');const row=JSON.parse(String(value.payload));if(row.occurrenceId!==value.rowId||row.personId!==value.personId||!Number.isSafeInteger(value.sourceRowIndex)||Number(value.sourceRowIndex)<2)throw new LegacyHistoryError('INVALID_LEGACY_HISTORY');
      const report=buildLegacyHistoryReport({...base,rows:[{row,sourceLabels:JSON.parse(String(value.labels)).map(String)}]}),entry={sourceRowIndex:Number(value.sourceRowIndex),row:report.rows[0],diagnostics:report.diagnostics};
      const size=new TextEncoder().encode(JSON.stringify(entry)).length+1;if(bytes+size>128000){if(!rows.length)fail(409,'LEGACY_HISTORY_CAPACITY');break;}bytes+=size;rows.push(entry);
    }
    if(!rows.length&&Number(r.offset)<Number(meta.rowCount))fail(409,'INVALID_LEGACY_HISTORY');return {...binding,section:'rows',offset:Number(r.offset),nextOffset:Number(r.offset)+rows.length<Number(meta.rowCount)?Number(r.offset)+rows.length:null,rows};
  }catch(error){if(error instanceof HttpError)throw error;return fail(409,error instanceof LegacyHistoryError?error.code:'INVALID_LEGACY_HISTORY');}
}
