import React, { useEffect, useState, useRef } from "react";
import { api, logout } from "./api";
import { Empty, Field, Heading, Select, Status, Table } from "./components";
import Excusals from "./Excusals";
import {pageFromUrl, writePageUrl} from "./page-url";
import WorkspaceShell from "./WorkspaceShell";
import { ViewAsBanner } from "./ViewAs";
import { ClipboardList, FileCheck2, Users, UserRound } from "lucide-react";
import { AS_YEARS } from "../../../packages/domain/src/admin";

const fields = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["classYear", "Graduation year"],
  ["phone", "Phone", "tel"],
  ["dateOfBirth", "Date of birth", "date"],
  ["dorm", "Residence"],
  ["homeTown", "Hometown"],
  ["homeState", "Home state"],
  ["cipBroadArea", "CIP broad area"],
  ["cipCode", "CIP code"],
  ["afsc", "AFSC"],
  ["photoLink", "Photo link", "url"],
];
const required = new Set([
  "firstName",
  "lastName",
  "classYear",
  "phone",
  "dateOfBirth",
  "homeTown",
  "homeState",
]);
function photoUrls(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return {};
    let thumbnail;
    if (url.origin === "https://drive.google.com") {
      const id = url.pathname.match(/^\/file\/d\/([\w-]+)(?:\/|$)/)?.[1] || url.searchParams.get("id");
      if (id && /^[\w-]+$/.test(id)) {
        const image = new URL("https://drive.google.com/thumbnail");
        image.searchParams.set("id", id);
        image.searchParams.set("sz", "w256");
        if (url.searchParams.has("resourcekey")) image.searchParams.set("resourcekey", url.searchParams.get("resourcekey"));
        thumbnail = image.href;
      }
    } else if (url.hostname.endsWith(".googleusercontent.com")) thumbnail = url.href;
    return {href:url.href, thumbnail};
  } catch { return {}; }
}

function ProfilePhoto({profile}) {
  const {href, thumbnail} = photoUrls(profile.photoLink);
  const [failed, setFailed] = useState("");
  const initials = [profile.firstName, profile.lastName].map(name => name?.trim()[0]).join("");
  return <div className="profile-identity">
    <div className="profile-portrait">{thumbnail && failed !== thumbnail
      ? <img src={thumbnail} alt="Directory portrait" referrerPolicy="no-referrer" onError={() => setFailed(thumbnail)} />
      : <span aria-label="Profile initials">{initials || "–"}</span>}</div>
    <div><h2>{[profile.firstName,profile.lastName].filter(Boolean).join(" ")}</h2>
      <p>{[profile.rank,profile.asYear,profile.university].filter(Boolean).join(" · ")}</p>
      {profile.email && <p>{profile.email}</p>}
      {href && <a href={href} target="_blank" rel="noreferrer">Open original photo</a>}
    </div>
  </div>;
}

