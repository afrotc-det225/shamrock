import {ToolbarFilters} from "./ToolbarFilters";
import React, { useEffect, useState } from "react";
import { rateStyle } from "./roster-colors";
import { AttendanceKey, MatrixTable } from "./AttendanceMatrix";
import { Heading, SearchBox, Empty, LoadingRows } from "./components";
import { api } from "./api";
import { loadHistory } from "../history-client";

import { defaultRosterFilters, MatrixRosterFilters, selectRosterRows } from "./MatrixRosterFilters";
import { compactReport } from "../history-table.mjs";

const percentage = (value) => typeof value === "number" && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%` : value === null || value === undefined ? "—" : String(value);

export default function HistoricalAttendance({item, initialReport, semesterPicker}) {
  const [report, setReport] = useState(null), [error, setError] = useState(""),
    [query, setQuery] = useState(""), [filters, setFilters] = useState(defaultRosterFilters),
    [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!item || initialReport) return;
    const controller = new AbortController();
    const request = (path,body) => api(path,body,{signal:controller.signal});
    setError("");
    const load = item.file ? request("/history/report",{version:item.value}) :
      loadHistory(item.value,request).then(compactReport);
    load.then(result=>{if (!controller.signal.aborted) setReport(result);})
      .catch(e=>{if (!controller.signal.aborted) setError(e.message);});
    return () => controller.abort();
  },[item,initialReport,attempt]);
  const current = initialReport || report;
  const roster = current?.rows || [];
  const rows = selectRosterRows(roster, query, filters);
  const events = (current?.headers || []).map((label, eventId) => ({eventId, label}));
  return <>
    <section className="page-controls">
      <Heading title="Attendance" />
      <div className="toolbar">
        {semesterPicker}
        <SearchBox placeholder="Find a cadet" value={query} onChange={setQuery} />
        <ToolbarFilters active={Boolean(filters.year || filters.flight || filters.sort !== "seniority")}>
          <MatrixRosterFilters rows={roster} value={filters} onChange={setFilters} />
        </ToolbarFilters>
        <div className="toolbar-actions"><AttendanceKey /></div>
      </div>
    </section>
    {error && <div className="error" role="alert">{error} <button onClick={() => setAttempt(value=>value+1)}>Retry</button></div>}
    {!error && !current && item && <LoadingRows label="Loading historical attendance" rows={7} />}
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
