// The school sign-in and an administrator's audited preview use the same Directory read model.
import {
  directoryLeadershipRole,
  operationallyActive,
  type DirectoryRecord,
} from "../../../packages/domain/src/admin.js";
import {memberOverview} from "./member-overview.js";
import { assignFlightRole } from "./flight-role-assignment.js";
import { currentFlightEvent, flightAttendance, scheduledFlightEvents, type ScheduledFlightEvent } from "./flight-attendance.js";
import { HttpError } from "./http-error.js";
import { acceptAttendanceCorrection, pairRevisionSql } from "./corrections.js";
import { ATTENDANCE_CODES, type AttendanceCode } from "../../../packages/domain/src/index.js";
import {personalAttendance,personalAttendanceQueries} from "./cadet-personal-attendance.js";
import { directoryCatalogQuery, leadershipCatalogQuery } from "./frontend-transport.js";

export interface CadetEnv {
  DB: D1Database;
  ENVIRONMENT: string;
  GENERATION: string;
}
type Row = Record<string, unknown>;
const denied = () =>
  new HttpError(
    403,
    "NOT_AUTHORIZED",
    "This Directory account is unavailable.",
  );
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const canonicalPrincipal = async (email: string) =>
  "google." +
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(normalizeEmail(email)),
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
const current =
  "d.status='active' AND d.term_id=(SELECT term_id FROM terms WHERE is_current=1)";
const adopted =
  "(r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions a WHERE a.adoption_id=r.legacy_adoption_id AND a.state='complete'))";
import {
  CADET_SCHOOLS,
  schoolForEmail,
} from "../../../packages/domain/src/school-account.js";
const schoolDomains = Object.keys(CADET_SCHOOLS);
export const schoolDomain = (email: string) =>
  schoolDomains.includes(email.split("@")[1]);
export const eligibleSchoolSql =
  "substr(lower(d.email),instr(d.email,'@')+1) IN (" +
  schoolDomains.map((x) => "'" + x + "'").join(",") +
  ")";

export const flightSection = (section: unknown): section is string => typeof section === "string" && /^flight(?::[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})?$/.test(section);
export const reportSection = (value:unknown) => typeof value==="string" && /^report:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
// Match the Directory school aliases used by the operational attendance Form.
const campus = (alias:string) => `CASE WHEN lower(${alias}.university) LIKE '%trine%' THEN 'Trine'
  WHEN lower(${alias}.university) LIKE '%valpo%' OR lower(${alias}.university) LIKE '%valpar%' THEN 'Valparaiso' ELSE '' END`;
const reportMembers = `FROM directory_profiles reporter CROSS JOIN event_details d
  JOIN event_units eu ON eu.event_id=d.event_id JOIN memberships m ON m.unit_id=eu.unit_id AND m.active=1
  JOIN directory_profiles candidate ON candidate.person_id=m.person_id AND candidate.flight_id=m.unit_id
  WHERE reporter.person_id=? AND reporter.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
  AND EXISTS(SELECT 1 FROM memberships own WHERE own.person_id=reporter.person_id AND own.unit_id=reporter.flight_id AND own.active=1)
  AND d.event_id=? AND ${current}
  AND EXISTS(SELECT 1 FROM events e WHERE e.event_id=d.event_id AND e.active=1)
  AND candidate.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
  AND (d.event_type='secondary' OR CASE WHEN d.event_type='mando' THEN
    ${campus("reporter")}=${campus("candidate")} AND (${campus("reporter")}<>'' OR m.unit_id=reporter.flight_id)
    ELSE m.unit_id=reporter.flight_id END)
  AND (NOT EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=d.event_id AND v.version=d.version)
    OR EXISTS(SELECT 1 FROM event_roster_members rm WHERE rm.event_id=d.event_id AND rm.version=d.version AND rm.person_id=m.person_id AND rm.flight_id=m.unit_id))`;

function workspaceAction(a:Row){
      let change=null;
      if(a.kind==="flag" && String(a.actionId).startsWith("cell."))try {const parsed=JSON.parse(String(a.detail));if(parsed?.type==="cell-review")change=parsed;}catch{}
      return {...a,change,detail:change?.reason??a.detail} as Row;
    }

