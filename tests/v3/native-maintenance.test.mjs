import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac} from 'node:crypto';
import {createNativeMaintenanceRuntime,nativeArchiveTables} from '../../.build/v3/apps/google-adapter/src/native-maintenance.js';
import {parseNativeMaintenanceConfig,MAINTENANCE_PROPERTIES as M} from '../../.build/v3/apps/google-adapter/src/maintenance-config.js';
const hash=v=>createHash('sha256').update(v).digest('hex'), copy=v=>structuredClone(v), owner='automation@example.invalid';
const config={version:1,environment:'staging',generation:1,enabled:true,resourceReview:'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING',principalId:'automation',workerId:'maintenance-adapter',sourceResource:'maintenance-source',stateFileId:'maintenance-state',archiveSpreadsheetId:'maintenance-archive',archiveExpectedTitle:'SHAMROCK staging private archives'};
function fixture(){
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://worker.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'private-journal',sheetId:1},attendance:{formId:'attendance',resourceKey:'attendance-source',itemRoles:{event:'1',scope:'2',present:['3'],completeness:'4'}}};
 const map={SHAMROCK_V3_MAINTENANCE_CONFIG:JSON.stringify(config)};
 const snapshot={contractVersion:1,environment:'staging',generation:1,revision:{operations:0,administration:0},people:[],leadership:[],flights:[],squadrons:[],terms:[{termId:'current',label:'Fictional term',sortOrder:1,isCurrent:true}],events:[],observations:[],corrections:[],requests:[],attendanceVersions:[],diagnostics:[]};
 const claim={transitionId:'transition',asOfDate:'2026-11-06',snapshotHash:hash(JSON.stringify(snapshot)),planHash:'a'.repeat(64),claimToken:'token',leaseExpiresAt:new Date(1800000600*1000).toISOString(),snapshot};
 const properties={SHAMROCK_V3_HOST_CONFIG:JSON.stringify(host),SHAMROCK_V3_CONFIG_FILE_ID:'private-config',SHAMROCK_V3_BRIDGE_SECRET:'fictional-maintenance-bridge-signing-material'};
 const f={map,claim,properties,state:{version:1,environment:'staging',generation:1},stateVersion:1,archiveVersion:1,sheets:[],calls:[],writes:0,ack:0,active:owner,shared:false,loseWrite:false,gridFormula:false};
 const metadata=id=>({id,name:id==='maintenance-archive'?config.archiveExpectedTitle:id,mimeType:id==='maintenance-archive'?'application/vnd.google-apps.spreadsheet':'application/json',size:String(JSON.stringify(id==='private-config'?map:f.state).length),version:String(id==='maintenance-state'?f.stateVersion:f.archiveVersion),owners:[{emailAddress:owner}]});
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>properties[k]=v})},Session:{getEffectiveUser:()=>({getEmail:()=>owner}),getActiveUser:()=>({getEmail:()=>f.active})},ScriptApp:{getOAuthToken:()=> 'fictional-oauth'},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()]},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},UrlFetchApp:{fetch(raw,options){
  f.calls.push(raw);const url=new URL(raw),body=options.payload?JSON.parse(options.payload):undefined;let result;
  if(url.hostname==='worker.example.invalid'){
   if(url.pathname.endsWith('/claim'))result=claim;
   else if(url.pathname.endsWith('/ack')){f.ack++;result={status:'done'};}
   else if(url.pathname.endsWith('/commands'))result={status:'accepted'};
   else throw Error('Unexpected Worker request');
  }else if(url.hostname==='www.googleapis.com'){
   const id=url.pathname.split('/').filter(Boolean).at(-1)==='permissions'?url.pathname.split('/').at(-2):url.pathname.split('/').at(-1);
   if(url.pathname.endsWith('/permissions'))result={permissions:[{type:'user',role:'owner',emailAddress:owner},...(f.shared?[{type:'anyone',role:'reader'}]:[])]};
   else if(options.method==='patch'){f.state=copy(body);f.stateVersion++;result={id,version:String(f.stateVersion)};}
   else if(url.searchParams.get('alt')==='media')result=id==='private-config'?map:f.state;
   else result=metadata(id);
  }else if(url.pathname.endsWith(':batchUpdate')){
   for(const request of body.requests){
    if(request.addSheet){const properties=copy(request.addSheet.properties);f.sheets.push({properties,protectedRanges:[],tables:[],cells:[]});}
    if(request.addProtectedRange){const p=request.addProtectedRange.protectedRange;f.sheets.find(s=>s.properties.sheetId===p.range.sheetId).protectedRanges.push(copy(p));}
    if(request.updateCells){const u=request.updateCells,s=f.sheets.find(s=>s.properties.sheetId===u.start.sheetId);u.rows.forEach((row,i)=>s.cells[u.start.rowIndex+i]=copy(row.values));}
    if(request.addTable){const t=request.addTable.table;f.sheets.find(s=>s.properties.sheetId===t.range.sheetId).tables.push({...copy(t),tableId:'native-'+f.sheets.length});}
   }
   f.archiveVersion++;f.writes++;result={};if(f.loseWrite){f.loseWrite=false;throw Error('ambiguous write');}
  }else if(url.searchParams.has('ranges')){
   const match=/^'(.*)'!A(\d+):[A-Z]+(\d+)$/.exec(url.searchParams.get('ranges'));assert.ok(match);
   const s=f.sheets.find(s=>s.properties.title===match[1]),start=Number(match[2])-1,end=Number(match[3]);
   const rowData=s.cells.slice(start,end).map(values=>({values:copy(values)}));if(f.gridFormula)rowData[0].values[0]={userEnteredValue:{formulaValue:'="forged"'}};
   result={sheets:[{data:[{startRow:start,startColumn:0,rowData}]}]};
  }else result={spreadsheetId:'maintenance-archive',sheets:f.sheets.map(({cells,...s})=>copy(s))};
  return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(result)};
 }}};
 f.runtime=createNativeMaintenanceRuntime(services,()=>1800000000);return f;
}
test('maintenance is opt-in, independently paused, privately owned, and operator commands need active identity',()=>{
 const f=fixture();assert.deepEqual(f.runtime.archive('transition'),{state:'paused'});assert.equal(f.calls.length,0);
 assert.deepEqual(f.runtime.resume(),{status:'enabled',mail:'suppressed'});f.active='other@example.invalid';assert.throws(()=>f.runtime.command({commandId:'command',operation:'transition.prepare',payload:{}}),e=>e.code==='maintenance_actor');
 f.runtime.pause();assert.deepEqual(f.runtime.planNotifications(),{status:'paused'});
 f.shared=true;assert.throws(()=>f.runtime.resume(),e=>e.code==='maintenance_isolation');
 assert.throws(()=>parseNativeMaintenanceConfig({...config,environment:'production'},1));
});
test('native archive retries an ambiguous chunk, writes native Tables and verifies exact literal grid before ACK',()=>{
 const f=fixture();f.runtime.resume();f.loseWrite=true;assert.throws(()=>f.runtime.archive('transition'));
 let result;for(let i=0;i<40;i++){result=f.runtime.archive('transition');if(result.state==='ready-for-reviewed-acceptance')break;assert.equal(f.ack,0);}
 assert.equal(result.state,'ready-for-reviewed-acceptance');assert.equal(f.ack,1);assert.equal(f.sheets.length,5);assert.equal(f.state.archive,undefined);
 assert.equal(f.sheets.filter(s=>s.properties.hidden).length,1);
 for(const sheet of f.sheets){assert.equal(sheet.tables.length,1);assert.equal(sheet.protectedRanges.length,1);}
 const recovery=f.sheets.find(s=>s.properties.hidden),json=recovery.cells.slice(3).map(row=>row[1].userEnteredValue.stringValue).join('');
 assert.deepEqual(JSON.parse(json),f.claim.snapshot);
 const planned=nativeArchiveTables(f.claim,hash);assert.equal(new Set(planned.map(t=>t.sheetId)).size,5);assert.ok(planned.every(t=>t.sheetId<2147483647));
});
test('native archive retains verification progress and rejects formula injection or archive revision changes',()=>{
 for(const mode of ['formula','revision']){
  const f=fixture();f.runtime.resume();let result;
  for(let i=0;i<20;i++){result=f.runtime.archive('transition');if(result.state==='verifying')break;}
  assert.equal(result.state,'verifying');assert.ok(f.state.archive.verificationContinuation);const writes=f.writes;
  if(mode==='formula')f.gridFormula=true;else f.archiveVersion++;
  assert.throws(()=>f.runtime.archive('transition'),e=>e.code===(mode==='formula'?'archive_readback':'archive_changed'));
  assert.equal(f.ack,0);assert.equal(f.writes,writes);assert.ok(f.state.archive);
 }
});
