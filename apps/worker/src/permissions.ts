/** Trusted, revisioned access policy. Google publication is a separate durable, fail-closed operation. */
import { adminIdentifier, DIRECTORY_FIELDS, operationallyActive, type AdminCommand, type DirectoryRecord } from '../../../packages/domain/src/admin.js';
import { buildRolePermissionPolicy, type PermissionAccount, type PermissionContact, type PermissionFlight, type RolePermissionPolicy } from '../../../packages/domain/src/permissions.js';
import { HttpError } from './http-error.js';
interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    GENERATION: string;
}
type Value = string | number | null;
const stmt = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const sha = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const columns = ['last_name', 'first_name', 'as_year', 'rank', 'role', 'university', 'email', 'phone', 'dorm', 'cip_broad_area', 'cip_code', 'afsc', 'home_town', 'home_state', 'class_year', 'date_of_birth', 'flight_path_status', 'photo_link'];
export const permissionManagerSql = `EXISTS(SELECT 1 FROM permission_managers m JOIN principals p ON p.principal_id=m.principal_id WHERE m.principal_id=? AND m.active=1 AND p.active=1)`;
// Compact optimistic fence over every source affecting permissions, including non-command identity/catalog changes.
const sourceRevisionSql = `SELECT json_array(
 (SELECT json_group_array(json_array(person_id,version,flight_id,email,role,flight_path_status)) FROM (SELECT * FROM directory_profiles ORDER BY person_id)),
 (SELECT json_group_array(json_array(person_id,unit_id,active)) FROM (SELECT * FROM memberships ORDER BY person_id,unit_id)),
 (SELECT json_group_array(json_array(contact_id,version,person_id,role,email,active)) FROM (SELECT * FROM leadership_contacts ORDER BY contact_id)),
 (SELECT json_group_array(json_array(principal_id,person_id,active,email)) FROM (SELECT p.principal_id,p.person_id,p.active,a.email FROM principals p LEFT JOIN principal_accounts a ON a.principal_id=p.principal_id ORDER BY p.principal_id)),
 (SELECT json_group_array(json_array(unit_id,label,squadron_id)) FROM (SELECT u.unit_id,u.label,h.squadron_id FROM organizational_units u LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id ORDER BY u.unit_id)),
 (SELECT json_group_array(json_array(squadron_id,label)) FROM (SELECT * FROM squadrons ORDER BY squadron_id)),
 (SELECT json_group_array(json_array(principal_id,active)) FROM (SELECT * FROM permission_managers ORDER BY principal_id))) AS revision`;
interface Facts {
    version: number;
    enabled: boolean;
    hash: string;
    config: {
        operationalSquadronIds: string[];
    };
    sourceRevision: string;
    managerPrincipalIds: string[];
    people: DirectoryRecord[];
    contacts: PermissionContact[];
    accounts: PermissionAccount[];
    flights: PermissionFlight[];
    squadrons: {
        squadronId: string;
        label: string;
    }[];
}
async function facts(env: Env): Promise<Facts> {
    const r = await env.DB.batch<Record<string, unknown>>([
        stmt(env.DB, 'SELECT version,enabled,policy_hash AS hash,config_json AS config FROM permission_policy_control WHERE singleton=1'),
        stmt(env.DB, sourceRevisionSql),
        stmt(env.DB, `SELECT d.person_id AS personId,d.version,d.flight_id AS flightId,${columns.map((c, i) => `d.${c} AS ${DIRECTORY_FIELDS[i]}`).join(',')},
      EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1) AS active FROM directory_profiles d ORDER BY d.person_id LIMIT 501`),
        stmt(env.DB, 'SELECT contact_id AS contactId,version,person_id AS personId,role,email,active FROM leadership_contacts ORDER BY contact_id LIMIT 201'),
        stmt(env.DB, 'SELECT a.principal_id AS principalId,a.email,p.person_id AS personId,p.active FROM principal_accounts a JOIN principals p ON p.principal_id=a.principal_id ORDER BY a.principal_id LIMIT 1001'),
        stmt(env.DB, 'SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id ORDER BY u.unit_id LIMIT 51'),
        stmt(env.DB, 'SELECT squadron_id AS squadronId,label FROM squadrons ORDER BY squadron_id LIMIT 21'),
        stmt(env.DB, 'SELECT m.principal_id AS principalId FROM permission_managers m JOIN principals p ON p.principal_id=m.principal_id WHERE m.active=1 AND p.active=1 ORDER BY m.principal_id LIMIT 501'),
    ]);
    const c = r[0].results[0];
    return { version: Number(c.version), enabled: !!c.enabled, hash: String(c.hash), config: JSON.parse(String(c.config)), sourceRevision: String(r[1].results[0].revision),
        managerPrincipalIds: r[7].results.map(p => String(p.principalId)), people: r[2].results.map(p => ({ ...p, active: !!p.active })) as unknown as DirectoryRecord[], contacts: r[3].results.map(p => ({ ...p, active: !!p.active })) as unknown as PermissionContact[],
        accounts: r[4].results.map(p => ({ ...p, active: !!p.active })) as unknown as PermissionAccount[], flights: r[5].results as unknown as PermissionFlight[], squadrons: r[6].results as unknown as Facts['squadrons'] };
}
const publisherSql = `EXISTS(SELECT 1 FROM permission_publishers m JOIN principals p ON p.principal_id=m.principal_id WHERE m.principal_id=? AND m.active=1 AND p.active=1)`;
const fenceSql = `EXISTS(SELECT 1 FROM permission_change_fences f JOIN permission_publishers pp ON pp.principal_id=f.publisher_id JOIN principals p ON p.principal_id=pp.principal_id
  WHERE f.command_id=? AND f.payload_hash=? AND f.policy_version=? AND f.expires_at>? AND f.consumed_at IS NULL AND pp.active=1 AND p.active=1)`;
