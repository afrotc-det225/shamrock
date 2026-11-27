import React, {useEffect, useRef, useState} from "react";
import {api} from "./api";
import runnerUrl from "./assistant-sandbox.js?worker&url";
import { runnable } from "../hosted/maintenance.mjs";

export function MaintenanceProposal({proposal:p,autoTest=false}) {
  const [results,setResults] = useState(null), [status,setStatus] = useState("");
  const active = useRef(null);
  useEffect(()=>()=>active.current?.(),[]);
  const run = () => {
    const basename = runnerUrl.split("/").pop();
    const worker = new Worker("/api/assistant-runner/" + basename,{type:"module"});
    const stop = () => {clearTimeout(timer);worker.terminate();active.current=null;};
    const fail = () => {stop();setStatus("Test runner unavailable or timed out.");};
    const timer = setTimeout(fail,10000);
    active.current=stop;
    worker.onmessage = e => {stop();setResults(e.data);setStatus("");};
    worker.onerror = fail;
    setStatus("Running…"); worker.postMessage(p);
  };
  useEffect(()=>{
    if(autoTest && Object.hasOwn(runnable,p.area))run();
    return ()=>active.current?.();
  },[autoTest,p]);
  const [testState,setTestState]=useState("queued");
  const [refreshKey,setRefreshKey]=useState(0);
  async function publish(){
    try{
      const result=await api("/chat/repository-test",{id:p.jobId,publishWebsite:true});
      setTestState(result.state);setRefreshKey(k=>k+1);
    }catch(e){setStatus(e.message);}
  }
  useEffect(()=>{
    if(!p.jobId)return;
    let stopped=false,timer;
    async function refresh(){
      let state;
      try{({state}=await api("/chat/repository-test?id="+encodeURIComponent(p.jobId)));}
      catch{state="unavailable";}
      if(stopped)return;
      setTestState(state);
      if(["queued","running","approved","publishing","unavailable"].includes(state))timer=setTimeout(refresh,30000);
    }
    refresh();return ()=>{stopped=true;clearTimeout(timer);};
  },[p.jobId,refreshKey]);
  const where = {
    "Wing overview":"/overview","Wing charts":"/overview","Wing reporting and historical comparisons":"/overview",
    "Birthday agenda":"/overview","Excusal queue":"/excusals","Excusals page":"/excusals","Excusal permissions":"/excusals",
    "Cadet profile fields":"/me/profile","Cadet profile and submissions":"/me/profile","Cadet sorting":"/cadets",
    "Cadet directory and Leadership":"/cadets","Directory roster views":"/cadets","Attendance matrix":"/attendance",
    "Attendance page":"/attendance","Attendance corrections":"/attendance","Event management page":"/events",
    "Semester planner":"/semester","Semester transitions":"/semester",
  };
  const labels={
    queued:"Waiting to check your change",running:"Checking your change",passed:"Checks passed",
    approved:"Preparing your update",publishing:"Updating the website",live:"Your change is live",
    failed:"Checks failed. Ask the assistant to revise this change.",expired:"This change has expired.",
    native:"This change needs a separate Google Sheets or Forms update.",
    outdated:"The website has changed since these checks. Ask for a fresh version.",
    release_failed:"The update could not be verified. Check the website before trying again.",
    published:"Saved for review",unavailable:"Checking update status",
  };
  return <section>
    <details><summary>See proposed changes</summary>{p.routing && <p>Routed by {p.routing} · GPT-5.3-Codex</p>}{(p.edits ?? [p]).map(edit=><div key={edit.path}><strong>{edit.path}</strong><p>Current</p><pre>{edit.before}</pre><p>Proposed</p><pre>{edit.after || "(remove)"}</pre></div>)}</details>

    {p.jobId && <p role="status">{labels[testState] ?? "Checking update status"}</p>}
    {testState==="passed" && <button onClick={publish}>Approve and publish</button>}
    {testState==="live" && <a href={where[p.area] ?? "/overview"}>Open updated page</a>}
    {testState==="published" && <a href={"https://github.com/afrotc-det225/shamrock-staging-runner/tree/proposals/"+p.jobId} target="_blank" rel="noreferrer">Open tested branch</a>}
    {p.jobId===null && <p>The daily repository test allowance has been used.</p>}
    {Object.hasOwn(runnable,p.area) ? <button disabled={status==="Running…"} onClick={run}>Test with fictional data</button>
      : null}
    {Object.hasOwn(runnable,p.area) && !p.example && <p>The model supplied no runnable example for the requested behavior. Only regression cases are available.</p>}
    {status && <p role="status">{status}</p>}
    {results && <table><thead><tr><th>Check</th><th>Released code</th><th>Proposal</th></tr></thead>
      <tbody>{results.map(r=><tr key={r.name}><td>{r.name}</td><td>{r.baseline}</td><td>{r.candidate}</td></tr>)}</tbody></table>}
  </section>;
}
