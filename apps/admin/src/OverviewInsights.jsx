import React, { useEffect, useState } from "react";
import { api } from "./api";
import BirthdayAgenda from "./BirthdayAgenda";
import { WingCharts, percent, archivedComparisons } from "./WingCharts";

function AttendanceSummary({ dashboard: d, previous, total }) {
  return (
    <section
      className="insight attendance-summary"
      aria-labelledby="wing-attendance"
    >
      <h3 id="wing-attendance">Wing attendance</h3>
      <table className="attendance-comparison">
        <thead>
          <tr>
            <th scope="col">Average</th>
            <th scope="col">This semester</th>
            {previous && <th scope="col">vs. {previous.label}</th>}
          </tr>
        </thead>
        <tbody>
          {[
            ["Overall", d.averageOverall, previous?.overall],
            ["LLAB", d.averageLlab, previous?.llab],
          ].map(([label, current, prior]) => {
            const change =
              Number.isFinite(prior) && Number.isFinite(current)
                ? Math.round((current - prior) * 1000) / 10
                : null;
            return (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{percent(current)}</td>
                {previous && (
                  <td>
                    <span
                      className="comparison-change"
                      data-direction={Math.sign(change || 0)}
                      title={
                        change == null
                          ? undefined
                          : change + " percentage points"
                      }
                      aria-label={
                        change == null
                          ? "No comparison"
                          : change + " percentage points"
                      }
                    >
                      {change == null
                        ? "—"
                        : (change > 0 ? "+" : "") + change.toFixed(1) + " pp"}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="attendance-threshold">
        <strong>
          {d.belowEighty}
          {Number.isInteger(total) ? " of " + total : ""}
        </strong>{" "}
        cadets below 80% overall
      </p>
      {d.noCountedAttendanceCadets > 0 && (
        <p className="coverage">
          {d.noCountedAttendanceCadets} with no counted attendance
        </p>
      )}
      <small className="attendance-cohorts">
        {d.gmcCadets} GMC · {d.pocCadets} POC
      </small>
    </section>
  );
}

export default function OverviewInsights({
  overview,
  snapshot,
  reporting,
  birthdayCalendar,
  birthdayFlights,
  birthdaySquadrons,
  reportingTime,
  captureKey,
  manifest,
  viewAsRevision,
  meta,
}) {
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const revision = JSON.stringify(manifest?.revision);
  const context = JSON.stringify([captureKey, viewAsRevision, revision]);
  useEffect(() => {
    if (!overview && !meta?.hosted) return;
    const controller = new AbortController();
    setLoaded(null);
    setError("");
    api("/wing-charts", undefined, {
      signal: controller.signal,
    })
      .then((data) => {
        if (
          data.captureKey !== captureKey ||
          data.viewAsRevision !== viewAsRevision ||
          JSON.stringify(data.revision) !== revision
        )
          throw Error("The roster or your access changed. Refresh Overview.");
        setLoaded({
          context,
          dashboard: data.dashboard,
          history: data.history,
          awaitingHistory: data.awaitingHistory,
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [
    meta?.hosted,
    !!overview,
    captureKey,
    viewAsRevision,
    revision,
    retry,
    context,
  ]);
  const compiled = loaded?.context === context ? loaded : null;
  const d =
    overview || meta?.hosted ? compiled?.dashboard : reporting?.dashboard;
  const term =
    overview?.term || snapshot?.terms.find((t) => t.isCurrent)?.label;
  const flights = birthdayFlights || snapshot?.flights || [],
    squadrons = birthdaySquadrons || snapshot?.squadrons || [];
  const calendar =
    birthdayCalendar ||
    reporting?.dashboard.birthdays.map((b) => [
      b.firstName,
      b.lastName,
      b.dateOfBirth.slice(5),
      snapshot?.people.find((p) => p.personId === b.personId)?.flightId,
    ]) ||
    [];
  return (
    <div className="insights-grid">
      {d ? (
        <AttendanceSummary
          dashboard={d}
          total={overview?.activeCadets ?? d.totalCadets}
          previous={archivedComparisons(compiled?.history ?? [], term).at(-1)}
        />
      ) : (
        <section className="insight">
          <h3>Wing attendance</h3>
          {error ? (
            <p role="alert">
              {error} <button onClick={() => setRetry(retry + 1)}>Retry</button>
            </p>
          ) : (
            <p role="status">Loading attendance…</p>
          )}
        </section>
      )}
      <BirthdayAgenda
        squadrons={squadrons}
        flights={flights}
        calendar={calendar}
        now={reportingTime || Date.now()}
      />
      {d && (
        <WingCharts
          key={context}
          dashboard={d}
          term={term}
          flights={flights}
          squadrons={squadrons}
          history={compiled?.history || []}
          awaitingHistory={compiled?.awaitingHistory}
        />
      )}
    </div>
  );
}
