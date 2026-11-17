import { legacySourceLabelSql } from './legacy-history-source.js';
import { legacySourceDataStartRow } from '../../../packages/domain/src/legacy-history.js';
import { effectiveAdminGrants } from './permission-grants.js';
import { HttpError } from './http-error.js';
import { AS_YEAR_DISPLAY_ORDER } from '../../../packages/domain/src/cadet-display-order.js';
import { buildRetainedHistorySummary, parseRetainedHistorySelections, RETAINED_HISTORY_SUMMARY_VERSION,
  type RetainedHistorySummaryResponse, type RetainedSummaryBin } from '../../../packages/domain/src/retained-history-summary.js';
interface Env { DB: D1Database; ENVIRONMENT: string; GENERATION: string }
const fail = (status: number, code: string): never => { throw new HttpError(status, code, 'The reviewed historical comparison is unavailable.'); };
const label = legacySourceLabelSql(2);
// Match ECMAScript whitespace for captured AS-year labels, including tabs and NBSP.
const whitespace = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
const trimYear = `trim(${label},char(${whitespace.join(',')}))`;
const normalizedYear = `upper(${whitespace.reduce((sql, code) => `replace(${sql},char(${code}),'')`, 'sourceYear')})`;
const asYear = `CASE normalizedAsYear ${AS_YEAR_DISPLAY_ORDER.map(year => `WHEN '${year.toUpperCase().replace(/\s+/g, '')}' THEN '${year}'`).join(' ')} ELSE 'unknown' END`;
/** SQL consumes at most 501 retained rows and emits at most 12 bins; no event/identity payload leaves D1. */
export const retainedHistoryAggregateSql = `WITH saved AS (
 SELECT ${label} AS sourceYear, r.person_id AS personId,
 json_extract(r.payload_json,'$.overall') AS overall,json_type(r.payload_json,'$.overall') AS overallType,
 json_extract(r.payload_json,'$.llab') AS llab,json_type(r.payload_json,'$.llab') AS llabType,
 CASE WHEN o.occurrence_id IS NULL OR length(CAST(r.payload_json AS BLOB))>128000 OR length(${label})>512
   OR json_extract(r.payload_json,'$.occurrenceId') IS NOT r.source_occurrence_id
   OR json_extract(r.payload_json,'$.personId') IS NOT r.person_id
   OR COALESCE(json_type(r.payload_json,'$.personId'),'missing') NOT IN('text','null')
   OR json_type(r.payload_json,'$.identityLabels[2]') IS NOT 'text'
   OR lower(${trimYear}) IS NOT json_extract(r.payload_json,'$.identityLabels[2]')
   OR json_type(o.locator_json,'$.rowIndex') IS NOT 'integer' OR CAST(json_extract(o.locator_json,'$.rowIndex') AS INTEGER)<CASE WHEN json_extract(m.metadata_json,'$.sourceFormat')='predecessor-human-headers-v1' THEN 1 ELSE 2 END THEN 1 ELSE 0 END AS invalidSource
 FROM legacy_matrix_snapshot_rows r JOIN legacy_matrix_snapshots m ON m.matrix_snapshot_id=r.matrix_snapshot_id
 LEFT JOIN legacy_source_occurrences o ON o.import_run_id=m.import_run_id AND o.occurrence_id=r.source_occurrence_id
 WHERE r.matrix_snapshot_id=? ORDER BY r.source_occurrence_id LIMIT 501
), normalized AS (SELECT *,${normalizedYear} AS normalizedAsYear FROM saved), grouped AS (SELECT *,${asYear} AS asYear FROM normalized)
SELECT asYear,COUNT(*) AS rows,SUM(personId IS NULL) AS unresolvedRows,
 COALESCE(SUM(CASE WHEN overallType IN('integer','real') THEN overall END),0) AS overallSum,
 SUM(overallType IN('integer','real')) AS overallCount,
 COALESCE(SUM(CASE WHEN llabType IN('integer','real') THEN llab END),0) AS llabSum,
 SUM(llabType IN('integer','real')) AS llabCount,
 SUM(CASE WHEN invalidSource=1 OR overallType IS NULL OR llabType IS NULL
   OR overallType NOT IN('integer','real','text','true','false','null') OR llabType NOT IN('integer','real','text','true','false','null')
   OR overallType IN('integer','real') AND (overall<0 OR overall>1)
   OR llabType IN('integer','real') AND (llab<0 OR llab>1) THEN 1 ELSE 0 END) AS invalidRows
FROM grouped GROUP BY asYear ORDER BY asYear`;

