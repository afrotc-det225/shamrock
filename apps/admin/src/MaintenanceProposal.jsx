import React, {useEffect, useRef, useState} from "react";
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
  const downloadJob = () => {
    const {area,path,commit,before,after}=p;
    const url=URL.createObjectURL(new Blob([JSON.stringify({area,path,commit,before,after})],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="shamrock-codex-job.json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([p.source.replace(p.before,()=>p.after)],{type:"text/plain"}));
    const a = document.createElement("a"); a.href=url; a.download=p.path.split("/").pop(); a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <section><strong>{p.path} · {p.commit.slice(0,12)}</strong>
    <details><summary>Review proposed edit</summary><p>Current</p><pre>{p.before}</pre><p>Proposed</p><pre>{p.after || "(remove)"}</pre></details>
    <button onClick={download}>Download proposed file</button>
    <button onClick={downloadJob}>Download repository test job</button>
    {Object.hasOwn(runnable,p.area) ? <button disabled={status==="Running…"} onClick={run}>Test with fictional data</button>
      : <p>Requires repository integration tests.</p>}
    {Object.hasOwn(runnable,p.area) && !p.example && <p>The model supplied no runnable example for the requested behavior. Only regression cases are available.</p>}
    {status && <p role="status">{status}</p>}
    {results && <table><thead><tr><th>Check</th><th>Released code</th><th>Proposal</th></tr></thead>
      <tbody>{results.map(r=><tr key={r.name}><td>{r.name}</td><td>{r.baseline}</td><td>{r.candidate}</td></tr>)}</tbody></table>}
  </section>;
}
