/** Staging-only, dependency-free backup proof. Provider IO is injected and never restores hosted data. */
import { createHash } from 'node:crypto';
import { DatabaseSync, constants } from 'node:sqlite';
import { classifyMigrationState, migrationEvidenceHash } from './v3-migrations.mjs';
export const BACKUP_LIMITS = { sqlBytes: 128 * 1024 * 1024, pageRows: 32, queries: 10000, tableRows: 1000000, polls: 120, pollMs: 1000 };
export const backupHash = value => createHash('sha256').update(value).digest('hex');
const check = (ok, code) => {
    if (!ok)
        throw Error(code);
};
const stable = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const same = (a, b) => stable(a) === stable(b);
export const backupObjectHash = value => backupHash(stable(value));
const identifier = name => {
    check(typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name), 'BACKUP_IDENTIFIER');
    return '"' + name + '"';
};
const engine = name => name.startsWith('_cf_') || name.startsWith('sqlite_');
export async function readBackupEvidence(query, plan) {
    const inventory = await query(plan.preflight.inventory.sql), ledger = await query(plan.preflight.ledger.sql), controls = await query(plan.preflight.control.sql);
    check(classifyMigrationState(plan, inventory, ledger, controls).action !== 'apply', 'BACKUP_EMPTY_DATABASE');
    const quick = await query('PRAGMA quick_check'), foreign = await query('PRAGMA foreign_key_check');
    check(quick.length === 1 && Object.values(quick[0])[0] === 'ok' && foreign.length === 0, 'BACKUP_INTEGRITY');
    return { inventory, ledger, controls, evidenceSha256: migrationEvidenceHash(inventory, ledger, controls) };
}
// D1 accepts at most 32 arguments per SQL function. Keep the same flat JSON bytes
// while joining bounded json_array fragments for wider current/future tables.
function boundedJsonArray(values) {
    if (values.length <= 32) return `json_array(${values.join(',')})`;
    const chunks = [];
    for (let offset = 0; offset < values.length; offset += 32) {
        const chunk = `json_array(${values.slice(offset, offset + 32).join(',')})`;
        chunks.push(`substr(${chunk},2,length(${chunk})-2)`);
    }
    return "'['||" + chunks.join("||','||") + "||']'";
}
/** Typed hexadecimal values preserve embedded NUL, Unicode, blobs and integer precision. */
export function backupRowSql(table, columns, cursor = null) {
    const selected = columns.map(c => identifier(c.name)), primary = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => identifier(c.name)), keys = primary.length ? primary : ['rowid'];
    const packed = selected.flatMap(c => [`typeof(${c})`, `CASE WHEN typeof(${c}) IN ('text','blob') THEN hex(CAST(${c} AS BLOB)) ELSE quote(${c}) END`]);
    return { sql: `SELECT ${boundedJsonArray(packed)} AS packed,${boundedJsonArray(keys.map(c => `CAST(${c} AS TEXT)`))} AS cursor FROM ${identifier(table)}${cursor ? ` WHERE (${keys.join(',')})>(${keys.map(() => '?').join(',')})` : ''} ORDER BY ${keys.join(',')} LIMIT ${BACKUP_LIMITS.pageRows}`, params: cursor ?? [] };
}
export async function fingerprintBackupTables(query, evidence, { progress = () => {
} } = {}) {
    const tables = evidence.inventory.filter(r => r.type === 'table' && !engine(r.name)).map(r => r.name);
    const sequences = await query("SELECT name FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'");
    if (sequences.length)
        tables.push('sqlite_sequence');
    const result = [];
    for (const table of tables.sort()) {
        const columns = await query(`PRAGMA table_info(${identifier(table)})`);
        check(columns.length > 0 && columns.length <= 128, 'BACKUP_COLUMNS');
        let cursor = null;
        const hashes = [];
        do {
            const input = backupRowSql(table, columns, cursor), rows = await query(input.sql, input.params);
            check(rows.length <= BACKUP_LIMITS.pageRows, 'BACKUP_PAGE');
            for (const row of rows) {
                check(typeof row.packed === 'string' && typeof row.cursor === 'string', 'BACKUP_ROW');
                hashes.push(backupHash(row.packed));
            }
            check(hashes.length <= BACKUP_LIMITS.tableRows, 'BACKUP_ROWS');
            if (!rows.length || rows.length < BACKUP_LIMITS.pageRows)
                break;
            const next = JSON.parse(rows.at(-1).cursor);
            check(Array.isArray(next) && next.every(v => typeof v === 'string') && !same(next, cursor), 'BACKUP_CURSOR');
            cursor = next;
        } while (true);
        result.push({ table, rows: hashes.length, columnsSha256: backupObjectHash(columns.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))), rowsSha256: backupHash(hashes.sort().join('\n')) });
        progress({ stage: 'fingerprint', table, rows: hashes.length });
    }
    return result;
}
/** Replay only into a fresh local database; SQLite authorizer blocks filesystem escape or executable schema. */
export function restoreBackupSql(sql, plan, file = ':memory:') {
    check(typeof sql === 'string' && Buffer.byteLength(sql) > 0 && Buffer.byteLength(sql) <= BACKUP_LIMITS.sqlBytes && !sql.includes('\0'), 'BACKUP_SQL_SIZE');
    const db = new DatabaseSync(file, { allowExtension: false, enableForeignKeyConstraints: false });
    try {
        check(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n === 0, 'BACKUP_RESTORE_NOT_EMPTY');
        const names = new Set(plan.expectedObjects.map(o => o.name));
        db.setAuthorizer((action, a, b) => {
            if ([constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_SELECT, constants.SQLITE_RECURSIVE, constants.SQLITE_CREATE_TRIGGER, constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_INDEX, constants.SQLITE_CREATE_TEMP_TRIGGER, constants.SQLITE_CREATE_VTABLE, constants.SQLITE_CREATE_VIEW, constants.SQLITE_CREATE_TEMP_VIEW, constants.SQLITE_ALTER_TABLE, ...[constants.SQLITE_DROP_TABLE, constants.SQLITE_DROP_INDEX, constants.SQLITE_DROP_VIEW, constants.SQLITE_DROP_TRIGGER]].includes(action))
                return constants.SQLITE_DENY;
            if (action === constants.SQLITE_PRAGMA && !['defer_foreign_keys', 'foreign_keys'].includes(a))
                return constants.SQLITE_DENY;
            // Native D1 dumps encode multiline strings with replace(...,char(10)).
            if (action === constants.SQLITE_FUNCTION && !['length', 'lower', 'json_valid', 'json_type', 'json_extract', 'replace', 'char'].includes(String(b ?? a).toLowerCase()))
                return constants.SQLITE_DENY;
            if ([constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_INDEX].includes(action) && !names.has(a) && !String(a).startsWith('sqlite_'))
                return constants.SQLITE_DENY;
            if (action === constants.SQLITE_UPDATE && !['sqlite_master', 'sqlite_schema'].includes(a))
                return constants.SQLITE_DENY;
            if (action === constants.SQLITE_DELETE && a !== 'sqlite_sequence')
                return constants.SQLITE_DENY;
            return constants.SQLITE_OK;
        });
        db.exec(sql);
        db.setAuthorizer(null);
        db.exec('PRAGMA foreign_keys=ON');
        return db;
    }
    catch {
        db.close();
        throw Error('BACKUP_RESTORE_REJECTED');
    }
}
export async function proveBackupSql(sql, plan, expected, { file = ':memory:' } = {}) {
    const db = restoreBackupSql(sql, plan, file);
    try {
        const query = async (sql, params = []) => db.prepare(sql).all(...params), evidence = await readBackupEvidence(query, plan), tables = await fingerprintBackupTables(query, evidence);
        check(evidence.evidenceSha256 === expected.evidence.evidenceSha256 && same(tables, expected.tables), 'BACKUP_RESTORE_MISMATCH');
        return { restoreKind: 'isolated-local-sqlite', schemaVersion: evidence.ledger.length, evidenceSha256: evidence.evidenceSha256, tables, tableInventorySha256: backupObjectHash(tables), sqlSha256: backupHash(sql), sqlBytes: Buffer.byteLength(sql) };
    }
    finally {
        db.close();
    }
}
export async function captureStagingBackup({ query, exportSql, download }, plan, { progress = () => {
} } = {}) {
    let queries = 0;
    const bounded = async (sql, params = []) => {
        check(++queries <= BACKUP_LIMITS.queries, 'BACKUP_QUERY_BUDGET');
        check(/^(SELECT|PRAGMA (quick_check|foreign_key_check|table_info))/i.test(sql) && !/[;]|--|\/\*/.test(sql), 'BACKUP_READ_ONLY');
        return query(sql, params);
    };
    const evidence = await readBackupEvidence(bounded, plan), tables = await fingerprintBackupTables(bounded, evidence, { progress });
    progress({ stage: 'export' });
    const sql = await download(await exportSql());
    check(typeof sql === 'string' && Buffer.byteLength(sql) <= BACKUP_LIMITS.sqlBytes, 'BACKUP_SQL_SIZE');
    const proof = await proveBackupSql(sql, plan, { evidence, tables });
    progress({ stage: 'restore-verified' });
    const finalEvidence = await readBackupEvidence(bounded, plan), finalTables = await fingerprintBackupTables(bounded, finalEvidence, { progress });
    check(evidence.evidenceSha256 === finalEvidence.evidenceSha256 && same(tables, finalTables), 'BACKUP_SOURCE_CHANGED');
    return { sql, evidence, proof: { ...proof, queryCount: queries } };
}
export function privateDriveAcl(metadata, permissions, ownerEmail, { folderId = null, folder = false } = {}) {
    check(metadata && !metadata.trashed && !metadata.driveId && metadata.owners?.length === 1 && metadata.owners[0].emailAddress?.toLowerCase() === ownerEmail.toLowerCase(), 'BACKUP_DRIVE_OWNER');
    check(Array.isArray(permissions) && permissions.length === 1 && permissions[0].type === 'user' && permissions[0].role === 'owner' && permissions[0].emailAddress?.toLowerCase() === ownerEmail.toLowerCase() && !permissions[0].deleted, 'BACKUP_DRIVE_ACL');
    if (folder)
        check(metadata.mimeType === 'application/vnd.google-apps.folder', 'BACKUP_DRIVE_FOLDER');
    else
        check(metadata.mimeType === 'application/sql' && same(metadata.parents, [folderId]), 'BACKUP_DRIVE_PARENT');
}
/** Allocate identity before IO; ambiguous create/upload resumes against the same file and exact bytes. */
export async function uploadPrivateBackup(sql, config, ports, journal) {
    const digest = backupHash(sql), size = Buffer.byteLength(sql), load = () => journal.load(), save = value => journal.save(value);
    privateDriveAcl(await ports.metadata(config.folderId), await ports.permissions(config.folderId), config.ownerEmail, { folder: true });
    let state = await load();
    if (!state) {
        state = { formatVersion: 1, sha256: digest, bytes: size, fileId: await ports.generateId(), folderId: config.folderId, ownerEmail: config.ownerEmail, status: 'allocated' };
        await save(state);
    }
    check(state.formatVersion === 1 && state.sha256 === digest && state.bytes === size && state.folderId === config.folderId && state.ownerEmail === config.ownerEmail && typeof state.fileId === 'string', 'BACKUP_UPLOAD_JOURNAL');
    let metadata = await ports.metadata(state.fileId, true);
    if (!metadata || state.status === 'uploading' && metadata.size === '0') {
        if (metadata) {
            privateDriveAcl(metadata, await ports.permissions(state.fileId), config.ownerEmail, { folderId: config.folderId });
            check(metadata.appProperties?.shamrockBackupSha256 === digest, 'BACKUP_DRIVE_CONTENT');
        }
        state = { ...state, status: 'uploading' };
        await save(state);
        await ports.upload(state.fileId, config.folderId, sql, digest, { sessionUrl: state.sessionUrl, persistSession: async (sessionUrl) => {
                state = { ...state, sessionUrl };
                await save(state);
            } });
        metadata = await ports.metadata(state.fileId);
    }
    privateDriveAcl(metadata, await ports.permissions(state.fileId), config.ownerEmail, { folderId: config.folderId });
    check(metadata.size === String(size) && metadata.appProperties?.shamrockBackupSha256 === digest && (!metadata.sha256Checksum || metadata.sha256Checksum === digest), 'BACKUP_DRIVE_CONTENT');
    check(backupHash(await ports.download(state.fileId)) === digest, 'BACKUP_DRIVE_READBACK');
    privateDriveAcl(await ports.metadata(config.folderId), await ports.permissions(config.folderId), config.ownerEmail, { folder: true });
    privateDriveAcl(await ports.metadata(state.fileId), await ports.permissions(state.fileId), config.ownerEmail, { folderId: config.folderId });
    state = { ...state, status: 'verified' };
    await save(state);
    return state;
}
export function sanitizedBackupSupport(proof, sourceCommit) {
    check(/^[a-f0-9]{40,64}$/.test(sourceCommit) && Number.isSafeInteger(proof.schemaVersion) && proof.schemaVersion > 0 && proof.restoreKind === 'isolated-local-sqlite' && Number.isSafeInteger(proof.sqlBytes) && proof.sqlBytes >= 0 && Number.isSafeInteger(proof.queryCount) && proof.queryCount >= 0 && Array.isArray(proof.tables) && proof.tables.every(t => Number.isSafeInteger(t.rows) && t.rows >= 0), 'BACKUP_SUPPORT_INPUT');
    return { formatVersion: 1, environment: 'staging', sourceCommit, schemaVersion: proof.schemaVersion, restoreKind: proof.restoreKind, restoreVerified: true,
        tables: proof.tables.length, rows: proof.tables.reduce((n, t) => n + t.rows, 0), sqlBytes: proof.sqlBytes, queryCount: proof.queryCount, contents: 'No record values, resource IDs, addresses, secrets, signed URLs or per-row hashes.' };
}
export function reviewedBackupRecovery(saved, sql, approvedHash) {
    check(saved && saved.captureSha256 === approvedHash && backupObjectHash(saved.manifest) === approvedHash, 'BACKUP_REVIEW_REQUIRED');
    const m = saved.manifest, p = m.proof;
    check(m.environment === 'staging' && Number.isSafeInteger(m.generation) && m.generation > 0 && /^[a-f0-9]{40,64}$/.test(m.rollbackSourceCommit) && p.restoreKind === 'isolated-local-sqlite' && p.sqlSha256 === m.backupSha256 && backupHash(sql) === m.backupSha256 && p.evidenceSha256 === m.evidence.evidenceSha256 && p.schemaVersion === m.evidence.ledger.length, 'BACKUP_RECOVERY_CHANGED');
    return { environment: 'staging', generation: m.generation, fromVersion: p.schemaVersion, evidenceSha256: m.evidence.evidenceSha256, backupSha256: m.backupSha256, rollbackSourceCommit: m.rollbackSourceCommit, reviewed: true, restoreVerified: true, adaptersPaused: true };
}
export async function verifyBackupSource(query, plan, manifest) {
    let count = 0;
    const bounded = async (sql, params = []) => {
        check(++count <= BACKUP_LIMITS.queries, 'BACKUP_QUERY_BUDGET');
        return query(sql, params);
    };
    const evidence = await readBackupEvidence(bounded, plan), tables = await fingerprintBackupTables(bounded, evidence);
    check(evidence.evidenceSha256 === manifest.evidence.evidenceSha256 && same(tables, manifest.proof.tables), 'BACKUP_SOURCE_CHANGED');
    return true;
}
