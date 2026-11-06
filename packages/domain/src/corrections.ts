import { ATTENDANCE_CODES, DomainError, type ActorEvidence, type AttendanceCode, type CommandSource, type Environment } from './index.js';
import { adminIdentifier } from './admin.js';

export interface AttendanceCorrectionCommand {
  commandId: string;
  contractVersion: 1;
  environment: Environment;
  generation: number;
  actor: ActorEvidence;
  source: CommandSource;
  operation: 'attendance.correct';
  payload: {
    personId: string;
    eventId: string;
    /** Server-issued causal revision for this pair, not a local edit counter. */
    expectedBaseVersion: number;
    /** The exact event/roster version shown when the edit began. */
    expectedEventVersion: number;
    code: AttendanceCode | null;
    reason: string;
  };
}
function invalid(path: string, message: string): never {
  throw new DomainError('INVALID_COMMAND', message, path);
}
function record(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'Expected a plain object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) {
    invalid(path, 'Required fields are missing or unsupported fields were supplied.');
  }
  return result;
}
function version(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(path, 'Expected a valid version.');
  return value;
}
export function parseAttendanceCorrection(input: unknown): AttendanceCorrectionCommand {
  const command = record(input, 'command', ['commandId', 'contractVersion', 'environment', 'generation', 'actor', 'source', 'operation', 'payload']);
  const actor = record(command.actor, 'actor', ['principalId', 'evidence']);
  const source = record(command.source, 'source', ['kind', 'resourceKey', 'submissionId', 'revision']);
  const payload = record(command.payload, 'payload', ['personId', 'eventId', 'expectedBaseVersion', 'expectedEventVersion', 'code', 'reason']);
  if (command.contractVersion !== 1 || command.operation !== 'attendance.correct') invalid('operation', 'Unsupported correction contract.');
  if (command.environment !== 'local' && command.environment !== 'staging') invalid('environment', 'Unsupported environment.');
  if (source.kind !== 'sheet' && source.kind !== 'test') invalid('source.kind', 'A registered sheet or test source is required.');
  if (actor.evidence !== 'authenticated-confirmation' && !(actor.evidence === 'google-edit' && source.kind === 'sheet')) {
    invalid('actor.evidence', 'Verified editor identity or authenticated confirmation is required.');
  }
  if (payload.code !== null && !ATTENDANCE_CODES.includes(payload.code as AttendanceCode)) invalid('payload.code', 'Unsupported attendance code.');
  if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason !== payload.reason.trim()
    || payload.reason.length > 4000 || /[\u0000-\u001f\u007f]/.test(payload.reason)) invalid('payload.reason', 'A bounded correction reason is required.');
  return {
    commandId: adminIdentifier(command.commandId, 'commandId'), contractVersion: 1,
    environment: command.environment, generation: version(command.generation, 'generation', 1),
    actor: { principalId: adminIdentifier(actor.principalId, 'actor.principalId'), evidence: actor.evidence },
    source: { kind: source.kind, resourceKey: adminIdentifier(source.resourceKey, 'source.resourceKey'),
      submissionId: adminIdentifier(source.submissionId, 'source.submissionId'), revision: version(source.revision, 'source.revision', 1) },
    operation: 'attendance.correct', payload: {
      personId: adminIdentifier(payload.personId, 'payload.personId'), eventId: adminIdentifier(payload.eventId, 'payload.eventId'),
      expectedBaseVersion: version(payload.expectedBaseVersion, 'payload.expectedBaseVersion'),
      expectedEventVersion: version(payload.expectedEventVersion, 'payload.expectedEventVersion', 1),
      code: payload.code as AttendanceCode | null, reason: payload.reason,
    },
  };
}
