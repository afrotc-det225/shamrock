import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativePermissionProvider,resolveAppliedPermissionIdentity} from '../../.build/v3/apps/google-adapter/src/permissions-native.js';
import {runPermissionRefresh,assertPermissionFenceClear} from '../../.build/v3/apps/google-adapter/src/permissions-refresh.js';
const policy=()=>({policyVersion:'det225-leadership-permissions-v1',members:[],accounts:[{principalId:'cadet',personId:'person',email:'cadet@example.invalid',active:true}],accessGrants:[],adminGrants:[],google:{permissionManagers:['manager@example.invalid'],leadershipEditors:['leader@example.invalid'],attendanceEditors:['leader@example.invalid'],squadronCommanders:[{squadronId:'blue',email:'blue@example.invalid'}],excusalViewers:['leader@example.invalid']},diagnostics:[]});
const access={ownerEmail:'owner@example.invalid',automationEmail:'owner@example.invalid',supportEditors:[],directoryEditors:[],leadershipEditors:[],attendanceEditors:[],squadronCommanders:[]};
function providerFixture(limit=25){
 let seq=1;const calls=[],books=['main','excusals'].map(kind=>({spreadsheetId:kind,kind,fixedReaders:[],fixedAccess:access}));
 const permissions=Object.fromEntries(books.map(b=>[b.kind,[{id:'owner',role:'owner',type:'user',emailAddress:access.ownerEmail},{id:'old',role:'writer',type:'user',emailAddress:'old@example.invalid'}]]));
 const sheets=Object.fromEntries(books.map(b=>[b.kind,[{properties:{sheetId:1,gridProperties:{rowCount:20,columnCount:5}},protectedRanges:[]}]]));
 const api={readFile:id=>({id,mimeType:'application/vnd.google-apps.spreadsheet',owners:[{emailAddress:access.ownerEmail}]}),readPermissions:id=>structuredClone(permissions[id]),readProtectionInput:id=>({metadata:{sheets:structuredClone(sheets[id])},surfaces:[{kind:id==='main'?'leadership':'excusal',sheetId:1,headers:id==='main'?['assignment_id','role','email','office_phone']:['request_id','decision'],...(id==='excusals'?{squadronId:'blue'}:{}),dataEndRow:4,gridRowCount:20,gridColumnCount:5}]}),
 batchUpdate(id,requests){calls.push(['protect',id]);for(const r of requests){if(r.addProtectedRange)sheets[id][0].protectedRanges.push({...structuredClone(r.addProtectedRange.protectedRange),protectedRangeId:seq++});else if(r.updateProtectedRange){const p=r.updateProtectedRange.protectedRange;Object.assign(sheets[id][0].protectedRanges.find(x=>x.protectedRangeId===p.protectedRangeId),structuredClone(p));}else if(r.deleteProtectedRange)sheets[id][0].protectedRanges=sheets[id][0].protectedRanges.filter(x=>x.protectedRangeId!==r.deleteProtectedRange.protectedRangeId);else assert.fail('Unexpected native request');}},
 deletePermission(id,pid){calls.push(['delete',id,pid]);permissions[id]=permissions[id].filter(p=>p.id!==pid);},
 createPermission(id,value,notify){assert.equal(notify,false);calls.push(['add',id,value.emailAddress]);permissions[id].push({id:`added-${seq++}`,...value});}};
 return {provider:createNativePermissionProvider({books,forbiddenSpreadsheetIds:['production'],maxMembershipMutations:limit},api),api,permissions,calls,books};
}
test('native provider revokes obsolete named/broad membership before additions and verifies exact field protections',()=>{
 const f=providerFixture();f.permissions.main.push({id:'public',role:'reader',type:'anyone'});f.provider.assertIsolation();f.provider.fenceProvider();f.provider.assertProviderFenced();
 assert.equal(f.provider.revokeMemberships(policy()),true);f.provider.assertRevocations(policy());assert.equal(f.provider.addMemberships(policy()),true);f.provider.assertMemberships(policy());f.provider.applyProtections(policy());f.provider.assertProtections(policy());
 assert.ok(f.calls.findLastIndex(c=>c[0]==='delete')<f.calls.findIndex(c=>c[0]==='add'));
 assert.deepEqual(f.permissions.excusals.filter(p=>p.role!=='owner').map(p=>[p.emailAddress,p.role]).sort(),[['blue@example.invalid','writer'],['leader@example.invalid','reader']]);
});
test('bounded native batches resume from live readback and do not duplicate acknowledged or ambiguous additions',()=>{
 const f=providerFixture(1);assert.equal(f.provider.revokeMemberships(policy()),false);assert.equal(f.provider.revokeMemberships(policy()),true);
 assert.equal(f.provider.addMemberships(policy()),false);const added=f.calls.filter(c=>c[0]==='add').length;assert.equal(added,1);
 while(!f.provider.addMemberships(policy())){}f.provider.assertMemberships(policy());assert.equal(f.permissions.main.filter(p=>p.emailAddress==='leader@example.invalid').length,1);
 assert.equal(f.provider.revokeMemberships(policy()),true);assert.equal(f.provider.addMemberships(policy()),true);
});
test('inherited unapproved sharing and wrong-owner isolation fail closed; named identity has no stale fallback',()=>{
 const f=providerFixture();f.permissions.main[1].permissionDetails=[{inherited:true}];assert.throws(()=>f.provider.revokeMemberships(policy()),/inherited/);assert.equal(f.calls.length,0);
 f.api.readFile=id=>({id,mimeType:'application/vnd.google-apps.spreadsheet',owners:[{emailAddress:'other@example.invalid'}]});assert.throws(()=>f.provider.assertIsolation(),/owner/);
 const applied={version:1,policyHash:'a'.repeat(64),policy:policy()};assert.deepEqual(resolveAppliedPermissionIdentity(applied,'CADET@example.invalid'),{principalId:'cadet',personId:'person'});assert.throws(()=>resolveAppliedPermissionIdentity(applied,'old@example.invalid'),/not enrolled/);
});
function consumerFixture(){
 const claim={jobId:'job1',version:1,claimToken:'token1',leaseExpiresAt:'2099-01-01T00:00:00.000Z'};let marker=false,storedClaim,state={version:1},done=false,current=true,paused=false;const calls=[];
 const p={enabled:()=>true,lock:{tryLock:()=>true,releaseLock:()=>{}},claimStore:{load:()=>storedClaim,save:c=>{storedClaim=structuredClone(c);},clear:c=>{assert.equal(c.jobId,storedClaim.jobId);storedClaim=undefined;}},state:{load:()=>structuredClone(state),save:s=>{state=structuredClone(s);}},request(action){calls.push(action);if(action==='claim')return {job:done?null:claim};if(action==='project')return {version:1,current,policyHash:'a'.repeat(64),policy:policy()};if(action==='ack'){done=true;return {acknowledged:true,current};}if(action==='status')return {applied:done,version:1,policyHash:'a'.repeat(64)};},assertIsolation(){calls.push('isolation');},setFence(){marker=true;},assertFenceMarker(){assert.equal(marker,true);},fenceProvider(){calls.push('fence');},assertProviderFenced(){},revokeMemberships(){calls.push('revoke');return true;},assertRevocations(){},addMemberships(){calls.push('add');return true;},assertMemberships(){},applyProtections(){calls.push('open');},assertProtections(){},clearFence(){marker=false;},pause(){paused=true;}};
 return {p,calls,get state(){return state;},get marker(){return marker;},get paused(){return paused;},get claim(){return storedClaim;},setCurrent:v=>{current=v;}};
}
test('idle permission tick performs one Worker request and zero Google/private-state reads',()=>{
 const f=consumerFixture();f.p.request=action=>{f.calls.push(action);return {job:null};};f.p.state.load=()=>assert.fail('No idle Drive reads');assert.equal(runPermissionRefresh(f.p),'idle');assert.deepEqual(f.calls,['claim']);
});
test('successful publication saves authoritative identity map and confirms current revision before reopening',()=>{
 const f=consumerFixture();assert.equal(runPermissionRefresh(f.p),'complete');assert.equal(f.marker,false);assert.equal(f.state.applied.version,1);assert.equal(f.claim,undefined);assert.ok(f.calls.indexOf('revoke')<f.calls.indexOf('add'));assert.ok(f.calls.indexOf('ack')<f.calls.indexOf('open'));
});
test('ambiguous acknowledgement retains the completed checkpoint and fence; exact replay safely recovers',()=>{
 const f=consumerFixture(),request=f.p.request;let lost=true;f.p.request=action=>{const result=request(action);if(action==='ack'&&lost){lost=false;throw new Error('response lost');}return result;};assert.throws(()=>runPermissionRefresh(f.p),/response lost/);assert.equal(f.marker,true);assert.equal(f.paused,true);assert.ok(f.state.completed);assert.ok(f.claim);
 assert.equal(runPermissionRefresh(f.p),'complete');assert.equal(f.marker,false);assert.equal(f.calls.filter(c=>c==='add').length,1);
});
test('superseded or interrupted permission publication never restores stale field access',()=>{
 const f=consumerFixture();f.setCurrent(false);assert.equal(runPermissionRefresh(f.p),'superseded');assert.equal(f.marker,true);assert.equal(f.calls.includes('open'),false);
 const partial=consumerFixture();partial.p.addMemberships=()=>false;assert.equal(runPermissionRefresh(partial.p),'pending');assert.equal(partial.marker,true);assert.ok(partial.state.pending);assert.equal(partial.calls.includes('ack'),false);
 assert.throws(()=>assertPermissionFenceClear({getProperty:()=> 'pending'}),/remains fenced/);
});

