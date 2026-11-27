import { ToolbarFilters } from "./ToolbarFilters";
import React, { useState } from "react";
import { Heading, Select, Field, Editor, Empty, SearchBox } from "./components";
import { AttendanceMatrix } from "./AttendanceMatrix";
import { defaultRosterFilters, MatrixRosterFilters, selectRosterRows } from "./MatrixRosterFilters";
import { api, name, eventTypes } from "./api";
export default function Attendance({
  semesterPicker,
  snapshot,
  list,
  reporting,
  propose,
  busy, run, refresh, notify, viewEntry,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [eventType, setEventType] = useState(""),
    [week, setWeek] = useState(""),
    [query, setQuery] = useState(""),
    [filters, setFilters] = useState(defaultRosterFilters),
    [edit, setEdit] = useState(null),
    [reason, setReason] = useState(""),
    [code, setCode] = useState("P");
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  const canCorrect = (p) =>
    !scoped ||
    s.access.capabilities.attendanceCorrectionFlightIds.includes(p.flightId);
  const termId = s.terms.find((t) => t.isCurrent)?.termId;
  const matrix = reporting?.matrices.find((m) => m.termId === termId);
  const catalog = new Map(s.events.map((e) => [e.eventId, e]));
  const events = (matrix?.eventColumns || [])
    .map((e) => catalog.get(e.eventId))
    .filter(Boolean);
  const weeks = [
    ...new Set(events.map((e) => e.trainingWeek).filter((w) => w != null)),
  ].sort((a, b) => a - b);
  const columns = events.filter(
    (e) =>
      (!eventType || e.eventType === eventType) &&
      (!week || String(e.trainingWeek) === week),
  );
  const roster = matrix?.rows || [];
  const rows = selectRosterRows(roster, query, filters);
  const [review,setReview] = useState(null);
  const [generation,resetSelection]=useState(0);
  function dismiss(){setEdit(null);setReview(null);resetSelection(n=>n+1);}
  const startCorrection = targets => {
    if(busy)return;
    setReview(null);
    if(!targets.length){setEdit(null);return;}
    setReason("");
    const codes=new Set(targets.map(t=>t.cell.effectiveCode || ""));
    setCode(codes.size===1 ? [...codes][0] : "choose");
    const versions=new Map(s.attendanceVersions.map(v=>[JSON.stringify([v.personId,v.eventId]),v.version]));
    setEdit(targets.map(({row,event})=>({
      label:name(row)+" · "+event.label,
      personId:row.personId,eventId:event.eventId,expectedEventVersion:event.version,
      expectedBaseVersion:versions.get(JSON.stringify([row.personId,event.eventId])) || 0
    })));
  };
  function submit() {
    const payloads=edit.map(({label,...target})=>({...target,code:code || null,reason}));
    if(payloads.length===1) return propose("attendance.correct",payloads[0],dismiss);
    setReview({payloads,next:0,proposalId:null});
  }
  function applySelected() {
    return run(async()=>{
      const identity=viewEntry ? {viewEntry} : {};
      while(review.next<review.payloads.length){
        if(!review.proposalId){
          const proposal=await api("/proposals",{operation:"attendance.correct",payload:review.payloads[review.next],...identity});
          review.proposalId=proposal.id;
        }
        await api("/proposals/"+review.proposalId+"/apply",{approved:true,...identity});
        review.next++;
        review.proposalId=null;
        setReview({...review});
      }
      dismiss();
      notify("Attendance corrections saved.");
      await refresh(true);
    });
  }
  return (
    <>
      <section className="page-controls">
        <Heading title="Attendance" />
        <div className="toolbar attendance-toolbar">
          {semesterPicker}
          <SearchBox
            placeholder="Find a cadet"
            value={query}
            onChange={value=>{setQuery(value);if(edit)dismiss();}}
          />
          <ToolbarFilters active={Boolean(eventType || week || filters.flight || filters.year || filters.sort !== "seniority")}>
            <Select
              label="Event type"
              value={eventType}
              onChange={value=>{setEventType(value);if(edit)dismiss();}}
              options={[
                { value: "", label: "All events" },
                ...Object.entries(eventTypes).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
            />
            <Select
              label="Training week"
              value={week}
              onChange={value=>{setWeek(value);if(edit)dismiss();}}
              options={[
                { value: "", label: "All weeks" },
                ...weeks.map((w) => ({ value: String(w), label: "TW-" + w })),
              ]}
            />
            <MatrixRosterFilters rows={roster} value={filters} onChange={value=>{setFilters(value);if(edit)dismiss();}} />
          </ToolbarFilters>
        </div>
      </section>
      <AttendanceMatrix
        rows={rows}
        events={columns}
        canCorrect={canCorrect}
        key={generation}
        onSelection={startCorrection}
        readOnly={readOnly || busy}
      />
      {(!rows.length || !columns.length) && (
        <Empty>No attendance matches these filters.</Empty>
      )}
      {edit && (
        <Editor title={review ? "Review corrections" : "Correct attendance"} bottomSheet
          busy={busy || (!review && code==="choose")}
          submitLabel={review ? "Apply corrections" : "Review change"}
          onClose={()=>{if(!busy)dismiss();}}
          onSubmit={review ? applySelected : submit}>
          <ul className="correction-targets" role="list">{edit.map(t=><li key={JSON.stringify([t.personId,t.eventId])}>{t.label}</li>)}</ul>
          {review ? <><p>{code || "Clear to blank"} · {reason}</p>
            {review.next>0 && <p role="status">{review.next} of {edit.length} saved</p>}</> : <>
          <Select
            label="Attendance code"
            value={code}
            onChange={setCode}
            options={[
              ...(code==="choose" ? [{value:"choose",label:"Choose a code"}] : []),
              { value: "", label: "Clear to blank" },
              "P",
              "T",
              "A",
              "U",
              "E",
              "ES",
              "MED",
              "R",
              "D",
              "N/A",
            ]}
          />
          <Field label="Reason for this change">
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field></>}
        </Editor>
      )}
    </>
  );
}
