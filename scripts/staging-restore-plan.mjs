#!/usr/bin/env node
/** Token-free, offline native-export comparison and reviewed restore planning. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readBackupPrivateFile } from './staging-backup.mjs';
import { readMigrationSources, createMigrationPlan } from './lib/v3-migrations.mjs';
import { inspectNativeExport, compareNativeExports, prepareHostedRestore } from './lib/staging-restore.mjs';
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), check = (ok, code) => {
    if (!ok)
        throw Error(code);
};
async function outputDirectory(input) {
    check(input, 'RESTORE_OUTPUT');
    await fs.mkdir(input, { mode: 0o700 });
    const info = await fs.lstat(input);
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0, 'RESTORE_OUTPUT');
    const resolved = await fs.realpath(input);
    let repository;
    try {
        repository = execFileSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    catch {
    }
    if (repository)
        try {
            execFileSync('git', ['-C', repository, 'check-ignore', '-q', '--', path.join(resolved, 'manifest.json')], { stdio: 'ignore' });
        }
        catch {
            throw Error('RESTORE_OUTPUT_NOT_IGNORED');
        }
    return resolved;
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === '--help') {
        console.log(`Offline staging restore planning; no provider calls or credentials.
  inspect --source-sql PRIVATE_SQL --generation N --out-dir NEW_PRIVATE_DIRECTORY
  compare --source-sql PRIVATE_SQL --restored-sql PRIVATE_SQL --generation N --out-dir NEW_PRIVATE_DIRECTORY
  prepare --source-sql PRIVATE_SQL --target-sql PRIVATE_OLD_TARGET_SQL --route PRIVATE_ROUTE_JSON --generation N --out-dir NEW_PRIVATE_DIRECTORY
Prepare emits destructive reset API code for separate review; it never executes that code.`);
        return;
    }
    check(['inspect', 'compare', 'prepare'].includes(command), 'RESTORE_COMMAND');
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
        check(['--source-sql', '--restored-sql', '--target-sql', '--route', '--generation', '--out-dir'].includes(args[i]) && args[i + 1] && !Object.hasOwn(opts, args[i]), 'RESTORE_ARGUMENT');
        opts[args[i]] = args[i + 1];
    }
    if (command === 'prepare') {
        const owning = ['scripts/staging-restore-plan.mjs', 'scripts/lib/staging-restore.mjs', 'scripts/lib/staging-backup.mjs', 'scripts/lib/v3-migrations.mjs', 'database/migrations'];
        execFileSync('git', ['ls-files', '--error-unmatch', ...owning], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...owning], { cwd: root, stdio: 'ignore' });
        check(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...owning], { cwd: root, encoding: 'utf8' }).trim() === '', 'RESTORE_UNCOMMITTED_SOURCE');
    }
    const generation = Number(opts['--generation']), sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), plan = createMigrationPlan(await readMigrationSources(path.join(root, 'database/migrations')), sourceCommit, generation), sourceSql = await readBackupPrivateFile(opts['--source-sql'], false), dir = await outputDirectory(opts['--out-dir']);
    const write = (name, value, json = true) => fs.writeFile(path.join(dir, name), json ? JSON.stringify(value, null, 2) + '\n' : value, { mode: 0o600, flag: 'wx' });
    if (command === 'inspect') {
        const result = await inspectNativeExport(sourceSql, plan);
        await write('inspection.json', result);
        console.log(JSON.stringify({ status: 'locally-inspected', schemaVersion: result.schemaVersion, tables: result.tables.length, sqlBytes: result.sqlBytes }));
    }
    if (command === 'compare') {
        const result = await compareNativeExports(sourceSql, await readBackupPrivateFile(opts['--restored-sql'], false), plan);
        await write('comparison.json', result);
        console.log(JSON.stringify({ status: 'supplied-exports-match', schemaVersion: result.schemaVersion, tables: result.tables, rows: result.rows }));
    }
    if (command === 'prepare') {
        const result = await prepareHostedRestore(sourceSql, await readBackupPrivateFile(opts['--target-sql'], false), await readBackupPrivateFile(opts['--route']), plan);
        await write('manifest.json', { planSha256: result.planSha256, ...result.manifest });
        await write('import.sql', result.importSql, false);
        await write('reset.plugin.js', result.resetPluginCode, false);
        await write('reset-batch.json', { batch: result.resetBatch });
        await write('source-inspection.json', result.source);
        await write('target-inspection.json', result.target);
        console.log(JSON.stringify({ status: 'prepared-only', planSha256: result.planSha256, resetStatements: result.resetBatch.length, importBytes: result.manifest.importBytes, providerWrites: 0 }));
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(error => {
        console.error(/^RESTORE_[A-Z_]+$/.test(error.message) ? error.message : 'RESTORE_PLAN_FAILED: private evidence retained; no provider request was made');
        process.exitCode = 1;
    });
