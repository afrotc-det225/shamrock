/** Pure, versioned reporting projections. No database, Sheets, clock or AI IO. */
import { ATTENDANCE_CODES, REQUESTED_OUTCOMES, EXCUSAL_DECISIONS } from './index.js';
import type { AttendanceCode, ExcusalStatus, RequestedOutcome } from './index.js';

export const REPORTING_POLICY_VERSION = 'legacy-shamrock-credit-v1' as const;
export const MAX_REPORTING_CELLS = 100_000;
const CREDIT = new Set<AttendanceCode>(['P', 'T', 'E', 'ES', 'MED']);
const COUNTED = new Set<AttendanceCode>(['P', 'T', 'A', 'U', 'E', 'ES', 'MED']);
const GMC = ['AS100', 'AS150', 'AS200', 'AS250', 'AS500'];
const POC = ['AS300', 'AS400', 'AS700', 'AS800', 'AS900'];
const YEARS = ['AS900', 'AS800', 'AS700', 'AS400', 'AS300', 'AS500', 'AS250', 'AS200', 'AS150', 'AS100', 'AF Civ'];
const INACTIVE = new Set(['inactive', 'commissioned', 'dropped']);
const TYPES = ['mando', 'secondary', 'llab', 'other', 'third-hour'] as const;

export interface ReportingPerson {
  personId: string;
  lastName: string;
  firstName: string;
  asYear: string;
  flightId: string | null;
  flightPathStatus: string;
  /** Date-only ISO value. Never parse a locale-formatted date or a chip label. */
  dateOfBirth: string | null;
}
export interface ReportingFlight { flightId: string; label: string; squadronId: string }
export interface ReportingSquadron { squadronId: string; label: string }
export interface ReportingTerm {
  termId: string;
  label: string;
  sortOrder: number;
  /** Membership/profile snapshot for this term, including now-inactive alumni. */
  roster?: readonly ReportingPerson[];
}
export interface ReportingEvent {
  eventId: string;
  termId: string;
  label: string;
  type: typeof TYPES[number];
  trainingWeek: number | null;
  displayOrder: number;
  /** Exact event roster snapshot. Null means unavailable, not everyone eligible. */
  eligiblePersonIds: readonly string[] | null;
}
export interface ReportingObservation {
  factId: string;
  personId: string;
  eventId: string;
  /** Committed causal order, comparable within one person/event pair. */
  order: number;
  code: AttendanceCode;
}
export interface ReportingCorrection extends Omit<ReportingObservation, 'code'> {
  /** Null is an explicit clear. It must remain distinguishable from no correction. */
  code: AttendanceCode | null;
}
/** Reviewed imported effective state, before every genuine operation in the new database. */
export interface ReportingLegacyBaseline { baselineId:string;personId:string;eventId:string;code:AttendanceCode|null }
export interface ReportingRequest {
  legacyStateOnly?: boolean;
  requestId: string;
  personId: string;
  eventId: string;
  /** Order of this current request state, not the request-local version. */
  order: number;
  status: ExcusalStatus;
  requestedOutcome: RequestedOutcome;
}
export type ReportingScope = { kind: 'wing' } | { kind: 'flight'; flightId: string } | { kind: 'squadron'; squadronId: string };
export interface FrontendReportingInput {
  policyVersion: typeof REPORTING_POLICY_VERSION;
  /** Calendar date already resolved in the detachment's configured time zone. */
  asOfDate: string;
  currentTermId: string;
  people: readonly ReportingPerson[];
  flights: readonly ReportingFlight[];
  squadrons: readonly ReportingSquadron[];
  terms: readonly ReportingTerm[];
  events: readonly ReportingEvent[];
  observations: readonly ReportingObservation[];
  corrections: readonly ReportingCorrection[];
  legacyBaselines?: readonly ReportingLegacyBaseline[];
  requests: readonly ReportingRequest[];
  scope?: ReportingScope;
}
export interface ReportingDiagnostic {
  code: 'missing-historical-roster' | 'unknown-eligibility' | 'evidence-outside-eligibility' |
    'ambiguous-attendance-order' | 'ambiguous-request-precedence' | 'overlapping-excusal-requests' |
    'approval-conflicts-with-presence';
  termId: string;
  eventId?: string;
  personId?: string;
}
export interface ReportingAttendanceCell {
  eventId: string;
  eligible: boolean | null;
  observedCode: AttendanceCode | null;
  observationId: string | null;
  correctionId: string | null;
  correctionCode: AttendanceCode | null;
  legacyBaselineId?: string;
  attendanceCode: AttendanceCode | null;
  effectiveCode: AttendanceCode | null;
  source: 'none' | 'observation' | 'correction' | 'legacy-baseline' | 'approval' | 'pending-request' | 'review';
  requests: { requestId: string; status: ExcusalStatus; requestedOutcome: RequestedOutcome }[];
  needsReview: boolean;
}
export interface AttendanceCredit {
  numerator: number;
  denominator: number;
  percentage: number;
  noCountedAttendance: boolean;
  eligibleEvents: number;
  unknownEligibilityEvents: number;
}
export interface ReportingMatrixRow {
  personId: string;
  lastName: string;
  firstName: string;
  asYear: string;
  flightId: string | null;
  flight: string;
  squadronId: string | null;
  squadron: string;
  overall: AttendanceCredit;
  llab: AttendanceCredit;
  cells: ReportingAttendanceCell[];
}
export interface ReportingMatrix {
  termId: string;
  label: string;
  rosterSource: 'current' | 'snapshot' | 'unavailable';
  eventColumns: { eventId: string; machineHeader: string; label: string; type: ReportingEvent['type'] }[];
  rows: ReportingMatrixRow[];
}
export interface BirthdayView {
  personId: string;
  lastName: string;
  firstName: string;
  dateOfBirth: string;
  birthdayThisYear: string;
  weekStartsOn: string;
  display: string;
  group: number;
}
export class ReportingInputError extends Error {
  constructor(public readonly path: string, message = 'Invalid reporting input.') { super(message); this.name = 'ReportingInputError'; }
}
const fail = (path: string): never => { throw new ReportingInputError(path); };
const normalizedYear = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');
const compareText = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b, 'en');
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const pairKey = (personId: string, eventId: string) => JSON.stringify([personId, eventId]);

function identifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail(path);
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 512 || value.includes('\u0000')) fail(path);
}
function integer(value: unknown, path: string, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) fail(path);
}
function dateOnly(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path);
  const time = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(time.getTime()) || isoDay(time) !== value) fail(path);
}
function unique<T>(items: readonly T[], key: (item: T) => string, path: string): Map<string, T> {
  if (!Array.isArray(items) || items.length > MAX_REPORTING_CELLS) fail(path);
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item); identifier(id, `${path}.id`);
    if (map.has(id)) fail(`${path}.duplicateId`);
    map.set(id, item);
  }
  return map;
}

/** Legacy numerical credit, with an explicit flag so 100% without data is not misrepresented. */
export function calculateAttendanceCredit(cells: readonly Pick<ReportingAttendanceCell, 'effectiveCode' | 'eligible'>[]): AttendanceCredit {
  let numerator = 0, denominator = 0, eligibleEvents = 0, unknownEligibilityEvents = 0;
  for (const cell of cells) {
    if (cell.effectiveCode !== null && !ATTENDANCE_CODES.includes(cell.effectiveCode)) fail('cells.code');
    if (cell.eligible !== false && cell.effectiveCode && CREDIT.has(cell.effectiveCode)) numerator++;
    if (cell.eligible !== false && cell.effectiveCode && COUNTED.has(cell.effectiveCode)) denominator++;
    if (cell.eligible === true) eligibleEvents++;
    if (cell.eligible === null) unknownEligibilityEvents++;
  }
  return { numerator, denominator, percentage: denominator ? numerator / denominator : 1,
    noCountedAttendance: denominator === 0, eligibleEvents, unknownEligibilityEvents };
}

/** Convenience for an existing matrix's literal event cells, including explicit blanks. */
export function calculateAttendancePercent(codes: readonly (AttendanceCode | null | '')[]): number {
  return calculateAttendanceCredit(codes.map(code => ({ effectiveCode: code === '' ? null : code, eligible: null }))).percentage;
}

