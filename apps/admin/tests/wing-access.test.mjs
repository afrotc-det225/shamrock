import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readdirSync,readFileSync} from "node:fs";
import {applyWingGrant,prepareWingGrant,schoolWingAccess} from "../hosted/wing-access.mjs";
import {sha} from "../hosted/auth.mjs";
import {answer} from "../hosted/openai-assistant.mjs";

test("a chat request, owner approval and verified school account resolve the same Wing grant",async()=>{
  const conn=new DatabaseSync(":memory:");
  const folder=new URL("../../../database/migrations/",import.meta.url);
  for(const f of readdirSync(folder).filter(f=>f.endsWith(".sql")).sort())conn.exec(readFileSync(new URL(f,folder),"utf8"));
  const db={prepare(query){return {bind(...args){const s=conn.prepare(query);return {first:()=>s.get(...args),run:()=>s.run(...args)};}};},
    batch(statements){conn.exec("BEGIN");try{statements.forEach(s=>s.run());conn.exec("COMMIT");}catch(e){conn.exec("ROLLBACK");throw e;}}};
  const host="https://shamrock.det225.workers.dev",store=new Map();
  const env={DB:db,GENERATION:"1",ENVIRONMENT:"staging",STAGING_DATASET:"real",APP_ORIGIN:host,BACKEND_ORIGIN:host,BACKEND_SERVICE_NAME:"shamrock",
    HISTORY_FILES:{put:(k,v)=>store.set(k,v),get:k=>JSON.parse(store.get(k)??"null")},PANEL_DB:{reserveAssistant:async()=>true}};
  conn.exec(`INSERT INTO system_control VALUES(1,'staging',1,1);
    INSERT INTO principals VALUES('owner',null,1);INSERT INTO permission_managers VALUES('owner',1);
    INSERT INTO people VALUES('cadet','Fixture Cadet');
    INSERT INTO directory_profiles(person_id,version,last_name,first_name,as_year,rank,role,university,email,phone,dorm,cip_broad_area,cip_code,afsc,home_town,home_state,class_year,flight_path_status,photo_link,updated_at)
    VALUES('cadet',1,'Cadet','Fixture','','','','','fixture@example.invalid','','','','','','','','','Ready','','now')`);
  const prepare=()=>prepareWingGrant(env,"owner","cadet",sha);
  const {wingGrant,content}=await answer(env,{messages:[{role:"user",content:"Make Fixture Cadet an administrator"}]},"Guide",
    async(_,opts)=>{assert.equal(JSON.parse(opts.body).text.format.name,"access_request");return Response.json({output:[{type:"message",content:[{type:"output_text",text:'{"intent":"grant_wing","target":"Fixture Cadet"}'}]}]});},
    null,null,async()=>[{first:"Fixture",last:"Cadet",id:"cadet"}],async()=>({administrators:[]}),prepare);
  assert.match(content,/fixture@example.invalid/);
  const principal="school."+await sha("fixture@example.invalid");
  assert.equal(await schoolWingAccess(db,principal,"fixture@example.invalid"),false);
  await assert.rejects(applyWingGrant(env,"someone-else",wingGrant.id));
  conn.exec("UPDATE system_control SET accepting_commands=0");
  await assert.rejects(applyWingGrant(env,"owner",wingGrant.id));
  conn.exec("UPDATE system_control SET accepting_commands=1;UPDATE directory_profiles SET version=2");
  await assert.rejects(applyWingGrant(env,"owner",wingGrant.id));
  const {wingGrant:{id}}=await prepare();
  conn.exec("UPDATE permission_managers SET active=0");
  await assert.rejects(applyWingGrant(env,"owner",id));
  conn.exec("UPDATE permission_managers SET active=1");
  for(let i=0;i<2;i++)assert.deepEqual(await applyWingGrant(env,"owner",id),{complete:true});
  assert.equal(await schoolWingAccess(db,principal,"fixture@example.invalid"),true);
  assert.equal(await schoolWingAccess(db,principal,"someone@example.invalid"),false);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM admin_grants").get().n,5);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM permission_managers").get().n,1);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM admin_audit_events").get().n,1);
  conn.close();
});
