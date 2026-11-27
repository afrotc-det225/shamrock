// Rehearse an owner-downloaded staging proposal against the exact released source.
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {areas} from "../apps/admin/hosted/maintenance.mjs";
import assert from "node:assert/strict";

const proposal=JSON.parse(readFileSync(process.argv[2],"utf8"));
const {area,path,commit,before,after}=proposal;
assert.ok(Object.hasOwn(areas,area) && path===areas[area],"Unrecognized source path");
assert.match(commit,/^[a-f0-9]{40}$/);
assert.equal(typeof after,"string");
assert.ok(typeof before==="string" && before && before!==after);
const git=(...args)=>execFileSync("git",args,{maxBuffer:64*1024*1024});
const root=git("rev-parse","--show-toplevel").toString().trim();
process.chdir(root);
git("merge-base","--is-ancestor",commit,"HEAD");
const source=git("show",commit+":"+path).toString();
assert.equal(source.split(before).length,2,"Replacement must match exactly once");
const volume="shamrock-job-"+crypto.randomUUID();
// This disposable volume is the only writable workspace accessible to the candidate.
const docker=(...args)=>execFileSync("docker",args,{stdio:"inherit",timeout:600000});
try{
  const run=["run","--rm","--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=256","--memory=2g","--cpus=2",
    "-v",volume+":/work","-w","/work"];
  const image="node:26-bookworm";
  docker("volume","create",volume);
  const pipe=(data,args)=>execFileSync("docker",[...run,"-i",...args],{input:data,stdio:["pipe","inherit","inherit"],timeout:600000});
  pipe(git("archive","--format=tar",commit),[image,"sh","-ec",
    "tar xf - && git init -q && git add . && git -c user.name=Fixture -c user.email=fixture@invalid commit -qm baseline && npm ci --no-audit && npm --prefix apps/admin ci --no-audit"]);
  const test="npm run check && npm --prefix apps/admin run build:domain && npm --prefix apps/admin test && npm --prefix apps/admin run build";
  docker(...run,"--network=none",image,"sh","-ec",test);
  pipe(source.replace(before,()=>after),["--network=none",image,"sh","-ec",
    'cat > "$1" && '+test,"codex-test",path]);
  console.log("Released code and proposal passed repository checks.");
}finally{
  docker("volume","rm","-f",volume);
}
