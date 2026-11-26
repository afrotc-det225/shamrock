import React, { useEffect, useState, useRef } from "react";
import { api, logout } from "./api";
import { Field, Select, Status, Table } from "./components";
import Excusals from "./Excusals";
import Brand from "./Brand";
import { AS_YEARS } from "../../../packages/domain/src/admin";

const fields = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["classYear", "Graduation year"],
  ["phone", "Phone", "tel"],
  ["dateOfBirth", "Date of birth", "date"],
  ["dorm", "Residence"],
  ["homeTown", "Hometown"],
  ["homeState", "Home state"],
  ["cipBroadArea", "CIP broad area"],
  ["cipCode", "CIP code"],
  ["afsc", "AFSC"],
  ["photoLink", "Photo link", "url"],
];
const required = new Set([
  "firstName",
  "lastName",
  "classYear",
  "phone",
  "dateOfBirth",
  "homeTown",
  "homeState",
]);
function Profile({ state, save, disabled }) {
  const [form, set] = useState(() => ({
    ...state.profile,
    university: state.profile?.university || state.school || "",
    asYear: state.profile?.asYear || "",
    flightId: state.profile?.flightId || "",
  }));
  const [step, setStep] = useState(0);
  const register = state.registration,
    pick = (key, value) => set((old) => ({ ...old, [key]: value }));
  const visible = register
    ? step === 0
      ? fields.slice(0, 5)
      : fields.slice(5)
    : fields;
  function submit(e) {
    e.preventDefault();
    if (register && step === 0) {
      setStep(1);
      return;
    }
    const changes = Object.fromEntries(
      fields
        .map(([k]) => [k, form[k]?.trim() || (k === "dateOfBirth" ? null : "")])
        .filter(([k, v]) => register || state.profile[k] !== v),
    );
    if (!register && !Object.keys(changes).length) return;
    save(
      register ? "register" : "profile",
      register
        ? {
            ...changes,
            university: form.university,
            asYear: form.asYear,
            flightId: form.flightId,
          }
        : { changes, version: state.profile.version },
    );
  }
  return (
    <form onSubmit={submit} className="cadet-form">
      <h2>
        {register
          ? step === 0
            ? "Create your Directory profile"
            : "Academic and career information"
          : "My Directory profile"}
      </h2>
      <fieldset disabled={disabled && !register}>
        <div className="cadet-fields">
          {register && step === 0 && (
            <>
              <Field label="University">
                <input
                  required
                  value={form.university}
                  onChange={(e) => pick("university", e.target.value)}
                />
              </Field>
              <Select
                label="AS year"
                required
                value={form.asYear}
                onChange={(v) => pick("asYear", v)}
                options={[{ value: "", label: "Choose AS year" }, ...AS_YEARS]}
              />
              <Select
                label="Flight"
                required
                value={form.flightId}
                onChange={(v) => pick("flightId", v)}
                options={[
                  { value: "", label: "Choose Flight" },
                  ...state.flights.map((f) => ({
                    value: f.flightId,
                    label: f.label,
                  })),
                ]}
              />
            </>
          )}
          {visible.map(([key, label, type]) => (
            <Field key={key} label={label}>
              <input
                type={type || "text"}
                maxLength={key === "classYear" ? 4 : 240}
                pattern={
                  key === "classYear"
                    ? "[0-9]{4}"
                    : key === "cipCode"
                      ? "[0-9]{2}[.][0-9]{4}"
                      : undefined
                }
                required={required.has(key)}
                value={form[key] || ""}
                onChange={(e) => pick(key, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      {(!register || step === 1) && (
        <p>
          <a
            href="https://nces.ed.gov/ipeds/cipcode/"
            target="_blank"
            rel="noreferrer"
          >
            Find your major’s CIP code
          </a>{" "}
          ·{" "}
          <a
            href="https://www.afrotc.com/career-opportunities/"
            target="_blank"
            rel="noreferrer"
          >
            Explore officer careers
          </a>
        </p>
      )}
      {register && step === 1 && (
        <button type="button" onClick={() => setStep(0)}>
          Back
        </button>
      )}
      <button
        className="primary"
        disabled={disabled && (!register || step === 1)}
      >
        {register
          ? step === 0
            ? "Continue"
            : "Create profile"
          : "Save changes"}
      </button>
    </form>
  );
}
function Submission({ state, mode, save, disabled }) {
  const [count, setCount] = useState(1);
  return (
    <form
      key={mode}
      className="cadet-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget),
          events = f
            .getAll("event")
            .map((id) => state.events.find((x) => x.eventId === id));
        save(
          mode,
          mode === "flag"
            ? { eventId: events[0].eventId, detail: f.get("reason") }
            : {
                events: events.map((e) => ({
                  eventId: e.eventId,
                  version: e.version,
                })),
                outcome: f.get("outcome"),
                reason: f.get("reason"),
              },
        );
      }}
    >
      <h2>{mode === "flag" ? "Flag attendance" : "Request an excusal"}</h2>
      <fieldset disabled={disabled}>
        {Array.from({ length: count }, (_, i) => (
          <Field key={i} label={count === 1 ? "Event" : `Event ${i + 1}`}>
            <select name="event" required defaultValue="">
              <option value="" disabled>
                Select an event
              </option>
              {state.events.map((e) => (
                <option value={e.eventId} key={e.eventId}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
        ))}
        {mode === "excusal" && count < Math.min(state.events.length, 25) && (
          <button type="button" onClick={() => setCount(count + 1)}>
            Add event
          </button>
        )}
        {count > 1 && (
          <button type="button" onClick={() => setCount(count - 1)}>
            Remove last event
          </button>
        )}
        {mode === "excusal" && (
          <Field label="Requested code">
            <select name="outcome" defaultValue="E">
              {["P", "T", "E", "ES", "MED"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={
            mode === "flag"
              ? "What should your Flight commander review?"
              : "Reason"
          }
        >
          <textarea name="reason" required maxLength={500} />
        </Field>
        <button className="primary">Submit</button>
      </fieldset>
    </form>
  );
}
function FlightReport({ state, save, disabled }) {
  const [eventId, select] = useState(""),
    [present, setPresent] = useState([]),
    [complete, setComplete] = useState(false);
  const events = [
    ...new Map(state.reportRoster.map((r) => [r.eventId, r])).values(),
  ];
  const eligible = new Set(
    state.reportRoster
      .filter((r) => r.eventId === eventId)
      .map((r) => r.personId),
  );
  const roster = state.roster.filter((r) => eligible.has(r.personId));
  const flight = state.flights.find(
    (f) => f.flightId === state.profile.flightId,
  );
  return (
    <details>
      <summary>Submit Flight attendance</summary>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(
            "report",
            {
              eventId,
              version: events.find((v) => v.eventId === eventId).version,
              rosterVersion: flight.rosterVersion,
              present,
              completeness: complete ? "complete" : "partial",
            },
            () => {
              select("");
              setPresent([]);
              setComplete(false);
            },
          );
        }}
      >
        <Select
          label="Attendance event"
          value={eventId}
          onChange={(id) => {
            select(id);
            setPresent([]);
            setComplete(false);
          }}
          required
          options={[
            { value: "", label: "Select an event" },
            ...events.map((r) => ({ value: r.eventId, label: r.label })),
          ]}
        />
        {eventId && (
          <>
            <fieldset>
              <legend>Present</legend>
              {roster.map((r) => (
                <label key={r.personId}>
                  <input
                    type="checkbox"
                    checked={present.includes(r.personId)}
                    onChange={(e) =>
                      setPresent(
                        e.target.checked
                          ? [...present, r.personId]
                          : present.filter((p) => p !== r.personId),
                      )
                    }
                  />
                  {r.name}
                </label>
              ))}
            </fieldset>
            {roster.length === state.roster.length && (
              <label>
                <input
                  type="checkbox"
                  checked={complete}
                  onChange={(e) => setComplete(e.target.checked)}
                />
                Complete Flight report
              </label>
            )}
            <button
              className="primary"
              disabled={disabled || (!present.length && !complete)}
            >
              Submit attendance
            </button>
          </>
        )}
      </form>
    </details>
  );
}
function Flight({ state, save, disabled }) {
  return (
    <>
      <FlightReport state={state} save={save} disabled={disabled} />
      <h2>Attendance flags</h2>
      {state.actions
        .filter((a) => a.kind === "flag" && !a.resolution)
        .map((a) => (
          <form
            key={a.actionId}
            className="cadet-form"
            onSubmit={(e) => {
              e.preventDefault();
              save("resolve", {
                parentId: a.actionId,
                detail: new FormData(e.currentTarget).get("resolution"),
              });
            }}
          >
            <strong>
              {a.person} · {a.event}
            </strong>
            <p>{a.detail}</p>
            <Field label="Resolution">
              <input name="resolution" required maxLength={500} />
            </Field>
            <button disabled={disabled}>Mark reviewed</button>
          </form>
        ))}
      {!state.actions.some((a) => a.kind === "flag" && !a.resolution) && (
        <p>No open attendance flags.</p>
      )}
      <h2>Flight duties</h2>
      <Table headers={["Cadet", "Current duty"]}>
        {state.roster.map((p) => (
          <tr key={p.personId}>
            <td>{p.name}</td>
            <td>
              {state.actions.find(
                (a) => a.kind === "duty" && a.personId === p.personId,
              )?.detail || "—"}
            </td>
          </tr>
        ))}
      </Table>
      <form
        className="cadet-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save("duty", { personId: f.get("person"), detail: f.get("duty") });
        }}
      >
        <Field label="Cadet">
          <select name="person" required>
            {state.roster.map((p) => (
              <option key={p.personId} value={p.personId}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flight duty">
          <input name="duty" required maxLength={120} />
        </Field>
        <button disabled={disabled}>Assign duty</button>
      </form>
    </>
  );
}
export default function CadetWorkspace({ session }) {
  const [state, setState] = useState(null),
    [tab, setTab] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(null),
    active = useRef(false),
    preview = !!session.viewAs;
  const load = async () => {
    const s = await api("/cadet");
    setState(s);
    return s;
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function save(kind, fields, done) {
    if (active.current || preview) return;
    active.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([kind, fields]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      await api("/cadet", { kind, fields, id: pending.current.id });
      await load();
      pending.current = null;
      done?.();
      setNotice("Saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const flight = state?.flights.find(
    (f) => f.flightId === state.profile?.flightId,
  )?.label;
  const tabs =
    state && !state.registration
      ? [
          ...(state.squadron ? ["Excusals"] : []),
          ...(state.flightCommander ? ["My Flight"] : []),
          "My requests",
          "My profile",
        ]
      : [];
  const page = tabs.includes(tab) ? tab : tabs[0];
  const disabled =
    busy ||
    preview ||
    !state?.writable ||
    (!state?.linked && !state?.registration);
  const queue = state?.queue || [];
  const list = state?.squadron && {
    terms: [{ termId: "current", isCurrent: true }],
    events: [
      ...new Map(
        queue.map((r) => [
          r.eventId,
          {
            eventId: r.eventId,
            label: r.event,
            termId: "current",
            status: "active",
          },
        ]),
      ).values(),
    ],
    flights: state.flights,
    people: [],
    requests: queue.map((r) => ({ ...r, canDecide: true })),
    access: { capabilities: { fullSnapshot: false } },
  };
  return (
    <main className="cadet-workspace">
      <header>
        <Brand />
        <div>
          {!preview && !session.schoolLogin && (
            <a href="/?workspace=leadership">Leadership workspace</a>
          )}
          {preview ? (
            <button
              onClick={async () => {
                try {
                  await api("/view-as", { personId: null });
                  location.assign("/");
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              Exit View as
            </button>
          ) : (
            <button onClick={() => logout().catch((e) => setError(e.message))}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <h1>
        {state?.profile
          ? [state.profile.firstName, state.profile.lastName].join(" ")
          : "Cadet workspace"}
      </h1>
      {preview && <strong>View as · Read-only</strong>}
      {state?.squadron && <p>{state.squadron} Squadron Commander</p>}
      {state?.flightCommander && <p>{flight} Flight</p>}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            onClick={() =>
              load()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            Reload
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!state && !error && <p role="status">Loading your workspace…</p>}
      {state && !preview && !state.writable && (
        <p>Submissions are paused.</p>
      )}
      {state?.profile && !state.linked && !preview && (
        <button
          disabled={busy || !state.writable}
          onClick={() => save("link", {})}
        >
          Connect my Directory record
        </button>
      )}
      {!!tabs.length && (
        <nav aria-label="Cadet workspace">
          {tabs.map((t) => (
            <button
              key={t}
              aria-current={page === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      )}
      {page === "Excusals" && (
        <Excusals
          list={list}
          busy={busy}
          readOnly={preview || disabled}
          propose={(_, p, done) =>
            save(
              "decide",
              {
                requestId: p.requestId,
                version: p.expectedVersion,
                decision: p.decision,
                reason: p.reason,
              },
              done,
            )
          }
        />
      )}
      {page === "My Flight" && (
        <Flight state={state} save={save} disabled={disabled} />
      )}
      {(state?.registration || page === "My profile") && (
        <Profile
          key={state.profile?.version || "new"}
          state={state}
          save={save}
          disabled={disabled}
        />
      )}
      {page === "My requests" && (
        <>
          <h2>My excusals</h2>
          {!state.requests.length ? (
            <p>No requests this term.</p>
          ) : (
            <Table
              headers={["Event", "Requested", "Status", "Decision reason"]}
            >
              {state.requests.map((r) => (
                <tr key={r.requestId}>
                  <td>{r.event}</td>
                  <td>{r.requestedOutcome}</td>
                  <td>
                    <Status>{r.status}</Status>
                  </td>
                  <td>{r.decisionReason || "—"}</td>
                </tr>
              ))}
            </Table>
          )}
          <Submission
            mode="excusal"
            state={state}
            save={save}
            disabled={disabled}
          />
          <h2>My attendance flags</h2>
          {state.actions
            .filter(
              (a) => a.kind === "flag" && a.personId === state.profile.personId,
            )
            .map((a) => (
              <p key={a.actionId}>
                <strong>{a.event}</strong> · {a.detail} ·{" "}
                {a.resolution || "Awaiting Flight review"}
              </p>
            ))}
          <Submission
            mode="flag"
            state={state}
            save={save}
            disabled={disabled}
          />
        </>
      )}
    </main>
  );
}
