import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createNativeHistoryRuntime,parseNativeHistoryConfig,HISTORY_PROPERTIES as H} from '../../.build/v3/apps/google-adapter/src/history-native.js';
import {historySheetPlan,historyPresentationRequests} from '../../.build/v3/apps/google-adapter/src/history-presentation.js';
import {buildLegacyHistoryReport,legacyHistoryTable} from '../../.build/v3/packages/domain/src/legacy-history.js';
const hash=v=>createHash('sha256').update(v).digest('hex'),copy=v=>structuredClone(v),owner='automation@example.invalid';
const config={version:1,environment:'staging',generation:1,enabled:true,resourceReview:'EXISTING_PRIVATE_HISTORY_REVIEWED_FOR_STAGING',principalId:'history-reader',stateFileId:'history-state',spreadsheetId:'history-book',expectedTitle:'SHAMROCK History',api:{baseUrl:'https://history.example.invalid',keyId:'history-key',secretProperty:'SHAMROCK_V3_HISTORY_READER_SECRET'}};
function source(count=9,snapshotId='archive-one'){
 const columns=['Repeated event','Repeated event'].map((header,i)=>({columnIndex:7+i,header,snapshotEventId:`event-${i}`,eventId:null}));
 const input={snapshotId,sourceSnapshotSha256:'a'.repeat(64),importedAt:'2026-11-06T12:00:00.000Z',metadata:{sourceTitle:'Retained Attendance',periodLabel:'Fall term',isCurrent:false,authority:'retained-source-copy',companionDirectoryFound:false,columns},sourceRoster:[],rows:Array.from({length:count},(_,i)=>({sourceLabels:['=literal source name',String(i),'AS100','Alpha','Blue'],row:{occurrenceId:`source-row-${i}`,personId:null,identityLabels:['=literal source name',String(i),'as100','alpha','blue'],events:columns.map((c,j)=>({...c,code:j?'MUR':'=literal code'})),overall:i===0?'=literal saved percentage':.75,llab:1,creditFormulaEvidence:{overall:null,llab:null,arrayAnchorRowIndex:2},personEvidence:null}}))};
 const report=buildLegacyHistoryReport(input),{rows,sourceRoster,summary,diagnostics,...head}=report,binding={contractVersion:'legacy-history-pages-v1',snapshotId,sourceSnapshotSha256:input.sourceSnapshotSha256,importedAt:input.importedAt};
 return {report,binding,manifest:{...binding,section:'manifest',report:head,rowCount:rows.length,rosterCount:0},entry:{snapshotId,title:report.title,periodLabel:report.periodLabel,isCurrentCapture:false,authority:report.authority,rowCount:rows.length,eventCount:columns.length,unresolvedRows:rows.length,sourceSnapshotSha256:input.sourceSnapshotSha256,importedAt:input.importedAt},page(offset){const entries=rows.slice(offset,offset+8).map(row=>({sourceRowIndex:count-Number(row.rowId.split('-').at(-1))+2,row,diagnostics:diagnostics.filter(d=>d.rowId===row.rowId)}));return {...binding,section:'rows',offset,nextOffset:offset+entries.length<rows.length?offset+entries.length:null,rows:entries};}};
}
function fixture({reports=[source()]}={}){
 const host={version:1,environment:'staging',generation:1,resourceReview:'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',workerOrigin:'https://fictional.example.invalid',keyId:'fixture',expectedAutomationEmail:owner,journal:{spreadsheetId:'private-journal',sheetId:1},attendance:{formId:'attendance',resourceKey:'attendance-source',itemRoles:{event:'1',scope:'2',present:['3'],completeness:'4'}}};
 const properties={SHAMROCK_V3_HOST_CONFIG:JSON.stringify(host),SHAMROCK_V3_CONFIG_FILE_ID:'private-config',SHAMROCK_V3_BRIDGE_SECRET:'fictional-default-bridge-material',SHAMROCK_V3_HISTORY_READER_SECRET:'fictional-readonly-history-bridge-material'};
 const f={map:{[H.config]:JSON.stringify(config)},properties,state:{version:1},stateVersion:1,bookVersion:1,owner,shared:false,loseWrite:false,formula:false,revoke:false,wrongHash:false,externalState:false,calls:[],requests:[],sheets:[{properties:{sheetId:0,title:'Sheet1',gridProperties:{rowCount:1000,columnCount:26}},protectedRanges:[],tables:[],cells:[]}]};
 const services={PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>properties[k]=v})},Session:{getEffectiveUser:()=>({getEmail:()=>f.owner})},ScriptApp:{getOAuthToken:()=> 'fictional-oauth'},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()]},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},UrlFetchApp:{fetch(raw,options){
  const u=new URL(raw),body=options.payload?JSON.parse(options.payload):undefined;f.calls.push({url:raw,body});let result,status=200;
  if(u.hostname==='history.example.invalid'){
   if(f.revoke){status=403;result={code:'NOT_AUTHORIZED'};}else if(u.pathname.endsWith('/list'))result={contractVersion:'legacy-source-report-v1',readOnly:true,snapshots:reports.map(r=>r.entry)};
   else{assert.ok(u.pathname.endsWith('/page'));const r=reports.find(r=>r.entry.snapshotId===body.snapshotId);assert.ok(r);result=body.section==='manifest'?r.manifest:body.section==='verify'?{...r.binding,section:'verify',verified:true}:r.page(body.offset);result=copy(result);if(f.wrongHash)result.sourceSnapshotSha256='b'.repeat(64);if(f.externalState)f.state.operatorNote='keep';}
  }else if(u.hostname==='www.googleapis.com'){
   const id=u.pathname.endsWith('/permissions')?u.pathname.split('/').at(-2):u.pathname.split('/').at(-1);
   if(u.pathname.endsWith('/permissions'))result={permissions:[{type:'user',role:'owner',emailAddress:owner},...(f.shared?[{type:'anyone',role:'reader'}]:[])]};
   else if(options.method==='patch'){f.state=copy(body);f.stateVersion++;result={id,version:String(f.stateVersion)};}
   else if(u.searchParams.get('alt')==='media')result=id==='private-config'?f.map:f.state;
   else result={id,name:id==='history-book'?config.expectedTitle:id,mimeType:id==='history-book'?'application/vnd.google-apps.spreadsheet':'application/json',size:String(JSON.stringify(id==='private-config'?f.map:f.state).length),version:String(id==='history-state'?f.stateVersion:f.bookVersion),owners:[{emailAddress:owner}]};
  }else if(u.hostname==='sheets.googleapis.com'){
   if(u.pathname.endsWith(':batchUpdate')){f.requests.push(...copy(body.requests));for(const req of body.requests){
    if(req.addSheet)f.sheets.push({properties:copy(req.addSheet.properties),protectedRanges:[],tables:[],cells:[]});
    if(req.updateSheetProperties){const p=req.updateSheetProperties.properties,s=f.sheets.find(s=>s.properties.sheetId===p.sheetId);Object.assign(s.properties,copy(p));}
    if(req.addProtectedRange){const p=req.addProtectedRange.protectedRange;f.sheets.find(s=>s.properties.sheetId===p.range.sheetId).protectedRanges.push(copy(p));}
    if(req.addTable){const t=req.addTable.table;f.sheets.find(s=>s.properties.sheetId===t.range.sheetId).tables.push({...copy(t),tableId:'native-'+f.sheets.length});}
    if(req.updateCells){const r=req.updateCells,s=f.sheets.find(s=>s.properties.sheetId===r.start.sheetId);r.rows.forEach((row,i)=>{const out=s.cells[r.start.rowIndex+i]??=[];row.values.forEach((cell,j)=>{out[r.start.columnIndex+j]={...out[r.start.columnIndex+j],...copy(cell)};});});}
   }f.bookVersion++;result={};if(f.loseWrite||f.losePublish&&body.requests.some(r=>r.updateSheetProperties?.properties.hidden===false)){f.loseWrite=false;f.losePublish=false;throw Error('ambiguous provider write');}}
   else if(u.searchParams.has('ranges')){const m=/^'(.*)'!A(\d+):[A-Z]+(\d+)$/.exec(u.searchParams.get('ranges'));assert.ok(m);const s=f.sheets.find(s=>s.properties.title===m[1]),start=Number(m[2])-1,end=Number(m[3]);const rowData=Array.from({length:end-start},(_,i)=>({values:copy(s.cells[start+i]??[])}));if(f.formula&&s.properties.sheetId!==0)rowData[0].values[0]={userEnteredValue:{formulaValue:'="forged"'}};result={sheets:[{data:[{startRow:start,startColumn:0,rowData}]}]};}
   else result={spreadsheetId:'history-book',sheets:f.sheets.map(({cells,...s})=>copy(s))};
  }else throw Error('Unexpected resource');return {getResponseCode:()=>status,getContentText:()=>JSON.stringify(result)};
 }}};
 f.runtime=createNativeHistoryRuntime(services,()=>1800000000);f.enable=()=>{const set=f.runtime.setup();f.runtime.resume(set.bindingHash);};f.finish=()=>{let result;for(let i=0;i<100;i++){result=f.runtime.run();if(result.state==='complete')return result;}throw Error('History did not finish');};return f;
}
test('history is default-paused, owner-only and uses a reviewed separate read-only API binding',()=>{
 const f=fixture();assert.deepEqual(f.runtime.run(),{state:'paused'});assert.equal(f.calls.length,0);const setup=f.runtime.setup();assert.match(setup.bindingHash,/^[a-f0-9]{64}$/);assert.throws(()=>f.runtime.resume('wrong'),e=>e.code==='history_native');f.runtime.resume(setup.bindingHash);f.runtime.run();assert.ok(f.calls.some(c=>c.url.startsWith('https://history.example.invalid')));assert.ok(!f.calls.some(c=>c.url.startsWith('https://fictional.example.invalid')));f.runtime.pause();assert.deepEqual(f.runtime.run(),{state:'paused'});
 for(const change of [{environment:'production'},{api:null},{api:{...config.api,secretProperty:'SHAMROCK_V3_BRIDGE_SECRET'}}])assert.throws(()=>parseNativeHistoryConfig({...config,...change},1));
 f.owner='outsider@example.invalid';assert.throws(()=>f.runtime.setup());f.owner=owner;f.shared=true;assert.throws(()=>f.runtime.setup(),/exactly one owner/);
});
test('native history retains literal values, source order, unresolved rows and native compact protected Tables',()=>{
 const r=source(),f=fixture({reports:[r]});f.enable();assert.equal(f.finish().completed,1);const plan=historySheetPlan(r.manifest,hash),s=f.sheets.find(s=>s.properties.sheetId===plan.sheetId);assert.equal(s.properties.hidden,false);assert.equal(s.tables.length,1);assert.equal(s.protectedRanges.length,1);
 const actual=s.cells.slice(2).map(row=>row.map(c=>c.userEnteredValue?.stringValue??c.userEnteredValue?.numberValue??c.userEnteredValue?.boolValue??null));assert.deepEqual(actual,legacyHistoryTable(r.report).rows.reverse());assert.ok(s.cells[2][0].note.includes('identity needs review'));assert.notEqual(plan.labels[7],plan.labels[8]);assert.ok(s.cells[1][8].note.includes('Repeated event'));
 assert.ok(f.requests.some(r=>r.updateDimensionProperties?.properties.pixelSize===21));assert.ok(f.requests.some(r=>r.updateDimensionProperties?.range.dimension==='COLUMNS'&&r.updateDimensionProperties.properties.pixelSize===75));assert.ok(f.requests.some(r=>r.updateDimensionProperties?.range.startIndex===plan.hiddenStart&&r.updateDimensionProperties.properties.hiddenByUser===true));assert.ok(!f.requests.some(r=>r.setDataValidation));
 const index=f.sheets.find(s=>s.properties.sheetId===0);assert.equal(index.properties.title,'History');assert.ok(index.cells[2][0].userEnteredFormat.textFormat.link.uri.endsWith('#gid='+plan.sheetId));
 const paths=f.calls.filter(c=>c.url.startsWith('https://history.example.invalid')).map(c=>new URL(c.url).pathname);assert.ok(paths.every(p=>['/v1/admin/history/list','/v1/admin/history/page'].includes(p)));assert.ok(!paths.includes('/v1/admin/history/read'));
});
test('history resumes ambiguous sheet writes without duplicate Tables and only publishes after complete verification',()=>{
 const f=fixture();f.enable();f.runtime.run();f.runtime.run();assert.equal(f.state.phase,'write');f.loseWrite=true;assert.throws(()=>f.runtime.run(),/unknown result/);assert.equal(f.state.phase,'write');assert.equal(f.sheets.filter(s=>s.properties.hidden).length,1);f.finish();assert.equal(f.sheets.length,2);assert.ok(f.sheets.every(s=>s.tables.length===1));
});
test('a lost final publication response resumes by rechecking every literal page before confirming completion',()=>{
 const f=fixture();f.enable();f.losePublish=true;assert.throws(()=>f.finish(),/unknown result/);assert.equal(f.state.phase,'publish');assert.equal(f.state.completed,0);const calls=f.calls.length;assert.equal(f.finish().completed,1);const rows=f.calls.slice(calls).filter(c=>c.body?.section==='rows');assert.equal(rows.length,2);assert.equal(f.sheets.length,2);assert.ok(f.sheets.every(s=>s.tables.length===1));
});
test('history pauses on reader revocation, changed source hash, a formula, or content changes during verification',()=>{
 for(const mode of ['revoke','wrongHash','formula','version']){const f=fixture();f.enable();while(f.state.phase!=='verify')f.runtime.run();if(mode==='version')f.bookVersion++;else f[mode]=true;assert.throws(()=>f.runtime.run());assert.equal(f.state.phase,'verify');assert.equal(f.sheets.filter(s=>s.properties.hidden).length,1);}
});
test('history preserves external checkpoint edits and rejects sharing changes before continuing',()=>{
 const f=fixture();f.enable();f.externalState=true;assert.throws(()=>f.runtime.run(),e=>e.code==='private_checkpoint_changed');assert.equal(f.state.operatorNote,'keep');assert.equal(f.sheets.length,1);
 const g=fixture();g.enable();g.runtime.run();g.shared=true;assert.throws(()=>g.runtime.run(),/exactly one owner/);assert.equal(g.sheets.length,1);
});
test('six distinct source reports remain separate despite reused period labels and empty reports retain a native Table',()=>{
 const reports=Array.from({length:6},(_,i)=>source(i===0?0:1,`archive-${i}`)),f=fixture({reports});f.enable();assert.deepEqual(f.finish(),{state:'complete',completed:6,reports:6});assert.equal(f.sheets.length,7);assert.equal(new Set(f.sheets.map(s=>s.properties.title)).size,7);assert.ok(f.sheets.every(s=>s.tables.length===1));assert.equal(f.sheets.filter(s=>s.properties.hidden).length,0);
 const requests=historyPresentationRequests(reports[0].manifest,historySheetPlan(reports[0].manifest,hash),owner);assert.ok(requests.some(r=>r.addTable?.table.range.endRowIndex===3));
});
