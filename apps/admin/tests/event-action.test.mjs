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

import {asksForAdministrators,currentAdministrators} from "../hosted/admin-directory.mjs";
import {DatabaseSync} from "node:sqlite";
import {readdirSync,readFileSync} from "node:fs";
test("owner lookup names active Wing accounts and excludes flight grants and inactive accounts",async()=>{
  assert.ok(asksForAdministrators({role:"user",content:"Which users are currently administrators?"}));
  assert.equal(asksForAdministrators({role:"user",content:"Which users are currently administrators of Alpha Flight?"}),false);
  assert.ok(asksForAdministrators({role:"user",content:"Who are the current shamrock administrators?"}));
  const db=new DatabaseSync(":memory:");
  const folder=new URL("../../../database/migrations/",import.meta.url);
  for(const file of readdirSync(folder).filter(n=>n.endsWith(".sql")).sort())db.exec(readFileSync(new URL(file,folder),"utf8"));
  db.exec("INSERT INTO principals(principal_id,active) VALUES ('wing',1),('flight',1),('retired',0); INSERT INTO admin_grants VALUES ('wing','frontend.read','wing','*'),('flight','frontend.read','flight','alpha'),('retired','frontend.read','wing','*')");
  const result=await currentAdministrators({prepare:sql=>({all:()=>({results:db.prepare(sql).all()})})});
  assert.deepEqual(result.administrators.map(r=>r.name),["wing"]);db.close();
});

import {rosterQuestion,rosterRows} from "../hosted/roster-questions.mjs";
test("month lookup reads recorded days and names, orders by day, and handles follow-ups",()=>{
  const q=content=>({role:"user",content});
  assert.equal(rosterQuestion([q("What could we improve about birthdays?")]), null);
  const {rosterLookup}=rosterQuestion([q("Whose birthdays are in may?")]);
  assert.deepEqual(rosterLookup,{kind:"birthday",value:"May"});
  assert.equal(rosterQuestion([q("May birthdays?"),q("What about June?")]).rosterLookup.value,"June");
  assert.deepEqual(rosterRows("birthday","May",{birthdays:'[["One","Example","05-21","f"],["Two","Example","05-02","f"],["Three","Example","06-01","f"]]'}),["May 2 · Two Example","May 21 · One Example"]);
});

test("career reports count active preferences separately from majors and redact unknown entries",()=>{
  const row=(afsc,major,status="Active")=>Object.assign(Array(15).fill("private"),{7:status,10:afsc,14:major});
  const rows=[row("32E","14"),row("32E - Civil Engineer","15"),row("Undecided","14"),row("private notes",""),row("62E","14","Dropped")];
  const result=reportTotals("careers",{people:JSON.stringify(rows)});
  assert.equal(result.activeCadets,4);assert.equal(result.desiredAfsc["32E - Civil Engineer"],2);
  assert.equal(result.academicField["14 - Engineering"],2);
  assert.equal(result.desiredAfsc["Unrecognized entry"],1);assert.ok(!JSON.stringify(result).includes("private"));
});

import {rosterDataset,rosterVocabulary,runRosterQuery,cohortNames} from "../hosted/roster-query.mjs";
test("cross-field queries and named follow-ups preserve the prior result across a roster change",()=>{
 const person=(id,asYear,afsc)=>[id,1,"f","Example",id,"",asYear,"Active","","",afsc,"Notre Dame","2028","","14"];
 const t={flights:'[["f","Alpha","s"]]',squadrons:'[["s","Blue"]]',people:JSON.stringify([person("one","AS300","32E"),person("two","AS400","62E"),person("three","AS300","11X")])};
 const rows=rosterDataset(t);
 const plan={scope:"active roster",filters:[{field:"afsc",values:["32E - Civil Engineer","62E - Developmental Engineer"]}],groupBy:"squadron",listNames:false};
 const first=runRosterQuery(rows,plan);
 assert.deepEqual(first.cohort.ids,["one","two"]);
 rows.push({...rows[0],id:"late"});
 const next=runRosterQuery(rows,{...plan,scope:"previous result",filters:[{field:"asYear",values:["AS300"]}],listNames:true},first.cohort.ids);
 assert.deepEqual(cohortNames(rows,next.cohort.ids),["one Example"]);
 assert.ok(!JSON.stringify(rosterVocabulary(rows)).includes("Example"));
 assert.throws(()=>runRosterQuery(rows,{...plan,filters:[{field:"last",values:["Example"]}]}));
});
