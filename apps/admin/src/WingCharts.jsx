import React, { useId, useState, useEffect } from "react";
import { api } from "./api";
import { flightColors, yearColors } from "./roster-colors";

const termInks = ["#253e65", "#b77942", "#598a99", "#886d9a"];
export const percent = (n) =>
  Number.isFinite(n) ? (100 * n).toFixed(1) + "%" : "—";
const mean = (values) =>
  values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const termKey = (label) =>
  String(label)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .sort()
    .join(" ");
function archivedTerm(label, rows) {
  const years = new Map();
  for (const r of rows) {
    const key = String(r.asYear).replace(/\s/g, "").toUpperCase();
    if (!years.has(key)) years.set(key, []);
    if (Number.isFinite(r.overall)) years.get(key).push(r.overall);
  }
  return {
    label,
    byYear: new Map([...years].map(([k, v]) => [k, mean(v)])),
    overall: mean(rows.map((r) => r.overall).filter(Number.isFinite)),
    llab: mean(rows.map((r) => r.llab).filter(Number.isFinite)),
  };
}
// All labels and exact values are also available without hovering or distinguishing colors.
function Plot({
  title,
  labels,
  series,
  kind = "bars",
  floor = 0.8,
  annotation = false,
  controls,
}) {
  const id = useId(),
    w = Math.max(460, labels.length * (series.length > 1 ? 56 : 50)),
    h = 205;
  const pad = { left: 44, right: 18, top: 24, bottom: 36 };
  const vals = series.flatMap((s) => s.values).filter(Number.isFinite);
  const low = Math.min(floor, ...vals.map((v) => Math.floor(v * 10) / 10)),
    high = 1;
  const y = (v) =>
    pad.top + ((high - v) / (high - low)) * (h - pad.top - pad.bottom);
  const slot = (w - pad.left - pad.right) / Math.max(labels.length, 1),
    x = (i) => pad.left + slot * (i + 0.5);
  const bw = Math.min(37, (slot * 0.74) / series.length);
  const ticks = Array.from(
    { length: 5 },
    (_, i) => high - (i * (high - low)) / 4,
  );
  return (
    <section className="insight chart-panel">
      <header>
        <h3 id={id}>{title}</h3>
        {controls}
      </header>
      <div className="chart-scroll">
        <svg
          role="img"
          aria-labelledby={id}
          viewBox={`0 0 ${w} ${h}`}
          style={{ minWidth: labels.length > 7 ? w : 280 }}
        >
          {ticks.map((n, i) => (
            <g key={i}>
              <line
                x1={pad.left}
                x2={w - pad.right}
                y1={y(n)}
                y2={y(n)}
                className="grid-rule"
              />
              <text x={pad.left - 7} y={y(n) + 4} textAnchor="end">
                {+(100 * n).toFixed(1)}%
              </text>
            </g>
          ))}
          {labels.map((label, i) => (
            <text key={i} x={x(i)} y={h - 13} textAnchor="middle">
              {label}
            </text>
          ))}
          {series.map((s, j) => (
            <g key={s.name}>
              {s.values.map((v, i) => {
                if (!Number.isFinite(v)) return null;
                const ink = s.inks?.[i] || s.ink,
                  cx = x(i) + (j - (series.length - 1) / 2) * bw;
                return (
                  <g key={i}>
                    <title>
                      {labels[i]} · {s.name} · {percent(v)}
                    </title>
                    {kind === "line" ? (
                      <>
                        {i > 0 && Number.isFinite(s.values[i - 1]) && (
                          <line
                            x1={x(i - 1)}
                            y1={y(s.values[i - 1])}
                            x2={cx}
                            y2={y(v)}
                            stroke={ink}
                            strokeWidth="2.8"
                          />
                        )}
                        <circle
                          cx={cx}
                          cy={y(v)}
                          r="4"
                          stroke="white"
                          strokeWidth="1.5"
                          fill={ink}
                        />
                      </>
                    ) : (
                      <rect
                        x={cx - bw * 0.44}
                        y={y(v)}
                        width={bw * 0.88}
                        height={Math.max(1, y(low) - y(v))}
                        fill={ink}
                        rx="2"
                      />
                    )}
                    {annotation && (
                      <text
                        x={cx}
                        y={y(v) - 8}
                        textAnchor="middle"
                        className="plot-value"
                      >
                        {percent(v)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      {series.length > 1 && (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.name}>
              <i style={{ background: s.ink }} />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <details className="chart-values">
        <summary>Chart data</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{kind === "line" ? "Semester" : "Group"}</th>
              {series.map((s) => (
                <th scope="col" key={s.name}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={i}>
                <th scope="row">{l}</th>
                {series.map((s) => (
                  <td key={s.name}>{percent(s.values[i])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
export function WingCharts({ dashboard: d, term, flights, squadrons, hosted }) {
  const [history, setHistory] = useState(null),
    [load, setLoad] = useState(false),
    [error, setError] = useState(""),
    [metric, setMetric] = useState("overall");
  useEffect(() => {
    if (!load || !hosted) return;
    const controller = new AbortController(),
      opts = { signal: controller.signal };
    (async () => {
      const catalog = await api("/history/list", undefined, opts);
      const entries = (catalog.semesters || []).filter(
        (t) => termKey(t.label) !== termKey(term),
      );
      const result = await Promise.all(
        entries.map(async (t) =>
          archivedTerm(
            t.label,
            (await api("/history/report", { version: t.version }, opts)).rows,
          ),
        ),
      );
      if (!controller.signal.aborted) setHistory(result);
    })().catch((e) => {
      if (!controller.signal.aborted) {
        setError(e.message);
        setLoad(false);
      }
    });
    return () => controller.abort();
  }, [load, hosted, term]);
  const years = d.attendanceByYear.filter(
    (r) =>
      r.terms[0]?.percentage != null ||
      history?.some((t) => t.byYear.get(r.asYear.toUpperCase()) != null),
  );
  const currentLabel = term?.replace(/^(\d{4})-(Fall|Spring|Summer)$/i, "$1 $2") || "Current";
  const trend = [
    ...(history || []),
    {
      label: currentLabel,
      overall: d.averageOverall,
      llab: d.averageLlab,
    },
  ];
  const byYear = [
    {
      name: currentLabel,
      ink: termInks[0],
      values: years.map((r) => r.terms[0]?.percentage),
    },
  ];
  for (const [i, t] of [...(history || [])].reverse().entries())
    byYear.push({
      name: t.label,
      ink: termInks[(i + 1) % termInks.length],
      values: years.map((r) => t.byYear.get(r.asYear.toUpperCase())),
    });
  const roster = d.rosterByYear.filter((r) => r.cadets > 0),
    max = Math.max(1, ...roster.map((r) => r.cadets));
  return (
    <>
      <Plot
        title="Overall attendance by AS year"
        labels={years.map((r) => r.asYear)}
        series={byYear}
        controls={
          hosted &&
          !history && (
            <button
              disabled={load}
              onClick={() => {
                setError("");
                setLoad(true);
              }}
            >
              {load ? "Loading semesters…" : "Compare semesters"}
            </button>
          )
        }
      />
      {error && <p role="alert">{error}</p>}
      {history && (
        <Plot
          title="Attendance by semester"
          labels={trend.map((t) => t.label)}
          series={[
            {
              name: metric === "overall" ? "Overall" : "LLAB",
              ink: termInks[0],
              values: trend.map((t) => t[metric]),
            },
          ]}
          kind="line"
          floor={0.9}
          annotation
          controls={
            <select
              aria-label="Attendance measure"
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
            >
              <option value="overall">Overall</option>
              <option value="llab">LLAB</option>
            </select>
          }
        />
      )}
      <Plot
        title="Overall attendance by flight"
        labels={d.attendanceByFlight.map((f) => f.flight)}
        floor={0.9}
        annotation
        series={[
          {
            name: "Overall",
            values: d.attendanceByFlight.map((f) => f.percentage),
            inks: d.attendanceByFlight.map((f) => {
              const assignment = flights.find((r) => r.flightId === f.flightId);
              return flightColors(
                f.flight,
                squadrons.find((q) => q.squadronId === assignment?.squadronId)
                  ?.label,
              )[2];
            }),
          },
        ]}
      />
      <section className="insight chart-panel">
        <h3>Cadets by AS year</h3>
        <ul className="roster-bars">
          {roster.map((r) => (
            <li key={r.asYear}>
              <span>{r.asYear}</span>
              <div>
                <i
                  style={{
                    width: (100 * r.cadets) / max + "%",
                    background: yearColors(r.asYear)[2],
                  }}
                />
              </div>
              <b>{r.cadets}</b>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
