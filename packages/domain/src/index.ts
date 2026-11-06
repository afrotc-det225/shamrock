/**
 * Policy-neutral contracts for the isolated D1 prototype.
 *
 * This package records evidence and adjudication separately. It deliberately
 * does not infer absences, calculate credit, or turn a denied request into U.
 * Authentication, database identity checks and permission checks belong to the
 * application boundary, not to these deterministic functions.
 */

export const ATTENDANCE_CODES = ['P', 'T', 'A', 'U', 'E', 'ES', 'MED', 'R', 'D', 'N/A'] as const;
export type AttendanceCode = typeof ATTENDANCE_CODES[number];
export const REQUESTED_OUTCOMES = ['P', 'T', 'E', 'ES', 'MED'] as const;
export type RequestedOutcome = typeof REQUESTED_OUTCOMES[number];
export const EXCUSAL_DECISIONS = ['Approved', 'Denied', 'Withdrawn', 'Superseded'] as const;
export type ExcusalDecision = typeof EXCUSAL_DECISIONS[number];
export type ExcusalStatus = 'Submitted' | ExcusalDecision;
export type Environment = 'local' | 'staging';

export interface ActorEvidence {
  principalId: string;
  evidence: 'google-form' | 'google-edit' | 'authenticated-confirmation';
}

export interface CommandSource {
  kind: 'form' | 'sheet' | 'test';
  /** Logical configured resource; never accept an arbitrary spreadsheet as trusted. */
  resourceKey: string;
  submissionId: string;
  revision: number;
}

interface CommandEnvelope {
  commandId: string;
  contractVersion: 1;
  environment: Environment;
  generation: number;
  actor: ActorEvidence;
  source: CommandSource;
}

export interface AttendanceReportPayload {
  reportId: string;
  eventId: string;
  expectedEventVersion?: number;
  unitId: string;
  rosterVersion: number;
  coveredPersonIds: string[];
  presentPersonIds: string[];
  completeness: 'partial' | 'complete';
}

export interface ExcusalSubmitPayload {
  requestId: string;
  eventId: string;
  expectedEventVersion?: number;
  personId: string;
  requestedOutcome: RequestedOutcome;
  reason: string;
}

export const MAX_EXCUSAL_EVENTS = 25;
export interface ExcusalSubmitManyPayload {
  personId: string;
  requestedOutcome: RequestedOutcome;
  reason: string;
  /** Child identities are stable per native response and event, never selection order. */
  events: { eventId: string; requestId: string; expectedEventVersion?: number }[];
}

export interface ExcusalDecidePayload {
  requestId: string;
  expectedVersion: number;
  decision: ExcusalDecision;
  reason: string;
}

export interface AttendanceReportCommand extends CommandEnvelope {
  operation: 'attendance.report';
  payload: AttendanceReportPayload;
}

export interface ExcusalSubmitCommand extends CommandEnvelope {
  operation: 'excusal.submit';
  payload: ExcusalSubmitPayload;
}

export interface ExcusalDecideCommand extends CommandEnvelope {
  operation: 'excusal.decide';
  payload: ExcusalDecidePayload;
}

export interface ExcusalSubmitManyCommand extends CommandEnvelope {
  operation: 'excusal.submitMany';
  payload: ExcusalSubmitManyPayload;
}

export type Command = AttendanceReportCommand | ExcusalSubmitCommand | ExcusalSubmitManyCommand | ExcusalDecideCommand;

export interface AttendanceObservation {
  personId: string;
  eventId: string;
  reportId: string;
  code: 'P';
}

export interface AttendanceReport extends AttendanceReportPayload {
  submittedAt: string;
  submittedBy: string;
  source: CommandSource;
  commandId: string;
  observations: AttendanceObservation[];
}

export interface ExcusalRequest extends ExcusalSubmitPayload {
  status: ExcusalStatus;
  decision: ExcusalDecision | null;
  version: number;
  submittedAt: string;
  submittedBy: string | null;
  updatedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  source: CommandSource | { kind: 'legacy-import'; resourceKey:string; submissionId:string; revision:1; humanIdentityVerified:false };
  commandId: string | null;
  lastCommandId: string | null;
}

