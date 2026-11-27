import React, { useEffect, useState } from "react";
import { rateStyle } from "./roster-colors";
import { AttendanceKey, MatrixTable } from "./AttendanceMatrix";
import { Heading, Select, SearchBox, Empty, LoadingRows } from "./components";
import { api } from "./api";
import { loadHistory } from "../history-client";

import { defaultRosterFilters, MatrixRosterFilters, selectRosterRows } from "./MatrixRosterFilters";
import { compactReport } from "../history-table.mjs";

const percentage = (value) => typeof value === "number" && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%` : value === null || value === undefined ? "—" : String(value);

export default function History() {
  const [catalog, setCatalog] = useState(null), [selected, setSelected] = useState(""),
    [report, setReport] = useState(null), [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [filters, setFilters] = useState(defaultRosterFilters), [attempt, setAttempt] = useState(0),
    [reportAttempt, setReportAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setCatalog(null); setSelected("");
    api("/history/list?include=latest", undefined, {signal:controller.signal}).then(result => {
      if (controller.signal.aborted) return;
      const options = result.semesters
        ? result.semesters.map(s => ({value:s.version, label:s.label, file:true}))
        : result.snapshots.map(s => ({value:s.snapshotId, label:s.periodLabel || s.title}));
      setCatalog(options);
      setSelected((result.semesters ? options.at(-1) : options[0])?.value || "");
      if (result.latest) setReport(result.latest);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const item = catalog?.find(option => option.value === selected);
    if (!item || report?.version === selected) return;
    const controller = new AbortController();
    const request = (path, body) => api(path, body, {signal:controller.signal});
    setReport(null); setError(""); setFilters(defaultRosterFilters); setQuery("");
    const load = item.file ? request("/history/report", {version:selected}) :
      loadHistory(selected, request).then(compactReport);
    load.then(value => {
      if (!controller.signal.aborted) { setReport({version:selected, report:value}); }
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); } });
    return () => controller.abort();
  }, [selected, catalog, reportAttempt]);
  const current = report?.version === selected ? report?.report : null;
  const roster = current?.rows || [];
  const rows = selectRosterRows(roster, query, filters);
  const events = (current?.headers || []).map((label, eventId) => ({eventId, label}));
  return <>
    <section className="page-controls">
      <Heading title="History"><AttendanceKey /></Heading>
      {catalog?.length !== 0 && <div className="toolbar">
        <Select label="Semester" value={selected} onChange={setSelected} disabled={!catalog} options={catalog || [{value:"", label:"Semester"}]} />
        <SearchBox placeholder="Find a cadet" value={query} onChange={setQuery} />
        <MatrixRosterFilters rows={roster} value={filters} onChange={setFilters} />
      </div>}
    </section>
    {error && <div className="error" role="alert">{error} <button onClick={() => { setError(""); if (selected) setReportAttempt(value => value + 1); else setAttempt(value => value + 1); }}>Retry</button></div>}
    {!error && !current && catalog?.length !== 0 && <LoadingRows label="Loading historical attendance" rows={7} />}
    {catalog?.length === 0 && <Empty>No archived reports.</Empty>}
    {current && <>
      {(current.summary.unresolvedRows > 0 || current.summary.formulaMismatches > 0) &&
        <p className="notice">{current.summary.unresolvedRows > 0 ? `${current.summary.unresolvedRows} historical identities are not linked to the current Directory. ` : ""}
          {current.summary.formulaMismatches > 0 ? `${current.summary.formulaMismatches} saved percentages differ from their recorded formulas. ` : ""}
          Original values are retained.</p>}
      <MatrixTable label="History" events={events}>
        {rows.map(row => <tr key={row.rowId}>
          <th scope="row">{[row.firstName, row.lastName].filter(Boolean).join(" ")}
            {row.identityStatus === "unresolved" && <small className="history-unlinked">Historical record</small>}</th>
          <td className="formation" style={rateStyle(row.overall)}>{percentage(row.overall)}</td>
          <td className="formation" style={rateStyle(row.llab)}>{percentage(row.llab)}</td>
          {row.codes.map((code, index) => <td className="mark-cell history-code" data-mark={String(code ?? "").trim().toUpperCase() || "blank"} key={index}>{String(code ?? "")}</td>)}
        </tr>)}
      </MatrixTable>
      {!rows.length && <Empty>No matching cadets.</Empty>}
    </>}
  </>;
}
