import { PANEL_PAGE_VERSION, PANEL_SECTIONS, resolvePanelAccess, type PanelAuthority, type PanelAuthorization, type PanelPage, type PanelRevision, type PanelSection } from '../../../packages/domain/src/panel-read.js';
import { FRONTEND_PAGE_MAX_BYTES, FRONTEND_SECTION_BOUNDS } from '../../../packages/domain/src/frontend-transport.js';
import { effectiveAccessGrants, effectiveAdminGrants, effectivePermissionMembers } from './permission-grants.js';
import { excusalDecisionRowPermission, excusalScopeJoin, excusalScopeSelect } from './excusal-scope.js';
import { HttpError } from './http-error.js';
import { permissionSourceRevisionSql } from './permissions.js';
import { pairRevisionSql } from './corrections.js';
import type { CommandScopeGuard } from './command-scope.js';

interface Env { DB: D1Database; ENVIRONMENT: string; GENERATION: string; }
type Row = Record<string, unknown>;
const fail = (status: number, code: string): never => { throw new HttpError(status, code, 'Reload the panel with current account access before continuing.'); };
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

/** Repeated in the data transaction: revocation/catalog drift cannot race a previously computed scope. */
function authorityStatements(env: Env, principal: string): D1PreparedStatement[] {
    const db = env.DB;
    return [
        db.prepare(`SELECT EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?) AS valid,
          EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND active=1) AS active,
          EXISTS(SELECT 1 FROM permission_managers WHERE principal_id=? AND active=1) AS manager,
          (SELECT COUNT(*) FROM terms WHERE is_current=1) AS termCount,(SELECT term_id FROM terms WHERE is_current=1) AS termId,
          (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration,
          (SELECT version FROM permission_policy_control WHERE singleton=1) AS permissionVersion,
          (SELECT policy_hash FROM permission_policy_control WHERE singleton=1) AS permissionHash,
          NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE state<>'complete') AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE state<>'complete') AS ready,
          (SELECT COUNT(*) FROM event_roster_refresh_work) AS rosterPending`).bind(env.ENVIRONMENT, Number(env.GENERATION), principal, principal),
        ...['admin_grants', effectiveAdminGrants].map(table => db.prepare(`SELECT capability,scope_kind AS kind,scope_key AS scope FROM ${table} WHERE principal_id=? ORDER BY capability,kind,scope LIMIT 501`).bind(principal)),
        ...['access_grants', effectiveAccessGrants].map(table => db.prepare(`SELECT capability,unit_id AS flightId,subject_scope AS subjectScope FROM ${table} WHERE principal_id=? ORDER BY capability,flightId,subjectScope LIMIT 501`).bind(principal)),
        db.prepare(`SELECT principal_id AS principalId,source_kind AS sourceKind,source_id AS sourceId,source_version AS sourceVersion,linked_contact_id AS linkedContactId,
          linked_contact_version AS linkedContactVersion,source_role AS sourceRole,source_flight_id AS sourceFlightId,source_status AS sourceStatus,linked_contact_active AS linkedContactActive
          FROM ${effectivePermissionMembers} WHERE principal_id=? LIMIT 2`).bind(principal),
        db.prepare(`SELECT json_extract(commander.value,'$.squadronId') AS squadronId FROM permission_policy_control pc
          JOIN principal_accounts a ON a.principal_id=? JOIN ${effectivePermissionMembers} m ON m.principal_id=a.principal_id
          JOIN json_each(pc.policy_json,'$.google.squadronCommanders') commander
          WHERE pc.singleton=1 AND pc.enabled=1 AND json_extract(commander.value,'$.email')=a.email ORDER BY squadronId LIMIT 21`).bind(principal),
        db.prepare('SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId,u.roster_version AS rosterVersion FROM organizational_units u LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id ORDER BY u.unit_id LIMIT 51'),
        db.prepare('SELECT squadron_id AS squadronId,label FROM squadrons ORDER BY squadron_id LIMIT 21'),
    ];
}
function authorityFrom(rows: Row[][]): PanelAuthority {
    if (rows[0][0]?.valid !== 1 || rows[0][0]?.active !== 1) fail(403, 'NOT_AUTHORIZED');
    if (rows.slice(1, 5).some(r => r.length > 500) || rows[5].length > 1 || rows[6].length > 20 || rows[7].length > 50 || rows[8].length > 20) fail(409, 'PANEL_SCOPE_TOO_LARGE');
    return {
        active: true, permissionManager: rows[0][0].manager === 1,
        explicitAdminGrants: rows[1] as unknown as PanelAuthority['explicitAdminGrants'], effectiveAdminGrants: rows[2] as unknown as PanelAuthority['effectiveAdminGrants'],
        explicitAccessGrants: rows[3] as unknown as PanelAuthority['explicitAccessGrants'], effectiveAccessGrants: rows[4] as unknown as PanelAuthority['effectiveAccessGrants'],
        member: (rows[5][0] ?? null) as unknown as PanelAuthority['member'], commanderSquadronIds: rows[6].map(r => String(r.squadronId)),
        flights: rows[7] as unknown as PanelAuthority['flights'], squadrons: rows[8] as unknown as PanelAuthority['squadrons'],
    };
}
function queries() {
    const people = 'd.person_id AS personId,d.version,d.flight_id AS flightId,d.last_name AS lastName,d.first_name AS firstName,d.rank,d.as_year AS asYear,d.flight_path_status AS flightPathStatus';
    const queries: Record<PanelSection, { select: string; from: string; countFrom?: string; order: string; limit: number; }> = {
        people: { select: people, from: 'FROM directory_profiles d WHERE d.person_id IN(SELECT person_id FROM scoped_people)', order: 'd.person_id', limit: 64 },
        flights: { select: 'u.unit_id AS flightId,u.label,h.squadron_id AS squadronId,u.roster_version AS rosterVersion', from: 'FROM organizational_units u LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id WHERE u.unit_id IN(SELECT flight_id FROM scoped_flights)', order: 'u.unit_id', limit: 50 },
        squadrons: { select: 's.squadron_id AS squadronId,s.label', from: 'FROM squadrons s WHERE s.squadron_id IN(SELECT h.squadron_id FROM flight_hierarchy h WHERE h.unit_id IN(SELECT flight_id FROM scoped_flights)) OR s.squadron_id IN(SELECT captured_squadron_id FROM visible_requests)', order: 's.squadron_id', limit: 20 },
        terms: { select: 'term_id AS termId,label,sort_order AS sortOrder,is_current AS isCurrent', from: 'FROM terms WHERE is_current=1', order: 'term_id', limit: 1 },
        events: { select: `e.event_id AS eventId,d.version,d.term_id AS termId,d.event_type AS eventType,d.training_week AS trainingWeek,d.display_order AS displayOrder,e.label,d.column_label AS columnLabel,d.expected_group AS expectedGroup,d.status,d.start_at AS startAt,d.end_at AS endAt,d.location,EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=e.event_id AND v.version=d.version) AS hasRoster`, from: 'FROM events e JOIN event_details d ON d.event_id=e.event_id WHERE e.event_id IN(SELECT event_id FROM scoped_events)', order: 'd.display_order,e.event_id', limit: 32 },
        eventRosters: { select: 'm.event_id AS eventId,m.person_id AS personId', from: 'FROM event_roster_members m JOIN event_details d ON d.event_id=m.event_id AND d.version=m.version WHERE m.event_id IN(SELECT event_id FROM scoped_events) AND m.person_id IN(SELECT person_id FROM scoped_people)', countFrom: 'FROM event_details d CROSS JOIN event_roster_members m ON d.event_id=m.event_id AND d.version=m.version WHERE d.event_id IN(SELECT event_id FROM scoped_events) AND m.person_id IN(SELECT person_id FROM scoped_people)', order: 'm.event_id,m.person_id', limit: 256 },
        eventFlights: { select: 'event_id AS eventId,unit_id AS flightId', from: 'FROM event_units WHERE event_id IN(SELECT event_id FROM scoped_events) AND unit_id IN(SELECT flight_id FROM scoped_flights)', order: 'event_id,unit_id', limit: 256 },
        observations: { select: `'observation:'||o.observation_id AS factId,o.person_id AS personId,o.event_id AS eventId,a.audit_id AS 'order',o.code`, from: 'FROM attendance_observations o JOIN attendance_reports r ON r.report_id=o.report_id JOIN audit_events a ON a.command_id=r.command_id WHERE o.event_id IN(SELECT event_id FROM scoped_events) AND o.person_id IN(SELECT person_id FROM scoped_people)', order: 'o.observation_id', limit: 256 },
        requests: { select: `r.request_id AS requestId,r.person_id AS personId,p.display_name AS personDisplayName,r.event_id AS eventId,r.unit_id AS flightId,${excusalScopeSelect},COALESCE(a.audit_id,0) AS 'order',(r.origin='legacy' AND r.last_command_id IS NULL) AS legacyStateOnly,r.status,r.requested_outcome AS requestedOutcome,r.version,r.reason,r.submitted_at AS submittedAt,r.updated_at AS updatedAt,r.decided_at AS decidedAt,r.decision_reason AS decisionReason,r.can_decide AS canDecide`, from: `FROM visible_requests r JOIN people p ON p.person_id=r.person_id ${excusalScopeJoin} LEFT JOIN audit_events a ON a.command_id=r.last_command_id`, order: 'r.request_id', limit: 32 },
        corrections: { select: `'correction:'||c.correction_id AS factId,c.person_id AS personId,c.event_id AS eventId,a.audit_id AS 'order',c.code`, from: 'FROM attendance_corrections c JOIN audit_events a ON a.command_id=c.command_id WHERE c.event_id IN(SELECT event_id FROM scoped_events) AND c.person_id IN(SELECT person_id FROM scoped_people)', order: 'a.audit_id', limit: 256 },
        legacyBaselines: { select: 'b.baseline_id AS baselineId,b.person_id AS personId,b.event_id AS eventId,b.code', from: "FROM legacy_attendance_baselines b JOIN legacy_import_runs i ON i.import_run_id=b.import_run_id AND i.state='complete' WHERE b.event_id IN(SELECT event_id FROM scoped_events) AND b.person_id IN(SELECT person_id FROM scoped_people)", countFrom: "FROM legacy_attendance_baselines b WHERE b.import_run_id IN(SELECT import_run_id FROM legacy_import_runs WHERE state='complete') AND b.event_id IN(SELECT event_id FROM scoped_events) AND b.person_id IN(SELECT person_id FROM scoped_people)", order: 'b.person_id,b.event_id', limit: 256 },
    };
    return queries;
}

