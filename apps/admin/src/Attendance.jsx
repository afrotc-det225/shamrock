import React, { useState } from "react";
import {
  Heading,
  Select,
  Field,
  Editor,
  Table,
  Status,
  Empty,

  SearchBox,
} from "./components";
import { AttendanceMatrix, AttendanceKey } from "./AttendanceMatrix";
import { compareCadetsForDisplay } from "../../../packages/domain/src/cadet-display-order";
import { alphabetic, textOrder } from "./RosterViews";
import { name,eventTypes } from "./api";
import { currentExcusalRequests } from "./attendance-events.mjs";
export default function Attendance({ snapshot, list, tab="attendance", onTab, reporting, propose, busy, readOnly = false }) {
  const s = snapshot || list;
  const [eventType,setEventType]=useState(""), [week,setWeek]=useState(""), [query,setQuery]=useState(""),
    [sort,setSort]=useState("seniority"), [queueStatus,setQueueStatus]=useState("Submitted"),
    [flight, setFlight] = useState(""),
    [edit, setEdit] = useState(null),
    [reason, setReason] = useState(""),
    [code, setCode] = useState("P");
  const scoped = s.access && !s.access.capabilities.fullSnapshot;
  const canCorrect = (p) =>
    !scoped ||
    s.access.capabilities.attendanceCorrectionFlightIds.includes(p.flightId);
  const termId=s.terms.find(t=>t.isCurrent)?.termId;
  const matrix=reporting?.matrices.find(m=>m.termId===termId);
  const catalog=new Map(s.events.map(e=>[e.eventId,e]));
  const events=(matrix?.eventColumns || []).map(e=>catalog.get(e.eventId)).filter(Boolean);
  const weeks=[...new Set(events.map(e=>e.trainingWeek).filter(w=>w!=null))].sort((a,b)=>a-b);
  const columns=events.filter(e=>(!eventType || e.eventType===eventType) && (!week || String(e.trainingWeek)===week));
  const search = text => text.toLowerCase().includes(query.trim().toLowerCase());
  const rows=(matrix?.rows || []).filter(p=>(!flight || p.flightId===flight) && search(name(p))).sort((a,b)=>{
    if(sort==="name")return alphabetic(a,b);
    if(sort==="overall")return (a.overall.noCountedAttendance ? Infinity : a.overall.percentage)-(b.overall.noCountedAttendance ? Infinity : b.overall.percentage) || alphabetic(a,b);
    if(sort==="flight")return textOrder(a.flight,b.flight) || compareCadetsForDisplay(a,b);
    return compareCadetsForDisplay(a,b);
  });
  const queue=currentExcusalRequests(s);
  const people=new Map(s.people.map(p=>[p.personId,p]));
  const requests=queue.filter(r=>(!flight || r.flightId===flight) && (!queueStatus || queueStatus===r.status) &&
    search((r.personDisplayName || name(people.get(r.personId)))+" "+(catalog.get(r.eventId)?.label || "")));
  const correction=(person,event,currentCode)=>{
    setReason("");setCode(currentCode);
    const base=s.attendanceVersions.find(v=>v.personId===person.personId && v.eventId===event.eventId);
    setEdit({person,event,baseVersion:base?.version || 0});
  };
  return (
    <>
      <section className="page-controls">
        <Heading title="Attendance & excusals" />
        <div className="tabs">
          <button
            aria-pressed={tab === "attendance"}
            onClick={() => onTab("attendance")}
          >
            Attendance
          </button>
          <button
            aria-pressed={tab === "excusals"}
            onClick={() => onTab("excusals")}
          >
            Excusals (
            {queue.filter((r) => r.status === "Submitted").length} pending)
          </button>
          {tab==="attendance" && <AttendanceKey/>}
        </div>
        <div className="toolbar">
          <SearchBox placeholder={tab==="attendance"?"Find a cadet":"Find cadet or event"} value={query} onChange={setQuery}/>
          {tab==="attendance" ? <>
            <Select label="Event type" value={eventType} onChange={setEventType} options={[{value:"",label:"All events"},...Object.entries(eventTypes).map(([value,label])=>({value,label}))]}/>
            <Select label="Training week" value={week} onChange={setWeek} options={[{value:"",label:"All weeks"},...weeks.map(w=>({value:String(w),label:"TW-"+w}))]}/>
            <Select label="Sort by" value={sort} onChange={setSort} options={[{value:"seniority",label:"AS year, then name"},{value:"name",label:"Last name"},{value:"flight",label:"Flight"},{value:"overall",label:"Lowest overall"}]}/>
          </> : <Select label="Decision status" value={queueStatus} onChange={setQueueStatus} options={[{value:"",label:"All decisions"},...new Set(["Submitted",...queue.map(r=>r.status)])]}/>}
          <Select
            label="Flight"
            value={flight}
            onChange={setFlight}
            options={[
              { value: "", label: "All Flights" },
              ...s.flights.map((f) => ({ value: f.flightId, label: f.label })),
            ]}
          />
        </div>
      </section>
      {tab === "attendance" ? (
        <><AttendanceMatrix rows={rows} events={columns} canCorrect={canCorrect} onEdit={correction} readOnly={readOnly || busy}/>
        {(!rows.length || !columns.length) && <Empty>No attendance matches these filters.</Empty>}</>
      ) : (
        <Table headers={["Cadet / event", "Request", "Reason", "Status", ""]}>
          {requests.map((r) => (
            <tr key={r.requestId}>
              <td>
                {r.personDisplayName ||
                  name(s.people.find((p) => p.personId === r.personId))}
                <small>
                  {s.events.find((e) => e.eventId === r.eventId)?.label}
                </small>
              </td>
              <td>{r.requestedOutcome}</td>
              <td>{r.reason}</td>
              <td>
                <Status>{r.status}</Status>
              </td>
              <td>
                {(!scoped || r.canDecide === true) && (
                  <button
                    disabled={readOnly}
                    onClick={() => {
                      setReason("");
                      setCode("Approved");
                      setEdit({ request: r });
                    }}
                  >
                    Review
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {tab==="excusals" && !requests.length && <Empty>No requests match these filters.</Empty>}
      {edit && (edit.request ? queue.some(r => r.requestId === edit.request.requestId) : events.some(e=>e.eventId===edit.event.eventId)) && (
        <Editor
          title={edit.request ? "Review excusal" : "Correct attendance"}
          bottomSheet={!edit.request}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            propose(
              edit.request ? "excusal.decide" : "attendance.correct",
              edit.request
                ? {
                    requestId: edit.request.requestId,
                    expectedVersion: edit.request.version,
                    decision: code,
                    reason,
                  }
                : {
                    personId: edit.person.personId,
                    eventId: edit.event.eventId,
                    expectedBaseVersion: edit.baseVersion,
                    expectedEventVersion: edit.event.version,
                    code: code || null,
                    reason,
                  },
              () => setEdit(null),
            )
          }
        >
          <p>
            {edit.request
              ? edit.request.personDisplayName ||
                name(s.people.find((p) => p.personId === edit.request.personId))
              : name(edit.person)}{" "}
            ·{" "}
            {edit.request
              ? s.events.find((e) => e.eventId === edit.request.eventId)?.label
              : edit.event.label}
          </p>
          {edit.request && <blockquote>{edit.request.reason}</blockquote>}
          <Select
            label={edit.request ? "Decision" : "Attendance code"}
            value={code}
            onChange={setCode}
            options={
              edit.request
                ? ["Approved", "Denied", "Withdrawn", "Superseded"]
                : [
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
                  ]
            }
          />
          <Field label="Reason for this change">
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </Editor>
      )}
    </>
  );
}
