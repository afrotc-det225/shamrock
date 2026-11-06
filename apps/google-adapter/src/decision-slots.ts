/** Append-only decision identities. Protected origin metadata travels with a whole
 * row sort; captured drafts stay bound to their original request version. */
import { AdapterError, type AdapterConfig, type DecisionSlot, type Signer } from './index.js';
import type { SheetPort } from './apps-script.js';
import { parseProjectionSnapshot, type ProjectionSnapshot } from './projection.js';

export const DECISION_HEADERS = ['slot_id', 'request_id', 'base_version', 'draft_decision', 'draft_id', 'draft_state', 'draft_json'] as const;
const LEGACY_DYNAMIC_HEADERS = [...DECISION_HEADERS, 'event_id', 'unit_id', 'person_id', 'event_label', 'display_name', 'requested_outcome', 'recorded_status'] as const;
export const DYNAMIC_DECISION_HEADERS = [...LEGACY_DYNAMIC_HEADERS, 'slot_origin_row', 'slot_context_hash'] as const;
const DISPLAY_HEADERS = ['Slot ID', 'Request ID', 'Version being decided', 'Choose decision', 'Draft ID', 'Delivery status', 'Saved draft', 'Event ID', 'Flight ID', 'Person ID', 'Event', 'Name', 'Requested outcome', 'Status at this version', 'Original slot allocation', 'Protected context digest'];
export interface DynamicSlotBinding { resourceKey: string; mode: 'projection'; maxSlots: number }
export interface DynamicSlotContext { binding: DynamicSlotBinding; config: AdapterConfig; signer: Signer }
export interface LocatedDecisionSlot extends DecisionSlot { row: number }

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
export function decisionColumns(sheet: SheetPort, dynamic = false): Record<string, number> {
  return columnsFor(sheet, dynamic ? DYNAMIC_DECISION_HEADERS : DECISION_HEADERS);
}
function columnsFor(sheet: SheetPort, required: readonly string[]): Record<string, number> {
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() !== required.length) fail('invalid_draft_schema', 'The decision input schema needs paused setup review.');
  const headers = sheet.getRange(1, 1, 1, required.length).getValues()[0];
  if (new Set(headers).size !== headers.length || required.some(h => !headers.includes(h))) fail('invalid_draft_schema', 'Decision input headers are missing or duplicated.');
  return Object.fromEntries(required.map(h => [h, headers.indexOf(h) + 1]));
}
function slotIdentity(row: number, requestId: string, version: number, ctx: DynamicSlotContext): string {
  const hash = ctx.signer.sha256(JSON.stringify(['decision-slot-v1', ctx.config.environment, ctx.config.generation, ctx.binding.resourceKey, row, requestId, version]));
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_signer', 'The decision slot digest is invalid.');
  return `slot.${hash}`;
}
function contextIdentity(get: (name: string) => unknown, ctx: DynamicSlotContext): string {
  const hash = ctx.signer.sha256(JSON.stringify(['decision-slot-context-v1', ctx.config.environment, ctx.config.generation, ctx.binding.resourceKey,
    ...['slot_id', 'slot_origin_row', 'request_id', 'base_version', 'event_id', 'unit_id', 'person_id', 'event_label', 'display_name', 'requested_outcome', 'recorded_status'].map(get),
  ]));
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_signer', 'The decision context digest is invalid.');
  return hash;
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function validLabel(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !value.includes('\0'); }
export function readDynamicDecisionSlots(sheet: SheetPort, ctx: DynamicSlotContext): { slots: LocatedDecisionSlot[]; columns: Record<string, number>; values: unknown[][] } {
  return readSlots(sheet, ctx, false);
}
function readSlots(sheet: SheetPort, ctx: DynamicSlotContext, legacy: boolean): { slots: LocatedDecisionSlot[]; columns: Record<string, number>; values: unknown[][] } {
  const headers = legacy ? LEGACY_DYNAMIC_HEADERS : DYNAMIC_DECISION_HEADERS;
  const columns = columnsFor(sheet, headers);
  const count = sheet.getLastRow() - 2;
  if (!Number.isSafeInteger(ctx.binding.maxSlots) || ctx.binding.maxSlots < 1 || ctx.binding.maxSlots > 500 || count > ctx.binding.maxSlots) fail('decision_slots_full', 'Decision slots reached their reviewed capacity. Pause and archive/review slots before increasing the bound; no draft was discarded.');
  const values = count ? sheet.getRange(3, 1, count, headers.length).getValues() : [];
  const seen = new Set<string>(); const origins = new Set<number>();
  const slots = values.map((cells, index) => {
    const row = index + 3;
    const get = (name: string) => cells[columns[name] - 1];
    const requestId = get('request_id'); const baseVersion = get('base_version'); const slotId = get('slot_id');
    const origin = legacy ? row : get('slot_origin_row');
    if (!validId(requestId) || typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1
      || typeof origin !== 'number' || !Number.isSafeInteger(origin) || origin < 3 || origins.has(origin)
      || slotId !== slotIdentity(origin, requestId, baseVersion, ctx) || !validId(get('event_id')) || !validId(get('unit_id')) || !validId(get('person_id'))
      || !validLabel(get('event_label')) || !validLabel(get('display_name'))
      || !['Submitted', 'Approved', 'Denied', 'Withdrawn', 'Superseded'].includes(String(get('recorded_status')))
      || !['P', 'T', 'E', 'ES', 'MED'].includes(String(get('requested_outcome')))
      || (!legacy && get('slot_context_hash') !== contextIdentity(get, ctx))) fail('draft_target_changed', 'A decision row has changed or incomplete protected metadata. Retain its input and restore the complete original row before retrying.');
    const identity = `${requestId}\n${baseVersion}`;
    if (seen.has(identity)) fail('draft_target_changed', 'A request version has duplicate decision slots.');
    seen.add(identity); origins.add(origin);
    return { row, slotId, requestId, baseVersion } as LocatedDecisionSlot;
  });
  return { slots, columns, values };
}

/** Caller is paused, holds the shared ScriptLock, and has verified whole-tab
 * protection and enough grid columns. Legacy rows must still be in their original
 * positions. Only the new metadata columns are written during an additive upgrade. */
export function initializeDynamicDecisionSlots(sheet: SheetPort, ctx?: DynamicSlotContext): void {
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 2, DYNAMIC_DECISION_HEADERS.length).setValues([[...DYNAMIC_DECISION_HEADERS], [...DISPLAY_HEADERS]]);
  if (sheet.getLastColumn() === LEGACY_DYNAMIC_HEADERS.length) {
    if (!ctx) fail('invalid_draft_schema', 'Paused decision schema upgrade requires the reviewed slot identity context.');
    const legacy = readSlots(sheet, ctx, true);
    const before = sheet.getRange(1, 1, legacy.slots.length + 2, LEGACY_DYNAMIC_HEADERS.length).getValues();
    sheet.getRange(1, LEGACY_DYNAMIC_HEADERS.length + 1, legacy.slots.length + 2, 2).setValues([
      ['slot_origin_row', 'slot_context_hash'], ['Original slot allocation', 'Protected context digest'], ...legacy.slots.map(slot => [slot.row, contextIdentity(
        name => name === 'slot_origin_row' ? slot.row : legacy.values[slot.row - 3][legacy.columns[name] - 1], ctx,
      )]),
    ]);
    if (JSON.stringify(sheet.getRange(1, 1, legacy.slots.length + 2, LEGACY_DYNAMIC_HEADERS.length).getValues()) !== JSON.stringify(before)) {
      fail('draft_capture_failed', 'Decision inputs changed during the paused schema upgrade; retain all rows for review.');
    }
  }
  decisionColumns(sheet, true);
  if (ctx) readDynamicDecisionSlots(sheet, ctx);
}

