import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, displayDate } from "./api";
import { Empty, Table } from "./components";
import { attendanceMeanings } from "./AttendanceMatrix";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";

function RollCall() {
  const [board, setBoard] = useState(null),
    [error, setError] = useState(""),
    [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const data = await api("/cadet?section=flight", undefined, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setBoard(data);
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
          setBoard(null);
          setError(e.message);
        }
      }
    }
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision]);
  return (
    <section className="flight-roll">
      <header>
        <h2>Flight attendance</h2>
        <button
          type="button"
          aria-label="Refresh Flight attendance"
          onClick={() => refresh((n) => n + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !board ? (
        <p role="status">Loading attendance…</p>
      ) : !board.flightEvent ? (
        <Empty>No scheduled Flight events remain this semester.</Empty>
      ) : (
        <>
          <h3>{board.flightEvent.label}</h3>
          <p>
            {Date.parse(board.flightEvent.startAt) > Date.parse(board.asOf)
              ? "Up next"
              : "In progress"}{" "}
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
