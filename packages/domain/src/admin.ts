/** Bounded administrative commands for the isolated backend. Stable identity is never an email. */
import { DomainError, type ActorEvidence, type CommandSource, type Environment, type AttendanceCode } from './index.js';
export const AS_YEARS = ['AS100', 'AS150', 'AS200', 'AS250', 'AS300', 'AS400', 'AS500', 'AS700', 'AS800', 'AS900', 'AF Civ'] as const;
export const FLIGHT_PATH_STATUSES = ['Participating 1/4', 'Enrolled 2/4', 'Active 3/4', 'Ready 4/4', 'Inactive', 'Commissioned', 'Dropped'] as const;
export const DIRECTORY_FIELDS = ['lastName', 'firstName', 'asYear', 'rank', 'role', 'university', 'email', 'phone', 'dorm', 'cipBroadArea', 'cipCode', 'afsc', 'homeTown', 'homeState', 'classYear', 'dateOfBirth', 'flightPathStatus', 'photoLink'] as const;
export interface DirectoryProfile {
  lastName: string;
  firstName: string;
  asYear: typeof AS_YEARS[number];
  rank: string;
  role: string;
  university: string;
  email: string;
  phone: string;
  dorm: string;
  cipBroadArea: string;
  cipCode: string;
  afsc: string;
  homeTown: string;
  homeState: string;
  classYear: string;
  dateOfBirth: string | null;
  flightPathStatus: typeof FLIGHT_PATH_STATUSES[number];
  photoLink: string;
}
export interface LeadershipProfile {
  lastName: string;
  firstName: string;
  rank: string;
  role: string;
  email: string;
  cellPhone: string;
}
export interface DirectoryUpsert {
  personId: string;
  expectedVersion: number;
  flightId: string | null;
  profile: DirectoryProfile;
}
export interface LeadershipUpsert {
  contactId: string;
  expectedVersion: number;
  personId: string | null;
  profile: LeadershipProfile | null;
  reportsTo: string;
  officePhone: string;
  officeLocation: string;
  active: boolean;
}
export interface EventUpsert {
  eventId: string;
  expectedVersion: number;
  termId: string;
  eventType: 'mando' | 'secondary' | 'llab' | 'other';
  trainingWeek: number | null;
  displayOrder: number;
  label: string;
  columnLabel: string;
  expectedGroup: string;
  flightIds: string[];
  eligiblePersonIds: string[];
  status: 'active' | 'cancelled' | 'inactive' | 'archived';
  startAt: string | null;
  endAt: string | null;
  location: string;
  notes: string;
}
interface Envelope {
  commandId: string;
  contractVersion: 1;
  environment: Environment;
  generation: number;
  actor: ActorEvidence;
  source: CommandSource;
}
export type AdminCommand = Envelope & ({
  operation: 'directory.upsert';
  payload: DirectoryUpsert;
} | {
  operation: 'leadership.upsert';
  payload: LeadershipUpsert;
} | {
  operation: 'event.upsert';
  payload: EventUpsert;
});
export interface SnapshotRevision {
  operations: number;
  administration: number;
}
export interface DirectoryRecord extends DirectoryProfile {
  personId: string;
  version: number;
  flightId: string | null;
  active: boolean;
}
export interface LeadershipRecord extends LeadershipProfile {
  contactId: string;
  /** Command version for Leadership contact-owned fields. */
  contactVersion: number;
  /** Directory command version for linked identity, otherwise null. */
  profileVersion: number | null;
  /** Monotonic display token, never an expected command version. */
  publicationVersion: number;
  personId: string | null;
  reportsTo: string;
  officePhone: string;
  officeLocation: string;
  active: boolean;
}
export interface FrontendSnapshot {
  contractVersion: 1;
  environment: Environment;
  generation: number;
  revision: SnapshotRevision;
  people: DirectoryRecord[];
  leadership: LeadershipRecord[];
  flights: {
    flightId: string;
    label: string;
    squadronId: string | null;
    rosterVersion: number;
  }[];
  squadrons: {
    squadronId: string;
    label: string;
  }[];
  terms: {
    termId: string;
    label: string;
    sortOrder: number;
    isCurrent: boolean;
    roster?: {personId:string;lastName:string;firstName:string;asYear:string;flightId:string|null;flightPathStatus:string;dateOfBirth:string|null}[];
  }[];
  events: (Omit<EventUpsert, 'expectedVersion' | 'flightIds' | 'eligiblePersonIds'> & {
    version: number;
    eligiblePersonIds: string[] | null;
  })[];
  eventFlights: {
    eventId: string;
    flightId: string;
  }[];
  observations: {
    factId: string;
    personId: string;
    eventId: string;
    order: number;
    code: 'P';
  }[];
  corrections: {factId:string;personId:string;eventId:string;order:number;code:AttendanceCode|null}[];
  /** Pairs with no facts are authoritatively version zero. */
  attendanceVersions: {personId:string;eventId:string;version:number}[];
  requests: {
    requestId: string;
    personId: string;
    eventId: string;
    flightId: string;
    order: number;
    status: string;
    requestedOutcome: string;
    version: number;
    reason: string;
    submittedAt: string;
    submittedBy: string;
    updatedAt: string;
    decidedAt: string | null;
    decidedBy: string | null;
    decisionReason: string | null;
  }[];
  /** Catalog/legacy records without profiles are explicit, never silently fabricated. */
  diagnostics: {
    code: string;
    count: number;
  }[];
}
const invalid = (path: string, message = 'Invalid administrative command.'): never => { throw new DomainError('INVALID_COMMAND', message, path); };
const object = (value: unknown, path: string, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return invalid(path, 'Expected a plain object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(k => !Object.hasOwn(result, k)))
    return invalid(path, 'Required fields are missing or unsupported fields were supplied.');
  return result;
};
export function adminIdentifier(value: unknown, path = 'id'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    return invalid(path, 'Expected a stable identifier.');
  return value;
}
function text(value: unknown, path: string, max = 240, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || value !== value.trim() || (required && !value))
    return invalid(path, 'Expected bounded, trimmed text.');
  return value;
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid(path, 'Expected a bounded integer.');
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], path: string): T { if (typeof value !== 'string' || !choices.includes(value as T))
  return invalid(path, 'Unsupported choice.'); return value as T; }
