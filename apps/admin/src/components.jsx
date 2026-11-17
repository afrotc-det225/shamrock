import React, { useEffect, useRef, useContext, createContext } from "react";
export const EditorError = createContext("");
import { X, Search } from "lucide-react";
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
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}
export function Status({ children }) {
  return (
    <span
      className={`status ${["active", "Approved", "complete"].includes(children) ? "good" : ""}`}
    >
      {children}
    </span>
  );
}
export function Drawer({ title, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} className="drawer" onCancel={onClose}>
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
  note = "Changes are reviewed before they are saved.",
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
          <p>{note}</p>
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
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
