import { noticeLocalClock } from '../../../packages/domain/src/notifications.js';
/** Isolated, explicitly reviewed term transitions. No Google or mail IO in the Worker. */
import { adminIdentifier, type FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { parseTransitionPlan, prepareTransition, type TransitionPlan } from '../../../packages/domain/src/transitions.js';
import { frontendSnapshot } from './admin.js';
import { HttpError } from './http-error.js';
interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    GENERATION: string;
}
type Value = string | number | null;
const stmt = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
function fail(code = 'TRANSITION_CONFLICT', message = 'The transition changed; reload its reviewed state before continuing.', status = 409): never { throw new HttpError(status, code, message); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return fail('INVALID_TRANSITION', 'Expected a structured transition request.', 400);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)))
        return fail('INVALID_TRANSITION', 'Unexpected transition fields.', 400);
    return row;
}
function authority(env: Env, principalId: string, write = true) {
    return { sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write ? ' AND accepting_commands=1' : ''})
    AND EXISTS(SELECT 1 FROM principals p JOIN transition_authorities a ON a.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND a.active=1)`,
        values: [env.ENVIRONMENT, Number(env.GENERATION), principalId] as Value[] };
}
interface Command {
    commandId: string;
    actor: {
        principalId: string;
        evidence: string;
    };
    source: {
        kind: string;
        resourceKey: string;
        submissionId: string;
        revision: number;
    };
    operation: 'transition.prepare' | 'transition.accept' | 'transition.cancel' | 'transition.complete';
    transitionId: string;
    expectedVersion: number;
    planHash: string | null;
    plan: TransitionPlan | null;
}
function parseCommand(value: unknown, env: Env): Command {
    const c = record(value, ['commandId', 'contractVersion', 'environment', 'generation', 'actor', 'source', 'operation', 'payload']);
    const actor = record(c.actor, ['principalId', 'evidence']);
    const source = record(c.source, ['kind', 'resourceKey', 'submissionId', 'revision']);
    if (c.contractVersion !== 1 || c.environment !== env.ENVIRONMENT || c.generation !== Number(env.GENERATION)
        || !['transition.prepare', 'transition.accept', 'transition.cancel', 'transition.complete'].includes(String(c.operation))
        || !['sheet', 'test'].includes(String(source.kind)) || !Number.isSafeInteger(source.revision) || Number(source.revision) < 1
        || !(actor.evidence === 'authenticated-confirmation' || actor.evidence === 'google-edit' && source.kind === 'sheet'))
        fail('INVALID_TRANSITION', 'Invalid transition identity.', 400);
    const prepare = c.operation === 'transition.prepare';
    const p = record(c.payload, prepare ? ['plan'] : ['transitionId', 'expectedVersion', 'planHash']);
    const plan = prepare ? parseTransitionPlan(p.plan) : null;
    if (!prepare && (!Number.isSafeInteger(p.expectedVersion) || Number(p.expectedVersion) < 1 || typeof p.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.planHash)))
        fail('INVALID_TRANSITION', 'A reviewed plan hash and version are required.', 400);
    return { commandId: adminIdentifier(c.commandId), actor: { principalId: adminIdentifier(actor.principalId), evidence: String(actor.evidence) },
        source: { kind: String(source.kind), resourceKey: adminIdentifier(source.resourceKey), submissionId: adminIdentifier(source.submissionId), revision: Number(source.revision) },
        operation: c.operation as Command['operation'], transitionId: plan?.transitionId ?? adminIdentifier(p.transitionId), expectedVersion: prepare ? 0 : Number(p.expectedVersion), planHash: prepare ? null : String(p.planHash), plan };
}
interface TransitionRow {
    transition_id: string;
    source_term_id: string;
    target_term_id: string;
    state: string;
    version: number;
    plan_json: string;
    plan_hash: string;
    snapshot_json: string;
    snapshot_hash: string;
    base_operations_revision: number;
    base_administration_revision: number;
    accepted_command_id: string | null;
}
export async function transitionCommand(env: Env, input: unknown): Promise<unknown> {
    const c = parseCommand(input, env), digest = await hash(JSON.stringify(input));
    const auth = authority(env, c.actor.principalId);
    auth.sql += ' AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)';
    auth.values.push(c.source.kind, c.source.resourceKey);
    const check = await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
        allowed: number;
    }>();
    if (check?.allowed !== 1)
        fail('NOT_AUTHORIZED', 'Current transition authority and a registered source are required.', 403);
    const previous = await stmt(env.DB, 'SELECT payload_hash,actor_id,receipt_json FROM admin_commands WHERE command_id=?', c.commandId).first<{
        payload_hash: string;
        actor_id: string;
        receipt_json: string;
    }>();
    if (previous) {
        if (previous.payload_hash !== digest || previous.actor_id !== c.actor.principalId)
            fail('COMMAND_ID_CONFLICT');
        return JSON.parse(previous.receipt_json);
    }
    const now = new Date().toISOString(), writes: D1PreparedStatement[] = [];
    let condition: string, values: Value[], before: unknown = {}, after: unknown, version: number, state: string;
    if (c.plan) {
        const snapshot = await frontendSnapshot(env, { environment: env.ENVIRONMENT, generation: Number(env.GENERATION), principalId: c.actor.principalId });
        const prepared = prepareTransition(c.plan, snapshot);
        const planJson = JSON.stringify(c.plan), snapshotJson = JSON.stringify(snapshot);
        if (new TextEncoder().encode(snapshotJson).length > 1500000)
            fail('TRANSITION_TOO_LARGE', 'Archive a smaller reviewed term scope before preparing this transition.');
        const planHash = await hash(planJson), snapshotHash = await hash(snapshotJson);
        condition = `(SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?
      AND NOT EXISTS(SELECT 1 FROM term_transitions WHERE state NOT IN ('complete','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM terms WHERE term_id=? OR sort_order=?)
      AND NOT EXISTS(SELECT 1 FROM admin_effects WHERE state='leased')
      AND NOT EXISTS(SELECT 1 FROM outbox_jobs WHERE state='leased')`;
        values = [snapshot.revision.operations, snapshot.revision.administration, c.plan.targetTerm.termId, c.plan.targetTerm.sortOrder];
        writes.push(stmt(env.DB, `INSERT INTO term_transitions VALUES(?,?,?, ?,1,'proposed',?,?,?,?,?,?,?,NULL,?,?)`, c.transitionId, c.plan.sourceTermId, c.plan.targetTerm.termId, c.plan.kind, planJson, planHash, snapshotJson, snapshotHash, snapshot.revision.operations, snapshot.revision.administration, c.commandId, now, now));
        writes.push(stmt(env.DB, "INSERT INTO transition_archive_jobs(transition_id,state,snapshot_hash) VALUES(?,'pending',?)", c.transitionId, snapshotHash));
        version = 1;
        state = 'proposed';
        after = { planHash, snapshotHash, changes: c.plan.people.length, people: prepared.people.length, events: prepared.events.length };
    }
    else {
        const row = await stmt(env.DB, 'SELECT * FROM term_transitions WHERE transition_id=?', c.transitionId).first<TransitionRow>();
        if (!row || row.version !== c.expectedVersion || row.plan_hash !== c.planHash)
            fail();
        before = { state: row.state, version: row.version };
        version = row.version + 1;
        condition = 'EXISTS(SELECT 1 FROM term_transitions WHERE transition_id=? AND version=? AND plan_hash=? AND state=?)';
        values = [c.transitionId, c.expectedVersion, c.planHash, row.state];
        if (c.operation === 'transition.cancel') {
            if (!['proposed', 'archiving', 'ready'].includes(row.state))
                fail();
            state = 'cancelled';
        }
        else if (c.operation === 'transition.complete') {
            if (row.state !== 'publishing' || !row.accepted_command_id)
                fail();
            condition += ` AND (SELECT COUNT(*) FROM admin_effects WHERE command_id=? AND kind IN ('forms.refresh','frontend.refresh') AND state='done')=2`;
            values.push(row.accepted_command_id);
            state = 'complete';
        }
        else {
            if (row.state !== 'ready')
                fail('ARCHIVE_REQUIRED', 'A verified protected archive is required before acceptance.');
            const plan: TransitionPlan = parseTransitionPlan(JSON.parse(row.plan_json));
            const snapshot: FrontendSnapshot = JSON.parse(row.snapshot_json);
            const prepared = prepareTransition(plan, snapshot);
            condition += ` AND EXISTS(SELECT 1 FROM transition_archive_jobs WHERE transition_id=? AND state='done')
        AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=?
        AND NOT EXISTS(SELECT 1 FROM admin_audit_events WHERE audit_id>? AND operation NOT LIKE 'transition.%')
        AND EXISTS(SELECT 1 FROM terms WHERE term_id=? AND is_current=1)
        AND NOT EXISTS(SELECT 1 FROM terms WHERE term_id=? OR sort_order=?)
        AND NOT EXISTS(SELECT 1 FROM admin_effects WHERE state='leased')
        AND NOT EXISTS(SELECT 1 FROM outbox_jobs WHERE state='leased')`;
            values.push(c.transitionId, row.base_operations_revision, row.base_administration_revision, plan.sourceTermId, plan.targetTerm.termId, plan.targetTerm.sortOrder);
            const changed = prepared.people.filter(p => plan.people.some(change => change.personId === p.personId));
            const changesJson = JSON.stringify(changed), oldJson = JSON.stringify(snapshot.people);
            const eventRows = await Promise.all(prepared.events.map(async (event) => ({ ...event, commandId: 'transition-event-' + await hash(JSON.stringify([c.commandId, event.eventId])) })));
            const eventsJson = JSON.stringify(eventRows);
            // One atomic acceptance: no partial advancement or deletion of old attendance/requests.
            writes.push(stmt(env.DB, `INSERT INTO term_roster_snapshots SELECT ?,person_id,last_name,first_name,as_year,flight_id,flight_path_status,date_of_birth,?
        FROM directory_profiles WHERE true ON CONFLICT(term_id,person_id) DO UPDATE SET last_name=excluded.last_name,first_name=excluded.first_name,
        as_year=excluded.as_year,flight_id=excluded.flight_id,flight_path_status=excluded.flight_path_status,date_of_birth=excluded.date_of_birth,command_id=excluded.command_id`, plan.sourceTermId, c.commandId));
            writes.push(stmt(env.DB, `INSERT INTO transition_people_history SELECT ?,json_extract(n.value,'$.personId'),json_extract(o.value,'$.version'),json_extract(n.value,'$.version'),o.value,n.value
        FROM json_each(?) n JOIN json_each(?) o ON json_extract(o.value,'$.personId')=json_extract(n.value,'$.personId')`, c.transitionId, changesJson, oldJson));
            writes.push(stmt(env.DB, `UPDATE directory_profiles SET version=json_extract(j.value,'$.version'),as_year=json_extract(j.value,'$.asYear'),rank=json_extract(j.value,'$.rank'),
        role=json_extract(j.value,'$.role'),flight_id=json_extract(j.value,'$.flightId'),flight_path_status=json_extract(j.value,'$.flightPathStatus'),updated_at=?
        FROM json_each(?) j WHERE person_id=json_extract(j.value,'$.personId')`, now, changesJson));
            writes.push(stmt(env.DB, `UPDATE memberships SET active=0 WHERE person_id IN (SELECT json_extract(value,'$.personId') FROM json_each(?))`, changesJson));
            writes.push(stmt(env.DB, `INSERT INTO memberships SELECT json_extract(value,'$.personId'),json_extract(value,'$.flightId'),json_extract(value,'$.active')
        FROM json_each(?) WHERE json_extract(value,'$.flightId') IS NOT NULL ON CONFLICT(person_id,unit_id) DO UPDATE SET active=excluded.active`, changesJson));
            writes.push(stmt(env.DB, `UPDATE organizational_units SET roster_version=roster_version+1 WHERE unit_id IN
        (SELECT flight_id FROM directory_profiles WHERE person_id IN (SELECT json_extract(value,'$.personId') FROM json_each(?))
         UNION SELECT json_extract(o.value,'$.flightId') FROM json_each(?) o WHERE json_extract(o.value,'$.personId') IN (SELECT json_extract(value,'$.personId') FROM json_each(?)))`, changesJson, oldJson, changesJson));
            writes.push(stmt(env.DB, 'UPDATE terms SET is_current=0 WHERE term_id=?', plan.sourceTermId));
            writes.push(stmt(env.DB, 'INSERT INTO terms VALUES(?,?,?,1)', plan.targetTerm.termId, plan.targetTerm.label, plan.targetTerm.sortOrder));
            writes.push(stmt(env.DB, `INSERT INTO term_roster_snapshots SELECT ?,person_id,last_name,first_name,as_year,flight_id,flight_path_status,date_of_birth,? FROM directory_profiles`, plan.targetTerm.termId, c.commandId));
            // Old events remain historical facts with their original roster/version. Intake is closed.
            writes.push(stmt(env.DB, 'UPDATE events SET active=0 WHERE event_id IN (SELECT event_id FROM event_details WHERE term_id=?)', plan.sourceTermId));
            writes.push(stmt(env.DB, "INSERT INTO command_registry SELECT json_extract(value,'$.commandId'),'admin' FROM json_each(?)", eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO admin_commands SELECT json_extract(value,'$.commandId'),?,?, 'transition.event',json_extract(value,'$.eventId'),
        'transitions.manage','[]',?,?,json_extract(value,'$.eventId'),1,?,json_object('status','committed','operation','transition.event') FROM json_each(?)`, digest, c.actor.principalId, c.source.kind, c.source.resourceKey, now, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO events SELECT json_extract(value,'$.eventId'),json_extract(value,'$.label'),1 FROM json_each(?)`, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO event_details SELECT json_extract(value,'$.eventId'),1,?,json_extract(value,'$.eventType'),json_extract(value,'$.trainingWeek'),
        json_extract(value,'$.displayOrder'),json_extract(value,'$.columnLabel'),'All Cadets','active',json_extract(value,'$.startAt'),json_extract(value,'$.endAt'),'','',?,?,? FROM json_each(?)`, plan.targetTerm.termId, now, c.actor.principalId, now, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO event_units SELECT json_extract(e.value,'$.eventId'),f.value FROM json_each(?) e,json_each(json_extract(e.value,'$.flightIds')) f`, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO event_roster_versions SELECT json_extract(value,'$.eventId'),1,json_extract(value,'$.commandId'),? FROM json_each(?)`, now, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO event_roster_members SELECT json_extract(e.value,'$.eventId'),1,d.person_id,d.flight_id,d.last_name,d.first_name,d.as_year,d.flight_path_status,d.date_of_birth
        FROM json_each(?) e,json_each(json_extract(e.value,'$.eligiblePersonIds')) p JOIN directory_profiles d ON d.person_id=p.value`, eventsJson));
            writes.push(stmt(env.DB, `INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json)
        SELECT json_extract(value,'$.commandId'),?,?,'transition.event',json_extract(value,'$.eventId'),?,'{}',value FROM json_each(?)`, c.actor.principalId, c.actor.evidence, now, eventsJson));
            for (const kind of ['forms.refresh', 'frontend.refresh'])
                writes.push(stmt(env.DB, "INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,?,'pending',?)", 'transition-' + await hash(JSON.stringify([c.commandId, kind])), c.commandId, kind, now));
            state = 'publishing';
        }
        writes.push(stmt(env.DB, `UPDATE term_transitions SET state=?,version=?,updated_at=?,accepted_command_id=CASE WHEN ?='publishing' THEN ? ELSE accepted_command_id END WHERE transition_id=?`, state, version, now, state, c.commandId, c.transitionId));
        after = { state, version, planHash: row.plan_hash };
    }
    const receipt = JSON.stringify({ commandId: c.commandId, status: 'committed', operation: c.operation, result: { transitionId: c.transitionId, version, state, ...after as object }, pendingEffects: state !== 'complete' && state !== 'cancelled' });
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (${condition}))`, c.commandId, ...auth.values, ...values),
            stmt(env.DB, "INSERT INTO command_registry VALUES(?,'admin')", c.commandId),
            stmt(env.DB, `INSERT INTO admin_commands VALUES(?,?,?,?,?,'transitions.manage','[]',?,?,?,?,?,?)`, c.commandId, digest, c.actor.principalId, c.operation, c.transitionId, c.source.kind, c.source.resourceKey, c.source.submissionId, c.source.revision, now, receipt),
            ...writes,
            stmt(env.DB, `INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)`, c.commandId, c.actor.principalId, c.actor.evidence, c.operation, c.transitionId, now, JSON.stringify(before), JSON.stringify(after)),
            stmt(env.DB, 'INSERT INTO transition_events(transition_id,command_id,action,version,principal_id,accepted_at,detail_json) VALUES(?,?,?,?,?,?,?)', c.transitionId, c.commandId, c.operation, version, c.actor.principalId, now, JSON.stringify(after)),
            stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', c.commandId),
        ]);
        return JSON.parse(receipt);
    }
    catch {
        const retry = await stmt(env.DB, `SELECT receipt_json FROM admin_commands WHERE command_id=? AND payload_hash=? AND actor_id=? AND (${auth.sql})`, c.commandId, digest, c.actor.principalId, ...auth.values).first<{
            receipt_json: string;
        }>();
        if (retry)
            return JSON.parse(retry.receipt_json);
        return fail();
    }
}
export async function transitionStatus(env: Env, input: unknown): Promise<unknown> {
    const r = record(input, ['environment', 'generation', 'principalId', 'transitionId']);
    if (r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION))
        fail('INVALID_TRANSITION', 'Wrong transition environment.', 400);
    const auth = authority(env, adminIdentifier(r.principalId), false);
    const result = await env.DB.batch<Record<string, unknown>>([
        stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values),
        stmt(env.DB, 'SELECT transition_id AS transitionId,version,state,plan_json AS plan,plan_hash AS planHash,snapshot_hash AS snapshotHash FROM term_transitions WHERE transition_id=?', adminIdentifier(r.transitionId)),
        stmt(env.DB, 'SELECT j.state,j.lease_expires_at AS leaseExpiresAt,j.receipt_json AS receipt FROM transition_archive_jobs j WHERE transition_id=?', adminIdentifier(r.transitionId)),
        stmt(env.DB, 'SELECT e.kind,e.state FROM admin_effects e JOIN term_transitions t ON t.accepted_command_id=e.command_id WHERE t.transition_id=? ORDER BY e.kind', adminIdentifier(r.transitionId)),
    ]);
    if (result[0].results[0]?.allowed !== 1)
        fail('NOT_AUTHORIZED', 'Current transition authority is required.', 403);
    const row = result[1].results[0];
    if (!row)
        fail('NOT_FOUND', 'Transition not found.', 404);
    return { ...row, plan: JSON.parse(String(row.plan)), archive: result[2].results[0], effects: result[3].results };
}
export async function transitionArchive(env: Env, action: 'claim' | 'ack', input: unknown): Promise<unknown> {
    const r = record(input, action === 'claim' ? ['environment', 'generation', 'principalId', 'workerId', 'transitionId'] : ['environment', 'generation', 'principalId', 'workerId', 'transitionId', 'claimToken', 'proof']);
    if (r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION))
        fail('INVALID_TRANSITION', 'Wrong transition environment.', 400);
    const principal = adminIdentifier(r.principalId), worker = adminIdentifier(r.workerId), transitionId = adminIdentifier(r.transitionId);
    const auth = authority(env, principal), now = new Date().toISOString();
    if (action === 'claim') {
        const token = crypto.randomUUID(), expiry = new Date(Date.now() + 600000).toISOString();
        const result = await env.DB.batch<Record<string, unknown>>([
            stmt(env.DB, `UPDATE transition_archive_jobs SET state='leased',worker_id=?,claim_token=?,lease_expires_at=?,claimed_by=?
        WHERE transition_id=? AND (state='pending' OR (state='leased' AND (worker_id=? OR lease_expires_at<=?)))
        AND EXISTS(SELECT 1 FROM term_transitions WHERE transition_id=? AND state IN ('proposed','archiving')) AND (${auth.sql}) RETURNING claim_token`, worker, token, expiry, principal, transitionId, worker, now, transitionId, ...auth.values),
            stmt(env.DB, `UPDATE term_transitions SET state='archiving',updated_at=? WHERE transition_id=? AND state='proposed'
        AND EXISTS(SELECT 1 FROM transition_archive_jobs WHERE transition_id=? AND claim_token=?)`, now, transitionId, transitionId, token),
            stmt(env.DB, `INSERT INTO transition_archive_events(transition_id,principal_id,worker_id,action,accepted_at,snapshot_hash) SELECT transition_id,?,?,'claimed',?,snapshot_hash FROM transition_archive_jobs WHERE transition_id=? AND claim_token=?`, principal, worker, now, transitionId, token),
            stmt(env.DB, `SELECT t.snapshot_json AS snapshot,t.snapshot_hash AS snapshotHash,t.plan_hash AS planHash,t.created_at AS preparedAt,j.claim_token AS claimToken,j.lease_expires_at AS leaseExpiresAt
        FROM term_transitions t JOIN transition_archive_jobs j USING(transition_id) WHERE t.transition_id=? AND j.claim_token=?`, transitionId, token),
        ]);
        if (!result[3].results.length)
            fail();
        const row = result[3].results[0];
        return { ...row, transitionId, asOfDate: noticeLocalClock(String(row.preparedAt)).date, snapshot: JSON.parse(String(row.snapshot)) };
    }
    const proof = record(r.proof, ['snapshotHash', 'archiveBinding', 'protected', 'private', 'valuesOnly']);
    if (typeof proof.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.snapshotHash) || proof.protected !== true || proof.private !== true || proof.valuesOnly !== true)
        fail('ARCHIVE_VERIFICATION_REQUIRED', 'Verify an immutable private protected archive before acknowledgement.');
    adminIdentifier(proof.archiveBinding);
    const token = adminIdentifier(r.claimToken), serialized = JSON.stringify(proof);
    const existing = await stmt(env.DB, `SELECT receipt_json FROM transition_archive_jobs WHERE transition_id=? AND claim_token=? AND worker_id=? AND claimed_by=? AND state='done' AND (${auth.sql})`, transitionId, token, worker, principal, ...auth.values).first<{
        receipt_json: string;
    }>();
    if (existing) {
        if (existing.receipt_json !== serialized)
            fail();
        return { status: 'done' };
    }
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM transition_archive_jobs j JOIN term_transitions t USING(transition_id)
        WHERE j.transition_id=? AND j.state='leased' AND t.state='archiving' AND j.claim_token=? AND j.worker_id=? AND j.claimed_by=? AND j.lease_expires_at>? AND j.snapshot_hash=?))`, token, ...auth.values, transitionId, token, worker, principal, now, proof.snapshotHash),
            stmt(env.DB, "UPDATE transition_archive_jobs SET state='done',receipt_json=?,completed_at=?,verified_by=? WHERE transition_id=?", serialized, now, principal, transitionId),
            stmt(env.DB, "INSERT INTO transition_archive_events(transition_id,principal_id,worker_id,action,accepted_at,snapshot_hash) VALUES(?,?,?,'verified',?,?)", transitionId, principal, worker, now, proof.snapshotHash),
            stmt(env.DB, "UPDATE term_transitions SET state='ready',version=version+1,updated_at=? WHERE transition_id=?", now, transitionId),
            stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', token),
        ]);
        return { status: 'done' };
    }
    catch {
        return fail();
    }
}
