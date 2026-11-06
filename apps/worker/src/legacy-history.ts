import { buildLegacyHistoryReport, LegacyHistoryError, type LegacyHistoryInput, type LegacyHistoryReport } from '../../../packages/domain/src/legacy-history.js';
import { HttpError } from './http-error.js';
interface Env { DB:D1Database;ENVIRONMENT:string;GENERATION:string }
type Value=string|number|null;
const stmt=(db:D1Database,sql:string,...values:Value[])=>db.prepare(sql).bind(...values);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const fail=(status:number,code:string):never=>{throw new HttpError(status,code,'The historical report is unavailable.');};
function request(env:Env,input:unknown,read:boolean){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'INVALID_HISTORY_REQUEST');const r=input as Record<string,unknown>;
  const fields=['environment','generation','principalId',...(read?['snapshotId']:[])];
  if(Object.keys(r).length!==fields.length||Object.keys(r).some(k=>!fields.includes(k))||!identifier(r.principalId)||(read&&!identifier(r.snapshotId)))fail(400,'INVALID_HISTORY_REQUEST');
  if(r.environment!==env.ENVIRONMENT||r.generation!==Number(env.GENERATION))fail(409,'WRONG_GENERATION');
  return {principalId:r.principalId as string,snapshotId:r.snapshotId as string};
}
function guard(env:Env,principalId:string){return {sql:`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?)
  AND EXISTS(SELECT 1 FROM principals p JOIN admin_grants g ON g.principal_id=p.principal_id
  WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')`,params:[env.ENVIRONMENT,Number(env.GENERATION),principalId] as Value[]};}
