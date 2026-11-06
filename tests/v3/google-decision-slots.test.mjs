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
test('underlying row sorts, moved target cells and generation changes fail closed', () => {
  const sheet = fixture(); const context = ctx(); appendProjectionDecisionSlots(snapshot(), sheet, context); appendProjectionDecisionSlots(snapshot(2, 'Denied'), sheet, context);
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
  [sheet.rows[2], sheet.rows[3]] = [sheet.rows[3], sheet.rows[2]];
  context.config.generation++;
  assert.throws(() => readDynamicDecisionSlots(sheet, context), code('draft_target_changed'));
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
