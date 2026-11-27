import React, { useEffect, useState } from "react";
import { LoadingRows } from "./components";
import { api } from "./api";
import BirthdayAgenda from "./BirthdayAgenda";
import { WingCharts, percent, archivedComparisons } from "./WingCharts";

function RateTrend({points, floor}) {
  if (points.length < 2 || points.some(p => !Number.isFinite(p.value))) return null;
  const coords = points.map((p, i) => [3 + i * 58 / (points.length - 1), 29 - (p.value - floor) / (1 - floor) * 26]);
  const summary = points.map(p => p.label + " " + percent(p.value)).join(", ");
  return <svg className="rate-trend" viewBox="0 0 64 32" role="img" aria-label={summary}>
    <title>{summary}</title>
    <polyline points={coords.map(point => point.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="2"/>
    {coords.map(([x,y], i) => <circle key={i} cx={x} cy={y} r={i === coords.length-1 ? 3 : 2} fill="currentColor"/>)}
  </svg>;
}

function AttendanceRate({label, value, history, metric, term, floor}) {
  const previous = history.at(-1);
  const prior = previous?.[metric];
  const change = Number.isFinite(prior) && Number.isFinite(value)
    ? Math.round((value - prior) * 1000) / 10 : null;
  const delta = change != null && (change > 0 ? "+" : "") + change.toFixed(1);
  return <div className="attendance-rate">
    <dt>{label}</dt>
    <dd className="rate-value">{percent(value)}
      <RateTrend points={[...history.slice(-2).map(h => ({label:h.label,value:h[metric]})), {label:term,value}]} floor={floor}/>
    </dd>
    {change != null && <dd className="rate-comparison">
      <span className="comparison-change" data-direction={Math.sign(change)}
        aria-label={delta + " percentage points"}>{delta} pp</span>
      <span>vs. {previous.label}</span>
    </dd>}
  </div>;
}

function AttendanceSummary({dashboard, history, term, activeCadets, pending, navigate, error, retry}) {
  const rates = [dashboard?.averageOverall, dashboard?.averageLlab, ...history.slice(-2).flatMap(h => [h.overall, h.llab])];
  // Give both trend lines the same percentage scale, with at least one point of range.
  const floor = Math.floor(100 * Math.min(.99, ...rates.filter(Number.isFinite))) / 100;
  return <section className="insight attendance-summary" aria-labelledby="wing-attendance">
    <h3 id="wing-attendance">Wing attendance</h3>
    {dashboard ? <dl className="attendance-rates">
      <AttendanceRate label="Overall" value={dashboard.averageOverall} history={history} metric="overall" term={term} floor={floor}/>
      <AttendanceRate label="LLAB" value={dashboard.averageLlab} history={history} metric="llab" term={term} floor={floor}/>
    </dl> : error ? <p role="alert">{error} <button onClick={retry}>Retry</button></p>
      : <LoadingRows label="Loading Wing attendance" rows={2}/>}
    <div className="wing-roster-context">
      <div><strong>{activeCadets}</strong> active cadets
        {dashboard && <small>{dashboard.gmcCadets} GMC · {dashboard.pocCadets} POC</small>}</div>
      {dashboard && <div><strong>{dashboard.belowEighty}</strong> below 80% overall
        {dashboard.noCountedAttendanceCadets > 0 && <small>{dashboard.noCountedAttendanceCadets} with no counted attendance</small>}</div>}
    </div>
    <a className="overview-queue" href="/excusals" onClick={e => {
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); navigate("Excusals"); }
    }}>{pending} pending {pending === 1 ? "excusal" : "excusals"} <span aria-hidden="true">→</span></a>
  </section>;
}

export default function OverviewInsights({
  overview,
  activeCadets, pending, navigate,
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
      <AttendanceSummary dashboard={d} term={term} history={archivedComparisons(compiled?.history ?? [], term)}
        activeCadets={activeCadets} pending={pending} navigate={navigate} error={error} retry={() => setRetry(retry + 1)}/>
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
