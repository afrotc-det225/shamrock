// Offline only. Supply a verified local staging export and a new private directory.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listLegacyHistory, readLegacyHistory } from '../.build/v3/apps/worker/src/legacy-history.js';
import { retainedDirectoryAliases, linkArchiveRows } from './lib/directory-aliases.mjs';
import { compactReport } from '../apps/admin/history-table.mjs';
import { catalogKey, fileKey, hash } from '../apps/admin/hosted/semester-history.mjs';

export function semesterLabel(period) {
  const match = /^(?:(\d{4})[- ](fall|spring|summer)|(fall|spring|summer) (\d{4}))$/i.exec(period || '');
  if (!match) return null;
  const season = (match[2] || match[3]).toLowerCase();
  return (match[1] || match[4]) + ' ' + season[0].toUpperCase() + season.slice(1);
}

export function chooseSemesters(sources) {
  const selected = new Map();
  for (const source of sources.filter(s => s.resource === 'main')) {
    const label = semesterLabel(source.periodLabel);
    if (!label) throw Error('Main workbook contains an unrecognized semester');
    const old = selected.get(label);
    if (old && old.importedAt === source.importedAt) throw Error('Ambiguous semester in main workbook');
    if (!old || old.importedAt < source.importedAt) selected.set(label, source);
  }
  for (const source of sources) {
    const label = semesterLabel(source.periodLabel);
    if (label && !selected.has(label)) throw Error('Semester has no main workbook report');
    if (!label) {
      const matches = new Set(sources.filter(s => s.resource === 'main' && s.layout === source.layout)
        .map(s => semesterLabel(s.periodLabel)));
      if (!source.layout || matches.size !== 1) throw Error('Unlabeled archive requires semester review');
    }
  }
  return [...selected].sort(([a], [b]) => Number(a.slice(0,4)) - Number(b.slice(0,4)) ||
    ['Spring','Summer','Fall'].indexOf(a.slice(5)) - ['Spring','Summer','Fall'].indexOf(b.slice(5)));
}

export async function prepare(dbPath, out) {
  if (!resolve(out).startsWith(resolve('.build') + sep)) throw Error('Write private artifacts under .build');
  const db = new DatabaseSync(dbPath, {readOnly:true});
  try {
    const control = db.prepare('SELECT environment,generation FROM system_control WHERE singleton=1').get();
    if (control?.environment !== 'staging') throw Error('A staging export is required');
    const dbApi = { prepare: sql => ({bind:(...args) => () => ({results:db.prepare(sql).all(...args)})}),
      batch: statements => statements.map(run => run()) };
    const env = {DB:dbApi,ENVIRONMENT:control.environment,GENERATION:String(control.generation)};
    // Use the existing authorized reader to exclude private source/roster fields.
    const { effectiveAdminGrants } = await import('../.build/v3/apps/worker/src/permission-grants.js');
    const reader = db.prepare(`SELECT p.principal_id FROM principals p JOIN ${effectiveAdminGrants} g USING(principal_id)
      WHERE p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*' LIMIT 1`).get();
    if (!reader) throw Error('No authorized Wing reader in staging export');
    const request = {...control,principalId:reader.principal_id};
    const {snapshots} = await listLegacyHistory(env,request);
    const resource = db.prepare('SELECT import_run_id AS importRunId, source_resource_key AS resource, metadata_json AS metadata FROM legacy_matrix_snapshots WHERE matrix_snapshot_id=?');
    const rows = db.prepare("SELECT json_extract(payload_json,'$.identityLabels') AS labels FROM legacy_matrix_snapshot_rows WHERE matrix_snapshot_id=? ORDER BY labels");
    const sources = snapshots.map(s => {
      const {importRunId,resource:kind,metadata} = resource.get(s.snapshotId);
      const layout = hash(JSON.stringify([JSON.parse(metadata).columns.map(c => c.header),
        rows.all(s.snapshotId).map(row => row.labels)]));
      return {...s,importRunId,resource:kind,layout};
    });
    const semesters = [], files = [], aliasesByRun = new Map();
    for (const [label, source] of chooseSemesters(sources)) {
      const report = await readLegacyHistory(env,{...request,snapshotId:source.snapshotId});
      if (report.sourceSnapshotSha256 !== source.sourceSnapshotSha256) throw Error('Report source changed');
      let rows = report.rows;
      if (report.summary.unresolvedRows && report.sourceRoster.length) {
        if (!aliasesByRun.has(source.importRunId)) aliasesByRun.set(source.importRunId, retainedDirectoryAliases(db,source.importRunId));
        rows = linkArchiveRows(report,aliasesByRun.get(source.importRunId));
      }
      const summary = {...report.summary, unresolvedRows:rows.filter(r=>r.identityStatus==='unresolved').length};
      const value = JSON.stringify({semester:label, ...compactReport({...report,rows,summary})});
      const version = hash(value);
      semesters.push({label,version});
      files.push({key:fileKey(version),value});
    }
    if (!semesters.length && snapshots.length) throw Error('No reviewed semester reports');
    mkdirSync(out,{mode:0o700});
    const save = (name,data) => writeFileSync(join(out,name),JSON.stringify(data),{mode:0o600,flag:'wx'});
    save('files.private.json',files);
    save('catalog.private.json',[{key:catalogKey(control.generation,snapshots),value:JSON.stringify({semesters})}]);
    console.log(JSON.stringify(semesters.map(({label},i) => ({label,rows:JSON.parse(files[i].value).rows.length,
      columns:JSON.parse(files[i].value).headers.length,bytes:Buffer.byteLength(files[i].value)}))));
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepare(process.argv[2], process.argv[3]);
