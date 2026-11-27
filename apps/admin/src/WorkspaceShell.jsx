import React, {useContext, useEffect, useRef, useState} from "react";
import {Menu, X} from "lucide-react";
import Brand from "./Brand";
import {usePhone} from "./use-phone";
import {EditorSuspended} from "./components";

import {pageHref} from "./page-url";

export function PageLink({workspace, title, navigate, children, className="", ...props}) {
  return <a {...props} className={`workspace-page-link ${className}`} href={pageHref(workspace,title)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(title);
  }}>{children}</a>;
}

export default function WorkspaceShell({ workspace="leadership", pages, page, navigate, account, children, drawer, mobileContext }) {
  const mobile = usePhone();
  const menu = useRef(null);
  const [open, setOpen] = useState(false);
  const suspended = useContext(EditorSuspended);
  useEffect(() => {
    if (!mobile) setOpen(false);
    if (suspended && menu.current?.open) menu.current.close();
  }, [mobile, suspended]);
  const links = <>
    <nav aria-label="Main navigation">
      {pages.map(([title, Icon]) => (
        <PageLink workspace={workspace} title={title} navigate={navigate} key={title} className={page === title ? "selected" : ""}
          aria-current={page === title ? "page" : undefined}>
          <Icon size={19} aria-hidden="true" />
          {title}
        </PageLink>
      ))}
    </nav>
    <div className="sidebar-bottom">{account}</div>
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
