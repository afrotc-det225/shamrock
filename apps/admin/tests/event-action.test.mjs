import test from "node:test";
import assert from "node:assert/strict";
import {eventCancellationReply} from "../hosted/event-action.mjs";
const name="TW-12 LLAB";
const row=["e",3,"fall","llab",12,9,name,"header","","active",null,null,"","notes",1];
function fixture(events=[["e","fall","llab",9,name]],status="active"){
  const calls=[];
  const read=async (_b,_a,profile)=>({tables:profile==="event-list" ?
    {events:JSON.stringify(events),terms:'[["fall","Fall",1,1]]'} :
    {events:JSON.stringify([[...row.slice(0,9),status,...row.slice(10)]]),eventFlights:'[["e","flight"]]',eligible:'[["e","cadet"]]',people:'[]',flights:'[]',terms:'[]'}});
  return {calls,reply:q=>eventCancellationReply({role:"user",content:q},{panelAuthority:async()=>({})},{propose:async (...args)=>{calls.push(args);return {id:"approval"};}},read)};
}
test("cancellation reviews only one current event and preserves roster and schedule",async()=>{
  const f=fixture([["old","spring","llab",9,name],["e","fall","llab",9,name]]);
  const r=await f.reply("Can you cancel TW-12 LLAB?");
  assert.equal(r.eventAction.id,"approval");const [[op,p]]=f.calls;
  assert.equal(op,"event.upsert");assert.equal(p.status,"cancelled");assert.equal(p.expectedVersion,3);
  assert.deepEqual(p.eligiblePersonIds,["cadet"]);assert.deepEqual(p.flightIds,["flight"]);assert.equal(p.notes,"notes");
});
test("no approval for ambiguous, compound, missing, already cancelled or explanatory requests",async()=>{
  for(const [f,q] of [[fixture([...Array(2)].map(()=>["e","fall","llab",9,name])),"Cancel "+name],[fixture(),"Cancel "+name+" and Mando"],[fixture(),"Cancel TW-99 LLAB"],[fixture(undefined,"cancelled"),"Cancel "+name],[fixture(),"How do I cancel "+name+"?"]]){
    assert.ok(!(await f.reply(q))?.eventAction);assert.equal(f.calls.length,0);
  }
});

import {reportTotals,reportSources} from "../hosted/operational-reports.mjs";
test("reports select relevant sources and omit names, phones and free text",()=>{
  assert.deepEqual(reportSources("compare pending excusals and leadership contacts"),["overview","leadership"]);
  const contacts=[["id",2,"pid","PRIVATE","PRIVATE","rank","role","PRIVATE","office",1,"PRIVATE","PRIVATE","PRIVATE"]];
  assert.deepEqual(reportTotals("leadership",{contacts:JSON.stringify(contacts)}),{activeLeadershipContacts:1,withOfficePhone:1,withOfficeLocation:1});
  assert.deepEqual(reportTotals("overview",{pending:3,activeEvents:2}),{activeEvents:2,pendingExcusalsForActiveEvents:3});
  const person=Array(12).fill("PRIVATE");person[11]="SMC";
  assert.deepEqual(reportTotals("cadets",{people:JSON.stringify([person])}),{activeCadetsByCampus:{"St. Mary's":1}});
  assert.deepEqual(reportTotals("event-list",{terms:'[["fall","Fall",1,1]]',events:'[["id","fall","llab",1,"PRIVATE","active"],["old","spring","llab",1,"PRIVATE","active"]]'}),{currentSemesterEventsByTypeAndStatus:{"llab / active":1}});
});
