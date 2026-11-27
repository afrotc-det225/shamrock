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
  const fresh=ledger([]);assert.equal(await reserve(fresh,now),true);assert.equal(await reserve(fresh,now+1),true);
  const last = ledger(Array(199).fill(now - 2 * day));
  assert.deepEqual(await Promise.all([reserve(last, now), reserve(last, now)]), [true, false]);
  assert.equal(await reserve(last, now + day), false);
  assert.equal(await reserve(last, now + 32 * day), true);
  assert.equal(await reserve(ledger(Array(32).fill(now - 31_000)), now), true);
  assert.equal(await reserve(ledger(Array(96).fill(now - 31_000)), now), false);
  assert.equal(await reserve(ledger([now + 1]), now), false);
});
const env = {ENVIRONMENT:"staging", STAGING_DATASET:"real", GENERATION:"1", BACKEND_SERVICE_NAME:"shamrock-real-parity",
  ASSISTANT_OWNER_SUB:"owner", ASSISTANT_KEY:"fixture", PANEL_DB:{reserveAssistant:async()=>true}};
test("Assistant requires owner or administrator tools in the signed-in workspace", () => {
  assert.equal(available(env,{google_sub:"owner"},null), true);
  assert.equal(available(env,{google_sub:"administrator"},null,{fullSnapshot:true,canViewAs:true}),true);
  assert.equal(available(env,{google_sub:"reader"},null,{fullSnapshot:true}),false);
  assert.equal(available(env,{google_sub:"administrator"},{status:"ready"},{canViewAs:true}),false);
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
    if(q.questions){assert.equal(_,"https://api.openai.com/v1/decisions");return decision(q,"patch",area);}
    assert.equal(q.model,"gpt-5.3-codex");
    assert.equal(q.reasoning.effort,"low");assert.equal(q.max_output_tokens,2200);
    assert.equal(JSON.parse(q.input).source,source);assert.ok(q.input.includes(messages.at(-1).content));
    return Response.json({output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({
      summary:"Handle missing requests.",before:"s.requests;",after:"s.requests ?? [];",args:["{}"],expected:"[]"})}]}]});
  };
  const r=await answer(config,{mode:"maintenance",area,messages},"Guide",send);
  assert.deepEqual(r.proposal.example,{args:[{}],expected:[]});
  assert.equal(r.proposal.source,source);
  assert.equal(r.proposal.routing,"Decisions");
  await assert.rejects(answer(config,{messages},"Guide",async()=>respond(JSON.stringify({type:"patch",areas:["../secrets"]}))));
});


function decision(q,type,area){
  assert.equal(q.model,"gpt-6-luna");
  const source=q.questions[1].choices.find(c=>c.description===area);
  return Response.json({answers:[{type:"choice",name:"route",choice:type},{type:"choice",name:"source",choice:source.value}]});
}
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
    if(calls===1){assert.match(q.input,/inefficient/);return decision(q,"design",area);}
    assert.equal(q.reasoning.effort,"high");assert.match(q.model,/^gpt-5.4-2026/);
    assert.match(q.input,/cached/);assert(!q.input.includes("../../other"));return respond("Plan");
  },()=>{throw Error("unexpected records read");});assert.equal(calls,2);
});

test("commissioning forecasts get current and prior cohorts without exposing cadet records",async()=>{
  let calls=0;
  await answer(env,{messages:[{role:"user",content:"How many cadets will we commission this year? How does that compare?"}]},"Guide",async(_,options)=>{
    const q=JSON.parse(options.body);calls++;
    assert.match(q.instructions,/typically commission in spring/);
    assert.match(q.instructions,/"term":"2026-Fall"/);
    assert.match(q.instructions,/"AS400":21/);
    assert.match(q.instructions,/"AS400":13/);
    assert(!q.instructions.includes("private-fixture"));
    return respond("The AS400 cohort is a projection.");
  },async()=>({dashboard:{termLabel:"2026-Fall",rosterByYear:[{asYear:"AS400",cadets:21,person:"private-fixture"}]},
    history:[{label:"2025 Fall",rosterByYear:[{asYear:"AS400",cadets:13}]}]}));
  assert.equal(calls,1);
});