function bool(value: unknown, path: string): boolean { if (typeof value !== 'boolean')
  return invalid(path, 'Expected true or false.'); return value; }
function date(value: unknown, path: string, dateOnly = false): string | null {
  if (value === null)
    return null;
  const valueText = text(value, path, 30, true);
  const parsed = new Date(dateOnly ? `${valueText}T00:00:00.000Z` : valueText);
  if (!Number.isFinite(parsed.getTime()) || (dateOnly ? parsed.toISOString().slice(0, 10) : parsed.toISOString()) !== valueText)
    return invalid(path, 'Expected a canonical date or UTC timestamp.');
  return valueText;
}
function email(value: unknown, path: string): string {
  const result = text(value, path, 254);
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    return invalid(path, 'Expected an email address or blank.');
  return result.toLowerCase();
}
function profile(value: unknown): DirectoryProfile {
  const p = object(value, 'payload.profile', DIRECTORY_FIELDS);
  const result = {} as DirectoryProfile;
  for (const key of DIRECTORY_FIELDS) {
    if (key === 'asYear')
      result[key] = choice(p[key], AS_YEARS, `payload.profile.${key}`);
    else if (key === 'flightPathStatus')
      result[key] = choice(p[key], FLIGHT_PATH_STATUSES, `payload.profile.${key}`);
    else if (key === 'dateOfBirth')
      result[key] = date(p[key], `payload.profile.${key}`, true);
    else if (key === 'email')
      result[key] = email(p[key], `payload.profile.${key}`);
    else
      result[key] = text(p[key], `payload.profile.${key}`, key === 'photoLink' ? 2048 : 240, ['firstName', 'lastName'].includes(key));
  }
  if (result.photoLink) {
    let url: URL;
    try {
      url = new URL(result.photoLink);
    }
    catch {
      return invalid('payload.profile.photoLink', 'Expected an HTTPS photo link or blank.');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      return invalid('payload.profile.photoLink', 'Expected an HTTPS photo link or blank.');
  }
  if (result.classYear && !/^\d{4}$/.test(result.classYear))
    return invalid('payload.profile.classYear', 'Expected a four-digit class year or blank.');
  return result;
}
export function operationallyActive(profile: Pick<DirectoryProfile, 'flightPathStatus'>): boolean {
  return !['Inactive', 'Commissioned', 'Dropped'].includes(profile.flightPathStatus);
}
/** Display-only role derivation mirrors DirectoryService; it never grants authority. */
export function directoryLeadershipRole(role: string, flight: string, squadron: string): string | null {
  const normalized = role.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!/(wing commander|operations group commander|operations group deputy|squadron commander|flight commander|senior gmc advisor|deputy gmc advisor)/.test(normalized))
    return null;
  if (normalized === 'squadron commander' && squadron)
    return `${squadron} Squadron Commander`;
  if (normalized.includes('flight commander') && flight && !/\b(alpha|bravo|charlie|delta|echo|foxtrot|abroad)\b/.test(normalized))
    return `${flight} ${role}`;
  return role;
}
export function parseAdminCommand(value: unknown): AdminCommand {
  const c = object(value, 'command', ['commandId', 'contractVersion', 'environment', 'generation', 'actor', 'source', 'operation', 'payload']);
  const a = object(c.actor, 'actor', ['principalId', 'evidence']);
  const s = object(c.source, 'source', ['kind', 'resourceKey', 'submissionId', 'revision']);
  if (c.contractVersion !== 1)
    return invalid('contractVersion', 'Unsupported contract version.');
  const sourceKind = choice(s.kind, ['sheet', 'test'] as const, 'source.kind');
  const evidence = choice(a.evidence, ['google-edit', 'authenticated-confirmation'] as const, 'actor.evidence');
  if (evidence === 'google-edit' && sourceKind !== 'sheet')
    return invalid('actor.evidence', 'Actor evidence does not match the source.');
  const envelope: Envelope = { commandId: adminIdentifier(c.commandId, 'commandId'), contractVersion: 1, environment: choice(c.environment, ['local', 'staging'] as const, 'environment'), generation: integer(c.generation, 'generation', 1), actor: { principalId: adminIdentifier(a.principalId, 'actor.principalId'), evidence }, source: { kind: sourceKind, resourceKey: adminIdentifier(s.resourceKey, 'source.resourceKey'), submissionId: adminIdentifier(s.submissionId, 'source.submissionId'), revision: integer(s.revision, 'source.revision', 1) } };
  if (c.operation === 'directory.upsert') {
    const p = object(c.payload, 'payload', ['personId', 'expectedVersion', 'flightId', 'profile']);
    const payload = { personId: adminIdentifier(p.personId, 'payload.personId'), expectedVersion: integer(p.expectedVersion, 'payload.expectedVersion'), flightId: p.flightId === null ? null : adminIdentifier(p.flightId, 'payload.flightId'), profile: profile(p.profile) };
    if (operationallyActive(payload.profile) && payload.flightId === null)
      return invalid('payload.flightId', 'An active cadet requires one Flight.');
    return { ...envelope, operation: c.operation, payload };
  }
  if (c.operation === 'leadership.upsert') {
    const p = object(c.payload, 'payload', ['contactId', 'expectedVersion', 'personId', 'profile', 'reportsTo', 'officePhone', 'officeLocation', 'active']);
    const personId = p.personId === null ? null : adminIdentifier(p.personId, 'payload.personId');
    let record: LeadershipProfile | null = null;
    if (personId !== null && p.profile !== null)
      return invalid('payload.profile', 'Directory-linked identity comes from the Directory.');
    if (personId === null) {
      const raw = object(p.profile, 'payload.profile', ['lastName', 'firstName', 'rank', 'role', 'email', 'cellPhone']);
      record = { lastName: text(raw.lastName, 'profile.lastName', 240, true), firstName: text(raw.firstName, 'profile.firstName', 240, true), rank: text(raw.rank, 'profile.rank'), role: text(raw.role, 'profile.role'), email: email(raw.email, 'profile.email'), cellPhone: text(raw.cellPhone, 'profile.cellPhone') };
    }
    return { ...envelope, operation: c.operation, payload: { contactId: adminIdentifier(p.contactId, 'payload.contactId'), expectedVersion: integer(p.expectedVersion, 'payload.expectedVersion'), personId, profile: record, reportsTo: text(p.reportsTo, 'payload.reportsTo'), officePhone: text(p.officePhone, 'payload.officePhone'), officeLocation: text(p.officeLocation, 'payload.officeLocation'), active: bool(p.active, 'payload.active') } };
  }
  if (c.operation === 'event.upsert') {
    const p = object(c.payload, 'payload', ['eventId', 'expectedVersion', 'termId', 'eventType', 'trainingWeek', 'displayOrder', 'label', 'columnLabel', 'expectedGroup', 'flightIds', 'eligiblePersonIds', 'status', 'startAt', 'endAt', 'location', 'notes']);
    if (!Array.isArray(p.flightIds) || p.flightIds.length < 1 || p.flightIds.length > 50)
      return invalid('payload.flightIds', 'Choose one to fifty Flights.');
    const flightIds = p.flightIds.map((f, i) => adminIdentifier(f, `payload.flightIds.${i}`)).sort();
    if (new Set(flightIds).size !== flightIds.length)
      return invalid('payload.flightIds', 'Duplicate Flights are not allowed.');
    if (!Array.isArray(p.eligiblePersonIds) || p.eligiblePersonIds.length > 500)
      return invalid('payload.eligiblePersonIds', 'Choose at most 500 explicit event roster members.');
    const eligiblePersonIds = p.eligiblePersonIds.map((person, i) => adminIdentifier(person, `payload.eligiblePersonIds.${i}`)).sort();
    if (new Set(eligiblePersonIds).size !== eligiblePersonIds.length)
      return invalid('payload.eligiblePersonIds', 'Duplicate event roster members are not allowed.');
    const payload: EventUpsert = {
      eventId: adminIdentifier(p.eventId, 'payload.eventId'),
      expectedVersion: integer(p.expectedVersion, 'payload.expectedVersion'),
      termId: adminIdentifier(p.termId, 'payload.termId'),
      eventType: choice(p.eventType, ['mando', 'secondary', 'llab', 'other'] as const, 'payload.eventType'),
      trainingWeek: p.trainingWeek === null ? null : integer(p.trainingWeek, 'payload.trainingWeek', 1, 100),
      displayOrder: integer(p.displayOrder, 'payload.displayOrder', 0, 10000),
      label: text(p.label, 'payload.label', 240, true),
      columnLabel: text(p.columnLabel, 'payload.columnLabel', 240, true),
      expectedGroup: text(p.expectedGroup, 'payload.expectedGroup', 240, true),
      flightIds, eligiblePersonIds,
      status: choice(p.status, ['active', 'cancelled', 'inactive', 'archived'] as const, 'payload.status'),
      startAt: date(p.startAt, 'payload.startAt'),
      endAt: date(p.endAt, 'payload.endAt'),
      location: text(p.location, 'payload.location', 1000),
      notes: text(p.notes, 'payload.notes', 4000),
    };
    if ((payload.startAt === null) !== (payload.endAt === null) || (payload.startAt !== null && payload.endAt !== null && payload.endAt < payload.startAt))
      return invalid('payload.endAt', 'Provide an ordered start/end pair or leave both blank.');
    return { ...envelope, operation: c.operation, payload };
  }
  return invalid('operation', 'Unsupported administrative operation.');
}
