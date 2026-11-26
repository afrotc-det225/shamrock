import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationSources, createMigrationPlan, createFreshDatabaseBatch } from '../../scripts/lib/v3-migrations.mjs';
import { backupHash } from '../../scripts/lib/staging-backup.mjs';
import { importDigest } from '../../scripts/lib/import-capture.mjs';
import { createIncrementalImportPlan } from '../../scripts/lib/import-refresh.mjs';
import { rehearseIncrementalImportFaults, applyRefreshRehearsalStatements } from '../../scripts/lib/import-refresh-rehearsal.mjs';

const commit = 'a'.repeat(40), at = '2026-11-17T00:00:00.000Z';
const migrations = createMigrationPlan(await readMigrationSources(new URL('../../database/migrations/', import.meta.url)), commit, 1);
function dump(db) {
    const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const sql = ['PRAGMA defer_foreign_keys=ON', ...tables.map(t => t.sql)];
    for (const table of [...tables, { name: 'sqlite_sequence' }]) {
        const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all();
        if (!columns.length) continue;
        if (table.name === 'sqlite_sequence') sql.push('DELETE FROM sqlite_sequence');
        const packed = columns.map(c => `CASE typeof("${c.name}") WHEN 'text' THEN 'CAST(X'''||hex("${c.name}")||''' AS TEXT)' WHEN 'blob' THEN 'X'''||hex("${c.name}")||'''' ELSE quote("${c.name}") END`).join("||','||");
        for (const row of db.prepare(`SELECT ${packed} AS row FROM "${table.name}"`).all()) sql.push(`INSERT INTO "${table.name}" VALUES(${row.row})`);
    }
    sql.push(...db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.sql));
    return sql.join(';\n') + ';\n';
}
function fixture() {
    const db = new DatabaseSync(':memory:');
    try {
        for (const s of createFreshDatabaseBatch(migrations).batch) db.prepare(s.sql).run(...s.params ?? []);
        db.exec("INSERT INTO people VALUES('p','Fictional Cadet');INSERT INTO events VALUES('e','Fictional LLAB',1);INSERT INTO principals VALUES('service:legacy-import',NULL,0)");
        const insert = (table, row) => { const columns = Object.keys(row); db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(row)); };
        insert('legacy_import_runs', { import_run_id: 'old', snapshot_sha256: 'a'.repeat(64), plan_sha256: 'b'.repeat(64), reconciliation_sha256: 'c'.repeat(64), review_reference: 'fictional-old', environment: 'staging', generation: 1, state: 'complete', expected_occurrences: 1, expected_profiles: 1, expected_events: 1, expected_baselines: 1, expected_batches: 1, manifest_json: '{}', started_at: at, completed_at: at });
        const oldSource = { import_run_id: 'old', occurrence_id: 'source', fingerprint: 'd'.repeat(64), source_kind: 'matrix', disposition: 'evidence-only', locator_json: '{}', raw_json: '["A"]', normalized_json: null, diagnostics_json: '{}' };
        insert('legacy_source_occurrences', oldSource);
        const old = { baseline_id: 'stable-baseline', person_id: 'p', event_id: 'e', code: 'A', import_run_id: 'old', source_occurrence_id: 'source', source_column_index: 7 };
        insert('legacy_attendance_baselines', old);
        const sourceSql = dump(db), rows = ['source', 'extra'].map(occurrence_id => ({ ...oldSource, import_run_id: 'new', occurrence_id, fingerprint: 'e'.repeat(64), raw_json: '["P"]' }));
        // Separate evidence groups exercise persisted resume after more than one batch.
        const refresh = createIncrementalImportPlan({
            before: { permission_policy_control: db.prepare('SELECT * FROM permission_policy_control').all(), shamrock_migrations: db.prepare('SELECT * FROM shamrock_migrations ORDER BY version').all(), legacy_attendance_baselines: [old] },
            desired: { legacy_attendance_baselines: [{ ...old, code: 'P', import_run_id: 'new' }] },
            evidence: { run: { import_run_id: 'new', snapshot_sha256: 'f'.repeat(64), reconciliation_sha256: 'a'.repeat(64), expected_occurrences: 2, expected_profiles: 1, expected_events: 1, expected_baselines: 1 }, groups: rows.map(r => ({ table: 'legacy_source_occurrences', columns: Object.keys(r), rows: [Object.values(r)] })) },
            context: { environment: 'staging', generation: 1, schemaVersion: 17, backupSha256: backupHash(sourceSql), sourceCommit: commit, administrationRevision: 0, importedAt: at },
            review: { reviewReference: 'fictional-reviewed-refresh', preserveCanonicalKeys: true, preserveOriginalEvidence: true, suppressNotifications: true, sourceSnapshots: [{ snapshotSha256: 'f'.repeat(64), consistent: true }] },
        });
        return { sourceSql, refresh };
    } finally { db.close(); }
}

