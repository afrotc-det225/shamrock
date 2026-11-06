/** Bounded automatic Sunday finalization. All writes are append-only, audited and staging mail is suppressed. */
import { adminIdentifier, type FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { buildFrontendReporting, REPORTING_POLICY_VERSION, type FrontendReportingInput } from '../../../packages/domain/src/frontend-reporting.js';
import { CLOSEOUT_POLICY, closeoutWindow, closeoutCode, closeoutNotices } from '../../../packages/domain/src/closeout.js';
import { noticeLocalClock } from '../../../packages/domain/src/notifications.js';
import { frontendSnapshot } from './admin.js';
import { flightNoticeContacts } from './notifications.js';
import { HttpError } from './http-error.js';
interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    GENERATION: string;
}
type Value = string | number | null;
interface Identity {
    environment: string;
    generation: number;
    principalId: string;
    sourceKind: 'sheet' | 'test';
    sourceResource: string;
    policyVersion: typeof CLOSEOUT_POLICY.version;
}
interface Run {
    closeout_id: string;
    as_of: string;
    term_id: string;
    version: number;
    state: string;
    source_kind: string;
    source_resource: string;
}
interface Item {
    event_id: string;
    person_id: string;
    event_version: number;
    flight_id: string;
}
const stmt = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const SIZE = 50;
function bad(message = 'Invalid closeout request.'): never { throw new HttpError(400, 'INVALID_CLOSEOUT', message); }
function parse(input: unknown, env: Env, extra: string[] = []): Identity & Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return bad();
    const r = input as Record<string, unknown>;
    const keys = ['environment', 'generation', 'principalId', 'sourceKind', 'sourceResource', 'policyVersion', ...extra];
    if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) || r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION) || r.policyVersion !== CLOSEOUT_POLICY.version || !['sheet', 'test'].includes(String(r.sourceKind)))
        return bad();
    adminIdentifier(r.principalId);
    adminIdentifier(r.sourceResource);
    return r as Identity & Record<string, unknown>;
}
function authority(env: Env, r: Identity, write = true) {
    return { sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? ${write ? 'AND accepting_commands=1' : ''})
 AND EXISTS(SELECT 1 FROM principals p JOIN closeout_authorities a ON a.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND a.active=1)
 AND EXISTS(SELECT 1 FROM admin_grants WHERE principal_id=? AND capability='frontend.read' AND scope_kind='wing' AND scope_key='*')
 AND EXISTS(SELECT 1 FROM admin_grants WHERE principal_id=? AND capability='notifications.manage' AND scope_kind='wing' AND scope_key='*')
 AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)`, values: [env.ENVIRONMENT, Number(env.GENERATION), r.principalId, r.principalId, r.principalId, r.sourceKind, r.sourceResource] };
}
async function authorized(env: Env, r: Identity, write = true) {
    const auth = authority(env, r, write);
    const row = await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
        allowed: number;
    }>();
    if (row?.allowed !== 1) {
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current closeout authority, notification/read grants and registered source are required.');
    }
    return auth;
}
function report(snapshot: FrontendSnapshot, asOf: string) {
    const current = snapshot.terms.filter(t => t.isCurrent);
    if (current.length !== 1 || snapshot.diagnostics.length)
        throw new HttpError(409, 'CLOSEOUT_SNAPSHOT', 'Review the current term and roster diagnostics first.');
    const input = { policyVersion: REPORTING_POLICY_VERSION, asOfDate: noticeLocalClock(asOf).date, currentTermId: current[0].termId, people: snapshot.people, flights: snapshot.flights.map(f => ({ ...f, squadronId: f.squadronId! })), squadrons: snapshot.squadrons, terms: snapshot.terms.map(t => ({ ...t, roster: t.isCurrent ? undefined : t.roster })), events: snapshot.events.map(e => ({ ...e, type: e.eventType })), observations: snapshot.observations, corrections: snapshot.corrections, requests: snapshot.requests as FrontendReportingInput['requests'],
        legacyBaselines: snapshot.legacyBaselines ?? [] };
    return { termId: current[0].termId, matrix: buildFrontendReporting(input).matrices.find(m => m.termId === current[0].termId)! };
}
function commandWrites(env: Env, r: Identity, commandId: string, operation: string, target: string, payloadHash: string, now: string) {
    return [
        stmt(env.DB, "INSERT INTO command_registry VALUES(?,'admin')", commandId),
        stmt(env.DB, "INSERT INTO admin_commands VALUES(?,?,?,?,?,'closeout.manage','[]',?,?,?,?,?,?)", commandId, payloadHash, r.principalId, operation, target, r.sourceKind, r.sourceResource, commandId, 1, now, '{}'),
    ];
}
function audit(env: Env, r: Identity, commandId: string, operation: string, target: string, now: string, detail: unknown) { return stmt(env.DB, "INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,'registered-automation',?,?,?,'{}',?)", commandId, r.principalId, operation, target, now, JSON.stringify(detail)); }
async function runRow(env: Env, id: string) { return stmt(env.DB, 'SELECT * FROM attendance_closeouts WHERE closeout_id=? AND environment=? AND generation=?', id, env.ENVIRONMENT, Number(env.GENERATION)).first<Run>(); }
export async function closeoutStatus(env: Env, input: unknown) {
    const r = parse(input, env);
    const auth = await authorized(env, r, false);
    const result = await stmt(env.DB, `SELECT closeout_id AS closeoutId,as_of AS asOf,version,state,
      (SELECT COUNT(*) FROM closeout_items i WHERE i.closeout_id=c.closeout_id AND i.state='pending') AS pending,
      (SELECT COUNT(*) FROM closeout_items i WHERE i.closeout_id=c.closeout_id AND i.state='needs-review') AS needsReview
      FROM attendance_closeouts c WHERE environment=? AND generation=? AND (${auth.sql})
      ORDER BY CASE WHEN state IN ('processing','notifying') THEN 0 ELSE 1 END,created_at LIMIT 21`, env.ENVIRONMENT, Number(env.GENERATION), ...auth.values).all();
    return { policyVersion: CLOSEOUT_POLICY.version, runs: result.results.slice(0, 20), more: result.results.length > 20, delivery: 'suppressed' };
}
export async function prepareCloseout(env: Env, input: unknown, clock = () => new Date()) {
    const r = parse(input, env, ['asOf']);
    const auth = await authorized(env, r);
    if (typeof r.asOf !== 'string')
        return bad();
    let window;
    try {
        window = closeoutWindow(r.asOf);
    }
    catch {
        return bad('Use Sunday 17:00 in the detachment time zone.');
    }
    const now = clock().toISOString();
    if (Date.parse(r.asOf) > Date.parse(now) || Date.parse(now) - Date.parse(r.asOf) > 8 * 86400000)
        return bad('Start the current due window; older catch-up requires a separately reviewed migration.');
    const id = 'closeout-' + await hash(JSON.stringify([env.ENVIRONMENT, Number(env.GENERATION), CLOSEOUT_POLICY.version, window.end]));
    const existing = await runRow(env, id);
    if (existing)
        return { closeoutId: id, version: existing.version, state: existing.state };
    const snapshot = await frontendSnapshot(env, { environment: env.ENVIRONMENT, generation: Number(env.GENERATION), principalId: r.principalId });
    const current = report(snapshot, r.asOf), events = snapshot.events.filter(e => e.termId === current.termId && e.status === 'active' && e.startAt && noticeLocalClock(e.startAt).date >= window.start && noticeLocalClock(e.startAt).date < window.end);
    if (events.some(e => e.eligiblePersonIds === null))
        throw new HttpError(409, 'CLOSEOUT_ROSTER', 'Every closeout event requires an explicit roster.');
    const eventIds = new Set(events.map(e => e.eventId));
    const rosters = await stmt(env.DB, `SELECT m.event_id AS eventId,m.person_id AS personId,m.flight_id AS flightId FROM event_roster_members m JOIN event_details d ON d.event_id=m.event_id AND d.version=m.version WHERE m.event_id IN(SELECT value FROM json_each(?))`, JSON.stringify([...eventIds])).all<{
        eventId: string;
        personId: string;
        flightId: string;
    }>();
    const flights = new Map(rosters.results.map(m => [JSON.stringify([m.eventId, m.personId]), m.flightId]));
    const items = current.matrix.rows.flatMap(p => p.cells.filter(c => eventIds.has(c.eventId) && c.eligible === true).map(c => ({ personId: p.personId, eventId: c.eventId, eventVersion: events.find(e => e.eventId === c.eventId)!.version, flightId: flights.get(JSON.stringify([c.eventId, p.personId])) })));
    if (items.length > 25000 || items.some(i => !i.flightId))
        throw new HttpError(409, 'CLOSEOUT_ROSTER', 'The closeout roster is incomplete or exceeds the bounded run.');
    const serialized = JSON.stringify(items);
    if (new TextEncoder().encode(serialized).length > 1500000)
        throw new HttpError(409, 'CLOSEOUT_CAPACITY', 'The frozen closeout roster exceeds its reviewed bound.');
    const commandId = id + '-prepare', result = { closeoutId: id, version: 1, state: items.length ? 'processing' : 'notifying' };
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?)`, commandId, ...auth.values, snapshot.revision.operations, snapshot.revision.administration),
            ...commandWrites(env, r, commandId, 'attendance.closeout.prepare', id, await hash(JSON.stringify({ asOf: r.asOf, revision: snapshot.revision })), now),
            stmt(env.DB, `INSERT INTO attendance_closeouts VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`, id, env.ENVIRONMENT, Number(env.GENERATION), CLOSEOUT_POLICY.version, r.asOf, window.start, window.end, current.termId, result.state, r.sourceKind, r.sourceResource, commandId, now, now),
            stmt(env.DB, `INSERT INTO closeout_items(closeout_id,event_id,person_id,event_version,flight_id,state) SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.personId'),json_extract(value,'$.eventVersion'),json_extract(value,'$.flightId'),'pending' FROM json_each(?)`, id, serialized),
            audit(env, r, commandId, 'attendance.closeout.prepare', id, now, { policyVersion: CLOSEOUT_POLICY.version, window, revision: snapshot.revision, items: items.length }),
            stmt(env.DB, 'UPDATE admin_commands SET receipt_json=? WHERE command_id=?', JSON.stringify(result), commandId), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', commandId),
        ]);
        return result;
    }
    catch {
        const retry = await runRow(env, id);
        await authorized(env, r);
        if (retry)
            return { closeoutId: id, version: retry.version, state: retry.state };
        throw new HttpError(409, 'CLOSEOUT_CONFLICT', 'The closeout snapshot or authority changed; retry from current facts.');
    }
}
export async function advanceCloseout(env: Env, input: unknown) {
    const r = parse(input, env, ['closeoutId', 'expectedVersion']);
    const auth = await authorized(env, r);
    const id = adminIdentifier(r.closeoutId);
    if (!Number.isSafeInteger(r.expectedVersion) || Number(r.expectedVersion) < 1)
        return bad();
    const version = Number(r.expectedVersion);
    const run = await runRow(env, id);
    if (!run || run.source_kind !== r.sourceKind || run.source_resource !== r.sourceResource)
        throw new HttpError(409, 'CLOSEOUT_CONFLICT', 'Use the original closeout source binding.');
    const previous = await stmt(env.DB, `SELECT receipt_json,(${auth.sql}) AS allowed FROM closeout_steps WHERE closeout_id=? AND base_version=?`, ...auth.values, id, version).first<{
        receipt_json: string;
        allowed: number;
    }>();
    if (previous) {
        if (previous.allowed !== 1)
            throw new HttpError(403, 'NOT_AUTHORIZED', 'Closeout authority changed before receipt delivery.');
        return JSON.parse(previous.receipt_json);
    }
    if (run.version !== version || !['processing', 'notifying'].includes(run.state))
        throw new HttpError(409, 'CLOSEOUT_CONFLICT', 'Reload the current closeout progress.');
    const snapshot = await frontendSnapshot(env, { environment: env.ENVIRONMENT, generation: Number(env.GENERATION), principalId: r.principalId });
    const current = report(snapshot, run.as_of);
    if (current.termId !== run.term_id)
        throw new HttpError(409, 'CLOSEOUT_TERM', 'Finish or review the retained closeout before a term transition.');
    const now = new Date().toISOString(), commandId = 'closeout-step-' + await hash(JSON.stringify([id, version]));
    const items = (await stmt(env.DB, "SELECT * FROM closeout_items WHERE closeout_id=? AND state='pending' ORDER BY event_id,person_id LIMIT ?", id, SIZE).all<Item>()).results;
    const cells = new Map(current.matrix.rows.flatMap(p => p.cells.map(c => [JSON.stringify([c.eventId, p.personId]), c] as const))), pairVersions = new Map(snapshot.attendanceVersions.map(v => [JSON.stringify([v.eventId, v.personId]), v.version]));
    const rows = await Promise.all(items.map(async (item) => {
        const key = JSON.stringify([item.event_id, item.person_id]), cell = cells.get(key), event = snapshot.events.find(e => e.eventId === item.event_id);
        const valid = event?.version === item.event_version && event.status === 'active' && cell?.eligible === true && !cell.needsReview;
        const orders = [...snapshot.observations, ...snapshot.corrections].filter(f => f.eventId === item.event_id && f.personId === item.person_id).map(f => f.order);
        const code = valid ? closeoutCode({ cell: cell!, latestAttendanceOrder: Math.max(0, ...orders), requests: snapshot.requests.filter(q => q.eventId === item.event_id && q.personId === item.person_id) }) : null;
        const child = 'closeout-cell-' + await hash(JSON.stringify([id, item.event_id, item.person_id]));
        return { ...item, code, before: cell?.effectiveCode ?? null, state: !valid ? 'needs-review' : code ? 'completed' : 'preserved', reason: !valid ? 'catalog-or-roster-changed' : code ? 'automatic-sunday-policy' : 'existing-outcome-preserved', baseVersion: pairVersions.get(key) ?? 0, commandId: child, hash: await hash(JSON.stringify([CLOSEOUT_POLICY.version, id, item, code, pairVersions.get(key) ?? 0])) };
    }));
    const changes = rows.filter(row => row.code !== null), serialized = JSON.stringify(rows), changed = JSON.stringify(changes);
    let notices: Awaited<ReturnType<typeof noticeRows>> = [];
    if (!items.length)
        notices = await noticeRows(env, snapshot, run, current.matrix);
    const encodedNotices = JSON.stringify(notices);
    if (new TextEncoder().encode(encodedNotices).length > 1000000)
        throw new HttpError(409, 'CLOSEOUT_CAPACITY', 'Notification content exceeds its bounded ledger entry.');
    const result = { closeoutId: id, version: version + 1, processed: items.length, changed: changes.length, delivery: 'suppressed' };
    const writes: D1PreparedStatement[] = [
        stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM attendance_closeouts WHERE closeout_id=? AND version=? AND state=?)
 AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?
 AND (SELECT COUNT(*) FROM notification_intents)+(SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM notification_intents n WHERE n.notice_key=json_extract(j.value,'$.key'))) <=(SELECT max_ledger_entries FROM notification_delivery_control WHERE singleton=1))`, commandId, ...auth.values, id, version, run.state, snapshot.revision.operations, snapshot.revision.administration, encodedNotices),
        ...commandWrites(env, r, commandId, 'attendance.closeout.advance', id, await hash(JSON.stringify({ id, version, revision: snapshot.revision })), now),
        stmt(env.DB, "INSERT INTO command_registry SELECT json_extract(value,'$.commandId'),'operation' FROM json_each(?)", changed),
        stmt(env.DB, `INSERT INTO operation_commands SELECT json_extract(value,'$.commandId'),json_extract(value,'$.hash'),?,'attendance.closeout',json_extract(value,'$.flight_id'),json_extract(value,'$.event_id'),json_extract(value,'$.person_id'),?,?,json_extract(value,'$.commandId'),1,?,'{}' FROM json_each(?)`, r.principalId, r.sourceKind, r.sourceResource, now, changed),
        stmt(env.DB, `INSERT INTO command_event_scopes SELECT json_extract(value,'$.commandId'),json_extract(value,'$.event_id'),json_extract(value,'$.flight_id') FROM json_each(?)`, changed),
        stmt(env.DB, `INSERT INTO attendance_corrections SELECT json_extract(value,'$.commandId'),json_extract(value,'$.commandId'),json_extract(value,'$.event_id'),json_extract(value,'$.person_id'),json_extract(value,'$.code'),?,json_extract(value,'$.baseVersion'),json_extract(value,'$.event_version'),? FROM json_each(?)`, CLOSEOUT_POLICY.version, now, changed),
        stmt(env.DB, `INSERT INTO audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,metadata_json) SELECT json_extract(value,'$.commandId'),?,'registered-automation','attendance.closeout',json_extract(value,'$.person_id'),?,json_object('policyVersion',?,'closeoutId',?,'before',json_extract(value,'$.before'),'code',json_extract(value,'$.code'),'baseVersion',json_extract(value,'$.baseVersion')) FROM json_each(?)`, r.principalId, now, CLOSEOUT_POLICY.version, id, changed),
        stmt(env.DB, `UPDATE operation_commands SET receipt_json=json_object('commandId',command_id,'status','committed','operation','attendance.closeout','result',json_object('personId',target_person_id,'eventId',event_id,'version',(SELECT audit_id FROM audit_events WHERE command_id=operation_commands.command_id),'code',(SELECT code FROM attendance_corrections WHERE command_id=operation_commands.command_id)),'pendingEffects',json('true')) WHERE command_id IN(SELECT json_extract(value,'$.commandId') FROM json_each(?))`, changed),
        stmt(env.DB, `UPDATE closeout_items SET state=json_extract(j.value,'$.state'),before_code=json_extract(j.value,'$.before'),final_code=COALESCE(json_extract(j.value,'$.code'),json_extract(j.value,'$.before')),reason=json_extract(j.value,'$.reason'),command_id=CASE WHEN json_extract(j.value,'$.code') IS NOT NULL THEN json_extract(j.value,'$.commandId') END FROM json_each(?) j WHERE closeout_id=? AND event_id=json_extract(j.value,'$.event_id') AND person_id=json_extract(j.value,'$.person_id') AND state='pending'`, serialized, id),
        ...(changes.length ? [stmt(env.DB, "INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,'frontend.refresh','pending',?)", commandId + '-refresh', commandId, now)] : []),
        stmt(env.DB, `INSERT INTO notification_intents(notice_id,notice_key,policy_version,kind,scope_id,local_date,environment,generation,mode,state,blocked_reason,to_json,cc_json,reply_to,subject,body,payload_hash,recipe_json,recipient_count,origin_command_id,created_at,updated_at)
 SELECT json_extract(value,'$.noticeId'),json_extract(value,'$.key'),json_extract(value,'$.policyVersion'),'weekly-review',json_extract(value,'$.scopeId'),json_extract(value,'$.localDate'),?,?,'staging','suppressed',json_extract(value,'$.blockedReason'),json_extract(value,'$.to'),json_extract(value,'$.cc'),NULL,json_extract(value,'$.subject'),json_extract(value,'$.body'),json_extract(value,'$.payloadHash'),?,json_extract(value,'$.recipientCount'),?,?,? FROM json_each(?) WHERE true ON CONFLICT(notice_key) DO NOTHING`, env.ENVIRONMENT, Number(env.GENERATION), JSON.stringify({ kind: 'closeout', closeoutId: id, policyVersion: CLOSEOUT_POLICY.version }), commandId, now, now, encodedNotices),
        audit(env, r, commandId, 'attendance.closeout.advance', id, now, { ...result, revision: snapshot.revision, notifications: notices.length }),
        stmt(env.DB, `UPDATE attendance_closeouts SET version=version+1,updated_at=?,state=CASE WHEN ?=1 THEN CASE WHEN EXISTS(SELECT 1 FROM closeout_items WHERE closeout_id=? AND state='needs-review') THEN 'needs-review' ELSE 'complete' END WHEN NOT EXISTS(SELECT 1 FROM closeout_items WHERE closeout_id=? AND state='pending') THEN 'notifying' ELSE 'processing' END WHERE closeout_id=?`, now, items.length ? 0 : 1, id, id, id),
        stmt(env.DB, `INSERT INTO closeout_steps SELECT ?,?,?,?,json_set(?,'$.state',(SELECT state FROM attendance_closeouts WHERE closeout_id=?))`, id, version, commandId, r.principalId, JSON.stringify(result), id),
        stmt(env.DB, 'UPDATE admin_commands SET receipt_json=(SELECT receipt_json FROM closeout_steps WHERE command_id=admin_commands.command_id) WHERE command_id=?', commandId),
        stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', commandId),
        stmt(env.DB, 'SELECT receipt_json FROM closeout_steps WHERE closeout_id=? AND base_version=?', id, version),
    ];
    try {
        const completed = await env.DB.batch<Record<string, unknown>>(writes);
        return JSON.parse(String(completed.at(-1)!.results[0].receipt_json));
    }
    catch {
        await authorized(env, r);
        const replay = await stmt(env.DB, `SELECT receipt_json FROM closeout_steps WHERE closeout_id=? AND base_version=? AND (${auth.sql})`, id, version, ...auth.values).first<{
            receipt_json: string;
        }>();
        if (replay)
            return JSON.parse(replay.receipt_json);
        throw new HttpError(409, 'CLOSEOUT_CONFLICT', 'Current attendance, closeout progress or authority changed. Retry the same step from fresh facts.');
    }
}
async function noticeRows(env: Env, snapshot: FrontendSnapshot, run: Run, matrix: ReturnType<typeof report>['matrix']) {
    const items = (await stmt(env.DB, 'SELECT event_id,person_id,flight_id,state FROM closeout_items WHERE closeout_id=?', run.closeout_id).all<Item & {
        state: string;
    }>()).results;
    const keys = new Map(items.map(i => [JSON.stringify([i.event_id, i.person_id]), i])), events = new Map(snapshot.events.map(e => [e.eventId, e]));
    const intents = closeoutNotices({ asOf: run.as_of, flights: flightNoticeContacts(snapshot), scopedFlightIds: [...new Set(items.map(i => i.flight_id))], reviewCount: items.filter(i => i.state === 'needs-review').length,
        rows: matrix.rows.flatMap(p => p.cells.filter(c => keys.has(JSON.stringify([c.eventId, p.personId]))).map(c => ({ flightId: keys.get(JSON.stringify([c.eventId, p.personId]))!.flight_id, personId: p.personId, name: `${p.lastName}, ${p.firstName} (${p.asYear})`, eventId: c.eventId, eventLabel: events.get(c.eventId)!.label, code: c.effectiveCode, needsReview: c.needsReview }))) });
    return Promise.all(intents.map(async (intent) => ({ ...intent, noticeId: await hash(intent.key), payloadHash: await hash(JSON.stringify({ to: intent.to, cc: intent.cc, replyTo: null, subject: intent.subject, body: intent.body })), recipientCount: new Set([...intent.to, ...intent.cc]).size })));
}
