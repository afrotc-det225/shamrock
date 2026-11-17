import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogLegendBindings,readCatalogLegend,planCatalogLegend,catalogLegendMatches,assertCatalogLegendPlan,refreshCatalogValidation} from '../../.build/v3/apps/google-adapter/src/frontend-catalog-legend.js';
import {planFrontendPublication,frontendLiteralCell} from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
const copy=v=>structuredClone(v), literal=userEnteredValue=>({userEnteredValue:{stringValue:userEnteredValue}});
function fixture(){
 const rule=(column,chip)=>({strict:true,...(chip?{showCustomUi:true}:{}),condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='Data Legend'!$${column}$3:$${column}`}]}});
 const seeds=['flight','squadron'].map((field,i)=>({key:`directory:${field}`,sheetId:7,rowIndex:2,columnIndex:18+i,protected:true,hidden:true,nativeStyleVersion:'reviewed-native',expectedRule:rule(i?'C':'B',!i),observedRule:rule(i?'C':'B',!i)}));
 const props=[{columnIndex:0,columnName:'Identity',columnType:'TEXT'},{columnIndex:1,columnName:'Flight',columnType:'DROPDOWN',dataValidationRule:{condition:{type:'ONE_OF_LIST',values:[{userEnteredValue:'Alpha'},{userEnteredValue:'Retired'}]}}},{columnIndex:2,columnName:'Squadron',columnType:'TEXT'}];
 const metadata={sheets:[{properties:{sheetId:7,title:'Data Legend',hidden:true,gridProperties:{rowCount:70,columnCount:29}},tables:[{tableId:'legend',range:{sheetId:7,startRowIndex:1,endRowIndex:70,startColumnIndex:0,endColumnIndex:29},columnProperties:[{columnIndex:1,columnName:'Flight Options'},{columnIndex:2,columnName:'Squadron Options'}]}]},
  {properties:{sheetId:1,title:'Directory'},tables:[{tableId:'directory',range:{sheetId:1,startRowIndex:1,endRowIndex:5,startColumnIndex:0,endColumnIndex:3},columnProperties:props}]}]};
 const cells={sheets:[{properties:{sheetId:7},data:[{startRow:2,startColumn:1,rowData:[{values:[literal('Alpha')]},{values:[literal('Retired')]}]},{startRow:2,startColumn:2,rowData:[{values:[literal('Blue')]},{values:[literal('Gold')]}]}]}]};
 const args={seeds,metadata,tables:[{sheetId:1,tableId:'directory',headers:['person_id','flight','squadron']}],businessSheetIds:[1,2,3],readCells:bindings=>{assert.deepEqual(bindings.map(b=>b.range.endRowIndex),[70,70]);return copy(cells);}};
 return {seeds,metadata,cells,args,read:()=>readCatalogLegend(args)};
}
const snapshot={flights:[{flightId:'alpha',label:'Alpine'},{flightId:'bravo',label:'Bravo'}],squadrons:[{squadronId:'blue',label:'Blue'},{squadronId:'gold',label:'Gold'}]};
test('catalog rename and new Flight publish literal source choices and existing Table dropdown lists only',()=>{
 const f=fixture(),before=f.read(),plan=planCatalogLegend(snapshot,before);assertCatalogLegendPlan(plan);
 assert.deepEqual(plan.expectedAfter.columns.map(c=>c.values),[['Alpine','Bravo'],['Blue','Gold']]);
 const cells=plan.requests.filter(r=>r.updateCells);assert.equal(cells.length,1);assert.deepEqual(cells[0].updateCells.range,{sheetId:7,startRowIndex:2,endRowIndex:4,startColumnIndex:1,endColumnIndex:2});assert.equal(cells[0].updateCells.fields,'userEnteredValue');assert.deepEqual(cells[0].updateCells.rows,[{values:[literal('Alpine')]},{values:[literal('Bravo')]}]);
 const table=plan.requests.find(r=>r.updateTable).updateTable;assert.equal(table.fields,'columnProperties');assert.equal(table.table.columnProperties[1].columnType,'DROPDOWN');assert.deepEqual(table.table.columnProperties[1].dataValidationRule.condition.values,[{userEnteredValue:'Alpine'},{userEnteredValue:'Bravo'}]);assert.deepEqual(table.table.columnProperties[2],before.tables[0].columnProperties[2]);
 assert.ok(catalogLegendMatches(plan,before,'before'));assert.ok(!catalogLegendMatches(plan,before,'after'));assert.ok(catalogLegendMatches(plan,copy(plan.expectedAfter),'after'));
 const retry=planCatalogLegend(snapshot,plan.expectedAfter);assert.deepEqual(retry.requests,[]);
 const tampered=copy(plan);tampered.requests[0].updateCells.fields='userEnteredFormat';assert.throws(()=>assertCatalogLegendPlan(tampered));
 const grown=copy(plan.expectedAfter);grown.tables[0].columnProperties.push({columnIndex:3,columnName:'New event'});grown.tables[0].columnProperties[0].columnName='Changed display header';assert.equal(catalogLegendMatches(plan,grown,'after'),true);grown.tables[0].columnProperties[0].columnType='DATE';assert.equal(catalogLegendMatches(plan,grown,'after'),false);
});
test('retirement clears the complete prior tail, formulas remain literal, and readback notices any stale or mistyped choice',()=>{
 const f=fixture(),plan=planCatalogLegend({...snapshot,flights:[{flightId:'literal',label:'=literal label'}]},f.read()),write=plan.requests[0].updateCells;
 assert.deepEqual(write.rows,[{values:[literal('=literal label')]},{values:[{}]}]);
 const observed=copy(plan.expectedAfter);observed.columns[0].values.push('Retired');assert.equal(catalogLegendMatches(plan,observed,'after'),false);
 observed.columns[0].values=['=literal label'];observed.tables[0].columnProperties[1].columnType='TEXT';assert.equal(catalogLegendMatches(plan,observed,'after'),false);
 f.cells.sheets[0].data[0].rowData[0].values[0]={userEnteredValue:{formulaValue:'=NOW()'}};assert.throws(f.read,/literal/);
});
test('native seed controls keep chip/plain display mode and preserve sorted pending edit targets',()=>{
 const f=fixture(),before=f.read(),legend=planCatalogLegend({...snapshot,squadrons:[{label:'Blue'},{label:'Gold'},{label:'New Squadron'}]},before),columns=[{header:'person_id',label:'ID',editable:false},{header:'flight',label:'Flight',editable:true,seedKey:'directory:flight'},{header:'squadron',label:'Squadron',editable:false,seedKey:'directory:squadron'}];
 const row=key=>({key,values:{person_id:key,flight:'Alpha',squadron:'Blue'},versions:{flight:1}}),a=row('p-a'),b=row('p-b');
 const current={sheetId:1,tableId:'directory',gridRowCount:5,gridColumnCount:3,headers:columns.map(c=>c.header),labels:columns.map(c=>c.label),rows:[['p-b','Bravo','Blue'],['p-a','Alpha','Blue']].map(r=>r.map(frontendLiteralCell)),range:{sheetId:1,startRowIndex:1,endRowIndex:4,startColumnIndex:0,endColumnIndex:3},hiddenColumns:[0],machineRowHidden:true};
 const publication=planFrontendPublication({generation:1,revision:{operations:1,administration:2},table:{kind:'directory',keyHeader:'person_id',columns,rows:[a,b].map(r=>({...copy(r),values:{...r.values,flight:'Alpine'},versions:{flight:2}}))},current,baseline:{generation:1,revision:{operations:1,administration:1},rows:[a,b]},drafts:[],seeds:f.seeds,editFenceVerified:true});
 const drafts=copy(publication.retainedDrafts),identity=copy(publication.expectedAfter.rows.map(r=>r[0]));refreshCatalogValidation(legend,publication,f.seeds);
 assert.deepEqual(publication.retainedDrafts,drafts);assert.equal(drafts[0].key,'p-b');assert.equal(drafts[0].value,'Bravo');assert.deepEqual(publication.expectedAfter.rows.map(r=>r[0]),identity);
 const copies=publication.requests.filter(r=>r.copyPaste).slice(-2);assert.equal(copies.length,2);assert.ok(copies.every(r=>r.copyPaste.pasteType==='PASTE_DATA_VALIDATION'));assert.deepEqual(copies.map(r=>r.copyPaste.source.startColumnIndex),[18,19]);
 assert.equal(publication.validationExpectations.at(-2).expectedRule.showCustomUi,true);assert.equal(Object.hasOwn(publication.validationExpectations.at(-1).expectedRule,'showCustomUi'),false);
 assert.ok(publication.requests.every(r=>!r.setDataValidation));assert.ok(!JSON.stringify(legend.requests).includes('userEnteredFormat'));
 const stale=copy(f.seeds);stale[0].observedRule.showCustomUi=false;assert.throws(()=>refreshCatalogValidation(legend,publication,stale),/native control/);
});
test('catalog source discovery rejects visible, merged, overlapping, undersized and nonliteral typed sources',()=>{
 for(const change of [f=>{f.metadata.sheets[0].properties.hidden=false;},f=>{f.metadata.sheets[0].merges=[{sheetId:7,startRowIndex:2,endRowIndex:3,startColumnIndex:1,endColumnIndex:3}];},f=>{f.seeds[1].expectedRule=copy(f.seeds[0].expectedRule);},f=>{f.seeds[0].columnIndex=1;},f=>{f.metadata.sheets[0].tables[0].columnProperties[0].columnType='DATE';}]){const f=fixture();change(f);assert.throws(f.read);}
 const f=fixture();f.seeds[0].expectedRule.condition.values[0].userEnteredValue="='Data Legend'!$B$3:$B$3";const before=f.read=()=>readCatalogLegend({...f.args,readCells:()=>copy(f.cells)});assert.throws(()=>planCatalogLegend(snapshot,before()),/cannot hold/);
 assert.deepEqual(catalogLegendBindings([],{},[]),[]);
 const noTypes=fixture();delete noTypes.metadata.sheets[1].tables[0].columnProperties[1].columnType;assert.deepEqual(noTypes.read().tables,[]);
});