test('public API adapter collects every permission page and disables invitations without following redirects',async()=>{
 const {createNativePermissionApi}=await import('../../.build/v3/apps/google-adapter/src/permissions-native.js');const calls=[];let pages=0;
 const services={ScriptApp:{getOAuthToken:()=> 'fictional-token'},UrlFetchApp:{fetch(url,options){calls.push({url,options});assert.equal(options.followRedirects,false);assert.equal(options.validateHttpsCertificates,true);return {getResponseCode:()=>200,getContentText:()=>url.includes('pageSize')?JSON.stringify(++pages===1?{permissions:[{id:'first'}],nextPageToken:'second'}:{permissions:[{id:'second'}]}):'{}'};}}};
 const api=createNativePermissionApi(services,()=>{throw new Error('not called');});assert.deepEqual(api.readPermissions('fictional-book').map(p=>p.id),['first','second']);assert.equal(calls.length,2);assert.ok(calls[1].url.includes('pageToken=second'));
 api.createPermission('fictional-book',{type:'user',role:'reader',emailAddress:'viewer@example.invalid'},false);assert.ok(calls.at(-1).url.includes('sendNotificationEmail=false'));
 assert.throws(()=>api.createPermission('fictional-book',{type:'user',role:'reader',emailAddress:'viewer@example.invalid'},true),/disabled/);
});
