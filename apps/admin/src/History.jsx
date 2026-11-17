import React, { useEffect, useState } from "react";
import { Heading, Select, SearchBox, Table, Empty } from "./components";
import { api } from "./api";
import { loadHistory } from "../history-client";

const percentage = (value) => typeof value === "number" && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%` : value === null || value === undefined ? "—" : String(value);

export default function History() {
  const [catalog, setCatalog] = useState(null), [selected, setSelected] = useState(""),
    [report, setReport] = useState(null), [error, setError] = useState(""),
    [progress, setProgress] = useState(""), [query, setQuery] = useState(""),
    [flight, setFlight] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api("/history/list").then(result => {
      if (active) { setCatalog(result.snapshots); setSelected(result.snapshots[0]?.snapshotId || ""); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setReport(null); setError(""); setFlight(""); setQuery(""); setProgress("Loading report…");
    const request = async (...args) => {
      if (!active) throw new Error("Loading stopped.");
      const result = await api(...args);
      if (!active) throw new Error("Loading stopped.");
      return result;
    };
    loadHistory(selected, request, (count, total) => {
      if (active) setProgress(`Loading report: ${count} of ${total} cadets`);
    }).then(value => { if (active) { setReport(value); setProgress(""); } })
      .catch(e => { if (active) { setError(e.message); setProgress(""); } });
    return () => { active = false; };
  }, [selected, attempt]);
  const rows = report?.rows.filter(row => (!flight || row.flight === flight) &&
    `${row.firstName} ${row.lastName}`.toLowerCase().includes(query.toLowerCase())) || [];
  return <>
    <section className="page-controls">
      <Heading title="History" />
      {catalog?.length > 0 && <div className="toolbar">
        <Select label="Report" value={selected} onChange={setSelected}
          options={catalog.map((item, index) => ({ value: item.snapshotId,
            label: `${item.periodLabel || item.title} · ${item.title} (${index + 1})` }))} />
        <SearchBox placeholder="Find a cadet" value={query} onChange={setQuery} />
        <Select label="Flight" value={flight} onChange={setFlight}
          options={[{value:"",label:"All Flights"}, ...[...new Set(report?.rows.map(row => row.flight).filter(Boolean))].sort()]} />
      </div>}
    </section>
    {error && <div className="error" role="alert">{error} <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry</button></div>}
    {progress && <p role="status">{progress}</p>}
    {catalog?.length === 0 && <Empty>No archived reports.</Empty>}
    {report && <>
      <p className="history-caption">{report.rows.length} cadets · Saved attendance and percentages</p>
      {(report.summary.unresolvedRows > 0 || report.summary.formulaMismatches > 0) &&
        <p className="notice">{report.summary.unresolvedRows > 0 ? `${report.summary.unresolvedRows} historical identities are not linked to the current Directory. ` : ""}
          {report.summary.formulaMismatches > 0 ? `${report.summary.formulaMismatches} saved percentages differ from their recorded formulas. ` : ""}
          Original values are retained.</p>}
      <Table headers={["Cadet", "AS year", "Flight", "Overall", "LLAB", ...report.eventColumns.map(column => column.header)]}>
        {rows.map(row => <tr key={row.rowId}>
          <td>{[row.firstName, row.lastName].filter(Boolean).join(" ")}
            {row.identityStatus === "unresolved" && <small className="history-unlinked">Historical record</small>}</td>
          <td>{row.asYear}</td><td>{row.flight || "—"}</td>
          <td>{percentage(row.overall.stored)}</td><td>{percentage(row.llab.stored)}</td>
          {report.eventColumns.map(column => <td className="history-code" key={column.snapshotEventId}>
            {String(row.cells.find(cell => cell.eventId === column.snapshotEventId)?.code ?? "")}
          </td>)}
        </tr>)}
      </Table>
      {!rows.length && <Empty>No matching cadets.</Empty>}
    </>}
  </>;
}
