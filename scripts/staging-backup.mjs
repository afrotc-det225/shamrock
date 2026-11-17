#!/usr/bin/env node
/** Private staging exports, restore proof and Drive custody. Never imports into a hosted database. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createMigrationPlan, readMigrationSources } from './lib/v3-migrations.mjs';
import { BACKUP_LIMITS, backupHash, backupObjectHash, captureStagingBackup, proveBackupSql, uploadPrivateBackup, sanitizedBackupSupport, reviewedBackupRecovery, verifyBackupSource } from './lib/staging-backup.mjs';
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), check = (ok, code) => {
    if (!ok)
        throw Error(code);
};
const HELP = `SHAMROCK staging backup (Node with node:sqlite; no paid services)
  capture --config PRIVATE_CONFIG --pause-evidence PRIVATE_ATTESTATION --private-dir NEW_PRIVATE_DIRECTORY
  upload --config PRIVATE_CONFIG --private-dir EXISTING_CAPTURE_DIRECTORY --review-sha CAPTURE_SHA256
  review-recovery --config PRIVATE_CONFIG --pause-evidence PRIVATE_ATTESTATION --private-dir EXISTING_CAPTURE_DIRECTORY --review-sha CAPTURE_SHA256
  recover-lock --private-dir EXISTING_CAPTURE_DIRECTORY
Capture verifies two local restores and exact hosted table hashes before/after export. Upload creates only one owner-private Drive SQL file with immutable identity. No command changes production, schema, hosted records, billing or retention.`;
export async function readBackupPrivateFile(file, json = true) {
    const info = await fs.lstat(file);
    check(!info.isSymbolicLink() && info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size <= BACKUP_LIMITS.sqlBytes, 'BACKUP_PRIVATE_FILE');
    const value = await fs.readFile(file, 'utf8');
    return json ? JSON.parse(value) : value;
}
async function directory(input) {
    check(input, 'BACKUP_PRIVATE_DIRECTORY');
    await fs.mkdir(input, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(input);
    check(!info.isSymbolicLink() && info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0, 'BACKUP_PRIVATE_DIRECTORY');
    const result = await fs.realpath(input);
    let repository;
    try {
        repository = execFileSync('git', ['-C', result, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    catch {
    }
    if (repository)
        try {
            execFileSync('git', ['-C', repository, 'check-ignore', '-q', '--', path.join(result, 'backup.sql')], { stdio: 'ignore' });
        }
        catch {
            throw Error('BACKUP_OUTPUT_NOT_IGNORED');
        }
    return result;
}
const writeNew = (dir, name, value, json = true) => fs.writeFile(path.join(dir, name), json ? JSON.stringify(value, null, 2) + '\n' : value, { flag: 'wx', mode: 0o600 });
export function validateBackupConfig(c) {
    check(c && Object.keys(c).sort().join(',') === 'cloudflare,destination,environment,generation,rollbackSourceCommit,version' && c.version === 1 && c.environment === 'staging' && Number.isSafeInteger(c.generation) && c.generation > 0 && /^[a-f0-9]{40,64}$/.test(c.rollbackSourceCommit), 'BACKUP_CONFIG');
    check(c.cloudflare && Object.keys(c.cloudflare).sort().join(',') === 'accountId,databaseId,tokenReference' && /^[a-f0-9]{32}$/.test(c.cloudflare.accountId) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.cloudflare.databaseId) && /^op:\/\/.{1,1000}$/.test(c.cloudflare.tokenReference), 'BACKUP_CONFIG');
    check(c.destination && Object.keys(c.destination).sort().join(',') === 'folderId,gcloudConfiguration,ownerEmail' && /^[A-Za-z0-9_-]{5,200}$/.test(c.destination.folderId) && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(c.destination.ownerEmail) && c.destination.ownerEmail === c.destination.ownerEmail.toLowerCase() && /^[a-z][a-z0-9_-]{0,63}$/.test(c.destination.gcloudConfiguration), 'BACKUP_CONFIG');
    return c;
}
const token = (command, args) => {
    let value;
    try {
        value = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 16384 }).trim();
    }
    catch {
        throw Error('BACKUP_CREDENTIAL_UNAVAILABLE');
    }
    check(value.length >= 24 && value.length < 8192, 'BACKUP_CREDENTIAL_BOUND');
    return value;
};
export async function boundedBackupResponse(response, maximum) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maximum) {
            await response.body?.cancel?.().catch(() => {
            });
            throw Error('BACKUP_RESPONSE_SIZE');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
export function backupProviderPorts(config, { fetcher = fetch, cloudflareToken, googleToken, wait = ms => new Promise(r => setTimeout(r, ms)), progress = () => {
} }) {
    const metrics = { requests: 0, rowsRead: 0, rowsWritten: 0 };
    const http = async (url, options = {}, limit = 8 * 1024 * 1024) => {
        metrics.requests++;
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30000), ...options });
        const body = await boundedBackupResponse(response, limit);
        return { status: response.status, headers: response.headers, body };
    };
    const cf = async (action, body) => {
        check(['query', 'export'].includes(action), 'BACKUP_API_ACTION');
        const response = await http(`https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/d1/database/${config.cloudflare.databaseId}/${action}`, { method: 'POST', headers: { authorization: 'Bearer ' + cloudflareToken, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        check(response.status === 200, 'BACKUP_CLOUDFLARE_HTTP');
        const value = JSON.parse(response.body);
        check(value.success === true, 'BACKUP_CLOUDFLARE_RESPONSE');
        return value.result;
    };
    const query = async (sql, params = []) => {
        check(/^(SELECT|PRAGMA (quick_check|foreign_key_check|table_info))/i.test(sql) && !/[;]|--|\/\*/.test(sql), 'BACKUP_READ_ONLY');
        const result = await cf('query', { sql, params });
        check(Array.isArray(result) && result.length === 1 && result[0].success !== false && Array.isArray(result[0].results), 'BACKUP_QUERY_RESPONSE');
        check(!result[0].meta?.rows_written && !result[0].meta?.changed_db, 'BACKUP_QUERY_WROTE');
        metrics.rowsRead += Number(result[0].meta?.rows_read ?? 0);
        return result[0].results;
    };
    const exportSql = async () => {
        let bookmark;
        for (let poll = 0; poll < BACKUP_LIMITS.polls; poll++) {
            const result = await cf('export', { output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) });
            check(!result.error && result.status !== 'error', 'BACKUP_EXPORT_FAILED');
            if (result.status === 'complete') {
                const url = new URL(result.result?.signed_url);
                check(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'BACKUP_EXPORT_URL');
                return url.href;
            }
            check(typeof result.at_bookmark === 'string' && (!bookmark || bookmark === result.at_bookmark), 'BACKUP_EXPORT_BOOKMARK');
            bookmark = result.at_bookmark;
            progress({ stage: 'export-poll', poll: poll + 1 });
            await wait(BACKUP_LIMITS.pollMs);
        }
        throw Error('BACKUP_EXPORT_PENDING');
    };
    const download = async (url) => {
        const response = await http(url, {}, BACKUP_LIMITS.sqlBytes);
        check(response.status === 200, 'BACKUP_EXPORT_DOWNLOAD');
        return new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    };
    const drive = async (route, options = {}, limit = 8 * 1024 * 1024) => {
        check(typeof googleToken === 'string', 'BACKUP_GOOGLE_TOKEN');
        return http('https://www.googleapis.com' + route, { ...options, headers: { authorization: 'Bearer ' + googleToken, ...options.headers } }, limit);
    };
    const metadata = async (id, optional = false) => {
        const response = await drive('/drive/v3/files/' + encodeURIComponent(id) + '?fields=id,mimeType,parents,owners(emailAddress),driveId,trashed,size,sha256Checksum,appProperties');
        if (optional && response.status === 404)
            return null;
        check(response.status === 200, 'BACKUP_DRIVE_METADATA');
        return JSON.parse(response.body);
    };
    const permissions = async (id) => {
        const response = await drive('/drive/v3/files/' + encodeURIComponent(id) + '/permissions?fields=nextPageToken,permissions(type,role,emailAddress,deleted)&pageSize=100');
        check(response.status === 200, 'BACKUP_DRIVE_PERMISSIONS');
        const value = JSON.parse(response.body);
        check(!value.nextPageToken && Array.isArray(value.permissions), 'BACKUP_DRIVE_PERMISSIONS');
        return value.permissions;
    };
    const generateId = async () => {
        const response = await drive('/drive/v3/files/generateIds?count=1&space=drive&type=files');
        check(response.status === 200, 'BACKUP_DRIVE_ID');
        const value = JSON.parse(response.body);
        check(value.ids?.length === 1 && /^[A-Za-z0-9_-]+$/.test(value.ids[0]), 'BACKUP_DRIVE_ID');
        return value.ids[0];
    };
    const upload = async (id, folderId, sql, digest, { sessionUrl, persistSession = async () => {
    } } = {}) => {
        const content = Buffer.from(sql), checkedSession = value => {
            const url = new URL(value);
            check(url.origin === 'https://www.googleapis.com' && url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable', 'BACKUP_DRIVE_SESSION');
            return url.href;
        };
        let offset = 0;
        if (sessionUrl) {
            sessionUrl = checkedSession(sessionUrl);
            const status = await http(sessionUrl, { method: 'PUT', headers: { authorization: 'Bearer ' + googleToken, 'content-length': '0', 'content-range': `bytes */${content.length}` }, body: Buffer.alloc(0) });
            if (status.status === 200 || status.status === 201)
                return;
            check(status.status === 308, 'BACKUP_DRIVE_SESSION_UNAVAILABLE');
            const range = status.headers.get('range');
            if (range) {
                check(/^bytes=0-[0-9]+$/.test(range), 'BACKUP_DRIVE_RANGE');
                offset = Number(range.split('-')[1]) + 1;
                check(Number.isSafeInteger(offset) && offset > 0 && offset < content.length, 'BACKUP_DRIVE_RANGE');
            }
        }
        else {
            const initial = await drive('/upload/drive/v3/files?uploadType=resumable', { method: 'POST', headers: { 'content-type': 'application/json', 'x-upload-content-type': 'application/sql', 'x-upload-content-length': String(content.length) }, body: JSON.stringify({ id, name: 'SHAMROCK staging backup ' + digest.slice(0, 16) + '.sql', mimeType: 'application/sql', parents: [folderId], appProperties: { shamrockBackupSha256: digest } }) });
            if (initial.status === 409)
                return;
            check(initial.status === 200, 'BACKUP_DRIVE_UPLOAD_START');
            sessionUrl = checkedSession(initial.headers.get('location'));
            await persistSession(sessionUrl);
        }
        const sent = await http(sessionUrl, { method: 'PUT', headers: { authorization: 'Bearer ' + googleToken, 'content-type': 'application/sql', 'content-length': String(content.length - offset), 'content-range': `bytes ${offset}-${content.length - 1}/${content.length}` }, body: content.subarray(offset) });
        check(sent.status === 200 || sent.status === 201, 'BACKUP_DRIVE_UPLOAD');
    };
    const readDrive = async (id) => {
        const response = await drive('/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {}, BACKUP_LIMITS.sqlBytes);
        check(response.status === 200, 'BACKUP_DRIVE_DOWNLOAD');
        return response.body;
    };
    return { query, exportSql, download, metrics, drive: { metadata, permissions, generateId, upload, download: readDrive } };
}
async function checkpoint(dir, name) {
    let prior;
    return { async load() {
            try {
                const value = await readBackupPrivateFile(path.join(dir, name));
                prior = backupObjectHash(value);
                return value;
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    prior = null;
                    return null;
                }
                throw error;
            }
        }, async save(value) {
            let current = null;
            try {
                current = backupObjectHash(await readBackupPrivateFile(path.join(dir, name)));
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            check(current === prior, 'BACKUP_CHECKPOINT_CHANGED');
            const temporary = path.join(dir, '.checkpoint-' + randomUUID());
            const handle = await fs.open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await fs.rename(temporary, path.join(dir, name));
            prior = backupObjectHash(value);
            check(backupObjectHash(await readBackupPrivateFile(path.join(dir, name))) === prior, 'BACKUP_CHECKPOINT_READBACK');
        } };
}
function requireCommittedBackupSource() {
    const owning = ['scripts/staging-backup.mjs', 'scripts/lib/staging-backup.mjs', 'scripts/lib/v3-migrations.mjs', 'database/migrations'];
    execFileSync('git', ['ls-files', '--error-unmatch', ...owning], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...owning], { cwd: root, stdio: 'ignore' });
    check(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...owning], { cwd: root, encoding: 'utf8' }).trim() === '', 'BACKUP_UNCOMMITTED_SOURCE');
}
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (!command || command === '--help') {
        console.log(HELP);
        return;
    }
    check(['capture', 'upload', 'review-recovery', 'recover-lock'].includes(command), 'BACKUP_COMMAND');
    const opts = {};
    for (let i = 0; i < rest.length; i += 2) {
        check(['--config', '--pause-evidence', '--private-dir', '--review-sha'].includes(rest[i]) && rest[i + 1] && !Object.hasOwn(opts, rest[i]), 'BACKUP_ARGUMENT');
        opts[rest[i]] = rest[i + 1];
    }
    const dir = await directory(opts['--private-dir']);
    if (command === 'recover-lock') {
        const file = path.join(dir, 'backup.lock'), record = await readBackupPrivateFile(file);
        check(record.hostname === hostname() && Number.isSafeInteger(record.pid) && record.pid > 0, 'BACKUP_LOCK_IDENTITY');
        let dead = false;
        try {
            process.kill(record.pid, 0);
        }
        catch (error) {
            if (error.code === 'ESRCH')
                dead = true;
            else
                throw error;
        }
        check(dead, 'BACKUP_LOCK_ACTIVE');
        await fs.unlink(file);
        console.log(JSON.stringify({ status: 'stale-local-lock-removed', backupChanged: false }));
        return;
    }
    const lock = await fs.open(path.join(dir, 'backup.lock'), 'wx', 0o600);
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }) + '\n');
        await lock.sync();
        const config = validateBackupConfig(await readBackupPrivateFile(opts['--config'])), configHash = backupObjectHash(config);
        const pauseEvidence = async () => {
            const pause = await readBackupPrivateFile(opts['--pause-evidence']);
            check(pause.environment === 'staging' && pause.generation === config.generation && pause.adaptersPaused === true && pause.sourceCommit === config.rollbackSourceCommit && Number.isFinite(Date.parse(pause.verifiedAt)) && Date.now() - Date.parse(pause.verifiedAt) >= 0 && Date.now() - Date.parse(pause.verifiedAt) < 15 * 60000, 'BACKUP_PAUSE_EVIDENCE');
            return pause;
        };
        if (command === 'review-recovery') {
            requireCommittedBackupSource();
            await pauseEvidence();
            const saved = await readBackupPrivateFile(path.join(dir, 'capture.json')), sql = await readBackupPrivateFile(path.join(dir, 'backup.sql'), false), recovery = reviewedBackupRecovery(saved, sql, opts['--review-sha']);
            check(saved.manifest.configHash === configHash, 'BACKUP_CONFIG_CHANGED');
            const candidate = await readBackupPrivateFile(path.join(dir, 'recovery-candidate.json'));
            check(backupObjectHash(candidate) === backupObjectHash({ ...recovery, reviewed: false }), 'BACKUP_RECOVERY_CHANGED');
            const plan = createMigrationPlan(await readMigrationSources(path.join(root, 'database/migrations')), saved.manifest.sourceCommit, config.generation), ports = backupProviderPorts(config, { cloudflareToken: token('op', ['read', config.cloudflare.tokenReference]) });
            await proveBackupSql(sql, plan, { evidence: saved.manifest.evidence, tables: saved.manifest.proof.tables });
            await verifyBackupSource(ports.query, plan, saved.manifest);
            await writeNew(dir, 'recovery-reviewed.json', recovery);
            console.log(JSON.stringify({ status: 'recovery-reviewed', captureSha256: saved.captureSha256, hostedWrites: 0 }));
            return;
        }
        if (command === 'capture') {
            const pause = await pauseEvidence();
            requireCommittedBackupSource();
            const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), plan = createMigrationPlan(await readMigrationSources(path.join(root, 'database/migrations')), sourceCommit, config.generation);
            const ports = backupProviderPorts(config, { cloudflareToken: token('op', ['read', config.cloudflare.tokenReference]), progress: event => console.error('BACKUP_PROGRESS ' + event.stage) }), result = await captureStagingBackup(ports, plan, { progress: event => console.error('BACKUP_PROGRESS ' + JSON.stringify(event)) });
            await writeNew(dir, 'backup.sql', result.sql, false);
            const local = await fs.open(path.join(dir, 'restored.sqlite'), 'wx', 0o600);
            await local.close();
            await proveBackupSql(result.sql, plan, { evidence: result.evidence, tables: result.proof.tables }, { file: path.join(dir, 'restored.sqlite') });
            const manifest = { formatVersion: 1, environment: 'staging', generation: config.generation, sourceCommit, rollbackSourceCommit: config.rollbackSourceCommit, configHash, backupSha256: result.proof.sqlSha256, capturedAt: new Date().toISOString(), pauseEvidenceSha256: backupObjectHash(pause), evidence: result.evidence, proof: result.proof, usage: ports.metrics }, captureSha256 = backupObjectHash(manifest);
            await writeNew(dir, 'capture.json', { captureSha256, manifest });
            await writeNew(dir, 'pause-evidence.json', pause);
            await writeNew(dir, 'preflight.json', { inventory: result.evidence.inventory, ledger: result.evidence.ledger, controls: result.evidence.controls });
            await writeNew(dir, 'recovery-candidate.json', { environment: 'staging', generation: config.generation, fromVersion: result.proof.schemaVersion, evidenceSha256: result.evidence.evidenceSha256, backupSha256: result.proof.sqlSha256, rollbackSourceCommit: config.rollbackSourceCommit, reviewed: false, restoreVerified: true, adaptersPaused: true });
            await writeNew(dir, 'support.json', sanitizedBackupSupport(result.proof, sourceCommit));
            console.log(JSON.stringify({ status: 'captured-and-restored-locally', captureSha256, schemaVersion: result.proof.schemaVersion, sqlBytes: result.proof.sqlBytes, providerRecordWrites: 0 }));
        }
        else {
            const saved = await readBackupPrivateFile(path.join(dir, 'capture.json')), sql = await readBackupPrivateFile(path.join(dir, 'backup.sql'), false);
            check(opts['--review-sha'] === saved.captureSha256 && backupObjectHash(saved.manifest) === saved.captureSha256 && saved.manifest.configHash === configHash && backupHash(sql) === saved.manifest.backupSha256, 'BACKUP_REVIEW_REQUIRED');
            const ports = backupProviderPorts(config, { googleToken: token('gcloud', ['--configuration', config.destination.gcloudConfiguration, '--account', config.destination.ownerEmail, 'auth', 'print-access-token']) });
            const result = await uploadPrivateBackup(sql, config.destination, ports.drive, await checkpoint(dir, 'drive-upload.json'));
            console.log(JSON.stringify({ status: result.status, captureSha256: saved.captureSha256, ownerPrivate: true, contentVerified: true }));
        }
    }
    finally {
        await lock.close();
        await fs.unlink(path.join(dir, 'backup.lock'));
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(error => {
        console.error(/^BACKUP_[A-Z_]+$/.test(error.message) ? error.message : 'BACKUP_FAILED: private evidence retained; no automatic retry, repair or cleanup');
        process.exitCode = 1;
    });
