import React, { useEffect, useRef, useState } from "react";
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
    [signIn, setSignIn] = useState(false),
    [sync, setSync] = useState("");
  const pendingRead = useRef(null),
    lastRead = useRef(0),
    live = useRef({});
  live.current = { busy, proposal, data };
  const reload = async (force = false) => {
    if (pendingRead.current) {
      await pendingRead.current;
      if (!force) return;
    }
    const task = api("/state").then((value) => {
      setData(value);
      if (
        value.snapshot.access &&
        !value.snapshot.access.capabilities.fullSnapshot
      )
        setPage("Attendance & excusals");
      lastRead.current = Date.now();
      setSync("");
    });
    pendingRead.current = task;
    try {
      await task;
    } finally {
      if (pendingRead.current === task) pendingRead.current = null;
    }
  };
  useEffect(() => {
    startSession()
      .then(reload)
      .catch((e) => {
        if (e.code === "SIGN_IN_REQUIRED") setSignIn(true);
        else setError(e.message);
      });
  }, []);
  useEffect(() => {
    let timer,
      stopped = false,
      failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped)
        timer = setTimeout(tick, Math.min(300000, 60000 * 2 ** failures));
    };
    const tick = async () => {
      const current = live.current;
      if (
        document.visibilityState === "visible" &&
        navigator.onLine &&
        current.data &&
        !current.busy &&
        !current.proposal &&
        !document.querySelector('dialog[open], form[data-dirty="true"]') &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement?.tagName,
        ) &&
        Date.now() - lastRead.current >= 15000
      ) {
        try {
          await reload();
          failures = 0;
        } catch (e) {
          failures = Math.min(failures + 1, 3);
          if (e.code === "SIGN_IN_REQUIRED" || e.status === 403) {
            setData(null);
            setSignIn(true);
          } else setSync("Updates interrupted. Retrying automatically.");
        }
      }
      schedule();
    };
    const resume = () => {
      if (!stopped) void tick();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e.code === "SIGN_IN_REQUIRED" || e.status === 403) {
        setData(null);
        setProposal(null);
      }
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
      await reload(true);
    });
  const navigate = (value) => {
    setPage(value);
    setError("");
    setNotice("");
  };
  const scoped =
    data?.snapshot.access && !data.snapshot.access.capabilities.fullSnapshot;
  const visiblePages = scoped
    ? pages.filter(([title]) => title === "Attendance & excusals")
    : pages;
  const common = { ...data, propose, busy, notify: setNotice, refresh: reload };
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
        </section>
        <main className="login-form">
          <h1>Sign in</h1>
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
            {visiblePages.map(([title, Icon]) => (
              <button
                key={title}
                className={page === title ? "selected" : ""}
                aria-current={page === title ? "page" : undefined}
                onClick={() => navigate(title)}
              >
                <Icon size={19} />
                {title}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {!scoped && (
              <button
                className={page === "Assistant" ? "selected" : ""}
                onClick={() => navigate("Assistant")}
              >
                <Sparkles size={20} />
                <span>
                  Assistant<small>Optional</small>
                </span>
              </button>
            )}
            <p>
              {scoped ? "Flight / Squadron access" : "Administrator"}
              {data?.meta.hosted && (
                <button className="sign-out" onClick={() => run(logout)}>
                  Sign out
                </button>
              )}
            </p>
          </div>
        </aside>
        <div className="workspace">
          <main>
            {sync && (
              <small className="sync-status" role="status">
                {sync}
              </small>
            )}
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
                {error ? (
                  <button
                    onClick={() =>
                      run(() => startSession().then(() => reload(true)))
                    }
                  >
                    Retry connection
                  </button>
                ) : (
                  "Loading SHAMROCK…"
                )}
              </p>
            ) : (
              <>
                {!scoped && page === "Events" && <Events {...common} />}{" "}
                {!scoped && page === "Cadets" && (
                  <People key="cadets" {...common} />
                )}{" "}
                {!scoped && page === "Leadership" && (
                  <People key="leadership" leadership {...common} />
                )}{" "}
                {page === "Attendance & excusals" && <Attendance {...common} />}{" "}
                {!scoped && page === "Semester" && <Semester {...common} />}{" "}
                {!scoped && page === "Overview" && (
                  <Overview {...common} navigate={navigate} />
                )}{" "}
                {!scoped && page === "System" && (
                  <System {...common} retry={apply} />
                )}{" "}
                {!scoped && page === "Assistant" && (
                  <Assistant meta={data.meta} />
                )}
              </>
            )}
          </main>
        </div>
        {proposal && (
          <Drawer title="Review change" onClose={() => setProposal(null)}>
            <div className="fields">
              <h3>{proposal.summary.title}</h3>
              <p>{displayTarget(proposal.summary.target, data?.snapshot)}</p>
              <dl className="review">
                {proposal.summary.changes.map((c, i) => (
                  <React.Fragment key={i}>
                    <dt>{label(c.field)}</dt>
                    <dd>{displayValue(c.value, data?.snapshot, c.field)}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {proposal.summary.consequence && (
                <p className="notice">{proposal.summary.consequence}</p>
              )}
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
function displayTarget(target, s) {
  if (!s) return target;
  const request = s.requests.find((r) => r.requestId === target);
  if (request)
    return `${
      request.personDisplayName ||
      s.people
        .filter((p) => p.personId === request.personId)
        .map((p) => `${p.firstName} ${p.lastName}`)
        .join("")
    } · ${s.events.find((e) => e.eventId === request.eventId)?.label || "Excusal"}`;
  return s.events.find((e) => e.eventId === target)?.label || target;
}
function displayValue(value, s, key) {
  if (key === "name") {
    const person = s.people.find((p) => p.personId === value);
    if (person) return `${person.firstName} ${person.lastName}`;
  }
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
