import {EventApproval} from "./EventApproval";
import { MaintenanceProposal } from "./MaintenanceProposal";
import React, { useLayoutEffect, useEffect, useRef, useState } from "react";
import {overviewRoster} from "../../../packages/domain/src/frontend-reporting";
import {operationallyActive} from "../../../packages/domain/src/admin";
import OverviewInsights from "./OverviewInsights";
import { ArrowUp, SquarePen, MessagesSquare } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import {readUsage} from "./read-usage";
import { api } from "./api";
import { useReceipts, ReceiptStatus } from "./receipts";
export function Overview({ snapshot: s, overview, reporting, history, receiptsDeferred, reportingTime, captureKey, readOnly = false, ...details }) {
  const roster = overview || overviewRoster(s.people.filter(operationallyActive).map(p => [p.asYear,p.university,1]));
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey, enabled: !readOnly });
  return (
    <>
      <Heading title="Overview" />
      <dl className="overview-roster" aria-label="Active Wing roster">
        {Object.entries({activeCadets:"Active cadets",gmcCadets:"GMC",pocCadets:"POC",crosstowns:"Crosstowns",farCrosstowns:"Far crosstowns"}).map(([key,label]) =>
          <div key={key}><dt>{label}</dt><dd>{roster[key] ?? "—"}</dd></div>)}
      </dl>
      <OverviewInsights {...details} overview={overview} snapshot={s} reporting={reporting} reportingTime={reportingTime} captureKey={captureKey}/>
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
const loadReplyRenderer = () => import("./AssistantResponse").then(module=>module.default,()=>PlainReply);
// A missing formatting bundle or an invalid saved proposal must not unmount the workspace.
class ReplyBoundary extends React.Component {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed ? this.props.fallback : this.props.children;}
}
function AdministratorList(){
  const [rows,setRows]=useState(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    api("/chat/administrators",undefined,{signal:controller.signal}).then(r=>setRows(r.administrators)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[attempt]);
  if(error)return <p role="alert">{error} <button onClick={()=>{setError("");retry(i=>i+1);}}>Retry</button></p>;
  if(!rows)return <p role="status">Checking current access…</p>;
  if(!rows.length)return <p>No active accounts have Wing administrator access.</p>;
  return <ul>{rows.map((r,i)=><li key={i}>{r.name}{r.managesAccess ? " · Manages permissions" : ""}</li>)}</ul>;
}
function PlainReply({text}){
  return <div className="assistant-answer plain-reply">{text}</div>;
}
export function Assistant({meta}){
  if(!meta.assistantAvailable)return <section><Heading title="Assistant"/><p role="status">The assistant is currently unavailable.</p></section>;
  return <AssistantWorkspace meta={meta}/>;
}
function AssistantWorkspace({ meta }) {
  const [messages,setMessages]=useState([]), [text,setText]=useState(""),
    [busy,setBusy]=useState(false), [error,setError]=useState("");
  const input=useRef(null), inFlight=useRef(false);
  const [active,setActive]=useState(null), [chats,setChats]=useState([]), [showChats,setShowChats]=useState(false);
  const [Reply,setReply]=useState(()=>PlainReply);
  const [opening,setOpening]=useState(null), [query,setQuery]=useState("");
  const [historyState,setHistoryState]=useState("loading"), [historyAttempt,retryHistory]=useState(0);
  const page=useRef(null);
  const historyMenu=useRef(null), historyToggle=useRef(null);
  useEffect(()=>{
    if(!showChats)return;
    function dismissOutside(event){
      if(!historyMenu.current?.contains(event.target))setShowChats(false);
    }
    function escape(event){
      if(event.key==="Escape"){setShowChats(false);historyToggle.current?.focus();}
    }
    document.addEventListener("pointerdown",dismissOutside);
    document.addEventListener("focusin",dismissOutside);
    document.addEventListener("keydown",escape);
    return ()=>{
      document.removeEventListener("pointerdown",dismissOutside);
      document.removeEventListener("focusin",dismissOutside);
      document.removeEventListener("keydown",escape);
    };
  },[showChats]);
  const hosted=meta.hosted && meta.assistantAvailable;
  const threads=useRef(new Map()), lastHistoryRead=useRef(0);
  function refreshStaleHistory(){
    if(document.visibilityState==="visible" && Date.now()-lastHistoryRead.current>60000){
      lastHistoryRead.current=Date.now();
      retryHistory(n=>n+1);
    }
  }
  useEffect(()=>{
    if(!hosted)return;
    document.addEventListener("visibilitychange",refreshStaleHistory);
    return ()=>document.removeEventListener("visibilitychange",refreshStaleHistory);
  },[hosted]);
  useEffect(()=>{
    if(!hosted)return;
    const controller=new AbortController();
    lastHistoryRead.current=Date.now();
    setHistoryState("loading");
    api("/chat/history",undefined,{signal:controller.signal}).then(({chats:stored})=>{
      setHistoryState("ready");
      setChats(current=>{
        const byId=new Map(stored.map(row=>[row.id,row]));
        for(const row of current)if(!byId.has(row.id) || row.at>byId.get(row.id).at)byId.set(row.id,row);
        return [...byId.values()].sort((a,b)=>b.at-a.at);
      });
    }).catch(()=>{if(!controller.signal.aborted)setHistoryState("failed");});
    return ()=>controller.abort();
  },[hosted,historyAttempt]);
  useLayoutEffect(()=>{
    const viewport=window.visualViewport, shell=page.current?.closest(".app");
    if(!viewport || !shell)return;
    function fit(){if(viewport.scale===1)shell.style.setProperty("--chat-visible-height",viewport.height+"px");}
    fit();viewport.addEventListener("resize",fit);
    return ()=>{viewport.removeEventListener("resize",fit);shell.style.removeProperty("--chat-visible-height");};
  },[]);
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
    inFlight.current=true;setOpening(chat.id);setError("");
    try{
      const [renderer,saved]=await Promise.all([
        loadReplyRenderer(),
        threads.current.get(chat.id) ?? api("/chat/history?id="+chat.id).then(result=>result.messages),
      ]);
      if(!Array.isArray(saved) || !saved.length || saved.some(m=>!m || !["user","assistant"].includes(m.role) || typeof m.content!=="string"))throw new Error("This conversation is unavailable. Try again shortly.");
      setReply(()=>renderer);setActive(chat);setMessages(saved);setText("");setShowChats(false);
    }catch(e){setError(e.message);}
    finally{inFlight.current=false;setOpening(null);}
  }
  async function send(event){
    event.preventDefault();
    if(inFlight.current || !meta.assistantAvailable || !text.trim())return;
    inFlight.current=true;
    const question=text.trim(), next=[...messages,{role:"user",content:question}];
    const chat=active || {id:crypto.randomUUID(),title:question.slice(0,90)};
    setMessages(next);setText("");setBusy(true);setError("");
    try{
      const [renderer,reply]=await Promise.all([
        loadReplyRenderer(),
        api("/chat",{
          ...(hosted ? {chatId:chat.id,chatTitle:chat.title} : {}),
          messages:next.slice(-15).map(({role,content})=>({role,content})),
        }),
      ]);
      const transcript=[...next,{role:"assistant",content:reply.content,proposal:reply.proposal,eventAction:reply.eventAction,adminDirectory:reply.adminDirectory,autoTest:true}];
      setReply(()=>renderer);setMessages(transcript);setActive(chat);
      threads.current.set(chat.id,transcript);
      setChats(rows=>[{...chat,at:Date.now()},...rows.filter(row=>row.id!==chat.id)]);
      if(reply.saved===false)setError("This reply could not be saved to chat history.");
    }catch(e){
      setMessages(messages);setText(draft=>draft || question);setError(e.message);
    }finally{inFlight.current=false;setBusy(false);}
  }
  const historyNotice=historyState==="loading" ? <small role="status">Loading recent chats…</small> :
    historyState==="failed" ? <button type="button" onClick={()=>retryHistory(n=>n+1)}>Retry loading recent chats</button> :
    !chats.length ? <small>No conversations yet.</small> : null;
  function chatLink(row){
    return <button key={row.id} className="chat-link" aria-current={active?.id===row.id ? "true" : undefined} disabled={busy || !!opening} onClick={()=>openChat(row)}>
      <span>{row.title}</span><span className="chat-date" data-loading={opening===row.id || undefined}><time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time>{opening===row.id && <span role="status" aria-label="Loading chat" className="chat-loading-ring"/>}</span>
    </button>;
  }
  return <section ref={page} className="assistant-page">
    <Heading title="Assistant" />
      <div className="chat-actions">
        <div ref={historyMenu} className="chat-history-menu">
          <button ref={historyToggle} aria-controls="assistant-history" aria-expanded={showChats} onClick={()=>{if(!showChats && hosted)refreshStaleHistory();setShowChats(!showChats);}}><MessagesSquare size={16}/>Recent chats</button>
          <aside aria-label="Recent chats" id="assistant-history" className="chat-library" hidden={!showChats}>
            {chats.length>1 && <input type="search" aria-label="Search chat titles" placeholder="Search chats" value={query} onChange={e=>setQuery(e.target.value)}/>}
            {historyNotice}
            {chats.filter(row=>row.title.toLowerCase().includes(query.trim().toLowerCase())).map(chatLink)}
          </aside>
        </div>
        <button disabled={busy || !!opening} onClick={newChat}><SquarePen size={16}/>New chat</button>
      </div>
    <div className="chat-workspace">

    <div className={"chat-main"+(messages.length ? "" : " empty-chat")} aria-busy={!!opening}>
    {hosted && !messages.length && !showChats && <section className="mobile-recent" aria-label="Recent conversations">
      <h2>Recent chats</h2>{historyNotice}{chats.slice(0,3).map(chatLink)}
    </section>}
    <div ref={log} className="conversation" role="log" aria-label="Conversation">
      {messages.map((m,i)=><article key={(active?.id || "draft")+":"+i} className={"message "+m.role}>
        <span className="message-author">{m.role==="user" ? "You" : "SHAMROCK assistant"}</span>
        {m.role==="user" ? <p>{m.content}</p> : <ReplyBoundary fallback={<PlainReply text={m.content}/>}>
          <Reply text={m.content}/>
        </ReplyBoundary>}
        {m.adminDirectory && <AdministratorList/>}
        {m.eventAction && <EventApproval action={m.eventAction}/>}
        {m.proposal && <ReplyBoundary fallback={<p role="status">The saved proposal could not be displayed.</p>}><MaintenanceProposal proposal={m.proposal} autoTest={m.autoTest}/></ReplyBoundary>}
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