test('SIGKILL at every SQL boundary preserves all committed rows/sequences and durable resume checkpoints', async () => {
    const { sourceSql, refresh } = fixture(), progress = [];
    const proof = await rehearseIncrementalImportFaults(sourceSql, refresh, migrations, { progress: p => progress.push(p) });
    assert.equal(proof.verified, true);
    assert.equal(proof.interruptedTransactions, refresh.initialize.length + refresh.steps.reduce((n, s) => n + s.batch.length, 0) + refresh.finish.length);
    assert.equal(proof.evidenceBatches, 2);
    assert.equal(proof.replayedBatches, 4);
    assert.equal(proof.refreshAuditRows, 1);
    assert.equal(proof.finalRowsVerified, 3);
    assert.equal(proof.allRollbackTablesAndSequencesVerified, true);
    assert.equal(proof.providerCalls, 0);
    assert.deepEqual(progress.map(p => p.stage), ['initialize', 'evidence', 'evidence', 'finish']);
});

test('altered source, execution plan or staging binding cannot start a rehearsal', async () => {
    const { sourceSql, refresh } = fixture();
    await assert.rejects(rehearseIncrementalImportFaults(sourceSql + '\n', refresh, migrations), /REFRESH_REHEARSAL_BACKUP_HASH/);
    const changed = structuredClone(refresh); changed.finish[0].params[0] = 'changed';
    await assert.rejects(rehearseIncrementalImportFaults(sourceSql, changed, migrations), /REFRESH_REHEARSAL_EXECUTION_HASH/);
    const { executionSha256, ...body } = refresh, production = { ...body, environment: 'production' };
    await assert.rejects(rehearseIncrementalImportFaults(sourceSql, { ...production, executionSha256: importDigest(production) }, migrations), /REFRESH_REHEARSAL_PLAN/);
});

test('rehearsal execution cannot attach files, change schema/gates, run PRAGMAs or load extensions', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec("CREATE TABLE legacy_import_assertions(assertion_id TEXT PRIMARY KEY,ok INTEGER);CREATE TABLE system_control(accepting_commands INTEGER);INSERT INTO system_control VALUES(0)");
        for (const sql of ["ATTACH '/tmp/shamrock-forbidden' AS escaped", 'PRAGMA writable_schema=ON', 'CREATE TABLE surprise(x)', 'DELETE FROM legacy_import_assertions', 'UPDATE system_control SET accepting_commands=1', "INSERT INTO legacy_import_assertions VALUES('x',load_extension('forbidden'))", "INSERT INTO legacy_import_assertions VALUES('x',1);DROP TABLE system_control"])
            assert.throws(() => applyRefreshRehearsalStatements(db, [{ sql, params: [] }]));
        assert.equal(db.prepare('SELECT accepting_commands FROM system_control').get().accepting_commands, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_import_assertions').get().n, 0);
    } finally { db.close(); }
});
