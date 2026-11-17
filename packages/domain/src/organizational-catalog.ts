/** Explicit current catalog commands. Captured request/event identities are immutable. */
import { adminIdentifier } from './admin.js';
import { DomainError, type ActorEvidence, type CommandSource, type Environment } from './index.js';
export interface FlightCatalogValue {
    flightId: string;
    label: string;
    squadronId: string;
    active: boolean;
}
export interface SquadronCatalogValue {
    squadronId: string;
    label: string;
}
export type CatalogCommand = {
    contractVersion: 1;
    commandId: string;
    environment: Environment;
    generation: number;
    actor: ActorEvidence;
    source: CommandSource;
} & ({
    operation: 'flight.upsert';
    payload: FlightCatalogValue & {
        expectedVersion: number;
        reason: string;
    };
} | {
    operation: 'squadron.upsert';
    payload: SquadronCatalogValue & {
        expectedVersion: number;
        reason: string;
    };
});
export interface OrganizationalCatalog {
    contractVersion: 1;
    environment: Environment;
    generation: number;
    revision: {
        operations: number;
        administration: number;
    };
    flights: (FlightCatalogValue & {
        version: number;
        rosterVersion: number | null;
    })[];
    squadrons: (SquadronCatalogValue & {
        version: number;
    })[];
}
const fail = (path: string): never => { throw new DomainError('INVALID_COMMAND', 'Use a reviewed versioned Flight or Squadron change.', path); };
const record = (v: unknown, keys: string[], path: string) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== keys.sort().join(','))
    return fail(path); return v as Record<string, unknown>; };
const integer = (v: unknown, path: string, min = 0) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : fail(path);
const text = (v: unknown, path: string, max = 120) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v) ? v : fail(path);
export function parseCatalogCommand(value: unknown): CatalogCommand {
    const c = record(value, ['contractVersion', 'commandId', 'environment', 'generation', 'actor', 'source', 'operation', 'payload'], 'command'), a = record(c.actor, ['principalId', 'evidence'], 'actor'), s = record(c.source, ['kind', 'resourceKey', 'submissionId', 'revision'], 'source');
    if (c.contractVersion !== 1 || !['local', 'staging'].includes(String(c.environment)) || !['sheet', 'test'].includes(String(s.kind)) || !['google-edit', 'authenticated-confirmation'].includes(String(a.evidence)) || a.evidence === 'google-edit' && s.kind !== 'sheet')
        return fail('envelope');
    const envelope = { contractVersion: 1 as const, commandId: adminIdentifier(c.commandId), environment: c.environment as Environment, generation: integer(c.generation, 'generation', 1), actor: { principalId: adminIdentifier(a.principalId), evidence: a.evidence as ActorEvidence['evidence'] }, source: { kind: s.kind as CommandSource['kind'], resourceKey: adminIdentifier(s.resourceKey), submissionId: adminIdentifier(s.submissionId), revision: integer(s.revision, 'source.revision', 1) } };
    if (c.operation === 'flight.upsert') {
        const p = record(c.payload, ['flightId', 'label', 'squadronId', 'active', 'expectedVersion', 'reason'], 'payload');
        if (typeof p.active !== 'boolean')
            return fail('payload.active');
        return { ...envelope, operation: 'flight.upsert', payload: { flightId: adminIdentifier(p.flightId), label: text(p.label, 'payload.label'), squadronId: adminIdentifier(p.squadronId), active: p.active, expectedVersion: integer(p.expectedVersion, 'payload.expectedVersion'), reason: text(p.reason, 'payload.reason', 2000) } };
    }
    if (c.operation === 'squadron.upsert') {
        const p = record(c.payload, ['squadronId', 'label', 'expectedVersion', 'reason'], 'payload');
        return { ...envelope, operation: 'squadron.upsert', payload: { squadronId: adminIdentifier(p.squadronId), label: text(p.label, 'payload.label'), expectedVersion: integer(p.expectedVersion, 'payload.expectedVersion'), reason: text(p.reason, 'payload.reason', 2000) } };
    }
    return fail('operation');
}
/** Pure review helper: expected version is derived from the captured ID, never a display label. */
export function prepareCatalogCommand(catalog: OrganizationalCatalog, envelope: Omit<CatalogCommand, 'operation' | 'payload'>, change: ({
    kind: 'flight';
    value: FlightCatalogValue;
} | {
    kind: 'squadron';
    value: SquadronCatalogValue;
}) & {
    reason: string;
}): CatalogCommand {
    if (catalog.contractVersion !== 1 || catalog.environment !== envelope.environment || catalog.generation !== envelope.generation)
        fail('catalog');
    if (change.kind === 'flight') {
        const prior = catalog.flights.find(f => f.flightId === change.value.flightId);
        if (!catalog.squadrons.some(s => s.squadronId === change.value.squadronId))
            fail('payload.squadronId');
        return parseCatalogCommand({ ...envelope, operation: 'flight.upsert', payload: { ...change.value, expectedVersion: prior?.version ?? 0, reason: change.reason } });
    }
    const prior = catalog.squadrons.find(s => s.squadronId === change.value.squadronId);
    return parseCatalogCommand({ ...envelope, operation: 'squadron.upsert', payload: { ...change.value, expectedVersion: prior?.version ?? 0, reason: change.reason } });
}
/** Canonical current role titles follow an unambiguous Flight rename; arbitrary prose is preserved. */
export function renamedFlightRole(value: string, before: string, after: string): string {
    const normal = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
    for (const prefix of ['', 'Cadet '])
        for (const role of ['Flight Commander', 'Deputy Flight Commander'])
            if (normal(value) === normal(`${prefix}${before} ${role}`))
                return `${prefix}${after} ${role}`;
    return value;
}
