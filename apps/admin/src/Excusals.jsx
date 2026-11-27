import { ToolbarFilters } from "./ToolbarFilters";
import React, { useContext, useState } from "react";
import {
  Drawer,
  EditorError,
  Heading,
  Select,
  Field,
  Table,
  Status,
  Empty,
  SearchBox,
} from "./components";
import { cellStyle, flightColors } from "./roster-colors";
import { eventZone } from "./time";
import { name } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";

const decisions = { Approved: "Approve", Denied: "Deny", Withdrawn: "Withdraw", Superseded: "Supersede" };

const submissionTime = new Intl.DateTimeFormat("en-US", {
  timeZone:eventZone, month:"short", day:"numeric", year:"numeric",
  hour:"numeric", minute:"2-digit", timeZoneName:"short",
});
function SubmittedAt({value}) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const label = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : submissionTime.format(new Date(value));
  return <time dateTime={value} aria-label={"Submitted " + label} title={"Submitted " + label}>{label}</time>;
}

function DecisionButtons({request, busy, onPick}) {
  return <div className="excusal-actions">
    {["Approved","Denied"].map(outcome =>
      <button key={outcome} data-decision={outcome} disabled={busy || outcome === request.status}
        onClick={() => onPick(outcome)}>{decisions[outcome]}</button>)}
    <select aria-label="More decisions" value="" disabled={busy} onChange={e => onPick(e.target.value)}>
      <option value="" disabled>More</option>
      {["Withdrawn","Superseded"].map(outcome =>
        <option key={outcome} value={outcome} disabled={outcome === request.status}>{decisions[outcome]}</option>)}
    </select>
  </div>;
}

