/** Offline process-interruption proof for an immutable staging refresh and native backup. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, constants } from 'node:sqlite';
import { importDigest } from './import-capture.mjs';
import { INCREMENTAL_IMPORT_TABLES, inspectIncrementalImportResume, verifyIncrementalImport } from './import-refresh.mjs';
import { backupHash, backupObjectHash, restoreBackupSql, readBackupEvidence, fingerprintBackupTables } from './staging-backup.mjs';

const check = (ok, code) => { if (!ok) throw Error(code); };
const writable = new Set([...INCREMENTAL_IMPORT_TABLES, 'legacy_import_assertions', 'legacy_import_runs', 'legacy_import_batches']);
const functions = new Set(['count', 'json_array', 'json_extract', 'json_type', 'json_valid', 'length', 'lower']);

/** Restrict reviewed plan SQL to refresh writes; no filesystem escape or schema execution. */
export function applyRefreshRehearsalStatements(db, statements) {
    db.setAuthorizer((action, a, b) => {
        if ([constants.SQLITE_READ, constants.SQLITE_SELECT].includes(action)) return constants.SQLITE_OK;
        if ([constants.SQLITE_INSERT, constants.SQLITE_UPDATE].includes(action) && writable.has(a)) return constants.SQLITE_OK;
        if (action === constants.SQLITE_FUNCTION && functions.has(String(b ?? a).toLowerCase())) return constants.SQLITE_OK;
        return constants.SQLITE_DENY;
    });
    try {
        for (const statement of statements) {
            check(/^(INSERT|UPDATE)\s/.test(statement.sql) && !/[;]|--|\/\*/.test(statement.sql), 'REFRESH_REHEARSAL_SQL');
            db.prepare(statement.sql).run(...statement.params);
        }
    } finally { db.setAuthorizer(null); }
}

const interruptedProcess = `
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const {applyRefreshRehearsalStatements}=await import(process.argv[1]);
const db=new DatabaseSync(process.argv[2],{allowExtension:false});
db.exec('PRAGMA foreign_keys=ON;BEGIN');
applyRefreshRehearsalStatements(db,JSON.parse(fs.readFileSync(process.argv[3],'utf8')).slice(0,Number(process.argv[4])));
process.kill(process.pid,'SIGKILL');
`;

/** Each SQL boundary is killed before COMMIT in a separate process, then recovered from disk.
 * No credentials, provider transport, existing writable database or retained private output. */
