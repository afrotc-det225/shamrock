import React, { useEffect, useRef, useId, useContext, createContext } from "react";
import { createPortal } from "react-dom";
export const EditorError = createContext("");
export const EditorSuspended = createContext(false);
import { X, Search, Check, Clock3, Minus, CircleAlert } from "lucide-react";
export function Field({ label, children, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children || <input {...props} />}
    </label>
  );
}
export function Select({ label, value, onChange, options, ...rest }) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      >
        {options.map((o) => (
          <option
            key={typeof o === "string" ? o : o.value}
            value={typeof o === "string" ? o : o.value}
          >
            {typeof o === "string" ? o : o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function SearchBox({ value, onChange, placeholder, resultCount }) {
  return (
    <label className="search">
      <Search size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {resultCount != null && <small className="search-count" role="status">{resultCount} {resultCount===1 ? "match" : "matches"}</small>}
    </label>
  );
}
export function Heading({ title, description, children }) {
  return (
    <div className="heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}
export function Status({ children }) {
  const text = String(children ?? ""),
    key = text.toLowerCase();
  const tone = [
    "active",
    "approved",
    "complete",
    "saved",
    "p",
    "ready 4/4",
  ].includes(key)
    ? "good"
    : ["denied", "a", "u", "conflict", "rejected"].includes(key)
      ? "bad"
      : [
            "submitted",
            "pending",
            "t",
            "retryable",
            "applying",
            "needs review",
          ].includes(key)
        ? "pending"
        : ["e", "es", "med", "active 3/4", "enrolled 2/4"].includes(key)
          ? "info"
          : "neutral";
  const Icon =
    tone === "good"
      ? Check
      : tone === "bad"
        ? CircleAlert
        : tone === "pending"
          ? Clock3
          : Minus;
  return (
    <span className={`status ${tone}`}>
      <Icon size={12} aria-hidden="true" />
      {children}
    </span>
  );
}
export function Drawer({ title, children, onClose, modal=false, bottomSheet=false }) {
  const ref=useRef(null), close=useRef(onClose), suspended=useContext(EditorSuspended);
  close.current=onClose;
  const titleId=useId();
  useEffect(()=>{
    if(suspended)return;
    const el=ref.current, mobile=matchMedia("(max-width: 640px)");
    const opener=document.activeElement;
    function open() {
      if(el.open)el.close();
      if(modal || (mobile.matches && !bottomSheet))el.showModal();
      else el.show();
    }
    function escape(e) {
      if (e.key !== "Escape" || document.querySelector("dialog:modal")) return;
      const openDrawers = document.querySelectorAll("dialog[open]");
      if (openDrawers[openDrawers.length-1]===el) {
        e.preventDefault();close.current();
      }
    }
    open(); mobile.addEventListener("change",open); document.addEventListener("keydown",escape);
    return ()=>{mobile.removeEventListener("change",open);document.removeEventListener("keydown",escape);
      const inside=el.contains(document.activeElement);
      el.close(); if(inside && opener?.isConnected)opener.focus({preventScroll:true});};
  },[modal,bottomSheet,suspended]);
  return createPortal(<dialog ref={ref} className={bottomSheet?"drawer cell-editor":"drawer"} aria-labelledby={titleId}
    onCancel={e=>{e.preventDefault();onClose();}}>
    <header><h2 id={titleId}>{title}</h2><button aria-label="Close editor" onClick={onClose}><X size={21}/></button></header>
    {children}
  </dialog>,document.body);
}
export function Editor({
  title,
  onClose,
  onSubmit,
  busy,
  children,
  note = "",
  bottomSheet = false,
}) {
  const error = useContext(EditorError);
  return (
    <Drawer title={title} onClose={onClose} bottomSheet={bottomSheet}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="fields">
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {children}
        </div>
        <footer>
          {note && <p>{note}</p>}
          <div className="actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Review change
            </button>
          </div>
        </footer>
      </form>
    </Drawer>
  );
}
export function Table({ headers, children }) {
  const ref = useRef();
  useEffect(() => {
    const container = ref.current,
      table = container.querySelector("table");
    const controls = container.closest("main")?.querySelector(".page-controls");
    const measure = () => {
      container.dataset.horizontal = String(
        table.scrollWidth > container.clientWidth + 1,
      );
      container.style.setProperty(
        "--controls-height",
        `${controls?.getBoundingClientRect().height || 0}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(table);
    if (controls) observer.observe(controls);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h, index) => (
              <th key={`${index}:${h}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