export default function Excusals({
  snapshot,
  list,
  onDecide,
  busy,
  error,
  readOnly = false,
}) {
  const editorError = useContext(EditorError);
  const s = snapshot || list;
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("Submitted"),
    [sort, setSort] = useState("submission"),
    [flight, setFlight] = useState(""),
    [squadron, setSquadron] = useState(""),
    [edit, setEdit] = useState(null),
    [reason, setReason] = useState("");
  const queue = currentExcusalRequests(s);
  const events = new Map(s.events.map((e) => [e.eventId, e.label]));
  const starts = new Map(s.events.map(e => [e.eventId, Date.parse(e.startAt)]));
  const people = new Map(s.people.map((p) => [p.personId, name(p)]));
  const who = (r) =>
    r.personDisplayName || people.get(r.personId) || "Unknown cadet";
  const squadrons = [...new Set(queue.map(r => r.capturedSquadronLabel).filter(Boolean))].sort();
  const flights = new Map(s.flights.map(f => [f.flightId, f.label]));
  const flightName = r => r.capturedFlightLabel || flights.get(r.flightId) || "—";
  const bySquadron = queue.filter(r => !squadron || squadron === r.capturedSquadronLabel);
  const visible = bySquadron.filter(
    (r) =>
      (!flight || r.flightId === flight) &&
      (!status || r.status === status) &&
      (who(r) + " " + events.get(r.eventId))
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  function submissionOrder(a, b) {
    return Number(b.status === "Submitted") - Number(a.status === "Submitted") ||
      (a.status === "Submitted" ? 1 : -1) * ((a.submittedAt || "").localeCompare(b.submittedAt || "")) ||
      who(a).localeCompare(who(b)) || a.requestId.localeCompare(b.requestId);
  }
  visible.sort((a, b) => {
    if (sort === "submission") return submissionOrder(a, b);
    const left = starts.get(a.eventId), right = starts.get(b.eventId);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right)
      return sort === "event-asc" ? left - right : right - left;
    if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
    return submissionOrder(a, b);
  });
  const selected = edit && queue.find(r => r.requestId === edit.requestId);
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  const canDecide = r => !readOnly && (scoped ? r.canDecide === true : r.canDecide !== false);
  const showActions = visible.some(canDecide);
  const close = () => { setEdit(null); setReason(""); };
  function pick(request, decision, note = "") {
    if (!canDecide(request) || busy) return;
    const target = {requestId: request.requestId, version: request.version, decision};
    setReason(note);
    setEdit(target);
  }
  const stale = selected && selected.version !== edit.version;
  return (
    <>
      <section className="page-controls">
        <Heading title="Excusals" />
        <div className="toolbar">
          <SearchBox
            placeholder="Find cadet or event"
            value={query}
            onChange={setQuery}
          />
          <ToolbarFilters active={Boolean(squadron || flight || status !== "Submitted" || sort !== "submission")}>
            {squadrons.length > 1 && <Select label="Squadron" value={squadron}
              onChange={value => {setSquadron(value);setFlight("");}}
              options={[{value:"",label:"Entire wing"},...squadrons]}/>}
            <Select
              label="Decision status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "All decisions" },
                {value:"Submitted",label:"Needs a decision"},
                ...new Set(queue.filter(r=>r.status !== "Submitted").map(r=>r.status)),
              ]}
            />
            <Select
              label="Flight"
              value={flight}
              onChange={setFlight}
              options={[
                { value: "", label: "All Flights" },
                ...Array.from(new Map(bySquadron.map(r => [r.flightId, flightName(r)])), ([value,label]) => ({value,label})).sort((a,b)=>a.label.localeCompare(b.label)),
              ]}
            />
            <Select label="Sort by" value={sort} onChange={setSort} options={[
              {value:"submission",label:"Submission time"},
              {value:"event-asc",label:"Event date · earliest first"},
              {value:"event-desc",label:"Event date · latest first"},
            ]}/>
          </ToolbarFilters>
        </div>
      </section>
      <Table className={`excusal-queue${showActions ? " actionable" : ""}`}
        headers={["Cadet", "Code", "Event", "Reason", "Submitted", "Status", ...(showActions ? ["Decision"] : [])]}>
        {visible.map(r => <tr key={r.requestId}>
          <td className="excusal-cadet" style={cellStyle(flightColors(flightName(r), r.capturedSquadronLabel))}><button
            title={flightName(r)} className="text-button"
            aria-label={`Request details for ${who(r)} · ${flightName(r)} · ${events.get(r.eventId)}`}
            onClick={() => { setReason(""); setEdit({requestId:r.requestId,version:r.version}); }}>
            {who(r)}
          </button></td>
          <td className="excusal-code" data-mark={r.requestedOutcome}>{r.requestedOutcome}</td>
          <td className="excusal-event">{events.get(r.eventId)}
            {sort !== "submission" && <small>{Number.isFinite(starts.get(r.eventId))
              ? <time dateTime={new Date(starts.get(r.eventId)).toISOString()}>{submissionTime.format(starts.get(r.eventId))}</time> : "Date to be determined"}</small>}
          </td>
          <td className="excusal-reason">{r.reason || "—"}</td>
          <td className="excusal-submitted"><SubmittedAt value={r.submittedAt}/></td>
          <td className="excusal-status" data-status={r.status}><Status>{r.status}</Status></td>
          {showActions && <td className="excusal-controls">{canDecide(r) &&
            <DecisionButtons request={r} busy={busy} onPick={d => pick(r,d)} />}
          </td>}
        </tr>)}
      </Table>
      {!visible.length && <Empty>No requests match these filters.</Empty>}
      {selected && <Drawer modal={Boolean(edit.decision)}
        title={edit.decision ? decisions[edit.decision] + " excusal?" : "Request details"} onClose={close}>
        <div className="fields">
          <RequestDetails request={selected} cadet={who(selected)} flight={flightName(selected)} event={events.get(selected.eventId)} />
          {(error || editorError) && <p className="error" role="alert">{error || editorError}</p>}
          {stale && <p role="alert">This request changed. Reopen it to review the latest decision.</p>}
          {canDecide(selected) && !stale && <Field label="Decision reason (optional)">
            <textarea maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} />
          </Field>}
        </div>
        {canDecide(selected) && !stale && <footer className="actions">
          {edit.decision ? <>
            <button disabled={busy} onClick={close}>Cancel</button>
            <button className="primary" disabled={busy}
              onClick={() => onDecide(payload(edit,reason),close)}>Confirm decision</button>
          </> : <DecisionButtons request={selected} busy={busy} onPick={d => pick(selected,d,reason)} />}
        </footer>}
      </Drawer>}
    </>
  );
}

function payload(target, note) {
  return {requestId:target.requestId, expectedVersion:target.version, decision:target.decision,
    reason:note.trim() || target.decision + " in the Excusals queue."};
}

function RequestDetails({request, cadet, flight, event}) {
  return <><strong>{cadet}</strong>{flight !== "—" && <span>{flight} Flight</span>}<div>{event} · {request.requestedOutcome}</div>
    <Status>{request.status}</Status>
    <SubmittedAt value={request.submittedAt}/>
    <blockquote>{request.reason}</blockquote>
    {request.decisionReason && <p>Decision reason · {request.decisionReason}</p>}</>;
}
