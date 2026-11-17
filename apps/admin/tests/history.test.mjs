import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {HostedBackend} from '../hosted/backend.mjs';
await build({absWorkingDir:resolve(import.meta.dirname,'../../..'),entryPoints:['apps/admin/history-client.ts'],outfile:'.build/admin/history-client.mjs',bundle:true,platform:'browser',format:'esm'});
const {loadHistory}=await import('../../../.build/admin/history-client.mjs');
function archive(){
 const binding={contractVersion:'legacy-history-pages-v1',snapshotId:'archive-one',sourceSnapshotSha256:'a'.repeat(64),importedAt:'2026-11-06T12:00:00Z'};
 const credit={stored:.75,calculated:null,matches:null,excludedEventIds:[],policyVersion:'unavailable'};
 const row={rowId:'old-one',personId:null,identityStatus:'unresolved',firstName:'Historical',lastName:'Cadet',overall:credit,llab:credit,cells:[{eventId:'old-event',canonicalEventId:null,code:'UR'}]};
 return {
  manifest:{...binding,section:'manifest',rowCount:1,rosterCount:0,report:{snapshotId:binding.snapshotId,eventColumns:[{snapshotEventId:'old-event',header:'Old LLAB'}],readOnly:true}},
  roster:{...binding,section:'roster',offset:0,nextOffset:null,rows:[]},
  rows:{...binding,section:'rows',offset:0,nextOffset:null,rows:[{sourceRowIndex:2,row,diagnostics:[]}]},
  verify:{...binding,section:'verify',verified:true},
 };
}
test('history browser preserves literal historical codes, unlinked people and saved percentages',async()=>{
 const pages=archive(),calls=[];
 const report=await loadHistory('archive-one',async(path,input)=>{calls.push(input.section);return pages[input.section];});
 assert.deepEqual(calls,['manifest','roster','rows','verify']);
 assert.equal(report.rows[0].cells[0].code,'UR');assert.equal(report.rows[0].overall.stored,.75);assert.equal(report.summary.unresolvedRows,1);
});
test('history browser refuses changed archives and nonadvancing cursors',async()=>{
 const pages=archive();pages.verify.sourceSnapshotSha256='b'.repeat(64);
 await assert.rejects(()=>loadHistory('archive-one',async(_,input)=>pages[input.section]),/INVALID_HISTORY_PAGE_SEQUENCE/);
 pages.rows.nextOffset=0;
 await assert.rejects(()=>loadHistory('archive-one',async(_,input)=>pages[input.section]),/changed while loading/);
});
test('history proxy gates actual administrator both before and after every private read',async()=>{
 const backend=Object.create(HostedBackend.prototype);backend.identity=()=>({principalId:'verified-admin',environment:'staging',generation:1});
 let calls=0,authorized=false;
 backend.panelManifest=async()=>({access:{capabilities:{fullSnapshot:authorized}},revision:{version:1}});
 backend.post=async()=>{calls++;return {snapshots:[]};};
 await assert.rejects(()=>backend.historyPage(null),e=>e.status===403);assert.equal(calls,0);
 authorized=true;backend.post=async(path,input)=>{assert.equal(input.principalId,'verified-admin');authorized=false;calls++;return {snapshots:['private']};};
 await assert.rejects(()=>backend.historyPage(null),e=>e.code==='SNAPSHOT_CHANGED');assert.equal(calls,1);
});
