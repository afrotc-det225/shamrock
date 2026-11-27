import test from "node:test";
import assert from "node:assert/strict";
import { available, reserve, answer, model } from "../hosted/openai-assistant.mjs";

const now = 4e9, day = 86400000;
function ledger(times) {
  let queue = Promise.resolve();
  return {transaction(f) {
    queue = queue.then(() => f({get: async () => times, put: async (_, values) => { times = values; }}));
    return queue;
  }};
}
test("shared budget serializes dispatches and rolls over only expired reservations", async () => {
  const last = ledger(Array(199).fill(now - 2 * day));
  assert.deepEqual(await Promise.all([reserve(last, now), reserve(last, now)]), [true, false]);
  assert.equal(await reserve(last, now + day), false);
  assert.equal(await reserve(last, now + 32 * day), true);
  assert.equal(await reserve(ledger(Array(8).fill(now - 31_000)), now), false);
  assert.equal(await reserve(ledger([now + 1]), now), false);
});
const env = {ENVIRONMENT:"staging", STAGING_DATASET:"real", GENERATION:"1", BACKEND_SERVICE_NAME:"shamrock-real-parity",
  ASSISTANT_OWNER_SUB:"owner", ASSISTANT_KEY:"fixture", PANEL_DB:{reserveAssistant:async()=>true}};
test("only configured staging subject in own view may use assistant", () => {
  assert.equal(available(env,{google_sub:"owner"},null), true);
  for (const [e,subject,preview] of [[env,"other",null],[env,"owner",{}],[{...env,GENERATION:"2"},"owner",null],
    [{...env,ASSISTANT_KEY:""},"owner",null]]) assert.equal(available(e,{google_sub:subject},preview), false);
});
test("bounded text-only call ignores client settings and fails closed before dispatch", async () => {
  const body = {messages:[{role:"user",content:"How do corrections work?"}],model:"other",tools:["search"]};
  let sent = 0;
  const send = async (_, options) => {
    sent++;
    const q = JSON.parse(options.body);
    assert.equal(options.redirect,"manual");
    assert.equal(q.model,model); assert.equal(q.max_output_tokens,700); assert.equal(q.store,false);
    assert.equal(q.tools,undefined); assert.equal(q.reasoning.effort,"none"); assert.ok(Buffer.byteLength(options.body)<=10000);
    return Response.json({output:[{type:"message",content:[{type:"output_text",text:"Review the correction."}]}]});
  };
  assert.deepEqual(await answer(env,body,"Guide",send), {content:"Review the correction."});
  for (const reserveAssistant of [async()=>false,async()=>{throw Error("offline")}]) {
    await assert.rejects(answer({...env,PANEL_DB:{reserveAssistant}},body,"Guide",send));
  }
  await assert.rejects(answer(env,{messages:[{role:"user",content:"🍀".repeat(1001)}]},"Guide",send));
  assert.equal(sent,1);
});
test("maintenance charges three slots against existing reservations and binds the unique edit to release code", async () => {
  assert.equal(await reserve(ledger(Array(198).fill(now-2*day)),now,3),false);
  const book=ledger(Array(197).fill(now-2*day));
  assert.equal(await reserve(book,now,3),true);
  assert.equal(await reserve(book,now+day,1),false);
  const area="Excusal queue", source="export function currentExcusalRequests(s){return s.requests;}";
  const config={...env,maintenanceSource:{commit:"a".repeat(40),files:{[area]:source}},
    PANEL_DB:{reserveAssistant:async weight=>weight===3}};
  const messages=[{role:"user",content:"We are working on the excusal queue"},{role:"user",content:"Handle missing requests"}];
  const send=async (_,opts)=>{
    const q=JSON.parse(opts.body);
    if(q.text?.format.name==="route")return respond(JSON.stringify({type:"patch",areas:[area]}));
    assert.equal(q.reasoning.effort,"low");assert.equal(q.max_output_tokens,2200);
    assert.equal(JSON.parse(q.input).source,source);assert.ok(q.input.includes(messages.at(-1).content));
    return Response.json({output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({
      summary:"Handle missing requests.",before:"s.requests;",after:"s.requests ?? [];",args:["{}"],expected:"[]"})}]}]});
  };
  const r=await answer(config,{mode:"maintenance",area,messages},"Guide",send);
  assert.deepEqual(r.proposal.example,{args:[{}],expected:[]});
  assert.equal(r.proposal.source,source);
  await assert.rejects(answer(config,{messages},"Guide",async()=>respond(JSON.stringify({type:"patch",areas:["../secrets"]}))));
});


function respond(text){
  return Response.json({output:[{type:"message",content:[{type:"output_text",text}]}]});
}
test("Wing summary skips routing and sends only approved current and archived aggregates",async()=>{
  let reads=0,calls=0;
  const result=await answer(env,{messages:[{role:"user",content:"How is our detachment doing?"}]},"Guide",async(_,options)=>{
    calls++;
    const q=JSON.parse(options.body);
    assert.equal(q.model,model);assert.match(q.instructions,/Spring 2026/);assert.match(q.instructions,/0.94/);
    assert(!options.body.includes("private-fixture"));return respond("Overall attendance improved.");
  },async()=>{reads++;return {dashboard:{averageOverall:.94,birthdays:["private-fixture"]},history:[{label:"Spring 2026",overall:.90,people:["private-fixture"]}]};});
  assert.equal(reads,1);assert.equal(calls,1);assert.match(result.content,/improved/);
});
test("follow-up overhaul selects stronger reasoning and only reviewed release excerpts",async()=>{
  let calls=0;
  const area="Panel caching",cfg={...env,maintenanceSource:{commit:"fixture",files:{[area]:"export function cached() {}"}}};
  await answer(cfg,{area:"../../other",messages:[{role:"user",content:"Our cache is inefficient."},{role:"user",content:"Overhaul it."}]},"Guide",async(_,options)=>{
    const q=JSON.parse(options.body);calls++;
    if(calls===1){assert.match(q.input,/inefficient/);return respond(JSON.stringify({type:"design",areas:[area]}));}
    assert.equal(q.reasoning.effort,"high");assert.match(q.model,/^gpt-5.4-2026/);
    assert.match(q.input,/cached/);assert(!q.input.includes("../../other"));return respond("Plan");
  },()=>{throw Error("unexpected records read");});assert.equal(calls,2);
});
