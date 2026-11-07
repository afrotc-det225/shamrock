import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createNativeRetention} from '../../.build/v3/apps/google-adapter/src/private-retention-native.js';
import {retentionCanonical} from '../../.build/v3/apps/google-adapter/src/private-retention.js';
const sha=x=>createHash('sha256').update(x).digest('hex'),owner='automation@example.invalid';
function fixture(){const fx={files:new Map([['index',{text:retentionCanonical({version:1,environment:'staging',generation:1,buckets:{}}),version:1}],['folder',{folder:true,version:1}]]),next:0,calls:[],lost:false,extraReader:false};
 const response=(text,status=200)=>({getResponseCode:()=>status,getContentText:()=>text});
 const services={ScriptApp:{getOAuthToken:()=> 'fixture-token'},UrlFetchApp:{fetch(url,o){fx.calls.push({url,method:o.method});assert.equal(o.headers.Authorization,'Bearer fixture-token');const u=new URL(url),id=u.pathname.split('/').at(-1);
   if(id==='generateIds')return response(JSON.stringify({ids:Array.from({length:Number(u.searchParams.get('count'))},()=>`reserved-${fx.next++}`)}));
   if(o.method==='post'){assert.equal(u.searchParams.get('uploadType'),'multipart');const boundary=o.contentType.split('boundary=')[1],parts=o.payload.split('--'+boundary),metadata=JSON.parse(parts[1].split('\r\n\r\n')[1]),text=parts[2].split('\r\n\r\n')[1].replace(/\r\n$/,'');
     assert.match(metadata.id,/^reserved-\d+$/);assert.deepEqual(metadata.parents,['folder']);assert(['SHAMROCK retention index','SHAMROCK retained evidence'].includes(metadata.name));
     if(fx.files.has(metadata.id))return response('{}',409);fx.files.set(metadata.id,{text,version:1});if(fx.lost&&metadata.name==='SHAMROCK retained evidence'){fx.lost=false;return response('{}',503);}return response(JSON.stringify({id:metadata.id}),201);
   }
   const file=fx.files.get(id);if(!file)return response('{}',404);
   if(o.method==='patch'){file.text=o.payload;file.version++;return response(JSON.stringify({id}));}
   if(u.searchParams.get('alt')==='media')return response(file.text);
   // Real Drive may advance metadata-only version numbers even when the content is unchanged.
   return response(JSON.stringify({id,mimeType:file.folder?'application/vnd.google-apps.folder':'application/json',size:Buffer.byteLength(file.text??''),version:String(++file.version),parents:file.folder?[]:['folder'],owners:[{emailAddress:owner}],permissions:[{type:'user',role:'owner',emailAddress:owner},...(fx.extraReader?[{type:'anyone',role:'reader'}]:[])]}));
 }}};
 const open=()=>createNativeRetention(services,{version:1,archiveFolderId:'folder',indexFileId:'index'},owner,1,{sha256:sha});return{fx,open};
}
test('native retention uses reserved Drive IDs, owner-only storage, literal JSON and metadata-drift-safe checkpoints',()=>{
 const f=fixture(),store=f.open(),value={privateEvidence:'x'.repeat(4000)};store.put([{key:'opaque-receipt',value}]);assert.deepEqual(f.open().get('opaque-receipt'),value);assert(f.fx.calls.some(c=>c.url.includes('generateIds')));assert(f.fx.calls.every(c=>!c.url.includes('/permissions')));
 f.fx.extraReader=true;assert.throws(()=>f.open().get('opaque-receipt'),/owned and readable only/);
});
test('an ambiguous native create keeps the reserved object and a fresh invocation verifies it without another file',()=>{
 const f=fixture(),value={privateEvidence:'z'.repeat(3000)};f.fx.lost=true;assert.throws(()=>f.open().put([{key:'receipt',value}]),/same saved ID/);const count=f.fx.files.size;assert.deepEqual(f.open().get('receipt'),value);assert.equal(f.fx.files.size,count);
});
