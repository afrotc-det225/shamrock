/** Trusted role policy. Identity bindings and privileged assignments are reviewed separately from Form answers. */
import { directoryLeadershipRole, operationallyActive, type DirectoryRecord } from './admin.js';
export interface PermissionAccount {
    principalId: string;
    email: string;
    personId: string | null;
    active: boolean;
}
export interface PermissionContact {
    contactId: string;
    version: number;
    personId: string | null;
    role: string;
    email: string;
    active: boolean;
}
export interface PermissionFlight {
    flightId: string;
    label: string;
    squadronId: string | null;
}
export interface PermissionMember {
    principalId: string;
    sourceKind: 'directory' | 'leadership';
    sourceId: string;
    sourceVersion: number;
    linkedContactId: string | null;
    linkedContactVersion: number | null;
    sourceRole: string;
    sourceFlightId: string | null;
    sourceStatus: string | null;
    linkedContactActive: number | null;
}
export interface RolePermissionPolicy {
    policyVersion: 'det225-leadership-permissions-v1';
    members: PermissionMember[];
    accounts: PermissionAccount[];
    accessGrants: {
        principalId: string;
        capability: 'attendance.report' | 'excusal.submit' | 'excusal.decide';
        flightId: string;
        subjectScope: 'self' | 'unit';
    }[];
    adminGrants: {
        principalId: string;
        capability: 'leadership.manage' | 'frontend.read' | 'attendance.correct';
        scopeKind: 'wing';
        scopeKey: '*';
    }[];
    google: {
        permissionManagers: string[];
        leadershipEditors: string[];
        attendanceEditors: string[];
        squadronCommanders: {
            squadronId: string;
            email: string;
        }[];
        excusalViewers: string[];
    };
    diagnostics: {
        code: string;
        key: string;
    }[];
}
const normalized = (value: string) => value.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
const unique = (values: string[]) => [...new Set(values)].sort();
export function buildRolePermissionPolicy(input: {
    people: DirectoryRecord[];
    contacts: PermissionContact[];
    accounts: PermissionAccount[];
    flights: PermissionFlight[];
    squadrons: {
        squadronId: string;
        label: string;
    }[];
    operationalSquadronIds: string[];
    managerPrincipalIds?: string[];
}): RolePermissionPolicy {
    if (input.people.length > 500 || input.contacts.length > 200 || input.accounts.length > 1000 || input.flights.length > 50 || input.squadrons.length > 20)
        throw new Error('Permission policy exceeds its reviewed bounds.');
    const result: RolePermissionPolicy = { policyVersion: 'det225-leadership-permissions-v1', members: [], accounts: [], accessGrants: [], adminGrants: [], google: { permissionManagers: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [], excusalViewers: [] }, diagnostics: [] };
    const leaders: {
        principalId: string;
        email: string;
        role: string;
    }[] = [];
    for (const account of [...input.accounts].sort((a, b) => a.principalId.localeCompare(b.principalId))) {
        if (!account.active)
            continue;
        const email = account.email.trim().toLowerCase();
        if (!email || input.accounts.filter(a => a.active && a.email.trim().toLowerCase() === email).length !== 1) {
            result.diagnostics.push({ code: 'ambiguous_account', key: account.principalId });
            continue;
        }
        if (input.managerPrincipalIds?.includes(account.principalId)) {
            result.google.permissionManagers.push(email);
            result.accounts.push({ ...account, email });
        }
        const person = account.personId ? input.people.find(p => p.personId === account.personId && p.email.trim().toLowerCase() === email && p.active && operationallyActive(p)) : undefined;
        const contacts = input.contacts.filter(c => c.personId === account.personId && c.personId !== null);
        if (contacts.length > 1) {
            result.diagnostics.push({ code: 'ambiguous_linked_contact', key: account.principalId });
            continue;
        }
        if (person) {
            const flight = input.flights.find(f => f.flightId === person.flightId);
            if (!flight) {
                result.diagnostics.push({ code: 'missing_flight', key: person.personId });
                continue;
            }
            const contact = contacts[0];
            if (!result.accounts.some(a => a.principalId === account.principalId))
                result.accounts.push({ ...account, email });
            result.members.push({ principalId: account.principalId, sourceKind: 'directory', sourceId: person.personId, sourceVersion: person.version, linkedContactId: contact?.contactId ?? null, linkedContactVersion: contact?.version ?? null, sourceRole: person.role, sourceFlightId: person.flightId, sourceStatus: person.flightPathStatus, linkedContactActive: contact ? Number(contact.active) : null });
            result.accessGrants.push({ principalId: account.principalId, capability: 'excusal.submit', flightId: flight.flightId, subjectScope: 'self' });
            const squadron = input.squadrons.find(s => s.squadronId === flight.squadronId);
            const role = directoryLeadershipRole(person.role, flight.label, squadron?.label ?? '');
            if (role && (!contact || contact.active))
                leaders.push({ principalId: account.principalId, email, role });
        }
        else if (!account.personId) {
            const manual = input.contacts.filter(c => c.personId === null && c.active && c.email.trim().toLowerCase() === email);
            if (manual.length !== 1) {
                if (manual.length)
                    result.diagnostics.push({ code: 'ambiguous_manual_contact', key: account.principalId });
                continue;
            }
            const contact = manual[0];
            if (!result.accounts.some(a => a.principalId === account.principalId))
                result.accounts.push({ ...account, email });
            result.members.push({ principalId: account.principalId, sourceKind: 'leadership', sourceId: contact.contactId, sourceVersion: contact.version, linkedContactId: null, linkedContactVersion: null, sourceRole: contact.role, sourceFlightId: null, sourceStatus: null, linkedContactActive: null });
            leaders.push({ principalId: account.principalId, email, role: contact.role });
        }
    }
    for (const leader of leaders) {
        for (const capability of ['leadership.manage', 'frontend.read', 'attendance.correct'] as const)
            result.adminGrants.push({ principalId: leader.principalId, capability, scopeKind: 'wing', scopeKey: '*' });
        for (const flight of input.flights)
            result.accessGrants.push({ principalId: leader.principalId, capability: 'attendance.report', flightId: flight.flightId, subjectScope: 'unit' });
        result.google.leadershipEditors.push(leader.email);
        result.google.attendanceEditors.push(leader.email);
        const role = normalized(leader.role);
        if (['wing commander', 'cadet wing commander'].includes(role) || input.flights.some(f => [normalized(`${f.label} Flight Commander`), normalized(`${f.label} Deputy Flight Commander`)].includes(role)))
            result.google.excusalViewers.push(leader.email);
    }
    for (const squadron of input.squadrons.filter(s => input.operationalSquadronIds.includes(s.squadronId) && ['blue', 'gold'].includes(normalized(s.label)))) {
        const commanders = leaders.filter(l => normalized(l.role) === normalized(`${squadron.label} Squadron Commander`));
        if (commanders.length > 1) {
            result.diagnostics.push({ code: 'ambiguous_squadron_commander', key: squadron.squadronId });
            continue;
        }
        if (!commanders.length)
            continue;
        const commander = commanders[0];
        result.google.squadronCommanders.push({ squadronId: squadron.squadronId, email: commander.email });
        for (const flight of input.flights.filter(f => f.squadronId === squadron.squadronId))
            result.accessGrants.push({ principalId: commander.principalId, capability: 'excusal.decide', flightId: flight.flightId, subjectScope: 'unit' });
    }
    result.google.leadershipEditors = unique(result.google.leadershipEditors);
    result.google.attendanceEditors = unique(result.google.attendanceEditors);
    result.google.excusalViewers = unique(result.google.excusalViewers.filter(email => !result.google.squadronCommanders.some(c => c.email === email)));
    if (result.accessGrants.length > 5000 || JSON.stringify(result).length > 500000)
        throw new Error('Permission policy exceeds its reviewed publication bound.');
    return result;
}
