import assert from "node:assert/strict";
import test from "node:test";
import {directoryPortrait} from "../hosted/directory-photo.mjs";
import {drivePhoto, portraitKey} from "../drive-photo.mjs";

test("published portraits require the current Directory association and the viewer's effective access",async()=>{
  const profile={personId:"one",photoLink:"https://drive.google.com/open?id=portrait"};
  const jpeg=Uint8Array.of(255,216,255,217);
  let reads=0, wing=true;
  const expected=await portraitKey("one","portrait");
  const env={VIEW_AS_ENABLED:"1",DB:{prepare:()=>({bind:id=>({all:async()=>({results:id==="one" ? [{photo_link:profile.photoLink}] : [],meta:{rows_read:1}})})})},
    HISTORY_FILES:{get:async key=>{reads++;assert.equal(key,expected);return jpeg.buffer;}}};
  const backend={panelAuthority:async()=>({access:{capabilities:{fullSnapshot:wing}}})};
  const get=(query,principal="owner",preview=null,self=profile)=>directoryPortrait(env,backend,{principal_id:principal},preview,new URLSearchParams(query),async()=>({profile:self}));
  const response=await get({person:"one",file:"portrait"});
  assert.equal(response.headers.get("content-type"),"image/jpeg");
  assert.equal(response.headers.get("X-Shamrock-D1-Rows-Read"),"1");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),jpeg);
  await get({file:"portrait"},"school.fixture");
  await assert.rejects(get({person:"two",file:"portrait"}),{status:404});
  await assert.rejects(get({file:"other"},"school.fixture"),{status:404});
  await assert.rejects(get({file:"portrait"},"school.fixture",null,null),{status:403});
  await assert.rejects(get({person:"one",file:"portrait"},"school.fixture"),{status:403});
  await assert.rejects(get({file:"portrait"},"owner",{status:"starting"}),{status:403});
  const peer={person:"one",file:"portrait",scope:"member"};
  await get(peer,"school.fixture");
  await get(peer,"owner",{status:"ready"});
  await assert.rejects(get(peer,"school.fixture",null,null),{status:403});
  await assert.rejects(get({...peer,file:"stale"},"school.fixture"),{status:404});
  wing=false;
  await assert.rejects(get({person:"one",file:"portrait"},"owner",{status:"ready"}),{status:403});
  profile.photoLink="https://example.org/image";
  await assert.rejects(get({file:"portrait"}),{status:404});
  assert.equal(reads,4);
  assert.equal(drivePhoto("https://example.org/open?id=portrait"),null);
  assert.deepEqual(drivePhoto("https://drive.google.com/file/d/demo/view?resourcekey=key"),{file:"demo",resourceKey:"key"});
});
