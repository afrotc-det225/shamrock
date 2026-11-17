import React, { useState } from "react";
import { Heading, Field, Select, Table } from "./components";
import { name, years, statuses, api } from "./api";
export default function Semester({
  snapshot: s,
  propose,
  busy,
  notify,
  meta,
  history,
}) {
  const current = s.terms.find((t) => t.isCurrent),
    [title, setTitle] = useState(""),
    [first, setFirst] = useState(""),
    [weeks, setWeeks] = useState(15),
    [reason, setReason] = useState(""),
    [changes, setChanges] = useState({}),
    [schedule, setSchedule] = useState({
      mando: { weekday: 4, hour: 6, minute: 30, durationMinutes: 60 },
      llab: { weekday: 2, hour: 15, minute: 30, durationMinutes: 120 },
    });
  const [transition, setTransition] = useState(null),
    [statusError, setStatusError] = useState("");
  const loadStatus = async (id) => {
    try {
      setStatusError("");
      setTransition(await api(`/transition?id=${encodeURIComponent(id)}`));
    } catch (e) {
      setStatusError(e.message);
    }
  };
  const plans = history.filter(
    (r) =>
      r.summary.title === "Prepare semester" &&
      r.summary.transitionId &&
      r.state === "complete",
  );
  const change = (p, k, v) =>
    setChanges({
      ...changes,
      [p.personId]: {
        ...(changes[p.personId] || {
          personId: p.personId,
          expectedVersion: p.version,
          asYear: p.asYear,
          rank: p.rank,
          role: p.role,
          flightId: p.flightId,
          flightPathStatus: p.flightPathStatus,
        }),
        [k]: v,
      },
    });
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
        reviewReason: reason,
        people: Object.values(changes),
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
        title="Semester"
        description={`Prepare the next semester while ${current?.label || "the current semester"} stays intact.`}
      />
      <div className="notice">
        Preparation saves a plan and requests a verified archive. It does not
        activate the next semester. No cadet is automatically marked graduated
        or commissioned.
      </div>
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
      <form onSubmit={submit}>
        <section className="form-section">
          <h2>1. Set the schedule</h2>
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
                  {key === "mando" ? "Mando PT" : "LLAB"} · Eastern time
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
          <h2>2. Review cadets</h2>
          <p>
            Unchanged cadets retain their current status and assignments. Review
            each senior explicitly.
          </p>
          <Table headers={["Cadet", "AS year", "Flight Path", "Flight", ""]}>
            {s.people.map((p) => {
              const draft = changes[p.personId] || p;
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
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        </section>
        <section className="form-section">
          <h2>3. Review the plan</h2>
          <Field label="Reason / semester preparation notes">
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <button className="primary" disabled={busy || !current}>
            Review semester plan
          </button>
        </section>
      </form>
    </>
  );
}
