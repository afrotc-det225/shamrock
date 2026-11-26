import React from "react";
import { cellStyle, flightColors } from "./roster-colors";
import { name } from "./api";

export const textOrder = (a, b) =>
  String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
export const alphabetic = (a, b) =>
  textOrder(a.lastName, b.lastName) ||
  textOrder(a.firstName, b.firstName) ||
  textOrder(a.personId, b.personId);

export function RosterTag({ value, squadron }) {
  return <span className="roster-tag" style={cellStyle(flightColors(value,squadron))}>{value || "Unassigned"}</span>;
}

// Squadron membership comes from the current flight catalog. Explicit supervisory links
// are presented separately so an assignment never implies a reporting relationship.
export function LeadershipChart({ records, roster }) {
  const roleIs = (person, title) =>
    person.role?.toLowerCase() === title.toLowerCase();
  const placed = new Set();
  function cards(matches) {
    matches.forEach((p) => placed.add(p.contactId));
    return matches.map((p) => (
      <div className="org-card" key={p.contactId}>
        <strong>{p.role || "Leadership contact"}</strong>
        <span>{[p.rank, name(p)].filter(Boolean).join(" ")}</span>
      </div>
    ));
  }
  const wing = cards(
    records.filter((p) =>
      /^(cadet wing commander|wing commander|deputy wing commander|operations group (deputy )?commander)$/i.test(
        p.role,
      ),
    ),
  );
  const branches = roster.squadrons.map((sq) => {
    const chiefs = cards(
      records.filter(
        (p) =>
          roleIs(p, sq.label + " Squadron Commander") ||
          roleIs(p, sq.label + " Deputy Squadron Commander"),
      ),
    );
    const flights = roster.flights
      .filter((f) => f.squadronId === sq.squadronId)
      .sort((a, b) => textOrder(a.label, b.label))
      .map((f) => {
        const leaders = cards(
          records.filter(
            (p) =>
              roleIs(p, f.label + " Flight Commander") ||
              roleIs(p, f.label + " Deputy Flight Commander"),
          ),
        );
        return leaders.length ? (
          <li key={f.flightId}>
            <RosterTag value={f.label} squadron={sq.label} />
            {leaders}
          </li>
        ) : null;
      })
      .filter(Boolean);
    return chiefs.length || flights.length ? (
      <section key={sq.squadronId}>
        <h3>{sq.label} Squadron</h3>
        {chiefs}
        <ul>{flights}</ul>
      </section>
    ) : null;
  });
  const other = cards(records.filter((p) => !placed.has(p.contactId)));
  const reports = records.filter((p) => p.reportsTo);
  return (
    <div className="org-layout">
      {wing.length > 0 && (
        <section>
          <h3>Wing and group leadership</h3>
          <div className="org-cards">{wing}</div>
        </section>
      )}
      <div className="org-branches">{branches}</div>
      {other.length > 0 && (
        <section>
          <h3>Other leadership and staff</h3>
          <div className="org-cards">{other}</div>
        </section>
      )}
      {reports.length > 0 && (
        <section>
          <h3>Recorded reporting lines</h3>
          <dl>
            {reports.map((p) => (
              <div key={p.contactId}>
                <dt>{p.role || name(p)}</dt>
                <dd>Reports to {p.reportsTo}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