function resolveCell(event: ReportingEvent, personId: string, observations: readonly ReportingObservation[],
  corrections: readonly ReportingCorrection[], requests: readonly ReportingRequest[], eligible: boolean | null,
  diagnostics: ReportingDiagnostic[], baseline?: ReportingLegacyBaseline): ReportingAttendanceCell {
  const ordered = [...observations.map(f => ({ ...f, kind: 'observation' as const })),
    ...corrections.map(f => ({ ...f, kind: 'correction' as const }))].sort((a, b) => b.order - a.order || compareText(a.factId, b.factId));
  const observation = [...observations].sort((a, b) => b.order - a.order || compareText(a.factId, b.factId))[0];
  const correction = [...corrections].sort((a, b) => b.order - a.order || compareText(a.factId, b.factId))[0];
  const ambiguousObservation = observation && observations.some(f => f.order === observation.order && f.code !== observation.code);
  const base = ordered[0] ?? (baseline ? {factId:baseline.baselineId,code:baseline.code,order:0,kind:'legacy-baseline' as const} : undefined);
  const cell: ReportingAttendanceCell = { eventId: event.eventId, eligible,
    observedCode: ambiguousObservation ? null : observation?.code ?? null, observationId: ambiguousObservation ? null : observation?.factId ?? null,
    correctionId: correction?.factId ?? null, correctionCode: correction?.code ?? null,
    ...(baseline?{legacyBaselineId:baseline.baselineId}:{}),
    attendanceCode: base?.code ?? null, effectiveCode: base?.code ?? null, source: base?.kind ?? 'none',
    requests: [...requests].sort((a, b) => compareText(a.requestId, b.requestId)).map(r => ({ requestId: r.requestId, status: r.status, requestedOutcome: r.requestedOutcome })),
    needsReview: false };
  const review = (code: ReportingDiagnostic['code']) => {
    diagnostics.push({ code, termId: event.termId, eventId: event.eventId, personId }); cell.needsReview = true;
  };
  if (base && ordered.some(f => f.order === base.order && f.code !== base.code)) {
    review('ambiguous-attendance-order'); cell.attendanceCode = null; cell.effectiveCode = null; cell.source = 'review'; return cell;
  }
  // Terminal requests remove only their adjudication; no stale prior-code restoration.
  const active = requests.filter(r => !r.legacyStateOnly && r.status !== 'Withdrawn' && r.status !== 'Superseded');
  if (active.length > 1) {
    review('overlapping-excusal-requests'); cell.source = 'review';
  } else if (active.length === 1) {
    const request = active[0];
    const presence = cell.attendanceCode === 'P' || cell.attendanceCode === 'T';
    const laterCorrection = base?.kind === 'correction' && base.order > request.order;
    if (presence) {
      if (request.status === 'Approved' && (request.requestedOutcome === 'P' || request.requestedOutcome === 'T') && request.requestedOutcome !== cell.attendanceCode) review('approval-conflicts-with-presence');
    } else if (!laterCorrection && request.status !== 'Denied') {
      if (base?.kind === 'correction' && base.order === request.order) {
        review('ambiguous-request-precedence'); cell.source = 'review';
      } else if (request.status === 'Approved') {
        cell.effectiveCode = request.requestedOutcome; cell.source = 'approval';
      } else if (!base || request.order > base.order) {
        cell.effectiveCode = 'R'; cell.source = 'pending-request';
      }
    }
    // Denial is a request state, never proof of absence or an automatic U/D.
  }
  if (eligible === false && (ordered.length || active.length || baseline)) review('evidence-outside-eligibility');
  return cell;
}

/** Birthday groups follow the existing Sunday–Saturday, current-calendar-year view. */
export function buildBirthdayView(people: readonly ReportingPerson[], asOfDate: string): BirthdayView[] {
  dateOnly(asOfDate, 'asOfDate');
  const year = Number(asOfDate.slice(0, 4));
  const birthdays = people.filter(p => p.lastName.trim() && p.dateOfBirth).map(p => {
    dateOnly(p.dateOfBirth, 'people.dateOfBirth');
    const birth = p.dateOfBirth!;
    // Google DATE rolls Feb 29 to March 1 in non-leap years; preserve that display rule.
    const birthday = new Date(`${year}-01-01T00:00:00Z`);
    birthday.setUTCMonth(Number(birth.slice(5, 7)) - 1, Number(birth.slice(8, 10)));
    const week = new Date(birthday); week.setUTCDate(week.getUTCDate() - week.getUTCDay());
    return { person: p, birthday, weekStartsOn: isoDay(week) };
  }).sort((a, b) => a.birthday.getTime() - b.birthday.getTime() || compareText(a.person.lastName, b.person.lastName) || compareText(a.person.firstName, b.person.firstName) || compareText(a.person.personId, b.person.personId));
  const surnameCounts = new Map<string, number>();
  for (const { person } of birthdays) { const key = person.lastName.toLowerCase(); surnameCounts.set(key, (surnameCounts.get(key) ?? 0) + 1); }
  const groups = new Map<string, number>();
  return birthdays.map(({ person, birthday, weekStartsOn }) => {
    if (!groups.has(weekStartsOn)) groups.set(weekStartsOn, groups.size + 1);
    const initial = (surnameCounts.get(person.lastName.toLowerCase()) ?? 0) > 1 ? `${person.firstName.slice(0, 1)}. ` : '';
    return { personId: person.personId, lastName: person.lastName, firstName: person.firstName,
      dateOfBirth: person.dateOfBirth!, birthdayThisYear: isoDay(birthday), weekStartsOn,
      display: `C/${initial}${person.lastName} (${birthday.getUTCMonth() + 1}/${birthday.getUTCDate()})`, group: groups.get(weekStartsOn)! };
  });
}

