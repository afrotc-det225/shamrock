import test from "node:test";
import assert from "node:assert/strict";
import {checkChatId,readChats,saveTurn} from "../hosted/chat-history.mjs";

test("saved exchanges expire, reopen in order and stay isolated by owner",async()=>{
  const values=new Map();
  const store={
    put(key,value,{metadata,expirationTtl}){
      assert.equal(expirationTtl,90*86400);
      values.set(key,{metadata,value:JSON.parse(value)});
    },
    list({prefix}){return {list_complete:true,keys:[...values.keys()].sort().filter(k=>k.startsWith(prefix)).map(name=>({name,metadata:values.get(name).metadata}))};},
    get(keys){return new Map(keys.map(k=>[k,values.get(k).value]));}
  };
  const id=checkChatId(crypto.randomUUID());
  assert.throws(()=>checkChatId("../other"));
  await saveTurn(store,"one/",id,"First","Question",{content:"First reply"});
  await new Promise(resolve=>setTimeout(resolve,2));
  await saveTurn(store,"one/",id,"First","Follow-up",{content:"Second reply",proposal:{summary:"example"}});
  assert.equal((await readChats(store,"one/")).chats.length,1);
  const {messages}=await readChats(store,"one/",id);
  assert.deepEqual(messages.map(row=>row.content),["Question","First reply","Follow-up","Second reply"]);
  assert.equal(messages[3].proposal.summary,"example");
  assert.deepEqual((await readChats(store,"two/",id)).messages,[]);
});
