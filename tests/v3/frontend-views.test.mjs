import test from 'node:test';
import assert from 'node:assert/strict';
import {planFrontendFlightViews, sameFrontendViews} from '../../.build/v3/apps/google-adapter/src/frontend-views.js';
const input=()=>({sheetId:10,tableId:'attendance-table',headers:['last_name','flight','person_id'],flights:['Alpha','Bravo'],views:[{filterViewId:9,title:'Alpha Flight',tableId:'attendance-table',range:{sheetId:10,endRowIndex:12},filterSpecs:[{columnIndex:1,filterCriteria:{hiddenValues:['Bravo']}}],sortSpecs:[{dimensionIndex:0,sortOrder:'ASCENDING'}]}]});
test('Flight equality excludes a newly added Flight and views follow the whole native Table',()=>{
 const i=input();i.flights.push('Charlie');const p=planFrontendFlightViews(i);
 assert.equal(p.requests.length,3);const alpha=p.views.find(v=>v.title==='Alpha Flight');
 assert.deepEqual(alpha.filterSpecs,[{columnIndex:1,filterCriteria:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:'Alpha'}]}}}]);
 assert.equal(alpha.filterViewId,9);assert.deepEqual(alpha.sortSpecs,i.views[0].sortSpecs);
 assert(p.views.every(v=>v.tableId==='attendance-table'&&!v.range));
 assert.equal(planFrontendFlightViews({...i,views:p.views}).requests.length,0);
});
test('unrelated saved views and sorts are retained; provider-derived extent and legacy criteria normalize',()=>{
 const i=input();i.views.push({filterViewId:88,title:'My review',range:{sheetId:10,endRowIndex:20},filterSpecs:[],sortSpecs:[{dimensionIndex:0,sortOrder:'DESCENDING'}]});
 const p=planFrontendFlightViews(i);assert.deepEqual(p.views.find(v=>v.filterViewId===88),i.views[1]);
 const read=structuredClone(p.views);for(const v of read)if(v.tableId){v.range={sheetId:10,endRowIndex:100};v.criteria={'1':v.filterSpecs[0].filterCriteria};}
 assert(sameFrontendViews(p.views,read));read.find(v=>v.title==='Alpha Flight').filterSpecs[0].filterCriteria.condition.values[0].userEnteredValue='Bravo';assert(!sameFrontendViews(p.views,read));
});
test('ambiguous managed names, rebound Tables, custom multi-field views and identifier collisions fail closed',()=>{
 for(const mutate of [i=>i.views.push({...i.views[0],filterViewId:10}),i=>i.views[0].tableId='another',i=>i.views[0].filterSpecs.push({columnIndex:0,filterCriteria:{hiddenValues:['Name']}}),i=>i.views[0].filterSpecs[0].filterCriteria={condition:{type:'TEXT_EQ',values:[{userEnteredValue:'Bravo'}]}},i=>i.flights.push('Alpha')]){const i=input();mutate(i);assert.throws(()=>planFrontendFlightViews(i));}
 const i=input(),generated=planFrontendFlightViews(i).views.find(v=>v.title==='Bravo Flight');i.views.push({...generated,title:'Unrelated'});assert.throws(()=>planFrontendFlightViews(i));
});
