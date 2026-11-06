import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {retainCapturedInput,deliverFrontendInputs,supersedeUnattemptedInput} from '../../.build/v3/apps/google-adapter/src/frontend-input-journal.js';
const copy=x=>structuredClone(x),hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const draft={key:'person',header:'event:event',value:'P',baseVersion:3,expectedEventVersion:2,command:{operation:'attendance.correct',entityId:'person',field:'event',expectedVersion:3}};
 const command={commandId:'input-one',operation:'attendance.correct',payload:{personId:'person',eventId:'event',expectedBaseVersion:3,expectedEventVersion:2,code:'P',reason:'Spreadsheet attendance correction.'}};
 const edit={editId:'edit-one',surface:'attendance',resourceKey:'attendance',generation:1,environment:'staging',evidence:{},drafts:[draft],templates:[{operation:command.operation,payload:command.payload,path:'/v1/admin/commands',drafts:[draft]}],summary:'Frozen change',summaryHash:hash('Frozen change'),status:'ready',principalId:'editor'};
 const baseline={generation:1,revision:{operations:3,administration:1},rows:[{key:'person',values:{'event:event':null},versions:{'event:event':3},eventVersions:{'event:event':2},commandBindings:{'event:event':draft.command}}]};
 const fx={events:[],storedJournal:{version:1,environment:'staging',generation:1,entries:{}},storedState:{version:1,environment:'staging',generation:1,baselines:{attendance:baseline,directory:copy(baseline),leadership:copy(baseline)},drafts:{attendance:[],directory:[],leadership:[]}},visible:true,sendCount:0,fail:'',response:{status:200,body:{commandId:'input-one',operation:'attendance.correct',status:'committed',result:{personId:'person',eventId:'event',version:9,code:'P'}}}};
 const open=()=>({journal:copy(fx.storedJournal),state:copy(fx.storedState),saveJournal(v){fx.events.push('journal');if(fx.fail==='journal-applied'&&v.entries['edit-one']?.commands[0]?.applied)throw Error('interrupted');fx.storedJournal=copy(v);},saveState(v){fx.events.push('state');if(fx.fail==='state')throw Error('interrupted');fx.storedState=copy(v);},sha256:hash,send(path,c){fx.events.push('send');fx.sendCount++;assert.deepEqual(c,command);assert(fx.storedJournal.entries['edit-one'].commands[0].attempted);assert.equal(fx.storedState.drafts.attendance.length,1);if(fx.fail==='ambiguous')throw Error('timeout');return copy(fx.response);},stillVisible:()=>fx.visible});return{fx,open,edit,command};
}
test('private input and publisher hold persist before the first signed delivery',()=>{
 const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);assert.deepEqual(f.fx.events,['journal','state']);assert.equal(deliverFrontendInputs(io).committed,1);assert.equal(f.fx.storedState.drafts.attendance.length,0);assert.equal(f.fx.storedState.baselines.attendance.rows[0].versions['event:event'],9);assert(f.fx.storedState.inputReceipts['input-one']);assert.equal(f.fx.storedJournal.entries['edit-one'].commands[0].applied,true);
});
test('a checkpoint interruption after capture cannot deliver an unheld edit',()=>{
 const f=fixture();f.fx.fail='state';assert.throws(()=>retainCapturedInput(f.open(),f.edit,[f.command]));assert.equal(f.fx.sendCount,0);assert(f.fx.storedJournal.entries['edit-one']);f.fx.fail='';assert.equal(deliverFrontendInputs(f.open()).committed,1);
});
test('an ambiguous attempt retries its exact command even if the visible cell later changes',()=>{
 const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.fail='ambiguous';deliverFrontendInputs(io);assert.equal(f.fx.storedJournal.entries['edit-one'].commands[0].status,'queued');f.fx.visible=false;f.fx.fail='';assert.equal(deliverFrontendInputs(f.open()).committed,1);assert.equal(f.fx.sendCount,2);
});
test('an unattempted edit whose visible value changed is retained without sending',()=>{
 const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.visible=false;deliverFrontendInputs(io);assert.equal(f.fx.sendCount,0);assert.equal(f.fx.storedJournal.entries['edit-one'].issue,'input-changed-before-dispatch');
});
test('a received receipt persists before baseline reconciliation, and recovery never redelivers it',()=>{
 const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.fail='state';assert.throws(()=>deliverFrontendInputs(io));assert.equal(f.fx.storedJournal.entries['edit-one'].commands[0].status,'committed');assert.equal(f.fx.sendCount,1);f.fx.fail='';assert.equal(deliverFrontendInputs(f.open()).committed,1);assert.equal(f.fx.sendCount,1);
});
test('an applied receipt marker survives a lost journal acknowledgement without rebasing or applying twice',()=>{
 const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.fail='journal-applied';assert.throws(()=>deliverFrontendInputs(io));assert.equal(f.fx.storedState.drafts.attendance.length,0);assert(f.fx.storedState.inputReceipts['input-one']);f.fx.fail='';assert.equal(deliverFrontendInputs(f.open()).committed,1);assert.equal(f.fx.sendCount,1);
});
test('conflict, revoked authority and mismatched receipts retain the original draft',()=>{
 for(const status of [409,403,200]){const f=fixture(),io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.response.status=status;if(status===200)f.fx.response.body.result.personId='other';deliverFrontendInputs(io);assert.equal(f.fx.storedState.drafts.attendance.length,1);assert.equal(f.fx.storedState.baselines.attendance.rows[0].versions['event:event'],3);assert.equal(f.fx.storedJournal.entries['edit-one'].commands[0].status,status===409?'conflict':status===403?'rejected':'queued');}
});
test('an unknown editor can retain frozen input without creating any authoritative command',()=>{
 const f=fixture(),io=f.open();f.edit.status='confirmation-required';delete f.edit.principalId;retainCapturedInput(io,f.edit,[]);deliverFrontendInputs(io);assert.equal(f.fx.sendCount,0);assert.equal(f.fx.storedState.drafts.attendance.length,1);
});

