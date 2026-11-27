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
  const storage={transaction:f=>f({list:()=>structuredClone(jobs),put:(k,v)=>jobs.set(k,structuredClone(v)),delete:k=>jobs.delete(k)})};
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
