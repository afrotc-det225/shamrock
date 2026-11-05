import {
  buildAttendanceReport, createExcusalRequest, decideExcusalRequest,
  DomainError, parseCommand,
  type Command, type ExcusalRequest,
} from '../../../packages/domain/src/index.js';

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  GENERATION: string;
  BRIDGE_KEY_ID: string;
  BRIDGE_SECRET: string;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const MAX_BODY_BYTES = 65_536;
const LEASE_MS = 10 * 60 * 1000;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const statement = (db: D1Database, sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values);
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function configuration(env: Env): void {
  if (!['local', 'staging'].includes(env.ENVIRONMENT) || !/^[1-9]\d*$/.test(env.GENERATION)
    || !Number.isSafeInteger(Number(env.GENERATION)) || !identifier(env.BRIDGE_KEY_ID)
    || typeof env.BRIDGE_SECRET !== 'string' || env.BRIDGE_SECRET.length < 32) {
    throw new HttpError(503, 'NOT_CONFIGURED', 'The isolated adapter is not configured.');
  }
}

async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let count = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Use a bounded operation.');
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_BODY', 'Expected UTF-8 JSON.');
  }
}

async function authenticate(request: Request, env: Env, body: string): Promise<void> {
  const timestamp = request.headers.get('x-shamrock-timestamp') ?? '';
  const signature = request.headers.get('x-shamrock-signature') ?? '';
  if (request.headers.get('x-shamrock-key-id') !== env.BRIDGE_KEY_ID
    || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Valid adapter authentication is required.');
  }
  const url = new URL(request.url);
  const canonical = `${request.method}\n${url.pathname}${url.search}\n${timestamp}\n${await digest(body)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BRIDGE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16));
  if (!await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(canonical))) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Valid adapter authentication is required.');
  }
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Expected a JSON object.'); }
}

interface Context { eventId: string; unitId: string; personId: string | null; current?: ExcusalRequest }

async function requestRecord(db: D1Database, requestId: string): Promise<(ExcusalRequest & { unitId: string }) | null> {
  const row = await statement(db, `SELECT request_id AS requestId, event_id AS eventId, person_id AS personId,
    unit_id AS unitId, requested_outcome AS requestedOutcome, reason, status, decision, version,
    submitted_at AS submittedAt, submitted_by AS submittedBy, updated_at AS updatedAt,
    decided_at AS decidedAt, decided_by AS decidedBy, decision_reason AS decisionReason,
    source_json AS sourceJson, command_id AS commandId, last_command_id AS lastCommandId
    FROM excusal_requests WHERE request_id = ?`, requestId).first<ExcusalRequest & { unitId: string; sourceJson: string }>();
  if (!row) return null;
  const { sourceJson, ...rest } = row;
  return { ...rest, source: JSON.parse(sourceJson) };
}

async function context(db: D1Database, command: Command): Promise<Context> {
  if (command.operation === 'attendance.report') {
    return { eventId: command.payload.eventId, unitId: command.payload.unitId, personId: null };
  }
  if (command.operation === 'excusal.decide') {
    const current = await requestRecord(db, command.payload.requestId);
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'The requested record is unavailable.');
    const { unitId, ...record } = current;
    return { eventId: current.eventId, unitId, personId: current.personId, current: record };
  }
  const units = await statement(db, `SELECT unit_id AS unitId FROM memberships
    WHERE person_id=? AND active=1 LIMIT 2`, command.payload.personId)
    .all<{ unitId: string }>();
  if (units.results.length !== 1) throw new HttpError(409, 'AMBIGUOUS_SCOPE', 'Resolve the event membership before submitting.');
  return { eventId: command.payload.eventId, unitId: units.results[0].unitId, personId: command.payload.personId };
}

const controlSql = `EXISTS (SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)`;
const permissionSql = `EXISTS (SELECT 1 FROM principals p JOIN access_grants g ON g.principal_id=p.principal_id
  WHERE p.principal_id=? AND p.active=1 AND g.capability=? AND g.unit_id=?
  AND (g.subject_scope='unit' OR (g.subject_scope='self' AND p.person_id=?)))`;
const sourceSql = `EXISTS (SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)`;
// The current projection/outbox is scoped by one unit, while attendance evidence is
// keyed by event/person. Multiple active units require explicit revision/job fan-out;
// reject that unsupported topology rather than publish stale views in another unit.
const singleUnitScopeSql = `NOT EXISTS (SELECT 1 FROM memberships scoped JOIN memberships other
  ON other.person_id=scoped.person_id AND other.active=1 AND other.unit_id<>scoped.unit_id
  WHERE scoped.unit_id=? AND scoped.active=1)`;

function membershipGuard(ctx: Context): { sql: string; values: (string | number | null)[] } {
  return {
    sql: `${singleUnitScopeSql}${ctx.personId === null ? '' : ` AND
      (SELECT COUNT(*) FROM memberships WHERE person_id=? AND active=1)=1
      AND EXISTS (SELECT 1 FROM memberships WHERE person_id=? AND unit_id=? AND active=1)`}`,
    values: ctx.personId === null ? [ctx.unitId] : [ctx.unitId, ctx.personId, ctx.personId, ctx.unitId],
  };
}

function guardParts(env: Env, command: Command, ctx: Context): { sql: string; values: (string | number | null)[] } {
  return {
    sql: `${controlSql} AND ${permissionSql} AND ${sourceSql}
      AND EXISTS (SELECT 1 FROM events e JOIN event_units eu ON eu.event_id=e.event_id
        WHERE e.event_id=? AND e.active=1 AND eu.unit_id=?)`,
    values: [env.ENVIRONMENT, Number(env.GENERATION), command.actor.principalId, command.operation,
      ctx.unitId, command.operation === 'excusal.submit' ? ctx.personId : null,
      command.source.kind, command.source.resourceKey, ctx.eventId, ctx.unitId],
  };
}

async function authorize(env: Env, command: Command, ctx: Context): Promise<void> {
  if (command.environment !== env.ENVIRONMENT || command.generation !== Number(env.GENERATION)) {
    throw new HttpError(409, 'WRONG_GENERATION', 'Reload the current environment before submitting.');
  }
  if ((command.actor.evidence === 'google-form' && command.source.kind !== 'form')
    || (command.actor.evidence === 'google-edit' && command.source.kind !== 'sheet')) {
    throw new HttpError(400, 'INVALID_EVIDENCE', 'Actor evidence does not match the source.');
  }
  const guard = guardParts(env, command, ctx);
  const result = await statement(env.DB, `SELECT (${guard.sql}) AS allowed`, ...guard.values).first<{ allowed: number }>();
  if (result?.allowed !== 1) throw new HttpError(403, 'NOT_AUTHORIZED', 'The actor, source or operation is not currently authorized.');
}

interface Receipt {
  commandId: string;
  status: 'committed';
  operation: Command['operation'];
  result: unknown;
  pendingEffects: true;
}
async function priorReceipt(db: D1Database, commandId: string, hash: string): Promise<Receipt | null> {
  const prior = await statement(db, 'SELECT payload_hash AS hash, receipt_json AS receipt FROM operation_commands WHERE command_id=?', commandId)
    .first<{ hash: string; receipt: string }>();
  if (!prior) return null;
  if (prior.hash !== hash) throw new HttpError(409, 'COMMAND_ID_CONFLICT', 'This command ID was already used for different input.');
  return JSON.parse(prior.receipt);
}

async function acceptCommand(env: Env, command: Command): Promise<Receipt> {
  const ctx = await context(env.DB, command);
  await authorize(env, command, ctx);
  const membership = membershipGuard(ctx);
  const scope = await statement(env.DB, `SELECT (${membership.sql}) AS supported`, ...membership.values).first<{ supported: number }>();
  if (scope?.supported !== 1) throw new HttpError(409, 'AMBIGUOUS_SCOPE', 'This prototype requires one active unit per person in the command scope.');
  const hash = await digest(JSON.stringify(command)); // parseCommand emits deterministic property order.
  const prior = await priorReceipt(env.DB, command.commandId, hash);
  if (prior) return prior;
  const now = new Date().toISOString();
  const guard = guardParts(env, command, ctx);
  // Recheck membership inside the same atomic batch as the accepted mutation.
  guard.sql += ` AND ${membership.sql}`;
  guard.values.push(...membership.values);
  const writes: D1PreparedStatement[] = [];
  let result: unknown;
  let targetId: string;

  if (command.operation === 'attendance.report') {
    const report = buildAttendanceReport(command, now);
    result = report; targetId = report.reportId;
    guard.sql += ` AND EXISTS (SELECT 1 FROM organizational_units WHERE unit_id=? AND roster_version=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS
        (SELECT 1 FROM memberships m WHERE m.unit_id=? AND m.person_id=j.value AND m.active=1))
      AND (?='partial' OR (SELECT COUNT(*) FROM memberships WHERE unit_id=? AND active=1)=json_array_length(?))`;
    guard.values.push(report.unitId, report.rosterVersion, JSON.stringify(report.coveredPersonIds), report.unitId,
      report.completeness, report.unitId, JSON.stringify(report.coveredPersonIds));
    writes.push(statement(env.DB, `INSERT INTO attendance_reports VALUES (?,?,?,?,?,?,?,?)`,
      report.reportId, report.eventId, report.unitId, report.rosterVersion, report.completeness,
      report.submittedAt, report.submittedBy, command.commandId));
    writes.push(statement(env.DB, `INSERT INTO attendance_report_members (report_id,person_id,present)
      SELECT ?,c.value,EXISTS(SELECT 1 FROM json_each(?) p WHERE p.value=c.value) FROM json_each(?) c`,
      report.reportId, JSON.stringify(report.presentPersonIds), JSON.stringify(report.coveredPersonIds)));
    writes.push(statement(env.DB, `INSERT INTO attendance_observations (report_id,event_id,person_id,code,accepted_at)
      SELECT ?,?,value,'P',? FROM json_each(?)`, report.reportId, report.eventId, now, JSON.stringify(report.presentPersonIds)));
    writes.push(statement(env.DB, `INSERT INTO attendance_current (event_id,person_id,observed_code,version,updated_at)
      SELECT ?,value,'P',1,? FROM json_each(?) WHERE true
      ON CONFLICT(event_id,person_id) DO UPDATE SET observed_code='P',version=attendance_current.version+1,updated_at=excluded.updated_at`,
      report.eventId, now, JSON.stringify(report.presentPersonIds)));
  } else if (command.operation === 'excusal.submit') {
    const request = createExcusalRequest(command, now);
    result = request; targetId = request.requestId;
    guard.sql += ' AND EXISTS (SELECT 1 FROM memberships WHERE unit_id=? AND person_id=? AND active=1)';
    guard.values.push(ctx.unitId, request.personId);
    writes.push(statement(env.DB, `INSERT INTO excusal_requests
      (request_id,event_id,person_id,unit_id,requested_outcome,reason,status,decision,version,
       submitted_at,submitted_by,updated_at,decided_at,decided_by,decision_reason,source_json,command_id,last_command_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      request.requestId, request.eventId, request.personId, ctx.unitId, request.requestedOutcome, request.reason,
      request.status, request.decision, request.version, request.submittedAt, request.submittedBy, request.updatedAt,
      request.decidedAt, request.decidedBy, request.decisionReason, JSON.stringify(request.source), request.commandId, request.lastCommandId));
  } else {
    const request = decideExcusalRequest(ctx.current!, command, now);
    result = request; targetId = request.requestId;
    guard.sql += ' AND EXISTS (SELECT 1 FROM excusal_requests WHERE request_id=? AND version=?)';
    guard.values.push(request.requestId, command.payload.expectedVersion);
    writes.push(statement(env.DB, `UPDATE excusal_requests SET status=?,decision=?,version=?,updated_at=?,
      decided_at=?,decided_by=?,decision_reason=?,last_command_id=? WHERE request_id=? AND version=?`,
      request.status, request.decision, request.version, request.updatedAt, request.decidedAt, request.decidedBy,
      request.decisionReason, request.lastCommandId, request.requestId, command.payload.expectedVersion));
    writes.push(statement(env.DB, `INSERT INTO excusal_decisions VALUES (?,?,?,?,?,?,?)`, request.requestId,
      request.version, request.decision, request.decisionReason, command.actor.principalId, now, command.commandId));
  }

  const receipt: Receipt = { commandId: command.commandId, status: 'committed', operation: command.operation, result, pendingEffects: true };
  const batch = [
    statement(env.DB, `INSERT INTO command_assertions(command_id,ok) SELECT ?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END`, command.commandId, ...guard.values),
    statement(env.DB, `INSERT INTO operation_commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      command.commandId, hash, command.actor.principalId, command.operation, ctx.unitId, ctx.eventId, ctx.personId,
      command.source.kind, command.source.resourceKey, command.source.submissionId, command.source.revision, now, JSON.stringify(receipt)),
    ...writes,
    statement(env.DB, `INSERT INTO audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,metadata_json)
      VALUES (?,?,?,?,?,?,?)`, command.commandId, command.actor.principalId, command.actor.evidence,
      command.operation, targetId, now, JSON.stringify({ source: command.source, environment: command.environment, generation: command.generation })),
    statement(env.DB, `INSERT INTO outbox_jobs(job_id,command_id,kind,event_id,unit_id,created_at) VALUES (?,?,'attendance.projection',?,?,?)`,
      `projection:${await digest(command.commandId)}`, command.commandId, ctx.eventId, ctx.unitId, now),
    statement(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', command.commandId),
  ];
  try { await env.DB.batch(batch); }
  catch (error) {
    // Another identical request may have committed while our batch was waiting.
    const committed = await priorReceipt(env.DB, command.commandId, hash);
    if (committed) return committed;
    const message = String(error);
    if (/constraint|command_preconditions/i.test(message)) {
      throw new HttpError(409, 'PRECONDITION_CONFLICT', 'State or source identity changed. Review before retrying.');
    }
    throw error;
  }
  return receipt;
}

function jobInput(value: unknown, env: Env, claim = false): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_JOB', 'Expected a job request.');
  const raw = value as Record<string, unknown>;
  const keys = claim ? ['environment', 'generation', 'workerId'] : ['environment', 'generation', 'workerId', 'jobId', 'claimToken'];
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
    || raw.environment !== env.ENVIRONMENT || raw.generation !== Number(env.GENERATION)
    || !identifier(raw.workerId) || (!claim && (!identifier(raw.jobId) || !identifier(raw.claimToken)))) {
    throw new HttpError(400, 'INVALID_JOB', 'Invalid job identity or environment.');
  }
  return raw as Record<string, string | number>;
}
interface Job { jobId: string; claimToken: string; leaseExpiresAt: string; eventId: string; unitId: string; kind: string }
async function claimJob(env: Env, input: Record<string, string | number>): Promise<{ job: Job | null }> {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  const token = crypto.randomUUID();
  // Expired leases are retained for attention. A database lease cannot cancel an
  // already issued Google request, so this prototype deliberately never steals one.
  const job = await statement(env.DB, `UPDATE outbox_jobs SET state='leased',worker_id=?,claim_token=?,lease_expires_at=?
    WHERE job_id=(SELECT j.job_id FROM outbox_jobs j WHERE j.state='pending' AND ${controlSql}
      AND NOT EXISTS(SELECT 1 FROM outbox_jobs l WHERE l.event_id=j.event_id AND l.unit_id=j.unit_id AND l.state='leased')
      ORDER BY j.created_at,j.job_id LIMIT 1)
    RETURNING job_id AS jobId,claim_token AS claimToken,lease_expires_at AS leaseExpiresAt,event_id AS eventId,unit_id AS unitId,kind`,
    input.workerId, token, until, env.ENVIRONMENT, Number(env.GENERATION)).first<Job>();
  return { job };
}
async function leasedJob(env: Env, input: Record<string, string | number>): Promise<Job> {
  const job = await statement(env.DB, `SELECT job_id AS jobId,claim_token AS claimToken,lease_expires_at AS leaseExpiresAt,
    event_id AS eventId,unit_id AS unitId,kind FROM outbox_jobs WHERE job_id=? AND state='leased' AND worker_id=?
    AND claim_token=? AND lease_expires_at>? AND ${controlSql}`,
    input.jobId, input.workerId, input.claimToken, new Date().toISOString(), env.ENVIRONMENT, Number(env.GENERATION)).first<Job>();
  if (!job) throw new HttpError(409, 'LEASE_CONFLICT', 'The job lease is no longer current.');
  return job;
}
async function projectJob(env: Env, input: Record<string, string | number>): Promise<unknown> {
  const job = await leasedJob(env, input);
  // D1 batch gives these related reads one transactional snapshot. Bounded to
  // the interactive prototype's maximum roster; larger views need pagination.
  const [event, unit, members, requests, revision, membership] = await env.DB.batch([
    statement(env.DB, 'SELECT event_id AS eventId,label FROM events WHERE event_id=?', job.eventId),
    statement(env.DB, 'SELECT unit_id AS unitId,label FROM organizational_units WHERE unit_id=?', job.unitId),
    statement(env.DB, `SELECT p.person_id AS personId,p.display_name AS displayName,a.observed_code AS observedCode
      FROM memberships m JOIN people p ON p.person_id=m.person_id LEFT JOIN attendance_current a
      ON a.person_id=p.person_id AND a.event_id=? WHERE m.unit_id=? AND m.active=1 ORDER BY p.person_id LIMIT 501`, job.eventId, job.unitId),
    statement(env.DB, `SELECT request_id AS requestId,person_id AS personId,status,requested_outcome AS requestedOutcome,version
      FROM excusal_requests WHERE event_id=? AND unit_id=? ORDER BY request_id LIMIT 1001`, job.eventId, job.unitId),
    // All current prototype mutations append an audit record atomically. Future
    // roster/event/name mutations must also advance this scope's revision.
    statement(env.DB, `SELECT COALESCE(MAX(a.audit_id),0) AS revision FROM audit_events a
      JOIN operation_commands c ON c.command_id=a.command_id WHERE c.event_id=? AND c.unit_id=?`, job.eventId, job.unitId),
    statement(env.DB, `SELECT (${singleUnitScopeSql}) AS supported`, job.unitId),
  ]);
  if ((membership.results[0] as { supported: number }).supported !== 1) {
    throw new HttpError(409, 'AMBIGUOUS_SCOPE', 'This prototype requires one active unit per person in the projection scope.');
  }
  if (members.results.length > 500 || requests.results.length > 1000) {
    throw new HttpError(409, 'PROJECTION_TOO_LARGE', 'Use a reviewed paginated publication workflow.');
  }
  const memberRows = members.results as { personId: string; displayName: string; observedCode: string | null }[];
  const requestRows = requests.results as { personId: string; requestId: string; status: string; requestedOutcome: string; version: number }[];
  const memberIds = new Set(memberRows.map(member => member.personId));
  if (requestRows.some(request => !memberIds.has(request.personId))) {
    throw new HttpError(409, 'PROJECTION_INCOMPLETE', 'A request outside the current roster needs a reviewed publication workflow.');
  }
  const byPerson = new Map<string, Omit<typeof requestRows[number], 'personId'>[]>();
  for (const { personId, ...request } of requestRows) {
    const existing = byPerson.get(personId);
    if (existing) existing.push(request);
    else byPerson.set(personId, [request]);
  }
  return { revision: (revision.results[0] as { revision: number }).revision, event: event.results[0], unit: unit.results[0], rows: memberRows.map(member => ({
    ...member, requests: byPerson.get(member.personId) ?? [],
  })) };
}
async function acknowledgeJob(env: Env, input: Record<string, string | number>): Promise<unknown> {
  const result = await statement(env.DB, `UPDATE outbox_jobs SET state='done',completed_at=? WHERE job_id=? AND state='leased'
    AND worker_id=? AND claim_token=? AND lease_expires_at>? AND ${controlSql} RETURNING job_id`,
    new Date().toISOString(), input.jobId, input.workerId, input.claimToken, new Date().toISOString(),
    env.ENVIRONMENT, Number(env.GENERATION)).first();
  if (!result) throw new HttpError(409, 'LEASE_CONFLICT', 'The job lease is no longer current.');
  return { acknowledged: true };
}
async function getReceipt(env: Env, url: URL): Promise<unknown> {
  const id = url.pathname.slice('/v1/commands/'.length);
  const actor = url.searchParams.get('principalId');
  if (!identifier(id) || !identifier(actor) || [...url.searchParams.keys()].some(key => key !== 'principalId')) {
    throw new HttpError(400, 'INVALID_RECEIPT_QUERY', 'Specify a command and principal.');
  }
  const row = await statement(env.DB, `SELECT c.receipt_json AS receipt FROM operation_commands c
    JOIN principals p ON p.principal_id=c.actor_id JOIN access_grants g ON g.principal_id=p.principal_id
    AND g.capability=c.operation AND g.unit_id=c.unit_id WHERE c.command_id=? AND c.actor_id=? AND p.active=1
    AND (g.subject_scope='unit' OR (c.operation='excusal.submit' AND p.person_id=c.target_person_id)) AND ${controlSql}`,
    id, actor, env.ENVIRONMENT, Number(env.GENERATION)).first<{ receipt: string }>();
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'The requested receipt is unavailable.');
  return JSON.parse(row.receipt);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      configuration(env);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ service: 'shamrock', phase: 'isolated-prototype', contractVersion: 1 });
      }
      const body = await boundedBody(request);
      await authenticate(request, env, body);
      if (request.method === 'GET' && url.pathname.startsWith('/v1/commands/')) return json(await getReceipt(env, url));
      if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Use an authenticated JSON operation.');
      }
      const input = parseJson(body);
      if (url.pathname === '/v1/commands' && !url.search) return json(await acceptCommand(env, parseCommand(input)));
      if (url.pathname === '/v1/jobs/claim' && !url.search) return json(await claimJob(env, jobInput(input, env, true)));
      if (url.pathname === '/v1/jobs/project' && !url.search) return json(await projectJob(env, jobInput(input, env)));
      if (url.pathname === '/v1/jobs/ack' && !url.search) return json(await acknowledgeJob(env, jobInput(input, env)));
      throw new HttpError(404, 'NOT_FOUND', 'Unknown operation.');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof DomainError) return json({ error: { code: error.code, message: error.message, path: error.path } }, error.code === 'VERSION_CONFLICT' ? 409 : 400);
      // Do not expose SQL, input, credentials, or raw exception details.
      return json({ error: { code: 'INTERNAL_ERROR', message: 'The operation failed; check its receipt before retrying.' } }, 500);
    }
  },
};
