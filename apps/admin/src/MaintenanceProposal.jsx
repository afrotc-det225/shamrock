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
      const result=await api("/chat/repository-test",{id:p.jobId,publishPublicBranch:true});
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
  const download = () => {
    const url = URL.createObjectURL(new Blob([p.source.replace(p.before,()=>p.after)],{type:"text/plain"}));
    const a = document.createElement("a"); a.href=url; a.download=p.path.split("/").pop(); a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <section><strong>{p.path} · {p.commit.slice(0,12)}</strong>
    <details><summary>Review proposed edit</summary>{p.routing && <p>Routed by {p.routing} · GPT-5.3-Codex</p>}{(p.edits ?? [p]).map(edit=><div key={edit.path}><strong>{edit.path}</strong><p>Current</p><pre>{edit.before}</pre><p>Proposed</p><pre>{edit.after || "(remove)"}</pre></div>)}</details>
    {(!p.edits || p.edits.length===1) && <button onClick={download}>Download proposed file</button>}
    {p.jobId && <p role="status">Repository tests · {testState}{testState==="queued" && p.dispatch?.startsWith("scheduled") ? " · "+p.dispatch : ""}</p>}
    {testState==="passed" && <button onClick={publish}>Publish tested change to a public review branch</button>}
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
