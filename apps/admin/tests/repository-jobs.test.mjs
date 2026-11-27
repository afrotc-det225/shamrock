import test from "node:test";
import assert from "node:assert/strict";
import {runnerIdentity,repositoryJob} from "../hosted/repository-jobs.mjs";

test("only the staging runner workflow and ref may claim jobs",()=>{
  const c={repository_id:"1473995318",repository_owner_id:"261806974",ref:"refs/heads/main",
    workflow_ref:"afrotc-det225/shamrock-staging-runner/.github/workflows/check.yml@refs/heads/main",
    event_name:"schedule",run_id:"123",run_attempt:"1"};
  assert.equal(runnerIdentity(c),"123/1");
  for(const key of Object.keys(c))assert.throws(()=>runnerIdentity({...c,[key]:"untrusted"}));
});
test("claimed proposals have one runner; stale work expires and another run cannot report success",async()=>{
  const jobs=new Map();
  const storage={transaction:f=>f({get:k=>jobs.get(k),list:()=>structuredClone(jobs),put:(k,v)=>jobs.set(k,structuredClone(v)),delete:k=>jobs.delete(k)})};
  const send=(operation,other={},now=0)=>repositoryJob(storage,{operation,id:"fixture",...other},now);
  await send("create",{patch:{area:"fixture"}});
  const claim=await send("claim",{run:"1/1"});
  assert.deepEqual(claim.patch,{area:"fixture"});
  assert.equal(await send("claim",{run:"2/1"}),null);
  assert.deepEqual(await send("finish",{run:"2/1",passed:true}),{state:"running"});
  assert.deepEqual(await send("finish",{run:"1/1",passed:false}),{state:"failed"});
  assert.deepEqual(await send("status"),{state:"failed"});
  assert.equal(await send("status",{},8*86400000),null);
});

test("publication requires owner approval of the exact passing patch",async()=>{
  const rows=new Map(),storage={transaction:f=>f({get:k=>rows.get(k),list:()=>structuredClone(rows),put:(k,v)=>rows.set(k,structuredClone(v))})};
  const send=(operation,options)=>repositoryJob(storage,{operation,id:"job",...options},0);
  await send("create",{patch:{after:"fixture"}});
  assert.deepEqual(await send("approve"),{state:"queued"});
  await send("claim",{run:"1/1"});
  await send("finish",{run:"1/1",passed:true});
  assert.equal(await send("claim",{run:"2/1"}),null);
  await send("approve");
  assert.deepEqual(await send("claim",{run:"2/1"}),{id:"job",patch:{after:"fixture"},operation:"publish"});
  assert.deepEqual(await send("finish",{run:"1/1",passed:true}),{state:"publishing"});
  assert.deepEqual(await send("finish",{run:"2/1",passed:true}),{state:"published"});
});

test("multi-file changes require unique release matches in every selected file",async()=>{
  const {areas,validateEdits}=await import("../hosted/maintenance.mjs");
  const edits=["Flight home","Cadet profile fields"].map(area=>({area,path:areas[area],before:"return 1",after:"return 2"}));
  const files=Object.fromEntries(edits.map(e=>[e.area,"function fixture(){return 1}"]));
  assert.deepEqual(validateEdits(edits,files),edits);
  assert.throws(()=>validateEdits([edits[0],edits[0]],files));
  assert.throws(()=>validateEdits(edits,{...files,[edits[1].area]:"other"}));
});

test("a uniquely named reviewed source resolves a mistaken Decisions file selection", async () => {
  const {patchSourceArea}=await import("../hosted/maintenance.mjs");
  for(const question of ["Fix currentExcusalRequests(snapshot)", "Edit apps/admin/src/attendance-events.mjs now"])
    assert.equal(patchSourceArea(question,"Google adapter entry points"),"Excusal queue");
  assert.equal(patchSourceArea("Improve attendance processing","Sheet edits"),"Sheet edits");
});
