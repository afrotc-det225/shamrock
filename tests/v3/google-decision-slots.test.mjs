import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeDynamicDecisionSlots, appendProjectionDecisionSlots, readDynamicDecisionSlots, DYNAMIC_DECISION_HEADERS as HEADERS } from '../../.build/v3/apps/google-adapter/src/decision-slots.js';
const code = expected => error => error.code === expected;
const ctx = () => ({ binding: { mode: 'projection', resourceKey: 'review-source', maxSlots: 10 }, config: { environment: 'staging', generation: 1 }, signer: { sha256: input => createHash('sha256').update(input).digest('hex') } });
const snapshot = (version = 1, status = 'Submitted') => ({ revision: version, event: { eventId: 'event.one', label: '=Literal event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [{ personId: 'person.one', displayName: '=Literal name', observedCode: 'P', requests: [{ requestId: 'request.one', status, requestedOutcome: 'E', version }] }] });
class Sheet {
  rows = []; writes = []; afterWrite;
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getRange(row, column, rows, columns) {
    return { getValues: () => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => this.rows[row + r - 1]?.[column + c - 1] ?? '')),
      setValues: values => { this.writes.push({ row, column, rows, columns }); for (let r = 0; r < rows; r++) { this.rows[row + r - 1] ??= []; for (let c = 0; c < columns; c++) this.rows[row + r - 1][column + c - 1] = values[r][c]; } this.afterWrite?.(row, column); } };
  }
  set(row, header, value) { this.getRange(row, this.rows[0].indexOf(header) + 1, 1, 1).setValues([[value]]); }
}
function fixture() { const sheet = new Sheet(); initializeDynamicDecisionSlots(sheet); sheet.writes = []; return sheet; }
test('new request versions append stable slots with literal context and never write an editable input cell', () => {
  const sheet = fixture(); const context = ctx();
  assert.deepEqual(appendProjectionDecisionSlots(snapshot(), sheet, context), { appended: 1 });
  const first = readDynamicDecisionSlots(sheet, context).slots[0];
  assert.equal(first.row, 3); assert.equal(first.requestId, 'request.one'); assert.equal(first.baseVersion, 1);
  assert.equal(sheet.rows[2][HEADERS.indexOf('display_name')], '=Literal name');
  assert.ok(sheet.writes.every(write => !(write.column <= 4 && write.column + write.columns > 4)));
  sheet.set(3, 'draft_decision', 'Denied'); sheet.set(3, 'draft_json', 'saved original payload'); sheet.set(3, 'draft_state', 'Retry pending');
  const before = structuredClone(sheet.rows[2]); const writes = sheet.writes.length;
  assert.deepEqual(appendProjectionDecisionSlots(snapshot(), sheet, context), { appended: 0 });
  assert.equal(sheet.writes.length, writes);
  appendProjectionDecisionSlots(snapshot(2, 'Approved'), sheet, context);
  assert.deepEqual(sheet.rows[2], before);
  assert.equal(readDynamicDecisionSlots(sheet, context).slots[1].baseVersion, 2);
});
test('whole-row sorting preserves identities and frozen payloads; later allocation uses a new origin', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context); appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  sheet.set(3, 'draft_decision', 'Denied'); sheet.set(3, 'draft_id', 'draft.original'); sheet.set(3, 'draft_json', '{"original":"frozen payload"}');
  const original = structuredClone(sheet.rows[2]);
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  const sorted = readDynamicDecisionSlots(sheet, context).slots;
  assert.deepEqual(sorted.map(slot => [slot.row, slot.baseVersion]), [[3, 2], [4, 1]]);
  assert.deepEqual(sheet.rows[3], original);
  appendProjectionDecisionSlots(snapshot(3, 'Approved'), sheet, context);
  assert.equal(sheet.rows[4][HEADERS.indexOf('slot_origin_row')], 5);
  assert.deepEqual(sheet.rows[3], original);
  assert.equal(new Set(readDynamicDecisionSlots(sheet, context).slots.map(slot => slot.slotId)).size, 3);
});
test('partial identity sorting, duplicate origins and generation changes fail closed', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context); appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  const before = structuredClone(sheet.rows);
  [sheet.rows[2][0], sheet.rows[3][0]] = [sheet.rows[3][0], sheet.rows[2][0]];
  assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
  sheet.rows = structuredClone(before);
  sheet.set(4, 'slot_origin_row', 3);
  sheet.set(4, 'slot_id', `slot.${context.signer.sha256(JSON.stringify(['decision-slot-v1', 'staging', 1, 'review-source', 3, 'request.one', 2]))}`);
  assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
  sheet.rows = structuredClone(before);
  context.config.generation++;
  assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
});
test('paused legacy upgrade appends origin metadata without rewriting old slots or frozen drafts', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context); appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  sheet.set(3, 'draft_decision', 'Denied'); sheet.set(3, 'draft_id', 'draft.original'); sheet.set(3, 'draft_json', '{"original":"payload, including row metadata"}');
  sheet.rows = sheet.rows.map(row => row.slice(0, 14));
  const before = structuredClone(sheet.rows); sheet.writes = [];
  initializeDynamicDecisionSlots(sheet, context);
  assert.deepEqual(sheet.rows.map(row => row.slice(0, 14)), before);
  assert.deepEqual(sheet.rows.slice(2).map(row => row[HEADERS.indexOf('slot_origin_row')]), [3, 4]);
  assert.ok(sheet.rows.slice(2).every(row => /^[a-f0-9]{64}$/.test(row[HEADERS.indexOf('slot_context_hash')])));
  assert.deepEqual(sheet.writes, [{ row: 1, column: 15, rows: 4, columns: 2 }]);
  initializeDynamicDecisionSlots(sheet, context); assert.equal(sheet.writes.length, 1);
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  assert.deepEqual(readDynamicDecisionSlots(sheet, context).slots.map(slot => slot.baseVersion), [2, 1]);
});
test('legacy upgrade validates context and original row integrity before writing', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context); appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  sheet.rows = sheet.rows.map(row => row.slice(0, 14)); sheet.writes = [];
  assert.throws(() => initializeDynamicDecisionSlots(sheet), code('invalid_draft_schema'));
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  const before = structuredClone(sheet.rows);
  assert.throws(() => initializeDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
  assert.deepEqual(sheet.rows, before); assert.equal(sheet.writes.length, 0);
});
test('legacy upgrade and sorted allocation use header names with reordered columns', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context);
  const order = Array.from({ length: 14 }, (_, index) => 13 - index);
  sheet.rows = sheet.rows.map(row => order.map(index => row[index]));
  const before = structuredClone(sheet.rows);
  initializeDynamicDecisionSlots(sheet, context);
  assert.deepEqual(sheet.rows.map(row => row.slice(0, 14)), before);
  appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  const slots = readDynamicDecisionSlots(sheet, context).slots;
  assert.deepEqual(slots.map(slot => [slot.row, slot.baseVersion]), [[3, 2], [4, 1]]);
  appendProjectionDecisionSlots(snapshot(3, 'Approved'), sheet, context);
  assert.equal(sheet.rows[4][HEADERS.indexOf('slot_origin_row')], 5);
});
test('partial sorts of displayed context or protected target context fail identity verification', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context);
  const other = snapshot(2, 'Denied'); other.event = { eventId: 'event.two', label: 'Other event' }; other.unit.unitId = 'unit.two';
  Object.assign(other.rows[0], { personId: 'person.two', displayName: 'Other cadet' });
  Object.assign(other.rows[0].requests[0], { requestId: 'request.two', requestedOutcome: 'MED' });
  appendProjectionDecisionSlots(other, sheet, context);
  const before = structuredClone(sheet.rows);
  for (const header of ['event_label', 'display_name', 'requested_outcome', 'recorded_status', 'event_id', 'unit_id', 'person_id']) {
    sheet.rows = structuredClone(before); const column = HEADERS.indexOf(header);
    [sheet.rows[2][column], sheet.rows[3][column]] = [sheet.rows[3][column], sheet.rows[2][column]];
    assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'), header);
  }
  sheet.rows = structuredClone(before); [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  assert.deepEqual(readDynamicDecisionSlots(sheet, context).slots.map(slot => slot.requestId), ['request.two', 'request.one']);
});
test('capacity exhaustion and unsaved input outside allocated rows preserve all existing data', () => {
  const sheet = fixture(); const context = ctx(); context.binding.maxSlots = 1;
  appendProjectionDecisionSlots(snapshot(), sheet, context); sheet.set(3, 'draft_decision', 'Denied');
  const before = structuredClone(sheet.rows);
  assert.throws(() => appendProjectionDecisionSlots(snapshot(2, 'Approved'), sheet, context), code('decision_slots_full'));
  assert.deepEqual(sheet.rows, before);
  context.binding.maxSlots = 10; sheet.set(4, 'draft_decision', 'Uncaptured input'); const withInput = structuredClone(sheet.rows);
  assert.throws(() => appendProjectionDecisionSlots(snapshot(2, 'Approved'), sheet, context), code('draft_target_changed'));
  assert.deepEqual(sheet.rows, withInput);
});
test('identity changes, same-version conflicts and stale versions do not write or rebind drafts', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(2, 'Approved'), sheet, context); const before = structuredClone(sheet.rows);
  const changed = snapshot(3, 'Denied'); changed.rows[0].personId = 'person.other';
  assert.throws(() => appendProjectionDecisionSlots(changed, sheet, context), code('draft_target_changed'));
  assert.throws(() => appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context), code('projection_conflict'));
  assert.throws(() => appendProjectionDecisionSlots(snapshot(), sheet, context), code('projection_rollback'));
  assert.deepEqual(sheet.rows, before);
});
test('concurrent human input during allocation is retained and ambiguous publication fails', () => {
  const sheet = fixture(); const context = ctx(); let injected = false;
  sheet.afterWrite = (row, column) => { if (row === 3 && column === 1 && !injected) { injected = true; sheet.rows[2][3] = 'Denied'; } };
  assert.throws(() => appendProjectionDecisionSlots(snapshot(), sheet, context), code('draft_capture_failed'));
  assert.equal(sheet.rows[2][3], 'Denied'); assert.equal(sheet.rows[2][6], '');
  sheet.afterWrite = undefined;
  assert.deepEqual(appendProjectionDecisionSlots(snapshot(), sheet, context), { appended: 0 });
  assert.equal(sheet.rows[2][3], 'Denied'); // A later authenticated edit event may capture it; projection cannot invent an actor.
});
test('schema initialization never silently converts a populated fixed-slot table', () => {
  const sheet = new Sheet(); sheet.rows = [HEADERS.slice(0, 7), HEADERS.slice(0, 7), ['slot.fixed', 'request.one', 1, 'Approved']]; const before = structuredClone(sheet.rows);
  assert.throws(() => initializeDynamicDecisionSlots(sheet), code('invalid_draft_schema')); assert.deepEqual(sheet.rows, before);
});
