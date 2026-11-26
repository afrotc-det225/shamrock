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
  FlightLabel,
} from "./components";
import { name, label, years, statuses, profileFields } from "./api";
import { compareCadetsForDisplay, compareLeadershipForDisplay } from "../../../packages/domain/src/cadet-display-order";
export default function People({
  snapshot, list, withFullData,
  propose,
  busy,
  leadership = false,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [query, setQuery] = useState(""),
    [flight, setFlight] = useState(""),
    [edit, setEdit] = useState(null);
  const set = (k, v) => setEdit({ ...edit, [k]: v }),
    profile = (k, v) =>
      setEdit({ ...edit, profile: { ...edit.profile, [k]: v } });
  const open = (row) => {
    if (snapshot) return openRecord(row);
    return withFullData(full => {
      const record = row && (leadership ? full.leadership.find(c=>c.contactId===row.contactId) :
        full.people.find(p=>p.personId===row.personId));
      if (row && !record) throw Error("This record changed. Reload the page.");
      openRecord(record);
    });
  };
  const openRecord = (p) => {
    if (leadership)
      setEdit({
        contactId: p?.contactId || crypto.randomUUID(),
        expectedVersion: p?.contactVersion || 0,
        personId: p?.personId || null,
        profile: p?.personId
          ? null
          : Object.fromEntries(
              [
                "firstName",
                "lastName",
                "rank",
                "role",
                "email",
                "cellPhone",
              ].map((k) => [k, p?.[k] || ""]),
            ),
        reportsTo: p?.reportsTo || "",
        officePhone: p?.officePhone || "",
        officeLocation: p?.officeLocation || "",
        active: p?.active ?? true,
      });
    else
      setEdit({
        personId: p?.personId || crypto.randomUUID(),
        expectedVersion: p?.version || 0,
        flightId: p?.flightId || null,
        profile: Object.fromEntries(
          profileFields.map((k) => [
            k,
            k === "dateOfBirth"
              ? (p?.[k] ?? null)
              : (p?.[k] ??
                {
                  asYear: "AS100",
                  flightPathStatus: "Active 3/4",
                }[k] ??
                ""),
          ]),
        ),
      });
  };
  const rows = (leadership ? s.leadership : s.people).filter(
    (p) =>
      (!flight || p.flightId === flight) &&
      `${name(p)} ${p.email} ${p.role}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  ).sort(leadership ? compareLeadershipForDisplay : compareCadetsForDisplay);
  const basic = leadership
    ? ["firstName", "lastName", "rank", "role", "email", "cellPhone"]
    : [
        "firstName",
        "lastName",
        "asYear",
        "rank",
        "role",
        "email",
        "phone",
        "flightPathStatus",
      ];
  function input(k) {
    return k === "asYear" || k === "flightPathStatus" ? (
      <Select
        key={k}
        label={label(k)}
        value={edit.profile[k]}
        onChange={(v) => profile(k, v)}
        options={k === "asYear" ? years : statuses}
      />
    ) : (
      <Field
        key={k}
        label={label(k)}
        required={["firstName", "lastName"].includes(k)}
        type={k === "email" ? "email" : k === "dateOfBirth" ? "date" : "text"}
        value={edit.profile[k] ?? ""}
        onChange={(e) =>
          profile(
            k,
            k === "dateOfBirth" && !e.target.value ? null : e.target.value,
          )
        }
      />
    );
  }
  return (
    <>
      <section className="page-controls">
        <Heading title={leadership ? "Leadership" : "Cadets"}>
          <button className="primary" disabled={readOnly} onClick={() => open()}>
            <Plus size={17} />
            {leadership ? "Add contact" : "Add cadet"}
          </button>
        </Heading>
        <div className="toolbar">
          <SearchBox
            placeholder={leadership ? "Find a leader" : "Find a cadet"}
            value={query}
            onChange={setQuery}
          />
          {!leadership && (
            <Select
              label="Flight"
              value={flight}
              onChange={setFlight}
              options={[
                { value: "", label: "All Flights" },
                ...s.flights.map((f) => ({
                  value: f.flightId,
                  label: f.label,
                })),
              ]}
            />
          )}
        </div>
      </section>
      <Table
        headers={
          leadership
            ? ["Name", "Role", "Email", "Office", ""]
            : ["Name", "AS year", "Flight", "Status", ""]
        }
      >
        {rows.map((p) => (
          <tr key={p.contactId || p.personId}>
            <td>
              <div className="person-cell">
                <span className="initials" aria-hidden="true">
                  {p.firstName?.[0]}
                  {p.lastName?.[0]}
                </span>
                <span>
                  <button className="text-button" disabled={readOnly} onClick={() => open(p)}>
                    {name(p)}
                  </button>
                  <small>{p.rank}</small>
                </span>
              </div>
            </td>
            {leadership ? (
              <>
                <td>{p.role}</td>
                <td>{p.email}</td>
                <td>{p.officeLocation || "—"}</td>
              </>
            ) : (
              <>
                <td>{p.asYear}</td>
                <td>
                  <FlightLabel>
                    {s.flights.find((f) => f.flightId === p.flightId)?.label}
                  </FlightLabel>
                </td>
                <td>
                  <Status>{p.flightPathStatus}</Status>
                </td>
              </>
            )}
            <td>
              <button
                className="icon"
                disabled={readOnly}
                aria-label={`Edit ${name(p)}`}
                onClick={() => open(p)}
              >
                <Pencil size={16} />
              </button>
            </td>
          </tr>
        ))}
      </Table>
      {!rows.length && <Empty>No records match your search.</Empty>}
      {edit && (
        <Editor
          title={leadership ? "Leadership contact" : "Cadet profile"}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            propose(
              leadership ? "leadership.upsert" : "directory.upsert",
              edit,
              () => setEdit(null),
            )
          }
          note={
            leadership
              ? "Leadership titles do not automatically grant system access."
              : ""
          }
        >
          {edit.profile ? (
            basic.map(input)
          ) : (
            <p>
              This contact is linked to a cadet. Edit their name, email and role
              in Cadets.
            </p>
          )}
          {!leadership && (
            <>
              <Select
                label="Flight"
                value={edit.flightId}
                onChange={(v) => set("flightId", v || null)}
                options={[
                  { value: "", label: "Unassigned" },
                  ...s.flights.map((f) => ({
                    value: f.flightId,
                    label: f.label,
                  })),
                ]}
              />
              <details>
                <summary>Academic, personal & photo details</summary>
                {profileFields.filter((k) => !basic.includes(k)).map(input)}
              </details>
            </>
          )}
          {leadership && (
            <>
              {["reportsTo", "officePhone", "officeLocation"].map((k) => (
                <Field
                  key={k}
                  label={label(k)}
                  value={edit[k]}
                  onChange={(e) => set(k, e.target.value)}
                />
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={edit.active}
                  onChange={(e) => set("active", e.target.checked)}
                />
                Active contact
              </label>
            </>
          )}
        </Editor>
      )}
    </>
  );
}
