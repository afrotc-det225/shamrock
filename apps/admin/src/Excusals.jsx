import React, { useState } from "react";
import {
  Drawer,
  Heading,
  Select,
  Field,
  Editor,
  Table,
  Status,
  Empty,
  SearchBox,
} from "./components";
import { name } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";

export default function Excusals({
  snapshot,
  list,
  propose,
  busy,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("Submitted"),
    [flight, setFlight] = useState(""),
    [squadron, setSquadron] = useState(""),
    [edit, setEdit] = useState(null),
    [decision, setDecision] = useState("Approved"),
    [reason, setReason] = useState("");
  const queue = currentExcusalRequests(s);
  const events = new Map(s.events.map((e) => [e.eventId, e.label]));
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
  visible.sort((a,b) => Number(b.status === "Submitted") - Number(a.status === "Submitted") ||
    (a.status === "Submitted" ? 1 : -1) * ((a.submittedAt || "").localeCompare(b.submittedAt || "")) ||
    who(a).localeCompare(who(b)));
  const selected = edit && queue.find(r => r.requestId === edit.requestId);
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  return (
    <>
      <section className="page-controls">
        <Heading title="Excusals">
          <span className="pending-total">
            {queue.filter((r) => r.status === "Submitted").length} pending
          </span>
        </Heading>
        {squadrons.length > 1 && <div className="squadron-tabs" aria-label="Squadron queues">
          {["", ...squadrons].map(label => <button key={label} aria-pressed={squadron === label}
            onClick={() => { setSquadron(label); setFlight(""); }}>{label || "Wing"} · {queue.filter(r => (!label || r.capturedSquadronLabel === label) && r.status === "Submitted").length}</button>)}
        </div>}
        <div className="toolbar">
          <SearchBox
            placeholder="Find cadet or event"
            value={query}
            onChange={setQuery}
          />
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
        </div>
      </section>
      <Table headers={["Cadet / Flight", "Event", "Requested", "Status", ""]}>
        {visible.map((r) => (
          <tr key={r.requestId}>
            <td>
              {who(r)}
              <small>{flightName(r)}</small>
            </td>
            <td>{events.get(r.eventId)}</td>
            <td>{r.requestedOutcome}</td>
            <td>
              <Status>{r.status}</Status>
            </td>
            <td>
                <button
                  disabled={busy}
                  onClick={() => {
                    setReason("");
                    setDecision("Approved");
                    setEdit({requestId:r.requestId,version:r.version});
                  }}
                >
                  {readOnly || (scoped && !r.canDecide) ? "Details" : "Review"}
                </button>
            </td>
          </tr>
        ))}
      </Table>
      {!visible.length && <Empty>No requests match these filters.</Empty>}
      {selected && (readOnly || (scoped && !selected.canDecide)) &&
        <Drawer title="Request details" onClose={() => setEdit(null)}>
          <div className="fields"><RequestDetails request={selected} cadet={who(selected)} event={events.get(selected.eventId)} /></div>
        </Drawer>}
      {selected && !readOnly && (!scoped || selected.canDecide === true) && (
          <Editor
            title="Review excusal"
            busy={busy}
            onClose={() => setEdit(null)}
            onSubmit={() =>
              propose(
                "excusal.decide",
                {
                  requestId: edit.requestId,
                  expectedVersion: edit.version,
                  decision,
                  reason,
                },
                () => setEdit(null),
              )
            }
          >
            <RequestDetails request={selected} cadet={who(selected)} event={events.get(selected.eventId)} />
            <Select
              label="Decision"
              value={decision}
              onChange={setDecision}
              options={["Approved", "Denied", "Withdrawn", "Superseded"]}
            />
            <Field label="Reason for this change">
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </Editor>
        )}
    </>
  );
}

function RequestDetails({request, cadet, event}) {
  return <><strong>{cadet}</strong><div>{event} · {request.requestedOutcome}</div>
    <Status>{request.status}</Status>
    {request.submittedAt && <small>Submitted {new Date(request.submittedAt).toLocaleDateString()}</small>}
    <blockquote>{request.reason}</blockquote>
    {request.decisionReason && <p>Decision reason · {request.decisionReason}</p>}</>;
}
