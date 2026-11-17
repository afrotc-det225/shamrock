import { directoryLeadershipRole, type DirectoryRecord, type FrontendSnapshot, type SnapshotRevision } from './admin.js';
import type { PermissionFlight, PermissionMember } from './permissions.js';
import { FRONTEND_SECTION_BOUNDS, frontendAttendanceVersions } from './frontend-transport.js';
import { REPORTING_POLICY_VERSION, type FrontendReportingInput } from './frontend-reporting.js';

/** The panel is a separate read surface. Existing spreadsheet authority is unchanged. */
export const PANEL_PAGE_VERSION = 'panel-pages-v1' as const;
export const PANEL_SECTIONS = ['people', 'flights', 'squadrons', 'terms', 'events', 'eventRosters', 'eventFlights', 'observations', 'requests', 'corrections', 'legacyBaselines'] as const;
export type PanelSection = typeof PANEL_SECTIONS[number];
export interface PanelRevision extends SnapshotRevision { access: string; }
export interface PanelAccess {
    mode: 'wing' | 'scoped';
    flightIds: string[];
    capabilities: { fullSnapshot: boolean; attendanceReportFlightIds: string[]; attendanceCorrectionFlightIds: string[]; };
}
export interface PanelPage {
    contractVersion: typeof PANEL_PAGE_VERSION;
    environment: FrontendSnapshot['environment'];
    generation: number;
    section: PanelSection | 'manifest' | 'verify';
    revision: PanelRevision;
    scope: { termId: string; currentTermId: string; };
    access: PanelAccess;
    sections?: { section: PanelSection; count: number; }[];
    offset?: number;
    nextOffset?: number | null;
    rows?: Record<string, unknown>[];
    verified?: true;
}
export interface PanelSnapshot extends Pick<FrontendSnapshot, 'environment' | 'generation' | 'flights' | 'squadrons' | 'terms' | 'eventFlights' | 'observations' | 'corrections' | 'legacyBaselines' | 'attendanceVersions'> {
    contractVersion: 'panel-snapshot-v1';
    revision: PanelRevision;
    scope: PanelPage['scope'];
    access: PanelAccess;
    people: (Pick<DirectoryRecord, 'personId' | 'version' | 'flightId' | 'lastName' | 'firstName' | 'rank' | 'asYear' | 'flightPathStatus'> & { active: true; })[];
    events: Omit<FrontendSnapshot['events'][number], 'notes'>[];
    requests: (Omit<FrontendSnapshot['requests'][number], 'submittedBy' | 'decidedBy'> & { personDisplayName: string; canDecide: boolean; })[];
}
export interface PanelAuthority {
    active: boolean;
    permissionManager: boolean;
    explicitAdminGrants: { capability: string; kind: string; scope: string; }[];
    effectiveAdminGrants: { capability: string; kind: string; scope: string; }[];
    explicitAccessGrants: { capability: string; flightId: string; subjectScope: string; }[];
    effectiveAccessGrants: { capability: string; flightId: string; subjectScope: string; }[];
    member: PermissionMember | null;
    commanderSquadronIds: string[];
    flights: PermissionFlight[];
    squadrons: { squadronId: string; label: string; }[];
}
const normalized = (value: string) => value.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const unique = (values: string[]) => [...new Set(values)].sort();

