/** Suppressed planning/status API and local-only transport rehearsal. No mail provider binding. */
import { adminIdentifier, type FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { buildFrontendReporting, REPORTING_POLICY_VERSION } from '../../../packages/domain/src/frontend-reporting.js';
import { NOTICE_POLICY, advanceDelivery, noticeLocalClock, planExcusalNotice, planScheduledNotices, type FlightNoticeContact, type NoticeRecipient, type NotificationIntent, } from '../../../packages/domain/src/notifications.js';
import { frontendSnapshot } from './admin.js';
import { HttpError } from './http-error.js';
type Value = string | number | null;
interface NotificationEnv {
  DB: D1Database;
  ENVIRONMENT: string;
  GENERATION: string;
}
interface PlanCommand {
  commandId: string;
  contractVersion: 1;
  environment: string;
  generation: number;
  actor: {
    principalId: string;
    evidence: 'google-edit' | 'authenticated-confirmation' | 'registered-automation';
  };
  source: {
    kind: 'sheet' | 'test';
    resourceKey: string;
    submissionId: string;
    revision: number;
  };
  operation: 'notifications.plan';
  payload: {
    kind: 'scheduled' | 'excusal';
    asOf: string;
    requestId: string | null;
  };
}
const statement = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
function invalid(message = 'Invalid notification request.'): never { throw new HttpError(400, 'INVALID_NOTIFICATION', message); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
    return invalid();
  return row;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    return invalid('Expected a canonical UTC planning time.');
  return value;
}
function parsePlan(input: unknown, env: NotificationEnv): PlanCommand {
  const row = record(input, ['commandId', 'contractVersion', 'environment', 'generation', 'actor', 'source', 'operation', 'payload']);
  const actor = record(row.actor, ['principalId', 'evidence']);
  const source = record(row.source, ['kind', 'resourceKey', 'submissionId', 'revision']);
  const payload = record(row.payload, ['kind', 'asOf', 'requestId']);
  if (row.contractVersion !== 1 || row.operation !== 'notifications.plan' || row.environment !== env.ENVIRONMENT || row.generation !== Number(env.GENERATION))
    return invalid();
  if (source.kind !== 'test' && source.kind !== 'sheet')
    return invalid();
  if (actor.evidence !== 'authenticated-confirmation' && actor.evidence !== 'registered-automation' && !(actor.evidence === 'google-edit' && source.kind === 'sheet'))
    return invalid();
  if (!Number.isSafeInteger(source.revision) || Number(source.revision) < 1)
    return invalid();
  if (payload.kind !== 'scheduled' && payload.kind !== 'excusal')
    return invalid();
  if (payload.kind === 'scheduled' && payload.requestId !== null)
    return invalid();
  return {
    commandId: adminIdentifier(row.commandId), contractVersion: 1, environment: env.ENVIRONMENT, generation: Number(env.GENERATION),
    actor: { principalId: adminIdentifier(actor.principalId), evidence: actor.evidence },
    source: { kind: source.kind, resourceKey: adminIdentifier(source.resourceKey), submissionId: adminIdentifier(source.submissionId), revision: Number(source.revision) },
    operation: 'notifications.plan', payload: { kind: payload.kind, asOf: instant(payload.asOf), requestId: payload.kind === 'excusal' ? adminIdentifier(payload.requestId) : null },
  };
}
function authority(env: NotificationEnv, principalId: string, write = true) {
  return {
    sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write ? ' AND accepting_commands=1' : ''})
   AND EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND active=1)
   AND EXISTS(SELECT 1 FROM admin_grants WHERE principal_id=? AND capability='notifications.manage' AND scope_kind='wing' AND scope_key='*')`,
    values: [env.ENVIRONMENT, Number(env.GENERATION), principalId, principalId],
  };
}
const roleKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
function recipient(snapshot: FrontendSnapshot, roles: string[]): NoticeRecipient | undefined {
  const keys = new Set(roles.map(roleKey));
  const matches = snapshot.leadership.filter(contact => contact.active && keys.has(roleKey(contact.role)));
  // Ambiguous or malformed routing is missing routing, never the first matching person.
  if (matches.length !== 1 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(matches[0].email))
    return undefined;
  return { email: matches[0].email, displayName: `${matches[0].lastName}, ${matches[0].firstName}` };
}
export function flightNoticeContacts(snapshot: FrontendSnapshot): FlightNoticeContact[] {
  return snapshot.flights.map(f => ({ flightId: f.flightId, label: f.label, operational: roleKey(f.label) !== 'abroad',
    commander: recipient(snapshot, [`${f.label} Flight Commander`, `Cadet ${f.label} Flight Commander`]),
    deputy: recipient(snapshot, [`${f.label} Deputy Flight Commander`, `Deputy ${f.label} Flight Commander`, `Cadet ${f.label} Deputy Flight Commander`]) }));
}
function planFromSnapshot(snapshot: FrontendSnapshot, recipe: PlanCommand['payload']): NotificationIntent[] {
  if (snapshot.diagnostics.length)
    throw new HttpError(409, 'NOTIFICATION_SNAPSHOT_INCOMPLETE', 'Resolve the roster/catalog diagnostics before planning notices.');
  const clock = noticeLocalClock(recipe.asOf);
  if (recipe.kind === 'excusal') {
    const request = snapshot.requests.find(row => row.requestId === recipe.requestId);
    if (!request)
      throw new HttpError(404, 'NOT_FOUND', 'The requested excusal is unavailable.');
    if (request.legacyStateOnly) throw new HttpError(409, 'LEGACY_REQUEST_NOTICE_REQUIRES_NEW_ACTION', 'Imported request history does not replay a notification.');
    const person = snapshot.people.find(row => row.personId === request.personId);
    const event = snapshot.events.find(row => row.eventId === request.eventId);
    const flight = snapshot.flights.find(row => row.flightId === request.flightId);
    const squadron = snapshot.squadrons.find(row => row.squadronId === flight?.squadronId);
    if (!person || !event || !squadron)
      throw new HttpError(409, 'NOTIFICATION_SNAPSHOT_INCOMPLETE', 'Resolve the excusal routing records before planning its notice.');
    const commander = recipient(snapshot, [`${squadron.label} Squadron Commander`, `Cadet ${squadron.label} Squadron Commander`]);
    if (!person.email || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(person.email)) {
      const kind = request.status === 'Submitted' ? 'excusal-submitted' : 'excusal-decision';
      return [{ key: JSON.stringify([NOTICE_POLICY.version, kind, request.requestId, request.version]), policyVersion: NOTICE_POLICY.version,
          kind, scopeId: squadron.squadronId, localDate: clock.date, state: 'suppressed', blockedReason: 'missing-recipient', to: [], cc: [],
          subject: 'Excusal routing requires review', body: 'The cadet email is unavailable. Review the Directory and the excusal record before any delivery.' }];
    }
    return [planExcusalNotice({ mode: 'staging', now: recipe.asOf, requestId: request.requestId, version: request.version,
        squadronId: squadron.squadronId, eventLabel: event.label, cadet: { email: person.email, displayName: `${person.lastName}, ${person.firstName}` }, commander,
        status: request.status as 'Submitted' | 'Approved' | 'Denied' | 'Withdrawn' | 'Superseded', reason: request.status === 'Submitted' ? request.reason : request.decisionReason ?? request.reason })];
  }
  const current = snapshot.terms.filter(term => term.isCurrent);
  if (current.length !== 1)
    throw new HttpError(409, 'NOTIFICATION_SNAPSHOT_INCOMPLETE', 'Exactly one current term is required.');
  const report = buildFrontendReporting({ policyVersion: REPORTING_POLICY_VERSION, asOfDate: clock.date, currentTermId: current[0].termId,
    people: snapshot.people, flights: snapshot.flights.map(f => ({ ...f, squadronId: f.squadronId! })), squadrons: snapshot.squadrons,
    terms: snapshot.terms.map(term => ({ ...term, roster: term.isCurrent ? undefined : term.roster })),
    events: snapshot.events.map(event => ({ ...event, type: event.eventType })), observations: snapshot.observations, corrections: snapshot.corrections, legacyBaselines: snapshot.legacyBaselines ?? [],
    requests: snapshot.requests as Parameters<typeof buildFrontendReporting>[0]['requests'] });
  const flights = flightNoticeContacts(snapshot);
  const events = snapshot.events.filter(event => event.startAt !== null).map(event => ({ eventId: event.eventId, termId: event.termId, label: event.label,
    type: ({ 'mando': 'Mando PT', 'secondary': 'Secondary PT', 'llab': 'LLAB', 'other': 'Other' } as const)[event.eventType], startsAt: event.startAt!, status: event.status,
    flightIds: snapshot.eventFlights.filter(scope => scope.eventId === event.eventId).map(scope => scope.flightId) }));
  const eventIds = new Set(events.map(event => event.eventId));
  const attendance = report.matrices.flatMap(matrix => matrix.rows.flatMap(person => person.flightId === null ? [] : person.cells.filter(cell => eventIds.has(cell.eventId)).map(cell => ({
    eventId: cell.eventId, personId: person.personId, flightId: person.flightId!, displayName: `${person.lastName}, ${person.firstName}`,
    eligible: cell.eligible, code: cell.effectiveCode, pendingRequest: cell.requests.some(request => request.status === 'Submitted'),
  }))));
  return planScheduledNotices({ now: recipe.asOf, mode: 'staging', events, flights, attendance });
}
function messageHash(intent: NotificationIntent): Promise<string> {
  return hash(JSON.stringify({ to: intent.to, cc: intent.cc, replyTo: intent.replyTo ?? null, subject: intent.subject, body: intent.body }));
}
interface NotificationTask { task_id: string; request_id: string; request_version: number; request_json: string; state: string; created_at: string }
export async function planNotifications(env: NotificationEnv, input: unknown, task?: NotificationTask): Promise<unknown> {
  const command = parsePlan(input, env);
  const digest = await hash(JSON.stringify(command));
  const auth = authority(env, command.actor.principalId);
  auth.sql += ` AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)`;
  auth.values.push(command.source.kind, command.source.resourceKey);
  const previous = await statement(env.DB, `SELECT payload_hash AS hash,actor_id AS actorId,operation,receipt_json AS receipt,(${auth.sql}) AS allowed
  FROM admin_commands WHERE command_id=?`, ...auth.values, command.commandId).first<{
    hash: string;
    actorId: string;
    operation: string;
    receipt: string;
    allowed: number;
  }>();
  if (previous) {
    if (previous.allowed !== 1 || previous.actorId !== command.actor.principalId)
      throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
    if (previous.operation !== 'notifications.plan' || previous.hash !== digest)
      throw new HttpError(409, 'COMMAND_ID_CONFLICT', 'This command ID was already used.');
    return JSON.parse(previous.receipt);
  }
  const authorized = await statement(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
    allowed: number;
  }>();
  if (authorized?.allowed !== 1)
    throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
  const snapshot = await frontendSnapshot(env, { environment: env.ENVIRONMENT, generation: Number(env.GENERATION), principalId: command.actor.principalId });
  const frozenSnapshot = task ? { ...snapshot, requests: snapshot.requests.filter(request => request.requestId !== task.request_id).concat({ ...JSON.parse(task.request_json), order: 0 }) } : snapshot;
  const intents = planFromSnapshot(frozenSnapshot, command.payload);
  if (intents.length > 100)
    throw new HttpError(409, 'NOTIFICATION_TOO_LARGE', 'Plan a smaller reviewed notification scope.');
  const records = await Promise.all(intents.map(async (intent) => ({ ...intent, noticeId: await hash(intent.key), payloadHash: await messageHash(intent), recipientCount: new Set([...intent.to, ...intent.cc]).size })));
  const serialized = JSON.stringify(records);
  if (new TextEncoder().encode(serialized).length > 1000000)
    throw new HttpError(409, 'NOTIFICATION_TOO_LARGE', 'The planned content exceeds the reviewed bound.');
  const now = new Date().toISOString();
  try {
    const result = await env.DB.batch<Record<string, unknown>>([
      statement(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql})
    AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=?
    AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?
    AND (SELECT COUNT(*) FROM notification_intents)+(SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS
     (SELECT 1 FROM notification_intents n WHERE n.notice_key=json_extract(j.value,'$.key')))
     <=COALESCE((SELECT max_ledger_entries FROM notification_delivery_control WHERE singleton=1),0)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM excusal_notification_tasks WHERE task_id=? AND state='pending' AND mode='suppressed' AND request_json=?)))`, command.commandId, ...auth.values, snapshot.revision.operations, snapshot.revision.administration, serialized, task?.task_id ?? null, task?.task_id ?? null, task?.request_json ?? null),
      statement(env.DB, `INSERT INTO command_registry VALUES(?,'admin')`, command.commandId),
      statement(env.DB, `INSERT INTO admin_commands VALUES(?,?,?,?,?,'notifications.manage','[]',?,?,?,?,?,?)`, command.commandId, digest, command.actor.principalId, command.operation, command.commandId, command.source.kind, command.source.resourceKey, command.source.submissionId, command.source.revision, now, '{}'),
      statement(env.DB, `INSERT INTO notification_intents(notice_id,notice_key,policy_version,kind,scope_id,local_date,environment,generation,mode,state,blocked_reason,
    to_json,cc_json,reply_to,subject,body,payload_hash,recipe_json,recipient_count,origin_command_id,created_at,updated_at)
    SELECT json_extract(value,'$.noticeId'),json_extract(value,'$.key'),json_extract(value,'$.policyVersion'),json_extract(value,'$.kind'),
     json_extract(value,'$.scopeId'),json_extract(value,'$.localDate'),?,?,'staging','suppressed',json_extract(value,'$.blockedReason'),
     json_extract(value,'$.to'),json_extract(value,'$.cc'),json_extract(value,'$.replyTo'),json_extract(value,'$.subject'),json_extract(value,'$.body'),
     json_extract(value,'$.payloadHash'),?,json_extract(value,'$.recipientCount'),?,?,? FROM json_each(?) WHERE true ON CONFLICT(notice_key) DO NOTHING`, env.ENVIRONMENT, Number(env.GENERATION), JSON.stringify(command.payload), command.commandId, now, now, serialized),
      statement(env.DB, `UPDATE admin_commands SET receipt_json=json_object('commandId',command_id,'status','committed','operation',operation,
    'result',json_object('planned',?,'created',(SELECT COUNT(*) FROM notification_intents WHERE origin_command_id=admin_commands.command_id),
     'suppressed',?,'missingRouting',?),'pendingEffects',json('false')) WHERE command_id=?`, intents.length, intents.length, intents.filter(intent => intent.blockedReason).length, command.commandId),
      statement(env.DB, `INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,'{}',?)`, command.commandId, command.actor.principalId, command.actor.evidence, command.operation, command.commandId, now, JSON.stringify({ recipe: command.payload, revision: snapshot.revision, planned: intents.length, mode: 'staging', delivery: 'suppressed' })),
      ...(task ? [statement(env.DB, "UPDATE excusal_notification_tasks SET state='done',completed_at=?,planning_command_id=? WHERE task_id=? AND state='pending'", now, command.commandId, task.task_id)] : []),
      statement(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', command.commandId),
      statement(env.DB, 'SELECT receipt_json AS receipt FROM admin_commands WHERE command_id=?', command.commandId),
    ]);
    return JSON.parse(String(result.at(-1)!.results[0].receipt));
  }
  catch {
    const retry = await statement(env.DB, `SELECT receipt_json AS receipt FROM admin_commands WHERE command_id=? AND payload_hash=? AND actor_id=? AND (${auth.sql})`, command.commandId, digest, command.actor.principalId, ...auth.values).first<{
      receipt: string;
    }>();
    if (retry)
      return JSON.parse(retry.receipt);
    throw new HttpError(409, 'NOTIFICATION_CONFLICT', 'Planning state, authority or ledger capacity changed. Review before retrying.');
  }
}
export async function notificationStatus(env: NotificationEnv, input: unknown): Promise<unknown> {
  const row = record(input, ['environment', 'generation', 'principalId']);
  if (row.environment !== env.ENVIRONMENT || row.generation !== Number(env.GENERATION))
    return invalid();
  const auth = authority(env, adminIdentifier(row.principalId), false);
  const result = await env.DB.batch<Record<string, unknown>>([
    statement(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values),
    statement(env.DB, 'SELECT state,COUNT(*) AS count FROM notification_intents GROUP BY state ORDER BY state'),
    statement(env.DB, `SELECT notice_id AS noticeId,kind,state,blocked_reason AS reason,created_at AS createdAt FROM notification_intents
   WHERE state IN ('blocked','uncertain','sending') OR blocked_reason IS NOT NULL ORDER BY created_at,notice_id LIMIT 51`),
    statement(env.DB, `SELECT state,COUNT(*) AS count FROM notification_attempts GROUP BY state ORDER BY state`),
    statement(env.DB, "SELECT task_id AS taskId FROM excusal_notification_tasks WHERE state='pending' ORDER BY created_at,task_id LIMIT 51"),
  ]);
  if (result[0].results[0]?.allowed !== 1)
    throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
  return { deliveryEnabled: false, states: result[1].results, attention: result[2].results.slice(0, 50), moreAttention: result[2].results.length > 50, attempts: result[3].results, pendingTasks: result[4].results.slice(0,50), moreTasks: result[4].results.length > 50 };
}
/** Each committed excusal version is frozen at acceptance; later decisions cannot erase its notice. */
export async function processNotificationTask(env: NotificationEnv, input: unknown): Promise<unknown> {
  const r = record(input, ['environment', 'generation', 'principalId', 'sourceKind', 'sourceResource', 'taskId']);
  if (r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION) || !['sheet', 'test'].includes(String(r.sourceKind))) return invalid();
  const principalId = adminIdentifier(r.principalId), taskId = adminIdentifier(r.taskId), resourceKey = adminIdentifier(r.sourceResource);
  const auth = authority(env, principalId);
  const allowed = await statement(env.DB, `SELECT (${auth.sql} AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)) AS allowed`, ...auth.values, String(r.sourceKind), resourceKey).first<{allowed: number}>();
  if (allowed?.allowed !== 1) throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority and source are required.');
  const task = await statement(env.DB, 'SELECT * FROM excusal_notification_tasks WHERE task_id=?', taskId).first<NotificationTask>();
  if (!task) throw new HttpError(404, 'NOT_FOUND', 'Notification task is unavailable.');
  if (task.state === 'done') return { taskId, state: 'done' };
  const commandId = 'notice-task-' + await hash(taskId);
  await planNotifications(env, { commandId, contractVersion: 1, environment: env.ENVIRONMENT, generation: Number(env.GENERATION),
    actor: { principalId, evidence: 'registered-automation' }, source: { kind: r.sourceKind, resourceKey, submissionId: taskId, revision: 1 },
    operation: 'notifications.plan', payload: { kind: 'excusal', asOf: task.created_at, requestId: task.request_id } }, task);
  return { taskId, state: 'done' };
}

