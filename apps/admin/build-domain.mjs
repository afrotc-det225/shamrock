import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readMigrationSources } from "../../scripts/lib/v3-migrations.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}/.build/admin`, { recursive: true });
const schema = createHash("sha256")
  .update(
    JSON.stringify(
      await readMigrationSources(
        new URL("../../database/migrations/", import.meta.url),
      ),
    ),
  )
  .digest("hex");
await writeFile(`${root}/.build/admin/schema.json`, JSON.stringify({ schema }));
// Separate artifacts: never replace the main thread's v3 release outputs.
await build({
  absWorkingDir: root,
  entryPoints: ["apps/admin/local-fixture.ts"],
  outfile: `${root}/.build/admin/worker.mjs`,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
});
await build({
  absWorkingDir: root,
  entryPoints: ["apps/admin/domain-entry.ts"],
  outfile: `${root}/.build/admin/domain.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  plugins: [
    {
      name: "isolated-source-imports",
      setup(b) {
        b.onResolve({ filter: /\.build\/v3\// }, (args) => ({
          path: resolve(args.resolveDir, args.path)
            .replace("/.build/v3/", "/")
            .replace(/\.js$/, ".ts"),
        }));
      },
    },
  ],
});
console.log(
  "Built isolated administrator-panel domain artifacts. No deployment.",
);
