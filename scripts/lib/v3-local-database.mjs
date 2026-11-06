import { readdir, readFile } from 'node:fs/promises';

// Disposable local fixtures only. Hosted upgrades must use the reviewed ledger
// and paused-state guards in prepare-v3-release.mjs.
export async function initializeLocalDatabase(db) {
  const directory = new URL('../../database/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    // Reviewed migrations currently contain no SQL triggers or literal semicolons.
    const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
}
