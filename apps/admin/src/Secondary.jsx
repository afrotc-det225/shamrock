import { MaintenanceProposal } from "./MaintenanceProposal";
import React, { lazy, Suspense, useLayoutEffect, useEffect, useRef, useState } from "react";
import {overviewRoster} from "../../../packages/domain/src/frontend-reporting";
import {operationallyActive} from "../../../packages/domain/src/admin";
import OverviewInsights from "./OverviewInsights";
import { ArrowUp, SquarePen, MessagesSquare } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import {readUsage} from "./read-usage";
import { api } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";
import { useReceipts, ReceiptStatus } from "./receipts";
export function Overview({ snapshot: s, overview, reporting, history, receiptsDeferred, reportingTime, captureKey, navigate, readOnly = false, ...details }) {
  const roster = overview || overviewRoster(s.people.filter(operationallyActive).map(p => [p.asYear,p.university,1]));
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey, enabled: !readOnly });
  return (
    <>
      <Heading
        title="Overview"
        description={`${overview?.term || s?.terms.find((t) => t.isCurrent)?.label || "Semester not configured"} · Detachment 225`}
      />
      <dl className="overview-roster" aria-label="Active Wing roster">
        {Object.entries({activeCadets:"Active cadets",gmcCadets:"GMC",pocCadets:"POC",crosstowns:"Crosstowns",farCrosstowns:"Far crosstowns"}).map(([key,label]) =>
          <div key={key}><dt>{label}</dt><dd>{roster[key] ?? "—"}</dd></div>)}
      </dl>
      <OverviewInsights {...details} overview={overview} snapshot={s} reporting={reporting} reportingTime={reportingTime} captureKey={captureKey}
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
export function Assistant({meta}){
  if(!meta.assistantAvailable)return <section><Heading title="Assistant"/><p role="status">The assistant is currently unavailable.</p></section>;
  return <AssistantWorkspace meta={meta}/>;
}
function AssistantWorkspace({ meta }) {
  const [messages,setMessages]=useState([]), [text,setText]=useState(""),
    [busy,setBusy]=useState(false), [error,setError]=useState("");
  const input=useRef(null), inFlight=useRef(false);
  const [active,setActive]=useState(null), [chats,setChats]=useState([]), [showChats,setShowChats]=useState(false);
  const [opening,setOpening]=useState(false), [query,setQuery]=useState("");
  const threads=useRef(new Map());
  const hosted=meta.hosted && meta.assistantAvailable;
  useEffect(()=>{
    if(!hosted)return;
    const controller=new AbortController();
    api("/chat/history",undefined,{signal:controller.signal}).then(({chats:stored})=>{
      setChats(current=>[...current,...stored.filter(row=>!current.some(chat=>chat.id===row.id))]);
    }).catch(()=>{if(!controller.signal.aborted)setError("Recent chats could not be loaded.");});
    return ()=>controller.abort();
  },[hosted]);
  const log=useRef(null);
  useLayoutEffect(()=>{
    const field=input.current;
    field.style.height="auto";
    field.style.height=field.scrollHeight+"px";
  },[text]);
  useLayoutEffect(()=>{
    const transcript=log.current;
    const latest=transcript.lastElementChild;
    if(latest)transcript.scrollTop+=latest.getBoundingClientRect().top-transcript.getBoundingClientRect().top;
  },[messages]);
  function newChat(){
    setActive(null);setMessages([]);setText("");setError("");setShowChats(false);input.current?.focus();
  }
  async function openChat(chat){
    if(inFlight.current)return;
    inFlight.current=true;setOpening(true);setError("");
    try{
      const saved=threads.current.get(chat.id) || (await api("/chat/history?id="+chat.id)).messages;
      if(!saved.length)throw new Error("This conversation is unavailable. Try again shortly.");
      setActive(chat);setMessages(saved);setText("");setShowChats(false);
    }catch(e){setError(e.message);}
    finally{inFlight.current=false;setOpening(false);}
  }
  async function send(event){
    event.preventDefault();
    if(inFlight.current || !meta.assistantAvailable || !text.trim())return;
    inFlight.current=true;
    const question=text.trim(), next=[...messages,{role:"user",content:question}];
    const chat=active || {id:crypto.randomUUID(),title:question.slice(0,90)};
    setMessages(next);setText("");setBusy(true);setError("");
    try{
      const reply=await api("/chat",{...(hosted ? {chatId:chat.id,chatTitle:chat.title} : {}),messages:next.slice(-15).map(({role,content})=>({role,content}))});
      const transcript=[...next,{role:"assistant",content:reply.content,proposal:reply.proposal}];
      setMessages(transcript);setActive(chat);
      threads.current.set(chat.id,transcript);
      setChats(rows=>[{...chat,at:Date.now()},...rows.filter(row=>row.id!==chat.id)]);
      if(reply.saved===false)setError("This reply could not be saved to chat history.");
    }catch(e){
      setMessages(messages);setText(draft=>draft || question);setError(e.message);
    }finally{inFlight.current=false;setBusy(false);}
  }
  return <section className="assistant-page">
    <Heading title="Assistant">
      <div className="chat-actions">
        <button className="chat-history-toggle" aria-expanded={showChats} onClick={()=>setShowChats(!showChats)}><MessagesSquare size={16}/>Recent chats</button>
        <button disabled={busy || opening} onClick={newChat}><SquarePen size={16}/>New chat</button>
      </div>
    </Heading>
    <div className="chat-workspace">
    <aside aria-label="Recent chats" className={"chat-library"+(showChats ? " expanded" : "")}>
      <h2>Recent chats</h2>
      {chats.length>1 && <input type="search" aria-label="Search chat titles" placeholder="Search chats" value={query} onChange={e=>setQuery(e.target.value)}/>}
      {!chats.length && <small>No conversations yet.</small>}
      {chats.filter(row=>row.title.toLowerCase().includes(query.trim().toLowerCase())).map(row=>
        <button key={row.id} className="chat-link" aria-current={active?.id===row.id ? "true" : undefined} disabled={busy || opening} onClick={()=>openChat(row)}>
          <span>{row.title}</span><time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time>
        </button>)}
    </aside>
    <div className={"chat-main"+(messages.length ? "" : " empty-chat")} aria-busy={opening}>
    {opening && <p role="status">Opening conversation…</p>}
    <div ref={log} className="conversation" role="log" aria-label="Conversation">
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
      <textarea ref={input} aria-label="Ask SHAMROCK"
        rows={1} placeholder={messages.length ? "Ask a follow-up…" : "Ask SHAMROCK…"}
        maxLength={meta.hosted ? 1000 : 6000} value={text} onChange={e=>setText(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form.requestSubmit();}}}
        disabled={opening || !meta.assistantAvailable}/>
      <button className="chat-send" aria-label="Send question" title="Send question" disabled={opening || busy || !meta.assistantAvailable || !text.trim()}><ArrowUp size={19} strokeWidth={2.5}/></button>
    </form>
    </div></div>
  </section>;
}
