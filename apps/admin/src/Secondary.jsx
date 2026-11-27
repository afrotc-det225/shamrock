import {EventApproval} from "./EventApproval";
import { MaintenanceProposal } from "./MaintenanceProposal";
import React, { useLayoutEffect, useEffect, useRef, useState } from "react";
import {overviewRoster} from "../../../packages/domain/src/frontend-reporting";
import {operationallyActive} from "../../../packages/domain/src/admin";
import OverviewInsights from "./OverviewInsights";
import { ArrowUp, SquarePen, PanelLeft, Search, X } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import {readUsage} from "./read-usage";
import { api, displayDate } from "./api";
import { useReceipts, ReceiptStatus } from "./receipts";
export function Overview({ snapshot: s, overview, reporting, reportingTime, captureKey, ...details }) {
  const roster = overview || overviewRoster(s.people.filter(operationallyActive).map(p => [p.asYear,p.university,1]));
  return (
    <>
      <Heading title="Overview" />
      <dl className="overview-roster" aria-label="Active Wing roster">
        {Object.entries({activeCadets:"Active cadets",gmcCadets:"GMC",pocCadets:"POC",crosstowns:"Crosstowns",farCrosstowns:"Far crosstowns"}).map(([key,label]) =>
          <div key={key}><dt>{label}</dt><dd>{roster[key] ?? "—"}</dd></div>)}
      </dl>
      <OverviewInsights {...details} overview={overview} snapshot={s} reporting={reporting} reportingTime={reportingTime} captureKey={captureKey}/>

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
          <td>{displayDate(r.created)}</td>
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
function AdministratorList({lookup,cohort}){
  const endpoint=cohort ? "/chat/cohort-names" : lookup ? "/chat/roster?"+new URLSearchParams(lookup) : "/chat/administrators";
  const [rows,setRows]=useState(null),[error,setError]=useState(""),[attempt,retry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    api(endpoint,cohort ? {ids:cohort.ids} : undefined,{signal:controller.signal}).then(r=>setRows(r)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[attempt,endpoint,cohort]);
  if(error)return <p role="alert">{error} <button onClick={()=>{setError("");retry(i=>i+1);}}>Retry</button></p>;
  if(!rows)return <p role="status">Checking current records…</p>;
  if(lookup || cohort)return rows.rows.length ? <ul>{rows.rows.map((row,i)=><li key={i}>{row}</li>)}</ul> : <p>No matching cadets were found.</p>;
  const workbook=rows.workbook;
  const checked=workbook && new Date(workbook.checkedAt);
  const recent=checked && Date.now()-checked.getTime()<86400000;
  return <div>
    <strong>Operational workbook</strong>
    {checked ? <><p>{recent ? "Drive access checked" : "Last known access, checked"} {displayDate(checked)}.</p>
      <ul>{workbook.admins.map(a=><li key={a.account}>{a.label}{a.account!==a.label ? " ("+a.account+")" : ""} · {a.role}</li>)}</ul></> :
      <p>The workbook access list has not been verified.</p>}
    <strong>Staging panel</strong>
  <ul>{rows.administrators.map((r,i)=><li key={i}>{r.name} · {r.managesAccess ? "Manages permissions" : "Wing panel access"}</li>)}</ul></div>;
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
  useLayoutEffect(()=>{
    const drawer=historyMenu.current;
    if(showChats && !drawer.open){setQuery("");drawer.showModal();}
    if(!showChats && drawer.open)drawer.close();
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
          previousCohort:messages.at(-1)?.cohort?.ids,
          messages:next.slice(-15).map(({role,content})=>({role,content})),
        }),
      ]);
      const transcript=[...next,{role:"assistant",content:reply.content,proposal:reply.proposal,eventAction:reply.eventAction,cohort:reply.cohort,adminDirectory:reply.adminDirectory,rosterLookup:reply.rosterLookup,autoTest:true}];
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
  const groups=new Map();
  const today=new Date(), yesterday=new Date(today);
  yesterday.setDate(today.getDate()-1);
  for(const chat of chats){
    if(!chat.title.toLowerCase().includes(query.trim().toLowerCase()))continue;
    const date=new Date(chat.at);
    const label=date.toDateString()===today.toDateString() ? "Today" : date.toDateString()===yesterday.toDateString() ? "Yesterday" :
      date.toLocaleDateString(undefined,{month:"long",day:"numeric",...(date.getFullYear()!==today.getFullYear()?{year:"numeric"}:{})});
    if(!groups.has(label))groups.set(label,[]);
    groups.get(label).push(chat);
  }
  function chatLink(row){
    return <button key={row.id} className="chat-link" aria-current={active?.id===row.id ? "true" : undefined} disabled={busy || !!opening} onClick={()=>openChat(row)}>
      <span className="history-title" title={row.title}>{row.title}</span>{opening===row.id && <span role="status" aria-label="Loading chat" className="chat-loading-ring"/>}
    </button>;
  }
  return <section ref={page} className="assistant-page">
    <div className="assistant-toolbar">
      <button className="icon" ref={historyToggle} aria-label="Recent chats" title="Recent chats" aria-expanded={showChats} aria-controls="assistant-history" onClick={()=>{if(hosted)refreshStaleHistory();setShowChats(true);}}><PanelLeft size={20}/></button>
      <Heading title="Assistant"/>
    </div>
    <dialog ref={historyMenu} id="assistant-history" aria-label="Recent chats" className="history-drawer" onCancel={()=>setShowChats(false)} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX>r.right || e.clientX<r.left)setShowChats(false);}}}>
      <header><h2>Recent chats</h2><button className="icon" aria-label="Close recent chats" onClick={()=>setShowChats(false)}><X size={18}/></button></header>
      <button className="history-new" disabled={busy || !!opening} onClick={()=>{newChat();requestAnimationFrame(()=>input.current?.focus());}}><SquarePen size={17}/>New chat</button>
      {chats.length>1 && <label className="history-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label="Search chat titles" placeholder="Search chats" value={query} onChange={e=>setQuery(e.target.value)}/></label>}
      <div className="history-entries">{historyNotice}
        {[...groups].map(([label,rows])=><section key={label} aria-label={label}><h3>{label}</h3>{rows.map(chatLink)}</section>)}
        {!!chats.length && !groups.size && <small>No matching chats.</small>}
        {error && <p role="alert">{error}</p>}
      </div>
    </dialog>
    <div className="chat-workspace">

    <div className={"chat-main"+(messages.length ? "" : " empty-chat")} aria-busy={!!opening}>
    <div ref={log} className="conversation" role="log" aria-label="Conversation">
      {messages.map((m,i)=><article key={(active?.id || "draft")+":"+i} aria-label={m.role==="user" ? "Your message" : "Assistant response"} className={"message "+m.role}>
        {m.role==="user" ? <p>{m.content}</p> : <ReplyBoundary fallback={<PlainReply text={m.content}/>}>
          <Reply text={m.content}/>
        </ReplyBoundary>}
        {(m.cohort?.names || m.rosterLookup || m.adminDirectory) && <AdministratorList lookup={m.rosterLookup} cohort={m.cohort}/>}
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
