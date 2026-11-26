import test from "node:test";
import assert from "node:assert/strict";
import { eventsState } from "../hosted/events-list.mjs";

test("rechecks grants on hits and isolates principal, revisions, previews and failed fills", async () => {
  let canRead = true, revision = 1, reads = 0, checks = 0, changeDuringRead = false;
  const scope = {termId:"term",currentTermId:"term"};
  const backend = {
    binding:"reader-one", identity:()=>({}), panelAuthority:async()=>{
      checks++;
      return {scope, revision:{operations:revision,administration:0,access:"hash"},
        access:{capabilities:{fullSnapshot:canRead}}};
    },
    post:async (_path,{section,offset,revision:version})=>{
      reads++;
      if (changeDuringRead && section === "events") revision++;
      return {section, offset, scope, revision:version, nextOffset:null,
        rows: section==="terms" ? [{termId:"term",isCurrent:1}] : [{eventId:"event",termId:"term"}]};
    },
  };
  const first=await eventsState(backend);
  assert.deepEqual(await eventsState(backend), first);
  assert.equal(reads,2); assert.equal(checks,3);
  canRead=false; assert.equal(await eventsState(backend),null);
  canRead=true; backend.binding="reader-two"; await eventsState(backend); assert.equal(reads,4);
  backend.preview={}; await assert.rejects(eventsState(backend)); assert.equal(reads,4);
  backend.preview=null; revision++; changeDuringRead=true;
  await assert.rejects(eventsState(backend),{code:"SNAPSHOT_CHANGED"});
  changeDuringRead=false; await eventsState(backend); assert.equal(reads,8);
});
