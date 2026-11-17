import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationSources, createMigrationPlan, createFreshDatabaseBatch } from '../../scripts/lib/v3-migrations.mjs';
import { inspectNativeExport, compareNativeExports, prepareHostedRestore } from '../../scripts/lib/staging-restore.mjs';
const sources = await readMigrationSources(new URL('../../database/migrations/', import.meta.url)), commit = 'a'.repeat(40), plan = createMigrationPlan(sources, commit, 1);
function fixture(version = sources.length) {
    const db = new DatabaseSync(':memory:');
    for (const q of createFreshDatabaseBatch(createMigrationPlan(sources.slice(0, version), commit, 1)).batch)
        db.prepare(q.sql).run(...q.params ?? []);
    db.prepare('INSERT INTO people VALUES(?,?)').run('fictional', 'Fictional Record');
    return db;
}
function dump(db) {
    const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), out = ['PRAGMA defer_foreign_keys=ON', ...schema.map(t => t.sql)];
    for (const table of [...schema, { name: 'sqlite_sequence' }]) {
        const columns = db.prepare('PRAGMA table_info("' + table.name + '")').all();
        if (!columns.length)
            continue;
        if (table.name === 'sqlite_sequence')
            out.push('DELETE FROM sqlite_sequence');
        const expr = columns.map(c => `CASE typeof("${c.name}") WHEN 'text' THEN 'CAST(X'''||hex("${c.name}")||''' AS TEXT)' WHEN 'blob' THEN 'X'''||hex("${c.name}")||'''' ELSE quote("${c.name}") END`).join(`||','||`);
        for (const row of db.prepare(`SELECT ${expr} AS row FROM "${table.name}"`).all())
            out.push(`INSERT INTO "${table.name}" VALUES(${row.row})`);
    }
    out.push(...db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.sql));
    return out.join(';\n') + ';\n';
}
async function scenario() {
    const source = fixture(), target = fixture(5), sourceSql = dump(source), targetSql = dump(target), s = await inspectNativeExport(sourceSql, plan), t = await inspectNativeExport(targetSql, plan);
    const route = { formatVersion: 1, environment: 'staging', generation: 1, observedAt: new Date().toISOString(), disposableTarget: true, accountId: 'b'.repeat(32), source: { uuid: '00000000-0000-4000-8000-000000000001', name: 'shamrock-staging' }, target: { uuid: '00000000-0000-4000-8000-000000000002', name: 'shamrock-staging-restore-fixture' }, sourceSqlSha256: s.sqlSha256, targetSqlSha256: t.sqlSha256, sourceEvidenceSha256: s.evidence.evidenceSha256, targetEvidenceSha256: t.evidence.evidenceSha256, inventoryComplete: true, workerBindings: [{ name: 'fixture', databaseIds: ['00000000-0000-4000-8000-000000000001'] }], pagesBindings: [] };
    return { source, target, sourceSql, targetSql, route };
}
function applyBatch(db, batch) {
    db.exec('BEGIN');
    try {
        for (const q of batch)
            db.prepare(q.sql).run(...q.params ?? []);
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
test('offline plan resets only the reviewed schema and native import restores exact latest tables, rows and gates', async (t) => {
    const s = await scenario();
    t.after(() => {
        s.source.close();
        s.target.close();
    });
    const prepared = await prepareHostedRestore(s.sourceSql, s.targetSql, s.route, plan);
    assert.equal(prepared.manifest.targetPreviousSchemaVersion, 5);
    assert.equal(prepared.manifest.sourceSchemaVersion, sources.length);
    s.target.exec('PRAGMA foreign_keys=ON');
    applyBatch(s.target, prepared.resetBatch);
    assert.equal(s.target.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n, 0);
    s.target.exec('BEGIN');
    s.target.exec(prepared.importSql);
    s.target.exec('COMMIT');
    const comparison = await compareNativeExports(s.sourceSql, dump(s.target), plan);
    assert.equal(comparison.acceptingCommands, 0);
    assert.equal(comparison.foreignKeys, 0);
    assert.equal(comparison.schemaVersion, sources.length);
    s.target.prepare("UPDATE people SET display_name='Changed'").run();
    await assert.rejects(compareNativeExports(s.sourceSql, dump(s.target), plan), /RESTORE_CONTENT_MISMATCH/);
});
test('wrong or bound targets, stale route inventory and altered backup evidence cannot produce a reset plan', async (t) => {
    const s = await scenario();
    t.after(() => {
        s.source.close();
        s.target.close();
    });
    for (const route of [{ ...s.route, target: s.route.source }, { ...s.route, disposableTarget: false }, { ...s.route, observedAt: new Date(Date.now() - 16 * 60000).toISOString() }, { ...s.route, targetEvidenceSha256: '0'.repeat(64) }, { ...s.route, workerBindings: [{ name: 'unexpected', databaseIds: [s.route.target.uuid] }] }, { ...s.route, inventoryComplete: false }])
        await assert.rejects(prepareHostedRestore(s.sourceSql, s.targetSql, route, plan));
});
test('atomic reset rejects changes to target control, schema, ledger or table counts without removing prior records', async (t) => {
    const s = await scenario();
    t.after(() => {
        s.source.close();
        s.target.close();
    });
    const prepared = await prepareHostedRestore(s.sourceSql, s.targetSql, s.route, plan);
    for (const change of ["UPDATE system_control SET accepting_commands=1", "CREATE TABLE surprise(x TEXT)", "UPDATE shamrock_migrations SET source_commit='other' WHERE version=1", "INSERT INTO people VALUES('new','Fictional Other')"]) {
        const target = fixture(5);
        try {
            target.exec(change);
            const before = target.prepare('SELECT COUNT(*) n FROM people').get().n;
            assert.throws(() => applyBatch(target, prepared.resetBatch));
            assert.equal(target.prepare('SELECT COUNT(*) n FROM people').get().n, before);
            assert.equal(target.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='shamrock_restore_guard'").get().n, 0);
        }
        finally {
            target.close();
        }
    }
});
test('native import starts with an emptiness guard and generated plugin code rejects wrong account before a request', async (t) => {
    const s = await scenario();
    t.after(() => {
        s.source.close();
        s.target.close();
    });
    const prepared = await prepareHostedRestore(s.sourceSql, s.targetSql, s.route, plan);
    assert.throws(() => s.target.exec(prepared.importSql), /CHECK constraint failed/);
    assert.equal(s.target.prepare('SELECT COUNT(*) n FROM people').get().n, 1);
    let calls = 0;
    const run = new Function('accountId', 'cloudflare', 'return (' + prepared.resetPluginCode + ')()');
    await assert.rejects(run('wrong', { request: async () => {
            calls++;
        } }), /RESTORE_WRONG_ACCOUNT/);
    assert.equal(calls, 0);
});

test('generated reset action rechecks hosted identity and live Worker bindings before its only write',async t=>{
 const s=await scenario();t.after(()=>{s.source.close();s.target.close();});const prepared=await prepareHostedRestore(s.sourceSql,s.targetSql,s.route,plan),run=new Function('accountId','cloudflare','return ('+prepared.resetPluginCode+')()');
 for(const mode of ['wrong-name','new-worker','new-target-binding','source-resumed','valid']){
  let writes=0;
  const api={request:async request=>{
   if(request.method==='GET'&&request.path.endsWith('/d1/database/'+s.route.source.uuid))return {result:s.route.source};
   if(request.method==='GET'&&request.path.endsWith('/d1/database/'+s.route.target.uuid))return {result:{...s.route.target,...(mode==='wrong-name'?{name:'operational'}:{})}};
   if(request.path.endsWith('/d1/database/'+s.route.source.uuid+'/query'))return {result:[{results:[{environment:'staging',generation:1,accepting_commands:mode==='source-resumed'?1:0,version:sources.length}]}]};
   if(request.path.endsWith('/workers/scripts'))return {result:mode==='new-worker'?[{id:'fixture'},{id:'new'}]:[{id:'fixture'}]};
   if(request.path.endsWith('/workers/scripts/fixture/settings'))return {result:{bindings:[{type:'d1',id:mode==='new-target-binding'?s.route.target.uuid:s.route.source.uuid}]}};
   if(request.path.endsWith('/pages/projects'))return {result:[]};
   assert.equal(request.path.endsWith('/d1/database/'+s.route.target.uuid+'/query'),true);assert.equal(request.method,'POST');writes++;assert.deepEqual(request.body.batch,prepared.resetBatch);return {success:true,result:prepared.resetBatch.map(()=>({success:true,meta:{rows_read:0,rows_written:0}}))};
  }};
  if(mode==='valid'){await run(s.route.accountId,api);assert.equal(writes,1);}else{await assert.rejects(run(s.route.accountId,api),/RESTORE_(WRONG_TARGET|BINDINGS_CHANGED|TARGET_BOUND|SOURCE_CHANGED)/);assert.equal(writes,0);}
 }
});