export interface LocalNotificationTransport {
  send(message: {
    to: string[];
    cc: string[];
    replyTo?: string;
    subject: string;
    body: string;
  }): Promise<{
    outcome: 'confirmed';
    providerReference?: string;
  } | {
    outcome: 'known-not-sent';
  }>;
}
export interface DeliveryMessage { to: string[]; cc: string[]; replyTo?: string; subject: string; body: string }
export type DeliveryClaimResult = { attempted: false; reason?: string; state?: string } | {
  attempted: true; noticeId: string; attemptId: string; claimToken: string; expiresAt: string; message: DeliveryMessage; mode: 'local-test';
};
/** Persist the delivery attempt and immutable claim before exposing a message to a provider. */
export async function claimLocalNotification(env: NotificationEnv, input: {
  principalId: string;
  workerId: string;
  asOf: string;
  claimId: string;
}): Promise<DeliveryClaimResult> {
  if (env.ENVIRONMENT !== 'local')
    throw new HttpError(403, 'DELIVERY_SUPPRESSED', 'Staging delivery is permanently suppressed.');
  adminIdentifier(input.principalId);
  adminIdentifier(input.workerId);
  const now = instant(input.asOf);
  const clock = noticeLocalClock(now);
  const auth = authority(env, input.principalId);
  adminIdentifier(input.claimId);
  const oldClaim = await statement(env.DB, `SELECT c.principal_id AS principalId,c.worker_id AS workerId,c.claim_token AS claimToken,c.attempt_id AS attemptId,
    c.message_json AS message,a.notice_id AS noticeId,a.state,a.expires_at AS expiresAt FROM notification_delivery_claims c JOIN notification_attempts a USING(attempt_id)
    WHERE c.claim_id=? AND (${auth.sql})`, input.claimId, ...auth.values).first<Record<string, unknown>>();
  if (oldClaim) {
    if (oldClaim.principalId !== input.principalId || oldClaim.workerId !== input.workerId) throw new HttpError(409, 'CLAIM_CONFLICT', 'This delivery claim belongs to another consumer.');
    if (oldClaim.state !== 'sending') return { attempted: false, state: String(oldClaim.state) };
    if (String(oldClaim.expiresAt) <= now) { await recoverLocalNotificationAttempts(env, now); return { attempted: false, state: 'uncertain' }; }
    return { attempted: true, noticeId: String(oldClaim.noticeId), attemptId: String(oldClaim.attemptId), claimToken: String(oldClaim.claimToken), expiresAt: String(oldClaim.expiresAt), message: JSON.parse(String(oldClaim.message)), mode: 'local-test' };
  }
  const candidate = await statement(env.DB, `SELECT notice_id AS noticeId,notice_key AS noticeKey,recipe_json AS recipe,payload_hash AS payloadHash,recipient_count AS recipientCount
  FROM notification_intents WHERE environment='local' AND generation=? AND mode='local-test' AND state='queued' AND (${auth.sql})
  AND EXISTS(SELECT 1 FROM notification_delivery_control WHERE singleton=1 AND mode='local-test') ORDER BY created_at,notice_id LIMIT 1`, Number(env.GENERATION), ...auth.values).first<{
    noticeId: string;
    noticeKey: string;
    recipe: string;
    payloadHash: string;
    recipientCount: number;
  }>();
  if (!candidate)
    return { attempted: false };
  const snapshot = await frontendSnapshot(env, { environment: 'local', generation: Number(env.GENERATION), principalId: input.principalId });
  const intent = planFromSnapshot(snapshot, JSON.parse(candidate.recipe) as PlanCommand['payload']).find(item => item.key === candidate.noticeKey);
  if (!intent || await messageHash(intent) !== candidate.payloadHash || !intent.to.length) {
    await env.DB.batch([
      statement(env.DB, `INSERT INTO notification_delivery_events(notice_id,action,principal_id,accepted_at,previous_state,state)
    SELECT notice_id,'routing-or-content-changed',?,?,'queued','blocked' FROM notification_intents
    WHERE notice_id=? AND state='queued' AND (${auth.sql})`, input.principalId, now, candidate.noticeId, ...auth.values),
      statement(env.DB, `UPDATE notification_intents SET state='blocked',blocked_reason='routing-or-content-changed',updated_at=?
    WHERE notice_id=? AND state='queued' AND (${auth.sql})`, now, candidate.noticeId, ...auth.values),
    ]);
    return { attempted: false, reason: 'routing-or-content-changed' };
  }
  if ([...intent.to, ...intent.cc, ...(intent.replyTo ? [intent.replyTo] : [])].some(address => !address.endsWith('.invalid')))
    throw new HttpError(409, 'LOCAL_TEST_RECIPIENT_REQUIRED', 'Local transport rehearsals require fictional recipients.');
  const attemptId = crypto.randomUUID(), claimToken = crypto.randomUUID();
  const message = { to: intent.to, cc: intent.cc, ...(intent.replyTo ? { replyTo: intent.replyTo } : {}), subject: intent.subject, body: intent.body };
  const expiresAt = new Date(Date.parse(now) + 600000).toISOString();
  try {
    await env.DB.batch([
      statement(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND
    EXISTS(SELECT 1 FROM notification_intents WHERE notice_id=? AND state='queued' AND mode='local-test') AND
    (SELECT COALESCE(SUM(recipient_count),0) FROM notification_attempts WHERE local_date=?)+?
     <=COALESCE((SELECT daily_recipient_budget FROM notification_delivery_control WHERE singleton=1 AND mode='local-test'),0)
    AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=?
    AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?)`, attemptId, ...auth.values, candidate.noticeId, clock.date, candidate.recipientCount, snapshot.revision.operations, snapshot.revision.administration),
      statement(env.DB, `UPDATE notification_intents SET state='sending',updated_at=? WHERE notice_id=?`, now, candidate.noticeId),
      statement(env.DB, `INSERT INTO notification_attempts VALUES(?,?,?,?,?,?,'sending',?,?,NULL,NULL,NULL)`, attemptId, candidate.noticeId, input.principalId, input.workerId, clock.date, candidate.recipientCount, now, expiresAt),
      statement(env.DB, `INSERT INTO notification_delivery_events(notice_id,attempt_id,action,principal_id,accepted_at,previous_state,state) VALUES(?,?,'claim',?,?,'queued','sending')`, candidate.noticeId, attemptId, input.principalId, now),
      statement(env.DB, 'INSERT INTO notification_delivery_claims VALUES(?,?,?,?,?,?,NULL,NULL)', input.claimId, attemptId, input.principalId, input.workerId, claimToken, JSON.stringify(message)),
      statement(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', attemptId),
    ]);
  }
  catch {
    const quotaGuard = `state='queued' AND notice_id=? AND (${auth.sql}) AND
   (SELECT COALESCE(SUM(recipient_count),0) FROM notification_attempts WHERE local_date=?)+recipient_count
    >COALESCE((SELECT daily_recipient_budget FROM notification_delivery_control WHERE singleton=1 AND mode='local-test'),0)`;
    const parameters = [candidate.noticeId, ...auth.values, clock.date];
    const blocked = await env.DB.batch<Record<string, unknown>>([
      statement(env.DB, `INSERT INTO notification_delivery_events(notice_id,action,principal_id,accepted_at,previous_state,state)
    SELECT notice_id,'quota-exhausted',?,?,'queued','blocked' FROM notification_intents WHERE ${quotaGuard}`, input.principalId, now, ...parameters),
      statement(env.DB, `UPDATE notification_intents SET state='blocked',blocked_reason='quota-exhausted',updated_at=? WHERE ${quotaGuard} RETURNING notice_id`, now, ...parameters),
    ]);
    return { attempted: false, reason: blocked[1].results.length ? 'quota-exhausted' : 'authority-version-or-budget-conflict' };
  }
  return { attempted: true, noticeId: candidate.noticeId, attemptId, claimToken, expiresAt, message, mode: 'local-test' };
}
/** An acknowledgement never requeues an expired/uncertain attempt, including a late success. */
export async function completeLocalNotification(env: NotificationEnv, input: {
  principalId: string; workerId: string; attemptId: string; claimToken: string; asOf: string;
  outcome: 'confirmed' | 'known-not-sent' | 'lost-result'; providerReference: string | null;
}): Promise<unknown> {
  if (env.ENVIRONMENT !== 'local') throw new HttpError(403, 'DELIVERY_SUPPRESSED', 'Staging delivery is permanently suppressed.');
  for (const value of [input.principalId, input.workerId, input.attemptId, input.claimToken]) adminIdentifier(value);
  if (!['confirmed', 'known-not-sent', 'lost-result'].includes(input.outcome)
    || input.providerReference !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.providerReference)) return invalid();
  const now = instant(input.asOf), auth = authority(env, input.principalId, false);
  const digest = await hash(JSON.stringify({ outcome: input.outcome, providerReference: input.providerReference }));
  const claim = await statement(env.DB, `SELECT c.completion_hash AS completionHash,c.receipt_json AS receipt,a.notice_id AS noticeId,a.state,a.expires_at AS expiresAt
    FROM notification_delivery_claims c JOIN notification_attempts a USING(attempt_id)
    WHERE c.attempt_id=? AND c.claim_token=? AND c.principal_id=? AND c.worker_id=? AND (${auth.sql})`, input.attemptId, input.claimToken, input.principalId, input.workerId, ...auth.values).first<Record<string, unknown>>();
  if (!claim) throw new HttpError(403, 'NOT_AUTHORIZED', 'Current authority and the original delivery claim are required.');
  if (claim.receipt) {
    if (claim.completionHash !== digest) throw new HttpError(409, 'DELIVERY_RESULT_CONFLICT', 'A different delivery result was already recorded.');
    return JSON.parse(String(claim.receipt));
  }
  if (String(claim.expiresAt) <= now) await recoverLocalNotificationAttempts(env, now);
  const outcome = input.outcome, state = advanceDelivery('sending', outcome), attemptState = outcome === 'known-not-sent' ? 'known-not-sent' : state;
  try {
    const result = await env.DB.batch<Record<string, unknown>>([
      statement(env.DB, `INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND EXISTS(SELECT 1 FROM notification_delivery_claims
        WHERE attempt_id=? AND claim_token=? AND completion_hash IS NULL))`, input.claimToken, ...auth.values, input.attemptId, input.claimToken),
      statement(env.DB, `INSERT INTO notification_delivery_events(notice_id,attempt_id,action,principal_id,accepted_at,previous_state,state)
        SELECT notice_id,attempt_id,?,?,?,'sending',? FROM notification_attempts WHERE attempt_id=? AND state='sending'`, outcome, input.principalId, now, state, input.attemptId),
      statement(env.DB, `UPDATE notification_attempts SET state=?,finished_at=?,provider_reference=?,result_code=? WHERE attempt_id=? AND state='sending'`, attemptState, now, input.providerReference, outcome, input.attemptId),
      statement(env.DB, `UPDATE notification_intents SET state=?,updated_at=? WHERE notice_id=? AND state='sending'
        AND EXISTS(SELECT 1 FROM notification_attempts WHERE attempt_id=? AND result_code=?)`, state, now, String(claim.noticeId), input.attemptId, outcome),
      statement(env.DB, `UPDATE notification_delivery_claims SET completion_hash=?,receipt_json=(SELECT json_object('attempted',json('true'),'noticeId',notice_id,
        'attemptId',?,'state',state) FROM notification_intents WHERE notice_id=?) WHERE attempt_id=?`, digest, input.attemptId, String(claim.noticeId), input.attemptId),
      statement(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', input.claimToken),
      statement(env.DB, 'SELECT receipt_json AS receipt FROM notification_delivery_claims WHERE attempt_id=?', input.attemptId),
    ]);
    return JSON.parse(String(result.at(-1)!.results[0].receipt));
  } catch {
    const completed = await statement(env.DB, `SELECT receipt_json AS receipt FROM notification_delivery_claims
      WHERE attempt_id=? AND claim_token=? AND principal_id=? AND worker_id=? AND completion_hash=? AND (${auth.sql})`, input.attemptId, input.claimToken, input.principalId, input.workerId, digest, ...auth.values).first<{receipt: string}>();
    if (completed?.receipt) return JSON.parse(completed.receipt);
    throw new HttpError(409, 'DELIVERY_RESULT_CONFLICT', 'The delivery result or its authority changed. Reconcile the saved attempt.');
  }
}
/** A local-only composition retained for the in-process transport rehearsal. */
export async function deliverLocalNotification(env: NotificationEnv, input: { principalId: string; workerId: string; asOf: string }, transport: LocalNotificationTransport): Promise<unknown> {
  const claim = await claimLocalNotification(env, { ...input, claimId: crypto.randomUUID() });
  if (!claim.attempted) return claim;
  let outcome: 'confirmed' | 'known-not-sent' | 'lost-result' = 'lost-result', providerReference: string | null = null;
  try {
    const result = await transport.send(claim.message);
    if (result.outcome === 'confirmed' && (result.providerReference === undefined || /^[A-Za-z0-9_.:-]{1,128}$/.test(result.providerReference))) {
      outcome = 'confirmed'; providerReference = result.providerReference ?? null;
    } else if (result.outcome === 'known-not-sent') outcome = 'known-not-sent';
  } catch { /* A thrown provider call is uncertain, never proof of no send. */ }
  return completeLocalNotification(env, { ...input, attemptId: claim.attemptId, claimToken: claim.claimToken, outcome, providerReference });
}
/** No caller can enable staging delivery or provide recipients through this protocol. */
export async function notificationDelivery(env: NotificationEnv, action: 'claim' | 'complete' | 'recover', input: unknown): Promise<unknown> {
  const keys = ['environment', 'generation', 'principalId', 'workerId'];
  const r = record(input, [...keys, ...(action === 'claim' ? ['claimId'] : action === 'complete' ? ['attemptId', 'claimToken', 'outcome', 'providerReference'] : [])]);
  if (r.environment !== env.ENVIRONMENT || r.generation !== Number(env.GENERATION)) return invalid();
  const principalId = adminIdentifier(r.principalId), workerId = adminIdentifier(r.workerId), asOf = new Date().toISOString();
  const auth = authority(env, principalId, false);
  if ((await statement(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{allowed: number}>())?.allowed !== 1) throw new HttpError(403, 'NOT_AUTHORIZED', 'Current notification authority is required.');
  if (env.ENVIRONMENT !== 'local') return { attempted: false, deliveryEnabled: false, reason: 'staging-suppressed' };
  if (action === 'claim') return claimLocalNotification(env, { principalId, workerId, asOf, claimId: adminIdentifier(r.claimId) });
  if (action === 'complete') return completeLocalNotification(env, { principalId, workerId, asOf, attemptId: adminIdentifier(r.attemptId), claimToken: adminIdentifier(r.claimToken), outcome: r.outcome as 'confirmed' | 'known-not-sent' | 'lost-result', providerReference: r.providerReference as string | null });
  await recoverLocalNotificationAttempts(env, asOf); return { recovered: true };
}
/** A crashed local attempt is terminal uncertain. It is never reclaimed as queued. */
export async function recoverLocalNotificationAttempts(env: NotificationEnv, asOf: string): Promise<void> {
  if (env.ENVIRONMENT !== 'local')
    throw new HttpError(403, 'DELIVERY_SUPPRESSED', 'Staging delivery is permanently suppressed.');
  const now = instant(asOf);
  await env.DB.batch([
    statement(env.DB, `INSERT INTO notification_delivery_events(notice_id,attempt_id,action,principal_id,accepted_at,previous_state,state)
   SELECT notice_id,attempt_id,'expired-result',principal_id,?,'sending','uncertain' FROM notification_attempts WHERE state='sending' AND expires_at<=?`, now, now),
    statement(env.DB, `UPDATE notification_intents SET state='uncertain',updated_at=? WHERE state='sending' AND notice_id IN
   (SELECT notice_id FROM notification_attempts WHERE state='sending' AND expires_at<=?)`, now, now),
    statement(env.DB, `UPDATE notification_attempts SET state='uncertain',finished_at=?,result_code='expired-result' WHERE state='sending' AND expires_at<=?`, now, now),
  ]);
}
