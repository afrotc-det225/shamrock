import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMigrationPlan, readMigrationSources, createFreshDatabaseBatch } from '../../scripts/lib/v3-migrations.mjs';
import { backupRowSql, backupHash, captureStagingBackup, proveBackupSql, uploadPrivateBackup, sanitizedBackupSupport, restoreBackupSql, privateDriveAcl } from '../../scripts/lib/staging-backup.mjs';
import { backupProviderPorts, validateBackupConfig } from '../../scripts/staging-backup.mjs';
const commit = 'a'.repeat(40), sources = await readMigrationSources(new URL('../../database/migrations/', import.meta.url));
function fixture() {
    const plan = createMigrationPlan(sources, commit, 1), db = new DatabaseSync(':memory:');
    for (const entry of createFreshDatabaseBatch(plan).batch)
        db.prepare(entry.sql).run(...entry.params ?? []);
    db.prepare('INSERT INTO people VALUES(?,?)').run('fictional', 'Unicode 🙂 and embedded\0value; ATTACH is data');
    return { plan, db, query: async (sql, params = []) => db.prepare(sql).all(...params) };
}
function dump(db) {
    const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), sql = ['PRAGMA defer_foreign_keys=ON', ...schema.map(r => r.sql)];
    const quote = name => '"' + name + '"';
    for (const table of [...schema, { name: 'sqlite_sequence' }]) {
        const columns = db.prepare('PRAGMA table_info(' + quote(table.name) + ')').all();
        if (!columns.length)
            continue;
        if (table.name === 'sqlite_sequence')
            sql.push('DELETE FROM sqlite_sequence');
        const expr = columns.map(c => `CASE typeof(${quote(c.name)}) WHEN 'text' THEN 'CAST(X'''||hex(${quote(c.name)})||''' AS TEXT)' WHEN 'blob' THEN 'X'''||hex(${quote(c.name)})||'''' ELSE quote(${quote(c.name)}) END`).join(`||','||`);
        for (const row of db.prepare(`SELECT ${expr} AS row FROM ${quote(table.name)}`).all())
            sql.push(`INSERT INTO ${quote(table.name)} VALUES(${row.row})`);
    }
    sql.push(...db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.sql));
    return sql.join(';\n') + ';\n';
}
test('current migration catalog exports and restores exact schema, typed rows, sequence values and paused state', async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    for (let index = 0; index < 80; index++) f.db.prepare('INSERT INTO people VALUES(?,?)').run('page-' + index, 'Fictional row ' + index);
    const sql = dump(f.db), result = await captureStagingBackup({ query: f.query, exportSql: async () => 'https://download.example.invalid', download: async () => sql }, f.plan);
    assert.equal(result.proof.schemaVersion, sources.length);
    assert.equal(result.proof.sqlSha256, backupHash(sql));
    assert(result.proof.tables.some(t => t.table === 'sqlite_sequence'));
    assert.equal(result.proof.tables.find(t => t.table === 'people').rows, 81);
    assert.equal((await proveBackupSql(sql, f.plan, { evidence: result.evidence, tables: result.proof.tables })).tableInventorySha256, result.proof.tableInventorySha256);
    const support = sanitizedBackupSupport(result.proof, commit);
    assert.equal(support.restoreKind, 'isolated-local-sqlite');
    assert(!JSON.stringify(support).includes('fictional'));
    assert(!JSON.stringify(support).includes('embedded'));
    assert.throws(() => sanitizedBackupSupport({ ...result.proof, tables: [{ rows: 'private value' }] }, commit), /BACKUP_SUPPORT_INPUT/);
});
test('known earlier schema prefixes are supported dynamically, with no hardcoded target version', async (t) => {
    const earlier = sources.slice(0, -1), old = createMigrationPlan(earlier, commit, 1), full = createMigrationPlan(sources, commit, 1), db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    for (const e of createFreshDatabaseBatch(old).batch)
        db.prepare(e.sql).run(...e.params ?? []);
    const sql = dump(db);
    const r = await captureStagingBackup({ query: async (s, p = []) => db.prepare(s).all(...p), exportSql: async () => '', download: async () => sql }, full);
    assert.equal(r.proof.schemaVersion, earlier.length);
});
test('changed source, unpaused state, foreign-key damage and unknown schema never produce a verified backup', async (t) => {
    const race = fixture();
    t.after(() => race.db.close());
    const sql = dump(race.db);
    await assert.rejects(captureStagingBackup({ query: race.query, exportSql: async () => {
            race.db.prepare("UPDATE people SET display_name='Changed'").run();
            return '';
        }, download: async () => sql }, race.plan), /BACKUP_SOURCE_CHANGED/);
    for (const mutate of [db => db.prepare('UPDATE system_control SET accepting_commands=1').run(), db => db.exec('CREATE TABLE unexpected(x TEXT)'), db => {
            db.exec('PRAGMA foreign_keys=OFF');
            db.prepare("INSERT INTO memberships VALUES('missing','missing',1)").run();
        }]) {
        const f = fixture();
        t.after(() => f.db.close());
        mutate(f.db);
        let exported = false;
        await assert.rejects(captureStagingBackup({ query: f.query, exportSql: async () => {
                exported = true;
                return '';
            }, download: async () => '' }, f.plan));
        assert.equal(exported, false);
    }
});
test('restore authorizer rejects external files, writable schema, temporary shadow tables and executable schema', () => {
    const plan = createMigrationPlan(sources, commit, 1);
    for (const sql of ["ATTACH DATABASE '/tmp/forbidden-shamrock.db' AS external;", 'PRAGMA writable_schema=ON;', 'CREATE TEMP TABLE people(x TEXT);', 'CREATE TABLE people(person_id TEXT PRIMARY KEY,display_name TEXT); CREATE TRIGGER dangerous AFTER INSERT ON people BEGIN DELETE FROM people; END;'])
        assert.throws(() => restoreBackupSql(sql, plan), /BACKUP_RESTORE_REJECTED/);
});
const owner = 'owner@example.invalid', folder = { id: 'folder', mimeType: 'application/vnd.google-apps.folder', owners: [{ emailAddress: owner }], trashed: false }, acl = [{ type: 'user', role: 'owner', emailAddress: owner }];
function driveFixture() {
    let state, file, allocated = 0, uploads = 0, lose = false, body = '';
    const journal = { load: async () => state ? structuredClone(state) : null, save: async (v) => {
            state = structuredClone(v);
        } };
    const ports = { metadata: async (id, optional) => id === 'folder' ? structuredClone(folder) : file ? structuredClone(file) : optional ? null : Promise.reject(Error('missing')), permissions: async () => structuredClone(acl), generateId: async () => {
            allocated++;
            return 'allocated';
        }, upload: async (id, parent, sql, digest) => {
            uploads++;
            assert.equal(state.status, 'uploading');
            body = sql;
            file = { id, mimeType: 'application/sql', owners: [{ emailAddress: owner }], parents: [parent], size: String(Buffer.byteLength(sql)), sha256Checksum: digest, appProperties: { shamrockBackupSha256: digest } };
            if (lose) {
                lose = false;
                throw Error('lost acknowledgement');
            }
        }, download: async () => Buffer.from(body) };
    return { ports, journal, config: { folderId: 'folder', ownerEmail: owner }, lose: () => lose = true, counters: () => ({ allocated, uploads }), file: () => file };
}
test('owner-private Drive upload journals one allocated identity and safely resumes a lost final acknowledgement', async () => {
    const f = driveFixture();
    f.lose();
    await assert.rejects(uploadPrivateBackup('fictional sql', f.config, f.ports, f.journal), /lost acknowledgement/);
    assert.equal((await f.journal.load()).status, 'uploading');
    const result = await uploadPrivateBackup('fictional sql', f.config, f.ports, f.journal);
    assert.equal(result.status, 'verified');
    assert.deepEqual(f.counters(), { allocated: 1, uploads: 1 });
    await assert.rejects(uploadPrivateBackup('different', f.config, f.ports, f.journal), /BACKUP_UPLOAD_JOURNAL/);
});
test('shared/wrong-owner folders, changed file metadata and corrupt readback fail before verified custody', async () => {
    assert.throws(() => privateDriveAcl(folder, [...acl, { type: 'anyone', role: 'reader' }], owner, { folder: true }), /BACKUP_DRIVE_ACL/);
    assert.throws(() => privateDriveAcl({ ...folder, driveId: 'shared-drive' }, acl, owner, { folder: true }), /BACKUP_DRIVE_OWNER/);
    const denied = driveFixture();
    denied.ports.permissions = async () => [...acl, { type: 'domain', role: 'reader' }];
    await assert.rejects(uploadPrivateBackup('sql', denied.config, denied.ports, denied.journal), /BACKUP_DRIVE_ACL/);
    assert.deepEqual(denied.counters(), { allocated: 0, uploads: 0 });
    const corrupt = driveFixture();
    corrupt.ports.download = async () => Buffer.from('corrupt');
    await assert.rejects(uploadPrivateBackup('sql', corrupt.config, corrupt.ports, corrupt.journal), /BACKUP_DRIVE_READBACK/);
    assert.equal((await corrupt.journal.load()).status, 'uploading');
});
test('provider export polling uses the returned bookmark and never forwards Cloudflare credentials to its signed download', async () => {
    const c = validateBackupConfig({ version: 1, environment: 'staging', generation: 1, rollbackSourceCommit: commit, cloudflare: { accountId: 'b'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000000', tokenReference: 'op://fixture/token/password' }, destination: { folderId: 'fixture-folder', ownerEmail: owner, gcloudConfiguration: 'fixture' } }), calls = [];
    const ports = backupProviderPorts(c, { cloudflareToken: 'fictional-token', wait: async () => {
        }, fetcher: async (url, opts) => {
            calls.push({ url, opts });
            if (calls.length === 1)
                return Response.json({ success: true, result: { at_bookmark: 'fictional-bookmark' } });
            if (calls.length === 2) {
                assert.equal(JSON.parse(opts.body).current_bookmark, 'fictional-bookmark');
                return Response.json({ success: true, result: { status: 'complete', result: { signed_url: 'https://download.example.invalid/private' } } });
            }
            assert.equal(opts.headers, undefined);
            return new Response('SQL');
        } });
    assert.equal(await ports.download(await ports.exportSql()), 'SQL');
    assert.equal(calls.length, 3);
    assert.equal(ports.metrics.rowsWritten, 0);
});
import { backupObjectHash, reviewedBackupRecovery, verifyBackupSource } from '../../scripts/lib/staging-backup.mjs';
test('recovery review binds the migration helper fields to the exact restored capture and rejects a changed live source', async (t) => {
    const f = fixture();
    t.after(() => f.db.close());
    const sql = dump(f.db), result = await captureStagingBackup({ query: f.query, exportSql: async () => '', download: async () => sql }, f.plan), manifest = { environment: 'staging', generation: 1, rollbackSourceCommit: commit, backupSha256: result.proof.sqlSha256, proof: result.proof, evidence: result.evidence }, saved = { manifest, captureSha256: backupObjectHash(manifest) };
    const recovery = reviewedBackupRecovery(saved, sql, saved.captureSha256);
    assert.equal(recovery.fromVersion, sources.length);
    assert.equal(recovery.reviewed, true);
    assert.equal(recovery.restoreVerified, true);
    assert.equal(recovery.evidenceSha256, result.evidence.evidenceSha256);
    assert.equal(recovery.backupSha256, backupHash(sql));
    await verifyBackupSource(f.query, f.plan, manifest);
    assert.throws(() => reviewedBackupRecovery(saved, sql + '-- changed', saved.captureSha256), /BACKUP_RECOVERY_CHANGED/);
    assert.throws(() => reviewedBackupRecovery(saved, sql, '0'.repeat(64)), /BACKUP_REVIEW_REQUIRED/);
    f.db.prepare("UPDATE people SET display_name='Later data'").run();
    await assert.rejects(verifyBackupSource(f.query, f.plan, manifest), /BACKUP_SOURCE_CHANGED/);
});
test('read API ports reject chained SQL before any provider request', async () => {
    let calls = 0;
    const ports = backupProviderPorts({ cloudflare: { accountId: 'fixture', databaseId: 'fixture' } }, { cloudflareToken: 'fixture', fetcher: async () => {
            calls++;
            throw Error('unexpected');
        } });
    await assert.rejects(ports.query('SELECT 1;DELETE FROM people'), /BACKUP_READ_ONLY/);
    await assert.rejects(ports.query('PRAGMA writable_schema=ON'), /BACKUP_READ_ONLY/);
    assert.equal(calls, 0);
});
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readBackupPrivateFile } from '../../scripts/staging-backup.mjs';
test('private backup files and local lock recovery retain active work and recover only a dead same-host process', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shamrock-backup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lock = path.join(dir, 'backup.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, hostname: hostname() }), { mode: 0o600 });
    const run = () => spawnSync(process.execPath, ['scripts/staging-backup.mjs', 'recover-lock', '--private-dir', dir], { encoding: 'utf8' });
    let r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BACKUP_LOCK_ACTIVE/);
    assert(await readFile(lock));
    await writeFile(lock, JSON.stringify({ pid: 2147483647, hostname: hostname() }));
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).backupChanged, false);
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    const file = path.join(dir, 'private.json');
    await writeFile(file, '{}', { mode: 0o600 });
    assert.deepEqual(await readBackupPrivateFile(file), {});
    await chmod(file, 0o644);
    await assert.rejects(readBackupPrivateFile(file), /BACKUP_PRIVATE_FILE/);
});
test('resumable Drive uploads persist the session before bytes and resume only the unacknowledged byte range', async () => {
    const config = { destination: {} }, calls = [], session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fictional';
    let saved;
    const ports = backupProviderPorts(config, { googleToken: 'fictional-google-token', fetcher: async (url, options) => {
            calls.push({ url, options });
            if (calls.length === 1)
                return new Response(null, { status: 200, headers: { location: session } });
            if (calls.length === 2) {
                assert.equal(saved, session);
                return new Response(null, { status: 308, headers: { range: 'bytes=0-4' } });
            }
            if (calls.length === 3) {
                assert.equal(options.headers['content-range'], 'bytes */10');
                return new Response(null, { status: 308, headers: { range: 'bytes=0-4' } });
            }
            assert.equal(options.headers['content-range'], 'bytes 5-9/10');
            assert.equal(options.body.toString(), '56789');
            return new Response('{}', { status: 200 });
        } });
    await assert.rejects(ports.drive.upload('file', 'folder', '0123456789', backupHash('0123456789'), { persistSession: async (value) => saved = value }), /BACKUP_DRIVE_UPLOAD/);
    await ports.drive.upload('file', 'folder', '0123456789', backupHash('0123456789'), { sessionUrl: saved });
    assert.equal(calls.length, 4);
    await assert.rejects(ports.drive.upload('file', 'folder', '0123456789', 'hash', { sessionUrl: 'https://external.example.invalid/upload' }), /BACKUP_DRIVE_SESSION/);
    assert.equal(calls.length, 4);
});

test('wide row fingerprints stay within D1 function arguments and preserve flat typed JSON', () => {
    const db = new DatabaseSync(':memory:');
    try {
        const names = Array.from({length:40},(_,index)=>'field_'+index);
        db.exec('CREATE TABLE wide('+names.map(name=>name+' TEXT').join(',')+')');
        const values=names.map((name,index)=>index===0?'Unicode \0 sample':String(index));
        db.prepare('INSERT INTO wide VALUES('+names.map(()=>'?').join(',')+')').run(...values);
        const input=backupRowSql('wide',db.prepare('PRAGMA table_info(wide)').all());
        let calls=0;db.function('json_array',{varargs:true},(...args)=>{calls++;assert(args.length<=32);return JSON.stringify(args);});
        const actual=db.prepare(input.sql).get();
        assert.deepEqual(JSON.parse(actual.packed),values.flatMap(value=>['text',Buffer.from(value).toString('hex').toUpperCase()]));
        assert.deepEqual(JSON.parse(actual.cursor),['1']);assert(calls>1);
    }finally{db.close();}
});
