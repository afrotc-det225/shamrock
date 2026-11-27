import React from "react";
import Brand from "./Brand";

import {pageHref} from "./page-url";

export function PageLink({workspace, title, navigate, children, className="", ...props}) {
  return <a {...props} className={`workspace-page-link ${className}`} href={pageHref(workspace,title)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(title);
  }}>{children}</a>;
}

export default function WorkspaceShell({ workspace="leadership", pages, page, navigate, account, children, drawer }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
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
      </aside>
      <div className="workspace"><main>{children}</main></div>
      {drawer}
    </div>
  );
}