const conflict = () => new HttpError(409, 'PERMISSION_CONFLICT', 'The trusted access policy changed. Reload and review before retrying.');
function guard(env: Env, principalId: string, write: boolean, publisher = false) {
    return { sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write ? ' AND accepting_commands=1' : ''}) AND ${publisher ? publisherSql : permissionManagerSql}`,
        values: [env.ENVIRONMENT, Number(env.GENERATION), principalId] as Value[] };
}
function sourceGuard(f: Facts) { return { sql: `(SELECT version FROM permission_policy_control WHERE singleton=1)=? AND (${sourceRevisionSql.replace(' AS revision', '')})=?`, values: [f.version, f.sourceRevision] as Value[] }; }
async function policyWrites(env: Env, f: Facts, commandId: string, actorId: string, now: string): Promise<D1PreparedStatement[]> {
    const policy = buildRolePermissionPolicy({ ...f, operationalSquadronIds: f.config.operationalSquadronIds }), json = JSON.stringify(policy), hash = await sha(json), version = f.version + 1;
    return [
        stmt(env.DB, 'DELETE FROM role_permission_members'),
        stmt(env.DB, `INSERT INTO role_permission_members SELECT json_extract(value,'$.principalId'),json_extract(value,'$.sourceKind'),json_extract(value,'$.sourceId'),json_extract(value,'$.sourceVersion'),json_extract(value,'$.linkedContactId'),json_extract(value,'$.linkedContactVersion'),?,json_extract(value,'$.sourceRole'),json_extract(value,'$.sourceFlightId'),json_extract(value,'$.sourceStatus'),json_extract(value,'$.linkedContactActive') FROM json_each(?)`, version, JSON.stringify(policy.members)),
        stmt(env.DB, `INSERT INTO role_access_grants SELECT json_extract(value,'$.principalId'),json_extract(value,'$.capability'),json_extract(value,'$.flightId'),json_extract(value,'$.subjectScope') FROM json_each(?)`, JSON.stringify(policy.accessGrants)),
        stmt(env.DB, `INSERT INTO role_admin_grants SELECT json_extract(value,'$.principalId'),json_extract(value,'$.capability'),json_extract(value,'$.scopeKind'),json_extract(value,'$.scopeKey') FROM json_each(?)`, JSON.stringify(policy.adminGrants)),
        stmt(env.DB, 'UPDATE permission_policy_control SET enabled=1,version=?,policy_json=?,policy_hash=?,last_command_id=?,config_json=? WHERE singleton=1', version, json, hash, commandId, JSON.stringify(f.config)),
        stmt(env.DB, 'INSERT INTO permission_policy_audit VALUES(?,?,?,?,?,?,?)', version, commandId, actorId, now, f.hash, hash, json),
        stmt(env.DB, "INSERT INTO permission_refresh_jobs(job_id,command_id,version,state) VALUES(?,?,?,'pending')", `permissions.${version}`, commandId, version),
    ];
}
export interface PermissionMutation {
    managerRequired: boolean;
    assertion: {
        sql: string;
        values: Value[];
    };
    writes: D1PreparedStatement[];
}
/** Called before a Directory/Leadership transaction; its guard and writes join that same atomic batch. */
export async function preparePermissionMutation(env: Env, c: AdminCommand, now: string, targetId: string, payloadHash: string): Promise<PermissionMutation | null> {
    if (!c.operation.startsWith('directory.') && c.operation !== 'leadership.upsert')
        return null;
    // Disabled installations retain existing behavior; source-derived grants never activate implicitly.
    const enabled = await stmt(env.DB, 'SELECT enabled FROM permission_policy_control WHERE singleton=1').first<{
        enabled: number;
    }>();
    if (!enabled?.enabled)
        return null;
    const f = await facts(env);
    let managerRequired = false;
    const extra: D1PreparedStatement[] = [];
    if (c.operation === 'directory.upsert') {
        const p = c.payload, prior = f.people.find(x => x.personId === p.personId);
        managerRequired = !prior || prior.role !== p.profile.role || prior.email.toLowerCase() !== p.profile.email.toLowerCase() || prior.flightId !== p.flightId || prior.flightPathStatus !== p.profile.flightPathStatus;
        f.people = f.people.filter(x => x.personId !== p.personId);
        f.people.push({ ...p.profile, personId: p.personId, flightId: p.flightId, version: p.expectedVersion + 1, active: operationallyActive(p.profile) });
    }
    else if (c.operation === 'directory.selfUpdate') {
        f.people = f.people.map(p => p.personId === c.payload.personId ? { ...p, ...c.payload.changes, version: c.payload.expectedVersion + 1 } : p);
    }
    else if (c.operation === 'directory.enroll') {
        const p = c.payload;
        if (!f.people.some(x => x.personId === targetId))
            f.people.push({ ...p.profile, personId: targetId, flightId: p.flightId, version: 1, active: true });
        const prior = f.accounts.find(a => a.principalId === c.actor.principalId);
        if (prior && (prior.email !== p.verifiedEmail || prior.personId !== targetId))
            throw conflict();
        if (!prior) {
            f.accounts.push({ principalId: c.actor.principalId, email: p.verifiedEmail, personId: targetId, active: true });
            extra.push(stmt(env.DB, "INSERT INTO principal_accounts VALUES(?,?,'google-form',?)", c.actor.principalId, p.verifiedEmail, c.commandId));
        }
    }
    else if (c.operation === 'leadership.upsert') {
        const p = c.payload, prior = f.contacts.find(x => x.contactId === p.contactId);
        managerRequired = !prior || prior.personId !== p.personId || prior.active !== p.active || p.personId === null && (prior.role !== p.profile!.role || prior.email.toLowerCase() !== p.profile!.email.toLowerCase());
        f.contacts = f.contacts.filter(x => x.contactId !== p.contactId);
        f.contacts.push({ contactId: p.contactId, version: p.expectedVersion + 1, personId: p.personId, role: p.profile?.role ?? '', email: p.profile?.email ?? '', active: p.active });
    }
    const assertion = sourceGuard(f);
    if (managerRequired) {
        const manager = await stmt(env.DB, `SELECT (${permissionManagerSql}) AS allowed`, c.actor.principalId).first<{allowed:number}>();
        if (!manager?.allowed) throw new HttpError(403, 'NOT_AUTHORIZED', 'Current permission-manager authority is required.');
        const fence = await stmt(env.DB, `SELECT (${fenceSql}) AS allowed`, c.commandId, payloadHash, f.version, now).first<{
            allowed: number;
        }>();
        if (!fence?.allowed)
            throw new HttpError(409, 'PERMISSION_FENCE_REQUIRED', 'The automation publisher must verify the native access fence for this exact command first.');
        assertion.sql += ` AND ${permissionManagerSql} AND ${fenceSql}`;
        assertion.values.push(c.actor.principalId, c.commandId, payloadHash, f.version, now);
        extra.push(stmt(env.DB, 'UPDATE permission_change_fences SET consumed_at=? WHERE command_id=?', now, c.commandId));
    }
    return { managerRequired, assertion, writes: [...extra, ...await policyWrites(env, f, c.commandId, c.actor.principalId, now), ...(managerRequired ? [stmt(env.DB, 'INSERT INTO permission_command_requirements VALUES(?)', c.commandId)] : [])] };
}
/** Transition acceptance changes role/scope/status in one batch and must refresh the same policy. */
export async function prepareTransitionPermissions(env: Env, input: {
    commandId: string;
    principalId: string;
    people: DirectoryRecord[];
    now: string;
    payloadHash: string;
}): Promise<PermissionMutation | null> {
    const enabled = await stmt(env.DB, 'SELECT enabled FROM permission_policy_control WHERE singleton=1').first<{
        enabled: number;
    }>();
    if (!enabled?.enabled)
        return null;
    const f = await facts(env), assertion = sourceGuard(f);
    const manager=await stmt(env.DB, `SELECT (${permissionManagerSql}) AS allowed`,input.principalId).first<{allowed:number}>();
    if(!manager?.allowed)throw new HttpError(403,'NOT_AUTHORIZED','Current permission-manager authority is required.');
    const fence=await stmt(env.DB,`SELECT (${fenceSql}) AS allowed`,input.commandId,input.payloadHash,f.version,input.now).first<{allowed:number}>();
    if(!fence?.allowed)throw new HttpError(409,'PERMISSION_FENCE_REQUIRED','Verify the exact native access fence before accepting this transition.');
    assertion.sql += ` AND ${permissionManagerSql} AND ${fenceSql}`;
    assertion.values.push(input.principalId, input.commandId, input.payloadHash, f.version, input.now);
    f.people = f.people.map(p => input.people.find(n => n.personId === p.personId) ?? p);
    return { managerRequired: true, assertion, writes: [stmt(env.DB, 'UPDATE permission_change_fences SET consumed_at=? WHERE command_id=?', input.now, input.commandId), ...await policyWrites(env, f, input.commandId, input.principalId, input.now), stmt(env.DB, 'INSERT INTO permission_command_requirements VALUES(?)', input.commandId)] };
}
function inputRecord(input: unknown, env: Env, extra: string[], optional: string[] = []): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Expected a structured permission request.');
    const r = input as Record<string, unknown>, required = ['environment', 'generation', 'principalId', ...extra];
    if (required.some(k => !Object.hasOwn(r, k)) || Object.keys(r).some(k => !required.includes(k) && !optional.includes(k)) || r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION))
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Unexpected permission fields or generation.');
    adminIdentifier(r.principalId);
    return r;
}
async function authorized(env: Env, principalId: string, write: boolean, publisher = false) {
    const g = guard(env, principalId, write, publisher), r = await stmt(env.DB, `SELECT (${g.sql}) AS allowed`, ...g.values).first<{
        allowed: number;
    }>();
    if (r?.allowed !== 1)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current explicit permission-manager authority is required.');
    return g;
}
/** Explicit identity enrollment/reconciliation; Form claims cannot call this route. */
export async function permissionCommand(env: Env, input: unknown): Promise<unknown> {
    const r = inputRecord(input, env, ['commandId', 'expectedVersion', 'accounts', 'revokePrincipalIds', 'operationalSquadronIds']);
    const principal = String(r.principalId), id = adminIdentifier(r.commandId), auth = await authorized(env, principal, true), digest = await sha(JSON.stringify(input));
    const prior = await stmt(env.DB, 'SELECT actor_id AS actor,payload_hash AS hash,receipt_json AS receipt FROM permission_commands WHERE command_id=?', id).first<{
        actor: string;
        hash: string;
        receipt: string;
    }>();
    if (prior) {
        if (prior.actor !== principal || prior.hash !== digest)
            throw conflict();
        return JSON.parse(prior.receipt);
    }
    if (!Number.isSafeInteger(r.expectedVersion) || Number(r.expectedVersion) < 0 || !Array.isArray(r.accounts) || r.accounts.length > 500 || !Array.isArray(r.revokePrincipalIds) || r.revokePrincipalIds.length > 500 || !Array.isArray(r.operationalSquadronIds) || r.operationalSquadronIds.length > 20)
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Permission changes exceed their bounded contract.');
    const f = await facts(env), original = sourceGuard(f), changes: D1PreparedStatement[] = [];
    if (f.version !== r.expectedVersion)
        throw conflict();
    const revokes = (r.revokePrincipalIds as unknown[]).map(v => adminIdentifier(v));
    const accounts = (r.accounts as unknown[]).map(v => {
        if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'email,personId,principalId')
            throw new HttpError(400, 'INVALID_PERMISSIONS', 'Named account bindings require exact fields.');
        const a = v as Record<string, unknown>, principalId = adminIdentifier(a.principalId), personId = a.personId === null ? null : adminIdentifier(a.personId);
        if (typeof a.email !== 'string' || a.email !== a.email.trim().toLowerCase() || a.email.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(a.email))
            throw new HttpError(400, 'INVALID_PERMISSIONS', 'Named account binding requires a normalized email.');
        return { principalId, personId, email: a.email, active: true };
    });
    if (new Set(accounts.map(a => a.principalId)).size !== accounts.length || new Set(accounts.map(a => a.email)).size !== accounts.length || accounts.some(a => revokes.includes(a.principalId)))
        throw conflict();
    const principals = (await stmt(env.DB, 'SELECT principal_id AS principalId,person_id AS personId,active FROM principals ORDER BY principal_id LIMIT 1001').all<{
        principalId: string;
        personId: string | null;
        active: number;
    }>()).results;
    if (principals.length > 1000)
        throw conflict();
    for (const a of accounts) {
        const p = principals.find(p => p.principalId === a.principalId);
        if (p && (!p.active || p.personId !== a.personId) || a.personId !== null && !f.people.some(p => p.personId === a.personId && p.email.toLowerCase() === a.email))
            throw conflict();
        if (!p) {
            if (a.principalId !== `google.${await sha(a.email)}`)
                throw new HttpError(400, 'INVALID_PERMISSIONS', 'New principals must use the verified Google account identifier.');
        }
    }
    const accountJson = JSON.stringify(accounts);
    changes.push(stmt(env.DB, `INSERT INTO principals SELECT json_extract(value,'$.principalId'),json_extract(value,'$.personId'),1 FROM json_each(?) WHERE true ON CONFLICT(principal_id) DO NOTHING`, accountJson));
    changes.push(stmt(env.DB, `INSERT INTO principal_accounts SELECT json_extract(value,'$.principalId'),json_extract(value,'$.email'),'authenticated-confirmation',? FROM json_each(?) WHERE true ON CONFLICT(principal_id) DO UPDATE SET email=excluded.email,evidence=excluded.evidence,bound_command_id=excluded.bound_command_id`, id, accountJson));
    const squads = (r.operationalSquadronIds as unknown[]).map(v => adminIdentifier(v));
    if (new Set(squads).size !== squads.length || squads.some(id => !f.squadrons.some(s => s.squadronId === id && ['blue', 'gold'].includes(s.label.trim().toLowerCase())) || !f.flights.some(x => x.squadronId === id)))
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Operational Squadron scopes must exist with Flights.');
    f.accounts = f.accounts.filter(a => !revokes.includes(a.principalId) && !accounts.some(x => x.principalId === a.principalId));
    f.accounts.push(...accounts);
    f.config = { operationalSquadronIds: squads.sort() };
    changes.unshift(stmt(env.DB, 'DELETE FROM principal_accounts WHERE principal_id IN (SELECT value FROM json_each(?))', JSON.stringify(revokes)));
    const now = new Date().toISOString();
    const nativeFence = await stmt(env.DB, `SELECT (${fenceSql}) AS allowed`, id, digest, f.version, now).first<{
        allowed: number;
    }>();
    if (!nativeFence?.allowed)
        throw new HttpError(409, 'PERMISSION_FENCE_REQUIRED', 'The automation publisher must verify the native access fence for this exact command first.');
    original.sql += ` AND ${fenceSql}`;
    original.values.push(id, digest, f.version, now);
    const receipt = { commandId: id, status: 'committed', version: f.version + 1, pendingPermissions: true };
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (${original.sql}))`, id, ...auth.values, ...original.values),
            stmt(env.DB, "INSERT INTO command_registry VALUES(?,'admin')", id), ...changes,
            stmt(env.DB, 'INSERT INTO permission_commands VALUES(?,?,?,?,?)', id, principal, digest, JSON.stringify(receipt), now),
            stmt(env.DB, 'UPDATE permission_change_fences SET consumed_at=? WHERE command_id=?', now, id), ...await policyWrites(env, f, id, principal, now), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', id),
        ]);
    }
    catch {
        throw conflict();
    }
    return receipt;
}
/** The native host must keep its fence until this exact policy revision has been applied and acknowledged. */
export async function permissionRefresh(env: Env, action: 'claim' | 'project' | 'ack' | 'status', input: unknown): Promise<unknown> {
    const r = inputRecord(input, env, action === 'status' ? [] : action === 'claim' ? ['workerId'] : ['workerId', 'jobId', 'claimToken']);
    const principal = String(r.principalId), auth = await authorized(env, principal, action !== 'status', true), now = new Date().toISOString();
    if (action === 'status')
        return await stmt(env.DB, `SELECT enabled,version,policy_hash AS policyHash,policy_json AS policy,
    NOT EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE state<>'done') AS applied FROM permission_policy_control WHERE singleton=1`).first();
    const workerId = adminIdentifier(r.workerId);
    if (action === 'claim') {
        const job = await stmt(env.DB, `UPDATE permission_refresh_jobs SET state='leased',worker_id=?,claim_token=?,lease_expires_at=?,frozen_policy_json=(SELECT policy_json FROM permission_policy_audit a WHERE a.version=permission_refresh_jobs.version)
      WHERE job_id=(SELECT job_id FROM permission_refresh_jobs WHERE state='pending' AND ${auth.sql}
      AND NOT EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE state='leased') ORDER BY version DESC LIMIT 1)
      RETURNING job_id AS jobId,version,claim_token AS claimToken,lease_expires_at AS leaseExpiresAt`, workerId, crypto.randomUUID(), new Date(Date.now() + 21600000).toISOString(), ...auth.values).first();
        return { job };
    }
    const jobId = adminIdentifier(r.jobId), token = adminIdentifier(r.claimToken), lease = `job_id=? AND worker_id=? AND claim_token=? AND state='leased' AND lease_expires_at>? AND ${auth.sql}`;
    const values = [jobId, workerId, token, now, ...auth.values];
    const job = await stmt(env.DB, `SELECT version,frozen_policy_json AS policy FROM permission_refresh_jobs WHERE ${lease}`, ...values).first<{
        version: number;
        policy: string;
    }>();
    if (!job) {
        if (action === 'ack') {
            const done = await stmt(env.DB, `SELECT version,version=(SELECT version FROM permission_policy_control WHERE singleton=1) AS current FROM permission_refresh_jobs WHERE job_id=? AND worker_id=? AND claim_token=? AND state='done'`, jobId, workerId, token).first<{
                version: number;
                current: number;
            }>();
            if (done)
                return { acknowledged: true, version: done.version, current: !!done.current };
        }
        throw conflict();
    }
    const control = await stmt(env.DB, 'SELECT version,policy_hash AS policyHash FROM permission_policy_control WHERE singleton=1').first<{
        version: number;
        policyHash: string;
    }>();
    // Never reopen Google access using a superseded policy. A stale lease may be finished safely while fenced.
    if (action === 'project')
        return { version: job.version, current: control!.version === job.version, policyHash: await sha(job.policy), policy: JSON.parse(job.policy) };
    const marker = crypto.randomUUID();
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE ${lease}))`, marker, ...values),
            stmt(env.DB, `UPDATE permission_refresh_jobs SET state='done',completed_at=?,completed_by_job_id=? WHERE job_id=? OR state='pending' AND version<=?`, now, jobId, jobId, job.version),
            stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', marker),
        ]);
    }
    catch {
        throw conflict();
    }
    const latest = await stmt(env.DB, 'SELECT version FROM permission_policy_control WHERE singleton=1').first<{
        version: number;
    }>();
    return { acknowledged: true, version: job.version, current: latest!.version === job.version };
}
/** Only the named automation publisher can attest fresh provider readback, never an ordinary manager. */
export async function attestPermissionFence(env: Env, input: unknown): Promise<unknown> {
    const r = inputRecord(input, env, ['commandId', 'payloadSha256', 'expectedVersion', 'checkpointSha256']);
    const principal = String(r.principalId), auth = await authorized(env, principal, true, true), commandId = adminIdentifier(r.commandId);
    if (!Number.isSafeInteger(r.expectedVersion) || Number(r.expectedVersion) < 0 || ![r.payloadSha256, r.checkpointSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Fence evidence requires exact command and private provider-checkpoint hashes.');
    const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 600000).toISOString();
    const prior = await stmt(env.DB, 'SELECT payload_hash AS hash,policy_version AS version,publisher_id AS publisher,checkpoint_sha256 AS checkpoint,expires_at AS expires,consumed_at AS consumed FROM permission_change_fences WHERE command_id=?', commandId).first<Record<string, unknown>>();
    if (prior) {
        if (prior.hash !== r.payloadSha256 || prior.version !== r.expectedVersion || prior.publisher !== principal || prior.checkpoint !== r.checkpointSha256 || prior.consumed || String(prior.expires) <= now)
            throw conflict();
        return { commandId, expiresAt: prior.expires };
    }
    const assertion = crypto.randomUUID();
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (SELECT version FROM permission_policy_control WHERE singleton=1)=? AND NOT EXISTS(SELECT 1 FROM command_registry WHERE command_id=?))`, assertion, ...auth.values, Number(r.expectedVersion), commandId),
            stmt(env.DB, 'INSERT INTO permission_change_fences VALUES(?,?,?,?,?,?,?,NULL)', commandId, String(r.payloadSha256), Number(r.expectedVersion), principal, String(r.checkpointSha256), now, expiresAt),
            stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', assertion),
        ]);
    }
    catch {
        throw conflict();
    }
    return { commandId, expiresAt };
}
/** Explicit owner-reviewed continuation; never steals a lease, changes its token or silently retries old authority. */
export async function recoverPermissionRefresh(env: Env, input: unknown): Promise<unknown> {
    const r = inputRecord(input, env, ['recoveryId', 'workerId', 'jobId', 'claimToken', 'previousExpiry', 'checkpointSha256']);
    const principal = String(r.principalId), auth = await authorized(env, principal, true, true), recoveryId = adminIdentifier(r.recoveryId), jobId = adminIdentifier(r.jobId), workerId = adminIdentifier(r.workerId), token = adminIdentifier(r.claimToken);
    if (typeof r.previousExpiry !== 'string' || !Number.isFinite(Date.parse(r.previousExpiry)) || typeof r.checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.checkpointSha256))
        throw new HttpError(400, 'INVALID_PERMISSIONS', 'Recovery requires the exact retained expiry and reviewed native checkpoint.');
    const previous = r.previousExpiry, checkpoint = r.checkpointSha256;
    const prior = await stmt(env.DB, 'SELECT * FROM permission_refresh_recoveries WHERE recovery_id=?', recoveryId).first<Record<string, unknown>>();
    if (prior) {
        if (prior.job_id !== jobId || prior.publisher_id !== principal || prior.worker_id !== workerId || prior.claim_token !== token || prior.previous_expiry !== previous || prior.checkpoint_sha256 !== checkpoint)
            throw conflict();
        return { jobId, claimToken: token, leaseExpiresAt: prior.new_expiry };
    }
    const now = new Date().toISOString(), next = new Date(Date.now() + 21600000).toISOString();
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE job_id=? AND worker_id=? AND claim_token=? AND lease_expires_at=? AND lease_expires_at<=? AND state='leased' AND frozen_policy_json IS NOT NULL))`, recoveryId, ...auth.values, jobId, workerId, token, previous, now),
            stmt(env.DB, 'INSERT INTO permission_refresh_recoveries VALUES(?,?,?,?,?,?,?,?,?)', recoveryId, jobId, principal, workerId, token, previous, next, checkpoint, now),
            stmt(env.DB, 'UPDATE permission_refresh_jobs SET lease_expires_at=? WHERE job_id=?', next, jobId),
            stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', recoveryId),
        ]);
    }
    catch {
        throw conflict();
    }
    return { jobId, claimToken: token, leaseExpiresAt: next };
}
