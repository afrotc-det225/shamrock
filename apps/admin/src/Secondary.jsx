import { MaintenanceProposal } from "./MaintenanceProposal";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import OverviewInsights from "./OverviewInsights";
import { Send } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import {readUsage} from "./read-usage";
import { api } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";
import { useReceipts, ReceiptStatus } from "./receipts";
export function Overview({ snapshot: s, overview, reporting, history, receiptsDeferred, reportingTime, captureKey, navigate, readOnly = false, ...details }) {
  const d = reporting?.dashboard;
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey, enabled: !readOnly });
  return (
    <>
      <Heading
        title="Overview"
        description={`${overview?.term || s?.terms.find((t) => t.isCurrent)?.label || "Semester not configured"} · Detachment 225`}
      />
      <OverviewInsights {...details} overview={overview} snapshot={s} reporting={reporting} reportingTime={reportingTime} captureKey={captureKey}
        activeCadets={overview?.activeCadets ?? d?.totalCadets ?? s.people.filter(p => p.active).length}
        pending={overview?.pending ?? currentExcusalRequests(s).filter(r => r.status === "Submitted").length}
        navigate={navigate}/>
      {!readOnly && <section className="form-section">
        <h2>Recent changes</h2>
        <ReceiptStatus receipt={receipt} />
        {receipt.rows === null ? null : receipt.rows.length ? (
          <History rows={receipt.rows.slice(0, 5)} />
        ) : (
          <Empty>No changes yet.</Empty>
        )}
      </section>}
    </>
  );
}
export function History({ rows, retry, busy }) {
  return (
    <Table
      headers={["Change", "Prepared", "State", ...(retry ? ["Action"] : [])]}
    >
      {rows.map((r) => (
        <tr key={r.id}>
          <td>
            {r.summary.title}
            <small>{r.summary.target}</small>
          </td>
          <td>{new Date(r.created).toLocaleString()}</td>
          <td>
            <Status>{r.state === "complete" ? "Saved" : r.state}</Status>
          </td>
          {retry && (
            <td>
              {["retryable", "continuing", "applying"].includes(r.state) && (
                <button disabled={busy} onClick={() => retry(r.id)}>
                  Retry saved change
                </button>
              )}
            </td>
          )}
        </tr>
      ))}
    </Table>
  );
}
function ReadUsage() {
  const [usage,setUsage]=useState(readUsage);
  useEffect(()=>{const timer=setInterval(()=>setUsage(readUsage()),1000);return ()=>clearInterval(timer);},[]);
  return <section className="form-section"><h2>Database usage in this tab</h2>
    <Table headers={["Period","API requests","Receipt requests","D1 rows read"]}>
      {[["Last 60 seconds",usage.minute],["Since opening",usage.tab]].map(([period,c])=>
        <tr key={period}><td>{period}</td><td>{c.requests}</td><td>{c.receipts}</td>
        <td>{c.unknown ? `${c.rows} measured · ${c.unknown} unmeasured` : c.rows}</td></tr>)}
    </Table>
    <details><summary>Usage by request since opening</summary>
      <Table headers={["Request","Calls","D1 rows read","Unmeasured"]}>
        {usage.groups.map(([name,c])=><tr key={name}><td>{name}</td><td>{c.requests}</td><td>{c.rows}</td><td>{c.unknown}</td></tr>)}
      </Table>
    </details></section>;
}
export function System({ snapshot, meta, history, receiptsDeferred, reportingTime, captureKey, retry, busy }) {
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey });
  const [checks,setChecks]=useState(null),[checking,setChecking]=useState(false),[failed,setFailed]=useState(false);
  const findings={PEOPLE_MISSING_PROFILES:"Cadets missing directory profiles",EVENTS_MISSING_DETAILS:"Events missing details",
    FLIGHTS_MISSING_SQUADRON:"Flights without a squadron",EVENTS_MISSING_ROSTER:"Events without a roster"};
  async function checkCatalog(){
    setChecking(true);setFailed(false);setChecks(null);
    try {setChecks(snapshot?.diagnostics ?? (await api("/system/diagnostics")).diagnostics);}
    catch {setFailed(true);} finally {setChecking(false);}
  }
  return (
    <>
      <Heading title="System" />
      {meta?.hosted && <ReadUsage />}
      <section className="form-section">
        <h2>Catalog checks</h2>
        <button disabled={checking} onClick={checkCatalog}>{checking ? "Checking…" : "Check catalog"}</button>
        {failed && <p role="alert">Catalog checks could not be loaded. Try again.</p>}
        {checks && (checks.length ? <Table headers={["Finding","Count"]}>{checks.map(d=><tr key={d.code}><td>{findings[d.code] || d.code}</td><td>{d.count}</td></tr>)}</Table> : <p role="status">No catalog issues were reported.</p>)}
      </section>
      <section className="form-section">
        <h2>Change history</h2>
        <ReceiptStatus receipt={receipt} />
        {receipt.rows !== null && (receipt.rows.length ? <History rows={receipt.rows} retry={retry} busy={busy} /> : <Empty>No saved changes yet.</Empty>)}
      </section>
    </>
  );
}
const AssistantResponse = lazy(()=>import("./AssistantResponse"));
export function Assistant({ meta }) {
  const [messages,setMessages]=useState([]), [text,setText]=useState(""),
    [busy,setBusy]=useState(false), [error,setError]=useState("");
  const input=useRef(null), inFlight=useRef(false);
  async function send(event){
    event.preventDefault();
    if(inFlight.current || !meta.assistantAvailable || !text.trim())return;
    inFlight.current=true;
    const question=text.trim(), next=[...messages,{role:"user",content:question}].slice(-15);
    setMessages(next);setText("");setBusy(true);setError("");
    try{
      const reply=await api("/chat",{messages:next.map(({role,content})=>({role,content}))});
      setMessages([...next,{role:"assistant",content:reply.content,proposal:reply.proposal}]);
    }catch(e){
      setMessages(messages);setText(draft=>draft || question);setError(e.message);
    }finally{inFlight.current=false;setBusy(false);}
  }
  return <section className="assistant-page">
    <Heading title="Assistant"/>
    {!meta.assistantAvailable && <p role="status">The assistant is currently unavailable.</p>}
    <div className="conversation" role="log" aria-label="Conversation">
      {messages.map((m,i)=><article key={i} className={"message "+m.role}>
        <span className="message-author">{m.role==="user" ? "You" : "SHAMROCK assistant"}</span>
        {m.role==="user" ? <p>{m.content}</p> : <Suspense fallback={<p role="status">Formatting response…</p>}>
          <AssistantResponse text={m.content}/>
        </Suspense>}
        {m.proposal && <MaintenanceProposal proposal={m.proposal}/>}
      </article>)}
      {busy && <p className="hint" role="status">Thinking…</p>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <form className="chat-form" onSubmit={send}>
      <textarea ref={input} aria-label="Ask SHAMROCK" aria-describedby="assistant-privacy"
        rows={2} placeholder={messages.length ? "Ask a follow-up…" : "Ask about the wing or SHAMROCK…"}
        maxLength={meta.hosted ? 1000 : 6000} value={text} onChange={e=>setText(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form.requestSubmit();}}}
        disabled={!meta.assistantAvailable}/>
      <button className="primary" aria-label="Send question" title="Send question" disabled={busy || !meta.assistantAvailable || !text.trim()}><Send size={18}/></button>
    </form>
    {!messages.length && meta.assistantAvailable && <div className="assistant-prompts">
      {["How is the detachment doing?","How do corrections work?"].map(prompt=><button type="button" key={prompt} onClick={()=>{setText(prompt);input.current?.focus();}}>{prompt}</button>)}
    </div>}
    <small id="assistant-privacy">{meta.hosted ? "OpenAI may receive your question, relevant code, and Wing totals. Omit personal details and secrets." : "Questions are sent to the CRC. Omit personal details and secrets."}</small>
  </section>;
}
