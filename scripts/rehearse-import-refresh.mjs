#!/usr/bin/env node
/** Offline-only fault rehearsal; never contacts a provider or accepts a writable target. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readBackupPrivateFile } from './staging-backup.mjs';
import { readMigrationSources, createMigrationPlan } from './lib/v3-migrations.mjs';
import { rehearseIncrementalImportFaults } from './lib/import-refresh-rehearsal.mjs';
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
    const args = process.argv.slice(2), opts = {};
    if (args.length === 0 || args[0] === '--help') {
        console.log('Offline staging refresh fault rehearsal; no credentials or provider calls.\n  node scripts/rehearse-import-refresh.mjs --source-sql PRIVATE_NATIVE_BACKUP --plan PRIVATE_REFRESH_PLAN --out-dir NEW_PRIVATE_DIRECTORY');
        return;
    }
    for (let i = 0; i < args.length; i += 2) {
        if (!['--source-sql', '--plan', '--out-dir'].includes(args[i]) || !args[i + 1] || Object.hasOwn(opts, args[i])) throw Error('REFRESH_REHEARSAL_ARGUMENT');
        opts[args[i]] = args[i + 1];
    }
    if (Object.keys(opts).length !== 3) throw Error('REFRESH_REHEARSAL_ARGUMENT');
    const sql = await readBackupPrivateFile(opts['--source-sql'], false), refresh = await readBackupPrivateFile(opts['--plan']);
    await fs.mkdir(opts['--out-dir'], { mode: 0o700 });
    const dir = await fs.realpath(opts['--out-dir']);
    let repository;
    try { repository = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (repository) {
        try { execFileSync('git', ['-C', repository, 'check-ignore', '-q', '--', path.join(dir, 'proof.private.json')], { stdio: 'ignore' }); }
        catch { throw Error('REFRESH_REHEARSAL_OUTPUT_NOT_IGNORED'); }
    }
    const migrations = createMigrationPlan(await readMigrationSources(path.join(root, 'database/migrations')), refresh.sourceCommit, refresh.generation);
    const proof = await rehearseIncrementalImportFaults(sql, refresh, migrations, { progress: value => {
        if (value.stage !== 'evidence' || value.completedBatches % 10 === 0) console.log(JSON.stringify(value));
    } });
    await fs.writeFile(path.join(dir, 'proof.private.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(proof));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(/^REFRESH_REHEARSAL_[A-Z_]+$/.test(error.message) ? error.message : 'REFRESH_REHEARSAL_FAILED: no provider request was made');
        process.exitCode = 1;
    });
}
