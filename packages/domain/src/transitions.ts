/** Reviewed term preparation. Legacy defaults are suggestions, never authority to change a cadet. */
import { AS_YEARS, FLIGHT_PATH_STATUSES, adminIdentifier, operationallyActive, type DirectoryRecord, type FrontendSnapshot, type EventUpsert } from './admin.js';
import { DomainError } from './index.js';
export const TRANSITION_POLICY = 'explicit-term-review-v1';
export const TRANSITION_TIME_ZONE = 'America/Indiana/Indianapolis';
export interface MeetingSchedule {
    weekday: number;
    hour: number;
    minute: number;
    durationMinutes: number;
}
export interface TermSchedule {
    firstSunday: string;
    firstTrainingWeek: number;
    weeks: number;
    mando: MeetingSchedule;
    llab: MeetingSchedule;
}
export interface TransitionPersonChange {
    personId: string;
    expectedVersion: number;
    asYear: DirectoryRecord['asYear'];
    rank: string;
    role: string;
    flightId: string | null;
    flightPathStatus: DirectoryRecord['flightPathStatus'];
}
export interface TransitionPlan {
    transitionId: string;
    kind: 'semester' | 'academic-year';
    sourceTermId: string;
    targetTerm: {
        termId: string;
        label: string;
        sortOrder: number;
    };
    policyVersion: typeof TRANSITION_POLICY;
    reviewReason: string;
    people: TransitionPersonChange[];
    schedule: TermSchedule;
}
function invalid(path: string, message = 'Invalid reviewed transition plan.'): never { throw new DomainError('INVALID_COMMAND', message, path); }
function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return invalid(path);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))
        return invalid(path);
    return row;
}
function text(value: unknown, path: string, max = 240, required = true): string {
    if (typeof value !== 'string' || value.length > max || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value) || (required && !value))
        return invalid(path);
    return value;
}
function integer(value: unknown, path: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
        return invalid(path);
    return Number(value);
}
function meeting(value: unknown, path: string): MeetingSchedule {
    const r = object(value, ['weekday', 'hour', 'minute', 'durationMinutes'], path);
    return { weekday: integer(r.weekday, path, 0, 6), hour: integer(r.hour, path, 0, 23),
        minute: integer(r.minute, path, 0, 59), durationMinutes: integer(r.durationMinutes, path, 1, 1440) };
}
export function parseTransitionPlan(value: unknown): TransitionPlan {
    const p = object(value, ['transitionId', 'kind', 'sourceTermId', 'targetTerm', 'policyVersion', 'reviewReason', 'people', 'schedule'], 'plan');
    const t = object(p.targetTerm, ['termId', 'label', 'sortOrder'], 'targetTerm');
    const s = object(p.schedule, ['firstSunday', 'firstTrainingWeek', 'weeks', 'mando', 'llab'], 'schedule');
    const firstSunday = text(s.firstSunday, 'firstSunday', 10), parsed = new Date(firstSunday + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(firstSunday) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== firstSunday || parsed.getUTCDay() !== 0)
        return invalid('firstSunday', 'Choose a real Sunday in the detachment time zone.');
    if (p.kind !== 'semester' && p.kind !== 'academic-year')
        return invalid('kind');
    if (p.policyVersion !== TRANSITION_POLICY || !Array.isArray(p.people) || p.people.length > 500)
        return invalid('people');
    const ids = new Set<string>();
    const people = p.people.map((value): TransitionPersonChange => {
        const r = object(value, ['personId', 'expectedVersion', 'asYear', 'rank', 'role', 'flightId', 'flightPathStatus'], 'people');
        const personId = adminIdentifier(r.personId);
        if (ids.has(personId) || !AS_YEARS.includes(r.asYear as DirectoryRecord['asYear']) || !FLIGHT_PATH_STATUSES.includes(r.flightPathStatus as DirectoryRecord['flightPathStatus']))
            return invalid('people');
        ids.add(personId);
        const result = { personId, expectedVersion: integer(r.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER),
            asYear: r.asYear as DirectoryRecord['asYear'], rank: text(r.rank, 'rank', 240, false), role: text(r.role, 'role', 240, false),
            flightId: r.flightId === null ? null : adminIdentifier(r.flightId), flightPathStatus: r.flightPathStatus as DirectoryRecord['flightPathStatus'] };
        if (operationallyActive(result) && result.flightId === null)
            return invalid('flightId', 'An operational cadet needs an explicit Flight.');
        return result;
    });
    if (Number(s.firstTrainingWeek) + Number(s.weeks) - 1 > 99)
        return invalid('schedule', 'Training weeks must remain within the reviewed 1–99 catalog bound.');
    const termId = adminIdentifier(t.termId);
    if (termId.length > 80 || termId === p.sourceTermId)
        return invalid('targetTerm');
    return { transitionId: adminIdentifier(p.transitionId), kind: p.kind, sourceTermId: adminIdentifier(p.sourceTermId),
        targetTerm: { termId, label: text(t.label, 'targetTerm.label'), sortOrder: integer(t.sortOrder, 'sortOrder', 0, 1000000) },
        policyVersion: TRANSITION_POLICY, reviewReason: text(p.reviewReason, 'reviewReason', 1000), people,
        schedule: { firstSunday, firstTrainingWeek: integer(s.firstTrainingWeek, 'firstTrainingWeek', 1, 99), weeks: integer(s.weeks, 'weeks', 1, 20), mando: meeting(s.mando, 'mando'), llab: meeting(s.llab, 'llab') } };
}
/** Preserve inactive/exceptional records. These suggestions have no mutation path until reviewed. */
export function suggestAcademicProgression(person: DirectoryRecord): {
    asYear: DirectoryRecord['asYear'];
    rank: string;
    requiresReview: true;
} {
    const next: Partial<Record<DirectoryRecord['asYear'], DirectoryRecord['asYear']>> = { AS100: 'AS200', AS150: 'AS250', AS200: 'AS300', AS250: 'AS300', AS300: 'AS400' };
    const asYear = operationallyActive(person) ? next[person.asYear] ?? person.asYear : person.asYear;
    const ranks: Record<string, string> = { AS100: 'C/4C', AS150: 'C/4C', AS200: 'C/3C', AS250: 'C/3C', AS500: 'C/3C', AS300: 'C/2d Lt', AS400: 'C/2d Lt' };
    return { asYear, rank: operationallyActive(person) ? ranks[asYear] ?? person.rank : person.rank, requiresReview: true };
}
function offsetDate(date: string, days: number): string { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
/** Resolve a local wall time and reject DST gaps/ambiguity instead of silently shifting an event. */
function localInstant(date: string, hour: number, minute: number): string {
    const desired = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TRANSITION_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const utc = Date.parse(desired + ':00Z');
    const candidates = [4, 5].map(offset => new Date(utc + offset * 3600000)).filter(d => formatter.format(d).replace(' ', 'T') === desired);
    if (candidates.length !== 1)
        return invalid('schedule', 'A scheduled local time is ambiguous or unavailable at a daylight-saving change.');
    return candidates[0].toISOString();
}
export function prepareTransition(plan: TransitionPlan, snapshot: FrontendSnapshot): {
    people: DirectoryRecord[];
    events: EventUpsert[];
} {
    const current = snapshot.terms.filter(t => t.isCurrent);
    if (snapshot.diagnostics.length || current.length !== 1 || current[0].termId !== plan.sourceTermId
        || snapshot.terms.some(t => t.termId === plan.targetTerm.termId || t.sortOrder === plan.targetTerm.sortOrder)
        || plan.targetTerm.sortOrder <= current[0].sortOrder)
        return invalid('sourceTermId', 'Resolve the current term and catalog before preparing a new term.');
    const changes = new Map(plan.people.map(p => [p.personId, p]));
    if (plan.people.some(p => !snapshot.people.some(existing => existing.personId === p.personId && existing.version === p.expectedVersion)))
        return invalid('people', 'A reviewed person or version is no longer current.');
    const people = snapshot.people.map(person => { const change = changes.get(person.personId); return change ? { ...person, ...change, version: person.version + 1, active: operationallyActive(change) } : person; });
    if (people.some(p => p.flightId && !snapshot.flights.some(f => f.flightId === p.flightId && f.squadronId)))
        return invalid('flightId');
    const flights = snapshot.flights.filter(f => f.squadronId).map(f => f.flightId);
    if (!flights.length)
        return invalid('schedule', 'At least one operational Flight is required.');
    const eligible = people.filter(p => p.active && p.flightId && flights.includes(p.flightId)).map(p => p.personId);
    const events: EventUpsert[] = [];
    for (let week = 0; week < plan.schedule.weeks; week++) {
        const trainingWeek = plan.schedule.firstTrainingWeek + week;
        const sunday = offsetDate(plan.schedule.firstSunday, week * 7);
        for (const type of ['mando', 'secondary', 'llab'] as const) {
            const config = type === 'secondary' ? null : plan.schedule[type];
            const startAt = config ? localInstant(offsetDate(sunday, config.weekday), config.hour, config.minute) : localInstant(sunday, 0, 0);
            const endAt = config ? new Date(Date.parse(startAt) + config.durationMinutes * 60000).toISOString() : localInstant(offsetDate(sunday, 6), 23, 59);
            const name = { mando: 'Mando PT', secondary: 'Secondary PT', llab: 'LLAB' }[type];
            events.push({ eventId: `${plan.targetTerm.termId}:tw${trainingWeek}:${type}`, expectedVersion: 0, termId: plan.targetTerm.termId,
                eventType: type, trainingWeek, displayOrder: events.length + 1, label: `TW-${trainingWeek} ${name}`, columnLabel: `${name} TW-${trainingWeek}`,
                expectedGroup: 'All Cadets', flightIds: flights, eligiblePersonIds: eligible, status: 'active', startAt, endAt, location: '', notes: '' });
        }
    }
    return { people, events };
}