/** Only fresh server-side role evidence belongs here; broad derived Sheets grants do not establish panel scope. */
export function resolvePanelAccess(authority: PanelAuthority): PanelAccess | null {
    if (!authority.active) return null;
    const wingRead = (g: { capability: string; kind: string; scope: string; }) => g.capability === 'frontend.read' && g.kind === 'wing' && g.scope === '*';
    const fullSnapshot = authority.explicitAdminGrants.some(wingRead)
        || authority.permissionManager && authority.effectiveAdminGrants.some(wingRead);
    const flightIds = new Set<string>(fullSnapshot ? authority.flights.map(f => f.flightId) : []);
    for (const grant of authority.explicitAdminGrants) {
        if (grant.capability === 'frontend.read' && grant.kind === 'flight' && authority.flights.some(f => f.flightId === grant.scope)) flightIds.add(grant.scope);
    }
    const member = authority.member;
    if (member && (member.linkedContactActive === null || member.linkedContactActive === 1)) {
        const ownFlight = authority.flights.find(f => f.flightId === member.sourceFlightId);
        const ownSquadron = authority.squadrons.find(s => s.squadronId === ownFlight?.squadronId);
        const role = member.sourceKind === 'directory'
            ? directoryLeadershipRole(member.sourceRole, ownFlight?.label ?? '', ownSquadron?.label ?? '')
            : member.sourceRole;
        const matches = authority.flights.filter(f => [normalized(`${f.label} Flight Commander`), normalized(`${f.label} Deputy Flight Commander`)].includes(normalized(role ?? '')));
        // Ambiguous labels and a Directory role inconsistent with its actual assignment fail closed.
        if (matches.length === 1 && (member.sourceKind === 'leadership' || matches[0].flightId === member.sourceFlightId)) flightIds.add(matches[0].flightId);
        for (const flight of authority.flights) if (flight.squadronId && authority.commanderSquadronIds.includes(flight.squadronId)) flightIds.add(flight.flightId);
    }
    // A retained Squadron decision may be readable even when that Squadron has no current Flights.
    const decisionReader = authority.commanderSquadronIds.length > 0
        || authority.explicitAccessGrants.some(g => g.capability === 'excusal.decide' && g.subjectScope === 'unit');
    if (!fullSnapshot && !flightIds.size && !decisionReader) return null;
    const ids = unique([...flightIds]);
    return {
        mode: fullSnapshot ? 'wing' : 'scoped', flightIds: ids,
        capabilities: {
            fullSnapshot,
            attendanceReportFlightIds: ids.filter(id => authority.effectiveAccessGrants.some(g => g.capability === 'attendance.report' && g.subjectScope === 'unit' && g.flightId === id)),
            attendanceCorrectionFlightIds: ids.filter(id => authority.effectiveAdminGrants.some(g => g.capability === 'attendance.correct' && (g.kind === 'wing' && g.scope === '*' || g.kind === 'flight' && g.scope === id))),
        },
    };
}

