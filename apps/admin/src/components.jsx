import React, { useEffect, useRef, useContext, createContext } from "react";
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
export function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="search">
      <Search size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
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
export function FlightLabel({ children }) {
  const value = String(children || "Unassigned");
  const colors = ["#426a9c", "#8a6624", "#32766e", "#765a91"];
  const index = Math.max(
    0,
    ["alpha", "bravo", "charlie", "delta"].indexOf(value.toLowerCase()),
  );
  return (
    <span className="flight-label">
      <span aria-hidden="true" style={{ background: colors[index] }} />
      {value}
    </span>
  );
}
export function AttendanceRate({ value }) {
  if (!value || value.noCountedAttendance)
    return <span className="muted">—</span>;
  const percent = Math.max(
    0,
    Math.min(100, Math.round(value.percentage * 100)),
  );
  return (
    <span className="attendance-rate">
      <span>{percent}%</span>
      <span className="rate-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}
export function Drawer({ title, children, onClose }) {
  const ref = useRef(), suspended = useContext(EditorSuspended);
  useEffect(() => {
    // Close the native top layer during an outage without discarding form state.
    // Hiding an ancestor alone leaves showModal() siblings inert.
    if (suspended) ref.current.close();
    else if (!ref.current.open) ref.current.showModal();
    return () => ref.current?.close();
  }, [suspended]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="Close editor" onClick={onClose}>
          <X size={21} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Editor({
  title,
  onClose,
  onSubmit,
  busy,
  children,
  note = "",
}) {
  const error = useContext(EditorError);
  return (
    <Drawer title={title} onClose={onClose}>
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
