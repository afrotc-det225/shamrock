import React, { useEffect, useState, useRef } from "react";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";
import { api, logout, eventTypes } from "./api";
import { Empty, Field, Heading, Select, Status, Table } from "./components";
import Excusals from "./Excusals";
import {pageFromUrl, writePageUrl} from "./page-url";
import { useDirectoryPhoto } from "./DirectoryPhoto";
import WorkspaceShell from "./WorkspaceShell";
import { ViewAsAccount } from "./ViewAs";
import { ClipboardList, FileCheck2, Users, UserRound } from "lucide-react";
import { AttendanceKey, AttendanceMatrix } from "./AttendanceMatrix";
import { calculateAttendanceCredit } from "../../../packages/domain/src/frontend-reporting";
import { ATTENDANCE_CODES } from "../../../packages/domain/src/index";
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
function ProfilePhoto({profile}) {
  const {source, src:thumbnail, onError} = useDirectoryPhoto(profile.photoLink, 256, null);
  const initials = [profile.firstName, profile.lastName].map(name => name?.trim()[0]).join("");
  return <div className="profile-identity">
    <div className="profile-portrait">{thumbnail
      ? <img src={thumbnail} alt="Directory portrait" referrerPolicy="no-referrer" onError={onError} />
      : <span aria-label="Profile initials">{initials || "–"}</span>}</div>
    <div><h2>{[profile.firstName,profile.lastName].filter(Boolean).join(" ")}</h2>
      <p>{[profile.rank,profile.asYear,profile.university].filter(Boolean).join(" · ")}</p>
      {profile.email && <p>{profile.email}</p>}
      {source?.href && <a href={source.href} target="_blank" rel="noreferrer">Open original photo</a>}
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
function EventPicker({events, label, choose, type, setType, eventId, typeLabel="Event type"}) {
  return <>
    <Select label={typeLabel} value={type} onChange={value=>{setType(value);choose("");}} required
      options={[{value:"",label:"Select an event type"},...Object.entries(eventTypes).filter(([key])=>events.some(e=>e.eventType===key)).map(([value,label])=>({value,label}))]}/>
    <Field label={label}><select name="event" value={eventId} onChange={e=>choose(e.target.value)} required disabled={!type}>
      <option value="">Select an event</option>
      {events.filter(e=>e.eventType===type).map(e=><option key={e.eventId} value={e.eventId}>{e.label}</option>)}
    </select></Field>
  </>;
}
function ExcusalEvent({events,number}) {
  const [type,setType]=useState(""), [eventId,choose]=useState("");
  return <EventPicker events={events} label={number?"Event "+number:"Event"} typeLabel={number?"Event type "+number:"Event type"} {...{type,setType,eventId,choose}}/>;
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
            <ExcusalEvent key={i} number={count===1?null:i+1} events={state.events}/>
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
function PersonalAttendance({state, flags, save, disabled}) {
  const [selected,setSelected]=useState(null);
  const cell=state.attendance?.find(row=>row.eventId===selected);
  const cells=(state.attendance || []).map(e=>({...e,effectiveCode:e.code,eligible:true}));
  const row={...state.profile,cells,overall:calculateAttendanceCredit(cells),llab:calculateAttendanceCredit(cells.filter(e=>e.eventType==="llab"))};
  return <section><p>Select an event to request a correction from your Squadron Commander.</p><AttendanceKey/>
    {cells.length ? <AttendanceMatrix actionLabel="Review selected cell" rows={[row]} events={state.attendance} canCorrect={()=>true} onEdit={(_,e)=>setSelected(e.eventId)}/> : <Empty>No attendance events for this semester.</Empty>}
    {cell && <form key={selected} className="cadet-form" onSubmit={e=>{
      e.preventDefault();const fields=new FormData(e.currentTarget);
      save("flag",{eventId:selected,eventVersion:cell.version,baseVersion:cell.baseVersion,code:fields.get("code"),detail:fields.get("reason")},()=>setSelected(null));
    }}><h2>{cell.label}</h2><p>Recorded attendance: {cell.code||"Blank"}</p>
      <Field label="Requested code"><select name="code" required defaultValue=""><option value="" disabled>Choose a code</option>{ATTENDANCE_CODES.filter(c=>c!==cell.code).map(c=><option key={c}>{c}</option>)}</select></Field>
      <Field label="Reason"><textarea name="reason" required maxLength={500}/></Field><button className="primary" disabled={disabled}>Request correction</button></form>}
    {flags.length>0 && <section><h2>My correction requests</h2>{flags.map(a=><p key={a.actionId}><strong>{a.event}</strong> · {a.change?.code} {a.detail} · {a.resolution || (a.change?"Awaiting Squadron review":"Awaiting Flight review")}</p>)}</section>}
  </section>;
}

function AttendanceReviews({state,save,disabled}) {
  const queue=state.actions.filter(a=>a.change && a.change.squadronId===state.squadronId && !a.resolution);
  return queue.length ? queue.map(a=><section className="form-section" key={a.actionId}><h2>{a.person}</h2>
    <p>{a.event} · Requested code: <strong>{a.change.code}</strong></p><p>{a.detail}</p>
    {["Approved","Denied"].map(decision=><button key={decision} disabled={disabled} onClick={()=>save("reviewFlag",{parentId:a.actionId,decision})}>{decision==="Approved"?"Approve correction":"Deny request"}</button>)}</section>) : <Empty>No attendance corrections awaiting Squadron review.</Empty>;
}
function FlightReport({ state, save, disabled }) {
  const [type,setType]=useState(""), [eventId,setEvent]=useState("");
  const [details,setDetails]=useState(null), [error,setError]=useState(""), [attempt,retry]=useState(0);
  const [present,setPresent]=useState([]), [complete,setComplete]=useState(false);
  const events=state.reportEvents || [];
  const event=events.find(e=>e.eventId===eventId);
  function choose(id){
    setEvent(id);setDetails(null);setError("");setPresent([]);setComplete(false);
  }
  useEffect(()=>{
    if(!eventId)return;
    const controller=new AbortController();
    api("/cadet?section="+encodeURIComponent("report:"+eventId),undefined,{signal:controller.signal})
      .then(v=>{if(!controller.signal.aborted)setDetails(v);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[eventId,attempt]);
  const roster=[...(details?.reportRoster || [])].sort(compareCadetsForDisplay);
  const groups=new Map();
  for(const cadet of roster){
    const year=cadet.asYear || "Unassigned AS year";
    if(!groups.has(year))groups.set(year,[]);
    groups.get(year).push(cadet);
  }
  const campus=roster[0]?.campus;
  const flight=state.flights.find(f=>f.flightId===state.profile.flightId)?.label;
  const crossFlight=type==="secondary" || (type==="mando" && !!campus);
  return <section><form className="cadet-form" onSubmit={e=>{
    e.preventDefault();
    if(!event || !roster.length)return;
    save("report",{eventId,version:roster[0].version,rosterVersions:Object.fromEntries(details.flights.map(f=>[f.flightId,f.rosterVersion])),
      present,completeness:complete?"complete":"partial"},()=>choose(""));
  }}>
    <EventPicker label="Attendance event" {...{events,type,setType,eventId,choose}}/>
    {event && !details && !error && <p role="status">Loading event roster…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>{setError("");retry(n=>n+1);}}>Retry</button></p>}
    {event && details && (roster.length ? <>
      <h2>{type==="secondary"?"All Flights":type==="mando" && campus ? campus+" · All Flights" : flight+" Flight"}</h2>
      {Array.from(groups,([year,people])=><fieldset key={year}><legend>{year}</legend>{people.map(r=><label key={r.personId}>
        <input type="checkbox" checked={present.includes(r.personId)} onChange={e=>setPresent(e.target.checked?[...present,r.personId]:present.filter(p=>p!==r.personId))}/>
        {r.lastName}, {r.firstName}</label>)}</fieldset>)}
      {!crossFlight && details.ownFlightCount===roster.length && <label><input type="checkbox" checked={complete} onChange={e=>setComplete(e.target.checked)}/> Complete Flight report</label>}
      <button className="primary" disabled={disabled || (!present.length && !complete)}>Submit attendance</button>
    </> : <Empty>No eligible cadets for this event.</Empty>)}
  </form></section>;
}
function Flight({ state, save, disabled }) {
  return (
    <>
      {state.actions.some(a=>a.kind==="flag" && !a.change && !a.resolution) && <h2>Earlier Flight review requests</h2>}
      {state.actions
        .filter((a) => a.kind === "flag" && !a.change && !a.resolution)
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
      {!state.actions.some((a) => a.kind === "flag" && !a.change && !a.resolution) && (
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
  const section = tab==="Submit attendance" ? "report" : tab==="My attendance" ? "attendance" : "";
  const currentSection=useRef(section);
  currentSection.current=section;
  const load = async () => {
    const s = await api("/cadet"+(section?"?section="+section:""));
    if(currentSection.current===section)setState(s);
    return s;
  };
  useEffect(() => {
    load().catch((e) => {if(currentSection.current===section)setError(e.message);});
  }, [section]);
  async function save(kind, fields, done) {
    if (active.current || !state?.writable || (preview && state?.readOnly !== false)) return;
    active.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([kind, fields]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      const action = { kind, fields, id: pending.current.id };
      await api("/cadet", preview ? {entryAuditId:session.viewAs.entryAuditId, action} : action);
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
          ["My attendance", ClipboardList],
          ["Submit attendance", ClipboardList],
          ...(state.squadron ? [["Attendance reviews",FileCheck2]] : []),
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
    (preview && state?.readOnly !== false) ||
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
      {preview && <ViewAsAccount acting={state?.readOnly === false} label={name || "selected cadet"} busy={busy} onExit={async () => {
        try {
          await api("/view-as", { personId: null });
          location.assign("/");
        } catch (e) { setError(e.message); }
      }} />}
      {!preview && !session.schoolLogin && <a className="workspace-switch" href="/events">Leadership workspace</a>}
      <p>
        {name && !preview && <strong className="account-name">{name}</strong>}
        {role}
        {!preview && <button className="sign-out" onClick={() => logout().catch((e) => setError(e.message))}>Sign out</button>}
      </p>
    </>}>

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
      {state && !state.writable && (
        <p className="notice">Submissions are paused.</p>
      )}
      {preview && state?.profile && !state.linked && <p className="notice">This cadet must connect their school account before you can act on their behalf.</p>}
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
          readOnly={disabled}
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
      {page==="Attendance reviews" && <AttendanceReviews state={state} save={save} disabled={disabled}/>}
      {page==="My attendance" && (state.section==="attendance" ? <PersonalAttendance state={state} flags={flags} save={save} disabled={disabled}/> : <p role="status">Loading attendance…</p>)}
      {page==="Submit attendance" && (state.section==="report" ? <FlightReport state={state} save={save} disabled={disabled}/> : <p role="status">Loading Flight roster…</p>)}
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

        </div>
      )}
    </WorkspaceShell>
  );
}
