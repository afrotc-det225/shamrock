import React, {useContext, useEffect, useRef, useState} from "react";
import {Menu, Sparkles, UserRound, X} from "lucide-react";
import Brand from "./Brand";
import {usePhone} from "./use-phone";
import {EditorSuspended} from "./components";

import {api} from "./api";
import {leadershipPages, personalPages} from "./site-navigation";
import {ViewAsSelector} from "./ViewAs";
import {pageHref,writePageUrl} from "./page-url";

export function PageLink({workspace, title, navigate, children, className="", ...props}) {
  return <a {...props} className={`workspace-page-link ${className}`} href={pageHref(workspace,title)} onClick={event => {
    if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(title);
  }}>{children}</a>;
}

export default function WorkspaceShell({ workspace="leadership", pages, page, navigate, account, children, drawer, mobileContext, session, preview }) {
  const mobile = usePhone();
  const menu = useRef(null);
  const [open, setOpen] = useState(false);
  const [accountError,setAccountError] = useState("");
  const suspended = useContext(EditorSuspended);
  useEffect(() => {
    if (!mobile) setOpen(false);
    if (suspended && menu.current?.open) menu.current.close();
  }, [mobile, suspended]);
  const include = workspace === "cadet" ? "leadership" : "personal";
  const dual = session && !session.schoolLogin && (preview ? preview.status === "ready" && session.hosted : session.cadetWorkspace);
  const key = dual ? include + "/" + (preview?.entryAuditId || "self") : null;
  const [result, setResult] = useState(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    api("/navigation?include="+include, undefined, {signal:controller.signal})
      .then(value => { if (!controller.signal.aborted) setResult({key,value}); })
      .catch(() => { if (!controller.signal.aborted) setResult({key,error:true}); });
    return () => controller.abort();
  }, [key,include,retry]);
  const navigation = key && result?.key === key ? result : null;
  const other = navigation?.value;
  const personal = workspace === "cadet" ? pages : other?.personal?.registration
    ? [["My profile",UserRound]] : personalPages(other?.personal);
  const leadership = workspace === "leadership" ? pages : other?.leadership ? leadershipPages(other.leadership.full,preview) : [];
  const openPage = (source,title) => {
    writePageUrl(source,title);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const links = <>
    <nav aria-label="Main navigation">
      {[
        ...leadership.map(([title,Icon]) => [title,Icon,"leadership"]),
        ...personal.filter(([title]) => !leadership.some(([name]) => name===title)).map(([title,Icon]) => [title,Icon,"cadet"]),
      ].map(([title, Icon, source]) => (
        <PageLink workspace={source} title={title} navigate={source===workspace ? navigate : name=>openPage(source,name)} key={title} className={page === title ? "selected" : ""}
          aria-current={page === title ? "page" : undefined}>
          <Icon size={19} aria-hidden="true" />
          {title}
        </PageLink>
      ))}
    </nav>
    <div className="sidebar-bottom">
      {navigation?.error && <button onClick={()=>setRetry(v=>v+1)}>Retry loading menu</button>}
      {other?.leadership?.canViewAs && <ViewAsSelector onSelect={async person=>{
        try {
          const result=await api("/view-as",{personId:person.personId});
          location.assign(result.directoryWorkspace ? "/me/profile" : "/attendance");
        } catch { setAccountError("Could not open View as. Reload to check your session."); }
      }}/>}
      {other?.leadership?.full && !preview && <PageLink workspace="leadership" title="Assistant" navigate={name=>openPage("leadership",name)}><Sparkles size={20}/>Assistant</PageLink>}
      {accountError && <p role="alert">{accountError}</p>}
      {account}
    </div>
  </>;
  return (
    <div className="app">
      {mobile ? <>
        <header className="mobile-bar">
          <Brand/><div className="mobile-page"><strong>{page}</strong>{mobileContext && <small>{mobileContext}</small>}</div>
          <button aria-label="Open navigation" aria-expanded={open} aria-controls="mobile-navigation"
            onClick={() => {menu.current.showModal(); setOpen(true);}}><Menu size={19}/> Menu</button>
        </header>
        <dialog ref={menu} id="mobile-navigation" className="sidebar mobile-menu" aria-label="Navigation"
          onClose={() => setOpen(false)}
          onClick={e => {
            if (e.target !== menu.current) return;
            const rect = menu.current.getBoundingClientRect();
            if (e.clientX > rect.right || e.clientX < rect.left) menu.current.close();
          }}>
          <div className="mobile-menu-screen">
          <header><Brand/><button aria-label="Close navigation" onClick={() => menu.current.close()}><X size={20}/></button></header>
          <div className="menu-links" onClickCapture={e => {
            if (menu.current.contains(e.target) && e.target.closest("button,a") &&
                !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) menu.current.close();
          }}>{links}</div>
          </div>
        </dialog>
      </> : <aside className="sidebar"><Brand/>{links}</aside>}
      <div className="workspace"><main>{children}</main></div>
      {drawer}
    </div>
  );
}