function replacementFixture(){
 const f=fixture();f.edit.evidence={spreadsheetId:'book',sheetId:1,row:3,column:2,rows:1,columns:1,triggerUid:'trigger'};
 f.fx.storedState.baselines.attendance.slots={headers:['person_id','event:event'],keys:['person']};
 const current={range:{startRowIndex:1,startColumnIndex:0},headers:['person_id','event:event'],rows:[[{userEnteredValue:{stringValue:'person'}},{}]]};return{...f,current};
}
test('supersession journals before dropping only never-attempted holds and recovers an interrupted state save',()=>{
 const f=replacementFixture();retainCapturedInput(f.open(),f.edit,[]);f.fx.fail='state';assert.throws(()=>supersedeUnattemptedInput(f.open(),'attendance',f.edit.evidence,f.current));
 assert.equal(f.fx.storedJournal.entries['edit-one'].superseded,true);assert.equal(f.fx.storedState.drafts.attendance.length,1);f.fx.fail='';deliverFrontendInputs(f.open());assert.equal(f.fx.storedState.drafts.attendance.length,0);assert.equal(f.fx.sendCount,0);
});
test('supersession cannot discard an ambiguous attempted command or trust a changed physical map',()=>{
 const f=replacementFixture();const io=f.open();retainCapturedInput(io,f.edit,[f.command]);f.fx.fail='ambiguous';deliverFrontendInputs(io);
 assert.equal(supersedeUnattemptedInput(io,'attendance',f.edit.evidence,f.current),0);assert.equal(io.state.drafts.attendance.length,1);f.current.rows[0][0].userEnteredValue.stringValue='another';assert.throws(()=>supersedeUnattemptedInput(io,'attendance',f.edit.evidence,f.current),e=>e.code==='input_slots');
});
