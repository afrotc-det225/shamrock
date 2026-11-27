import { ToolbarFilters } from "./ToolbarFilters";
import React, { useState } from "react";
import { CalendarClock, Plus, Pencil } from "lucide-react";
import {
  Heading,
  Field,
  Select,
  SearchBox,
  Editor,
  Table,
  Status,
  Empty,
} from "./components";
import { eventTypes, displayDate, name } from "./api";
import { toEastern, fromEastern, zoneLabel } from "./time";
import { eventEditorData } from "./browse";
import { api } from "./api";
import BulkSchedule from "./BulkSchedule";
export default function Events({ snapshot, eventsList, propose, busy, refresh, readOnly = false, run }) {
  const [details,setDetails] = useState(null), [loading,setLoading] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState("default"),
    [type, setType] = useState(""),
    [term, setTerm] = useState((snapshot || eventsList).terms.find((t) => t.isCurrent)?.termId || ""),
    [edit, setEdit] = useState(null);
  const s = snapshot || ((bulk || edit) && details) || eventsList;
  const set = (key, value) => setEdit({ ...edit, [key]: value });
  const [timeError, setTimeError] = useState("");
  const setTime = (key, value) => {
    try {
      set(key, fromEastern(value));
      setTimeError("");
    } catch (e) {
      setTimeError(e.message);
    }
  };
  const openFrom = (source, e) =>
    setEdit(
      e
        ? {
            ...Object.fromEntries(
              [
                "eventId",
                "termId",
                "eventType",
                "trainingWeek",
                "displayOrder",
                "label",
                "columnLabel",
                "expectedGroup",
                "status",
                "startAt",
                "endAt",
                "location",
                "notes",
                "eligiblePersonIds",
              ].map((k) => [k, e[k]]),
            ),
            expectedVersion: e.version,
            flightIds: source.eventFlights
              .filter((f) => f.eventId === e.eventId)
              .map((f) => f.flightId),
          }
        : {
            eventId: crypto.randomUUID(),
            expectedVersion: 0,
            termId: term,
            eventType: "other",
            trainingWeek: null,
            displayOrder: source.events.length,
            label: "",
            columnLabel: "",
            expectedGroup: "",
            flightIds: [],
            eligiblePersonIds: [],
            status: "active",
            startAt: null,
            endAt: null,
            location: "",
            notes: "",
          },
    );
  const withEditor = (callback, recordId) => snapshot ? callback(snapshot) : run(async () => {
    setLoading(true);
    try {
      const source=eventEditorData(await api("/events/editor"+(recordId ? "?id="+encodeURIComponent(recordId) : "")));
      setDetails(source); callback(source);
    } finally {setLoading(false);}
  });
  const open = (event) => withEditor(source => {
    const current = event ? source.events.find(value => value.eventId === event.eventId) : null;
    if (event && !current) throw new Error("This event is no longer available. Reload the list.");
    openFrom(source, current);
  }, event?.eventId || crypto.randomUUID());
  const rows = s.events
    .filter(
      (e) =>
        (!term || e.termId === term) &&
        (!type || e.eventType === type) &&
        `${e.label} ${e.notes}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      if (sort === "type") {
        const byType = (eventTypes[a.eventType] || a.eventType).localeCompare(eventTypes[b.eventType] || b.eventType);
        if (byType) return byType;
      }
      return a.displayOrder - b.displayOrder;
    });
  return (
    <>
      <section className="page-controls">
        <Heading title="Events" />
        <div className="toolbar event-toolbar">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Find an event"
          />
          <ToolbarFilters active={Boolean(type || sort !== "default" || term !== (s.terms.find(t=>t.isCurrent)?.termId || ""))}>
            <Select
              label="Semester"
              value={term}
              onChange={setTerm}
              options={[
                { value: "", label: "All semesters" },
                ...s.terms.map((t) => ({ value: t.termId, label: t.label })),
              ]}
            />
            <Select
              label="Type"
              value={type}
              onChange={setType}
              options={[
                { value: "", label: "All types" },
                ...Object.entries(eventTypes).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
            />
            <Select label="Sort by" value={sort} onChange={setSort}
              options={[{value:"default", label:"Default"}, {value:"type", label:"Type"}]} />
          </ToolbarFilters>
          <div className="toolbar-actions">
            <button aria-label="Change schedule" title="Change schedule" disabled={readOnly || !term || busy} onClick={() => withEditor(() => setBulk(true))}>
              <CalendarClock className="phone-action-icon" size={18} aria-hidden="true" />
              <span>Change schedule</span>
            </button>
            <button className="primary" aria-label="Add event" title="Add event" disabled={readOnly || busy} onClick={() => open()}>
              <Plus size={17} />
              <span>Add event</span>
            </button>
          </div>
        </div>
      </section>
      {loading && <span className="page-transfer" role="status">Loading event details…</span>}
      <Table className="event-schedule" headers={["Event", "Date & time", "Status", ""]}>
        {rows.map((e) => (
          <tr key={e.eventId}>
            <td>
              <button className="text-button" disabled={readOnly || busy} onClick={() => open(e)}>
                {e.label}
              </button>
              {e.location && <small>{e.location}</small>}
              <div className="compact-event-status"><Status>{e.status}</Status></div>
            </td>
            <td>{e.startAt ? <time dateTime={e.startAt}>{displayDate(e.startAt,e.timeZone)}</time> : "Not scheduled"}</td>
            <td>
              <Status>{e.status}</Status>
            </td>
            <td>
              <button
                className="icon"
                disabled={readOnly || busy}
                aria-label={`Edit ${e.label}`}
                onClick={() => open(e)}
              >
                <Pencil size={16} />
              </button>
            </td>
          </tr>
        ))}
      </Table>
      {!rows.length && <Empty>No events match these filters.</Empty>}
      {bulk && (
        <BulkSchedule
          snapshot={s}
          term={term}
          onClose={() => setBulk(false)}
          onSaved={() => refresh(true)}
        />
      )}
      {edit && (
        <Editor
          title={edit.expectedVersion ? "Edit event" : "Add event"}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            !timeError && propose("event.upsert", edit, () => setEdit(null), s)
          }
        >
          <Field
            label="Event name"
            required
            value={edit.label}
            onChange={(e) => set("label", e.target.value)}
          />
          <Field
            label="Attendance header"
            required
            maxLength={80}
            value={edit.columnLabel}
            onChange={(e) => set("columnLabel", e.target.value)}
          />
          <Select
            label="Type"
            value={edit.eventType}
            onChange={(v) => set("eventType", v)}
            options={Object.entries(eventTypes).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Field
            label={`Starts (${zoneLabel(edit.startAt)})`}
            type="datetime-local"
            value={toEastern(edit.startAt)}
            onChange={(e) => setTime("startAt", e.target.value)}
          />
          <Field
            label={`Ends (${zoneLabel(edit.endAt)})`}
            type="datetime-local"
            value={toEastern(edit.endAt)}
            onChange={(e) => setTime("endAt", e.target.value)}
          />
          {timeError && (
            <p role="alert" className="error">
              {timeError}
            </p>
          )}
          <Select
            label="Status"
            value={edit.status}
            onChange={(v) => set("status", v)}
            options={["active", "cancelled", "inactive", "archived"]}
          />
          <Field
            label="Location"
            value={edit.location}
            onChange={(e) => set("location", e.target.value)}
          />
          <details>
            <summary>Attendance roster & schedule details</summary>
            <Select
              label="Semester"
              disabled={edit.expectedVersion > 0}
              value={edit.termId}
              onChange={(v) => set("termId", v)}
              options={s.terms.map((t) => ({
                value: t.termId,
                label: t.label,
              }))}
            />
            <Field
              label="Expected attendees"
              value={edit.expectedGroup}
              onChange={(e) => set("expectedGroup", e.target.value)}
            />
            <Field
              label="Training week"
              type="number"
              min="1"
              max="99"
              value={edit.trainingWeek ?? ""}
              onChange={(e) =>
                set(
                  "trainingWeek",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
            />
            <Field
              label="Display order"
              type="number"
              min="0"
              value={edit.displayOrder}
              onChange={(e) => set("displayOrder", Number(e.target.value))}
            />
            <fieldset>
              <legend>Flights</legend>
              {s.flights.map((f) => (
                <label className="check" key={f.flightId}>
                  <input
                    type="checkbox"
                    checked={edit.flightIds.includes(f.flightId)}
                    onChange={(e) =>
                      set(
                        "flightIds",
                        e.target.checked
                          ? [...edit.flightIds, f.flightId]
                          : edit.flightIds.filter((v) => v !== f.flightId),
                      )
                    }
                  />
                  {f.label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Expected cadets</legend>
              {edit.eligiblePersonIds === null ? (
                <p>
                  Historical eligibility is unknown. This event cannot be edited
                  here until its roster is reviewed.
                </p>
              ) : (
                s.people.map((p) => (
                  <label className="check" key={p.personId}>
                    <input
                      type="checkbox"
                      checked={edit.eligiblePersonIds.includes(p.personId)}
                      onChange={(e) =>
                        set(
                          "eligiblePersonIds",
                          e.target.checked
                            ? [...edit.eligiblePersonIds, p.personId]
                            : edit.eligiblePersonIds.filter(
                                (v) => v !== p.personId,
                              ),
                        )
                      }
                    />
                    {name(p)}
                  </label>
                ))
              )}
            </fieldset>
          </details>
        </Editor>
      )}
    </>
  );
}
