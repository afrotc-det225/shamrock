import React, { useEffect, useState, useRef, useMemo } from "react";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";
import { api, logout, eventTypes } from "./api";
import { Drawer, Empty, Field, Heading, Select, Status, Table } from "./components";
import Excusals from "./Excusals";
import {pageFromUrl, workspaceFromUrl, writePageUrl} from "./page-url";
import { ProfileField } from "./ProfileField";
import { DirectoryPhoto } from "./DirectoryPhoto";
import WorkspaceShell from "./WorkspaceShell";
import { ViewAsAccount } from "./ViewAs";
import {personalPages} from "./site-navigation";
import { ChevronDown, ExternalLink } from "lucide-react";
import { attendanceMeanings } from "./AttendanceMatrix";
import {loadReportDraft, restoreSelections, rosterSignature} from "./report-draft";
import {Overview} from "./Secondary";
import CadetDirectory from "./CadetDirectory";
import { cellStyle, yearColors, rateStyle } from "./roster-colors";
import { ToolbarPopover } from "./ToolbarPopover";
import { FlightHome } from "./FlightHome";
import { calculateAttendanceCredit } from "../../../packages/domain/src/frontend-reporting";
import { ATTENDANCE_CODES } from "../../../packages/domain/src/index";
import { selfServiceRoles } from "../../../packages/domain/src/flight-roles";
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
  return <div className="profile-identity">
    <DirectoryPhoto value={profile.photoLink} person={profile} personId={null} portrait/>
    <div><h2>{[profile.firstName,profile.lastName].filter(Boolean).join(" ")}</h2>
      <p>{[profile.rank,profile.asYear,profile.university].filter(Boolean).join(" · ")}</p>
      {profile.email && <p>{profile.email}</p>}
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
  const editableFields = register ? fields : [...fields, ["university","University"], ["asYear","AS year"], ["rank","Rank"], ["role","Role"], ["contactEmail","Contact email"]];
  const flight = state.flights.find(f=>f.flightId === form.flightId);
  const roles = flight ? selfServiceRoles(flight.label) : [""];
  const managerRole = !roles.includes(state.profile?.role || "");
  const visible = register
    ? step === 0
      ? fields.slice(0, 5)
      : fields.slice(5)
    : editableFields;
  const groups = [["Contact information", ["firstName","lastName","contactEmail","phone","dateOfBirth","dorm","homeTown","homeState"]], ["Academics and career", ["university","classYear","cipBroadArea","cipCode","afsc"]], ...(!register ? [["Cadet information", ["asYear","rank","role"]]] : []), ...(register ? [["Directory photo", ["photoLink"]]] : [])];
  function submit(e) {
    e.preventDefault();
    if (register && step === 0) {
      setStep(1);
      return;
    }
    const changes = Object.fromEntries(
      editableFields
        .map(([k]) => [k, form[k]?.trim() || (k === "dateOfBirth" ? null : "")])
        .filter(([k, v]) => register || (state.profile[k] ?? (k === "dateOfBirth" ? null : "")) !== v),
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
    <form onSubmit={submit} className="cadet-form profile-form">
      {!register && <div className="profile-header">
        <ProfilePhoto profile={state.profile}/>
        <fieldset disabled={disabled}><ProfileField field="photoLink" label="Directory photo link"
          original={state.profile.photoLink} value={form.photoLink || ""} onChange={value=>pick("photoLink",value)}/></fieldset>
      </div>}
      {register && <h2>{step === 0 ? "Directory information" : "Academic and career information"}</h2>}
      <fieldset disabled={disabled && !register}>
        {register && step === 0 && (
          <div className="cadet-fields">
              <ProfileField field="university" label="University" required value={form.university} onChange={v=>pick("university",v)}/>
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
          </div>
        )}
        {groups.map(([title, keys]) => {
          const members = visible.filter(([key]) => keys.includes(key));
          return members.length > 0 && <section key={title} className="profile-section"><h3>{title}</h3><div className="cadet-fields">
          {members.map(([key,label]) => <div className="profile-input" data-field={key} key={key}>
            {key === "asYear" ? <Select label={label} value={form.asYear} required onChange={v=>pick(key,v)} options={[{value:"",label:"Choose AS year"}, ...AS_YEARS]}/> : key === "role" ? <Select label={label} value={form.role || ""} disabled={managerRole || !flight} onChange={v=>pick(key,v)}
              options={[{value:"",label:"No Flight position"}, ...roles.filter(Boolean), ...(managerRole ? [state.profile.role] : [])]}/> : <ProfileField field={key === "contactEmail" ? "email" : key} label={key === "afsc" ? "Air Force Specialty Code (AFSC)" : label}
              broadArea={key === "cipCode" ? form.cipBroadArea : undefined} originalBroadArea={key === "cipCode" ? state.profile?.cipBroadArea : undefined}
              original={state.profile?.[key]} required={required.has(key) && (register || !!state.profile?.[key])}
              value={form[key] || ""} onChange={value=>pick(key,value)}/>}
            {key === "role" && <small>Command assignments are managed by the Directory manager.</small>}
            {key === "contactEmail" && <small>Shown in the cadet Directory. Leave blank to use your school email.</small>}
            {key === "cipCode" && <a className="field-resource" href="https://nces.ed.gov/ipeds/cipcode/" target="_blank" rel="noreferrer">Find your major’s CIP code <ExternalLink size={14}/></a>}
            {key === "afsc" && <a className="field-resource" href="https://tmd.texas.gov/Data/Sites/1/media/tmd-jobs/ang-dsg-vacancy/fy26/quarter-3/air-force-officer-classification-directory-afocd-30-april-2025.pdf" target="_blank" rel="noreferrer">Officer classification directory (DAFOCD) <ExternalLink size={14}/></a>}
          </div>)}
        </div>
        </section>;
        })}
      </fieldset>
      <div className="profile-actions">{register && step === 1 && (
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
      </button></div>
    </form>
  );
}
function EventPicker({events, label, choose, type, setType, eventId, typeLabel="Event type"}) {
  return <>
    <Select label={typeLabel} value={type} onChange={value=>{setType(value);choose("");}} required
      options={[{value:"",label:"Select an event type"},...Object.entries(eventTypes).filter(([key])=>events.some(e=>e.eventType===key)).map(([value,label])=>({value,label}))]}/>
    {type && <Field label={label}><select name="event" value={eventId} onChange={e=>choose(e.target.value)} required disabled={!type}>
      <option value="">Select an event</option>
      {events.filter(e=>e.eventType===type).map(e=><option key={e.eventId} value={e.eventId}>{e.label}</option>)}
    </select></Field>}
  </>;
}
function ExcusalEvent({events,number}) {
  const [type,setType]=useState(""), [eventId,choose]=useState("");
  return <EventPicker events={events} label={number?"Event "+number:"Event"} typeLabel={number?"Event type "+number:"Event type"} {...{type,setType,eventId,choose}}/>;
}
function Submission({ state, mode, save, disabled }) {
  const [count, setCount] = useState(1);
  return (
    <section className="cadet-compose">
      <h3>{mode === "flag" ? "Flag attendance" : "Request an excusal"}</h3>
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
          <div className="cadet-inline-actions">
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
          </div>
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
    </section>
  );
}
function PersonalAttendance({state, flags, save, disabled}) {
  const [selected,setSelected]=useState([]);
  const anchor=useRef(null);
  function dismiss(){setSelected([]);anchor.current=null;}
  const events=state.attendance || [];
  const cells=events.map(e=>({effectiveCode:e.code,eligible:true}));
  function credit(list){
    const value=calculateAttendanceCredit(list);
    return <dd style={rateStyle(value.noCountedAttendance ? null : value.percentage)}>{value.noCountedAttendance ? "—" : (value.percentage*100).toFixed(1)+"%"}</dd>;
  }
  function select(event,index,click){
    if(click.shiftKey && anchor.current!==null){
      setSelected(events.slice(Math.min(index,anchor.current),Math.max(index,anchor.current)+1));
    }else if(click.ctrlKey || click.metaKey){
      setSelected(old=>old.includes(event)?old.filter(e=>e!==event):[...old,event]);anchor.current=index;
    }else{setSelected([event]);anchor.current=index;}
  }
  return <section>
    {events.length ? <>
      <dl className="personal-credit"><div><dt>Overall</dt>{credit(cells)}</div>
        <div><dt>LLAB</dt>{credit(cells.filter((_,i)=>events[i].eventType==="llab"))}</div></dl>
      <table className="personal-events" aria-label="Attendance"><thead><tr><th>Event</th><th>Attendance</th></tr></thead>
      <tbody>{events.map((event,i)=><tr key={event.eventId}><th scope="row">{event.label}</th><td className="personal-mark" data-mark={event.code || ""}>
        <button type="button" data-event={event.eventId} disabled={disabled} aria-pressed={selected.includes(event)}
          aria-label={event.label+" · "+(event.code?event.code+" · ":"")+(attendanceMeanings[event.code] || "Unmarked")+", request correction"}
          onKeyDown={key=>{
            if(!["ArrowDown","ArrowUp"].includes(key.key))return;
            const next=i+(key.key==="ArrowDown"?1:-1);
            const button=key.currentTarget.closest("tbody").rows[next]?.querySelector("button");
            if(!button)return;
            key.preventDefault();button.focus();
            if(key.shiftKey){if(anchor.current===null)anchor.current=i;select(events[next],next,key);}
          }}
          onClick={click=>select(event,i,click)}>{event.code && <strong>{event.code} </strong>}{attendanceMeanings[event.code] || "Unmarked"}</button>
        {event.needsReview && <small>Needs review</small>}</td></tr>)}</tbody></table>
    </> : <Empty>No attendance events for this semester.</Empty>}
    {selected.length>0 && <Drawer title="Request correction" bottomSheet onClose={dismiss}><form key={JSON.stringify(selected.map(e=>e.eventId))} className="cadet-form" onSubmit={e=>{
      e.preventDefault();
      const fields=new FormData(e.currentTarget), code=fields.get("code");
      const requests=selected.filter(event=>event.code!==code).map(event=>({
        eventId:event.eventId,eventVersion:event.version,baseVersion:event.baseVersion,code,detail:fields.get("reason")
      }));
      save("flag",requests,dismiss);
    }}><h2>{selected.map(event=>event.label).join(", ")}</h2>
      <Field label="Requested code"><select name="code" required defaultValue=""><option value="" disabled>Choose a code</option>{ATTENDANCE_CODES.filter(code=>selected.some(event=>event.code!==code)).map(c=><option key={c}>{c}</option>)}</select></Field>
      <Field label="Reason"><textarea name="reason" required maxLength={500}/></Field><button className="primary" disabled={disabled}>Send for Squadron review</button></form></Drawer>}
    {flags.length>0 && <section><h2>My correction requests</h2>{flags.map(a=><p key={a.actionId}><strong>{a.event}</strong> · {a.change && <span className="code-label" data-mark={a.change.code}>{a.change.code}</span>} {a.detail} · {a.resolution || (a.change?"Awaiting Squadron review":"Awaiting Flight review")}</p>)}</section>}
  </section>;
}

function AttendanceReviews({state,save,disabled}) {
  const queue=state.actions.filter(a=>a.change && a.change.squadronId===state.squadronId && !a.resolution);
  return queue.length ? queue.map(a=><section className="form-section" key={a.actionId}><h2>{a.person}</h2>
    <p>{a.event} · Requested code: <strong className="code-label" data-mark={a.change.code}>{a.change.code}</strong></p><p>{a.detail}</p>
    {["Approved","Denied"].map(decision=><button key={decision} disabled={disabled} onClick={()=>save("reviewFlag",{parentId:a.actionId,decision})}>{decision==="Approved"?"Approve correction":"Deny request"}</button>)}</section>) : <Empty>No attendance corrections awaiting Squadron review.</Empty>;
}
function FlightReport({ state, save, disabled, previewId }) {
  const key = "shamrock.reportDraft.v1." + (previewId ? "preview."+previewId+"." : "") + state.profile.personId;
  const storage = () => previewId ? sessionStorage : localStorage;
  const [draft,setDraft] = useState(()=>loadReportDraft(storage,key));
  const events=state.reportEvents || [];
  const initialEvent=events.find(event=>event.eventId===draft?.eventId);
  const [type,setType]=useState(initialEvent?.eventType || ""), [eventId,setEvent]=useState(initialEvent?.eventId || "");
  const [draftNotice,setDraftNotice]=useState("");
  const restore=useRef(draft);
  const [details,setDetails]=useState(null), [error,setError]=useState(""), [attempt,retry]=useState(0);
  const [present,setPresent]=useState([]), [complete,setComplete]=useState(false);
  const [search,setSearch]=useState("");
  const event=events.find(e=>e.eventId===eventId);
  function choose(id){
    restore.current=id===draft?.eventId ? draft : null;setDraftNotice("");
    setEvent(id);setDetails(null);setError("");setPresent([]);setComplete(false);setSearch("");
  }
  useEffect(()=>{
    if(!eventId)return;
    const controller=new AbortController();
    api("/cadet?section="+encodeURIComponent("report:"+eventId),undefined,{signal:controller.signal})
      .then(v=>{
        if(controller.signal.aborted)return;
        const saved=restore.current;
        if(saved?.eventId===eventId){
          const selection=restoreSelections(saved,v);
          setPresent(selection.present);
          setComplete(selection.complete);
          if(selection.changed)setDraftNotice("The event roster changed. Review your selections before submitting.");
          restore.current=null;
        }
        setDetails(v);
      })
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[eventId,attempt]);
  const roster=useMemo(()=>[...(details?.reportRoster || [])].sort(compareCadetsForDisplay),[details]);
  const signature=useMemo(()=>details ? rosterSignature(details) : "",[details]);
  const groups=new Map();
  const words=search.trim().toLowerCase().split(/[\s,]+/);
  for(const cadet of roster){
    const name=(cadet.firstName+" "+cadet.lastName).toLowerCase();
    if(!words.every(word=>name.includes(word)))continue;
    const year=cadet.asYear || "Unassigned AS year";
    if(!groups.has(year))groups.set(year,[]);
    groups.get(year).push(cadet);
  }
  const campus=roster[0]?.campus;
  const flight=state.flights.find(f=>f.flightId===state.profile.flightId)?.label;
  const crossFlight=type==="secondary" || (type==="mando" && !!campus);
  function currentDraft(){
    return {eventId,present:[...present].sort(),complete,roster:signature};
  }
  function storeDraft(){
    const next={...currentDraft(),id:crypto.randomUUID()};
    try {
      storage().setItem(key,JSON.stringify(next));
      setDraft(next);setDraftNotice("");
    } catch {setDraftNotice("This browser could not save the draft.");}
  }
  function forgetDraft(expected){
    try {
      if(JSON.stringify(loadReportDraft(storage,key))===JSON.stringify(expected))storage().removeItem(key);
      setDraft(loadReportDraft(storage,key));setDraftNotice("");
    } catch {setDraftNotice("This browser could not clear the saved draft.");}
  }
  const savedEvent=events.find(e=>e.eventId===draft?.eventId);
  const savedHere=draft && draft.eventId===eventId;
  const matches=savedHere && details && draft.roster===signature && draft.complete===complete
    && JSON.stringify(draft.present)===JSON.stringify([...present].sort());
  return <section><form className="cadet-form" onSubmit={e=>{
    e.preventDefault();
    if(!event || !roster.length)return;
    save("report",{eventId,version:roster[0].version,rosterVersions:Object.fromEntries(details.flights.map(f=>[f.flightId,f.rosterVersion])),
      present:[...present].sort(),completeness:complete?"complete":"partial"},()=>{
        if(savedHere)forgetDraft(draft);
        choose(""); setType("");
      }, matches ? draft.id : undefined);
  }}>
    {draft && !savedHere && <div className="draft-banner">
      <span title={savedEvent?.label}>Draft · {savedEvent?.label || "Unavailable event"}</span>
      {savedEvent && <button type="button" aria-label="Resume draft" onClick={()=>{
        setType(savedEvent.eventType);choose(draft.eventId);
      }}>Resume</button>}
      <button type="button" aria-label="Discard draft" onClick={()=>forgetDraft(draft)}>Discard</button>
    </div>}
    <EventPicker label="Attendance event" {...{events,type,setType,eventId,choose}}/>
    {event && !details && !error && <p role="status">Loading event roster…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>{setError("");retry(n=>n+1);}}>Retry</button></p>}
    {event && details && (roster.length ? <>
      <h2>{type==="secondary"?"All Flights":type==="mando" && campus ? campus+" · All Flights" : flight+" Flight"}</h2>
      <Field label="Find a cadet"><input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></Field>
      {!groups.size && <Empty>No matching cadets.</Empty>}
      {Array.from(groups,([year,people])=><fieldset className="report-checklist" key={year}><legend style={cellStyle(yearColors(year))}>{year}</legend>{people.map(r=><label key={r.personId}>
        <input type="checkbox" checked={present.includes(r.personId)} onChange={e=>{
          const checked=e.currentTarget.checked;
          setPresent(ids=>checked ? [...new Set([...ids,r.personId])] : ids.filter(id=>id!==r.personId));
        }}/>
        {r.lastName}, {r.firstName}</label>)}</fieldset>)}
      <div className="cadet-inline-actions">
        <button className="primary" disabled={disabled || (!present.length && !complete)}>{complete ? "Submit full Flight report" : "Submit attendance"}</button>
        {!crossFlight && details.ownFlightCount===roster.length && <ToolbarPopover label="Submission options" icon={ChevronDown} iconOnly>
          <label className="report-completion"><input type="checkbox" checked={complete} disabled={disabled}
            onChange={e=>setComplete(e.target.checked)}/>Entire Flight accounted for</label>
        </ToolbarPopover>}
        <button type="button" disabled={disabled || matches} onClick={storeDraft}>{matches ? "Saved" : savedHere ? "Save changes" : draft ? "Replace saved draft" : "Save for later"}</button>
      </div>
    </> : <Empty>No eligible cadets for this event.</Empty>)}
    {draftNotice && <p role="status">{draftNotice}</p>}
  </form></section>;
}
function Flight({ state, save, disabled }) {
  return (
    <FlightHome>
      <section className="flight-flags"><h2>Flagged attendance</h2>
      {!state.actions.some(a=>a.kind==="flag" && a.flightId===state.profile.flightId && !a.resolution) && <Empty>No open Flight flags.</Empty>}
      {state.actions
        .filter((a) => a.kind === "flag" && a.flightId===state.profile.flightId && !a.resolution)
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
            {a.change ? <p>Requested <span className="code-label" data-mark={a.change.code}>{a.change.code}</span> · Awaiting Squadron review</p> : <>
            <Field label="Resolution">
              <input name="resolution" required maxLength={500} />
            </Field>
            <button disabled={disabled}>Mark reviewed</button></>}
          </form>
        ))}

      </section>
    </FlightHome>
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
  const section = tab==="Overview" ? "overview" : tab==="Cadets" ? "directory" : tab==="Excusals" ? "excusals" : tab==="My profile" ? "profile" : tab==="Submit attendance" ? "report" : tab==="My attendance" ? "attendance" : "";
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
  useEffect(() => { setNotice(""); }, [tab]);
  async function save(kind, fields, done, savedId) {
    if (active.current || !state?.writable || (preview && state?.readOnly !== false)) return;
    active.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([kind, fields]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, actions: (Array.isArray(fields) ? fields : [fields]).map(item=>({kind,fields:item,id:savedId || crypto.randomUUID()})), next:0 };
    const batch=pending.current;
    try {
      while(batch.next<batch.actions.length){
        const action=batch.actions[batch.next];
        await api("/cadet", preview ? {entryAuditId:session.viewAs.entryAuditId, action} : action);
        batch.next++;
      }
      await load();
      pending.current = null;
      done?.();
      if (currentSection.current === section) setNotice("Saved.");
    } catch (e) {
      setError(batch.next && batch.next<batch.actions.length ? batch.next+" of "+batch.actions.length+" saved. "+e.message : e.message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const flight = state?.flights.find(
    (f) => f.flightId === state.profile?.flightId,
  )?.label;
  const pages = personalPages(state);
  const page = pages.find(([title]) => title === tab)?.[0] || pages[0]?.[0];
  useEffect(() => {
    const restore = () => {
      if (workspaceFromUrl() !== "leadership") setTab(pageFromUrl("cadet"));
    };
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
  const readOnly =
    (preview && state?.readOnly !== false) ||
    !state?.writable ||
    (!state?.linked && !state?.registration);
  const disabled = busy || readOnly;
  const flags = (state?.actions || []).filter(a => a.kind === "flag" && a.personId === state.profile?.personId);
  const queue = state?.queue || [];
  const list = (state?.squadron || state?.flightCommander) && {
    terms: [{ termId: "current", isCurrent: true }],
    events: [
      ...new Map(
        queue.map((r) => [
          r.eventId,
          {
            eventId: r.eventId,
            label: r.event,
            startAt: r.eventStartAt,
            termId: "current",
            status: "active",
          },
        ]),
      ).values(),
    ],
    flights: state.flights,
    people: [],
    requests: queue.map((r) => ({ ...r, canDecide: Boolean(state.squadron) })),
    access: { capabilities: { fullSnapshot: false } },
  };
  return (
    <WorkspaceShell session={session} preview={session.viewAs} mobileContext={preview && ((state?.readOnly === false ? "Acting as " : "Viewing as ") + (name || "selected cadet"))} workspace="cadet" pages={pages} page={state?.registration ? "Create profile" : page} navigate={navigate} account={<>
      {state && !state.writable && <small role="status" className="submission-status">Submissions are paused.</small>}
      {preview && <ViewAsAccount acting={state?.readOnly === false} label={name || "selected cadet"} busy={busy} onExit={async () => {
        try {
          await api("/view-as", { personId: null });
          location.assign("/overview");
        } catch (e) { setError(e.message); }
      }} />}
      <p>
        {name && !preview && <strong className="account-name">{name}</strong>}
        {role}
        {!preview && <button className="sign-out" onClick={() => logout().catch((e) => setError(e.message))}>Sign out</button>}
      </p>
    </>}>

      {page !== "Excusals" && page !== "Overview" && page !== "Cadets" && <Heading title={state?.registration ? "Create profile" : page || "My workspace"} />}
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
          readOnly={readOnly || !state.squadron}
          error={error}
          onDecide={(p, done) =>
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
      {page==="Overview" && (state?.overview ? <Overview overview={state.overview} memberReport={state.compiled}
        birthdayCalendar={state.birthdayCalendar} birthdayFlights={state.birthdayFlights} birthdaySquadrons={state.birthdaySquadrons}/> : <p role="status">Loading Overview…</p>)}
      {page==="Cadets" && (state?.section==="directory" ? <CadetDirectory rows={state.directory}/> : <p role="status">Loading Directory…</p>)}
      {page==="Attendance reviews" && <AttendanceReviews state={state} save={save} disabled={disabled}/>}
      {page==="My attendance" && (state.section==="attendance" ? <PersonalAttendance state={state} flags={flags} save={save} disabled={disabled}/> : <p role="status">Loading attendance…</p>)}
      {page==="Submit attendance" && (state.section==="report" ? <FlightReport key={(session.viewAs?.entryAuditId || "self")+state.profile.personId} previewId={session.viewAs?.entryAuditId} state={state} save={save} disabled={disabled}/> : <p role="status">Loading Flight roster…</p>)}
      {page === "My Flight" && !state.section && (
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
      {page === "My excusals" && (
        <div className="cadet-requests">
          <section className="form-section">
            <h2>My excusals</h2>
            {!state.requests.length ? (
              <Empty>No requests this term.</Empty>
            ) : (
              <Table
                className="personal-excusals" headers={["Event", "Code", "Excusal reason", "Status", "Decision reason"]}
              >
                {state.requests.map((r) => (
                  <tr key={r.requestId}>
                    <td>{r.event}</td>
                    <td className="excusal-code personal-mark" data-mark={r.requestedOutcome}>{r.requestedOutcome}</td>
                    <td>{r.reason || "—"}</td>
                    <td>
                      <Status>{r.status}</Status>
                    </td>
                    <td className={r.decisionReason ? "personal-decision" : "empty-decision"}>{r.decisionReason || "—"}</td>
                  </tr>
                ))}
              </Table>
            )}

          </section>
          <section className="form-section">
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