/** Signed adapter route; principalId must come from the panel server's verified session, never browser JSON. */
export async function panelSnapshotPage(env: Env, input: unknown): Promise<PanelPage> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'INVALID_PANEL_REQUEST');
    const req = input as Row;
    if (Object.keys(req).sort().join(',') !== 'environment,generation,offset,principalId,revision,section' || !identifier(req.principalId)
        || !['manifest', 'verify', ...PANEL_SECTIONS].includes(String(req.section)) || !Number.isSafeInteger(req.offset) || Number(req.offset) < 0) fail(400, 'INVALID_PANEL_REQUEST');
    if (req.environment !== env.ENVIRONMENT || req.generation !== Number(env.GENERATION)) fail(409, 'WRONG_GENERATION');
    const section = req.section as PanelPage['section'], offset = Number(req.offset), expected = req.revision as PanelRevision | null, principal = String(req.principalId);
    if (section === 'manifest' ? expected !== null || offset !== 0 : !expected || typeof expected !== 'object' || Array.isArray(expected)
        || Object.keys(expected).sort().join(',') !== 'access,administration,operations' || typeof expected.access !== 'string' || !/^[a-f0-9]{64}$/.test(expected.access)
        || ![expected.operations, expected.administration].every(v => Number.isSafeInteger(v) && v >= 0)) fail(400, 'INVALID_PANEL_REQUEST');
    if (section === 'verify' && offset !== 0 || section !== 'manifest' && section !== 'verify' && offset > FRONTEND_SECTION_BOUNDS[section]) fail(400, 'INVALID_PANEL_REQUEST');
    const first = (await env.DB.batch<Row>(authorityStatements(env, principal))).map(r => r.results);
    const authority = authorityFrom(first), access = resolvePanelAccess(authority);
    if (!access) return fail(403, 'NOT_AUTHORIZED');
    const control = first[0][0];
    if (control.ready !== 1) fail(409, 'SNAPSHOT_IMPORT_ACTIVE');
    if (Number(control.rosterPending)) fail(409, 'EVENT_ROSTERS_PENDING');
    if (control.termCount !== 1 || !control.termId) fail(409, 'TERM_SCOPE_UNAVAILABLE');
    const hashInput = JSON.stringify({ principalId: req.principalId, authority, permissionVersion: control.permissionVersion, permissionHash: control.permissionHash, termId: control.termId });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
    const revision: PanelRevision = { operations: Number(control.operations), administration: Number(control.administration), access: [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') };
    if (expected && (expected.operations !== revision.operations || expected.administration !== revision.administration || expected.access !== revision.access)) fail(409, 'SNAPSHOT_CHANGED');
    const decision = excusalDecisionRowPermission(principal);
    // Manifest counts reuse the same small scope sets in eleven subqueries. Keep
    // them within this transaction instead of recalculating decisions per count.
    // Page queries retain streaming plans so LIMIT can stop reads early.
    const materialized = section === 'manifest' ? 'MATERIALIZED ' : '';
    const cte = `WITH scoped_flights AS ${materialized}(SELECT value AS flight_id FROM json_each(?)),
      scoped_people AS ${materialized}(SELECT d.person_id FROM directory_profiles d WHERE d.flight_id IN(SELECT flight_id FROM scoped_flights)
        AND d.flight_path_status NOT IN ('Inactive','Commissioned','Dropped') AND EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1)),
      candidates AS (SELECT r.request_id,r.event_id,r.person_id,r.unit_id,r.origin,r.last_command_id,r.status,r.requested_outcome,r.version,r.reason,
        r.submitted_at,r.updated_at,r.decided_at,r.decision_reason,sc.squadron_id AS captured_squadron_id,${decision.sql} AS can_decide FROM excusal_records r ${excusalScopeJoin}
        JOIN event_details d ON d.event_id=r.event_id JOIN terms t ON t.term_id=d.term_id AND t.is_current=1
        WHERE r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions a WHERE a.adoption_id=r.legacy_adoption_id AND a.state='complete')),
      visible_requests AS ${materialized}(SELECT * FROM candidates WHERE can_decide=1 OR unit_id IN(SELECT flight_id FROM scoped_flights) OR person_id IN(SELECT person_id FROM scoped_people)),
      scoped_events AS ${materialized}(SELECT d.event_id FROM event_details d JOIN terms t ON t.term_id=d.term_id AND t.is_current=1
        WHERE EXISTS(SELECT 1 FROM event_units eu WHERE eu.event_id=d.event_id AND eu.unit_id IN(SELECT flight_id FROM scoped_flights))
          OR EXISTS(SELECT 1 FROM visible_requests r WHERE r.event_id=d.event_id)
          OR EXISTS(SELECT 1 FROM event_roster_members m WHERE m.event_id=d.event_id AND m.version=d.version AND m.person_id IN(SELECT person_id FROM scoped_people))
          OR EXISTS(SELECT 1 FROM attendance_observations o WHERE o.event_id=d.event_id AND o.person_id IN(SELECT person_id FROM scoped_people))
          OR EXISTS(SELECT 1 FROM attendance_corrections c WHERE c.event_id=d.event_id AND c.person_id IN(SELECT person_id FROM scoped_people))
          OR EXISTS(SELECT 1 FROM legacy_attendance_baselines b WHERE b.event_id=d.event_id AND b.person_id IN(SELECT person_id FROM scoped_people))) `;
    const bind = [JSON.stringify(access.flightIds), ...decision.values];
    const allQueries = queries(), statements = authorityStatements(env, principal), dataIndex = statements.length;
    if (section === 'manifest') statements.push(env.DB.prepare(`${cte} SELECT ${PANEL_SECTIONS.map(s => `(SELECT COUNT(*) ${allQueries[s].countFrom ?? allQueries[s].from}) AS ${s}`).join(',')}`).bind(...bind));
    else if (section !== 'verify') {
        const q = allQueries[section];
        statements.push(env.DB.prepare(`${cte} SELECT ${q.select} ${q.from} ORDER BY ${q.order} LIMIT ? OFFSET ?`).bind(...bind, q.limit + 1, offset));
    }
    const second = await env.DB.batch<Row>(statements);
    if (JSON.stringify(first) !== JSON.stringify(second.slice(0, dataIndex).map(r => r.results))) fail(409, 'SNAPSHOT_CHANGED');
    const response: PanelPage = { contractVersion: PANEL_PAGE_VERSION, environment: env.ENVIRONMENT as PanelPage['environment'], generation: Number(env.GENERATION), section, revision, scope: { termId: String(control.termId), currentTermId: String(control.termId) }, access };
    if (section === 'verify') return { ...response, verified: true };
    if (section === 'manifest') {
        const counts = second[dataIndex].results[0], sections = PANEL_SECTIONS.map(section => ({ section, count: Number(counts[section]) }));
        if (sections.some(s => s.count > FRONTEND_SECTION_BOUNDS[s.section])) fail(409, 'SNAPSHOT_TOO_LARGE');
        return { ...response, sections };
    }
    const q = allQueries[section], source = second[dataIndex].results, rows: Row[] = [];
    let bytes = new TextEncoder().encode(JSON.stringify(response)).length + 100;
    for (const raw of source.slice(0, q.limit)) {
        const row = section === 'requests' ? { ...raw, canDecide: raw.canDecide === 1, legacyStateOnly: raw.legacyStateOnly === 1 } : raw;
        const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
        if (bytes + size > FRONTEND_PAGE_MAX_BYTES) { if (!rows.length) fail(409, 'SNAPSHOT_ROW_TOO_LARGE'); break; }
        bytes += size; rows.push(row);
    }
    return { ...response, offset, nextOffset: source.length > rows.length ? offset + rows.length : null, rows };
}

/** Capture exactly the authority inputs used by resolvePanelAccess, including out-of-band revocation.
 * The JSON is private SQL guard material, never returned to the browser or treated as a bearer token. */
function scopeRevision(principal: string): CommandScopeGuard {
    const grant = (table: string, columns: string) => `(SELECT json_group_array(json_array(${columns})) FROM (SELECT * FROM ${table} WHERE principal_id=(SELECT principal_id FROM panel_actor) ORDER BY ${columns}))`;
    return {
        sql: `WITH panel_actor AS (SELECT ? AS principal_id) SELECT json_array((${permissionSourceRevisionSql}),
          (SELECT json_array(environment,generation) FROM system_control WHERE singleton=1),
          (SELECT json_array(enabled,version,policy_hash,config_json) FROM permission_policy_control WHERE singleton=1),
          (SELECT json_group_array(json_array(term_id,is_current)) FROM (SELECT term_id,is_current FROM terms ORDER BY term_id)),
          ${grant('admin_grants', 'capability,scope_kind,scope_key')},${grant('access_grants', 'capability,unit_id,subject_scope')},
          ${grant('role_admin_grants', 'capability,scope_kind,scope_key')},${grant('role_access_grants', 'capability,unit_id,subject_scope')},
          ${grant('role_permission_members', 'source_kind,source_id,source_version,linked_contact_id,linked_contact_version,policy_version,source_role,source_flight_id,source_status,linked_contact_active')},
          (SELECT COUNT(*) FROM legacy_import_runs WHERE state<>'complete'),(SELECT COUNT(*) FROM legacy_operational_adoptions WHERE state<>'complete'),(SELECT COUNT(*) FROM event_roster_refresh_work)) AS revision`,
        values: [principal],
    };
}

/** Targeted preview and an internal atomic commit/replay guard. No state is changed or grant inferred. */
export async function preparePanelAuthorization(env: Env, input: unknown): Promise<{ authorization: PanelAuthorization; guard: CommandScopeGuard }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'INVALID_PANEL_REQUEST');
    const req = input as Row, target = req.target as Row;
    if (Object.keys(req).sort().join(',') !== 'environment,generation,operation,principalId,target' || !identifier(req.principalId)
        || !['excusal.decide', 'attendance.correct'].includes(String(req.operation)) || !target || typeof target !== 'object' || Array.isArray(target)) return fail(400, 'INVALID_PANEL_REQUEST');
    const decision = req.operation === 'excusal.decide';
    if (Object.keys(target).sort().join(',') !== (decision ? 'requestId' : 'eventId,personId') || Object.values(target).some(v => !identifier(v))) return fail(400, 'INVALID_PANEL_REQUEST');
    if (req.environment !== env.ENVIRONMENT || req.generation !== Number(env.GENERATION)) return fail(409, 'WRONG_GENERATION');
    const principal = String(req.principalId), source = scopeRevision(principal);
    const authorityQueries = authorityStatements(env, principal), sourceIndex = authorityQueries.length;
    const initial = await env.DB.batch<Row>([...authorityQueries, env.DB.prepare(source.sql).bind(...source.values)]);
    const access = resolvePanelAccess(authorityFrom(initial.slice(0, sourceIndex).map(r => r.results)));
    if (!access) return fail(403, 'NOT_AUTHORIZED');
    const control = initial[0].results[0];
    if (control.ready !== 1) return fail(409, 'SNAPSHOT_IMPORT_ACTIVE');
    if (Number(control.rosterPending)) return fail(409, 'EVENT_ROSTERS_PENDING');
    if (control.termCount !== 1 || !control.termId) return fail(409, 'TERM_SCOPE_UNAVAILABLE');
    const sourceValue = String(initial[sourceIndex].results[0].revision), full = access.capabilities.fullSnapshot ? 1 : 0;
    let from: string, select: string, targetValues: (string | number | null)[], selectValues: (string | number | null)[] = [];
    if (decision) {
        const permission = excusalDecisionRowPermission(principal);
        from = `FROM excusal_records r JOIN event_details d ON d.event_id=r.event_id WHERE r.request_id=?
          AND (r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions a WHERE a.adoption_id=r.legacy_adoption_id AND a.state='complete'))
          AND (?=1 OR EXISTS(SELECT 1 FROM terms t WHERE t.term_id=d.term_id AND t.is_current=1)) AND ${permission.sql}`;
        select = 'r.version AS expectedVersion,r.status,r.requested_outcome AS requestedOutcome,r.reason,r.decision_reason AS decisionReason';
        targetValues = [String(target.requestId), full, ...permission.values];
    } else {
        from = `FROM event_details d JOIN event_roster_members m ON m.event_id=d.event_id AND m.version=d.version
          LEFT JOIN directory_profiles p ON p.person_id=m.person_id WHERE d.event_id=? AND m.person_id=?
          AND EXISTS(SELECT 1 FROM principals actor JOIN ${effectiveAdminGrants} g ON g.principal_id=actor.principal_id WHERE actor.principal_id=? AND actor.active=1
            AND g.capability='attendance.correct' AND (g.scope_kind='wing' AND g.scope_key='*' OR g.scope_kind='flight' AND g.scope_key=m.flight_id))
          AND (?=1 OR (EXISTS(SELECT 1 FROM terms t WHERE t.term_id=d.term_id AND t.is_current=1)
            AND p.flight_id IN(SELECT value FROM json_each(?)) AND m.flight_id IN(SELECT value FROM json_each(?))
            AND p.flight_path_status NOT IN('Inactive','Commissioned','Dropped')
            AND EXISTS(SELECT 1 FROM memberships current_member WHERE current_member.person_id=p.person_id AND current_member.unit_id=p.flight_id AND current_member.active=1)))`;
        select = `d.version AS expectedEventVersion,m.flight_id AS flightId,(${pairRevisionSql}) AS expectedBaseVersion`;
        const flights = JSON.stringify(access.capabilities.attendanceCorrectionFlightIds);
        targetValues = [String(target.eventId), String(target.personId), principal, full, flights, flights];
        selectValues = Array.from({ length: 3 }, () => [String(target.eventId), String(target.personId)]).flat();
    }
    const rows = await env.DB.batch<Row>([env.DB.prepare(source.sql).bind(...source.values), env.DB.prepare(`SELECT ${select} ${from}`).bind(...selectValues, ...targetValues)]);
    if (rows[0].results[0]?.revision !== sourceValue) return fail(409, 'SNAPSHOT_CHANGED');
    const current = rows[1].results[0];
    if (!current) return fail(403, 'NOT_AUTHORIZED');
    return {
        authorization: { contractVersion: 'panel-authorization-v1', environment: env.ENVIRONMENT as PanelAuthorization['environment'], generation: Number(env.GENERATION), allowed: true,
            operation: req.operation, target, current } as PanelAuthorization,
        guard: { sql: `(${source.sql})=? AND EXISTS(SELECT 1 ${from})`, values: [...source.values, sourceValue, ...targetValues] },
    };
}