export async function readCadetWorkspace(
  env: CadetEnv,
  email: string,
  loginPrincipal?: string,
  section:unknown=null,
) {
  const db = env.DB;
  const principal = await canonicalPrincipal(email);
  const actor = loginPrincipal ?? principal;
  const lookup = db
    .prepare(
      `SELECT ${directoryCatalogQuery.select}, (SELECT email FROM directory_contact_emails c WHERE c.person_id=d.person_id) AS contactEmail,
    EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1) AS enrolled
    FROM directory_profiles d WHERE lower(d.email)=? LIMIT 2`,
    )
    .bind(email);
  const bindings = db
    .prepare(
      `SELECT p.principal_id,p.person_id,p.active,a.email FROM principals p
    LEFT JOIN principal_accounts a ON a.principal_id=p.principal_id WHERE p.principal_id IN (
      SELECT ? UNION SELECT principal_id FROM principal_accounts WHERE email=? UNION
      SELECT p2.principal_id FROM principals p2 JOIN directory_profiles d ON d.person_id=p2.person_id WHERE lower(d.email)=?)
    ORDER BY p.principal_id LIMIT 3`,
    )
    .bind(principal, email, email);
  const rosterSection=section==="directory" || section==="leadership";
  const personal=rosterSection || section==="profile" || section==="attendance" || flightSection(section) || section==="overview" || section==="overview-charts";
  const flights = db.prepare(
    "SELECT u.unit_id AS flightId,u.label,u.roster_version AS rosterVersion,h.squadron_id AS squadronId,s.label AS squadron FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s ON s.squadron_id=h.squadron_id " + (personal ? " WHERE u.unit_id=(SELECT flight_id FROM directory_profiles WHERE lower(email)=?)" : "") + " ORDER BY u.label",
  );
  const leadership =
    db.prepare(`SELECT d.person_id,d.role,u.label AS flight,s.label AS squadron,s.squadron_id FROM directory_profiles d
    JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
    JOIN organizational_units u ON u.unit_id=d.flight_id JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s ON s.squadron_id=h.squadron_id
    WHERE d.person_id IN (SELECT person_id FROM directory_profiles WHERE lower(email)=?
      UNION ALL SELECT person_id FROM directory_profiles WHERE instr(lower(role),'squadron')>0 AND instr(lower(role),'commander')>0 AND instr(lower(role),'deputy')=0
        AND EXISTS(SELECT 1 FROM directory_profiles me WHERE lower(me.email)=? AND instr(lower(me.role),'squadron')>0 AND instr(lower(me.role),'commander')>0 AND instr(lower(me.role),'deputy')=0))
    AND d.role<>'' AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
    AND NOT EXISTS(SELECT 1 FROM leadership_contacts c WHERE c.person_id=d.person_id AND c.active=0)
    AND EXISTS(SELECT 1 FROM permission_policy_control pc,json_each(pc.config_json,'$.operationalSquadronIds') op WHERE pc.enabled=1 AND op.value=s.squadron_id)
    ORDER BY d.person_id`).bind(email,email);
  const control = db
    .prepare(
      "SELECT accepting_commands AS writable FROM system_control WHERE singleton=1 AND environment=? AND generation=?",
    )
    .bind(env.ENVIRONMENT, Number(env.GENERATION));
  const fence = [lookup,bindings,personal ? flights.bind(email) : flights,leadership,control];
  const capture = await db.batch<Row>(section==="attendance" ? [...fence,...personalAttendanceQueries(db,email)] : fence);
  const first = capture.slice(0,fence.length).map(r=>r.results);
  const [people, linkedAccounts, flightList, leaders, controls] = first;
  // Wing grants use the same verified address as the personal Google login.
  // Strip only its exact, active school alias from the personal workspace check.
  const schoolAlias = 'school.' + principal.slice('google.'.length);
  const accounts = linkedAccounts.filter(account => !(actor===principal && account.principal_id===schoolAlias
    && account.active===1 && people.length===1 && account.person_id===people[0].personId
    && (!account.email || account.email===email)));
  if (
    controls.length !== 1 ||
    people.length > 1 ||
    accounts.length > 1 ||
    accounts.some(
      (a) =>
        !a.active ||
        a.person_id !== people[0]?.personId ||
        (a.email && a.email !== email) ||
        a.principal_id !== actor,
    )
  )
    throw denied();
  const writable = !!controls[0].writable;
  if (!people.length) {
    if (!schoolDomain(email) || accounts.length) throw denied();
    return {
      registration: true,
      school: schoolForEmail(email),
      writable,
      flights: personal ? (await db.batch<Row>([db.prepare("SELECT u.unit_id AS flightId,u.label,u.roster_version AS rosterVersion,h.squadron_id AS squadronId,s.label AS squadron FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s USING(squadron_id) ORDER BY u.label")]))[0].results : flightList,
      profile: null,
    };
  }
  const profile = people[0] as unknown as DirectoryRecord & {
    enrolled: number;
  };
  if (!operationallyActive(profile) || !profile.enrolled) throw denied();
  const owner = leaders.find((l) => l.person_id === profile.personId);
  const role = (r: Row) =>
    directoryLeadershipRole(
      String(r.role),
      String(r.flight),
      String(r.squadron),
    )
      ?.trim()
      .toLowerCase();
  const title = owner && role(owner);
  const squadronCommander =
    owner &&
    title === String(owner.squadron).toLowerCase() + " squadron commander" &&
    leaders.filter((l) => role(l) === title).length === 1;
  const flightCommander =
    owner &&
    [
      String(owner.flight).toLowerCase() + " flight commander",
      String(owner.flight).toLowerCase() + " deputy flight commander",
    ].includes(title || "");
  const requests = (
    predicate: string,
  ) => `SELECT r.request_id AS requestId,r.person_id AS personId,r.unit_id AS flightId,r.event_id AS eventId,
    e.label AS event,d.start_at AS eventStartAt,p.display_name AS personDisplayName,r.status,r.requested_outcome AS requestedOutcome,r.reason,
    COALESCE((SELECT audit_id FROM audit_events WHERE command_id=r.last_command_id),0) AS 'order',(r.origin='legacy' AND r.last_command_id IS NULL) AS legacyStateOnly,r.version,r.submitted_at AS submittedAt,r.decision_reason AS decisionReason,sc.flight_label AS capturedFlightLabel,sc.squadron_label AS capturedSquadronLabel
    FROM excusal_records r JOIN event_details d ON d.event_id=r.event_id JOIN events e ON e.event_id=r.event_id
    JOIN people p ON p.person_id=r.person_id LEFT JOIN excusal_request_scopes sc ON sc.request_id=r.request_id
    WHERE ${predicate} AND ${current} AND ${adopted} ORDER BY r.submitted_at,r.request_id`;
  if (section === "excusals" && !squadronCommander && !flightCommander) throw denied();
  if(personal || section === "excusals"){
    let queue: Row[] = [];
    if (section === "excusals") {
      const query = squadronCommander
        ? db.prepare(requests("sc.squadron_id=?")).bind(owner.squadron_id)
        : db.prepare(requests("r.unit_id=? AND sc.flight_id=r.unit_id")).bind(profile.flightId);
      const [rows, ...checked] = await db.batch<Row>([query, ...fence]);
      if (JSON.stringify(first) !== JSON.stringify(checked.map(result => result.results)))
        throw new HttpError(409, "SNAPSHOT_CHANGED", "Your assignment changed. Reload SHAMROCK.");
      queue = rows.results;
    }
    let overviewData;
    if(section==="overview" || section==="overview-charts") {
      overviewData=await memberOverview(db,section==="overview-charts");
      const checked=await db.batch(fence);
      if(JSON.stringify(first)!==JSON.stringify(checked.map(r=>r.results)))throw denied();
    }
    let rosterData;
    if (rosterSection) {
      const peerQuery = db.prepare(`SELECT d.person_id AS personId,d.first_name AS firstName,
    d.last_name AS lastName,d.as_year AS asYear,d.rank,d.role,d.university,d.phone,d.photo_link AS photoLink,COALESCE((SELECT email FROM directory_contact_emails c WHERE c.person_id=d.person_id),d.email) AS email,d.class_year AS classYear,d.afsc,d.cip_broad_area AS cipBroadArea,d.cip_code AS cipCode,d.flight_path_status AS flightPathStatus,u.label AS flight,s.label AS squadron
    FROM directory_profiles d JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
    JOIN organizational_units u ON u.unit_id=d.flight_id
    LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id LEFT JOIN squadrons s ON s.squadron_id=h.squadron_id
    WHERE d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')`);
      const queries=[peerQuery];
      if(section==="leadership") queries.push(db.prepare(`SELECT ${leadershipCatalogQuery.select} ${leadershipCatalogQuery.from}
        AND c.active=1 AND (c.person_id IS NULL OR EXISTS (SELECT 1 FROM directory_profiles d
          JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
          WHERE d.person_id=c.person_id AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')))`));
      const result = await db.batch<Row>([...queries,...fence]);
      const checked=result.slice(queries.length);
      if (JSON.stringify(first)!==JSON.stringify(checked.map(r=>r.results)))
        throw new HttpError(409,"SNAPSHOT_CHANGED","Your assignment changed. Reload the Directory.");
      const contacts=section==="leadership" ? result[1].results.map(contact=>{
        if (!contact.personId) return contact;
        const {personId,contactId,version,active,officePhone,officeLocation,reportsTo}=contact;
        return {personId,contactId,version,active,officePhone,officeLocation,reportsTo};
      }) : undefined;
      rosterData={directory:result[0].results,...(contacts ? {leadership:contacts} : {})};
    }
    let flightHome;
    if(flightSection(section)){
      if(!flightCommander || !profile.flightId)throw denied();
      const asOf=new Date().toISOString();
      const schedule=scheduledFlightEvents(db,profile.flightId);
      const [read]=await db.batch<ScheduledFlightEvent>([schedule]);
      const automatic=currentFlightEvent(read.results,asOf);
      const selected=section.startsWith("flight:") ? section.slice(7) : null;
      const event=selected ? read.results.find(e=>e.eventId===selected) : automatic.event;
      if(selected && !event)throw denied();
      const members=event ? await flightAttendance(db,event,profile.flightId) : [];
      const verified=await db.batch([schedule,...fence]);
      if(JSON.stringify(read.results)!==JSON.stringify(verified[0].results) ||
        JSON.stringify(first)!==JSON.stringify(verified.slice(1).map(r=>r.results)))throw new HttpError(409,"SNAPSHOT_CHANGED","Reload your Flight attendance.");
      flightHome={flightEvent:event ?? null,members,eventsForFlight:read.results,refreshAt:selected ? null : automatic.refreshAt,asOf};
    }
    const personalData=section==="attendance" ? personalAttendance(profile.personId,capture.slice(fence.length).map(r=>r.results)) : {attendance:[],flags:[]};
    return {registration:false,profile,flights:flightList,writable,linked:accounts.length===1 && accounts[0].principal_id===actor && accounts[0].email===email,
      flightCommander:!!flightCommander,squadron:squadronCommander ? String(owner.squadron) : null,squadronId:squadronCommander ? owner.squadron_id : null,
      section,...overviewData,...rosterData,...flightHome,attendance:personalData.attendance,actions:personalData.flags.map(workspaceAction),reportEvents:[],reportRoster:[],ownFlightCount:null,roster:[],requests:[],events:[],queue};
  }
  const reporting=section==="report" || reportSection(section);
  const data = reporting ? [] : [
    db.prepare(requests("r.person_id=?")).bind(profile.personId),
    db
      .prepare(
        `SELECT d.event_id AS eventId,e.label,d.term_id AS termId,d.event_type AS eventType,d.column_label AS columnLabel,d.training_week AS trainingWeek,d.version FROM event_details d JOIN events e ON e.event_id=d.event_id
      WHERE ${current} AND EXISTS(SELECT 1 FROM event_units u WHERE u.event_id=d.event_id AND u.unit_id=?)
      AND (NOT EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=d.event_id AND v.version=d.version)
        OR EXISTS(SELECT 1 FROM event_roster_members m WHERE m.event_id=d.event_id AND m.version=d.version AND m.person_id=?))
      ORDER BY d.display_order,d.event_id`,
      )
      .bind(profile.flightId, profile.personId),
  ];
  if (!reporting && squadronCommander)
    data.push(db.prepare(requests("sc.squadron_id=?")).bind(owner.squadron_id));
  const actionsIndex = data.length;
  if(!reporting)data.push(
    db
      .prepare(
        `SELECT a.action_id AS actionId,a.kind,a.detail,a.accepted_at AS acceptedAt,
    a.flight_id AS flightId,a.subject_person_id AS personId,p.display_name AS person,a.event_id AS eventId,e.label AS event,resolved.detail AS resolution
    FROM cadet_workspace_actions a JOIN people p ON p.person_id=a.subject_person_id LEFT JOIN events e ON e.event_id=a.event_id
    LEFT JOIN cadet_workspace_actions resolved ON resolved.parent_id=a.action_id WHERE a.kind IN ('flag','duty')
    AND (a.subject_person_id=? OR a.flight_id=? OR (a.kind='flag' AND a.action_id LIKE 'cell.%' AND CASE WHEN json_valid(a.detail) THEN json_extract(a.detail,'$.squadronId') END=?)) AND (a.kind!='duty' OR NOT EXISTS(
      SELECT 1 FROM cadet_workspace_actions newer WHERE newer.kind='duty' AND newer.subject_person_id=a.subject_person_id
      AND newer.flight_id=a.flight_id AND newer.rowid>a.rowid)) ORDER BY a.accepted_at DESC`,
      )
      .bind(profile.personId, flightCommander ? profile.flightId : null, squadronCommander ? owner.squadron_id : null),
  );
  const ownIndex=data.length;
  if (!reporting && flightCommander)
    data.push(
      db
        .prepare(
          `SELECT d.person_id AS personId,d.last_name || ', ' || d.first_name AS name,d.role,d.version FROM directory_profiles d
    JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1 WHERE d.flight_id=?
    AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned') ORDER BY d.last_name,d.first_name`,
        )
        .bind(profile.flightId),
    );
  if(reportSection(section))data.push(db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE unit_id=? AND active=1").bind(profile.flightId));
  const reportIndex = data.length;
  if(section==="report")data.push(db.prepare(`SELECT d.event_id AS eventId,e.label,d.event_type AS eventType,d.version
    FROM event_details d JOIN events e USING(event_id) JOIN directory_profiles reporter ON reporter.person_id=?
    WHERE ${current} AND e.active=1 AND EXISTS(SELECT 1 FROM event_units eu WHERE eu.event_id=d.event_id AND
      (eu.unit_id=reporter.flight_id OR d.event_type='secondary' OR (d.event_type='mando' AND ${campus("reporter")}<>'')))
    ORDER BY d.display_order,d.event_id`).bind(profile.personId));
  if(reportSection(section))data.push(db.prepare(`SELECT m.person_id AS personId,m.unit_id AS flightId,
    candidate.first_name AS firstName,candidate.last_name AS lastName,candidate.as_year AS asYear,
    d.event_id AS eventId,d.event_type AS eventType,d.version,${campus("reporter")} AS campus ${reportMembers}`)
    .bind(profile.personId,String(section).slice(7)));
  const all = (await db.batch<Row>([...data, ...fence])).map((r) => r.results);
  if (JSON.stringify(first) !== JSON.stringify(all.slice(data.length)))
    throw new HttpError(
      409,
      "SNAPSHOT_CHANGED",
      "Your assignment changed. Reload SHAMROCK.",
    );
  return {
    registration: false,
    profile,
    flights: flightList,
    writable,
    linked:
      accounts.length === 1 &&
      accounts[0].principal_id === actor &&
      accounts[0].email === email,
    flightCommander: !!flightCommander,
    squadron: squadronCommander ? String(owner.squadron) : null,
    section, squadronId:squadronCommander ? owner.squadron_id : null,
    attendance:[],
    reportEvents:section==="report" ? all[reportIndex] : [],
    reportRoster:reportSection(section) ? all[reportIndex] : [],
    actions: reporting ? [] : all[actionsIndex].map(workspaceAction),
    roster: !reporting && flightCommander ? all[ownIndex] : [],
    ownFlightCount:reportSection(section) ? Number(all[ownIndex][0].n) : null,
    requests: reporting ? [] : all[0],
    events: reporting ? [] : all[1],
    queue: !reporting && squadronCommander ? all[2] : [],
  };
}

import { acceptAdminCommand } from "./admin.js";
import {
  DIRECTORY_FIELDS,
  DIRECTORY_SELF_FIELDS,
  adminIdentifier,
} from "../../../packages/domain/src/admin.js";
import { permissionSourceRevisionSql } from "./permissions.js";
import {
  parseCommand,
  type Command,
} from "../../../packages/domain/src/index.js";

const bad = () =>
  new HttpError(400, "INVALID_REQUEST", "Check the fields and try again.");
const object = (x: unknown): x is Row =>
  !!x && typeof x === "object" && !Array.isArray(x);
export async function cadetRoute(
  env: CadetEnv,
  input: unknown,
  submit: (
    c: Command,
    guard: { reportBatch?:D1PreparedStatement[]; memberReport?:true; sql: string; values: (string | number | null)[] },
  ) => Promise<unknown>,
  viewEntry?: string,
) {
  if (
    !object(input) ||
    input.environment !== env.ENVIRONMENT ||
    input.generation !== Number(env.GENERATION) ||
    typeof input.email !== "string" ||
    input.email !== normalizeEmail(input.email) ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
    typeof input.principalId !== "string"
  )
    throw denied();
  if (
    Object.keys(input).some(
      (k) =>
        ![
          "environment",
          "generation",
          "principalId",
          "email",
          "action",
          "section",
        ].includes(k),
    )
  )
    throw bad();
  const a = input.action;
  // Include the permission source revision in the write condition when a Flight leader assigns a duty or resolves a flag.
  const revision = a
    ? await env.DB.prepare(permissionSourceRevisionSql).first<string>(
        "revision",
      )
    : null;
  const section=object(a) ? (a.kind==="report" && object(a.fields) ? "report:"+a.fields.eventId : undefined) : input.section;
  if(section!=null && !reportSection(section) && !flightSection(section) && !["overview","overview-charts","profile","attendance","report","flight","excusals","directory","leadership"].includes(String(section))) throw bad();
  const state = await readCadetWorkspace(env, input.email, input.principalId, section);
  if (
    !state.linked &&
    input.principalId !== (await canonicalPrincipal(input.email))
  )
    throw denied();
  if (!a) return state;
  if (!state.writable)
    throw new HttpError(
      409,
      "WRITES_PAUSED",
      "Submissions are paused.",
    );
  if (
    !object(a) ||
    !object(a.fields) ||
    typeof a.kind !== "string" ||
    typeof a.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(a.id)
  )
    throw bad();
  const f = a.fields,
    commandId = (a.kind==="flag" && Object.hasOwn(a.fields,"code") ? "cell." : "portal.") + (viewEntry ? viewEntry+"." : "") + a.id;
  const envelope = {
    contractVersion: 1,
    generation: input.generation,
    environment: env.ENVIRONMENT,
    actor: {
      principalId: input.principalId,
      evidence: "authenticated-confirmation",
    },
    source: {
      kind: "test",
      resourceKey: "admin-staging-web",
      submissionId: commandId,
      revision: 1,
    },
    commandId,
  };
  const p = state.profile;
  if (!schoolDomain(input.email) && !p) throw denied();
  if (a.kind === "register" || a.kind === "link") {
    if (
      (a.kind === "link" && !p) ||
      (a.kind === "register" && p && !state.linked)
    )
      throw bad();
    if (
      Object.keys(f).some(
        (k) =>
          !["flightId", "asYear", ...DIRECTORY_SELF_FIELDS].includes(
            k as (typeof DIRECTORY_SELF_FIELDS)[number],
          ),
      )
    )
      throw bad();
    const source = a.kind === "link" ? p! : f;
    const profile = Object.fromEntries(
      DIRECTORY_FIELDS.map((k) => [
        k,
        source[k] ?? (k === "dateOfBirth" ? null : ""),
      ]),
    );
    Object.assign(profile, {
      rank: "C/AB",
      role: "",
      flightPathStatus: "Active 3/4",
      email: input.email,
    });
    if (
      !p &&
      (!profile.university ||
        !profile.asYear ||
        !profile.classYear ||
        !profile.phone ||
        !profile.homeTown ||
        !profile.homeState ||
        !profile.dateOfBirth)
    )
      throw bad();
    return acceptAdminCommand(env, {
      ...envelope,
      operation: "directory.enroll",
      payload: {
        verifiedEmail: input.email,
        flightId: source.flightId,
        profile,
      },
    });
  }
  if (!p || !state.linked)
    throw new HttpError(
      409,
      "LINK_REQUIRED",
      "Connect your Directory record first.",
    );
  const permissionGuard: {sql:string;values:(string|number|null)[]} = {
    sql: `(${permissionSourceRevisionSql})=? AND EXISTS(SELECT 1 FROM principal_accounts a
    JOIN principals p ON p.principal_id=a.principal_id WHERE a.principal_id=? AND a.email=? AND p.person_id=? AND p.active=1)`,
    values: [
      revision as string,
      String(input.principalId),
      input.email,
      p.personId,
    ],
  };
  if(a.kind==="flightRole"){
    const target=state.roster?.find(r=>r.personId===f.personId);
    const flight=state.flights.find(r=>r.flightId===p.flightId);
    if(!state.flightCommander || !target || !flight || !p.flightId)throw denied();
    return assignFlightRole(env,permissionGuard,input.principalId,commandId,p.flightId,String(flight.label),
      {personId:target.personId,role:target.role,version:target.version},f);
  }
  if (a.kind === "report") {
    if (
      !Array.isArray(f.present) ||
      !["complete", "partial"].includes(String(f.completeness))
    )
      throw denied();
    const roster=state.reportRoster.filter(r=>r.version===f.version);
    const present=f.present as unknown[];
    const selected=roster.filter(r=>present.includes(r.personId));
    if(!roster.length || selected.length!==present.length || (!selected.length && f.completeness!=="complete"))throw bad();
    const ownFlight=roster.every(r=>r.flightId===p.flightId);
    const partialOnly=roster[0].eventType==="secondary" || (roster[0].eventType==="mando" && !!roster[0].campus);
    const complete=f.completeness==="complete";
    if(complete && (partialOnly || !ownFlight || state.ownFlightCount!==roster.length))
      throw new HttpError(409,"PARTIAL_ROSTER","Submit a partial report for this event roster.");
    const covered=complete ? roster : selected;
    const flightIds=[...new Set(covered.map(r=>String(r.flightId)))].sort();
    const supplied=object(f.rosterVersions) ? f.rosterVersions : {};
    // Bind retries to the complete selection, even when it spans Flight ledgers.
    const signature=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(
      JSON.stringify([f.eventId,f.version,f.completeness,[...present].sort()])))),n=>n.toString(16).padStart(2,"0")).join("");
    const statements:D1PreparedStatement[]=[];
    const receipts=[];
    for(const [i,flightId] of flightIds.entries()){
      const version=state.flights.find(r=>r.flightId===flightId)?.rosterVersion;
      if(version!==(supplied[flightId] ?? (flightId===p.flightId ? f.rosterVersion : null)))
        throw new HttpError(409,"ROSTER_CHANGED","Reload the event roster before submitting.");
      const ids=covered.filter(r=>r.flightId===flightId).map(r=>String(r.personId)).sort();
      const childId=i===0 ? commandId : commandId+"."+i;
      const guard={memberReport:true as const,reportBatch:statements,
        sql:permissionGuard.sql+` AND (SELECT COUNT(*) ${reportMembers} AND m.unit_id=? AND m.person_id IN (SELECT value FROM json_each(?)))=?`,
        values:[...permissionGuard.values,p.personId,String(f.eventId),flightId,JSON.stringify(ids),ids.length]};
      receipts.push(await submit(parseCommand({...envelope, commandId:childId,
        source:{...envelope.source,submissionId:!f.rosterVersions && flightIds.length===1 ? childId : childId+"."+signature.slice(0,24)},operation:"attendance.report",
        payload:{reportId:"report."+a.id+(i?"."+i:""),eventId:f.eventId,expectedEventVersion:f.version,unitId:flightId,
          rosterVersion:version,completeness:f.completeness,coveredPersonIds:ids,presentPersonIds:ids.filter(id=>present.includes(id))}}),guard));
    }
    if(statements.length) {
      try {await env.DB.batch(statements);}
      catch(error){if(/constraint|command_preconditions/i.test(String(error)))throw new HttpError(409,"REPORT_CONFLICT","The roster or report changed. Reload and verify the saved attendance.");throw error;}
    }
    return receipts[0];
  }
  if (a.kind === "profile") {
    const changes = f.changes;
    if (object(changes) && (["phone","classYear","homeTown","homeState","dateOfBirth"] as const).some(key =>
      Object.hasOwn(changes,key) && !changes[key] && p[key])) throw new HttpError(400,"INVALID_PROFILE_FIELD","A required profile field cannot be cleared.");
    return acceptAdminCommand(env, {
      ...envelope,
      operation: "directory.selfUpdate",
      payload: {
        personId: p.personId,
        expectedVersion: f.version,
        changes: f.changes,
      },
    });
  }
  if (a.kind === "excusal" && Array.isArray(f.events)) {
    if (!f.events.length || f.events.length > 25) throw bad();
    const events = f.events.map((entry, i) => {
      if (
        !object(entry) ||
        !state.events?.some(
          (e) => e.eventId === entry.eventId && e.version === entry.version,
        )
      )
        throw bad();
      return {
        eventId: entry.eventId,
        expectedEventVersion: entry.version,
        requestId: `request.${a.id}.${i + 1}`,
      };
    });
    return submit(
      parseCommand({
        ...envelope,
        operation: "excusal.submitMany",
        payload: {
          personId: p.personId,
          requestedOutcome: f.outcome,
          reason: f.reason,
          events,
        },
      }),
      permissionGuard,
    );
  }
  if (a.kind === "excusal") {
    if (
      !state.events?.some(
        (e) => e.eventId === f.eventId && e.version === f.version,
      )
    )
      throw bad();
    return submit(
      parseCommand({
        ...envelope,
        operation: "excusal.submit",
        payload: {
          personId: p.personId,
          eventId: f.eventId,
          expectedEventVersion: f.version,
          requestedOutcome: f.outcome,
          reason: f.reason,
          requestId: "request." + a.id,
        },
      }),
      permissionGuard,
    );
  }
  if (a.kind === "decide") {
    if (
      !state.squadron ||
      !state.queue?.some((r) => r.requestId === f.requestId)
    )
      throw denied();
    return submit(
      parseCommand({
        ...envelope,
        operation: "excusal.decide",
        payload: {
          requestId: f.requestId,
          expectedVersion: f.version,
          decision: f.decision,
          reason: f.reason,
        },
      }),
      permissionGuard,
    );
  }
  const pending=state.actions?.find(r=>r.kind==="flag" && r.actionId===f.parentId);
  if(a.kind==="reviewFlag"){
    const change=pending?.change as Row|undefined;
    if(!state.squadronId || !change || state.squadronId!==change.squadronId || !["Approved","Denied"].includes(String(f.decision))) throw denied();
    const resolution=env.DB.prepare("INSERT INTO cadet_workspace_actions VALUES(?,'resolve',?,?,?,?,?,?,?)").bind(commandId,p!.personId,pending!.personId,pending!.flightId,pending!.eventId,pending!.actionId,f.decision,new Date().toISOString());
    const guard={sql:permissionGuard.sql+" AND EXISTS(SELECT 1 FROM flight_hierarchy WHERE unit_id=? AND squadron_id=?)",values:[...permissionGuard.values,String(pending!.flightId),String(state.squadronId)]};
    if(f.decision==="Approved")return acceptAttendanceCorrection(env,{...envelope,operation:"attendance.correct",payload:{
      personId:pending!.personId,eventId:pending!.eventId,code:change.code,reason:change.reason,expectedBaseVersion:change.baseVersion,expectedEventVersion:change.eventVersion}},guard,{flightId:String(pending!.flightId),resolution});
    const result=await env.DB.batch<Row>([
      env.DB.prepare(`INSERT OR IGNORE INTO cadet_workspace_actions SELECT ?, 'resolve',?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND accepting_commands=1)`).bind(commandId,p.personId,pending!.personId,pending!.flightId,pending!.eventId,pending!.actionId,"Denied",new Date().toISOString(),...guard.values),
      env.DB.prepare("SELECT action_id FROM cadet_workspace_actions WHERE parent_id=? AND detail='Denied'").bind(pending!.actionId)]);
    if(result[1].results[0]?.action_id!==commandId)throw new HttpError(409,"REVIEW_CHANGED","Reload the request.");
    return {commandId,status:"committed"};
  }
  if (
    !["flag", "resolve"].includes(a.kind) ||
    typeof f.detail !== "string" ||
    !f.detail.trim() ||
    f.detail.length > 500
  )
    throw bad();
  const flag = state.actions?.find(
    (r) => r.actionId === f.parentId && r.kind === "flag",
  );
  if (a.kind === "flag" && !state.events?.some((e) => e.eventId === f.eventId))
    throw bad();

  if (
    a.kind === "resolve" &&
    (!state.flightCommander || !flag || flag.change || flag.flightId !== p.flightId)
  )
    throw denied();
  const person =
    a.kind === "flag"
      ? p.personId
      : adminIdentifier(flag!.personId);
  const event =
    adminIdentifier(a.kind === "flag" ? f.eventId : flag!.eventId);
  const parent = a.kind === "resolve" ? adminIdentifier(f.parentId) : null;
  let detail=f.detail.trim();
  if(a.kind==="flag" && Object.hasOwn(f,"code")){
    const event=state.events?.find(e=>e.eventId===f.eventId);
    const flight=state.flights.find(r=>r.flightId===p.flightId);
    if(!flight?.squadronId || !event || f.eventVersion!==event.version || !ATTENDANCE_CODES.includes(f.code as AttendanceCode) || !Number.isSafeInteger(f.baseVersion))throw bad();
    permissionGuard.sql+=` AND (${pairRevisionSql})=? AND EXISTS(SELECT 1 FROM event_details WHERE event_id=? AND version=? AND status='active')`;
    permissionGuard.values.push(String(f.eventId),p.personId,f.baseVersion as number,String(f.eventId),Number(event.version));
    detail=JSON.stringify({type:"cell-review",squadronId:flight.squadronId,code:f.code,reason:detail,baseVersion:f.baseVersion,eventVersion:event.version});
  }
  const values = [
    commandId,
    a.kind,
    p.personId,
    person,
    p.flightId,
    event,
    parent,
    detail,
  ];
  const results = await env.DB.batch<Row>([
    env.DB.prepare(
      `INSERT INTO cadet_workspace_actions SELECT ?,?,?,?,?,?,?,?,? WHERE ${permissionGuard.sql}
      AND EXISTS(SELECT 1 FROM system_control WHERE environment=? AND generation=? AND accepting_commands=1)
      AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind='test' AND resource_key='admin-staging-web' AND active=1)
      AND EXISTS(SELECT 1 FROM permission_policy_control WHERE singleton=1 AND enabled=1)
      ON CONFLICT DO NOTHING`,
    ).bind(
      ...values,
      new Date().toISOString(),
      ...permissionGuard.values,
      env.ENVIRONMENT,
      Number(env.GENERATION),
    ),
    env.DB.prepare(
      "SELECT action_id,kind,actor_person_id,subject_person_id,flight_id,event_id,parent_id,detail FROM cadet_workspace_actions WHERE action_id=?",
    ).bind(commandId),
  ]);
  if (
    JSON.stringify(Object.values(results[1].results[0] || {})) !==
    JSON.stringify(values)
  )
    throw new HttpError(
      409,
      "WORKSPACE_CHANGED",
      "Reload the current Flight before trying again.",
    );
  return { commandId, status: "committed" };
}

export async function knownDirectoryEmail(env: CadetEnv, input: unknown) {
  if (
    !object(input) ||
    input.environment !== env.ENVIRONMENT ||
    input.generation !== Number(env.GENERATION) ||
    typeof input.email !== "string" ||
    input.email !== normalizeEmail(input.email) ||
    input.email.length > 254 ||
    input.principalId !== (await canonicalPrincipal(input.email))
  )
    throw denied();
  const result = await env.DB.prepare(
    `SELECT d.person_id FROM directory_profiles d WHERE lower(d.email)=?
    AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
    AND EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1)
    AND NOT EXISTS(SELECT 1 FROM principals p WHERE p.person_id=d.person_id AND p.active=0) LIMIT 2`,
  )
    .bind(input.email)
    .all();
  return { known: result.results.length === 1 };
}
