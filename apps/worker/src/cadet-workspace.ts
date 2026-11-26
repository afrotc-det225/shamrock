// The school sign-in and an administrator's audited preview use the same Directory read model.
import {
  directoryLeadershipRole,
  operationallyActive,
  type DirectoryRecord,
} from "../../../packages/domain/src/admin.js";
import { HttpError } from "./http-error.js";
import { directoryCatalogQuery } from "./frontend-transport.js";

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

export async function readCadetWorkspace(
  env: CadetEnv,
  email: string,
  loginPrincipal?: string,
) {
  const db = env.DB;
  const principal = await canonicalPrincipal(email);
  const actor = loginPrincipal ?? principal;
  const lookup = db
    .prepare(
      `SELECT ${directoryCatalogQuery.select},
    EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1) AS enrolled
    FROM directory_profiles d WHERE lower(d.email)=? LIMIT 2`,
    )
    .bind(email);
  const bindings = db
    .prepare(
      `SELECT p.principal_id,p.person_id,p.active,a.email FROM principals p
    LEFT JOIN principal_accounts a ON a.principal_id=p.principal_id WHERE p.principal_id=? OR a.email=?
    OR p.person_id IN (SELECT person_id FROM directory_profiles WHERE lower(email)=?) ORDER BY p.principal_id LIMIT 3`,
    )
    .bind(principal, email, email);
  const flights = db.prepare(
    "SELECT u.unit_id AS flightId,u.label,u.roster_version AS rosterVersion,h.squadron_id AS squadronId,s.label AS squadron FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s ON s.squadron_id=h.squadron_id ORDER BY u.label",
  );
  const leadership =
    db.prepare(`SELECT d.person_id,d.role,u.label AS flight,s.label AS squadron,s.squadron_id FROM directory_profiles d
    JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
    JOIN organizational_units u ON u.unit_id=d.flight_id JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s ON s.squadron_id=h.squadron_id
    WHERE d.role<>'' AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
    AND NOT EXISTS(SELECT 1 FROM leadership_contacts c WHERE c.person_id=d.person_id AND c.active=0)
    AND EXISTS(SELECT 1 FROM permission_policy_control pc,json_each(pc.config_json,'$.operationalSquadronIds') op WHERE pc.enabled=1 AND op.value=s.squadron_id)
    ORDER BY d.person_id`);
  const control = db
    .prepare(
      "SELECT accepting_commands AS writable FROM system_control WHERE singleton=1 AND environment=? AND generation=?",
    )
    .bind(env.ENVIRONMENT, Number(env.GENERATION));
  const fence = [lookup, bindings, flights, leadership, control];
  const first = (await db.batch<Row>(fence)).map((r) => r.results);
  const [people, accounts, flightList, leaders, controls] = first;
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
      flights: flightList,
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
    e.label AS event,p.display_name AS personDisplayName,r.status,r.requested_outcome AS requestedOutcome,r.reason,
    r.version,r.submitted_at AS submittedAt,r.decision_reason AS decisionReason,sc.flight_label AS capturedFlightLabel,sc.squadron_label AS capturedSquadronLabel
    FROM excusal_records r JOIN event_details d ON d.event_id=r.event_id JOIN events e ON e.event_id=r.event_id
    JOIN people p ON p.person_id=r.person_id LEFT JOIN excusal_request_scopes sc ON sc.request_id=r.request_id
    WHERE ${predicate} AND ${current} AND ${adopted} ORDER BY r.submitted_at,r.request_id`;
  const data = [
    db.prepare(requests("r.person_id=?")).bind(profile.personId),
    db
      .prepare(
        `SELECT d.event_id AS eventId,e.label,d.version FROM event_details d JOIN events e ON e.event_id=d.event_id
      WHERE ${current} AND EXISTS(SELECT 1 FROM event_units u WHERE u.event_id=d.event_id AND u.unit_id=?)
      AND (NOT EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=d.event_id AND v.version=d.version)
        OR EXISTS(SELECT 1 FROM event_roster_members m WHERE m.event_id=d.event_id AND m.version=d.version AND m.person_id=?))
      ORDER BY d.display_order,d.event_id`,
      )
      .bind(profile.flightId, profile.personId),
  ];
  if (squadronCommander)
    data.push(db.prepare(requests("sc.squadron_id=?")).bind(owner.squadron_id));
  const actionsIndex = data.length;
  data.push(
    db
      .prepare(
        `SELECT a.action_id AS actionId,a.kind,a.detail,a.accepted_at AS acceptedAt,
    a.flight_id AS flightId,a.subject_person_id AS personId,p.display_name AS person,a.event_id AS eventId,e.label AS event,resolved.detail AS resolution
    FROM cadet_workspace_actions a JOIN people p ON p.person_id=a.subject_person_id LEFT JOIN events e ON e.event_id=a.event_id
    LEFT JOIN cadet_workspace_actions resolved ON resolved.parent_id=a.action_id WHERE a.kind IN ('flag','duty')
    AND (a.subject_person_id=? OR a.flight_id=?) AND (a.kind!='duty' OR NOT EXISTS(
      SELECT 1 FROM cadet_workspace_actions newer WHERE newer.kind='duty' AND newer.subject_person_id=a.subject_person_id
      AND newer.flight_id=a.flight_id AND newer.rowid>a.rowid)) ORDER BY a.accepted_at DESC`,
      )
      .bind(profile.personId, flightCommander ? profile.flightId : null),
  );
  if (flightCommander)
    data.push(
      db
        .prepare(
          `SELECT d.person_id AS personId,d.last_name || ', ' || d.first_name AS name FROM directory_profiles d
    JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1 WHERE d.flight_id=?
    AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned') ORDER BY d.last_name,d.first_name`,
        )
        .bind(profile.flightId),
    );
  const reportIndex = data.length;
  if (flightCommander)
    data.push(
      db
        .prepare(
          `SELECT d.event_id AS eventId,e.label,d.version,m.person_id AS personId FROM event_details d JOIN events e ON e.event_id=d.event_id
    JOIN event_units eu ON eu.event_id=d.event_id AND eu.unit_id=?
    JOIN memberships m ON m.unit_id=eu.unit_id AND m.active=1 WHERE ${current} AND (
    NOT EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=d.event_id AND v.version=d.version)
    OR EXISTS(SELECT 1 FROM event_roster_members rm WHERE rm.event_id=d.event_id AND rm.version=d.version AND rm.person_id=m.person_id AND rm.flight_id=m.unit_id))
    ORDER BY d.display_order,d.event_id,m.person_id`,
        )
        .bind(profile.flightId),
    );
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
    reportRoster: flightCommander ? all[reportIndex] : [],
    actions: all[actionsIndex],
    roster: flightCommander ? all[actionsIndex + 1] : [],
    requests: all[0],
    events: all[1],
    queue: squadronCommander ? all[2] : [],
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
    guard: { sql: string; values: (string | number | null)[] },
  ) => Promise<unknown>,
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
  const state = await readCadetWorkspace(env, input.email, input.principalId);
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
    commandId = "portal." + a.id;
  const cip =
    a.kind === "register"
      ? f.cipCode
      : a.kind === "profile" && object(f.changes)
        ? f.changes.cipCode
        : null;
  if (cip && (typeof cip !== "string" || !/^\d{2}\.\d{4}$/.test(cip)))
    throw bad();
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
  const permissionGuard = {
    sql: `(${permissionSourceRevisionSql})=? AND EXISTS(SELECT 1 FROM principal_accounts a
    JOIN principals p ON p.principal_id=a.principal_id WHERE a.principal_id=? AND a.email=? AND p.person_id=? AND p.active=1)`,
    values: [
      revision as string,
      String(input.principalId),
      input.email,
      p.personId,
    ],
  };
  if (a.kind === "report") {
    if (
      !state.flightCommander ||
      !Array.isArray(f.present) ||
      !["complete", "partial"].includes(String(f.completeness))
    )
      throw denied();
    const roster =
      state.reportRoster
        ?.filter((r) => r.eventId === f.eventId && r.version === f.version)
        .map((r) => String(r.personId)) || [];
    if (
      !roster.length ||
      f.present.some((id) => typeof id !== "string" || !roster.includes(id))
    )
      throw bad();
    const flight = state.flights.find((r) => r.flightId === p.flightId);
    if (flight?.rosterVersion !== f.rosterVersion)
      throw new HttpError(409, "ROSTER_CHANGED", "Reload the Flight roster.");
    if (f.completeness === "complete" && state.roster?.length !== roster.length)
      throw new HttpError(
        409,
        "PARTIAL_ROSTER",
        "Submit a partial report for this event roster.",
      );
    return submit(
      parseCommand({
        ...envelope,
        operation: "attendance.report",
        payload: {
          reportId: "report." + a.id,
          eventId: f.eventId,
          expectedEventVersion: f.version,
          unitId: p.flightId,
          rosterVersion: f.rosterVersion,
          completeness: f.completeness,
          coveredPersonIds: f.completeness === "complete" ? roster : f.present,
          presentPersonIds: f.present,
        },
      }),
      permissionGuard,
    );
  }
  if (a.kind === "profile") {
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
  if (
    !["flag", "resolve", "duty"].includes(a.kind) ||
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
    a.kind === "duty" &&
    (!state.flightCommander ||
      !state.roster?.some((r) => r.personId === f.personId))
  )
    throw denied();
  if (
    a.kind === "resolve" &&
    (!state.flightCommander || !flag || flag.flightId !== p.flightId)
  )
    throw denied();
  const person =
    a.kind === "flag"
      ? p.personId
      : adminIdentifier(a.kind === "duty" ? f.personId : flag!.personId);
  const event =
    a.kind === "duty"
      ? null
      : adminIdentifier(a.kind === "flag" ? f.eventId : flag!.eventId);
  const parent = a.kind === "resolve" ? adminIdentifier(f.parentId) : null;
  const values = [
    commandId,
    a.kind,
    p.personId,
    person,
    p.flightId,
    event,
    parent,
    f.detail.trim(),
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
