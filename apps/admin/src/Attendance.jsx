import React, { useState } from "react";
import { Heading, Select, Field, Editor, Empty, SearchBox } from "./components";
import { AttendanceMatrix, AttendanceKey } from "./AttendanceMatrix";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";
import { alphabetic, textOrder } from "./RosterViews";
import { name, eventTypes } from "./api";
export default function Attendance({
  snapshot,
  list,
  reporting,
  propose,
  busy,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [eventType, setEventType] = useState(""),
    [week, setWeek] = useState(""),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("seniority"),
    [flight, setFlight] = useState(""),
    [edit, setEdit] = useState(null),
    [reason, setReason] = useState(""),
    [code, setCode] = useState("P");
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  const canCorrect = (p) =>
    !scoped ||
    s.access.capabilities.attendanceCorrectionFlightIds.includes(p.flightId);
  const termId = s.terms.find((t) => t.isCurrent)?.termId;
  const matrix = reporting?.matrices.find((m) => m.termId === termId);
  const catalog = new Map(s.events.map((e) => [e.eventId, e]));
  const events = (matrix?.eventColumns || [])
    .map((e) => catalog.get(e.eventId))
    .filter(Boolean);
  const weeks = [
    ...new Set(events.map((e) => e.trainingWeek).filter((w) => w != null)),
  ].sort((a, b) => a - b);
  const columns = events.filter(
    (e) =>
      (!eventType || e.eventType === eventType) &&
      (!week || String(e.trainingWeek) === week),
  );
  const search = (text) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  const rows = (matrix?.rows || [])
    .filter((p) => (!flight || p.flightId === flight) && search(name(p)))
    .sort((a, b) => {
      if (sort === "name") return alphabetic(a, b);
      if (sort === "overall")
        return (
          (a.overall.noCountedAttendance ? Infinity : a.overall.percentage) -
            (b.overall.noCountedAttendance ? Infinity : b.overall.percentage) ||
          alphabetic(a, b)
        );
      if (sort === "flight")
        return textOrder(a.flight, b.flight) || compareCadetsForDisplay(a, b);
      return compareCadetsForDisplay(a, b);
    });
  const correction = (person, event, currentCode) => {
    setReason("");
    setCode(currentCode);
    const base = s.attendanceVersions.find(
      (v) => v.personId === person.personId && v.eventId === event.eventId,
    );
    setEdit({ person, event, baseVersion: base?.version || 0 });
  };
  return (
    <>
      <section className="page-controls">
        <Heading title="Attendance">
          <div className="heading-tools">
            <AttendanceKey />
          </div>
        </Heading>
        <div className="toolbar">
          <SearchBox
            placeholder="Find a cadet"
            value={query}
            onChange={setQuery}
          />
          <Select
            label="Event type"
            value={eventType}
            onChange={setEventType}
            options={[
              { value: "", label: "All events" },
              ...Object.entries(eventTypes).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <Select
            label="Training week"
            value={week}
            onChange={setWeek}
            options={[
              { value: "", label: "All weeks" },
              ...weeks.map((w) => ({ value: String(w), label: "TW-" + w })),
            ]}
          />
          <Select
            label="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: "seniority", label: "AS year, then name" },
              { value: "name", label: "Last name" },
              { value: "flight", label: "Flight" },
              { value: "overall", label: "Lowest overall" },
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
      <AttendanceMatrix
        rows={rows}
        events={columns}
        canCorrect={canCorrect}
        onEdit={correction}
        readOnly={readOnly || busy}
      />
      {(!rows.length || !columns.length) && (
        <Empty>No attendance matches these filters.</Empty>
      )}
      {edit && events.some((e) => e.eventId === edit.event.eventId) && (
        <Editor
          title="Correct attendance"
          bottomSheet
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            propose(
              "attendance.correct",
              {
                personId: edit.person.personId,
                eventId: edit.event.eventId,
                expectedBaseVersion: edit.baseVersion,
                expectedEventVersion: edit.event.version,
                code: code || null,
                reason,
              },
              () => setEdit(null),
            )
          }
        >
          <p>
            {name(edit.person)} · {edit.event.label}
          </p>
          <Select
            label="Attendance code"
            value={code}
            onChange={setCode}
            options={[
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
            ]}
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
