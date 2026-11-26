import React, { useEffect, useState } from "react";
import { Heading, Select, SearchBox, Table, Empty } from "./components";
import { api } from "./api";
import { loadHistory } from "../history-client";

import { compactReport } from "../history-table.mjs";

const percentage = (value) => typeof value === "number" && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%` : value === null || value === undefined ? "—" : String(value);

export default function History() {
  const [catalog, setCatalog] = useState(null), [selected, setSelected] = useState(""),
    [report, setReport] = useState(null), [error, setError] = useState(""),
    [progress, setProgress] = useState(""), [query, setQuery] = useState(""),
    [flight, setFlight] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setCatalog(null); setSelected(""); setProgress("Loading semesters…");
    api("/history/list", undefined, {signal:controller.signal}).then(result => {
      const options = result.semesters
        ? result.semesters.map(s => ({value:s.version, label:s.label, file:true}))
        : result.snapshots.map(s => ({value:s.snapshotId, label:s.periodLabel || s.title}));
      setCatalog(options);
      setSelected((result.semesters ? options.at(-1) : options[0])?.value || "");
      setProgress("");
    }).catch(e => { if (!controller.signal.aborted) { setProgress(""); setError(e.message); } });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const item = catalog?.find(option => option.value === selected);
    if (!item) return;
    const controller = new AbortController();
    const request = (path, body) => api(path, body, {signal:controller.signal});
    setReport(null); setError(""); setFlight(""); setQuery(""); setProgress("Loading " + item.label + "…");
    const load = item.file ? request("/history/report", {version:selected}) :
      loadHistory(selected, request).then(compactReport);
    load.then(value => {
      if (!controller.signal.aborted) { setReport(value); setProgress(""); }
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setProgress(""); } });
    return () => controller.abort();
  }, [selected, catalog]);
  const rows = report?.rows.filter(row => (!flight || row.flight === flight) &&
    `${row.firstName} ${row.lastName}`.toLowerCase().includes(query.toLowerCase())) || [];
  return <>
    <section className="page-controls">
      <Heading title="History" />
      {catalog?.length > 0 && <div className="toolbar">
        <Select label="Semester" value={selected} onChange={setSelected} options={catalog} />
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
      <Table headers={["Cadet", "AS year", "Flight", "Overall", "LLAB", ...report.headers]}>
        {rows.map(row => <tr key={row.rowId}>
          <td>{[row.firstName, row.lastName].filter(Boolean).join(" ")}
            {row.identityStatus === "unresolved" && <small className="history-unlinked">Historical record</small>}</td>
          <td>{row.asYear}</td><td>{row.flight || "—"}</td>
          <td>{percentage(row.overall)}</td><td>{percentage(row.llab)}</td>
          {row.codes.map((code, index) => <td className="history-code" key={index}>{String(code ?? "")}</td>)}
        </tr>)}
      </Table>
      {!rows.length && <Empty>No matching cadets.</Empty>}
    </>}
  </>;
}
