import React, { useState } from "react";
import { Plus, Pencil } from "lucide-react";
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
import { toEastern, fromEastern } from "./time";
export default function Events({ snapshot: s, propose, busy }) {
  const [query, setQuery] = useState(""),
    [type, setType] = useState(""),
    [term, setTerm] = useState(s.terms.find((t) => t.isCurrent)?.termId || ""),
    [edit, setEdit] = useState(null);
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
  const open = (e) =>
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
            flightIds: s.eventFlights
              .filter((f) => f.eventId === e.eventId)
              .map((f) => f.flightId),
          }
        : {
            eventId: crypto.randomUUID(),
            expectedVersion: 0,
            termId: term,
            eventType: "other",
            trainingWeek: null,
            displayOrder: s.events.length,
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
  const rows = s.events
    .filter(
      (e) =>
        (!term || e.termId === term) &&
        (!type || e.eventType === type) &&
        `${e.label} ${e.notes}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <>
      <Heading
        title="Events"
        description="Manage the schedule. Keep attendance connected."
      >
        <button className="primary" onClick={() => open()}>
          <Plus size={17} />
          Add event
        </button>
      </Heading>
      <div className="toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Find an event"
        />
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
      </div>
      <Table headers={["Event", "Type", "Date & time · Eastern", "Status", ""]}>
        {rows.map((e) => (
          <tr key={e.eventId}>
            <td>
              <button className="text-button" onClick={() => open(e)}>
                {e.label}
              </button>
              <small>{e.location}</small>
            </td>
            <td>{eventTypes[e.eventType] || e.eventType}</td>
            <td>{displayDate(e.startAt)}</td>
            <td>
              <Status>{e.status}</Status>
            </td>
            <td>
              <button
                className="icon"
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
      <p className="footnote">
        Changes update attendance views and Form choices.
      </p>
      {edit && (
        <Editor
          title={edit.expectedVersion ? "Edit event" : "Add event"}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            !timeError && propose("event.upsert", edit, () => setEdit(null))
          }
          note="Existing attendance and excusals stay linked."
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
            label="Starts (Eastern time)"
            type="datetime-local"
            value={toEastern(edit.startAt)}
            onChange={(e) => setTime("startAt", e.target.value)}
          />
          <Field
            label="Ends (Eastern time)"
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
          <Field label="Notes">
            <textarea
              value={edit.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
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
