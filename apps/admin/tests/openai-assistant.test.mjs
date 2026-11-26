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