/** Fresh Wing authority and immutable source selection are checked in the same batch as the aggregates. */
export async function retainedHistorySummary(env: Env, input: unknown): Promise<RetainedHistorySummaryResponse> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'INVALID_HISTORY_REQUEST');
  const req = input as Record<string, unknown>;
  if (Object.keys(req).sort().join(',') !== 'environment,generation,principalId,selections' || typeof req.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(req.principalId)) fail(400, 'INVALID_HISTORY_REQUEST');
  if (req.environment !== env.ENVIRONMENT || req.generation !== Number(env.GENERATION)) fail(409, 'WRONG_GENERATION');
  let selections; try { selections = parseRetainedHistorySelections(req.selections); } catch { return fail(400, 'INVALID_HISTORY_REQUEST'); }
  const statements = [env.DB.prepare(`SELECT (EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?)
    AND EXISTS(SELECT 1 FROM principals p JOIN ${effectiveAdminGrants} g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1
    AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')) AS allowed`).bind(env.ENVIRONMENT, Number(env.GENERATION), req.principalId)];
  for (const selection of selections) statements.push(
    env.DB.prepare(`SELECT i.snapshot_sha256 AS sourceSnapshotSha256,json_extract(m.metadata_json,'$.periodLabel') AS periodLabel,
      json_extract(m.metadata_json,'$.isCurrent') AS isCurrentCapture,m.metadata_json AS metadata,
      (SELECT COUNT(*) FROM legacy_matrix_snapshot_rows r WHERE r.matrix_snapshot_id=m.matrix_snapshot_id) AS rowCount
      FROM legacy_matrix_snapshots m JOIN legacy_import_runs i ON i.import_run_id=m.import_run_id AND i.state='complete'
      WHERE m.matrix_snapshot_id=? AND length(CAST(m.metadata_json AS BLOB))<=64000`).bind(selection.snapshotId),
    env.DB.prepare(retainedHistoryAggregateSql).bind(selection.snapshotId));
  const results = await env.DB.batch<Record<string, unknown>>(statements);
  if (results[0].results[0]?.allowed !== 1) fail(403, 'NOT_AUTHORIZED');
  const summaries = selections.map((selection, i) => {
    const metadata = results[1 + i * 2].results[0];
    if (!metadata) fail(404, 'NOT_FOUND');
    if (metadata.sourceSnapshotSha256 !== selection.sourceSnapshotSha256 || metadata.periodLabel !== selection.expectedPeriodLabel || metadata.isCurrentCapture !== 0) fail(409, 'HISTORY_SELECTION_CHANGED');
    try { legacySourceDataStartRow(JSON.parse(String(metadata.metadata))); return buildRetainedHistorySummary(selection, Number(metadata.rowCount), results[2 + i * 2].results as unknown as RetainedSummaryBin[]); }
    catch { return fail(409, 'INVALID_LEGACY_HISTORY'); }
  });
  const response: RetainedHistorySummaryResponse = { contractVersion: RETAINED_HISTORY_SUMMARY_VERSION, environment: env.ENVIRONMENT as 'local' | 'staging', generation: Number(env.GENERATION), summaries };
  if (new TextEncoder().encode(JSON.stringify(response)).length > 16000) fail(409, 'LEGACY_HISTORY_CAPACITY');
  return response;
}