/** Build literal values for the normal matrix/dashboard; providers handle rendering separately. */
export function buildFrontendReporting(input: FrontendReportingInput) {
  if (input.policyVersion !== REPORTING_POLICY_VERSION) fail('policyVersion');
  dateOnly(input.asOfDate, 'asOfDate');
  const flights = unique(input.flights, f => f.flightId, 'flights');
  const squadrons = unique(input.squadrons, s => s.squadronId, 'squadrons');
  const terms = unique(input.terms, t => t.termId, 'terms');
  const events = unique(input.events, e => e.eventId, 'events');
  const people = unique(input.people, p => p.personId, 'people');
  if (!terms.has(input.currentTermId)) fail('currentTermId');
  for (const f of flights.values()) { text(f.label, 'flights.label'); if (!squadrons.has(f.squadronId)) fail('flights.squadronId'); }
  for (const s of squadrons.values()) text(s.label, 'squadrons.label');
  const allPeople = new Set(people.keys());
  const validatePerson = (p: ReportingPerson) => {
    identifier(p.personId, 'people.personId');
    for (const value of [p.lastName, p.firstName, p.asYear, p.flightPathStatus]) text(value, 'people.profile');
    if (p.flightId !== null && !flights.has(p.flightId)) fail('people.flightId');
    if (p.dateOfBirth !== null) dateOnly(p.dateOfBirth, 'people.dateOfBirth');
    allPeople.add(p.personId);
  };
  for (const p of people.values()) validatePerson(p);
  const termOrders = new Set<number>();
  for (const t of terms.values()) {
    text(t.label, 'terms.label'); integer(t.sortOrder, 'terms.sortOrder');
    if (termOrders.has(t.sortOrder)) fail('terms.duplicateOrder'); termOrders.add(t.sortOrder);
    if (t.roster) for (const p of unique(t.roster, p => p.personId, 'terms.roster').values()) validatePerson(p);
  }
  const eligibility = new Map<string, Set<string> | null>();
  for (const e of events.values()) {
    text(e.label, 'events.label'); if (!terms.has(e.termId) || !TYPES.includes(e.type)) fail('events.classification');
    integer(e.displayOrder, 'events.displayOrder'); if (e.trainingWeek !== null) integer(e.trainingWeek, 'events.trainingWeek', 1);
    if (e.eligiblePersonIds === null) eligibility.set(e.eventId, null);
    else {
      if (!Array.isArray(e.eligiblePersonIds) || e.eligiblePersonIds.length > MAX_REPORTING_CELLS) fail('events.eligiblePersonIds');
      const ids = new Set(e.eligiblePersonIds);
      if (ids.size !== e.eligiblePersonIds.length || [...ids].some(id => !allPeople.has(id))) fail('events.eligiblePersonIds');
      eligibility.set(e.eventId, ids);
    }
  }
  const scope = input.scope ?? { kind: 'wing' as const };
  if (scope.kind === 'flight') { if (!flights.has(scope.flightId)) fail('scope.flightId'); }
  else if (scope.kind === 'squadron') { if (!squadrons.has(scope.squadronId)) fail('scope.squadronId'); }
  else if (scope.kind !== 'wing') fail('scope.kind');
  const inScope = (p: ReportingPerson) => scope.kind === 'wing' || (scope.kind === 'flight' ? p.flightId === scope.flightId : !!p.flightId && flights.get(p.flightId)?.squadronId === scope.squadronId);
  const validateFact = (f: { personId: string; eventId: string; order: number }) => {
    if (!allPeople.has(f.personId) || !events.has(f.eventId)) fail('facts.target');
    integer(f.order, 'facts.order', 1);
  };
  const obsByPair = new Map<string, ReportingObservation[]>(), correctionByPair = new Map<string, ReportingCorrection[]>(), requestsByPair = new Map<string, ReportingRequest[]>();
  const baselineByPair = new Map<string, ReportingLegacyBaseline>();
  for (const baseline of unique(input.legacyBaselines??[], b=>b.baselineId, 'legacyBaselines').values()) {
    if (!allPeople.has(baseline.personId)||!events.has(baseline.eventId)) fail('legacyBaselines.target');
    if (baseline.code!==null&&!ATTENDANCE_CODES.includes(baseline.code)) fail('legacyBaselines.code');
    const key=pairKey(baseline.personId,baseline.eventId);
    if (baselineByPair.has(key)) fail('legacyBaselines.duplicatePair');
    baselineByPair.set(key,baseline);
  }
  const group = <T extends { personId: string; eventId: string }>(map: Map<string, T[]>, fact: T) => {
    const key = pairKey(fact.personId, fact.eventId); const values = map.get(key) ?? []; values.push(fact); map.set(key, values);
  };
  const seenFacts = new Set<string>();
  for (const [kind, facts] of [['observations', input.observations], ['corrections', input.corrections]] as const) {
    for (const f of unique(facts, f => f.factId, kind).values()) {
      validateFact(f); if (seenFacts.has(f.factId)) fail('facts.duplicateId'); seenFacts.add(f.factId);
      if (f.code !== null && !ATTENDANCE_CODES.includes(f.code)) fail('facts.code');
      if (kind === 'observations') { if (f.code === null) fail('observations.code'); group(obsByPair, f as ReportingObservation); }
      else group(correctionByPair, f);
    }
  }
  for (const r of unique(input.requests, r => r.requestId, 'requests').values()) {
    if (r.legacyStateOnly===true) { if (r.order!==0||!allPeople.has(r.personId)||!events.has(r.eventId)) fail('requests.legacyState'); } else validateFact(r);
    if (!['Submitted', ...EXCUSAL_DECISIONS].includes(r.status) || !REQUESTED_OUTCOMES.includes(r.requestedOutcome)) fail('requests.state');
    group(requestsByPair, r);
  }
  const diagnostics: ReportingDiagnostic[] = [];
  const comparePeople = (a: ReportingPerson, b: ReportingPerson) => {
    const rank = (p: ReportingPerson) => { const i = YEARS.map(normalizedYear).indexOf(normalizedYear(p.asYear)); return i < 0 ? YEARS.length : i; };
    return rank(a) - rank(b) || (rank(a) === YEARS.length ? compareText(normalizedYear(b.asYear), normalizedYear(a.asYear)) : 0) || compareText(a.lastName, b.lastName) || compareText(a.firstName, b.firstName) || compareText(a.personId, b.personId);
  };
  let cellsPlanned = 0;
  const plan = [...terms.values()].sort((a, b) => a.sortOrder - b.sortOrder).map(term => {
    const termEvents = input.events.filter(e => e.termId === term.termId && e.type !== 'third-hour').sort((a, b) => (a.trainingWeek ?? Number.MAX_SAFE_INTEGER) - (b.trainingWeek ?? Number.MAX_SAFE_INTEGER) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.displayOrder - b.displayOrder || compareText(a.eventId, b.eventId));
    const isCurrent = term.termId === input.currentTermId;
    const roster = (term.roster ?? (isCurrent ? input.people.filter(p => !INACTIVE.has(p.flightPathStatus.trim().toLowerCase())) : [])).filter(inScope).slice().sort(comparePeople);
    const rosterSource = term.roster ? 'snapshot' as const : isCurrent ? 'current' as const : 'unavailable' as const;
    if (rosterSource === 'unavailable') diagnostics.push({ code: 'missing-historical-roster', termId: term.termId });
    cellsPlanned += termEvents.length * roster.length;
    if (cellsPlanned > MAX_REPORTING_CELLS) fail('matrix.capacity');
    return { term, termEvents, roster, rosterSource };
  });
  const matrices: ReportingMatrix[] = plan.map(({ term, termEvents, roster, rosterSource }) => {
    for (const event of termEvents) if (eligibility.get(event.eventId) === null) diagnostics.push({ code: 'unknown-eligibility', termId: term.termId, eventId: event.eventId });
    const rows = roster.map(p => {
      const flight = p.flightId ? flights.get(p.flightId)! : null;
      const cells = termEvents.map(event => {
        const key = pairKey(p.personId, event.eventId), eligible = eligibility.get(event.eventId);
        return resolveCell(event, p.personId, obsByPair.get(key) ?? [], correctionByPair.get(key) ?? [], requestsByPair.get(key) ?? [], eligible ? eligible.has(p.personId) : null, diagnostics, baselineByPair.get(key));
      });
      return { personId: p.personId, lastName: p.lastName, firstName: p.firstName, asYear: p.asYear,
        flightId: p.flightId, flight: flight?.label ?? '', squadronId: flight?.squadronId ?? null, squadron: flight ? squadrons.get(flight.squadronId)!.label : '',
        overall: calculateAttendanceCredit(cells), llab: calculateAttendanceCredit(cells.filter((_, i) => termEvents[i].type === 'llab')), cells };
    });
    return { termId: term.termId, label: term.label, rosterSource,
      eventColumns: termEvents.map(e => ({ eventId: e.eventId, machineHeader: `event:${e.eventId}`, label: e.label, type: e.type })), rows };
  });
  const current = matrices.find(m => m.termId === input.currentTermId)!;
  const mean = (rows: readonly ReportingMatrixRow[], field: 'overall' | 'llab' = 'overall') => rows.length ? rows.reduce((sum, r) => sum + r[field].percentage, 0) / rows.length : null;
  const currentPlan = plan.find(p => p.term.termId === input.currentTermId)!;
  const history = matrices.filter(m => m.termId !== current.termId && terms.get(m.termId)!.sortOrder < terms.get(current.termId)!.sortOrder).slice(-2);
  const comparison = [current, ...history.slice().reverse()];
  return {
    policyVersion: REPORTING_POLICY_VERSION, asOfDate: input.asOfDate, scope: { ...scope }, currentTermId: input.currentTermId,
    matrices, diagnostics, needsReview: diagnostics.length > 0,
    dashboard: {
      totalCadets: current.rows.length,
      gmcCadets: current.rows.filter(p => GMC.includes(normalizedYear(p.asYear))).length,
      pocCadets: current.rows.filter(p => POC.includes(normalizedYear(p.asYear))).length,
      averageOverall: mean(current.rows), averageLlab: mean(current.rows, 'llab'), belowEighty: current.rows.filter(p => p.overall.percentage < 0.8).length,
      noCountedAttendanceCadets: current.rows.filter(p => p.overall.noCountedAttendance).length,
      eligiblePersonEvents: current.rows.reduce((sum, r) => sum + r.overall.eligibleEvents, 0),
      unknownEligibilityPersonEvents: current.rows.reduce((sum, r) => sum + r.overall.unknownEligibilityEvents, 0),
      pendingRequests: current.rows.reduce((sum, r) => sum + r.cells.reduce((n, c) => n + c.requests.filter(q => q.status === 'Submitted').length, 0), 0),
      rosterByYear: YEARS.map(asYear => ({ asYear, cadets: current.rows.filter(r => normalizedYear(r.asYear) === normalizedYear(asYear)).length })),
      attendanceByYear: YEARS.map(asYear => ({ asYear, terms: comparison.map(m => ({ termId: m.termId, label: m.label, percentage: mean(m.rows.filter(r => normalizedYear(r.asYear) === normalizedYear(asYear))) })) })),
      attendanceByFlight: [...flights.values()].filter(f => f.label.toLowerCase() !== 'abroad' && (scope.kind === 'wing' || (scope.kind === 'flight' ? f.flightId === scope.flightId : f.squadronId === scope.squadronId))).sort((a, b) => compareText(a.label, b.label)).map(f => ({ flightId: f.flightId, flight: f.label, percentage: mean(current.rows.filter(r => r.flightId === f.flightId)) })),
      attendanceBySquadron: [...squadrons.values()].filter(s => scope.kind === 'wing' || (scope.kind === 'squadron' ? s.squadronId === scope.squadronId : flights.get(scope.flightId)?.squadronId === s.squadronId)).sort((a, b) => compareText(a.label, b.label)).map(s => ({ squadronId: s.squadronId, squadron: s.label, percentage: mean(current.rows.filter(r => r.squadronId === s.squadronId)) })),
      termTrend: [...history, current].map(m => ({ termId: m.termId, label: m.label, percentage: mean(m.rows), rosterSource: m.rosterSource })),
      birthdays: buildBirthdayView(currentPlan.roster, input.asOfDate),
    },
  };
}
