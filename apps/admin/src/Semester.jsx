import { zoneLabel } from "./time";
import React, { useState } from "react";
import { Heading, Field, Select, Table } from "./components";
import { name, years, statuses, api } from "./api";
import { semesterAsYear } from "../../../packages/domain/src/transitions";
import { operationallyActive } from "../../../packages/domain/src/admin";
import { semesterDefaults } from './schedule.mjs';
import { useReceipts, ReceiptStatus } from './receipts';
export default function Semester({
  snapshot: s,
  propose,
  busy,
  notify,
  meta,
  history,
  receiptsDeferred,
  reportingTime,
  captureKey,
}) {
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey });
  const current = s.terms.find((t) => t.isCurrent),
    [defaults] = useState(() => semesterDefaults(s)),
    [title, setTitle] = useState(defaults.label),
    [first, setFirst] = useState(""),
    [weeks, setWeeks] = useState(defaults.weeks),
    [changes, setChanges] = useState({}),
    [schedule, setSchedule] = useState(defaults.schedule);
  const [transition, setTransition] = useState(null),
    [statusError, setStatusError] = useState(""),
    [dirty, setDirty] = useState(false);
  const loadStatus = async (id) => {
    try {
      setStatusError("");
      setTransition(await api(`/transition?id=${encodeURIComponent(id)}`));
    } catch (e) {
      setStatusError(e.message);
    }
  };
  const plans = (receipt.rows || []).filter(
    (r) =>
      r.summary.title === "Prepare semester" &&
      r.summary.transitionId &&
      r.state === "complete",
  );
  const [groupRules, setGroupRules] = useState({});
  const [search, setSearch] = useState("");
  const currentSeason = current?.label.match(/\b(fall|spring)\b/i)?.[1].toLowerCase();
  const nextSeason = title.match(/\b(fall|spring)\b/i)?.[1].toLowerCase();
  const direction = currentSeason === "fall" && nextSeason === "spring" ? "fall-spring"
    : currentSeason === "spring" && nextSeason === "fall" ? "spring-fall" : "hold";
  const rules = groupRules[direction] || {};
  const outcome = year => rules[year] ?? (year === "AS400" && direction === "spring-fall"
    ? "Commissioned" : semesterAsYear(year, direction));
  const activeCounts = new Map();
  const planned = [];
  for (const p of s.people) {
    const active = operationallyActive(p);
    if (active) activeCounts.set(p.asYear, (activeCounts.get(p.asYear) || 0) + 1);
    const next = active ? outcome(p.asYear) : p.asYear;
    const commissioning = next === "Commissioned";
    const entry = {personId:p.personId, expectedVersion:p.version, asYear:commissioning ? p.asYear : next,
      rank:p.rank, role:p.role, flightId:p.flightId, flightPathStatus:commissioning ? "Commissioned" : p.flightPathStatus, ...changes[p.personId]};
    if (["asYear","flightId","flightPathStatus"].some(key => entry[key] !== p[key])) planned.push(entry);
  }
  const matches = search.trim() ? s.people.filter(p => !changes[p.personId] &&
    name(p).toLowerCase().includes(search.trim().toLowerCase())).slice(0, 12) : [];
  const change = (p, key, value) => setChanges(previous => ({
    ...previous, [p.personId]: {...previous[p.personId], [key]:value},
  }));
  const submit = (e) => {
    e.preventDefault();
    propose("transition.prepare", {
      plan: {
        transitionId: crypto.randomUUID(),
        kind: "semester",
        sourceTermId: current.termId,
        targetTerm: {
          termId: crypto.randomUUID(),
          label: title,
          sortOrder: Math.max(...s.terms.map((t) => t.sortOrder)) + 1,
        },
        policyVersion: meta.transitionPolicy,
        reviewReason: `Prepare ${title}`,
        people: planned,
        schedule: {
          firstSunday: first,
          firstTrainingWeek: 1,
          weeks: Number(weeks),
          ...schedule,
        },
      },
    });
  };
  return (
    <>
      <Heading
        title="Semester planning"
      />
      <ReceiptStatus receipt={receipt} />
      {plans.length > 0 && (
        <section className="form-section">
          <h2>Prepared plans</h2>
          {plans.map((p) => (
            <button
              key={p.id}
              onClick={() => loadStatus(p.summary.transitionId)}
            >
              {p.summary.target} · Check progress
            </button>
          ))}
          {statusError && (
            <p role="alert" className="error">
              {statusError}
            </p>
          )}
          {transition && (
            <div className="form-section">
              <h3>{transition.plan.targetTerm.label}</h3>
              <p>
                Status: {transition.state}. Archive:{" "}
                {transition.archive?.state || "Not requested"}.
              </p>
              <p>
                Activation requires a verified archive. Publication must finish
                before the semester can be marked complete.
              </p>
              <div className="actions">
                <button onClick={() => loadStatus(transition.transitionId)}>
                  Refresh progress
                </button>
                {["proposed", "ready"].includes(transition.state) && (
                  <button
                    onClick={() =>
                      propose("transition.cancel", {
                        transitionId: transition.transitionId,
                        expectedVersion: transition.version,
                        planHash: transition.planHash,
                      })
                    }
                  >
                    Review cancellation
                  </button>
                )}
                {transition.state === "ready" && (
                  <button
                    className="primary"
                    onClick={() =>
                      propose("transition.accept", {
                        transitionId: transition.transitionId,
                        expectedVersion: transition.version,
                        planHash: transition.planHash,
                      })
                    }
                  >
                    Review activation
                  </button>
                )}
                {transition.state === "publishing" && (
                  <button
                    onClick={() =>
                      propose("transition.complete", {
                        transitionId: transition.transitionId,
                        expectedVersion: transition.version,
                        planHash: transition.planHash,
                      })
                    }
                  >
                    Verify completion
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
      <form onSubmit={submit} data-dirty={dirty} onChangeCapture={() => setDirty(true)}>
        <section className="form-section">
          <h2>Schedule</h2>
          <div className="form-grid">
            <Field
              label="New semester name"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Spring 2027"
            />
            <Field
              label="First training-week Sunday"
              required
              type="date"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
            <Field
              label="Training weeks"
              required
              type="number"
              min="1"
              max="20"
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
            />
          </div>
          <div className="form-grid">
            {Object.entries(schedule).map(([key, value]) => (
              <fieldset key={key}>
                <legend>
                  {key === "mando" ? "Mando PT" : "LLAB"} · {zoneLabel()}
                </legend>
                <Select
                  label="Weekday"
                  value={value.weekday}
                  onChange={(v) =>
                    setSchedule({
                      ...schedule,
                      [key]: { ...value, weekday: Number(v) },
                    })
                  }
                  options={[
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                  ].map((label, value) => ({ label, value }))}
                />
                <Field
                  label="Start time"
                  type="time"
                  required
                  value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
                  onChange={(e) => {
                    const [hour, minute] = e.target.value
                      .split(":")
                      .map(Number);
                    setSchedule({
                      ...schedule,
                      [key]: { ...value, hour, minute },
                    });
                  }}
                />
                <Field
                  label="Duration (minutes)"
                  type="number"
                  min="1"
                  max="720"
                  required
                  value={value.durationMinutes}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      [key]: {
                        ...value,
                        durationMinutes: Number(e.target.value),
                      },
                    })
                  }
                />
              </fieldset>
            ))}
          </div>
        </section>
        <section className="form-section">
          <h2>AS year progression</h2>
          <p>{current?.label} → {title || "New semester"} · {planned.length} cadet records will change.</p>
          <Table headers={["Current AS year", "Active cadets", "Next AS year"]}>
            {years.filter(year => activeCounts.has(year)).map(year =>
              <tr key={year}><td>{year}</td><td>{activeCounts.get(year)}</td><td>
                <Select label={`Next AS year for ${year}`} value={outcome(year)} options={year === "AS400" ? [...years, "Commissioned"] : years}
                  onChange={value => setGroupRules({...groupRules, [direction]:{...rules, [year]:value}})} />
              </td></tr>)}
          </Table>
        </section>
        <section className="form-section">
          <h2>Individual exceptions</h2>
          <p>Add a cadet to keep their current AS year or assign a different outcome.</p>
          <Field label="Find a cadet" type="search" value={search} onChange={e => setSearch(e.target.value)} />
          {search.trim() && !matches.length && <p>No matching cadets to add.</p>}
          {matches.map(p => <button key={p.personId} type="button" onClick={() => {
            setChanges(previous => ({...previous, [p.personId]:{asYear:p.asYear, flightPathStatus:p.flightPathStatus}}));
            setSearch(""); setDirty(true);
          }}>Add {name(p)} · {p.asYear} · {s.flights.find(f => f.flightId === p.flightId)?.label || "Unassigned"}</button>)}
          {Object.keys(changes).length > 0 && (
          <Table headers={["Cadet", "AS year", "Flight Path", "Flight", ""]}>
            {s.people.filter(p => changes[p.personId]).map((p) => {
              const draft = {...p, ...changes[p.personId]};
              return (
                <tr key={p.personId}>
                  <td>{name(p)}</td>
                  <td>
                    <Select
                      label={`AS year for ${name(p)}`}
                      value={draft.asYear}
                      onChange={(v) => change(p, "asYear", v)}
                      options={years}
                    />
                  </td>
                  <td>
                    <Select
                      label={`Status for ${name(p)}`}
                      value={draft.flightPathStatus}
                      onChange={(v) => change(p, "flightPathStatus", v)}
                      options={statuses}
                    />
                  </td>
                  <td>
                    <Select
                      label={`Flight for ${name(p)}`}
                      value={draft.flightId}
                      onChange={(v) => change(p, "flightId", v || null)}
                      options={[
                        { value: "", label: "Unassigned" },
                        ...s.flights.map((f) => ({
                          value: f.flightId,
                          label: f.label,
                        })),
                      ]}
                    />
                  </td>
                  <td>
                    {changes[p.personId] && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...changes };
                          delete next[p.personId];
                          setChanges(next);
                        }}
                      >
                        Remove exception
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>)}
        </section>
        <section className="form-section">
          <button className="primary" disabled={busy || !current}>
            Review semester plan
          </button>
        </section>
      </form>
    </>
  );
}
