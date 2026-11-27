import assert from "node:assert/strict";
import test from "node:test";
import {loadReportDraft, restoreSelections, rosterSignature} from "../src/report-draft.js";

test("restore a full report only for the same eligible roster and version",()=>{
  const roster=["one","two"].map(personId=>({personId,flightId:"alpha",version:1}));
  const data={reportRoster:roster,flights:[{flightId:"alpha",rosterVersion:4}],ownFlightCount:2};
  const draft={eventId:"lab",present:["two","one"],complete:true,roster:rosterSignature(data)};
  assert.deepEqual(restoreSelections(draft,{...data,reportRoster:[...roster].reverse()}),
    {present:["two","one"],complete:true,changed:false});
  assert.deepEqual(restoreSelections(draft,{...data,reportRoster:roster.slice(0,1),ownFlightCount:1}),
    {present:["one"],complete:false,changed:true});
  assert.equal(restoreSelections(draft,{...data,flights:[{flightId:"alpha",rosterVersion:5}]}).complete,false);
  assert.equal(loadReportDraft(()=>({getItem:()=>"{broken"}),"key"),null);
  assert.equal(loadReportDraft(()=>{throw Error("Storage disabled");},"key"),null);
});
