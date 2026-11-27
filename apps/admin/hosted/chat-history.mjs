import {PanelError} from "../errors.mjs";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function checkChatId(id){
  if(typeof id!=="string" || !uuid.test(id))throw new PanelError("INVALID_REQUEST","Unknown conversation.");
  return id;
}

// One immutable value per completed exchange keeps simultaneous replies from replacing one another.
export async function saveTurn(store,prefix,id,title,question,reply){
  const at=Date.now();
  await store.put(prefix+id+"/"+at+"-"+crypto.randomUUID(),JSON.stringify({question,reply}),{
    expirationTtl:90*86400,metadata:{id,at,title:title.slice(0,90)}
  });
}
export async function readChats(store,prefix,id){
  if(id)prefix+=checkChatId(id)+"/";
  const keys=[];
  let cursor;
  do{
    const page=await store.list({prefix,cursor});
    keys.push(...page.keys);
    cursor=page.list_complete ? undefined : page.cursor;
  }while(cursor);
  if(!id){
    const chats=new Map();
    for(const {metadata} of keys){
      if(!metadata)continue;
      if(!chats.has(metadata.id) || chats.get(metadata.id).at<metadata.at)chats.set(metadata.id,metadata);
    }
    return {chats:[...chats.values()].sort((a,b)=>b.at-a.at)};
  }
  const messages=[];
  for(let i=0;i<keys.length;i+=50){
    const names=keys.slice(i,i+50).map(k=>k.name);
    const turns=await store.get(names,"json");
    for(const name of names){
      const turn=turns.get(name);
      if(turn)messages.push({role:"user",content:turn.question},{role:"assistant",...turn.reply});
    }
  }
  return {messages};
}
