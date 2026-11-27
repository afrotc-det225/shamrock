import React from "react";
export default function Brand({href = "/", onNavigate}) {
  return (
    <a className="brand" href={href} aria-label="SHAMROCK home" onClick={event => {
      if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate();
    }}>
      <img className="brand-mark" src="/shamrock.svg" alt="" />
      <div>
        SHAMROCK<small>Detachment 225</small>
      </div>
    </a>
  );
}
