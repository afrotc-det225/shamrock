import React, { useState } from "react";
import {
  Heading,
  Select,
  Field,
  Editor,
  Table,
  Status,
  Empty,
  FlightLabel,
  AttendanceRate,
} from "./components";
import { name } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";
export default function Attendance({ snapshot: s, reporting, propose, busy, readOnly = false }) {
  const [tab, setTab] = useState("attendance"),
    [selectedEvent, setEvent] = useState(""),
    [flight, setFlight] = useState(""),
    [edit, setEdit] = useState(null),
    [reason, setReason] = useState(""),
    [code, setCode] = useState("P");
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  const canCorrect = (p) =>
    !scoped ||
    s.access.capabilities.attendanceCorrectionFlightIds.includes(p.flightId);
  const reported = new Set(reporting?.matrices.flatMap(m => m.eventColumns.map(e => e.eventId)));
  const events = s.events.filter(e => reported.has(e.eventId));
  const event = events.some(e => e.eventId === selectedEvent) ? selectedEvent : events[0]?.eventId || "";
  const queue = currentExcusalRequests(s);
  const requests = queue.filter(r => !flight || r.flightId === flight);
  const matrix = reporting?.matrices?.find(
    (m) => m.termId === s.events.find((e) => e.eventId === event)?.termId,
  );
  const correction = (p) => {
    setReason("");
    setCode(
      matrix?.rows
        .find((r) => r.personId === p.personId)
        ?.cells.find((c) => c.eventId === event)?.effectiveCode || "P",
    );
    setEdit({ person: p, event: s.events.find((e) => e.eventId === event) });
  };
  return (
    <>
      <section className="page-controls">
        <Heading title="Attendance & excusals" />
        <div className="tabs">
          <button
            aria-pressed={tab === "attendance"}
            onClick={() => setTab("attendance")}
          >
            Attendance
          </button>
          <button
            aria-pressed={tab === "excusals"}
            onClick={() => setTab("excusals")}
          >
            Excusals (
            {queue.filter((r) => r.status === "Submitted").length} pending)
          </button>
        </div>
        <div className="toolbar">
          {tab === "attendance" && (
            <Select
              label="Event"
              value={event}
              onChange={setEvent}
              options={events.map((e) => ({
                value: e.eventId,
                label: e.label,
              }))}
            />
          )}
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
      {tab === "attendance" ? (
        <Table
          headers={["Cadet", "Flight", "Attendance", "Overall", "LLAB", ""]}
        >
          {s.people
            .filter(
              (p) =>
                (!flight || p.flightId === flight) &&
                s.events
                  .find((e) => e.eventId === event)
                  ?.eligiblePersonIds?.includes(p.personId),
            )
            .map((p) => {
              const row = matrix?.rows.find((r) => r.personId === p.personId),
                cell = row?.cells.find((c) => c.eventId === event);
              return (
                <tr key={p.personId}>
                  <td>{name(p)}</td>
                  <td>
                    <FlightLabel>
                      {s.flights.find((f) => f.flightId === p.flightId)?.label}
                    </FlightLabel>
                  </td>
                  <td>
                    <Status>{cell?.effectiveCode || "Blank"}</Status>
                    {cell?.needsReview && (
                      <small className="review-needed">Needs review</small>
                    )}
                  </td>
                  <td>
                    <AttendanceRate value={row?.overall} />
                  </td>
                  <td>
                    <AttendanceRate value={row?.llab} />
                  </td>
                  <td>
                    {canCorrect(p) && (
                      <button disabled={readOnly} onClick={() => correction(p)}>Correct</button>
                    )}
                  </td>
                </tr>
              );
            })}
        </Table>
      ) : (
        <Table headers={["Cadet / event", "Request", "Reason", "Status", ""]}>
          {requests.map((r) => (
            <tr key={r.requestId}>
              <td>
                {r.personDisplayName ||
                  name(s.people.find((p) => p.personId === r.personId))}
                <small>
                  {s.events.find((e) => e.eventId === r.eventId)?.label}
                </small>
              </td>
              <td>{r.requestedOutcome}</td>
              <td>{r.reason}</td>
              <td>
                <Status>{r.status}</Status>
              </td>
              <td>
                {(!scoped || r.canDecide === true) && (
                  <button
                    disabled={readOnly}
                    onClick={() => {
                      setReason("");
                      setCode("Approved");
                      setEdit({ request: r });
                    }}
                  >
                    Review
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {edit && (edit.request ? queue.some(r => r.requestId === edit.request.requestId) : reported.has(edit.event.eventId)) && (
        <Editor
          title={edit.request ? "Review excusal" : "Correct attendance"}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            propose(
              edit.request ? "excusal.decide" : "attendance.correct",
              edit.request
                ? {
                    requestId: edit.request.requestId,
                    expectedVersion: edit.request.version,
                    decision: code,
                    reason,
                  }
                : {
                    personId: edit.person.personId,
                    eventId: edit.event.eventId,
                    expectedBaseVersion:
                      s.attendanceVersions.find(
                        (v) =>
                          v.personId === edit.person.personId &&
                          v.eventId === edit.event.eventId,
                      )?.version || 0,
                    expectedEventVersion: edit.event.version,
                    code: code || null,
                    reason,
                  },
              () => setEdit(null),
            )
          }
        >
          <p>
            {edit.request
              ? edit.request.personDisplayName ||
                name(s.people.find((p) => p.personId === edit.request.personId))
              : name(edit.person)}{" "}
            ·{" "}
            {edit.request
              ? s.events.find((e) => e.eventId === edit.request.eventId)?.label
              : edit.event.label}
          </p>
          {edit.request && <blockquote>{edit.request.reason}</blockquote>}
          <Select
            label={edit.request ? "Decision" : "Attendance code"}
            value={code}
            onChange={setCode}
            options={
              edit.request
                ? ["Approved", "Denied", "Withdrawn", "Superseded"]
                : [
                    { value: "", label: "Clear to blank" },
                    "P",
                    "T",
                    "A",
                    "U",
                    "E",
                    "ES",
                    "MED",
                    "R",
                    "D",
                    "N/A",
                  ]
            }
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
