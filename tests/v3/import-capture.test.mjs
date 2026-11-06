import test from 'node:test';
import assert from 'node:assert/strict';
import {captureLegacySources,captureRanges,importDigest} from '../../scripts/lib/import-capture.mjs';

const manifest={formatVersion:1,resources:[{key:'backend',role:'backend',kind:'workbook',providerId:'fictional-book',expectedTitle:'Fictional backend'},{key:'attendance-form',role:'attendance',kind:'form',providerId:'fictional-form'}]};
const metadata={spreadsheetId:'fictional-book',properties:{title:'Fictional backend'},sheets:[{properties:{sheetId:0,title:"Sheet's data",gridProperties:{rowCount:4,columnCount:2}}}]};
function provider(){return {file:async()=>({version:'1'}),workbook:async()=>metadata,grid:async()=>({rowData:[{values:[{userEnteredValue:{stringValue:'Header'}}]},{values:[{userEnteredValue:{formulaValue:'=1+1'},effectiveValue:{numberValue:2},chipRuns:[{chip:{richLinkProperties:{uri:'https://drive.google.com/file/d/fictional/view'}}}]}]}]}),form:async()=>({formId:'fictional-form'}),responses:async()=>({responses:[{responseId:'fictional-response',lastSubmittedTime:'2026-01-01T00:00:00Z',answers:{question:{textAnswers:{answers:[{value:'Fictional answer'}]}}}}]})};}
test('capture preserves sparse typed values, actual chip evidence, native response IDs and explicit empty grid rows',async()=>{
  const result=await captureLegacySources({manifest,port:provider(),now:()=> '2026-01-02T00:00:00Z'});
  assert.equal(result.consistent,true);assert.equal(result.writerFence,false);assert.equal(result.passes,1);
  assert.equal(result.resources[0].sheets[0].rows.length,4);
  assert.equal(result.resources[0].sheets[0].rows[1][0].userEnteredValue.formulaValue,'=1+1');
  assert.match(result.resources[0].sheets[0].rows[1][0].chipRuns[0].chip.richLinkProperties.uri,/fictional/);
  assert.equal(result.resources[1].responses[0].responseId,'fictional-response');
  const {snapshotSha256,...body}=result;assert.equal(importDigest(body),snapshotSha256);
});
test('capture retries only a resource whose Drive version drifts across the full window',async()=>{
  const port=provider();let reads=0,bookReads=0;
  port.file=async id=>({version:id==='fictional-book'&&++reads>=4?'2':'1'});
  port.workbook=async()=>{bookReads++;return metadata;};
  const result=await captureLegacySources({manifest,port});assert.equal(result.consistent,true);assert.equal(result.passes,2);assert.equal(bookReads,2);
});
test('Forms content drift is detected even with an unchanged Drive version',async()=>{
  const port=provider();let n=0;port.responses=async()=>({responses:[{responseId:'same-response',answer:++n<3?'before':'after'}]});
  const result=await captureLegacySources({manifest,port});assert.equal(result.consistent,true);assert.equal(result.passes,2);assert.equal(result.resources[1].responses[0].answer,'after');
});
test('unending edits produce explicitly inconsistent evidence, never a usable snapshot',async()=>{
  const port=provider();let n=0;port.file=async()=>({version:String(++n)});
  const result=await captureLegacySources({manifest,port,maxPasses:2});assert.equal(result.consistent,false);assert.equal(result.passes,2);
});
test('capture refuses wrong binding, oversized grids, repeated pages and duplicate response IDs',async()=>{
  const wrong=provider();wrong.workbook=async()=>({...metadata,spreadsheetId:'wrong'});await assert.rejects(captureLegacySources({manifest,port:wrong}),/CAPTURE_RESOURCE_BINDING/);
  assert.throws(()=>captureRanges({...metadata,sheets:[{properties:{sheetId:0,title:'Big',gridProperties:{rowCount:50001,columnCount:2}}}]}),/CAPTURE_GRID_BOUND/);
  const paging=provider();paging.responses=async()=>({responses:[],nextPageToken:'same'});await assert.rejects(captureLegacySources({manifest,port:paging}),/CAPTURE_FORM_PAGING/);
  const duplicates=provider();duplicates.responses=async()=>({responses:[{responseId:'duplicate'},{responseId:'duplicate'}]});await assert.rejects(captureLegacySources({manifest,port:duplicates}),/CAPTURE_RESPONSE_ID_COLLISION/);
});
