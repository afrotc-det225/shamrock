import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Home,
  Users,
  ChevronsUp,
  CalendarDays,
  ClipboardList,
  Layers,
  Settings,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { api, startSession, label, logout } from "./api";
import { Drawer, EditorError } from "./components";
import Events from "./Events";
import People from "./People";
import Attendance from "./Attendance";
import Semester from "./Semester";
import { Overview, System, Assistant } from "./Secondary";
import "@fontsource/libre-franklin/latin-400.css";
import "@fontsource/libre-franklin/latin-500.css";
import "@fontsource/libre-franklin/latin-600.css";
import "@fontsource/libre-franklin/latin-700.css";
import "@fontsource/barlow-condensed/latin-600.css";
import Brand from "./Brand";
import "./style.css";
const pages = [
  ["Overview", Home],
  ["Cadets", Users],
  ["Leadership", ChevronsUp],
  ["Events", CalendarDays],
  ["Attendance & excusals", ClipboardList],
  ["Semester", Layers],
  ["System", Settings],
];
function App() {
  const [page, setPage] = useState("Events"),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [proposal, setProposal] = useState(null),
    [signIn, setSignIn] = useState(false);
  const reload = async () => setData(await api("/state"));
  useEffect(() => {
    startSession()
      .then(reload)
      .catch((e) => {
        if (e.code === "SIGN_IN_REQUIRED") setSignIn(true);
        else setError(e.message);
      });
  }, []);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const propose = (operation, payload, close) =>
    run(async () => {
      const p = await api("/proposals", { operation, payload });
      setProposal(p);
      close?.();
    });
  const apply = (id) =>
    run(async () => {
      let result = await api(`/proposals/${id}/apply`, { approved: true });
      for (let step = 0; result.state === "continuing" && step < 40; step++) {
        setNotice("Preparing the semester. Progress is being saved.");
        result = await api(`/proposals/${id}/apply`, { approved: true });
      }
      setNotice(result.message);
      setProposal(null);
      await reload();
    });
  const navigate = (value) => {
    setPage(value);
    setError("");
    setNotice("");
  };
  const common = { ...data, propose, busy, notify: setNotice };
  if (signIn) {
    const code = new URLSearchParams(location.search).get("signin");
    const message =
      code === "ACCESS_NOT_GRANTED"
        ? "This account does not have SHAMROCK access. Contact your administrator."
        : code === "SIGN_IN_LIMIT"
          ? "Please wait a few minutes before trying again."
          : code
            ? "Sign-in did not complete. Please try again."
            : "";
    return (
      <div className="login">
        <section className="login-brand">
          <Brand />
          <p>
            Detachment administration,
            <br />
            in one place.
          </p>
        </section>
        <main className="login-form">
          <h1>Welcome to SHAMROCK</h1>
          <p>Sign in to manage the Wing’s people, schedule and attendance.</p>
          {message && (
            <div className="error" role="alert">
              {message}
            </div>
          )}
          <a className="google-sign-in" href="/auth/login">
            Sign in with Google
          </a>
          <small>
            Use the Google account your administrator has authorized.
          </small>
        </main>
      </div>
    );
  }

  return (
    <EditorError.Provider value={error}>
      <div className="app">
        <aside className="sidebar">
          <Brand />
          <nav aria-label="Main navigation">
            {pages.map(([title, Icon]) => (
              <button
                key={title}
                className={page === title ? "selected" : ""}
                onClick={() => navigate(title)}
              >
                <Icon size={19} />
                {title}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className={page === "Assistant" ? "selected" : ""}
              onClick={() => navigate("Assistant")}
            >
              <Sparkles size={20} />
              <span>
                Assistant<small>Optional</small>
              </span>
            </button>
            <p>
              Administrator
              {data?.meta.hosted && (
                <button className="sign-out" onClick={() => run(logout)}>
                  Sign out
                </button>
              )}
            </p>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span>
              Wing <span className="slash">/</span> <strong>{page}</strong>
            </span>
            <div>
              <button
                className="icon"
                aria-label="Refresh data"
                disabled={busy}
                onClick={() => run(reload)}
              >
                <RefreshCw size={17} />
              </button>
            </div>
          </header>
          <main>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="success" role="status">
                {notice}
              </div>
            )}
            {!data ? (
              <p aria-live="polite">
                {error
                  ? "Unable to load SHAMROCK. Use Refresh data to retry."
                  : "Loading SHAMROCK…"}
              </p>
            ) : (
              <>
                {page === "Events" && <Events {...common} />}{" "}
                {page === "Cadets" && <People key="cadets" {...common} />}{" "}
                {page === "Leadership" && (
                  <People key="leadership" leadership {...common} />
                )}{" "}
                {page === "Attendance & excusals" && <Attendance {...common} />}{" "}
                {page === "Semester" && <Semester {...common} />}{" "}
                {page === "Overview" && (
                  <Overview {...common} navigate={navigate} />
                )}{" "}
                {page === "System" && <System {...common} retry={apply} />}{" "}
                {page === "Assistant" && <Assistant meta={data.meta} />}
              </>
            )}
          </main>
        </div>
        {proposal && (
          <Drawer title="Review change" onClose={() => setProposal(null)}>
            <div className="fields">
              <h3>{proposal.summary.title}</h3>
              <p>{proposal.summary.target}</p>
              <dl className="review">
                {proposal.summary.changes.map((c, i) => (
                  <React.Fragment key={i}>
                    <dt>{label(c.field)}</dt>
                    <dd>{displayValue(c.value, data?.snapshot, c.field)}</dd>
                  </React.Fragment>
                ))}
              </dl>
              <p className="notice">{proposal.summary.consequence}</p>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </div>
            <footer className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(`/proposals/${proposal.id}/cancel`, {});
                    setProposal(null);
                  })
                }
              >
                Cancel change
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => apply(proposal.id)}
              >
                {busy ? "Saving…" : "Apply change"}
              </button>
            </footer>
          </Drawer>
        )}
      </div>
    </EditorError.Provider>
  );
}
function displayValue(value, s, key) {
  if (key === "flightId")
    return s.flights.find((f) => f.flightId === value)?.label || "Unassigned";
  if (key === "termId")
    return s.terms.find((t) => t.termId === value)?.label || "New semester";
  if (key === "flightIds")
    return value
      .map(
        (id) =>
          s.flights.find((f) => f.flightId === id)?.label || "Unknown Flight",
      )
      .join(", ");
  if (key === "eligiblePersonIds")
    return value === null
      ? "Unknown historical roster"
      : `${value.length} cadets`;
  if (value === null || value === "") return "Blank";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value.length
      ? value.map((v, i) => <div key={i}>{displayValue(v, s, "")}</div>)
      : "None";
  if (typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{label(k)}</dt>
            <dd>{displayValue(v, s, k)}</dd>
          </React.Fragment>
        ))}
      </dl>
    );
  return String(value);
}
createRoot(document.getElementById("root")).render(<App />);
