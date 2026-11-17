import React, { useState } from "react";
import { ArrowRight, Send } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import { api } from "./api";
export function Overview({ snapshot: s, reporting, history, navigate }) {
  const d = reporting?.dashboard;
  return (
    <>
      <Heading
        title="Overview"
        description={`${s.terms.find((t) => t.isCurrent)?.label || "Semester not configured"} · Detachment 225`}
      />
      <div className="metrics">
        <div>
          <strong>
            {d?.totalCadets ?? s.people.filter((p) => p.active).length}
          </strong>
          <span>Active cadets</span>
        </div>
        <div>
          <strong>
            {s.events.filter((e) => e.status === "active").length}
          </strong>
          <span>Active events</span>
        </div>
        <div>
          <strong>
            {s.requests.filter((r) => r.status === "Submitted").length}
          </strong>
          <span>Pending excusals</span>
        </div>
      </div>
      <section className="form-section">
        <h2>What needs your attention?</h2>
        {[
          ["Events", "Edit an event, its schedule or attendance roster."],
          ["Cadets", "Update profiles and Flight assignments."],
          [
            "Attendance & excusals",
            "Review excusals or correct an attendance record.",
          ],
          ["Semester", "Review cadets and prepare the next semester."],
        ].map(([title, copy]) => (
          <button
            key={title}
            className="task-row"
            onClick={() => navigate(title)}
          >
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
            <ArrowRight size={19} />
          </button>
        ))}
      </section>
      <section className="form-section">
        <h2>Recent changes</h2>
        {history.length ? (
          <History rows={history.slice(0, 5)} />
        ) : (
          <Empty>No panel changes have been submitted yet.</Empty>
        )}
      </section>
    </>
  );
}
export function History({ rows, retry, busy }) {
  return (
    <Table
      headers={["Change", "Prepared", "State", ...(retry ? ["Action"] : [])]}
    >
      {rows.map((r) => (
        <tr key={r.id}>
          <td>
            {r.summary.title}
            <small>{r.summary.target}</small>
          </td>
          <td>{new Date(r.created).toLocaleString()}</td>
          <td>
            <Status>{r.state === "complete" ? "Saved" : r.state}</Status>
          </td>
          {retry && (
            <td>
              {["retryable", "continuing", "applying"].includes(r.state) && (
                <button disabled={busy} onClick={() => retry(r.id)}>
                  Retry saved change
                </button>
              )}
            </td>
          )}
        </tr>
      ))}
    </Table>
  );
}
export function System({ snapshot, history, retry, busy }) {
  return (
    <>
      <Heading
        title="System"
        description="Check saved changes and recover interrupted requests."
      />
      <div className="notice">
        A saved change confirms the database accepted it. Spreadsheet and Form
        publication is a separate step. This local staging host does not publish
        to Google.
      </div>
      <section className="form-section">
        <h2>Change history</h2>
        <p>Retries reuse the original request, preventing duplicate changes.</p>
        <History rows={history} retry={retry} busy={busy} />
      </section>
      <details>
        <summary>Diagnostics</summary>
        {snapshot.diagnostics.length ? (
          <Table headers={["Finding", "Count"]}>
            {snapshot.diagnostics.map((d) => (
              <tr key={d.code}>
                <td>{d.code}</td>
                <td>{d.count}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p>
            No catalog diagnostics were reported. This is not a check of Google
            delivery or hosted service health.
          </p>
        )}
      </details>
    </>
  );
}
export function Assistant({ meta }) {
  const [messages, setMessages] = useState([]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const next = [...messages, { role: "user", content: text.trim() }].slice(
      -15,
    );
    setMessages(next);
    setText("");
    setBusy(true);
    setError("");
    try {
      const r = await api("/chat", { messages: next });
      setMessages([...next, { role: "assistant", content: r.content }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading
        title="Assistant"
        description="Optional help with SHAMROCK procedures."
      />
      <div className="notice">
        CRC access and usage limits may change, and this feature may be retired.
        Administrator tools work independently. This version can explain
        procedures; it cannot change records, modify code or repair bugs.
      </div>
      <p className="hint">
        {meta.assistantAvailable
          ? `Connected · ${meta.model}`
          : "CRC is not connected on this test host. No AI subscription is required to use the panel."}
      </p>
      <div className="conversation" aria-live="polite">
        {messages.map((m, i) => (
          <article key={i} className={`message ${m.role}`}>
            <strong>{m.role === "user" ? "You" : "SHAMROCK assistant"}</strong>
            <p>{m.content}</p>
          </article>
        ))}
        {busy && <p>Checking SHAMROCK procedures…</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <form className="chat-form" onSubmit={send}>
        <textarea
          aria-label="Ask SHAMROCK"
          placeholder="How do I prepare the next semester?"
          maxLength={6000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!meta.assistantAvailable}
        />
        <button
          className="primary"
          disabled={busy || !meta.assistantAvailable || !text.trim()}
        >
          <Send size={18} />
          Ask
        </button>
      </form>
    </>
  );
}
