import React, { useRef } from "react";
import { List } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { cellStyle, flightColors, rateGradient, rateStyle } from "./roster-colors";

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
const rateLabels = ["80% or below", "85%", "90%", "95%", "100%"];
export function AttendanceRateKey() {
  return (
    <div className="attendance-rate-key" aria-label="Overall and LLAB attendance scale">
      <span>Overall and LLAB</span>
      <div className="attendance-rate-bar" style={{ background: rateGradient }} aria-hidden="true" />
      <div className="attendance-rate-ticks">
        {rateLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}
export function AttendanceKey() {
  return (
    <ToolbarPopover
      label="Attendance code key"
      shortLabel="Code key"
      icon={List}
    >
      <dl className="code-key">
        {Object.entries(meanings).map(([code, meaning]) => (
          <div key={code}>
            <dt data-mark={code}>{code}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </ToolbarPopover>
  );
}

function eventHeading(event) {
  const label = (event.columnLabel || event.label).trim();
  if (
    event.trainingWeek != null &&
    /^(mando|secondary|llab)$/.test(event.eventType) &&
    /TW[ -]?\d/i.test(label)
  )
    return [
      "TW-" + event.trainingWeek,
      { llab: "LLAB", secondary: "Secondary", mando: "Mando" }[event.eventType],
    ];
  const words = label.split(/\s+/);
  let cut = 1;
  for (let i = 2; i < words.length; i++)
    if (
      Math.abs(words.slice(0, i).join(" ").length - label.length / 2) <
      Math.abs(words.slice(0, cut).join(" ").length - label.length / 2)
    )
      cut = i;
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
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
      <table
        className="attendance-matrix"
        aria-label="Attendance"
        style={{ width: 356 + 68 * events.length }}
        onKeyDown={moveFocus}
      >
        <colgroup>
          <col style={{ width: 152 }} />
          <col style={{ width: 74 }} />
          <col span="2" style={{ width: 65 }} />
          {events.length > 0 && (
            <col span={events.length} style={{ width: 68 }} />
          )}
        </colgroup>
        <thead>
          <tr>
            {["Cadet", "Flight", "Overall", "LLAB"].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
            {events.map((e) => (
              <th scope="col" key={e.eventId} title={e.label}>
                {eventHeading(e).map((line, i) => (
                  <span className="event-line" key={i}>
                    {line}
                  </span>
                ))}
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
                <td
                  className="formation"
                  style={cellStyle(flightColors(row.flight, row.squadron))}
                >
                  {row.flight || "—"}
                </td>
                {[row.overall, row.llab].map((r, i) => {
                  const v = r?.noCountedAttendance ? null : r?.percentage;
                  return (
                    <td key={i} className="matrix-percent" style={rateStyle(v)}>
                      {Number.isFinite(v) ? (100 * v).toFixed(1) + "%" : "—"}
                    </td>
                  );
                })}
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
                  const content = code || (c?.eligible === true ? "·" : "—");
                  const tabStop = first && editable;
                  if (editable) first = false;
                  return (
                    <td
                      key={e.eventId}
                      className="mark-cell"
                      data-mark={
                        code || (c?.eligible === true ? "blank" : "excluded")
                      }
                      data-review={c?.needsReview ? "true" : undefined}
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