/** Lists source copies separately; a reused term label cannot merge different archived formulas. */
export async function listLegacyHistory(env:Env,input:unknown):Promise<unknown>{
  const req=request(env,input,false),g=guard(env,req.principalId);
  const results=await env.DB.batch<Record<string,unknown>>([
    stmt(env.DB,`SELECT (${g.sql}) AS allowed`,...g.params),
    stmt(env.DB,`SELECT m.matrix_snapshot_id AS snapshotId,json_extract(m.metadata_json,'$.sourceTitle') AS title,
      json_extract(m.metadata_json,'$.periodLabel') AS periodLabel,json_extract(m.metadata_json,'$.isCurrent') AS isCurrentCapture,
      json_extract(m.metadata_json,'$.authority') AS authority,json_array_length(m.metadata_json,'$.columns') AS eventCount,
      (SELECT COUNT(*) FROM legacy_matrix_snapshot_rows r WHERE r.matrix_snapshot_id=m.matrix_snapshot_id) AS rowCount,
      (SELECT COUNT(*) FROM legacy_matrix_snapshot_rows r WHERE r.matrix_snapshot_id=m.matrix_snapshot_id AND r.person_id IS NULL) AS unresolvedRows,
      i.snapshot_sha256 AS sourceSnapshotSha256,i.completed_at AS importedAt
      FROM legacy_matrix_snapshots m JOIN legacy_import_runs i ON i.import_run_id=m.import_run_id AND i.state='complete'
      WHERE (${g.sql}) ORDER BY m.matrix_snapshot_id LIMIT 101`,...g.params),
  ]);
  if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');
  if(results[1].results.length>100)fail(409,'LEGACY_HISTORY_CAPACITY');
  return {contractVersion:'legacy-source-report-v1',readOnly:true,snapshots:results[1].results.map(row=>({...row,isCurrentCapture:row.isCurrentCapture===1}))};
}
/** One authorized, bounded D1 snapshot; no raw Form responses, emails, phone numbers or Drive identifiers are exposed. */
export async function readLegacyHistory(env:Env,input:unknown):Promise<LegacyHistoryReport>{
  const req=request(env,input,true),g=guard(env,req.principalId);
  const source=`FROM legacy_matrix_snapshots m JOIN legacy_import_runs i ON i.import_run_id=m.import_run_id AND i.state='complete' WHERE m.matrix_snapshot_id=? AND (${g.sql})`;
  const rowsBound=`(SELECT COUNT(*) FROM legacy_matrix_snapshot_rows b WHERE b.matrix_snapshot_id=m.matrix_snapshot_id)<=500
    AND (SELECT COALESCE(SUM(length(CAST(b.payload_json AS BLOB))),0) FROM legacy_matrix_snapshot_rows b WHERE b.matrix_snapshot_id=m.matrix_snapshot_id)<=4000000`;
  // Captured matrix identity occupies the five fixed columns; domain validation checks every label against the retained tuple.
  const label=(index:number)=>`substr(CAST(COALESCE(json_extract(o.raw_json,'$[${index}].effectiveValue.stringValue'),json_extract(o.raw_json,'$[${index}].effectiveValue.numberValue'),json_extract(o.raw_json,'$[${index}].userEnteredValue.stringValue'),json_extract(o.raw_json,'$[${index}].userEnteredValue.numberValue'),'') AS TEXT),1,513)`;
  const results=await env.DB.batch<Record<string,unknown>>([
    stmt(env.DB,`SELECT (${g.sql}) AS allowed`,...g.params),
    stmt(env.DB,`SELECT m.matrix_snapshot_id AS snapshotId,i.snapshot_sha256 AS sourceSnapshotSha256,i.completed_at AS importedAt,
      CASE WHEN length(CAST(m.metadata_json AS BLOB))<=256000 THEN m.metadata_json END AS metadata,
      CASE WHEN length(CAST(m.roster_json AS BLOB))<=1000000 THEN m.roster_json END AS roster,
      (SELECT COUNT(*) FROM legacy_matrix_snapshot_rows r WHERE r.matrix_snapshot_id=m.matrix_snapshot_id) AS rowCount,
      (${rowsBound}) AS withinBound ${source}`,req.snapshotId,...g.params),
    stmt(env.DB,`SELECT r.source_occurrence_id AS rowId,r.person_id AS personId,r.payload_json AS payload,
      json_array(${[0,1,2,3,4].map(label).join(',')}) AS labels
      FROM legacy_matrix_snapshot_rows r JOIN legacy_matrix_snapshots m ON m.matrix_snapshot_id=r.matrix_snapshot_id
      JOIN legacy_import_runs i ON i.import_run_id=m.import_run_id AND i.state='complete'
      JOIN legacy_source_occurrences o ON o.import_run_id=m.import_run_id AND o.occurrence_id=r.source_occurrence_id
      WHERE m.matrix_snapshot_id=? AND (${g.sql}) AND ${rowsBound}
      ORDER BY CAST(json_extract(o.locator_json,'$.rowIndex') AS INTEGER),r.source_occurrence_id LIMIT 501`,req.snapshotId,...g.params),
  ]);
  if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');const metadata=results[1].results[0];if(!metadata)fail(404,'NOT_FOUND');
  if(metadata.withinBound!==1||typeof metadata.metadata!=='string'||typeof metadata.roster!=='string'||metadata.rowCount!==results[2].results.length)fail(409,'LEGACY_HISTORY_CAPACITY');
  try{
    const rows=results[2].results.map(value=>{const row=JSON.parse(String(value.payload));if(row.occurrenceId!==value.rowId||row.personId!==value.personId)throw new LegacyHistoryError('INVALID_LEGACY_HISTORY');return {row,sourceLabels:JSON.parse(String(value.labels)).map((label:unknown)=>String(label))};});
    const report=buildLegacyHistoryReport({snapshotId:metadata.snapshotId,sourceSnapshotSha256:metadata.sourceSnapshotSha256,importedAt:metadata.importedAt,metadata:JSON.parse(String(metadata.metadata)),sourceRoster:JSON.parse(String(metadata.roster)),rows} as LegacyHistoryInput);
    if(new TextEncoder().encode(JSON.stringify(report)).length>5000000)fail(409,'LEGACY_HISTORY_CAPACITY');return report;
  }catch(error){if(error instanceof HttpError)throw error;return fail(409,error instanceof LegacyHistoryError?error.code:'INVALID_LEGACY_HISTORY');}
}