test("a Decisions refusal never dispatches a coding call; key scope denial uses bounded routing",async()=>{
  const body={messages:[{role:"user",content:"Explain flight reporting"}]};
  let calls=0;
  await assert.rejects(answer(env,body,"Guide",async()=>{
    calls++;
    return Response.json({answers:[{type:"refusal",name:"route"}]});
  }));
  assert.equal(calls,1);
  const endpoints=[];
  await answer(env,body,"Guide",async(url,options)=>{
    endpoints.push(url.split("/").pop());
    if(endpoints.length===1)return new Response(null,{status:403});
    if(endpoints.length===2){
      assert.equal(JSON.parse(options.body).max_output_tokens,120);
      return respond(JSON.stringify({type:"procedure",area:"none"}));
    }
    return respond("Guide response");
  });
  assert.deepEqual(endpoints,["decisions","responses","responses"]);
});

test("discussing improvements and selecting an idea are inexpensive text-only turns", async()=>{
  const history=[];
  for(const question of ["What graphs should we add to Overview?", "The second one"]){
    history.push({role:"user",content:question});
    const reply=await answer(env,{messages:history},"Guide",async(_,options)=>{
      const q=JSON.parse(options.body);
      if(q.questions){
        assert.ok(q.questions[0].choices.some(c=>c.value==="suggest"));
        return decision(q,"suggest","No matching source area.");
      }
      assert.equal(q.model,model);
      assert.ok(q.max_output_tokens<=360);
      assert.deepEqual(JSON.parse(q.input),history);
      assert.match(q.instructions,/ask whether to implement/);
      return respond("Would you like to prepare this change?");
    });
    assert.equal(reply.proposal,undefined);
    history.push({role:"assistant",content:reply.content});
  }
});

test("administrator identity questions routed by meaning open the protected directory",async()=>{
  let requests=0;
  const reply=await answer(env,{messages:[{role:"user",content:"Who has the keys to manage SHAMROCK?"}]},"Guide",async(_,options)=>{
    requests++;
    const q=JSON.parse(options.body);
    if(!q.questions){
      assert.match(q.input,/permissionManager/);return respond("The live panel accounts are listed below.");
    }
    assert.ok(q.questions.find(x=>x.name==="dataset").choices.some(x=>x.value==="administrators"));
    return Response.json({answers:Object.entries({route:"report",dataset:"administrators"})
      .map(([name,choice])=>({type:"choice",name,choice}))});
  },null,null,null,async()=>({administrators:[{name:"Private fixture"}]}));
  assert.equal(requests,2);
  assert.ok(reply.adminDirectory);
});

test("access follow-ups explain the referenced accounts without listing the directory again",async()=>{
  const history=[{role:"user",content:"Which users are administrators?"},{role:"assistant",content:"SHAMROCK administrators"},{role:"user",content:"Who is sample-reader?"}];
  const result=await answer(env,{messages:history},"Guide",async(_,opts)=>{
    const q=JSON.parse(opts.body);
    if(q.questions)return Response.json({answers:["route:report","dataset:administrators"].map(pair=>{
      const [name,choice]=pair.split(":");return {type:"choice",name,choice};
    })});
    const {access}=JSON.parse(q.input);
    assert.deepEqual(access.panel[0].mentionedAs,["sample-reader"]);
    assert.equal(access.panel[0].linkedDirectoryPerson,false);
    assert.ok(!q.input.includes("private fixture"));
    return respond("This panel account has no linked Directory person.");
  },null,null,null,async()=>({administrators:[{principalId:"sample-reader",name:"private fixture"}]}));
  assert.equal(result.adminDirectory,undefined);
});

test("an access change with a copied UI suffix resolves the named cadet without dispatching code",async()=>{
  const result=await answer(env,{messages:[{role:"user",content:"make Sample Cadet an administratorsvg"}]},"Guide",async(_,opts)=>{
    const q=JSON.parse(opts.body);assert.equal(q.model,model);
    assert.equal(JSON.parse(q.input).matchingFullNamesInActiveDirectory,1);
    return respond("Which access should Sample Cadet receive?");
  },null,null,async()=>[{first:"Sample",last:"Cadet"}],async()=>({administrators:[]}));
  assert.equal(result.proposal,undefined);
});
