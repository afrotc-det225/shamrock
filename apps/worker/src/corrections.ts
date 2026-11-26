import { effectiveAdminGrants } from './permission-grants.js';
import { parseAttendanceCorrection, type AttendanceCorrectionCommand } from '../../../packages/domain/src/corrections.js';
import { HttpError } from './http-error.js';
import { isDailyD1Limit } from './provider-errors.js';
import type { CommandScopeGuard } from './command-scope.js';

interface CorrectionEnv { DB: D1Database; ENVIRONMENT: string; GENERATION: string }
type Value = string | number | null;
const statement = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

// Incremental imports advance the administration stream. The original capture is revision zero.
export const baselineRevisionSql = `CASE WHEN json_extract(i.manifest_json,'$.kind')='reviewed-incremental-staging-refresh'
  THEN json_extract(i.manifest_json,'$.administrationRevision')+1 ELSE 0 END`;
function pairBaselineRevision(event: string, person: string) {
  return `COALESCE((SELECT ${baselineRevisionSql} FROM legacy_attendance_baselines b
    JOIN legacy_import_runs i ON i.import_run_id=b.import_run_id AND i.state='complete'
    WHERE b.event_id=${event} AND b.person_id=${person}),0)`;
}
export const receiptBaselineRevisionSql = pairBaselineRevision('operation_commands.event_id', 'operation_commands.target_person_id');

