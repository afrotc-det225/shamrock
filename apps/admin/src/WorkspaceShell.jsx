import React, {useContext, useEffect, useLayoutEffect, useRef, useState} from "react";
import {Menu, Shield, Sparkles, UserRound, X} from "lucide-react";
import Brand from "./Brand";
import {usePhone} from "./use-phone";
import {EditorSuspended} from "./components";

import {api} from "./api";
import {leadershipPages, personalPages} from "./site-navigation";
import {ViewAsSelector} from "./ViewAs";
import {pageHref,writePageUrl} from "./page-url";

const navigationOrder = ["Overview","My Flight","My excusals","My attendance","Submit attendance","Events","Attendance","Excusals","Attendance reviews","Cadets","Leadership","My profile","Semester planning","System"];

export function PageLink({workspace, title, navigate, children, className="", ...props}) {
  return <a {...props} className={`workspace-page-link ${className}`} href={pageHref(workspace,title)} onClick={event => {
    if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(title);
  }}>{children}</a>;
}

export default function WorkspaceShell({ workspace="leadership", pages, page, tabTitle=page, navigate, account, children, drawer, mobileContext, session, preview }) {
  useLayoutEffect(() => {
    document.title = tabTitle ? tabTitle + " · SHAMROCK" : "SHAMROCK";
    return () => { document.title = "SHAMROCK"; };
  }, [tabTitle]);
  const mobile = usePhone();
  const menu = useRef(null);
  const content = useRef(null);
  useLayoutEffect(() => {
    const reset = () => {
      window.scrollTo({top:0, behavior:"instant"});
      content.current?.scrollTo({top:0, behavior:"instant"});
    };
    reset();
    const frame = requestAnimationFrame(reset);
    return () => cancelAnimationFrame(frame);
  }, [workspace,page]);
  const [open, setOpen] = useState(false);
  const [accountError,setAccountError] = useState("");
  const suspended = useContext(EditorSuspended);
  useEffect(() => {
    if (!mobile) setOpen(false);
    if (suspended && menu.current?.open) menu.current.close();
  }, [mobile, suspended]);
  const include = workspace === "cadet" ? "leadership" : "personal";
  const dual = session && !session.schoolLogin && (preview ? preview.status === "ready" && session.hosted : (session.cadetWorkspace || workspace === "cadet" && session.hosted));
  const key = dual ? include + "/" + (preview?.entryAuditId || "self") : null;
  const [navigation, setNavigation] = useState(null);
  const [menuAttempt, setMenuAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const load = () => api("/navigation?include="+include, undefined, {signal:controller.signal})
      .then(value => { if (!controller.signal.aborted) setNavigation({key,value}); })
      .catch(() => { if (!controller.signal.aborted) setNavigation({key,failed:true}); });
    load();
    window.addEventListener("online",load);
    return () => { controller.abort(); window.removeEventListener("online",load); };
  }, [key,include,menuAttempt]);
  const other = key && navigation?.key === key ? navigation.value : null;
  const showWingSwitch = workspace === "cadet" && (other ? other.leadership?.full : !preview && session?.schoolWingAccess);
  const personal = workspace === "cadet" ? pages : other?.personal?.registration
    ? [["My profile",UserRound]] : personalPages(other?.personal);
  const leadership = workspace === "leadership" ? pages : other?.leadership ? leadershipPages(other.leadership.full,preview) : [];
  const openPage = (source,title) => {
    writePageUrl(source,title);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const home = pages.some(([title]) => title === "My Flight") ? "My Flight"
    : pages.some(([title]) => title === "Overview") ? "Overview" : pages[0]?.[0];
  const brand = <Brand href={home ? pageHref(workspace,home) : "/"} onNavigate={home && (() => {
    if (menu.current?.open) menu.current.close();
    if (page !== home) navigate(home);
    else {
      window.scrollTo(0,0);
      content.current?.scrollTo(0,0);
    }
  })}/>;
  const wingSwitch = showWingSwitch &&
        <PageLink workspace="leadership" title="Overview" navigate={name=>openPage("leadership",name)}>
          <Shield size={18} aria-hidden="true"/>View as administrator
        </PageLink>;
  const links = <>
    <nav aria-label="Main navigation">
      {mobile && wingSwitch}
      {[
        ...leadership.map(([title,Icon]) => [title,Icon,"leadership"]),
        ...personal.filter(([title]) => !leadership.some(([name]) => name===title)).map(([title,Icon]) => [title,Icon,"cadet"]),
      ].sort(([left],[right]) => {
        return navigationOrder.indexOf(left)-navigationOrder.indexOf(right);
      }).map(([title, Icon, source]) => (
        <PageLink workspace={source} title={title} navigate={source===workspace ? navigate : name=>openPage(source,name)} key={title} className={page === title ? "selected" : ""}
          aria-current={page === title ? "page" : undefined}>
          <Icon size={19} aria-hidden="true" />
          {title}
        </PageLink>
      ))}
    </nav>
    <div className="sidebar-bottom">
      {key && navigation?.key === key && navigation.failed && <button type="button" data-keep-menu-open onClick={()=>setMenuAttempt(n=>n+1)}>Retry loading menu</button>}
      {!mobile && wingSwitch}
      {other?.leadership?.canViewAs && <ViewAsSelector onSelect={async person=>{
        try {
          const result=await api("/view-as",{personId:person.personId});
          location.assign(result.directoryWorkspace ? "/me/profile" : "/attendance");
        } catch { setAccountError("Could not open View as. Reload to check your session."); }
      }}/>}
      {other?.leadership?.assistantAvailable && !preview && <PageLink workspace="leadership" title="Assistant" navigate={name=>openPage("leadership",name)}><Sparkles size={20}/>Assistant</PageLink>}
      {accountError && <p role="alert">{accountError}</p>}
      {account}
    </div>
  </>;
  return (
    <div className="app">
      {mobile ? <>
        <header className="mobile-bar">
          {brand}<div className="mobile-page"><strong>{page}</strong>{mobileContext && <small>{mobileContext}</small>}</div>
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
          <header>{brand}<button aria-label="Close navigation" onClick={() => menu.current.close()}><X size={20}/></button></header>
          <div className="menu-links" onClickCapture={e => {
            if (menu.current.contains(e.target) && e.target.closest("button,a") && !e.target.closest("[data-keep-menu-open]") &&
                !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) menu.current.close();
          }}>{links}</div>
          </div>
        </dialog>
      </> : <aside className="sidebar">{brand}{links}</aside>}
      <div className="workspace" ref={content}><main>{children}</main></div>
      {drawer}
    </div>
  );
}
