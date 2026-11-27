// These indexes contain source facts only. The caller checks the Directory identity
// and current enrollment in the same primary transaction before returning any rows.
import {cadetAttendanceFacts} from "./frontend-transport.js";
import {baselineRevisionSql} from "./corrections.js";
import {resolveCell,type ReportingObservation,type ReportingCorrection,type ReportingLegacyBaseline,type ReportingRequest} from "../../../packages/domain/src/frontend-reporting.js";
type Row=Record<string,unknown>;
export function personalAttendanceQueries(db:D1Database,email:string){
  const identity="SELECT person_id FROM directory_profiles WHERE lower(email)=?";
  const packed=db.prepare(`WITH me AS (SELECT person_id,flight_id FROM directory_profiles WHERE lower(email)=?),
    term AS (SELECT term_id FROM terms WHERE is_current=1)
    SELECT kind,entries FROM cadet_attendance_index WHERE (kind,bucket) IN (
      VALUES ('events','*'),('event_details',(SELECT term_id FROM term)),('event_units',(SELECT flight_id FROM me)),
      ('event_roster_versions','*'),('event_roster_members',(SELECT person_id FROM me)),('legacy_attendance_baselines',(SELECT person_id FROM me)))`).bind(email);
  const facts=[["o",cadetAttendanceFacts.observations],["c",cadetAttendanceFacts.corrections]] as const;
  return [packed,db.prepare(`SELECT import_run_id AS id,${baselineRevisionSql} AS rev FROM legacy_import_runs i WHERE state='complete'`),
    ...facts.map(([alias,f])=>db.prepare(`SELECT ${f.select} ${f.from} WHERE ${alias}.person_id=(${identity})`).bind(email)),
    db.prepare(`SELECT r.request_id AS requestId,r.person_id AS personId,r.event_id AS eventId,r.status,r.requested_outcome AS requestedOutcome,
      COALESCE(a.audit_id,0) AS 'order',(r.origin='legacy' AND r.last_command_id IS NULL) AS legacyStateOnly
      FROM excusal_records r LEFT JOIN audit_events a ON a.command_id=r.last_command_id WHERE r.person_id=(${identity})
      AND (r.origin='native' OR r.last_command_id IS NOT NULL)
      AND (r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions l WHERE l.adoption_id=r.legacy_adoption_id AND l.state='complete'))
      ORDER BY r.submitted_at,r.request_id`).bind(email),
    db.prepare(`SELECT a.action_id AS actionId,a.kind,a.detail,a.accepted_at AS acceptedAt,a.subject_person_id AS personId,
      e.label AS event,resolved.detail AS resolution FROM cadet_workspace_actions a LEFT JOIN events e ON e.event_id=a.event_id
      LEFT JOIN cadet_workspace_actions resolved ON resolved.parent_id=a.action_id
      WHERE a.subject_person_id=(${identity}) AND a.kind='flag' ORDER BY a.accepted_at DESC`).bind(email)];
}
export function personalAttendance(personId:string,rows:Row[][]){
  const [packed,imports,observations,corrections,requests,flags]=rows;
  type Value=string|number|null;
  const packs=new Map(packed.map(r=>[r.kind,Object.values(JSON.parse(String(r.entries))) as Value[][]]));
  const get=(kind:string)=>packs.get(kind)??[];
  const labels=new Map(get("events").map(([id,label])=>[id,label]));
  const flights=new Set(get("event_units").map(([id])=>id));
  const versions=(kind:string)=>new Set(get(kind).map(pair=>JSON.stringify(pair)));
  const rosters=versions("event_roster_versions"),eligible=versions("event_roster_members");
  const revisions=new Map(imports.map(r=>[r.id,Number(r.rev)]));
  const bases=new Map(get("legacy_attendance_baselines").filter(r=>revisions.has(r[2])).map(([id,code,run,baselineId])=>
    [id,{baselineId:String(baselineId),eventId:String(id),personId,code:code as ReportingLegacyBaseline["code"],baselineRevision:Number(revisions.get(run))}]));
  const attendance=get("event_details").filter(([id,,,,,version,,status])=>{
    const key=JSON.stringify([id,version]);
    return status==="active" && labels.has(id) && flights.has(id) && (!rosters.has(key)||eligible.has(key));
  }).sort((a,b)=>Number(a[6])-Number(b[6]) || (String(a[0])<String(b[0])?-1:1))
    .map(([eventId,termId,eventType,columnLabel,trainingWeek,version])=>{
      const pair=(facts:Row[])=>facts.filter(f=>f.eventId===eventId);
      const obs=pair(observations),cor=pair(corrections),req=pair(requests),base=bases.get(eventId);
      const cell=resolveCell({eventId:String(eventId),termId:String(termId)},personId,obs as unknown as ReportingObservation[],
        cor as unknown as ReportingCorrection[],req as unknown as ReportingRequest[],true,[],base);
      return {eventId,label:labels.get(eventId),termId,eventType,columnLabel,trainingWeek,version,code:cell.effectiveCode,needsReview:cell.needsReview,
        baseVersion:Number(base?.baselineRevision||0)+Math.max(0,...[...obs,...cor,...req].map(r=>Number(r.order)))};
    });
  return {attendance,flags};
}