/** The reviewed baseline revision plus the newest independent operational audit for this pair. */
export const pairRevisionSql = `SELECT ${pairBaselineRevision('t.eventId','t.personId')} + COALESCE((SELECT MAX(revision) FROM (
  SELECT MAX(a.audit_id) AS revision FROM attendance_observations o
    JOIN attendance_reports r ON r.report_id=o.report_id JOIN audit_events a ON a.command_id=r.command_id
    WHERE o.event_id=t.eventId AND o.person_id=t.personId
  UNION ALL SELECT MAX(a.audit_id) FROM excusal_records r JOIN audit_events a ON a.command_id=r.last_command_id
    WHERE r.event_id=t.eventId AND r.person_id=t.personId
  UNION ALL SELECT MAX(a.audit_id) FROM attendance_corrections c JOIN audit_events a ON a.command_id=c.command_id
    WHERE c.event_id=t.eventId AND c.person_id=t.personId
)),0) FROM (SELECT ? AS eventId,? AS personId) t`;
export const attendanceVersionsSql = `SELECT personId,eventId,MAX(operationalRevision)+MAX(baselineRevision) AS version FROM (
  SELECT o.person_id AS personId,o.event_id AS eventId,a.audit_id AS operationalRevision,0 AS baselineRevision FROM attendance_observations o
    JOIN attendance_reports r ON r.report_id=o.report_id JOIN audit_events a ON a.command_id=r.command_id
  UNION ALL SELECT r.person_id,r.event_id,COALESCE(a.audit_id,0),0 FROM excusal_records r LEFT JOIN audit_events a ON a.command_id=r.last_command_id WHERE r.origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions l WHERE l.adoption_id=r.legacy_adoption_id AND l.state='complete')
  UNION ALL SELECT c.person_id,c.event_id,a.audit_id,0 FROM attendance_corrections c JOIN audit_events a ON a.command_id=c.command_id
  UNION ALL SELECT b.person_id,b.event_id,0,${baselineRevisionSql} FROM legacy_attendance_baselines b JOIN legacy_import_runs i ON i.import_run_id=b.import_run_id AND i.state='complete'
) GROUP BY personId,eventId ORDER BY personId,eventId LIMIT 25001`;
function authorization(env: CorrectionEnv, command: AttendanceCorrectionCommand, flightId: string, scope?: CommandScopeGuard) {
  return {
    sql: `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)
      AND EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND active=1)
      AND EXISTS(SELECT 1 FROM ${effectiveAdminGrants} WHERE principal_id=? AND capability='attendance.correct'
        AND ((scope_kind='wing' AND scope_key='*') OR (scope_kind='flight' AND scope_key=?)))
      AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)${scope ? ` AND (${scope.sql})` : ''}`,
    values: [env.ENVIRONMENT, Number(env.GENERATION), command.actor.principalId, command.actor.principalId,
      flightId, command.source.kind, command.source.resourceKey, ...(scope?.values ?? [])],
  };
}
interface CorrectionReceipt {
  commandId: string;
  status: 'committed';
  operation: 'attendance.correct';
  result: { personId: string; eventId: string; version: number; code: string | null };
  pendingEffects: true;
}
async function previousReceipt(env: CorrectionEnv, command: AttendanceCorrectionCommand, hash: string, scope?: CommandScopeGuard): Promise<CorrectionReceipt | null> {
  // The stored original scope and current permission are evaluated in the same SQL read.
  const row = await statement(env.DB, `SELECT c.payload_hash AS hash,c.receipt_json AS receipt,c.operation,c.actor_id AS actorId,
    (EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)
    AND EXISTS(SELECT 1 FROM principals p WHERE p.principal_id=c.actor_id AND p.active=1)
    AND EXISTS(SELECT 1 FROM ${effectiveAdminGrants} g WHERE g.principal_id=c.actor_id AND g.capability='attendance.correct'
      AND ((g.scope_kind='wing' AND g.scope_key='*') OR (g.scope_kind='flight' AND g.scope_key=c.unit_id)))
    AND EXISTS(SELECT 1 FROM adapter_sources s WHERE s.source_kind=c.source_kind AND s.resource_key=c.source_resource AND s.active=1)${scope ? ` AND (${scope.sql})` : ''}) AS allowed
    FROM operation_commands c WHERE c.command_id=?`, env.ENVIRONMENT, Number(env.GENERATION), ...(scope?.values ?? []), command.commandId)
    .first<{ hash: string; receipt: string; operation: string; actorId: string; allowed: number }>();
  if (!row) return null;
  if (row.operation !== 'attendance.correct') throw new HttpError(409, 'COMMAND_ID_CONFLICT', 'This command ID was already used.');
  if (row.actorId !== command.actor.principalId || row.allowed !== 1) throw new HttpError(403, 'NOT_AUTHORIZED', 'The correction authority is no longer current.');
  if (row.hash !== hash) throw new HttpError(409, 'COMMAND_ID_CONFLICT', 'This command ID was already used for different input.');
  return JSON.parse(row.receipt) as CorrectionReceipt;
}
export async function acceptAttendanceCorrection(env: CorrectionEnv, input: unknown, scope?: CommandScopeGuard): Promise<CorrectionReceipt> {
  const command = parseAttendanceCorrection(input);
  if (command.environment !== env.ENVIRONMENT || command.generation !== Number(env.GENERATION)) {
    throw new HttpError(409, 'WRONG_GENERATION', 'Reload the current environment before submitting.');
  }
  const hash = await digest(JSON.stringify(command));
  const previous = await previousReceipt(env, command, hash, scope);
  if (previous) return previous;
  const payload = command.payload;
  const roster = await statement(env.DB, `SELECT m.flight_id AS flightId,d.version AS eventVersion
    FROM event_details d JOIN event_roster_members m ON m.event_id=d.event_id AND m.version=d.version
    WHERE d.event_id=? AND m.person_id=?`, payload.eventId, payload.personId).first<{ flightId: string; eventVersion: number }>();
  if (!roster) throw new HttpError(409, 'ROSTER_UNAVAILABLE', 'An explicit event roster is required before correcting this attendance cell.');
  const auth = authorization(env, command, roster.flightId, scope);
  const allowed = await statement(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{ allowed: number }>();
  if (allowed?.allowed !== 1) throw new HttpError(403, 'NOT_AUTHORIZED', 'The actor, source or correction is not currently authorized.');
  const now = new Date().toISOString();
  const correctionId = crypto.randomUUID();
  const source = command.source;
  // Receipt JSON is filled after audit_id is allocated, within the same atomic batch.
  try {
    const results = await env.DB.batch<Record<string, unknown>>([
      statement(env.DB, `INSERT INTO command_assertions(command_id,ok) VALUES(?,(${auth.sql})
        AND (${pairRevisionSql})=?
        AND EXISTS(SELECT 1 FROM event_details d JOIN event_roster_members m ON m.event_id=d.event_id AND m.version=d.version
          WHERE d.event_id=? AND d.version=? AND m.person_id=? AND m.flight_id=?
          AND (d.status='active' OR EXISTS(SELECT 1 FROM terms t WHERE t.term_id=d.term_id AND t.is_current=0))
          AND NOT EXISTS(SELECT 1 FROM event_roster_refresh_work w WHERE w.event_id=d.event_id))
        AND NOT EXISTS(SELECT 1 FROM admin_commands WHERE command_id=?))`,
      command.commandId, ...auth.values,
      payload.eventId, payload.personId, payload.expectedBaseVersion, payload.eventId, payload.expectedEventVersion,
      payload.personId, roster.flightId, command.commandId),
      statement(env.DB, `INSERT INTO command_registry VALUES(?,'operation')`, command.commandId),
      statement(env.DB, `INSERT INTO operation_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, command.commandId, hash,
        command.actor.principalId, command.operation, roster.flightId, payload.eventId, payload.personId,
        source.kind, source.resourceKey, source.submissionId, source.revision, now, '{}'),
      statement(env.DB, `INSERT INTO command_event_scopes VALUES(?,?,?)`, command.commandId, payload.eventId, roster.flightId),
      statement(env.DB, `INSERT INTO attendance_corrections VALUES(?,?,?,?,?,?,?,?,?)`, correctionId, command.commandId,
        payload.eventId, payload.personId, payload.code, payload.reason, payload.expectedBaseVersion, payload.expectedEventVersion, now),
      statement(env.DB, `INSERT INTO audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,metadata_json) VALUES(?,?,?,?,?,?,?)`,
        command.commandId, command.actor.principalId, command.actor.evidence, command.operation, correctionId, now, JSON.stringify(payload)),
      statement(env.DB, `UPDATE operation_commands SET receipt_json=json_object('commandId',command_id,'status','committed',
        'operation',operation,'result',json_object('personId',target_person_id,'eventId',event_id,
          'version',${receiptBaselineRevisionSql}+(SELECT audit_id FROM audit_events WHERE command_id=operation_commands.command_id),'code',?),
        'pendingEffects',json('true')) WHERE command_id=?`, payload.code, command.commandId),
      statement(env.DB, `INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,'frontend.refresh','pending',?)`,
        crypto.randomUUID(), command.commandId, now),
      statement(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', command.commandId),
      statement(env.DB, 'SELECT receipt_json AS receipt FROM operation_commands WHERE command_id=?', command.commandId),
    ]);
    return JSON.parse(String(results.at(-1)!.results[0].receipt)) as CorrectionReceipt;
  } catch (error) {
    if (isDailyD1Limit(error)) throw error;
    const raced = await previousReceipt(env, command, hash, scope);
    if (raced) return raced;
    if (/command_preconditions|UNIQUE constraint failed/i.test(String(error))) {
      throw new HttpError(409, 'CORRECTION_CONFLICT', 'Attendance, event roster or authority changed. Reload and review this correction.');
    }
    // Let the adapter keep the original command retryable on an infrastructure failure.
    throw error;
  }
}

export async function correctionReceipt(env: CorrectionEnv, commandId: string, principalId: string): Promise<CorrectionReceipt | null> {
  const row = await statement(env.DB, `SELECT c.receipt_json AS receipt FROM operation_commands c
    JOIN principals p ON p.principal_id=c.actor_id
    WHERE c.command_id=? AND c.operation='attendance.correct' AND c.actor_id=? AND p.active=1
    AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)
    AND EXISTS(SELECT 1 FROM ${effectiveAdminGrants} g WHERE g.principal_id=c.actor_id AND g.capability='attendance.correct'
      AND ((g.scope_kind='wing' AND g.scope_key='*') OR (g.scope_kind='flight' AND g.scope_key=c.unit_id)))
    AND EXISTS(SELECT 1 FROM adapter_sources s WHERE s.source_kind=c.source_kind AND s.resource_key=c.source_resource AND s.active=1)`,
    commandId, principalId, env.ENVIRONMENT, Number(env.GENERATION)).first<{ receipt: string }>();
  return row ? JSON.parse(row.receipt) as CorrectionReceipt : null;
}
