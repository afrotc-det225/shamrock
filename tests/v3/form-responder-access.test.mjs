import test from'node:test';import assert from'node:assert/strict';
import{assertPublishedResponderAccess,assertNamedResponder}from'../../.build/v3/apps/google-adapter/src/form-responder-access.js';
const owner='owner@example.invalid',reader='reader@example.invalid',policy={version:1,allowedEmails:[owner,reader]},p=(emailAddress=reader,id='reader')=>({id,type:'user',role:'reader',view:'published',emailAddress});
const check=(permissions,overrides={})=>assertPublishedResponderAccess({formId:'fixture-form',ownerEmail:owner,policy,read:url=>{const u=new URL(url);assert.equal(u.searchParams.get('includePermissionsForView'),'published');assert.equal(u.searchParams.get('pageSize'),'100');assert(u.searchParams.get('fields').includes('view'));return{permissions};},...overrides});
const refused=fn=>assert.throws(fn,{code:'form_responder_access'});
test('published responder review distinguishes editor view and implicit owner access',()=>{check([{id:'owner',type:'user',role:'owner',emailAddress:owner},p()]);check([],{policy:{version:1,allowedEmails:[owner]}});check([p(owner,'owner')],{policy:{version:1,allowedEmails:[owner]}});check([p(' READER@example.invalid ') ]);check([{id:'editor',type:'user',role:'writer',emailAddress:reader}]);refused(()=>check([{id:'editor',type:'user',role:'writer',emailAddress:'outside@example.invalid'},p()]));});
test('published access rejects broad, missing, duplicate, deleted and unreviewed grants',()=>{
 for(const permissions of [[{id:'public',type:'anyone',role:'reader',view:'published'}],[{...p(),type:'domain'}],[{...p(),type:'group'}],[p('other@example.invalid')],[],[p(),p(reader,'second')],[{...p(),deleted:true}],[{...p(),role:'writer'}],[{...p(),id:''}],[{...p(),emailAddress:undefined}],[p(),p(owner,'reader')]])refused(()=>check(permissions));
 for(const value of [undefined,{}, {version:2,allowedEmails:[owner]}, {version:1,allowedEmails:[]},{version:1,allowedEmails:[reader]},{version:1,allowedEmails:[owner,owner]},{version:1,allowedEmails:[owner],extra:true}])refused(()=>check([],{policy:value}));
});
test('all responder pages are verified and changed later-page grants cannot be hidden',()=>{
 let calls=0;const read=url=>{calls++;const next=new URL(url).searchParams.get('pageToken');return next?{permissions:[p()]}:{permissions:[{id:'owner',role:'owner',type:'user',emailAddress:owner}],nextPageToken:'second-page'};};check([],{read});assert.equal(calls,2);
 refused(()=>check([],{read:url=>new URL(url).searchParams.has('pageToken')?{permissions:[{id:'public',type:'anyone',role:'reader',view:'published'}]}:{permissions:[p()],nextPageToken:'second-page'}}));
 refused(()=>check([],{read:()=>({permissions:[],nextPageToken:'loop'})}));
 refused(()=>check([],{read:()=>({permissions:[],nextPageToken:5})}));
 refused(()=>check([],{read:()=>({})}));
 refused(()=>check([],{read:()=>({permissions:Array.from({length:101},()=>({}))})}));
 let page=0;refused(()=>check([],{read:()=>({permissions:[],nextPageToken:String(++page)})}));assert.equal(page,20);
});
test('response replay also requires a currently reviewed verified respondent',()=>{assertNamedResponder(policy,owner,reader.toUpperCase());refused(()=>assertNamedResponder(policy,owner,'former@example.invalid'));refused(()=>assertNamedResponder(undefined,owner,reader));});