/** Runs under the projection lock after output read-back and before ACK. Existing
 * rows, draft inputs, captured payloads and target versions are never written. */
export function appendProjectionDecisionSlots(input: ProjectionSnapshot, sheet: SheetPort, ctx: DynamicSlotContext): { appended: number } {
  const snapshot = parseProjectionSnapshot(input);
  const current = readDynamicDecisionSlots(sheet, ctx);
  const additions: unknown[][] = [];
  const lastOrigin = Math.max(2, ...current.values.map(row => row[current.columns.slot_origin_row - 1] as number));
  for (const person of snapshot.rows) for (const request of person.requests) {
    const versions = current.slots.filter(slot => slot.requestId === request.requestId);
    for (const old of versions) {
      const cells = current.values[old.row - 3];
      const get = (name: string) => cells[current.columns[name] - 1];
      if (get('event_id') !== snapshot.event.eventId || get('unit_id') !== snapshot.unit.unitId || get('person_id') !== person.personId
        || get('requested_outcome') !== request.requestedOutcome) fail('draft_target_changed', 'The recorded request identity changed; retain its original decision slots for review.');
      if (old.baseVersion > request.version) fail('projection_rollback', 'An older snapshot cannot create an earlier decision slot.');
      if (old.baseVersion === request.version && get('recorded_status') !== request.status) fail('projection_conflict', 'The same request version changed its recorded decision.');
    }
    if (versions.some(slot => slot.baseVersion === request.version)) continue;
    const origin = lastOrigin + additions.length + 1;
    if (!Number.isSafeInteger(origin)) fail('decision_slots_full', 'Decision slot allocation needs paused review.');
    const record: Record<string, unknown> = {
      slot_id: slotIdentity(origin, request.requestId, request.version, ctx), slot_origin_row: origin, request_id: request.requestId, base_version: request.version,
      draft_decision: '', draft_id: '', draft_state: 'Ready for decision', draft_json: '',
      event_id: snapshot.event.eventId, unit_id: snapshot.unit.unitId, person_id: person.personId,
      event_label: snapshot.event.label, display_name: person.displayName, requested_outcome: request.requestedOutcome, recorded_status: request.status,
    };
    record.slot_context_hash = contextIdentity(name => record[name], ctx);
    additions.push(Array.from({ length: DYNAMIC_DECISION_HEADERS.length }, (_, index) => record[Object.keys(current.columns).find(key => current.columns[key] === index + 1)!]));
  }
  if (current.slots.length + additions.length > ctx.binding.maxSlots) fail('decision_slots_full', 'Decision slots reached their reviewed capacity. Pause and archive/review slots before increasing the bound; no draft was discarded.');
  if (!additions.length) return { appended: 0 };
  const start = current.slots.length + 3;
  const before = sheet.getRange(start, 1, additions.length, DYNAMIC_DECISION_HEADERS.length).getValues();
  if (before.some(row => row.some(cell => cell !== ''))) fail('draft_target_changed', 'The next decision rows contain unsaved input; preserve them for review.');
  // Never write the editable input column, even when allocating an empty row.
  const inputColumn = current.columns.draft_decision;
  if (inputColumn > 1) sheet.getRange(start, 1, additions.length, inputColumn - 1).setValues(additions.map(row => row.slice(0, inputColumn - 1)));
  if (inputColumn < DYNAMIC_DECISION_HEADERS.length) sheet.getRange(start, inputColumn + 1, additions.length, DYNAMIC_DECISION_HEADERS.length - inputColumn).setValues(additions.map(row => row.slice(inputColumn)));
  const actual = readDynamicDecisionSlots(sheet, ctx);
  const expected = [...current.values, ...additions];
  if (JSON.stringify(actual.values) !== JSON.stringify(expected)) fail('draft_capture_failed', 'Decision slots did not read back exactly. Retain the projection claim and review the partial write.');
  return { appended: additions.length };
}
