import { markManagedFutureRosters } from './event-rosters.js';
import { parseCatalogCommand, type CatalogCommand, type OrganizationalCatalog } from '../../../packages/domain/src/organizational-catalog.js';
import { adminIdentifier } from '../../../packages/domain/src/admin.js';
import { effectiveAdminGrants } from './permission-grants.js';
import { prepareCatalogPermissions, permissionManagerSql } from './permissions.js';
import { HttpError } from './http-error.js';
interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    GENERATION: string;
}
type Value = string | number | null;
const stmt = (db: D1Database, sql: string, ...v: Value[]) => db.prepare(sql).bind(...v);
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const conflict = () => new HttpError(409, 'CATALOG_CONFLICT', 'The Flight or Squadron catalog changed. Reload and review the exact target.');
const authority = (env: Env, principalId: string, write: boolean) => ({ sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write ? ' AND accepting_commands=1' : ''}) AND EXISTS(SELECT 1 FROM principals p JOIN ${effectiveAdminGrants} g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND g.capability='directory.manage' AND g.scope_kind='wing' AND g.scope_key='*')`, values: [env.ENVIRONMENT, Number(env.GENERATION), principalId] as Value[] });
const flightsSql = `SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId,1 AS active,COALESCE(v.version,1) AS version,u.roster_version AS rosterVersion
 FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id LEFT JOIN organizational_catalog_versions v ON v.kind='flight' AND v.target_id=u.unit_id
 UNION ALL SELECT v.target_id,json_extract(v.value_json,'$.label'),json_extract(v.value_json,'$.squadronId'),0,v.version,NULL FROM organizational_catalog_versions v
 WHERE v.kind='flight' AND json_extract(v.value_json,'$.active')=0 AND NOT EXISTS(SELECT 1 FROM organizational_units u WHERE u.unit_id=v.target_id)`;
const squadsSql = `SELECT s.squadron_id AS squadronId,s.label,COALESCE(v.version,1) AS version FROM squadrons s LEFT JOIN organizational_catalog_versions v ON v.kind='squadron' AND v.target_id=s.squadron_id`;
export async function readOrganizationalCatalog(env: Env, input: unknown): Promise<OrganizationalCatalog> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'environment,generation,principalId')
        throw new HttpError(400, 'INVALID_CATALOG', 'Expected a private catalog read.');
    const r = input as Record<string, unknown>;
    if (r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION))
        throw conflict();
    const a = authority(env, adminIdentifier(r.principalId), false);
    const rows = await env.DB.batch<Record<string, unknown>>([stmt(env.DB, `SELECT (${a.sql}) AS allowed`, ...a.values), stmt(env.DB, 'SELECT (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration'), stmt(env.DB, `${flightsSql} ORDER BY flightId LIMIT 1001`), stmt(env.DB, `${squadsSql} ORDER BY squadronId LIMIT 21`)]);
    if (rows[0].results[0]?.allowed !== 1)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current Wing Directory management authority is required.');
    if (rows[2].results.length > 1000 || rows[3].results.length > 20)
        throw new HttpError(409, 'CATALOG_TOO_LARGE', 'The catalog exceeds its reviewed bound.');
    return { contractVersion: 1, environment: env.ENVIRONMENT as 'local' | 'staging', generation: Number(env.GENERATION), revision: rows[1].results[0] as unknown as OrganizationalCatalog['revision'], flights: rows[2].results.map(f => ({ ...f, active: !!f.active })) as unknown as OrganizationalCatalog['flights'], squadrons: rows[3].results as unknown as OrganizationalCatalog['squadrons'] };
}
async function receipt(env: Env, c: CatalogCommand, digest: string) {
    const a = authority(env, c.actor.principalId, true), r = await stmt(env.DB, `SELECT payload_hash AS hash,actor_id AS actor,receipt_json AS receipt,
 (${a.sql} AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)
 AND (NOT EXISTS(SELECT 1 FROM permission_command_requirements pr WHERE pr.command_id=admin_commands.command_id) OR ${permissionManagerSql})) AS allowed FROM admin_commands WHERE command_id=?`, ...a.values, c.source.kind, c.source.resourceKey, c.actor.principalId, c.commandId).first<{
        hash: string;
        actor: string;
        receipt: string;
        allowed: number;
    }>();
    if (!r)
        return null;
    if (r.allowed !== 1 || r.actor !== c.actor.principalId)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current authority and registered source are required.');
    if (r.hash !== digest)
        throw conflict();
    return JSON.parse(r.receipt);
}
export async function acceptCatalogCommand(env: Env, input: unknown): Promise<unknown> {
    const c = parseCatalogCommand(input);
    if (c.environment !== env.ENVIRONMENT || c.generation !== Number(env.GENERATION))
        throw conflict();
    const digest = await hash(JSON.stringify(c)), prior = await receipt(env, c, digest);
    if (prior)
        return prior;
    const catalog = await readOrganizationalCatalog(env, { environment: c.environment, generation: c.generation, principalId: c.actor.principalId }), flight = c.operation === 'flight.upsert', id = flight ? c.payload.flightId : c.payload.squadronId, before = flight ? catalog.flights.find(f => f.flightId === id) : catalog.squadrons.find(s => s.squadronId === id), now = new Date().toISOString(), version = c.payload.expectedVersion + 1;
    if ((before?.version ?? 0) !== c.payload.expectedVersion)
        throw conflict();
    if (flight && !catalog.squadrons.some(s => s.squadronId === c.payload.squadronId))
        throw conflict();
    // Operational queue names are a documented fixed contract, not freely renameable labels.
    if (!flight && ['blue', 'gold'].includes((before?.label ?? '').toLowerCase()) && before!.label !== c.payload.label)
        throw new HttpError(409, 'OPERATIONAL_SQUADRON_POLICY', 'Blue and Gold queue names require a coordinated presentation and policy change.');
    const auth = authority(env, c.actor.principalId, true);
    auth.sql += ' AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)';
    auth.values.push(c.source.kind, c.source.resourceKey);
    const affectedFlightIds = !before ? [] : flight
      ? (before as OrganizationalCatalog['flights'][number]).active && c.payload.active && (before.label !== c.payload.label || (before as OrganizationalCatalog['flights'][number]).squadronId !== c.payload.squadronId) ? [id] : []
      : before.label !== c.payload.label ? catalog.flights.filter(f => f.active && f.squadronId === id).map(f => f.flightId) : [];
    const permission = await prepareCatalogPermissions(env, c, now, digest, before?.label, affectedFlightIds);
    if (permission) {
        auth.sql += ` AND (${permission.assertion.sql})`;
        auth.values.push(...permission.assertion.values);
    }
    const key = flight ? 'flight' : 'squadron', table = flight ? 'organizational_units' : 'squadrons', column = flight ? 'unit_id' : 'squadron_id';
    let condition = `COALESCE((SELECT version FROM organizational_catalog_versions WHERE kind=? AND target_id=?),CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${column}=?) THEN 1 ELSE 0 END)=?
 AND NOT EXISTS(SELECT 1 FROM ${table} WHERE lower(trim(label))=lower(trim(?)) AND ${column}<>?)
 AND NOT EXISTS(SELECT 1 FROM excusal_records r WHERE NOT EXISTS(SELECT 1 FROM excusal_request_scopes s WHERE s.request_id=r.request_id))`;
    const values: Value[] = [key, id, id, c.payload.expectedVersion, c.payload.label, id], writes: D1PreparedStatement[] = [];
    if (before) {
        condition += ` AND COALESCE((SELECT label FROM ${table} WHERE ${column}=?),'')=?`;
        values.push(id, flight && !(before as OrganizationalCatalog['flights'][number]).active ? '' : before.label);
    }
    if (flight && before && (before as OrganizationalCatalog['flights'][number]).active) {
        condition += ' AND (SELECT squadron_id FROM flight_hierarchy WHERE unit_id=?)=?';
        values.push(id, (before as OrganizationalCatalog['flights'][number]).squadronId);
    }
    if (flight) {
        const p = c.payload;
        condition += ' AND EXISTS(SELECT 1 FROM squadrons WHERE squadron_id=?)';
        values.push(p.squadronId);
        if (p.active) {
            condition += ' AND ((SELECT COUNT(*) FROM organizational_units)<50 OR EXISTS(SELECT 1 FROM organizational_units WHERE unit_id=?))';
            values.push(id);
            writes.push(stmt(env.DB, 'INSERT INTO organizational_units VALUES(?,?,1) ON CONFLICT(unit_id) DO UPDATE SET label=excluded.label,roster_version=roster_version+1', id, p.label), stmt(env.DB, 'INSERT INTO flight_hierarchy VALUES(?,?) ON CONFLICT(unit_id) DO UPDATE SET squadron_id=excluded.squadron_id', id, p.squadronId));
        }
        else {
            if (!before)
                throw conflict();
            condition += ` AND NOT EXISTS(SELECT 1 FROM directory_profiles WHERE flight_id=?) AND NOT EXISTS(SELECT 1 FROM memberships WHERE unit_id=?) AND NOT EXISTS(SELECT 1 FROM event_units WHERE unit_id=?) AND NOT EXISTS(SELECT 1 FROM excusal_records WHERE unit_id=?) AND NOT EXISTS(SELECT 1 FROM admin_grants WHERE scope_kind='flight' AND scope_key=?) AND NOT EXISTS(SELECT 1 FROM event_roster_policies p,json_each(p.selected_flight_ids_json) f WHERE f.value=?)`;
            values.push(id, id, id, id, id, id);
            // Remaining foreign keys deliberately reject retirement of any historical or permission reference.
            writes.push(stmt(env.DB, 'DELETE FROM flight_hierarchy WHERE unit_id=?', id), stmt(env.DB, 'DELETE FROM organizational_units WHERE unit_id=?', id));
        }
    }
    else {
        condition += ' AND ((SELECT COUNT(*) FROM squadrons)<20 OR EXISTS(SELECT 1 FROM squadrons WHERE squadron_id=?))';
        values.push(id);
        writes.push(stmt(env.DB, 'INSERT INTO squadrons VALUES(?,?) ON CONFLICT(squadron_id) DO UPDATE SET label=excluded.label', id, c.payload.label));
    }
    const { expectedVersion, reason, ...value } = c.payload;
    const result = { commandId: c.commandId, status: 'committed', operation: c.operation, result: { targetId: id, version }, pendingEffects: true };
    const allowed = await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
        allowed: number;
    }>();
    if (!allowed?.allowed)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current authority and registered source are required.');
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (${condition}))`, c.commandId, ...auth.values, ...values), stmt(env.DB, "INSERT INTO command_registry VALUES(?,'admin')", c.commandId),
            stmt(env.DB, 'INSERT INTO admin_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', c.commandId, digest, c.actor.principalId, c.operation, id, 'directory.manage', '[]', c.source.kind, c.source.resourceKey, c.source.submissionId, c.source.revision, now, JSON.stringify(result)), ...(flight && !c.payload.active ? (permission?.writes ?? []) : []), ...writes,
            stmt(env.DB, 'INSERT INTO organizational_catalog_versions VALUES(?,?,?,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET version=excluded.version,value_json=excluded.value_json,command_id=excluded.command_id,updated_at=excluded.updated_at', key, id, version, JSON.stringify(value), c.commandId, now),
            ...(flight && !c.payload.active ? [] : (permission?.writes ?? [])), markManagedFutureRosters(env.DB, c.commandId, now, flight ? [id] : catalog.flights.filter(f => f.squadronId === id && f.active).map(f => f.flightId)), stmt(env.DB, 'INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)', c.commandId, c.actor.principalId, c.actor.evidence, c.operation, id, now, JSON.stringify({ catalog: before ?? null, roleLabels: (permission?.roleLabels ?? []).map(r => ({ source: r.source, id: r.id, role: r.before })) }), JSON.stringify({ ...c.payload, roleLabels: permission?.roleLabels ?? [], profileVersions: permission?.profileVersions ?? [] })),
            stmt(env.DB, "INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,'frontend.refresh','pending',?),(?,?,'forms.refresh','pending',?)", crypto.randomUUID(), c.commandId, now, crypto.randomUUID(), c.commandId, now), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', c.commandId)
        ]);
    }
    catch {
        const raced = await receipt(env, c, digest);
        if (raced)
            return raced;
        throw conflict();
    }
    return result;
}
