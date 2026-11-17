import { createHash } from "node:crypto";
import { splitMigrationSql } from "../../../scripts/lib/v3-migrations.mjs";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
/** Provider IO is injected by the release owner; every call receives the exact reviewed target. */
export async function installPanelSchema({
  target,
  schema,
  sourceCommit,
  inspect,
  apply,
}) {
  assert(
    target.workerName === "shamrock-admin-staging" &&
      target.origin === "https://shamrock-admin-staging.det225.workers.dev" &&
      target.databaseName === "shamrock-admin-staging" &&
      /^[a-f0-9-]{36}$/.test(target.databaseId),
    "ADMIN_STAGING_TARGET_REQUIRED",
  );
  assert(/^[a-f0-9]{40}$/.test(sourceCommit), "COMMITTED_SOURCE_REQUIRED");
  const hash = digest(schema),
    before = await inspect(target);
  assert(
    before.databaseId === target.databaseId &&
      before.databaseName === target.databaseName &&
      Array.isArray(before.tables),
    "DATABASE_TARGET_MISMATCH",
  );
  const tables = before.tables.filter(
    (name) =>
      !name.startsWith("sqlite_") && !["_cf_KV", "_cf_METADATA"].includes(name),
  );
  if (tables.length) {
    assert(
      before.installation?.sha256 === hash &&
        before.installation.database_id === target.databaseId &&
        before.installation.worker_name === target.workerName &&
        before.installation.origin === target.origin,
      "DATABASE_NOT_EMPTY_OR_SCHEMA_CHANGED",
    );
    return { status: "already-installed", schemaSha256: hash };
  }
  const statements = [
    {
      sql: "CREATE TABLE panel_install_guard (ok INTEGER NOT NULL CHECK(ok=1))",
      params: [],
    },
    {
      sql: "INSERT INTO panel_install_guard SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA','panel_install_guard')) THEN 1 ELSE 0 END",
      params: [],
    },
    ...splitMigrationSql(schema).map((sql) => ({ sql, params: [] })),
  ];
  statements.push({
    sql: "INSERT INTO panel_schema VALUES(1,?,?,?,?,?)",
    params: [
      hash,
      target.databaseId,
      target.workerName,
      target.origin,
      sourceCommit,
    ],
  });
  statements.push({ sql: "DROP TABLE panel_install_guard", params: [] });
  // The provider adapter must apply the ordered statements transactionally and
  // must not have any fallback to another database or operational D1 binding.
  await apply(target, statements, { expectedEmpty: true, schemaSha256: hash });
  const after = await inspect(target);
  assert(
    after.databaseId === target.databaseId &&
      after.databaseName === target.databaseName &&
      after.installation?.sha256 === hash &&
      after.installation.database_id === target.databaseId &&
      after.installation.worker_name === target.workerName &&
      after.installation.origin === target.origin,
    "SCHEMA_READBACK_FAILED",
  );
  return { status: "installed", schemaSha256: hash };
}
