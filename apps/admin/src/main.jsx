import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {Sparkles} from "lucide-react";
import {leadershipPages} from "./site-navigation";
import { api, startSession, label, logout } from "./api";
import { Drawer, EditorError, EditorSuspended } from "./components";
import Events from "./Events";
import People, {cadetBrowseProfile} from "./People";
import CadetWorkspace from "./CadetWorkspace";
import Excusals from "./Excusals";
import AttendancePage from "./AttendancePage";
import Semester from "./Semester";
import { Overview, System, Assistant } from "./Secondary";
import "@fontsource/libre-franklin/latin-400.css";
import "@fontsource/libre-franklin/latin-500.css";
import "@fontsource/libre-franklin/latin-600.css";
import "@fontsource/libre-franklin/latin-700.css";
import "@fontsource/barlow-condensed/latin-600.css";
import Brand from "./Brand";
import {workspaceFromUrl, pageFromUrl, writePageUrl, rememberSignInPage, restoreSignInPage} from "./page-url";
import WorkspaceShell, {PageLink} from "./WorkspaceShell";
import { ViewAsSelector, ViewAsAccount, viewAsStatus } from "./ViewAs";
import "./style.css";
const profileFor = page => page === "Cadets" ? cadetBrowseProfile() : ({
  Leadership:"leadership", Attendance:"attendance", Excusals:"excusals",
  "Semester planning":"semester", Overview:"overview", Events:"events",
  History:"access", Assistant:"access", System:"access",
}[page] || "full");
function App() {
  const [page, setPage] = useState(() => pageFromUrl("leadership") || "Events"),
    [archiveVersion, setArchiveVersion] = useState(() => new URL(location.href).searchParams.get("semester") || "latest"),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [errorSource, setErrorSource] = useState("read"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [proposal, setProposal] = useState(null),
    [signIn, setSignIn] = useState(false),
    [sessionInfo, setSessionInfo] = useState(null),
    [readOutage, setReadOutage] = useState(null),
    [sync, setSync] = useState("");
  const [routeFamily, setRouteFamily] = useState(workspaceFromUrl);
  const [destination, setDestination] = useState(null);
  const [preview, setPreview] = useState(null), [previewName, setPreviewName] = useState("");
  const [readProgress, setReadProgress] = useState({stage: "Checking access"});
  const pendingAbort = useRef(null);
  const pendingActions = useRef(0);
  const readIntent = useRef(0);
  const bootstrap = useRef(null);
  const initialize = () => {
    if (!bootstrap.current) bootstrap.current = startSession().then(value => {
      setSessionInfo(value); setSignIn(false);
      setPreview(value.viewAs || null); return value;
    }).catch(error => { bootstrap.current = null; throw error; });
    return bootstrap.current;
  };
  const pendingRead = useRef(null),
    lastRead = useRef(0),
    readFailures = useRef(0),
    capacityRetryAt = useRef(0),
    live = useRef({});
  const pauseAtServiceLimit = (error) => {
    if (error.code !== "SERVICE_LIMIT_REACHED") return false;
    const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
    capacityRetryAt.current = error.retryAfterSeconds
      ? Date.now() + error.retryAfterSeconds * 1000 : reset.getTime();
    setReadOutage({limited:true, retryAt:capacityRetryAt.current});
    setSync("Database daily limit reached. Automatic updates will resume after the allowance resets.");
    return true;
  };
  const recordsUnavailable = (error) => {
    if (pauseAtServiceLimit(error)) return true;
    if (error.status >= 500 || error instanceof TypeError) {
      readFailures.current = Math.min(readFailures.current + 1, 4);
      const delay = Math.max((error.retryAfterSeconds || 0) * 1000,
        Math.min(300000, 60000 * 2 ** (readFailures.current - 1)));
      capacityRetryAt.current = Date.now() + delay;
      setReadOutage({limited:false, retryAt:capacityRetryAt.current});
      return true;
    }
    return false;
  };
  const requireSignIn = () => {
    bootstrap.current = null;
    setSessionInfo(null); setData(null); setReadOutage(null); setSignIn(true);
  };
  live.current = { busy, proposal, data, preview, page, sessionInfo, readOutage };
  const reload = async (force = false, profile, nextPage) => {
    if (!force && pendingRead.current) return pendingRead.current;
    const intent = ++readIntent.current;
    const currentSession = await initialize();
    if (workspaceFromUrl()==="cadet" ||
        !currentSession.viewAs && (currentSession.schoolLogin || currentSession.cadetWorkspace && workspaceFromUrl()!=="leadership")) return;
    if (intent !== readIntent.current)
      throw Object.assign(new Error("A newer view is loading."), {code:"SUPERSEDED"});
    if (pendingRead.current) {
      if (force && pendingAbort.current) { pendingAbort.current.superseded = true; pendingAbort.current.abort(); }
      await pendingRead.current.catch(() => null);
    }
    if (intent !== readIntent.current)
      throw Object.assign(new Error("A newer view is loading."), {code:"SUPERSEDED"});
    const controller = new AbortController();
    pendingAbort.current = controller;
    setReadProgress({stage: "Checking access"});
    profile ||= profileFor(live.current.page);
    const task = api("/state", undefined, {profile, signal: controller.signal, onProgress: value => {
      if (!controller.signal.aborted && pendingAbort.current === controller) setReadProgress(value);
    }}).then((value) => {
      if (controller.signal.aborted || pendingAbort.current !== controller || intent !== readIntent.current)
        throw Object.assign(new Error("A newer view is loading."), {code:"SUPERSEDED"});
      setData(value);
      setReadOutage(null); setError(""); capacityRetryAt.current = 0; readFailures.current = 0;
      setPreview(value.viewAs || null);
      if (
        (value.snapshot?.access || value.manifest?.access) &&
        !(value.snapshot?.access || value.manifest.access).capabilities.fullSnapshot
      ) {
        const allowed = profile === "excusals" ? "Excusals" : "Attendance";
        setPage(allowed);
        writePageUrl("leadership", allowed, true);
      } else {
        const resolved = nextPage || live.current.page;
        if (nextPage) setPage(nextPage);
        writePageUrl("leadership", resolved, true);
      }
      lastRead.current = Date.now();
      setSync("");
      return value;
    }).catch(error => {
      if(error.code==="CADET_WORKSPACE"){location.replace("/me");return;}
      controller.abort();
      if (controller.superseded) throw Object.assign(new Error("A newer view is loading."), {code:"SUPERSEDED"});
      if (error.name === "AbortError") throw new Error("Loading stopped.");
      // A failed read never creates a change receipt. Do not surface the generic
      // mutation recovery message returned by an upstream INTERNAL_ERROR.
      error.recordReadFailure = true;
      error.recordReadUnavailable = recordsUnavailable(error);
      if (error.code !== "SIGN_IN_REQUIRED" && error.status !== 403) {
        error.message = error.code === "SERVICE_LIMIT_REACHED"
          ? "Cadet records will load when the database allowance resets."
          : "SHAMROCK could not load cadet records. Please try again after the retry delay.";
      }
      throw error;
    });
    pendingRead.current = task;
    try {
      return await task;
    } finally {
      if (pendingRead.current === task) pendingRead.current = null;
      if (pendingAbort.current === controller) pendingAbort.current = null;
    }
  };
  useEffect(() => {
    reload()
      .catch((e) => {
        if (e.code === "SUPERSEDED") return;
        if (!e.recordReadFailure) pauseAtServiceLimit(e);
        if (e.code === "SIGN_IN_REQUIRED") requireSignIn();
        else { setErrorSource("read"); setError(e.message); }
      });
  }, []);
  useEffect(() => {
    let timer,
      stopped = false,
      failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped) {
        const remaining = capacityRetryAt.current - Date.now();
        timer = setTimeout(tick, remaining > 0 ? remaining : Math.min(300000, 60000 * 2 ** failures));
      }
    };
    const tick = async () => {
      const current = live.current;
      if (
        document.visibilityState === "visible" &&
        navigator.onLine &&
        Date.now() >= capacityRetryAt.current &&
        (current.data || (current.sessionInfo && current.readOutage)) &&
        !current.busy &&
        (!current.proposal || current.readOutage) &&
        (current.readOutage || !document.querySelector('dialog[open], form[data-dirty="true"]')) &&
        (current.readOutage || !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement?.tagName,
        )) &&
        Date.now() - lastRead.current >= 15000
      ) {
        try {
          await reload();
          failures = 0;
        } catch (e) {
          if (e.code === "SUPERSEDED") { schedule(); return; }
          if (e.recordReadUnavailable) { schedule(); return; }
          failures = Math.min(failures + 1, 3);
          if (e.code === "SIGN_IN_REQUIRED" || e.status === 403) {
            setData(null);
            if (!current.preview) requireSignIn();
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
    pendingActions.current++;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e.code === "SUPERSEDED") return;
      if (!e.recordReadFailure) pauseAtServiceLimit(e);
      if (e.code === "SIGN_IN_REQUIRED") requireSignIn();
      if (e.code === "SIGN_IN_REQUIRED" || e.status === 403) {
        setData(null);
        setProposal(null);
      }
      setErrorSource(e.recordReadFailure ? "read" : "action");
      setError(e.message);
    } finally {
      if (--pendingActions.current === 0) setBusy(false);
    }
  };
  const propose = (operation, payload, close, reviewContext) =>
    run(async () => {
      const p = await api("/proposals", { operation, payload, ...(preview?{viewEntry:preview.entryAuditId}:{}) });
      setProposal({...p, reviewContext});
      close?.();
    });
  const decisionReceipt = useRef(null);
  const decideExcusal = (payload, close) => run(async () => {
    const context = preview ? {viewEntry:preview.entryAuditId} : {};
    const key = JSON.stringify([context, payload]);
    if (decisionReceipt.current?.key !== key) {
      const receipt = await api("/proposals", {operation:"excusal.decide", payload, ...context});
      decisionReceipt.current = {key, id:receipt.id};
    }
    const saved = await api(`/proposals/${decisionReceipt.current.id}/apply`, {approved:true, ...context});
    decisionReceipt.current = null;
    close();
    setNotice(saved.message);
    await reload(true);
  });
  const apply = (id) =>
    run(async () => {
      let result = await api(`/proposals/${id}/apply`, { approved: true, ...(preview?{viewEntry:preview.entryAuditId}:{}) });
      for (let step = 0; result.state === "continuing" && step < 40; step++) {
        setNotice("Preparing the semester. Progress is being saved.");
        result = await api(`/proposals/${id}/apply`, { approved: true, ...(preview?{viewEntry:preview.entryAuditId}:{}) });
      }
      setNotice(result.message);
      setProposal(null);
      await reload(true);
    });
  const navigate = (value, fromHistory = false, semester = "latest") => {
    if (value === "History") setArchiveVersion(fromHistory ? new URL(location.href).searchParams.get("semester") || "latest" : semester);
    if (!fromHistory) writePageUrl("leadership", value, false, semester);
    readIntent.current++;
    if (pendingAbort.current) { pendingAbort.current.superseded = true; pendingAbort.current.abort(); }
    setError("");
    setNotice("");
    // Navigation can supersede the post-save refresh while the old snapshot is still visible.
    const needsRefresh = !data?.snapshot || pendingRead.current || pendingActions.current > 0;
    if (needsRefresh && (!["History", "Assistant", "System"].includes(value) || !data)) {
      const next = {page:value};
      setDestination(next);
      if (!data) setPage(value);
      void run(() => reload(true, profileFor(value), value)).finally(() =>
        setDestination(current => current === next ? null : current));
    } else {
      setDestination(null);
      setPage(value);
    }
  };
  useEffect(() => {
    const restore = () => {
      setRouteFamily(workspaceFromUrl());
      if (workspaceFromUrl() === "cadet") {
        readIntent.current++;
        if (pendingAbort.current) { pendingAbort.current.superseded = true; pendingAbort.current.abort(); }
        setDestination(null);
        return;
      }
      if (sessionInfo && !preview && sessionInfo.schoolLogin) return;
      navigate(pageFromUrl("leadership") || "Events", true);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  });
  const cancelRead = () => {
    readIntent.current++;
    pendingAbort.current?.abort();
    setErrorSource("read");
    setError("Loading stopped.");
  };
  const viewAs = (person) => run(async () => {
    readIntent.current++;
    if (pendingAbort.current) {pendingAbort.current.superseded=true; pendingAbort.current.abort();}
    if (person?.firstName) setPreviewName([person.firstName,person.lastName].filter(Boolean).join(" "));
    let result;
    try { result = await api("/view-as", {personId:person?.personId || null}); }
    catch (error) {
      const current = await api("/session",{}).catch(()=>null);
      if (current?.viewAs) { setPreview(current.viewAs); setData(null); }
      throw error;
    }
    if(result.directoryWorkspace){location.assign("/me/profile");return;}
    setPreview(result.viewAs); if (!person) setPreviewName("");
    setProposal(null); setData(null); setNotice("");
    await reload(true);
    if (result.auditRecorded === false) setNotice("Exited View as; the exit audit could not be saved.");
  });
  const blockedPreview = preview && preview.status !== "ready";
  const access = data?.snapshot?.access || data?.manifest?.access;
  const scoped = access && !access.capabilities.fullSnapshot;
  const browseReady = page === "Cadets" ? ["cadets","cadet-details"].includes(data?.browse?.profile) : data?.browse?.profile === profileFor(page);
  const visiblePages = blockedPreview || (sessionInfo?.hosted && !access) ? [] : leadershipPages(!scoped, preview);
  const navigationPage = destination?.page ?? page;
  const common = { ...data, propose, busy, readOnly: !!preview && !data?.meta.delegatedEdits, notify: setNotice, refresh: reload, run };
  if (signIn) {
    const code = new URLSearchParams(location.search).get("signin");
    const message =
      code === "SERVICE_LIMIT_REACHED"
        ? "The previous attempt hit a service limit. Please try signing in again."
        : code === "AUTH_STORE_UNAVAILABLE"
        ? "Sign-in is temporarily unavailable. Please try again later."
        : code === "ACCESS_NOT_GRANTED"
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
          <a className="google-sign-in" onClick={rememberSignInPage} href="/auth/login">
            Sign in with Google
          </a>
          <small>
            Sign in with the school email listed in SHAMROCK.
          </small>
        </main>
      </div>
    );
  }

  let outageScreen = null;
  if(sessionInfo && (routeFamily==="cadet" ||
    !preview && (sessionInfo.schoolLogin || sessionInfo.cadetWorkspace && routeFamily!=="leadership")))
    return <CadetWorkspace session={{...sessionInfo,viewAs:preview}}/>;
  if (sessionInfo && readOutage) {
    const retryTime = new Intl.DateTimeFormat(undefined, {
      hour:"2-digit", hourCycle:"h23", minute:"2-digit", timeZoneName:"short",
    }).format(new Date(readOutage.retryAt));
    outageScreen = <div className="login records-unavailable">
      <section className="login-brand"><Brand /></section>
      <main className="login-form">
        <span className="session-confirmed">Signed in securely</span>
        <h1>You're signed in</h1>
        <p role="status">Cadet records are temporarily unavailable.</p>
        <p>{readOutage.limited
          ? `The database has reached its daily allowance. We'll check again after ${retryTime}.`
          : `SHAMROCK could not load cadet records. We'll try again after ${retryTime}. You can stay on this page.`}</p>

        {error && errorSource === "action" && <div className="error" role="alert">{error}</div>}
        {busy && <small role="status">Checking records…</small>}
        <div className="outage-actions">
          <button disabled={busy || Date.now() < capacityRetryAt.current}
            onClick={() => run(() => reload(true))}>Retry records</button>
          <button disabled={busy} onClick={() => run(logout)}>Sign out</button>
        </div>
      </main>
    </div>;
  }

  const viewAsLabel = preview && (previewName || [data?.snapshot?.people.find(p => p.personId === preview.personId)?.firstName,
                data?.snapshot?.people.find(p => p.personId === preview.personId)?.lastName].filter(Boolean).join(" ") || "selected cadet");
  return (
    <>
    <div hidden={!!outageScreen} inert={outageScreen ? true : undefined}>
    <EditorSuspended.Provider value={!!outageScreen}>
    <EditorError.Provider value={error}>
      <WorkspaceShell session={sessionInfo} preview={preview} mobileContext={preview && ((data?.meta.delegatedEdits ? "Acting as " : "Viewing as ") + viewAsLabel)} pages={visiblePages} page={navigationPage === "History" ? "Attendance" : navigationPage} navigate={navigate} account={<>
      {preview && <ViewAsAccount acting={data?.meta.delegatedEdits} busy={busy} onExit={() => viewAs(null)}
              label={viewAsLabel} />}
            {!preview && !scoped && data?.meta.viewAsEnabled &&
              <ViewAsSelector people={data.snapshot?.people ?? (["cadets","leadership","cadet-details","semester"].includes(data.browse?.profile) ? data.list.people : null)} onSelect={viewAs} busy={busy} />}
            {!preview && !scoped && data && (
              <PageLink workspace="leadership" title="Assistant" navigate={navigate}
                className={page === "Assistant" ? "selected" : ""}
              >
                <Sparkles size={20} />
                <span>
                  Assistant
                </span>
              </PageLink>
            )}
            <p>
              {scoped ? "Flight / Squadron access" : "Administrator"}
              {data?.meta.hosted && (
                <button className="sign-out" onClick={() => run(logout)}>
                  Sign out
                </button>
              )}
            </p>
      </>} drawer={proposal && (
          <Drawer modal title="Review change" onClose={() => setProposal(null)}>
            <div className="fields">
              <h3>{proposal.summary.title}</h3>
              <p>{displayTarget(proposal.summary.target, data?.snapshot || data?.list)}</p>
              <dl className="review">
                {proposal.summary.changes.map((c, i) => (
                  <React.Fragment key={i}>
                    <dt>{label(c.field)}</dt>
                    <dd>{displayValue(c.value, proposal.reviewContext || data?.snapshot || data?.list, c.field)}</dd>
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
                    await api(`/proposals/${proposal.id}/cancel`, preview?{viewEntry:preview.entryAuditId}:{});
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
        )}>

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
            {destination && data && <span role="status" className="page-transfer">Opening {destination.page}…</span>}
            <div inert={destination && data ? true : undefined} aria-busy={!!destination}>
            {blockedPreview ? <div><p>{viewAsStatus[preview.status] || "This account cannot be previewed."}</p>
              {preview.status === "starting" && <button disabled={busy} onClick={()=>viewAs({personId:preview.personId})}>Retry view</button>}</div> : !data || (!data.snapshot && !browseReady && !["History", "Assistant", "System"].includes(page) && !(page === "Events" && data.eventsList)) ? (
              <section className="loading-panel" aria-busy={!error}>
                {error ? (
                  <button
                    onClick={() =>
                      run(() => { bootstrap.current = null; return reload(true); })
                    }
                  >
                    Retry connection
                  </button>
                ) : (
                  <>
                    <h1 className="page-title">{page}</h1>
                    <div className="loading-status"><span role="status">{readProgress.stage}…</span>
                      <button onClick={cancelRead}>Cancel</button></div>
                    {readProgress.total && <progress aria-label="Record groups loaded" value={readProgress.completed} max={readProgress.total} />}
                    <div className="loading-table" aria-hidden="true">{Array.from({length:6},(_,i)=><div key={i}><i/><i/><i/></div>)}</div>
                  </>
                )}
              </section>
            ) : (
              <React.Fragment key={preview?.entryAuditId || "own-account"}>
                {!scoped && page === "Events" && <Events {...common} />}{" "}
                {!scoped && page === "Cadets" && (
                  <People key="cadets" {...common} />
                )}{" "}
                {!scoped && page === "Leadership" && (
                  <People key="leadership" leadership {...common} />
                )}{" "}
                {(page === "Attendance" || page === "History") && <AttendancePage
                  key={JSON.stringify([data.manifest?.generation, data.manifest?.revision?.access, preview?.entryAuditId])}
                  {...common} viewEntry={preview?.entryAuditId} archivesAllowed={Boolean(access?.capabilities.fullSnapshot && data.meta.hosted)}
                  archiveVersion={page === "History" ? archiveVersion : null}
                  onSemester={version => navigate(version ? "History" : "Attendance", false, version)} />}
                {page === "Excusals" && <Excusals {...common} onDecide={decideExcusal} />}{" "}
                {!preview && !scoped && page === "Semester planning" && <Semester {...common} snapshot={data.snapshot || data.list} />}{" "}
                {!scoped && page === "Overview" && (
                  <Overview key={JSON.stringify([data.captureKey,data.viewAsRevision])} {...common} />
                )}{" "}
                {!preview && !scoped && page === "System" && (
                  <System {...common} retry={apply} />
                )}{" "}
                {!preview && !scoped && page === "Assistant" && (
                  <Assistant meta={data.meta} />
                )}
                {preview && ["Semester planning", "System", "Assistant"].includes(page) && <p>Exit View as to use this page.</p>}
              </React.Fragment>
            )}
            </div>
      </WorkspaceShell>
    </EditorError.Provider>
    </EditorSuspended.Provider>
    </div>
    {outageScreen}
    </>
  );
}
function displayTarget(target, s) {
  if (!s) return target;
  const request = s.requests?.find((r) => r.requestId === target);
  if (request)
    return `${
      request.personDisplayName ||
      s.people
        .filter((p) => p.personId === request.personId)
        .map((p) => `${p.firstName} ${p.lastName}`)
        .join("")
    } · ${s.events.find((e) => e.eventId === request.eventId)?.label || "Excusal"}`;
  return s.events?.find((e) => e.eventId === target)?.label || target;
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
restoreSignInPage();
createRoot(document.getElementById("root")).render(<App />);
