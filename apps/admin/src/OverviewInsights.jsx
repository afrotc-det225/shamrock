import React, { useEffect, useState } from "react";
import { api } from "./api";
import { Select } from "./components";
import { toEastern } from "./time";

const percent = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(n);
const dayMs = 86400000;
const dayLabel = (date, weekday = false) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(weekday ? { weekday: "short" } : {}),
  }).format(date);
function Birthdays({ calendar, now }) {
  const [week, setWeek] = useState(0);
  const today = new Date(toEastern(now).slice(0, 10) + "T00:00Z");
  const first = new Date(+today + (week * 7 - today.getUTCDay()) * dayMs),
    end = new Date(+first + 6 * dayMs);
  const roster = calendar
    .flatMap(([given, last, md]) => {
      if (!/^\d\d-\d\d$/.test(md)) return [];
      return [...new Set([first.getUTCFullYear(), end.getUTCFullYear()])]
        .map(
          (year) => new Date(Date.UTC(year, +md.slice(0, 2) - 1, +md.slice(3))),
        )
        .filter((d) => d >= first && d <= end)
        .map((d) => ({ date: d, who: [given, last].join(" ") }));
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
      <p>
        {dayLabel(first)} – {dayLabel(end)}
      </p>
      {roster.length ? (
        <ul>
          {roster.map((r, i) => (
            <li key={i}>
              <strong>{r.who}</strong>
              <time>{dayLabel(r.date, true)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p>No birthdays this week.</p>
      )}
    </section>
  );
}
function Bars({ title, items, counts = false }) {
  const maximum = counts ? Math.max(1, ...items.map((i) => i.value || 0)) : 1;
  const observed = items.map((i) => i.value).filter(Number.isFinite);
  const floor = observed.length
    ? Math.min(0.9, Math.floor(Math.min(...observed) * 10) / 10)
    : 0;
  return (
    <section className="insight">
      <h3>{title}</h3>
      {!counts && (
        <div className="plot-axis" aria-hidden="true">
          <span>{percent(floor)}</span>
          <span>100%</span>
        </div>
      )}
      <ul className="bars">
        {items.map((i) => (
          <li key={i.label}>
            <span>{i.label}</span>
            {counts ? (
              <span aria-hidden="true" className="bar-track">
                <i style={{ width: (100 * (i.value || 0)) / maximum + "%" }} />
              </span>
            ) : (
              <span aria-hidden="true" className="dot-track">
                {i.value != null && (
                  <i
                    style={{
                      left: (100 * (i.value - floor)) / (1 - floor) + "%",
                    }}
                  />
                )}
              </span>
            )}
            <strong>{counts ? i.value : percent(i.value)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
const average = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function SemesterTrend({ dashboard, nowTerm }) {
  const [show, setShow] = useState(false),
    [terms, setTerms] = useState(null),
    [error, setError] = useState(""),
    [metric, setMetric] = useState("overall");
  useEffect(() => {
    if (!show) return;
    const controller = new AbortController(),
      opts = { signal: controller.signal };
    (async () => {
      const { semesters } = await api("/history/list", undefined, opts);
      const normalize = (v) =>
        String(v)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .sort()
          .join(" ");
      const series = [];
      for (const item of semesters || []) {
        if (normalize(item.label) === normalize(nowTerm)) continue;
        const file = await api(
          "/history/report",
          { version: item.version },
          opts,
        );
        series.push({
          label: item.label,
          overall: average(
            file.rows.map((r) => r.overall).filter(Number.isFinite),
          ),
          llab: average(file.rows.map((r) => r.llab).filter(Number.isFinite)),
        });
      }
      if (!controller.signal.aborted) setTerms(series);
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [show, nowTerm]);
  const series = [
    ...(terms || []),
    {
      label: nowTerm || "Current",
      overall: dashboard.averageOverall,
      llab: dashboard.averageLlab,
    },
  ];
  const values = series.map((i) => i[metric]).filter(Number.isFinite);
  const floor = Math.min(0.9, ...values.map((v) => Math.floor(v * 10) / 10));
  const coords = series.map((t, i) => ({
    x: 8 + (84 * i) / Math.max(series.length - 1, 1),
    y: 8 + (68 * (1 - t[metric])) / (1 - floor),
  }));
  return (
    <section className="insight trend">
      <h3>Attendance by semester</h3>
      {!show ? (
        <button
          onClick={() => {
            setError("");
            setShow(true);
          }}
        >
          Compare semesters
        </button>
      ) : error ? (
        <p role="alert">
          {error} <button onClick={() => setShow(false)}>Close</button>
        </p>
      ) : terms ? (
        <>
          <Select
            label="Attendance measure"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "overall", label: "Overall" },
              { value: "llab", label: "LLAB" },
            ]}
          />
          <figure className="trend-chart">
            <svg
              viewBox="0 0 100 84"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {[8, 42, 76].map((y) => (
                <line
                  key={y}
                  x1="4"
                  y1={y}
                  x2="96"
                  y2={y}
                  stroke="#d7e2dc"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {coords.map(
                (p, i) =>
                  i > 0 &&
                  series[i][metric] != null &&
                  series[i - 1][metric] != null && (
                    <line
                      key={i}
                      x1={coords[i - 1].x}
                      y1={coords[i - 1].y}
                      x2={p.x}
                      y2={p.y}
                      stroke="#28644d"
                      strokeWidth="3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ),
              )}
            </svg>
            <figcaption>Scale {percent(floor)}–100%</figcaption>
          </figure>
          <ul className="term-values">
            {series.map((t) => (
              <li key={t.label}>
                {t.label}
                <strong>{percent(t[metric])}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status">Loading semester averages…</p>
      )}
    </section>
  );
}
export default function OverviewInsights({
  overview,
  snapshot,
  reporting,
  birthdayCalendar,
  reportingTime,
  captureKey,
  manifest,
  viewAsRevision,
  meta,
}) {
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [requestedCapture, setRequestedCapture] = useState(null);
  const revision = JSON.stringify(manifest?.revision);
  const context = JSON.stringify([captureKey, viewAsRevision, revision]);
  useEffect(() => {
    if (reporting || !overview || requestedCapture !== context) return;
    const controller = new AbortController();
    setLoaded(null);
    setError("");
    api("/state", undefined, {
      profile: "attendance",
      signal: controller.signal,
    })
      .then((data) => {
        if (
          data.captureKey !== captureKey ||
          data.viewAsRevision !== viewAsRevision ||
          JSON.stringify(data.manifest?.revision) !== revision
        )
          throw Error("The roster or your access changed. Refresh Overview.");
        setLoaded({ context, dashboard: data.reporting.dashboard });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [reporting, !!overview, captureKey, viewAsRevision, revision, retry, requestedCapture, context]);
  const d =
    reporting?.dashboard ||
    (loaded && loaded.context === context ? loaded.dashboard : null);
  const term =
    overview?.term || snapshot?.terms.find((t) => t.isCurrent)?.label;
  const calendar =
    birthdayCalendar ||
    reporting?.dashboard.birthdays.map((b) => [
      b.firstName,
      b.lastName,
      b.dateOfBirth.slice(5),
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
          <Bars
            title="Overall attendance by flight"
            items={d.attendanceByFlight.map((f) => ({
              label: f.flight,
              value: f.percentage,
            }))}
          />
          <Bars
            title="Cadets by AS year"
            counts
            items={d.rosterByYear
              .filter((r) => r.cadets)
              .map((r) => ({ label: r.asYear, value: r.cadets }))}
          />
          <Bars
            title="Overall attendance by AS year"
            items={d.attendanceByYear
              .filter((r) => r.terms[0]?.percentage != null)
              .map((r) => ({ label: r.asYear, value: r.terms[0].percentage }))}
          />
        </>
      ) : (
        <section className="insight">
          <h3>Wing attendance</h3>
          {requestedCapture !== context ? (
            <button onClick={() => { setError(""); setRequestedCapture(context); }}>
              Show attendance charts
            </button>
          ) : error ? (
            <p role="alert">
              {error} <button onClick={() => setRetry(retry + 1)}>Retry</button>
            </p>
          ) : (
            <p role="status">Loading attendance…</p>
          )}
        </section>
      )}
      <Birthdays calendar={calendar} now={reportingTime || Date.now()} />
      {d && meta?.hosted && <SemesterTrend dashboard={d} nowTerm={term} />}
    </div>
  );
}