const assertPage: (condition: unknown) => asserts condition = condition => { if (!condition) throw new Error('INVALID_PANEL_PAGE_SEQUENCE'); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A panel snapshot intentionally has no Directory/contact payload. Never cast it to FrontendSnapshot. */
export function assemblePanelSnapshotPages(manifest: PanelPage, pages: PanelPage[], verified: PanelPage): PanelSnapshot {
    const coherent = (page: PanelPage) => page?.contractVersion === PANEL_PAGE_VERSION && page.environment === manifest.environment && page.generation === manifest.generation
        && same(page.revision, manifest.revision) && same(page.scope, manifest.scope) && same(page.access, manifest.access);
    assertPage(manifest?.contractVersion === PANEL_PAGE_VERSION && manifest.section === 'manifest' && coherent(verified) && verified.section === 'verify' && verified.verified === true);
    assertPage(['local', 'staging'].includes(manifest.environment) && Number.isSafeInteger(manifest.generation) && manifest.generation > 0);
    assertPage(manifest.scope?.termId === manifest.scope?.currentTermId && typeof manifest.scope.termId === 'string');
    assertPage(manifest.revision && [manifest.revision.operations, manifest.revision.administration].every(v => Number.isSafeInteger(v) && v >= 0) && /^[a-f0-9]{64}$/.test(manifest.revision.access));
    assertPage(manifest.sections?.length === PANEL_SECTIONS.length && manifest.sections.every((s, i) => s.section === PANEL_SECTIONS[i] && Number.isSafeInteger(s.count) && s.count >= 0 && s.count <= FRONTEND_SECTION_BOUNDS[s.section]));
    const data = {} as Record<PanelSection, Record<string, unknown>[]>; let pageIndex = 0;
    for (const entry of manifest.sections) {
        const rows: Record<string, unknown>[] = []; let offset = 0;
        do {
            const page = pages[pageIndex++];
            assertPage(coherent(page) && page.section === entry.section && page.offset === offset && Array.isArray(page.rows) && page.rows.length <= 256 && offset + page.rows.length <= entry.count);
            rows.push(...page.rows); offset += page.rows.length;
            assertPage(page.nextOffset === (offset < entry.count ? offset : null) && (page.rows.length > 0 || entry.count === 0));
        } while (offset < entry.count);
        assertPage(rows.length === entry.count); data[entry.section] = rows;
    }
    assertPage(pageIndex === pages.length);
    const people = data.people.map(p => ({ ...p, active: true as const })) as PanelSnapshot['people'];
    const ids = new Set(people.map(p => p.personId));
    assertPage(ids.size === people.length && people.every(p => manifest.access.flightIds.includes(String(p.flightId))));
    const eligible = new Map<string, string[]>();
    for (const row of data.eventRosters) {
        assertPage(typeof row.eventId === 'string' && typeof row.personId === 'string' && ids.has(row.personId));
        const members = eligible.get(row.eventId) ?? []; assertPage(!members.includes(row.personId)); members.push(row.personId); eligible.set(row.eventId, members);
    }
    const events = data.events.map(({ hasRoster, ...e }) => ({ ...e, eligiblePersonIds: hasRoster === 1 ? eligible.get(String(e.eventId)) ?? [] : null })) as PanelSnapshot['events'];
    const eventsById = new Set(events.map(e => e.eventId));
    assertPage(eventsById.size === events.length && events.every(e => e.termId === manifest.scope.termId));
    assertPage(data.eventRosters.every(r => eventsById.has(String(r.eventId))));
    const terms = data.terms.map(t => ({ ...t, isCurrent: t.isCurrent === 1 })) as PanelSnapshot['terms'];
    assertPage(terms.length === 1 && terms[0].isCurrent && terms[0].termId === manifest.scope.termId);
    assertPage(data.requests.every(r => typeof r.canDecide === 'boolean' && typeof r.personDisplayName === 'string' && eventsById.has(String(r.eventId))));
    for (const section of ['observations', 'corrections', 'legacyBaselines'] as const) assertPage(data[section].every(r => ids.has(String(r.personId)) && eventsById.has(String(r.eventId))));
    return {
        contractVersion: 'panel-snapshot-v1', environment: manifest.environment, generation: manifest.generation, revision: manifest.revision, scope: manifest.scope, access: manifest.access,
        people, flights: data.flights as unknown as PanelSnapshot['flights'], squadrons: data.squadrons as unknown as PanelSnapshot['squadrons'], terms, events,
        eventFlights: data.eventFlights as unknown as PanelSnapshot['eventFlights'], observations: data.observations as unknown as PanelSnapshot['observations'],
        corrections: data.corrections as unknown as PanelSnapshot['corrections'], legacyBaselines: data.legacyBaselines as unknown as PanelSnapshot['legacyBaselines'],
        requests: data.requests as unknown as PanelSnapshot['requests'],
        attendanceVersions: frontendAttendanceVersions([...data.observations, ...data.requests.filter(r => ids.has(String(r.personId))), ...data.corrections, ...data.legacyBaselines]),
    };
}

/** Reuse the established credit/precedence rules without reading birthdays or fabricating private profile fields. */
export function panelSnapshotToReportingInput(snapshot: PanelSnapshot, asOfDate: string): FrontendReportingInput {
    const people = snapshot.people.map(p => ({ personId: p.personId, lastName: p.lastName, firstName: p.firstName, asYear: p.asYear,
        flightId: p.flightId, flightPathStatus: p.flightPathStatus, dateOfBirth: null }));
    const ids = new Set(people.map(p => p.personId));
    const flights = snapshot.flights.map(f => { assertPage(f.squadronId); return { flightId: f.flightId, label: f.label, squadronId: f.squadronId }; });
    return {
        policyVersion: REPORTING_POLICY_VERSION, asOfDate, currentTermId: snapshot.scope.currentTermId, people, flights, squadrons: snapshot.squadrons,
        terms: snapshot.terms.map(t => ({ termId: t.termId, label: t.label, sortOrder: t.sortOrder })),
        events: snapshot.events.map(e => ({ eventId: e.eventId, termId: e.termId, label: e.columnLabel || e.label, type: e.eventType, trainingWeek: e.trainingWeek, displayOrder: e.displayOrder, eligiblePersonIds: e.eligiblePersonIds })),
        observations: snapshot.observations, corrections: snapshot.corrections, legacyBaselines: snapshot.legacyBaselines,
        // Retained request-only people belong in the queue, not a fabricated attendance roster.
        requests: snapshot.requests.filter(r => ids.has(r.personId)).map(r => ({ requestId: r.requestId, personId: r.personId, eventId: r.eventId, order: r.order,
            status: r.status as FrontendReportingInput['requests'][number]['status'], requestedOutcome: r.requestedOutcome as FrontendReportingInput['requests'][number]['requestedOutcome'], ...(r.legacyStateOnly ? { legacyStateOnly: true } : {}) })),
    };
}