export interface AttendanceView {
  /** The observation is never rewritten by an excusal request or decision. */
  observedCode: AttendanceCode | null;
  requestStatus: ExcusalStatus | null;
  requestedOutcome: RequestedOutcome | null;
  approvedOutcome: RequestedOutcome | null;
  requestVersion: number | null;
}

export class DomainError extends Error {
  constructor(
    public readonly code: 'INVALID_COMMAND' | 'VERSION_CONFLICT',
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function invalid(path: string, message: string): never {
  // Field paths and safe fixed messages only; never echo private input values.
  throw new DomainError('INVALID_COMMAND', message, path);
}

function object(value: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'Expected an object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'Expected a plain object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid(path, 'Unsupported field.');
  for (const key of keys) {
    if (!optional.includes(key) && !Object.prototype.hasOwnProperty.call(record, key)) invalid(`${path}.${key}`, 'Required field is missing.');
  }
  return record;
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    invalid(path, 'Expected a stable identifier of at most 128 characters.');
  }
  return value;
}

function sourceId(value: unknown, path: string): string {
  // Native response identifiers are opaque and can be longer than our entity
  // identifiers. Bound transport input without silently truncating provenance.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(value)) {
    invalid(path, 'Expected a source identifier of at most 512 characters.');
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(path, 'Expected a positive safe integer.');
  }
  return value;
}

function choice<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(path, 'Unsupported value.');
  return value as T;
}

function reason(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4000 || value.includes('\u0000')) {
    invalid(path, 'Expected a nonempty reason of at most 4000 characters.');
  }
  return value;
}

function identifiers(value: unknown, path: string, minimum: number): string[] {
  // Intentionally bounded for this interactive prototype. Larger workflows must
  // use explicit chunking rather than silently truncating a roster.
  if (!Array.isArray(value) || value.length < minimum || value.length > 500) {
    invalid(path, 'Expected a bounded list of up to 500 identifiers.');
  }
  const values = value.map((entry, index) => id(entry, `${path}[${index}]`));
  if (new Set(values).size !== values.length) invalid(path, 'Duplicate identifiers are not allowed.');
  return values;
}

function acceptedTime(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    invalid('acceptedAt', 'Expected a UTC timestamp.');
  }
  const parsed = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) invalid('acceptedAt', 'Expected a valid UTC timestamp.');
  return canonical;
}

