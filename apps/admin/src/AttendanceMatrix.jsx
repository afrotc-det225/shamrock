import React, { useRef } from "react";
import { AttendanceRate } from "./components";
import { RosterTag } from "./RosterViews";

const meanings = {
  P: "Present",
  T: "Tardy",
  A: "Absent, unresolved",
  R: "Request pending",
  D: "Request denied, attendance required",
  U: "Unexcused absence",
  E: "Excused",
  ES: "Excused for sport",
  MED: "Medical",
  "N/A": "Not applicable",
};
export function AttendanceKey() {
  return (
    <details className="code-key">
      <summary>Attendance code key</summary>
      <dl>
        {Object.entries(meanings).map(([code, meaning]) => (
          <div key={code}>
            <dt data-mark={code}>{code}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function moveFocus(e) {
  const direction = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
  }[e.key];
  if (!direction || !e.target.matches("button[data-event]")) return;
  e.preventDefault();
  const cell = e.target.closest("td"),
    row = cell.parentElement,
    rows = row.parentElement.rows;
  let r = row.sectionRowIndex,
    c = cell.cellIndex;
  while (true) {
    r += direction[0];
    c += direction[1];
    if (r < 0 || r >= rows.length || c < 4 || c >= rows[r].cells.length) return;
    const next = rows[r].cells[c].querySelector("button");
    if (next) {
      next.focus();
      return;
    }
  }
}
export function AttendanceMatrix({
  rows,
  events,
  canCorrect,
  onEdit,
  readOnly,
}) {
  const focused = useRef(null);
  let first = true;
  return (
    <div
      className="matrix-scroll"
      tabIndex={0}
      aria-label="Scrollable attendance matrix"
    >
      <table className="attendance-matrix" onKeyDown={moveFocus}>
        <caption>
          {rows.length} cadets · {events.length} events
          {!readOnly &&
            " · Select an eligible attendance cell to review or change it."}
        </caption>
        <thead>
          <tr>
            {["Cadet", "Flight", "Overall", "LLAB"].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
            {events.map((e) => (
              <th scope="col" key={e.eventId} title={e.label}>
                {e.columnLabel || e.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const byEvent = new Map(row.cells.map((c) => [c.eventId, c]));
            return (
              <tr key={row.personId}>
                <th scope="row">
                  {row.lastName}, {row.firstName}
                </th>
                <td>
                  <RosterTag value={row.flight} squadron={row.squadron} />
                </td>
                <td>
                  <AttendanceRate value={row.overall} />
                </td>
                <td>
                  <AttendanceRate value={row.llab} />
                </td>
                {events.map((e) => {
                  const c = byEvent.get(e.eventId),
                    editable =
                      !readOnly && c?.eligible === true && canCorrect(row);
                  const code = c?.effectiveCode || "",
                    label =
                      code ||
                      (c?.eligible === true
                        ? "Blank"
                        : c?.eligible === false
                          ? "Not eligible"
                          : "Eligibility unknown");
                  const description = [
                    row.firstName + " " + row.lastName,
                    e.label,
                    meanings[code] ? code + " · " + meanings[code] : label,
                    c?.needsReview ? "Needs review" : "",
                  ]
                    .filter(Boolean)
                    .join(", ");
                  const content = (
                    <>
                      {code || (c?.eligible === true ? "·" : "—")}
                      {c?.needsReview && <sup aria-label="Needs review">!</sup>}
                    </>
                  );
                  const tabStop = first && editable;
                  if (editable) first = false;
                  return (
                    <td
                      key={e.eventId}
                      className="mark-cell"
                      data-mark={
                        code || (c?.eligible === true ? "blank" : "excluded")
                      }
                      title={description}
                    >
                      {editable ? (
                        <button
                          type="button"
                          data-event={e.eventId}
                          tabIndex={tabStop ? 0 : -1}
                          aria-label={description}
                          onFocus={(ev) => {
                            if (focused.current?.isConnected)
                              focused.current.tabIndex = -1;
                            ev.currentTarget.tabIndex = 0;
                            focused.current = ev.currentTarget;
                          }}
                          onClick={() => onEdit(row, e, code)}
                        >
                          {content}
                        </button>
                      ) : (
                        <span aria-label={description}>{content}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
