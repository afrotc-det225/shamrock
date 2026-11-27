import React, { useEffect, useState } from "react";
import { api, displayDate } from "./api";
import { Empty, Table } from "./components";
import { attendanceMeanings } from "./AttendanceMatrix";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";

function RollCall() {
  const [board, setBoard] = useState(null),
    [error, setError] = useState(""),
    [selected, select] = useState(""),
    [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const data = await api("/cadet?section="+encodeURIComponent(selected ? "flight:"+selected : "flight"), undefined, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setBoard({...data,selection:selected});
        setError("");
        if (data.refreshAt)
          timer = setTimeout(
            () => refresh((n) => n + 1),
            Math.min(
              2147483647,
              Math.max(
                1000,
                Date.parse(data.refreshAt) - Date.parse(data.asOf) + 100,
              ),
            ),
          );
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e.message);
        }
      }
    }
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision, selected]);
  return (
    <section className="flight-roll">
      <header>
        <h2>Flight attendance</h2>
      </header>
      {!!board?.eventsForFlight?.length && <select className="flight-event-select" aria-label="Flight attendance event"
        value={selected} onChange={e=>select(e.target.value)}>
        <option value="">{!selected && board.flightEvent ? board.flightEvent.label+" (automatic)" : "Follow current event"}</option>
        {board.eventsForFlight.map(e=><option key={e.eventId} value={e.eventId}>{e.label}</option>)}
      </select>}
      {error ? (
        <p role="alert">{error}</p>
      ) : !board ? (
        <p role="status">Loading attendance…</p>
      ) : board.selection !== selected ? (
        <p role="status">Loading attendance…</p>
      ) : !board.flightEvent ? (
        <Empty>No scheduled Flight events remain this semester.</Empty>
      ) : (
        <>
          {!board.eventsForFlight && <h3>{board.flightEvent.label}</h3>}
          <p>
            {Date.parse(board.flightEvent.startAt) > Date.parse(board.asOf)
              ? "Up next"
              : Date.parse(board.flightEvent.endAt ?? board.flightEvent.startAt) <= Date.parse(board.asOf) ? "Completed" : "In progress"}{" "}
            ·{" "}
            <time dateTime={board.flightEvent.startAt}>
              {displayDate(board.flightEvent.startAt)}
            </time>
          </p>
          {board.members.length ? (
            <Table headers={["Cadet", "Attendance"]}>
              {[...board.members].sort(compareCadetsForDisplay).map((m) => (
                <tr key={m.personId}>
                  <td>
                    {m.lastName}, {m.firstName}
                  </td>
                  <td className="personal-mark" data-mark={m.code || ""}>
                    {attendanceMeanings[m.code] || "Unmarked"}
                    {m.needsReview && " · Needs review"}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No eligible Flight members for this event.</Empty>
          )}
        </>
      )}
    </section>
  );
}

export function FlightHome({children}) {
  return <><RollCall />{children}</>;
}
