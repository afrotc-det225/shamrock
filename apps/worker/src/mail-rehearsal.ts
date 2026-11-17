/** Deliberately separate from operational notification delivery and its suppressed ledger. */
import { adminIdentifier } from '../../../packages/domain/src/admin.js';
import { noticeLocalClock } from '../../../packages/domain/src/notifications.js';
import { effectiveAdminGrants } from './permission-grants.js';
import { HttpError } from './http-error.js';
import { planFromSnapshot, messageHash } from './notifications.js';
import { readNotificationContext } from './reporting-context.js';
export interface MailRehearsalEnv {
    DB: D1Database;
    ENVIRONMENT: string;
    GENERATION: string;
    OWNER_MAIL_REHEARSAL_ENABLED?: string;
    OWNER_MAIL_REHEARSAL_EMAIL?: string;
    OWNER_MAIL_REHEARSAL_PRINCIPAL?: string;
}
type Value = string | number | null;
const stmt = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const invalid = (): never => { throw new HttpError(400, 'INVALID_MAIL_REHEARSAL', 'Use the exact reviewed owner-mail operation.'); };
const email = (v: unknown): v is string => typeof v === 'string' && v === v.trim().toLowerCase() && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function record(v: unknown, keys: string[]): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k)))
    return invalid(); return v as Record<string, unknown>; }
