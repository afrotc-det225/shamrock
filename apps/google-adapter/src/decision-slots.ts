/** Append-only decision inputs. Every slot is bound to its original physical row and
 * request version. Filter views are safe; moving underlying rows requires review. */
import { AdapterError, type AdapterConfig, type DecisionSlot, type Signer } from './index.js';
import type { SheetPort } from './apps-script.js';
import { parseProjectionSnapshot, type ProjectionSnapshot } from './projection.js';

export const DECISION_HEADERS = ['slot_id', 'request_id', 'base_version', 'draft_decision', 'draft_id', 'draft_state', 'draft_json'] as const;
export const DYNAMIC_DECISION_HEADERS = [...DECISION_HEADERS, 'event_id', 'unit_id', 'person_id', 'event_label', 'display_name', 'requested_outcome', 'recorded_status'] as const;
const DISPLAY_HEADERS = ['Slot ID', 'Request ID', 'Version being decided', 'Choose decision', 'Draft ID', 'Delivery status', 'Saved draft', 'Event ID', 'Unit ID', 'Person ID', 'Event', 'Name', 'Requested outcome', 'Status at this version'];
export interface DynamicSlotBinding { resourceKey: string; mode: 'projection'; maxSlots: number }
export interface DynamicSlotContext { binding: DynamicSlotBinding; config: AdapterConfig; signer: Signer }
export interface LocatedDecisionSlot extends DecisionSlot { row: number }

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
export function decisionColumns(sheet: SheetPort, dynamic = false): Record<string, number> {
  const required = dynamic ? DYNAMIC_DECISION_HEADERS : DECISION_HEADERS;
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
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
export function readDynamicDecisionSlots(sheet: SheetPort, ctx: DynamicSlotContext): { slots: LocatedDecisionSlot[]; columns: Record<string, number>; values: unknown[][] } {
  const columns = decisionColumns(sheet, true);
  const count = sheet.getLastRow() - 2;
  if (!Number.isSafeInteger(ctx.binding.maxSlots) || ctx.binding.maxSlots < 1 || ctx.binding.maxSlots > 500 || count > ctx.binding.maxSlots) fail('decision_slots_full', 'Decision slots reached their reviewed capacity. Pause and archive/review slots before increasing the bound; no draft was discarded.');
  const values = count ? sheet.getRange(3, 1, count, DYNAMIC_DECISION_HEADERS.length).getValues() : [];
  const seen = new Set<string>();
  const slots = values.map((cells, index) => {
    const row = index + 3;
    const get = (name: string) => cells[columns[name] - 1];
    const requestId = get('request_id'); const baseVersion = get('base_version'); const slotId = get('slot_id');
    if (!validId(requestId) || typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1
      || slotId !== slotIdentity(row, requestId, baseVersion, ctx) || !validId(get('event_id')) || !validId(get('unit_id')) || !validId(get('person_id'))
      || !['Submitted', 'Approved', 'Denied', 'Withdrawn', 'Superseded'].includes(String(get('recorded_status')))
      || !['P', 'T', 'E', 'ES', 'MED'].includes(String(get('requested_outcome')))) fail('draft_target_changed', 'A decision row was moved, edited, or partially written. Restore its original position and metadata before retrying.');
    const identity = `${requestId}\n${baseVersion}`;
    if (seen.has(identity)) fail('draft_target_changed', 'A request version has duplicate decision slots.');
    seen.add(identity);
    return { row, slotId, requestId, baseVersion } as LocatedDecisionSlot;
  });
  return { slots, columns, values };
}

/** Caller holds the shared ScriptLock and has verified whole-tab protection. */
export function initializeDynamicDecisionSlots(sheet: SheetPort): void {
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 2, DYNAMIC_DECISION_HEADERS.length).setValues([[...DYNAMIC_DECISION_HEADERS], [...DISPLAY_HEADERS]]);
  decisionColumns(sheet, true);
}

/** Runs under the projection lock after output read-back and before ACK. Existing
 * rows, draft inputs, captured payloads and target versions are never written. */
export function appendProjectionDecisionSlots(input: ProjectionSnapshot, sheet: SheetPort, ctx: DynamicSlotContext): { appended: number } {
  const snapshot = parseProjectionSnapshot(input);
  const current = readDynamicDecisionSlots(sheet, ctx);
  const additions: unknown[][] = [];
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
    const row = current.slots.length + additions.length + 3;
    const record: Record<string, unknown> = {
      slot_id: slotIdentity(row, request.requestId, request.version, ctx), request_id: request.requestId, base_version: request.version,
      draft_decision: '', draft_id: '', draft_state: 'Ready for decision', draft_json: '',
      event_id: snapshot.event.eventId, unit_id: snapshot.unit.unitId, person_id: person.personId,
      event_label: snapshot.event.label, display_name: person.displayName, requested_outcome: request.requestedOutcome, recorded_status: request.status,
    };
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
