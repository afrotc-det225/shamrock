import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, displayDate } from "./api";
import { Empty, Field, Table } from "./components";
import { attendanceMeanings } from "./AttendanceMatrix";
import { flightRoleOptions } from "../../../packages/domain/src/flight-roles";
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

function FlightRoles({ state, save, disabled }) {
  const flight = state.flights.find(
    (f) => f.flightId === state.profile.flightId,
  );
  const roles = flightRoleOptions(flight.label);
  const [person, setPerson] = useState(""),
    [role, setRole] = useState("");
  const editable = state.roster.filter(
    (r) => !r.role || roles.includes(r.role),
  );
  const target = editable.find((r) => r.personId === person);
  return (
    <section>
      <h2>Flight roles</h2>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (target)
            save(
              "flightRole",
              { personId: person, version: target.version, role },
              () => {
                setPerson("");
                setRole("");
              },
            );
        }}
      >
        <Field label="Cadet">
          <select
            aria-label="Cadet"
            required
            value={person}
            onChange={(e) => {
              setPerson(e.target.value);
              setRole(
                editable.find((r) => r.personId === e.target.value)?.role || "",
              );
            }}
          >
            <option value="">Choose a cadet</option>
            {editable.map((r) => (
              <option key={r.personId} value={r.personId}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {target && (
          <Field label="Flight role">
            <select aria-label="Flight role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Unassigned</option>
              {roles.map((title) => (
                <option key={title}>{title}</option>
              ))}
            </select>
          </Field>
        )}
        <button
          className="primary"
          disabled={disabled || !target || role === (target?.role || "")}
        >
          Save role
        </button>
      </form>
      <Table headers={["Cadet", "Directory role"]}>
        {state.roster.map((r) => (
          <tr key={r.personId}>
            <td>{r.name}</td>
            <td>{r.role || "Unassigned"}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

export function FlightHome({ state, save, disabled, children }) {
  const [view, setView] = useState("attendance");
  return (
    <>
      <div className="flight-sections" role="group" aria-label="My Flight">
        {[
          ["attendance", "Attendance"],
          ["roles", "Flight roles"],
        ].map(([key, text]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {text}
          </button>
        ))}
      </div>
      {view === "roles" ? (
        <FlightRoles {...{ state, save, disabled }} />
      ) : (
        <>
          <RollCall />
          {children}
        </>
      )}
    </>
  );
}
