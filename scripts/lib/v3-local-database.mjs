import { readMigrationSources, splitMigrationSql } from './v3-migrations.mjs';

// Disposable local fixtures only. Hosted upgrades must use the reviewed ledger
// and paused-state guards in prepare-v3-release.mjs.
export async function initializeLocalDatabase(db) {
  const directory = new URL('../../database/migrations/', import.meta.url);
  for (const { sql } of await readMigrationSources(directory)) {
    const statements = splitMigrationSql(sql);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
}
