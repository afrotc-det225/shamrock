import React, { useState } from "react";
import {
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
    [edit, setEdit] = useState(null),
    [decision, setDecision] = useState("Approved"),
    [reason, setReason] = useState("");
  const queue = currentExcusalRequests(s);
  const events = new Map(s.events.map((e) => [e.eventId, e.label]));
  const people = new Map(s.people.map((p) => [p.personId, name(p)]));
  const who = (r) =>
    r.personDisplayName || people.get(r.personId) || "Unknown cadet";
  const visible = queue.filter(
    (r) =>
      (!flight || r.flightId === flight) &&
      (!status || r.status === status) &&
      (who(r) + " " + events.get(r.eventId))
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  return (
    <>
      <section className="page-controls">
        <Heading title="Excusals">
          <span className="pending-total">
            {queue.filter((r) => r.status === "Submitted").length} pending
          </span>
        </Heading>
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
              ...new Set(["Submitted", ...queue.map((r) => r.status)]),
            ]}
          />
          <Select
            label="Flight"
            value={flight}
            onChange={setFlight}
            options={[
              { value: "", label: "All Flights" },
              ...s.flights.map((f) => ({ value: f.flightId, label: f.label })),
            ]}
          />
        </div>
      </section>
      <Table headers={["Cadet / event", "Request", "Reason", "Status", ""]}>
        {visible.map((r) => (
          <tr key={r.requestId}>
            <td>
              {who(r)}
              <small>{events.get(r.eventId)}</small>
            </td>
            <td>{r.requestedOutcome}</td>
            <td>{r.reason}</td>
            <td>
              <Status>{r.status}</Status>
            </td>
            <td>
              {(!scoped || r.canDecide === true) && (
                <button
                  disabled={readOnly || busy}
                  onClick={() => {
                    setReason("");
                    setDecision("Approved");
                    setEdit(r);
                  }}
                >
                  Review
                </button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {!visible.length && <Empty>No requests match these filters.</Empty>}
      {edit &&
        queue.some(
          (r) =>
            r.requestId === edit.requestId && (!scoped || r.canDecide === true),
        ) && (
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
            <p>
              {who(edit)} · {events.get(edit.eventId)}
            </p>
            <blockquote>{edit.reason}</blockquote>
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