function Profile({ state, save, disabled }) {
  const [form, set] = useState(() => ({
    ...state.profile,
    university: state.profile?.university || state.school || "",
    asYear: state.profile?.asYear || "",
    flightId: state.profile?.flightId || "",
  }));
  const [step, setStep] = useState(0);
  const register = state.registration,
    pick = (key, value) => set((old) => ({ ...old, [key]: value }));
  const visible = register
    ? step === 0
      ? fields.slice(0, 5)
      : fields.slice(5)
    : fields;
  const groups = [["Contact information", ["firstName","lastName","phone","dateOfBirth","dorm","homeTown","homeState"]], ["Academics and career", ["classYear","cipBroadArea","cipCode","afsc"]], ["Directory photo", ["photoLink"]]];
  function submit(e) {
    e.preventDefault();
    if (register && step === 0) {
      setStep(1);
      return;
    }
    const changes = Object.fromEntries(
      fields
        .map(([k]) => [k, form[k]?.trim() || (k === "dateOfBirth" ? null : "")])
        .filter(([k, v]) => register || state.profile[k] !== v),
    );
    if (!register && !Object.keys(changes).length) return;
    save(
      register ? "register" : "profile",
      register
        ? {
            ...changes,
            university: form.university,
            asYear: form.asYear,
            flightId: form.flightId,
          }
        : { changes, version: state.profile.version },
    );
  }
  return (
    <form onSubmit={submit} className="cadet-form form-section">
      {!register && <ProfilePhoto profile={state.profile} />}
      {register && <h2>{step === 0 ? "Directory information" : "Academic and career information"}</h2>}
      <fieldset disabled={disabled && !register}>
        <div className="cadet-fields">
          {register && step === 0 && (
            <>
              <Field label="University">
                <input
                  required
                  value={form.university}
                  onChange={(e) => pick("university", e.target.value)}
                />
              </Field>
              <Select
                label="AS year"
                required
                value={form.asYear}
                onChange={(v) => pick("asYear", v)}
                options={[{ value: "", label: "Choose AS year" }, ...AS_YEARS]}
              />
              <Select
                label="Flight"
                required
                value={form.flightId}
                onChange={(v) => pick("flightId", v)}
                options={[
                  { value: "", label: "Choose Flight" },
                  ...state.flights.map((f) => ({
                    value: f.flightId,
                    label: f.label,
                  })),
                ]}
              />
            </>
          )}
          </div>
        {groups.map(([title, keys]) => {
          const members = visible.filter(([key]) => keys.includes(key));
          return members.length > 0 && <section key={title} className="profile-section"><h3>{title}</h3><div className="cadet-fields">
          {members.map(([key, label, type]) => key === "afsc" ? (
            <div className="profile-wide" key={key}><Field label="Air Force Specialty Code (AFSC)">
              <textarea value={form.afsc || ""} maxLength={240} rows={4}
                onChange={e => pick(key,e.target.value)} />
            </Field></div>
          ) : (
            <Field key={key} label={label}>
              <input
                type={type || "text"}
                maxLength={key === "classYear" ? 4 : key === "photoLink" ? 2048 : 240}
                pattern={
                  key === "classYear"
                    ? "[0-9]{4}"
                    : key === "cipCode"
                      ? "[0-9]{2}[.][0-9]{4}"
                      : undefined
                }
                required={required.has(key)}
                value={form[key] || ""}
                onChange={(e) => pick(key, e.target.value)}
              />
            </Field>
          ))}
        </div></section>;
        })}
      </fieldset>
      {(!register || step === 1) && (
        <p>
          <a
            href="https://nces.ed.gov/ipeds/cipcode/"
            target="_blank"
            rel="noreferrer"
          >
            Find your major’s CIP code
          </a>{" "}
          ·{" "}
          <a
            href="https://www.afrotc.com/career-opportunities/"
            target="_blank"
            rel="noreferrer"
          >
            Explore officer careers
          </a>
        </p>
      )}
      {register && step === 1 && (
        <button type="button" onClick={() => setStep(0)}>
          Back
        </button>
      )}
      <button
        className="primary"
        disabled={disabled && (!register || step === 1)}
      >
        {register
          ? step === 0
            ? "Continue"
            : "Create profile"
          : "Save changes"}
      </button>
    </form>
  );
}
function Submission({ state, mode, save, disabled }) {
  const [count, setCount] = useState(1);
  return (
    <details className="cadet-compose">
      <summary>{mode === "flag" ? "Flag attendance" : "Request an excusal"}</summary>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            events = f
              .getAll("event")
              .map((id) => state.events.find((x) => x.eventId === id));
          save(
            mode,
            mode === "flag"
              ? { eventId: events[0].eventId, detail: f.get("reason") }
              : {
                  events: events.map((e) => ({
                    eventId: e.eventId,
                    version: e.version,
                  })),
                  outcome: f.get("outcome"),
                  reason: f.get("reason"),
                },
          );
        }}
      >
        <fieldset disabled={disabled}>
          {Array.from({ length: count }, (_, i) => (
            <Field key={i} label={count === 1 ? "Event" : `Event ${i + 1}`}>
              <select name="event" required defaultValue="">
                <option value="" disabled>
                  Select an event
                </option>
                {state.events.map((e) => (
                  <option value={e.eventId} key={e.eventId}>
                    {e.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {mode === "excusal" && count < Math.min(state.events.length, 25) && (
            <button type="button" onClick={() => setCount(count + 1)}>
              Add event
            </button>
          )}
          {count > 1 && (
            <button type="button" onClick={() => setCount(count - 1)}>
              Remove last event
            </button>
          )}
          {mode === "excusal" && (
            <Field label="Requested code">
              <select name="outcome" defaultValue="E">
                {["P", "T", "E", "ES", "MED"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label={
              mode === "flag"
                ? "What should your Flight commander review?"
                : "Reason"
            }
          >
            <textarea name="reason" required maxLength={500} />
          </Field>
          <button className="primary">Submit</button>
        </fieldset>
      </form>
    </details>
  );
}
function FlightReport({ state, save, disabled }) {
  const [eventId, select] = useState(""),
    [present, setPresent] = useState([]),
    [complete, setComplete] = useState(false);
  const events = [
    ...new Map(state.reportRoster.map((r) => [r.eventId, r])).values(),
  ];
  const eligible = new Set(
    state.reportRoster
      .filter((r) => r.eventId === eventId)
      .map((r) => r.personId),
  );
  const roster = state.roster.filter((r) => eligible.has(r.personId));
  const flight = state.flights.find(
    (f) => f.flightId === state.profile.flightId,
  );
  return (
    <details>
      <summary>Submit Flight attendance</summary>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(
            "report",
            {
              eventId,
              version: events.find((v) => v.eventId === eventId).version,
              rosterVersion: flight.rosterVersion,
              present,
              completeness: complete ? "complete" : "partial",
            },
            () => {
              select("");
              setPresent([]);
              setComplete(false);
            },
          );
        }}
      >
        <Select
          label="Attendance event"
          value={eventId}
          onChange={(id) => {
            select(id);
            setPresent([]);
            setComplete(false);
          }}
          required
          options={[
            { value: "", label: "Select an event" },
            ...events.map((r) => ({ value: r.eventId, label: r.label })),
          ]}
        />
        {eventId && (
          <>
            <fieldset>
              <legend>Present</legend>
              {roster.map((r) => (
                <label key={r.personId}>
                  <input
                    type="checkbox"
                    checked={present.includes(r.personId)}
                    onChange={(e) =>
                      setPresent(
                        e.target.checked
                          ? [...present, r.personId]
                          : present.filter((p) => p !== r.personId),
                      )
                    }
                  />
                  {r.name}
                </label>
              ))}
            </fieldset>
            {roster.length === state.roster.length && (
              <label>
                <input
                  type="checkbox"
                  checked={complete}
                  onChange={(e) => setComplete(e.target.checked)}
                />
                Complete Flight report
              </label>
            )}
            <button
              className="primary"
              disabled={disabled || (!present.length && !complete)}
            >
              Submit attendance
            </button>
          </>
        )}
      </form>
    </details>
  );
}
function Flight({ state, save, disabled }) {
  return (
    <>
      <FlightReport state={state} save={save} disabled={disabled} />
      <h2>Attendance flags</h2>
      {state.actions
        .filter((a) => a.kind === "flag" && !a.resolution)
        .map((a) => (
          <form
            key={a.actionId}
            className="cadet-form"
            onSubmit={(e) => {
              e.preventDefault();
              save("resolve", {
                parentId: a.actionId,
                detail: new FormData(e.currentTarget).get("resolution"),
              });
            }}
          >
            <strong>
              {a.person} · {a.event}
            </strong>
            <p>{a.detail}</p>
            <Field label="Resolution">
              <input name="resolution" required maxLength={500} />
            </Field>
            <button disabled={disabled}>Mark reviewed</button>
          </form>
        ))}
      {!state.actions.some((a) => a.kind === "flag" && !a.resolution) && (
        <p>No open attendance flags.</p>
      )}
      <h2>Flight duties</h2>
      <Table headers={["Cadet", "Current duty"]}>
        {state.roster.map((p) => (
          <tr key={p.personId}>
            <td>{p.name}</td>
            <td>
              {state.actions.find(
                (a) => a.kind === "duty" && a.personId === p.personId,
              )?.detail || "—"}
            </td>
          </tr>
        ))}
      </Table>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save("duty", { personId: f.get("person"), detail: f.get("duty") });
        }}
      >
        <Field label="Cadet">
          <select name="person" required>
            {state.roster.map((p) => (
              <option key={p.personId} value={p.personId}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flight duty">
          <input name="duty" required maxLength={120} />
        </Field>
        <button disabled={disabled}>Assign duty</button>
      </form>
    </>
  );
}
export default function CadetWorkspace({ session }) {
  const [state, setState] = useState(null),
    [tab, setTab] = useState(() => pageFromUrl("cadet")),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(null),
    active = useRef(false),
    preview = !!session.viewAs;
  const load = async () => {
    const s = await api("/cadet");
    setState(s);
    return s;
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function save(kind, fields, done) {
    if (active.current || preview) return;
    active.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([kind, fields]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      await api("/cadet", { kind, fields, id: pending.current.id });
      await load();
      pending.current = null;
      done?.();
      setNotice("Saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const flight = state?.flights.find(
    (f) => f.flightId === state.profile?.flightId,
  )?.label;
  const pages =
    state && !state.registration
      ? [
          ...(state.squadron ? [["Excusals", FileCheck2]] : []),
          ...(state.flightCommander ? [["My Flight", Users]] : []),
          ["My requests", ClipboardList],
          ["My profile", UserRound],
        ]
      : [];
  const page = pages.find(([title]) => title === tab)?.[0] || pages[0]?.[0];
  useEffect(() => {
    const restore = () => setTab(pageFromUrl("cadet"));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (page) writePageUrl("cadet",page,true);
  }, [page, tab]);
  const navigate = title => {
    writePageUrl("cadet",title);
    setTab(title);
  };
  const name = [state?.profile?.firstName, state?.profile?.lastName].filter(Boolean).join(" ");
  const role = state?.squadron ? `${state.squadron} Squadron Commander`
    : state?.flightCommander && flight ? `${flight} Flight Commander` : "Cadet";
  const disabled =
    busy ||
    preview ||
    !state?.writable ||
    (!state?.linked && !state?.registration);
  const flags = (state?.actions || []).filter(a => a.kind === "flag" && a.personId === state.profile?.personId);
  const queue = state?.queue || [];
  const list = state?.squadron && {
    terms: [{ termId: "current", isCurrent: true }],
    events: [
      ...new Map(
        queue.map((r) => [
          r.eventId,
          {
            eventId: r.eventId,
            label: r.event,
            termId: "current",
            status: "active",
          },
        ]),
      ).values(),
    ],
    flights: state.flights,
    people: [],
    requests: queue.map((r) => ({ ...r, canDecide: true })),
    access: { capabilities: { fullSnapshot: false } },
  };
  return (
    <WorkspaceShell workspace="cadet" pages={pages} page={page} navigate={navigate} account={<>
      {!preview && !session.schoolLogin && <a className="workspace-switch" href="/events">Leadership workspace</a>}
      <p>
        {name && <strong className="account-name">{name}</strong>}
        {role}
        {!preview && <button className="sign-out" onClick={() => logout().catch((e) => setError(e.message))}>Sign out</button>}
      </p>
    </>}>
      {preview && <ViewAsBanner label={name || "selected cadet"} busy={busy} onExit={async () => {
        try {
          await api("/view-as", { personId: null });
          location.assign("/");
        } catch (e) { setError(e.message); }
      }} />}
      {page !== "Excusals" && <Heading title={state?.registration ? "Create profile" : page || "My workspace"} />}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            onClick={() =>
              load()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            Reload
          </button>
        </p>
      )}
      {notice && <div className="success" role="status">{notice}</div>}
      {!state && !error && <p role="status">Loading your workspace…</p>}
      {state && !preview && !state.writable && (
        <p className="notice">Submissions are paused.</p>
      )}
      {state?.profile && !state.linked && !preview && (
        <button
          disabled={busy || !state.writable}
          onClick={() => save("link", {})}
        >
          Connect my Directory record
        </button>
      )}
      {page === "Excusals" && (
        <Excusals
          list={list}
          busy={busy}
          readOnly={preview || disabled}
          propose={(_, p, done) =>
            save(
              "decide",
              {
                requestId: p.requestId,
                version: p.expectedVersion,
                decision: p.decision,
                reason: p.reason,
              },
              done,
            )
          }
        />
      )}
      {page === "My Flight" && (
        <Flight state={state} save={save} disabled={disabled} />
      )}
      {(state?.registration || page === "My profile") && (
        <Profile
          key={state.profile?.version || "new"}
          state={state}
          save={save}
          disabled={disabled}
        />
      )}
      {page === "My requests" && (
        <div className="cadet-requests">
          <section className="form-section">
            <h2>My excusals</h2>
            {!state.requests.length ? (
              <Empty>No requests this term.</Empty>
            ) : (
              <Table
                headers={["Event", "Requested", "Status", "Decision reason"]}
              >
                {state.requests.map((r) => (
                  <tr key={r.requestId}>
                    <td>{r.event}</td>
                    <td>{r.requestedOutcome}</td>
                    <td>
                      <Status>{r.status}</Status>
                    </td>
                    <td>{r.decisionReason || "—"}</td>
                  </tr>
                ))}
              </Table>
            )}
            <Submission
              mode="excusal"
              state={state}
              save={save}
              disabled={disabled}
            />
          </section>
          <section className="form-section">
            <h2>My attendance flags</h2>
            {!flags.length && <Empty>No attendance flags this term.</Empty>}
            {flags.map((a) => (
                <p key={a.actionId}>
                  <strong>{a.event}</strong> · {a.detail} ·{" "}
                  {a.resolution || "Awaiting Flight review"}
                </p>
              ))}
            <Submission
              mode="flag"
              state={state}
              save={save}
              disabled={disabled}
            />
          </section>
        </div>
      )}
    </WorkspaceShell>
  );
}
