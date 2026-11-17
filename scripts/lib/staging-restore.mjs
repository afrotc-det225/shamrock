/** Offline planning only. Never executes provider requests or resets hosted data. */
import { createHash } from 'node:crypto';
import { backupHash, backupObjectHash, restoreBackupSql, readBackupEvidence, fingerprintBackupTables } from './staging-backup.mjs';
const check = (ok, code) => {
    if (!ok)
        throw Error(code);
};
const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const guard = 'shamrock_restore_guard';
const identifier = name => {
    check(/^[a-z][a-z0-9_]*$/.test(name), 'RESTORE_IDENTIFIER');
    return '"' + name + '"';
};
export async function inspectNativeExport(sql, plan) {
    const db = restoreBackupSql(sql, plan);
    try {
        const query = async (sql, params = []) => db.prepare(sql).all(...params), evidence = await readBackupEvidence(query, plan), tables = await fingerprintBackupTables(query, evidence);
        const dependencies = Object.fromEntries(tables.filter(t => t.table !== 'sqlite_sequence').map(t => [t.table, db.prepare('PRAGMA foreign_key_list(' + identifier(t.table) + ')').all().map(r => r.table)]));
        return { sqlSha256: backupHash(sql), sqlBytes: Buffer.byteLength(sql), schemaVersion: evidence.ledger.length, evidence, tables, dependencies, tableInventorySha256: backupObjectHash(tables), proofKind: 'local-inspection-of-native-export' };
    }
    finally {
        db.close();
    }
}
export async function compareNativeExports(sourceSql, restoredSql, plan) {
    const source = await inspectNativeExport(sourceSql, plan), restored = await inspectNativeExport(restoredSql, plan);
    check(source.evidence.evidenceSha256 === restored.evidence.evidenceSha256 && source.tableInventorySha256 === restored.tableInventorySha256, 'RESTORE_CONTENT_MISMATCH');
    return { formatVersion: 1, environment: 'staging', generation: plan.generation, proofKind: 'exact-comparison-of-supplied-native-exports', schemaVersion: source.schemaVersion, sourceSqlSha256: source.sqlSha256, restoredSqlSha256: restored.sqlSha256, tables: source.tables.length, rows: source.tables.reduce((n, t) => n + t.rows, 0), integrity: 'ok', foreignKeys: 0, acceptingCommands: 0, tableInventorySha256: source.tableInventorySha256 };
}
function validateRoute(e, source, target, now) {
    check(e?.formatVersion === 1 && e.environment === 'staging' && e.disposableTarget === true && /^[a-f0-9]{32}$/.test(e.accountId) && Number.isSafeInteger(e.generation) && e.generation > 0, 'RESTORE_ROUTE');
    check(Date.parse(e.observedAt) <= now && now - Date.parse(e.observedAt) < 15 * 60000, 'RESTORE_STALE_ROUTE');
    check(id.test(e.source?.uuid) && id.test(e.target?.uuid) && e.source.uuid !== e.target.uuid && typeof e.source.name === 'string' && /^shamrock-[a-z0-9-]*restore[a-z0-9-]*$/.test(e.target.name), 'RESTORE_TARGET');
    check(e.sourceSqlSha256 === source.sqlSha256 && e.targetSqlSha256 === target.sqlSha256, 'RESTORE_EXPORT_BINDING');
    check(e.sourceEvidenceSha256 === source.evidence.evidenceSha256 && e.targetEvidenceSha256 === target.evidence.evidenceSha256, 'RESTORE_EVIDENCE_BINDING');
    check(e.inventoryComplete === true && Array.isArray(e.workerBindings) && Array.isArray(e.pagesBindings), 'RESTORE_BINDING_INVENTORY');
    check([...e.workerBindings, ...e.pagesBindings].every(b => typeof b.name === 'string' && Array.isArray(b.databaseIds) && b.databaseIds.every(value => id.test(value)) && !b.databaseIds.includes(e.target.uuid)), 'RESTORE_TARGET_BOUND');
}
function dropOrder(dependencies) {
    const remaining = new Set(Object.keys(dependencies)), order = [];
    while (remaining.size) {
        const next = [...remaining].sort().find(name => ![...remaining].some(other => other !== name && dependencies[other].includes(name)));
        check(next, 'RESTORE_DEPENDENCY_CYCLE');
        remaining.delete(next);
        order.push(next);
    }
    return order;
}
function resetBatch(target, generation) {
    const objects = target.evidence.inventory, ledger = target.evidence.ledger;
    const assert = (n, condition, params = []) => ({ sql: `INSERT INTO ${guard} SELECT ${n},CASE WHEN ${condition} THEN 1 ELSE 0 END`, params });
    return [
        { sql: `CREATE TABLE ${guard}(check_id INTEGER PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))` },
        assert(1, "(SELECT COUNT(*) FROM system_control)=1 AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=0)", [generation]),
        assert(2, `(SELECT COUNT(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA','${guard}'))=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema actual WHERE actual.name=json_extract(expected.value,'$.name') AND actual.type=json_extract(expected.value,'$.type') AND actual.sql=json_extract(expected.value,'$.sql')))`, [JSON.stringify(objects), JSON.stringify(objects)]),
        assert(3, "(SELECT COUNT(*) FROM shamrock_migrations)=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM shamrock_migrations actual WHERE actual.version=json_extract(expected.value,'$.version') AND actual.name=json_extract(expected.value,'$.name') AND actual.sha256=json_extract(expected.value,'$.sha256') AND actual.source_commit=json_extract(expected.value,'$.source_commit') AND actual.environment=json_extract(expected.value,'$.environment') AND actual.applied_at=json_extract(expected.value,'$.applied_at')))", [JSON.stringify(ledger), JSON.stringify(ledger)]),
        ...target.tables.map((t, n) => assert(n + 4, `(SELECT COUNT(*) FROM ${identifier(t.table)})=?`, [t.rows])),
        ...dropOrder(target.dependencies).map(name => ({ sql: `DROP TABLE ${identifier(name)}` })),
        { sql: `DROP TABLE ${guard}` }
    ];
}
/** Guard identity and current binding inventory again immediately before the one reset batch. */
function resetPluginCode(route, batch, version) {
    const data = { observedAt: route.observedAt, generation: route.generation, sourceVersion: version, accountId: route.accountId, source: route.source, target: route.target, workerNames: route.workerBindings.map(b => b.name).sort(), pagesNames: route.pagesBindings.map(b => b.name).sort(), batch };
    return `async () => {
 const plan=${JSON.stringify(data)};
 const must=(ok,message)=>{if(!ok)throw Error(message)};
 must(accountId===plan.accountId,'RESTORE_WRONG_ACCOUNT');
 must(Date.now()>=Date.parse(plan.observedAt)&&Date.now()-Date.parse(plan.observedAt)<15*60000,'RESTORE_STALE_ROUTE');
 const path='/accounts/'+accountId;
 const source=await cloudflare.request({method:'GET',path:path+'/d1/database/'+plan.source.uuid});
 const target=await cloudflare.request({method:'GET',path:path+'/d1/database/'+plan.target.uuid});
 must(source.result.uuid===plan.source.uuid&&source.result.name===plan.source.name&&target.result.uuid===plan.target.uuid&&target.result.name===plan.target.name&&target.result.uuid!==source.result.uuid,'RESTORE_WRONG_TARGET');
 const sourceGate=await cloudflare.request({method:'POST',path:path+'/d1/database/'+plan.source.uuid+'/query',body:{sql:'SELECT environment,generation,accepting_commands,(SELECT COUNT(*) FROM shamrock_migrations) AS version FROM system_control'}});
 must(sourceGate.result.length===1&&sourceGate.result[0].results.length===1&&sourceGate.result[0].results[0].environment==='staging'&&sourceGate.result[0].results[0].generation===plan.generation&&sourceGate.result[0].results[0].accepting_commands===0&&sourceGate.result[0].results[0].version===plan.sourceVersion,'RESTORE_SOURCE_CHANGED');
 const workers=await cloudflare.request({method:'GET',path:path+'/workers/scripts'});
 must(!workers.result_info?.total_pages||workers.result_info.total_pages<=1,'RESTORE_WORKER_PAGINATION');
 must(JSON.stringify(workers.result.map(w=>w.id).sort())===JSON.stringify(plan.workerNames),'RESTORE_BINDINGS_CHANGED');
 for(const worker of workers.result){const settings=await cloudflare.request({method:'GET',path:path+'/workers/scripts/'+encodeURIComponent(worker.id)+'/settings'});must(settings.result.bindings.every(b=>b.type!=='d1'||(b.id!==plan.target.uuid&&b.database_id!==plan.target.uuid)),'RESTORE_TARGET_BOUND');}
 const pages=await cloudflare.request({method:'GET',path:path+'/pages/projects'});
 must(!pages.result_info?.total_pages||pages.result_info.total_pages<=1,'RESTORE_PAGES_PAGINATION');
 must(JSON.stringify(pages.result.map(p=>p.name).sort())===JSON.stringify(plan.pagesNames),'RESTORE_BINDINGS_CHANGED');
 for(const page of pages.result){const detail=await cloudflare.request({method:'GET',path:path+'/pages/projects/'+encodeURIComponent(page.name)});must(detail.result.deployment_configs,'RESTORE_PAGES_UNKNOWN');for(const deployment of ['production','preview'])must(Object.values(detail.result.deployment_configs[deployment]?.d1_databases??{}).every(b=>b.id!==plan.target.uuid&&b.database_id!==plan.target.uuid),'RESTORE_TARGET_BOUND');}
 const result=await cloudflare.request({method:'POST',path:path+'/d1/database/'+plan.target.uuid+'/query',body:{batch:plan.batch}});
 must(result.success===true&&result.result.every(r=>r.success!==false),'RESTORE_RESET_FAILED');
 return {stage:'isolated-target-reset',statements:result.result.length,rowsRead:result.result.reduce((n,r)=>n+(r.meta?.rows_read??0),0),rowsWritten:result.result.reduce((n,r)=>n+(r.meta?.rows_written??0),0)};
}`;
}
export async function prepareHostedRestore(sourceSql, targetSql, route, plan, { now = Date.now() } = {}) {
    const source = await inspectNativeExport(sourceSql, plan), target = await inspectNativeExport(targetSql, plan);
    validateRoute(route, source, target, now);
    check(route.generation === plan.generation && source.schemaVersion === plan.version, 'RESTORE_SOURCE_VERSION');
    const batch = resetBatch(target, plan.generation);
    check(batch.length <= 220 && Buffer.byteLength(JSON.stringify(batch)) <= 512 * 1024, 'RESTORE_RESET_BOUND');
    const prefix = `CREATE TABLE ${guard}(check_id INTEGER PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));\nINSERT INTO ${guard} SELECT 1,CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA','${guard}')) THEN 1 ELSE 0 END;\nDROP TABLE ${guard};\n`;
    const importSql = prefix + sourceSql, manifest = { formatVersion: 1, environment: 'staging', generation: plan.generation, sourceCommit: plan.sourceCommit, sourceSchemaVersion: source.schemaVersion, targetPreviousSchemaVersion: target.schemaVersion, sourceSqlSha256: source.sqlSha256, targetSqlSha256: target.sqlSha256, sourceTableInventorySha256: source.tableInventorySha256, routeSha256: backupObjectHash(route), importSqlSha256: backupHash(importSql), importMd5: createHash('md5').update(importSql).digest('hex'), importBytes: Buffer.byteLength(importSql), resetStatements: batch.length, operatorMustReview: true };
    return { manifest, planSha256: backupObjectHash(manifest), importSql, resetBatch: batch, resetPluginCode: resetPluginCode(route, batch, plan.version), source, target };
}
