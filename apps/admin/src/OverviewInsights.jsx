import React, { useEffect, useState } from "react";
import { LoadingRows } from "./components";
import { api } from "./api";
import BirthdayAgenda from "./BirthdayAgenda";
import { WingCharts, percent, archivedComparisons } from "./WingCharts";

function AttendanceRate({label, value, history, metric}) {
  const previous = history.at(-1);
  const prior = previous?.[metric];
  const change = Number.isFinite(prior) && Number.isFinite(value)
    ? Math.round((value - prior) * 1000) / 10 : null;
  const delta = change != null && (change > 0 ? "+" : "") + change.toFixed(1);
  return <div className="attendance-rate">
    <dt>{label}</dt>
    <dd className="rate-value">{percent(value)}</dd>
    {change != null && <dd className="rate-comparison">
      <span className="comparison-change" data-direction={Math.sign(change)}
        aria-label={delta + " percentage points"}>{delta} pp</span>
      <span>vs. {previous.label}</span>
    </dd>}
  </div>;
}

function AttendanceSummary({dashboard, history, error, retry}) {
  return <section className="insight attendance-summary" aria-labelledby="wing-attendance">
    <h3 id="wing-attendance">Wing attendance</h3>
    {dashboard ? <dl className="attendance-rates">
      <AttendanceRate label="Overall" value={dashboard.averageOverall} history={history} metric="overall"/>
      <AttendanceRate label="LLAB" value={dashboard.averageLlab} history={history} metric="llab"/>
    </dl> : error ? <p role="alert">{error} <button onClick={retry}>Retry</button></p>
      : <LoadingRows label="Loading Wing attendance" rows={2}/>}
  </section>;
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
      <AttendanceSummary dashboard={d} history={archivedComparisons(compiled?.history ?? [], term)}
        error={error} retry={() => setRetry(retry + 1)}/>
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
