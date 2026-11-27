import React, { useId, useState, useRef, useEffect } from "react";
import { flightColors, yearColors } from "./roster-colors";

const termInks = ["#253e65", "#b77942", "#598a99", "#886d9a"];
export const percent = (n) =>
  Number.isFinite(n) ? (100 * n).toFixed(1) + "%" : "—";
const termKey = (label) =>
  String(label)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .sort()
    .join(" ");
export const archivedComparisons = (archives,term) => archives.filter(t => termKey(t.label) !== termKey(term));

function useChartTooltip() {
  const panel = useRef(null);
  const [tip, setTip] = useState(null);
  const anchor = useRef(null);
  function reveal(element, label, name, value) {
    anchor.current = element;
    const mark = anchor.current.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    setTip({
      label,
      name,
      value,
      x: mark.left + mark.width / 2 - box.left,
      y: mark.top - box.top,
    });
  }
  useEffect(() => {
    if (!tip) return;
    const dismiss = (event) => {
      if (
        event.type === "keydown"
          ? event.key === "Escape"
          : !(
              panel.current?.contains(event.target) &&
              event.target.closest?.("[data-chart-mark]")
            )
      )
        setTip(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("click", dismiss, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [tip]);
  const dismiss = () => setTip(null);
  function onScroll(event) {
    if (!tip) return;
    const mark = anchor.current;
    if (document.activeElement === mark && event.currentTarget.contains(mark)) {
      const rect = mark.getBoundingClientRect();
      const viewport = event.currentTarget.getBoundingClientRect();
      if (rect.right > viewport.left && rect.left < viewport.right) {
        reveal(mark, tip.label, tip.name, tip.value);
        return;
      }
    }
    dismiss();
  }
  function target(label, name, value) {
    const show = (event) => reveal(event.currentTarget, label, name, value);
    return {
      "data-chart-mark": "",
      tabIndex: 0,
      "aria-label": [label, name, value].join(", "),
      onPointerMove: (event) => {
        if (
          event.pointerType !== "touch" &&
          (tip?.label !== label || tip.name !== name || tip.value !== value)
        )
          show(event);
      },
      onFocus: show,
      onClick: show,
      onPointerLeave: (event) => {
        if (event.pointerType !== "touch") dismiss();
      },
      onBlur: dismiss,
    };
  }
  const tooltip = tip && (
    <div
      className="chart-tip"
      role="tooltip"
      style={{
        left: `clamp(4.5rem, ${tip.x}px, calc(100% - 4.5rem))`,
        top: `max(3.25rem, ${tip.y}px)`,
      }}
    >
      <strong>{tip.label}</strong>
      <span>
        {tip.name} · {tip.value}
      </span>
    </div>
  );
  return { panel, tooltip, target, onScroll };
}

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
  const { panel, tooltip, target, onScroll } = useChartTooltip();
  return (
    <section className="insight chart-panel" ref={panel}>
      <header>
        <h3 id={id}>{title}</h3>
        {controls}
      </header>
      {tooltip}
      <div className="chart-scroll" onScroll={onScroll}>
        <svg
          role="group"
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
                    <rect
                      className="chart-target"
                      role="img"
                      {...target(labels[i], s.name, percent(v))}
                      x={cx - bw / 2}
                      y={y(v) - 8}
                      width={bw}
                      height={
                        kind === "line" ? 22 : Math.max(20, y(low) - y(v) + 8)
                      }
                    />
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
    </section>
  );
}
export function WingCharts({
  dashboard: d,
  term,
  flights,
  squadrons,
  history: archives,
  awaitingHistory,
}) {
  const [metric, setMetric] = useState("overall");
  const rosterTip = useChartTooltip();
  const history = archivedComparisons(archives,term);
  const years = d.attendanceByYear.filter(
    (r) =>
      r.terms[0]?.percentage != null ||
      history.some(
        (t) => t.byYear[r.asYear.replace(/\s/g, "").toUpperCase()] != null,
      ),
  );
  const currentLabel =
    term?.replace(/^(\d{4})-(Fall|Spring|Summer)$/i, "$1 $2") || "Current";
  const trend = [
    ...history,
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
  for (const [i, t] of [...history].reverse().entries())
    byYear.push({
      name: t.label,
      ink: termInks[(i + 1) % termInks.length],
      values: years.map(
        (r) => t.byYear[r.asYear.replace(/\s/g, "").toUpperCase()],
      ),
    });
  const roster = d.rosterByYear.filter((r) => r.cadets > 0),
    max = Math.max(1, ...roster.map((r) => r.cadets));
  return (
    <>
      <Plot
        title="Overall attendance by AS year"
        labels={years.map((r) => r.asYear)}
        series={byYear}
      />
      <Plot
        title="Wing attendance by semester"
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
      {awaitingHistory && (
        <p role="status">Historical comparisons are awaiting publication.</p>
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
      <section className="insight chart-panel" ref={rosterTip.panel}>
        {rosterTip.tooltip}
        <h3>Cadets by AS year</h3>
        <ul className="roster-bars">
          {roster.map((r) => (
            <li
              key={r.asYear}
              {...rosterTip.target(r.asYear, "Cadets", r.cadets)}
            >
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