export async function rehearseIncrementalImportFaults(sourceSql, refresh, migrations, { progress = () => {} } = {}) {
    const { executionSha256, ...body } = refresh;
    check(importDigest(body) === executionSha256, 'REFRESH_REHEARSAL_EXECUTION_HASH');
    check(backupHash(sourceSql) === refresh.manifest?.backupSha256, 'REFRESH_REHEARSAL_BACKUP_HASH');
    check(refresh.environment === 'staging' && refresh.requiredSchemaVersion === migrations.version
        && refresh.generation === migrations.generation && refresh.requirements?.productionAllowed === false
        && refresh.requirements?.atomicFinalBatchRequired === true, 'REFRESH_REHEARSAL_PLAN');
    const batches = [refresh.initialize, ...refresh.steps.map(s => s.batch), refresh.finish];
    check(batches.length >= 3 && batches.length <= 1000 && batches.every(batch => Array.isArray(batch) && batch.length > 0
        && batch.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) < 1_800_000
        && batch.every(s => typeof s.sql === 'string' && Buffer.byteLength(s.sql) < 100000 && Array.isArray(s.params) && s.params.length <= 100)), 'REFRESH_REHEARSAL_BOUND');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shamrock-refresh-faults-'));
    await fs.chmod(dir, 0o700);
    const file = path.join(dir, 'rehearsal.sqlite'), batchFile = path.join(dir, 'batch.private.json');
    let db, interruptions = 0, committedBatches = 0, restarts = 0;
    const reopen = () => { db = new DatabaseSync(file, { allowExtension: false }); db.exec('PRAGMA foreign_keys=ON'); restarts++; };
    const query = async (sql, params = []) => db.prepare(sql).all(...params);
    const readBatch = async statements => Promise.all(statements.map(async s => ({ results: await query(s.sql, s.params) })));
    const resume = () => inspectIncrementalImportResume(refresh, { readBatch });
    const commit = statements => {
        db.exec('BEGIN');
        try { applyRefreshRehearsalStatements(db, statements); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    try {
        db = restoreBackupSql(sourceSql, migrations, file);
        await fs.chmod(file, 0o600);
        const evidence = await readBackupEvidence(query, migrations);
        check(evidence.ledger.length === refresh.requiredSchemaVersion && importDigest(evidence.ledger) === refresh.manifest.schemaLedgerSha256, 'REFRESH_REHEARSAL_SCHEMA');
        check((await resume()).phase === 'initialize', 'REFRESH_REHEARSAL_NOT_PRISTINE');
        const fingerprint = async () => backupObjectHash(await fingerprintBackupTables(query, evidence));
        let previous = await fingerprint(), evidenceResult;
        for (const [index, statements] of batches.entries()) {
            const stage = index === 0 ? 'initialize' : index === batches.length - 1 ? 'finish' : 'evidence';
            if (stage === 'finish') {
                evidenceResult = await verifyIncrementalImport(refresh, { readBatch, phase: 'evidence' });
                check(evidenceResult.verified, 'REFRESH_REHEARSAL_EVIDENCE');
            }
            const checkpoint = backupObjectHash(await resume());
            await fs.writeFile(batchFile, JSON.stringify(statements), { mode: 0o600 });
            for (let prefix = 1; prefix <= statements.length; prefix++) {
                db.close(); db = undefined;
                const child = spawnSync(process.execPath, ['--input-type=module', '-e', interruptedProcess, import.meta.url, file, batchFile, String(prefix)],
                    { stdio: 'ignore', timeout: 30000, env: { NODE_NO_WARNINGS: '1' } });
                check(child.signal === 'SIGKILL' && !child.error, 'REFRESH_REHEARSAL_INTERRUPTION');
                reopen();
                check(await fingerprint() === previous && backupObjectHash(await resume()) === checkpoint, 'REFRESH_REHEARSAL_ROLLBACK');
                interruptions++;
            }
            commit(statements);
            db.close(); db = undefined; reopen();
            previous = await fingerprint();
            const state = await resume(), expectedPending = refresh.steps.slice(Math.max(0, index)).map(s => s.index);
            const expectedPhase = stage === 'finish' ? 'complete' : expectedPending.length ? 'loading' : 'verify-evidence-before-finish';
            check(state.phase === expectedPhase && (stage === 'finish' ? state.pendingSteps.length === 0 : importDigest(state.pendingSteps) === importDigest(expectedPending)), 'REFRESH_REHEARSAL_CHECKPOINT');
            // Lost committed response: replay the identical batch only after reopening and checking receipts.
            commit(statements);
            check(await fingerprint() === previous, 'REFRESH_REHEARSAL_REPLAY');
            committedBatches++;
            progress({ stage, completedBatches: committedBatches, totalBatches: batches.length, interruptions });
        }
        const verification = await verifyIncrementalImport(refresh, { readBatch });
        check(verification.verified, 'REFRESH_REHEARSAL_READBACK');
        await readBackupEvidence(query, migrations);
        const audits = db.prepare('SELECT COUNT(*) n FROM admin_audit_events WHERE command_id=?').get(refresh.commandId).n;
        check(audits === 1 && db.prepare('SELECT COUNT(*) n FROM operation_commands').get().n === 0, 'REFRESH_REHEARSAL_AUDIT');
        return { formatVersion: 1, environment: 'staging', kind: 'offline-process-interruption-rehearsal', verified: true,
            backupSha256: refresh.manifest.backupSha256, executionSha256, schemaVersion: evidence.ledger.length,
            evidenceBatches: refresh.steps.length, finalStatements: refresh.finish.length, interruptedTransactions: interruptions,
            committedBatches, reopenedConnections: restarts, replayedBatches: committedBatches,
            evidenceRowsVerified: evidenceResult.checkedRows, finalRowsVerified: verification.checkedRows,
            allRollbackTablesAndSequencesVerified: true, tableInventorySha256: previous, refreshAuditRows: audits,
            integrityVerified: true, providerCalls: 0, productionChanges: 0 };
    } finally {
        db?.close();
        await fs.rm(dir, { recursive: true, force: true });
    }
}
