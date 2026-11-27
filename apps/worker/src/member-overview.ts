// Membership is checked before and after these reads in readCadetWorkspace.
// Only aggregate attendance and birthday month/day are returned to the panel.
import {
  buildFrontendReporting, overviewRoster, REPORTING_POLICY_VERSION, type FrontendReportingInput,
} from "../../../packages/domain/src/frontend-reporting.js";
import {scopeCte, semesterQueries} from "./frontend-transport.js";
import {HttpError} from "./http-error.js";

type Report = FrontendReportingInput;
type EventRow = Omit<Report["events"][number],"eligiblePersonIds"> & {hasRoster:number};
type Stamp = {termId:string; operations:number; administration:number};

export async function memberOverview(db:D1Database, charts:boolean) {
  const revision = db.prepare(`SELECT
    (SELECT term_id FROM terms WHERE is_current=1) AS termId,
    (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,
    (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration`);
  if (!charts) {
    const [head,roster,flights,squadrons,terms] = await db.batch<Record<string,string>>([
      revision,
      db.prepare(`SELECT first_name,last_name,substr(date_of_birth,6,5) AS birthday,flight_id,as_year,university
        FROM directory_profiles WHERE flight_path_status NOT IN ('Commissioned','Dropped','Inactive')`),
      db.prepare(`SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId
        FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id`),
      db.prepare("SELECT squadron_id AS squadronId,label FROM squadrons"),
      db.prepare("SELECT label FROM terms WHERE is_current=1"),
    ]);
    return {
      stamp:head.results[0],
      overview:{...overviewRoster(roster.results.map(r=>[r.as_year,r.university,1])),term:terms.results[0]?.label},
      birthdayCalendar:roster.results.filter(r=>r.birthday).map(r=>[r.first_name,r.last_name,r.birthday,r.flight_id]),
      birthdayFlights:flights.results,
      birthdaySquadrons:squadrons.results,
    };
  }

  function query(key:keyof typeof semesterQueries, fields:string) {
    const q=semesterQueries[key];
    return db.prepare(scopeCte+"SELECT "+fields+" FROM (SELECT "+q.select+" "+q.from+")").bind(null);
  }
  const [head,people,flights,squadrons,terms,events,roster,observations,corrections,baselines,requests] = await db.batch([
    revision,
    query("people","personId,lastName,firstName,asYear,flightId,flightPathStatus,NULL AS dateOfBirth"),
    query("flights","flightId,label,squadronId"), query("squadrons","squadronId,label"), query("terms","termId,label,sortOrder"),
    query("events","eventId,termId,coalesce(nullif(columnLabel,''),label) AS label,eventType AS type,status,trainingWeek,displayOrder,hasRoster"),
    query("eventRosters","eventId,personId"), query("observations","*"), query("corrections","*"),
    query("legacyBaselines","baselineId,personId,eventId,code"),
    query("requests",'requestId,personId,eventId,"order",status,requestedOutcome,legacyStateOnly'),
  ]);
  const stamp=head.results[0] as Stamp | undefined;
  if (!stamp?.termId) throw new HttpError(409,"SNAPSHOT_CHANGED","The current semester is unavailable.");
  const eligible=new Map<string,string[]>();
  for(const row of roster.results as {eventId:string;personId:string}[]) {
    const members=eligible.get(row.eventId) ?? [];
    members.push(row.personId);
    eligible.set(row.eventId,members);
  }
  const profiles=people.results as Report["people"];
  const semesters=terms.results as Report["terms"];
  const ids=new Set(profiles.map(row=>row.personId));
  const {dashboard}=buildFrontendReporting({
    policyVersion:REPORTING_POLICY_VERSION, currentTermId:stamp.termId,
    asOfDate:new Intl.DateTimeFormat("en-CA",{timeZone:"America/Indiana/Indianapolis"}).format(new Date()),
    people:profiles, flights:flights.results as Report["flights"], squadrons:squadrons.results as Report["squadrons"], terms:semesters,
    events:(events.results as EventRow[]).map(row=>({...row,eligiblePersonIds:row.hasRoster ? eligible.get(row.eventId) ?? [] : null})),
    observations:observations.results as Report["observations"], corrections:corrections.results as Report["corrections"],
    legacyBaselines:baselines.results as Report["legacyBaselines"],
    requests:(requests.results as Report["requests"]).filter(row=>ids.has(row.personId)).map(row=>({...row,legacyStateOnly:!!row.legacyStateOnly})),
  });
  const {averageOverall,averageLlab,belowEighty,gmcCadets,pocCadets,noCountedAttendanceCadets,rosterByYear,attendanceByYear,attendanceByFlight}=dashboard;
  return {stamp,termLabel:semesters.find(term=>term.termId===stamp.termId)?.label,
    dashboard:{averageOverall,averageLlab,belowEighty,gmcCadets,pocCadets,noCountedAttendanceCadets,rosterByYear,attendanceByYear,attendanceByFlight}};
}
