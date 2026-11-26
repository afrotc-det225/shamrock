import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Select } from "./components";
import { toEastern } from "./time";

import { WingCharts, percent } from "./WingCharts";
import { flightColors, cellStyle } from "./roster-colors";
const dayMs = 86400000;
const dayLabel = (date, weekday = false) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(weekday ? { weekday: "short" } : {}),
  }).format(date);
function Birthdays({ calendar, now, flights, squadrons }) {
  const [week, setWeek] = useState(0);
  const today = new Date(toEastern(now).slice(0, 10) + "T00:00Z");
  const first = new Date(+today + (week * 7 - today.getUTCDay()) * dayMs),
    end = new Date(+first + 6 * dayMs);
  const roster = calendar
    .flatMap(([given, last, md, flightId]) => {
      if (!/^\d\d-\d\d$/.test(md)) return [];
      return [...new Set([first.getUTCFullYear(), end.getUTCFullYear()])]
        .map(
          (year) => new Date(Date.UTC(year, +md.slice(0, 2) - 1, +md.slice(3))),
        )
        .filter((d) => d >= first && d <= end)
        .map((d) => ({
          date: d,
          who: [given, last].join(" "),
          flight: flights.find((f) => f.flightId === flightId),
        }));
    })
    .sort((a, b) => a.date - b.date || a.who.localeCompare(b.who));
  return (
    <section className="insight birthdays">
      <header>
        <h3>Wing birthdays</h3>
        <Select
          label="Week"
          value={String(week)}
          onChange={(v) => setWeek(Number(v))}
          options={[
            { value: "0", label: "This week" },
            { value: "1", label: "Next week" },
            { value: "-1", label: "Last week" },
          ]}
        />
      </header>
      <div className="birthday-month">
        {new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).formatRange(first, end)}
      </div>
      <ol className="birthday-week">
        {Array.from({ length: 7 }, (_, i) => {
          const date = new Date(+first + i * dayMs),
            day = roster.filter((r) => +r.date === +date);
          return (
            <li key={i} aria-current={+date === +today ? "date" : undefined}>
              <small>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]}
              </small>
              <b>{date.getUTCDate()}</b>
              <div className="birthday-dots">
                {day.map((r, j) => (
                  <i
                    key={j}
                    style={{
                      background: flightColors(
                        r.flight?.label,
                        squadrons.find(
                          (s) => s.squadronId === r.flight?.squadronId,
                        )?.label,
                      )[2],
                    }}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      {roster.length ? (
        <ul className="birthday-agenda">
          {roster.map((r, i) => {
            const colors = flightColors(
              r.flight?.label,
              squadrons.find((s) => s.squadronId === r.flight?.squadronId)
                ?.label,
            );
            return (
              <li key={i} style={{ borderLeftColor: colors[2] }}>
                <time>{dayLabel(r.date, true)}</time>
                <strong>{r.who}</strong>
                {r.flight && (
                  <span style={cellStyle(colors)}>{r.flight.label} Flight</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No birthdays this week.</p>
      )}
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
        <>
          <section className="insight attendance-summary">
            <h3>Wing attendance</h3>
            <dl>
              {[
                ["Overall", percent(d.averageOverall)],
                ["LLAB", percent(d.averageLlab)],
                ["Below 80% overall", d.belowEighty],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="coverage">
              {d.gmcCadets} GMC · {d.pocCadets} POC
              {d.noCountedAttendanceCadets > 0 &&
                " · " +
                  d.noCountedAttendanceCadets +
                  " with no counted attendance"}
            </p>
          </section>
        </>
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
      <Birthdays
        flights={flights}
        squadrons={squadrons}
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