function authority(env: MailRehearsalEnv, principal: string) { return { sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=?) AND EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND active=1) AND EXISTS(SELECT 1 FROM ${effectiveAdminGrants} WHERE principal_id=? AND capability='notifications.manage' AND scope_kind='wing' AND scope_key='*')`, values: [Number(env.GENERATION), principal, principal] }; }
interface Case {
    environment: string;
    generation: number;
    case_id: string;
    notice_id: string;
    source_hash: string;
    principal_id: string;
    owner_email: string;
    message_json: string;
    review_hash: string;
    state: string;
    prepared_at: string;
    expires_at: string;
}
interface Attempt {
    attempt_id: string;
    case_id: string;
    claim_id: string;
    principal_id: string;
    worker_id: string;
    claim_token: string;
    state: string;
    expires_at: string;
    completion_hash: string | null;
    receipt_json: string | null;
}
function checked(env: MailRehearsalEnv, r: Record<string, unknown>) {
    if (env.ENVIRONMENT !== 'staging' || env.OWNER_MAIL_REHEARSAL_ENABLED !== 'true' || !email(env.OWNER_MAIL_REHEARSAL_EMAIL) || !env.OWNER_MAIL_REHEARSAL_PRINCIPAL)
        throw new HttpError(403, 'OWNER_REHEARSAL_DISABLED', 'Owner mail rehearsal is disabled.');
    if (r.environment !== 'staging' || r.generation !== Number(env.GENERATION))
        return invalid();
    const p = adminIdentifier(r.principalId);
    if (p !== env.OWNER_MAIL_REHEARSAL_PRINCIPAL)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Use the explicitly configured rehearsal principal.');
    return { principal: p, owner: env.OWNER_MAIL_REHEARSAL_EMAIL, auth: authority(env, p) };
}
async function source(env: MailRehearsalEnv, principal: string, noticeId: string, expected: string, now: string) {
    const row = await stmt(env.DB, `SELECT notice_key,recipe_json,payload_hash,created_at FROM notification_intents WHERE notice_id=? AND environment='staging' AND generation=? AND mode='staging' AND state='suppressed' AND blocked_reason IS NULL`, noticeId, Number(env.GENERATION)).first<{
        notice_key: string;
        recipe_json: string;
        payload_hash: string;
        created_at: string;
    }>();
    if (!row || row.payload_hash !== expected || Date.parse(row.created_at) < Date.parse(now) - 86400000 || Date.parse(row.created_at) > Date.parse(now) + 30000)
        throw new HttpError(409, 'REHEARSAL_SOURCE_STALE', 'Choose a newly planned, reviewed suppressed intent.');
    const recipe = JSON.parse(row.recipe_json);
    if (!recipe || !['scheduled', 'excusal'].includes(recipe.kind) || !Number.isFinite(Date.parse(recipe.asOf)) || Date.parse(recipe.asOf) < Date.parse(now) - 86400000 || Date.parse(recipe.asOf) > Date.parse(now) + 30000)
        throw new HttpError(409, 'REHEARSAL_SOURCE_STALE', 'Historical notification recipes cannot be replayed as mail rehearsals.');
    const snapshot = await readNotificationContext(env, principal, recipe), intent = planFromSnapshot(snapshot, recipe).find(n => n.key === row.notice_key);
    if (!intent || !intent.to.length || intent.blockedReason || await messageHash(intent) !== expected)
        throw new HttpError(409, 'REHEARSAL_SOURCE_CHANGED', 'Current routing or notice content differs from the reviewed intent.');
    const message = { to: [env.OWNER_MAIL_REHEARSAL_EMAIL!], cc: [], subject: '[STAGING REHEARSAL] ' + intent.subject, body: 'Owner-only SHAMROCK rehearsal. No operational recipients were contacted.\n\n' + intent.body };
    if (JSON.stringify(message).length > 32000)
        throw new HttpError(409, 'REHEARSAL_TOO_LARGE', 'Use a smaller bounded notice.');
    return { snapshot, message };
}
export async function ownerMailRehearsal(env: MailRehearsalEnv, action: 'prepare' | 'claim' | 'complete' | 'status' | 'recover', input: unknown, now = new Date().toISOString()): Promise<unknown> {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(now) || !Number.isFinite(Date.parse(now)))
        return invalid();
    const common = ['environment', 'generation', 'principalId'];
    const r = record(input, [...common, ...(action === 'prepare' ? ['caseId', 'noticeId', 'payloadHash'] : action === 'claim' ? ['caseId', 'claimId', 'workerId', 'reviewHash'] : action === 'complete' ? ['attemptId', 'claimToken', 'workerId', 'outcome'] : action === 'recover' ? ['attemptId', 'claimToken', 'workerId'] : ['caseId'])]);
    const { principal, owner, auth } = checked(env, r);
    if ((await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
        allowed: number;
    }>())?.allowed !== 1)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
    if (action === 'prepare') {
        const caseId = adminIdentifier(r.caseId), noticeId = adminIdentifier(r.noticeId);
        if (!hash(r.payloadHash))
            return invalid();
        const prior = await stmt(env.DB, 'SELECT * FROM owner_mail_cases WHERE case_id=?', caseId).first<Case>();
        const replay = (c: Case) => { if (c.environment !== 'staging' || c.generation !== Number(env.GENERATION) || c.principal_id !== principal || c.notice_id !== noticeId || c.source_hash !== r.payloadHash || c.owner_email !== owner)
            throw new HttpError(409, 'REHEARSAL_ID_CONFLICT', 'The rehearsal ID already names another review.'); return { caseId, state: c.state, reviewHash: c.review_hash }; };
        if (prior)
            return replay(prior);
        const checkedSource = await source(env, principal, noticeId, r.payloadHash, now), message = JSON.stringify(checkedSource.message), reviewHash = await sha(JSON.stringify([caseId, noticeId, r.payloadHash, owner, message]));
        const expires = new Date(Date.parse(now) + 3600000).toISOString();
        try {
            await env.DB.batch([
                stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (SELECT COUNT(*) FROM owner_mail_cases)<100 AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?)`, caseId, ...auth.values, checkedSource.snapshot.revision.operations, checkedSource.snapshot.revision.administration),
                stmt(env.DB, `INSERT INTO owner_mail_cases VALUES(?,?,?,?,'staging',?,?,?,?, 'ready',?,?)`, caseId, noticeId, r.payloadHash, principal, Number(env.GENERATION), owner, message, reviewHash, now, expires),
                stmt(env.DB, `INSERT INTO owner_mail_audit(case_id,principal_id,action,accepted_at,details_json) VALUES(?,?,'prepare',?,?)`, caseId, principal, now, JSON.stringify({ sourceHash: r.payloadHash, reviewHash })), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', caseId)
            ]);
        }
        catch {
            await assertAuthority(env, auth);
            const saved = await stmt(env.DB, 'SELECT * FROM owner_mail_cases WHERE case_id=?', caseId).first<Case>();
            if (saved)
                return replay(saved);
            throw new HttpError(409, 'REHEARSAL_PREPARE_CONFLICT', 'Source, authority, rehearsal limit or review binding changed. Retain the same case ID.');
        }
        return { caseId, state: 'ready', reviewHash };
    }
    if (action === 'status') {
        const c = await stmt(env.DB, "SELECT case_id AS caseId,state,review_hash AS reviewHash,expires_at AS expiresAt FROM owner_mail_cases WHERE case_id=? AND principal_id=? AND owner_email=? AND environment='staging' AND generation=?", adminIdentifier(r.caseId), principal, owner, Number(env.GENERATION)).first();
        return { enabled: true, ownerEmail: owner, case: c ?? null };
    }
    if (action === 'claim') {
        const caseId = adminIdentifier(r.caseId), claimId = adminIdentifier(r.claimId), workerId = adminIdentifier(r.workerId);
        if (!hash(r.reviewHash))
            return invalid();
        const c = await stmt(env.DB, "SELECT * FROM owner_mail_cases WHERE case_id=? AND principal_id=? AND owner_email=? AND environment='staging' AND generation=?", caseId, principal, owner, Number(env.GENERATION)).first<Case>();
        if (!c || c.review_hash !== r.reviewHash)
            throw new HttpError(409, 'REHEARSAL_REVIEW_REQUIRED', 'The exact reviewed owner-only case is required.');
        const old = await stmt(env.DB, 'SELECT * FROM owner_mail_attempts WHERE claim_id=? OR case_id=?', claimId, caseId).first<Attempt>();
        if (old) {
            if (old.case_id !== caseId || old.claim_id !== claimId || old.worker_id !== workerId || old.principal_id !== principal)
                throw new HttpError(409, 'REHEARSAL_CLAIM_CONFLICT', 'A different consumer already claimed this rehearsal.');
            if (old.state !== 'sending')
                return { attempted: false, caseId: old.case_id, attemptId: old.attempt_id, state: old.state };
            if (old.expires_at <= now)
                return complete(env, old, 'lost-result', auth, principal, now);
            return claimResponse(old, c);
        }
        if (c.state !== 'ready' || c.expires_at <= now)
            throw new HttpError(409, 'REHEARSAL_EXPIRED', 'Prepare and review a fresh case before sending.');
        const current = await source(env, principal, c.notice_id, c.source_hash, now);
        if (JSON.stringify(current.message) !== c.message_json)
            throw new HttpError(409, 'REHEARSAL_SOURCE_CHANGED', 'The frozen message changed.');
        const attempt: Attempt = { attempt_id: crypto.randomUUID(), case_id: caseId, claim_id: claimId, principal_id: principal, worker_id: workerId, claim_token: crypto.randomUUID(), state: 'sending', expires_at: new Date(Date.parse(now) + 600000).toISOString(), completion_hash: null, receipt_json: null };
        try {
            await env.DB.batch([
                stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM owner_mail_cases WHERE case_id=? AND state='ready' AND expires_at>?) AND (SELECT COUNT(*) FROM owner_mail_attempts WHERE local_date=?)<3 AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?)`, attempt.attempt_id, ...auth.values, caseId, now, noticeLocalClock(now).date, current.snapshot.revision.operations, current.snapshot.revision.administration),
                stmt(env.DB, `INSERT INTO owner_mail_attempts VALUES(?,?,?,?,?,?,?,'sending',?,?,NULL,NULL,NULL)`, attempt.attempt_id, caseId, claimId, principal, workerId, attempt.claim_token, noticeLocalClock(now).date, now, attempt.expires_at),
                stmt(env.DB, "UPDATE owner_mail_cases SET state='sending' WHERE case_id=?", caseId),
                stmt(env.DB, `INSERT INTO owner_mail_audit(case_id,attempt_id,principal_id,action,accepted_at,details_json) VALUES(?,?,?,'claim',?,'{}')`, caseId, attempt.attempt_id, principal, now), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', attempt.attempt_id)
            ]);
        }
        catch {
            await assertAuthority(env, auth);
            const saved = await stmt(env.DB, 'SELECT * FROM owner_mail_attempts WHERE claim_id=? AND case_id=? AND worker_id=? AND principal_id=?', claimId, caseId, workerId, principal).first<Attempt>();
            if (saved) {
                if (saved.state !== 'sending')
                    return { attempted: false, caseId: saved.case_id, attemptId: saved.attempt_id, state: saved.state };
                if (saved.expires_at <= now)
                    return complete(env, saved, 'lost-result', auth, principal, now);
                return claimResponse(saved, c);
            }
            throw new HttpError(409, 'REHEARSAL_CLAIM_CONFLICT', 'Authority, source, daily rehearsal budget or claim changed; retain the same claim ID.');
        }
        return claimResponse(attempt, c);
    }
    const attemptId = adminIdentifier(r.attemptId), token = adminIdentifier(r.claimToken), worker = adminIdentifier(r.workerId);
    const a = await stmt(env.DB, `SELECT a.* FROM owner_mail_attempts a JOIN owner_mail_cases c USING(case_id) WHERE a.attempt_id=? AND a.claim_token=? AND a.worker_id=? AND a.principal_id=? AND c.owner_email=? AND c.environment='staging' AND c.generation=?`, attemptId, token, worker, principal, owner, Number(env.GENERATION)).first<Attempt>();
    if (!a)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'The exact original rehearsal claim is required.');
    if (action === 'recover') {
        if (a.state === 'sending' && a.expires_at > now)
            throw new HttpError(409, 'REHEARSAL_NOT_EXPIRED', 'The retained attempt has not expired.');
        return complete(env, a, 'lost-result', auth, principal, now);
    }
    if (!['confirmed', 'known-not-sent', 'lost-result'].includes(String(r.outcome)))
        return invalid();
    return complete(env, a, String(r.outcome), auth, principal, now);
}
function claimResponse(a: Attempt, c: Case) { return { attempted: true, mode: 'owner-rehearsal', caseId: a.case_id, attemptId: a.attempt_id, claimToken: a.claim_token, expiresAt: a.expires_at, message: JSON.parse(c.message_json) }; }
async function complete(env: MailRehearsalEnv, a: Attempt, outcome: string, auth: ReturnType<typeof authority>, principal: string, now: string) {
    const digest = await sha(outcome);
    const replay = (saved: Attempt) => { if (saved.completion_hash !== digest && saved.state !== 'uncertain')
        throw new HttpError(409, 'REHEARSAL_RESULT_CONFLICT', 'A different result is already recorded.'); return JSON.parse(saved.receipt_json!); };
    if (a.receipt_json)
        return replay(a);
    const state = a.state === 'uncertain' || a.expires_at <= now || outcome === 'lost-result' ? 'uncertain' : outcome === 'confirmed' ? 'sent' : 'not-sent';
    const receipt = JSON.stringify({ attempted: false, caseId: a.case_id, attemptId: a.attempt_id, state });
    try {
        await env.DB.batch([
            stmt(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM owner_mail_attempts WHERE attempt_id=? AND receipt_json IS NULL))`, a.claim_token, ...auth.values, a.attempt_id),
            stmt(env.DB, 'UPDATE owner_mail_attempts SET state=?,finished_at=?,completion_hash=?,receipt_json=? WHERE attempt_id=?', state, now, digest, receipt, a.attempt_id), stmt(env.DB, 'UPDATE owner_mail_cases SET state=? WHERE case_id=?', state, a.case_id),
            stmt(env.DB, `INSERT INTO owner_mail_audit(case_id,attempt_id,principal_id,action,accepted_at,details_json) VALUES(?,?,?,?,?,?)`, a.case_id, a.attempt_id, principal, state, now, JSON.stringify({ reportedOutcome: outcome })), stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', a.claim_token)
        ]);
    }
    catch {
        await assertAuthority(env, auth);
        const saved = await stmt(env.DB, 'SELECT * FROM owner_mail_attempts WHERE attempt_id=? AND claim_token=? AND worker_id=? AND principal_id=?', a.attempt_id, a.claim_token, a.worker_id, principal).first<Attempt>();
        if (saved?.receipt_json)
            return replay(saved);
        throw new HttpError(409, 'REHEARSAL_RESULT_CONFLICT', 'The retained attempt changed; retry its exact result.');
    }
    return JSON.parse(receipt);
}
async function assertAuthority(env: MailRehearsalEnv, auth: ReturnType<typeof authority>) {
    if ((await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
        allowed: number;
    }>())?.allowed !== 1)
        throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
}
