import React, { useState } from "react";
import OverviewInsights from "./OverviewInsights";
import { Send } from "lucide-react";
import { Heading, Table, Status, Empty } from "./components";
import { api } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";
import { useReceipts, ReceiptStatus } from "./receipts";
export function Overview({ snapshot: s, overview, reporting, history, receiptsDeferred, reportingTime, captureKey, navigate, readOnly = false, ...details }) {
  const d = reporting?.dashboard;
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey, enabled: !readOnly });
  return (
    <>
      <Heading
        title="Overview"
        description={`${overview?.term || s?.terms.find((t) => t.isCurrent)?.label || "Semester not configured"} · Detachment 225`}
      />
      <div className="metrics">
        <div>
          <strong>
            {overview?.activeCadets ?? d?.totalCadets ?? s.people.filter((p) => p.active).length}
          </strong>
          <span>Active cadets</span>
        </div>
        <div>
          <strong>
            {overview?.activeEvents ?? s.events.filter((e) => e.status === "active").length}
          </strong>
          <span>Active events</span>
        </div>
        <div>
          <strong>
            {overview?.pending ?? currentExcusalRequests(s).filter(r => r.status === "Submitted").length}
          </strong>
          <span>Pending excusals</span>
        </div>
      </div>
      <OverviewInsights {...details} overview={overview} snapshot={s} reporting={reporting} reportingTime={reportingTime} captureKey={captureKey}/>
      {!readOnly && <section className="form-section">
        <h2>Recent changes</h2>
        <ReceiptStatus receipt={receipt} />
        {receipt.rows === null ? null : receipt.rows.length ? (
          <History rows={receipt.rows.slice(0, 5)} />
        ) : (
          <Empty>No changes yet.</Empty>
        )}
      </section>}
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
export function System({ snapshot, history, receiptsDeferred, reportingTime, captureKey, retry, busy }) {
  const receipt = useReceipts({ history, receiptsDeferred, reportingTime, captureKey });
  return (
    <>
      <Heading
        title="System"
      />
      <div className="notice">
        Spreadsheet and Form sync may finish after a change is saved.
      </div>
      <section className="form-section">
        <h2>Change history</h2>
        <ReceiptStatus receipt={receipt} />
        {receipt.rows !== null && <History rows={receipt.rows} retry={retry} busy={busy} />}
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
          <p>No catalog issues were reported.</p>
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
      />
      <div className="notice">
        CRC access and usage limits may change, and this feature may be retired.
        Administrator tools work independently. This version can explain
        procedures; it cannot change records, modify code or repair bugs.
      </div>
      <p className="hint">
        {meta.assistantAvailable
          ? `Connected · ${meta.model}`
          : "The assistant is currently unavailable. All administrator tools remain available."}
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
