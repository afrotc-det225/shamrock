import { areas } from "./hosted/maintenance.mjs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const filesAtCommit = Object.fromEntries(Object.entries(areas).map(([area,path]) =>
  [area,execFileSync('git',['show',sourceCommit+':'+path],{cwd:root,encoding:'utf8'})]));
const built=await build({
  define: {__MAINTENANCE_SOURCE__: JSON.stringify({commit:sourceCommit,files:filesAtCommit})},
  absWorkingDir: root,
  entryPoints: ["apps/admin/hosted/worker.mjs"],
  outfile: resolve(root, ".build/admin/hosted-worker.mjs"),
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
  loader: { ".sql": "text", ".md": "text" },
  plugins: [
    {
      name: "source-domain",
      setup(b) {
        b.onResolve({ filter: /\.build\/(admin|v3)\// }, (args) => ({
          path: args.path.endsWith("/admin/domain.mjs")
            ? resolve(root, "apps/admin/domain-entry.ts")
            : resolve(args.resolveDir, args.path)
                .replace("/.build/v3/", "/")
                .replace(/\.js$/, ".ts"),
        }));
      },
    },
  ],
});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputs=Object.keys(built.metafile.inputs).filter(p=>!p.includes('node_modules/'));
const scope=['apps/admin',...inputs,...Object.values(areas)];
const trackedDirty=execFileSync('git',['diff','--name-only','HEAD','--',...scope],{cwd:root,encoding:'utf8'}).trim();
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','--',...scope],{cwd:root,encoding:'utf8'}).trim();
const dirty=!!(trackedDirty||untracked);
if(process.argv.includes('--release')&&dirty)throw new Error('Commit the administrator panel and its imported source before preparing a release.');
const files=await readdir(resolve(root,'apps/admin/dist'),{recursive:true,withFileTypes:true});
const assets={};for(const file of files.filter(f=>f.isFile())){const full=resolve(file.parentPath,file.name);assets[full.slice(resolve(root,'apps/admin/dist').length)]=sha(await readFile(full));}
const manifest={sourceCommit,dirty,workerSha256:sha(await readFile(resolve(root,'.build/admin/hosted-worker.mjs'))),schemaSha256:sha(await readFile(resolve(root,'apps/admin/hosted/schema.sql'))),assets};
await writeFile(resolve(root,'.build/admin/hosted-release.json'),JSON.stringify({...manifest,releaseSha256:sha(JSON.stringify(manifest))},null,2)+'\n');
console.log("Built hosted administrator Worker. No deployment.");