/** Strict runtime validation also copies nested input so callers cannot rebind a draft. */
export function parseCommand(input: unknown): Command {
  const raw = object(input, 'command', [
    'commandId', 'contractVersion', 'environment', 'generation', 'actor', 'source', 'operation', 'payload',
  ]);
  if (raw.contractVersion !== 1) invalid('command.contractVersion', 'Unsupported contract version.');
  const actor = object(raw.actor, 'command.actor', ['principalId', 'evidence']);
  const source = object(raw.source, 'command.source', ['kind', 'resourceKey', 'submissionId', 'revision']);
  const envelope: CommandEnvelope = {
    commandId: id(raw.commandId, 'command.commandId'),
    contractVersion: 1,
    environment: choice(raw.environment, 'command.environment', ['local', 'staging']),
    generation: positiveInteger(raw.generation, 'command.generation'),
    actor: {
      principalId: id(actor.principalId, 'command.actor.principalId'),
      evidence: choice(actor.evidence, 'command.actor.evidence', ['google-form', 'google-edit', 'authenticated-confirmation']),
    },
    source: {
      kind: choice(source.kind, 'command.source.kind', ['form', 'sheet', 'test']),
      resourceKey: id(source.resourceKey, 'command.source.resourceKey'),
      submissionId: sourceId(source.submissionId, 'command.source.submissionId'),
      revision: positiveInteger(source.revision, 'command.source.revision'),
    },
  };

  if (raw.operation === 'attendance.report') {
    const p = object(raw.payload, 'command.payload', [
      'reportId', 'eventId', 'unitId', 'rosterVersion', 'coveredPersonIds', 'presentPersonIds', 'completeness', 'expectedEventVersion',
    ], ['expectedEventVersion']);
    const coveredPersonIds = identifiers(p.coveredPersonIds, 'command.payload.coveredPersonIds', 1);
    const presentPersonIds = identifiers(p.presentPersonIds, 'command.payload.presentPersonIds', 0);
    const covered = new Set(coveredPersonIds);
    if (presentPersonIds.some(person => !covered.has(person))) {
      invalid('command.payload.presentPersonIds', 'Every selected person must belong to the covered roster.');
    }
    return {
      ...envelope,
      operation: 'attendance.report',
      payload: {
        reportId: id(p.reportId, 'command.payload.reportId'),
        eventId: id(p.eventId, 'command.payload.eventId'),
        ...(p.expectedEventVersion === undefined ? {} : { expectedEventVersion: positiveInteger(p.expectedEventVersion, 'command.payload.expectedEventVersion') }),
        unitId: id(p.unitId, 'command.payload.unitId'),
        rosterVersion: positiveInteger(p.rosterVersion, 'command.payload.rosterVersion'),
        coveredPersonIds,
        presentPersonIds,
        completeness: choice(p.completeness, 'command.payload.completeness', ['partial', 'complete']),
      },
    };
  }

  if (raw.operation === 'excusal.submit') {
    const p = object(raw.payload, 'command.payload', ['requestId', 'eventId', 'personId', 'requestedOutcome', 'reason', 'expectedEventVersion'], ['expectedEventVersion']);
    return {
      ...envelope,
      operation: 'excusal.submit',
      payload: {
        requestId: id(p.requestId, 'command.payload.requestId'),
        eventId: id(p.eventId, 'command.payload.eventId'),
        ...(p.expectedEventVersion === undefined ? {} : { expectedEventVersion: positiveInteger(p.expectedEventVersion, 'command.payload.expectedEventVersion') }),
        personId: id(p.personId, 'command.payload.personId'),
        requestedOutcome: choice(p.requestedOutcome, 'command.payload.requestedOutcome', REQUESTED_OUTCOMES),
        reason: reason(p.reason, 'command.payload.reason'),
      },
    };
  }

  if (raw.operation === 'excusal.submitMany') {
    const p = object(raw.payload, 'command.payload', ['personId', 'requestedOutcome', 'reason', 'events']);
    if (!Array.isArray(p.events) || p.events.length < 1 || p.events.length > MAX_EXCUSAL_EVENTS) {
      invalid('command.payload.events', 'Expected between 1 and 25 event requests.');
    }
    const events = p.events.map((entry, index) => {
      const path = `command.payload.events[${index}]`;
      const event = object(entry, path, ['eventId', 'requestId', 'expectedEventVersion'], ['expectedEventVersion']);
      return { eventId: id(event.eventId, `${path}.eventId`), requestId: id(event.requestId, `${path}.requestId`), ...(event.expectedEventVersion === undefined ? {} : { expectedEventVersion: positiveInteger(event.expectedEventVersion, `${path}.expectedEventVersion`) }) };
    });
    if (new Set(events.map(event => event.eventId)).size !== events.length
      || new Set(events.map(event => event.requestId)).size !== events.length) {
      invalid('command.payload.events', 'Event and child request identifiers must each be unique.');
    }
    // Code-point ordering is independent of host locale. Selection order is not identity.
    events.sort((a, b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
    return {
      ...envelope, operation: 'excusal.submitMany', payload: {
        personId: id(p.personId, 'command.payload.personId'),
        requestedOutcome: choice(p.requestedOutcome, 'command.payload.requestedOutcome', REQUESTED_OUTCOMES),
        reason: reason(p.reason, 'command.payload.reason'), events,
      },
    };
  }

  if (raw.operation === 'excusal.decide') {
    const p = object(raw.payload, 'command.payload', ['requestId', 'expectedVersion', 'decision', 'reason']);
    return {
      ...envelope,
      operation: 'excusal.decide',
      payload: {
        requestId: id(p.requestId, 'command.payload.requestId'),
        expectedVersion: positiveInteger(p.expectedVersion, 'command.payload.expectedVersion'),
        decision: choice(p.decision, 'command.payload.decision', EXCUSAL_DECISIONS),
        reason: reason(p.reason, 'command.payload.reason'),
      },
    };
  }

  return invalid('command.operation', 'Unsupported operation.');
}

export function buildAttendanceReport(command: AttendanceReportCommand, acceptedAt: string): AttendanceReport {
  const parsed = parseCommand(command);
  if (parsed.operation !== 'attendance.report') invalid('command.operation', 'Expected an attendance report.');
  return {
    ...parsed.payload,
    submittedAt: acceptedTime(acceptedAt),
    submittedBy: parsed.actor.principalId,
    source: parsed.source,
    commandId: parsed.commandId,
    observations: parsed.payload.presentPersonIds.map(personId => ({
      personId, eventId: parsed.payload.eventId, reportId: parsed.payload.reportId, code: 'P',
    })),
  };
}

export function createExcusalRequest(command: ExcusalSubmitCommand, acceptedAt: string): ExcusalRequest {
  const parsed = parseCommand(command);
  if (parsed.operation !== 'excusal.submit') invalid('command.operation', 'Expected an excusal submission.');
  const timestamp = acceptedTime(acceptedAt);
  return {
    ...parsed.payload,
    status: 'Submitted',
    decision: null,
    version: 1,
    submittedAt: timestamp,
    submittedBy: parsed.actor.principalId,
    updatedAt: timestamp,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    source: parsed.source,
    commandId: parsed.commandId,
    lastCommandId: parsed.commandId,
  };
}

/** Pure expansion only: persistence must commit the parent and every child together. */
export function createExcusalRequests(command: ExcusalSubmitManyCommand, acceptedAt: string): ExcusalRequest[] {
  const parsed = parseCommand(command);
  if (parsed.operation !== 'excusal.submitMany') invalid('command.operation', 'Expected a multi-event excusal submission.');
  const { events, ...common } = parsed.payload;
  return events.map(event => createExcusalRequest({
    ...parsed, operation: 'excusal.submit', payload: { ...common, ...event },
  }, acceptedAt));
}

export function decideExcusalRequest(
  current: ExcusalRequest,
  command: ExcusalDecideCommand,
  acceptedAt: string,
): ExcusalRequest {
  const parsed = parseCommand(command);
  if (parsed.operation !== 'excusal.decide') invalid('command.operation', 'Expected an excusal decision.');
  if (current.requestId !== parsed.payload.requestId) invalid('command.payload.requestId', 'Decision target does not match the request.');
  if (current.version !== parsed.payload.expectedVersion) {
    throw new DomainError('VERSION_CONFLICT', 'The request changed. Review the current version before deciding.');
  }
  if (!Number.isSafeInteger(current.version) || current.version < 1 || current.version === Number.MAX_SAFE_INTEGER) {
    invalid('current.version', 'The stored request version is invalid.');
  }
  const timestamp = acceptedTime(acceptedAt);
  return {
    ...current,
    source: { ...current.source },
    status: parsed.payload.decision,
    decision: parsed.payload.decision,
    version: current.version + 1,
    updatedAt: timestamp,
    decidedAt: timestamp,
    decidedBy: parsed.actor.principalId,
    decisionReason: parsed.payload.reason,
    lastCommandId: parsed.commandId,
  };
}

/** This view exposes facts; the future policy layer owns any combined display code. */
export function deriveAttendanceView(
  observedCode: AttendanceCode | null,
  request: ExcusalRequest | null,
): AttendanceView {
  if (observedCode !== null) choice(observedCode, 'observedCode', ATTENDANCE_CODES);
  return {
    observedCode,
    requestStatus: request?.status ?? null,
    requestedOutcome: request?.requestedOutcome ?? null,
    approvedOutcome: request?.decision === 'Approved' ? request.requestedOutcome : null,
    requestVersion: request?.version ?? null,
  };
}
