import React from "react";
import Brand from "./Brand";

export default function WorkspaceShell({ pages, page, navigate, account, children, drawer }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Main navigation">
          {pages.map(([title, Icon]) => (
            <button key={title} className={page === title ? "selected" : ""}
              aria-current={page === title ? "page" : undefined}
              onClick={() => navigate(title)}>
              <Icon size={19} aria-hidden="true" />
              {title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">{account}</div>
      </aside>
      <div className="workspace"><main>{children}</main></div>
      {drawer}
    </div>
  );
}
