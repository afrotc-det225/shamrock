import React, { useEffect, useId, useRef, useState } from "react";

export function ToolbarPopover({
  label,
  icon: Icon,
  shortLabel,
  iconOnly,
  active,
  children,
}) {
  const id = useId(),
    trigger = useRef(null),
    panel = useRef(null);
  const [open, setOpen] = useState(false);

  function position() {
    const rect = trigger.current.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      if (panel.current.matches(":popover-open")) panel.current.hidePopover();
      return;
    }
    const above = rect.top,
      below = window.innerHeight - rect.bottom;
    const upwards = below < 300 && above > below;
    Object.assign(panel.current.style, {
      top: upwards ? "auto" : rect.bottom + 6 + "px",
      bottom: upwards ? window.innerHeight - rect.top + 6 + "px" : "auto",
      maxHeight: Math.max(0, (upwards ? above : below) - 14) + "px",
    });
    panel.current.style.setProperty("--trigger-right", rect.right + "px");
  }
  useEffect(() => {
    if (!open) return;
    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="toolbar-tool"
        ref={trigger}
        popoverTarget={id}
        aria-label={label}
        title={label}
        aria-expanded={open}
        data-active={active || undefined}
      >
        <Icon size={16} aria-hidden="true" />
        {!iconOnly && <span>{shortLabel || label}</span>}
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="region"
        aria-label={label}
        className="toolbar-popover"
        onBeforeToggle={(e) => {
          if (e.nativeEvent.newState === "open") position();
        }}
        onToggle={() => setOpen(panel.current.matches(":popover-open"))}
      >
        {children}
      </div>
    </>
  );
}
