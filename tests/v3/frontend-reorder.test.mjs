import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planFrontendReorder, verifyFrontendReorderReadback } from '../../.build/v3/apps/google-adapter/src/frontend-reorder.js';
import { bindImmutableInputSlots, assertImmutableInputSlots } from '../../.build/v3/apps/google-adapter/src/frontend-input.js';
import { frontendLiteralCell, planFrontendPublication } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const copy = value => structuredClone(value);
function fixture() {
  const headers = ['last_name', 'first_name', 'as_year', 'role', 'photo_link', 'person_id'];
  const record = (key, asYear, lastName, firstName) => ({ key, values: { last_name: lastName, first_name: firstName, as_year: asYear, role: 'Cadet', photo_link: { fileUri: 'https://drive.google.com/file/d/fictional-photo/view' }, person_id: key }, versions: { role: 3 }, commandBindings: { role: { operation: 'directory.upsert', entityId: key, field: 'role', expectedVersion: 3 } } });
  const rows = [record('gmc', 'AS500', 'Alpha', 'Cadet'), record('senior-z', 'AS400', 'Zulu', 'Cadet'), record('senior-a', 'AS400', 'Able', 'Cadet')];
  const current = { sheetId: 1, tableId: 'fictional-table', gridRowCount: 50, gridColumnCount: 6, headers, labels: headers,
    rows: [...rows.map(row => headers.map(header => ({ ...frontendLiteralCell(row.values[header]), dataValidation: { opaque: 'native-color' }, note: 'Retain record note' }))), headers.map(() => ({}))],
    range: { sheetId: 1, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 6 }, hiddenColumns: [5], machineRowHidden: true,
    filterViews: [{ filterViewId: 10, title: 'Alpha', range: { sheetId: 1, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 6 } }] };
  const baseline = bindImmutableInputSlots({ baseline: { generation: 1, revision: { operations: 3, administration: 2 }, rows }, current, keyHeader: 'person_id', editFenceVerified: true });
  return { kind: 'directory', current, baseline, drafts: [], journal: { version: 1, environment: 'staging', generation: 1, entries: {} }, editFenceVerified: true,
    barrier: { nativeInputPaused: true, publicationPaused: true, setupReceiptInvalidated: true, retiredEditTriggerIds: ['old-trigger', 'old-duplicate'], replacementEditTriggerId: 'fresh-trigger' }, sha256 };
}

test('reviewed rebind moves whole records while retaining versions, grants, chips, metadata and filter definitions', () => {
  const input = fixture(), before = copy({ ...input, sha256: undefined }), plan = planFrontendReorder(input);
  assert.deepEqual(plan.sourceRowIndices, [2, 1, 0, 3]);
  assert.deepEqual(plan.baselineAfter.rows, input.baseline.rows);
  assert.deepEqual(plan.baselineAfter.slots.keys, ['senior-a', 'senior-z', 'gmc', null]);
  assert.deepEqual(plan.expectedAfter.filterViews, input.current.filterViews);
  for (let i = 0; i < plan.sourceRowIndices.length; i++) assert.deepEqual(plan.expectedAfter.rows[i], input.current.rows[plan.sourceRowIndices[i]]);
  assert.deepEqual(verifyFrontendReorderReadback({ ...input, plan, current: plan.expectedAfter }), plan.baselineAfter);
  assert.deepEqual({ ...input, sha256: undefined }, before);
  assert.deepEqual(assertImmutableInputSlots(plan.baselineAfter, plan.expectedAfter, 'directory'), undefined);
});

test('ordinary publication never uses the canonical row order to reinterpret existing bound slots', () => {
  const input = fixture(), sorted = planFrontendReorder(input), columns = input.current.headers.map(header => ({ header, label: header, editable: header === 'role', ...(header === 'photo_link' ? { fileChip: true } : {}) }));
  const plan = planFrontendPublication({ generation: 1, revision: input.baseline.revision, table: { kind: 'directory', keyHeader: 'person_id', columns, rows: [...input.baseline.rows].reverse() }, current: input.current, baseline: input.baseline, drafts: [], seeds: [], editFenceVerified: true });
  assert.deepEqual(plan.expectedAfter.rows.map(row => row[5]?.userEnteredValue?.stringValue ?? null), input.baseline.slots.keys);
  assert.throws(() => bindImmutableInputSlots({ baseline: input.baseline, current: sorted.expectedAfter, keyHeader: 'person_id', editFenceVerified: true }), /cannot be reassigned/);
});

test('pause and fence alone cannot reassign slots, and old trigger IDs cannot be reused', () => {
  for (const update of [{ nativeInputPaused: false }, { publicationPaused: false }, { setupReceiptInvalidated: false }, { retiredEditTriggerIds: [] }, { replacementEditTriggerId: 'old-trigger' }]) {
    const input = fixture(); Object.assign(input.barrier, update); assert.throws(() => planFrontendReorder(input), /Rotate every prior/);
  }
  const input = fixture(); input.editFenceVerified = false; assert.throws(() => planFrontendReorder(input));
});

test('unsent cells, frozen drafts, uncertain journal entries and held evidence stop before any row move', () => {
  const dirty = fixture(); dirty.current.rows[0][3] = frontendLiteralCell('Edited role'); assert.throws(() => planFrontendReorder(dirty), /unsent native values/);
  const draft = fixture(); draft.drafts.push({ key: 'gmc', header: 'role', value: 'Cadet', baseVersion: 3 }); assert.throws(() => planFrontendReorder(draft));
  const queued = fixture(); queued.journal.entries.pending = { commands: [{ status: 'queued', attempted: true }], edit: {} }; assert.throws(() => planFrontendReorder(queued));
  const held = fixture(); held.journal.held = { uncertain: { event: {}, issue: 'input_identity' } }; assert.throws(() => planFrontendReorder(held));
  const awaiting = fixture(); awaiting.journal.entries.pending = { commands: [], edit: { status: 'confirmation-required' } }; assert.throws(() => planFrontendReorder(awaiting));
});

test('readback rejects partial writes, changed keyed versions, lost metadata or changed journal/trigger review', () => {
  const input = fixture(), plan = planFrontendReorder(input);
  assert.throws(() => verifyFrontendReorderReadback({ ...input, plan }), /Sorted cells/);
  const after = copy(plan.expectedAfter); delete after.rows[0][0].dataValidation;
  assert.throws(() => verifyFrontendReorderReadback({ ...input, plan, current: after }), /Sorted cells/);
  const baseline = copy(input.baseline); baseline.rows[0].versions.role++;
  assert.throws(() => verifyFrontendReorderReadback({ ...input, plan, current: plan.expectedAfter, baseline }), /Sorted cells/);
  const journal = copy(input.journal); journal.entries.done = { commands: [{ status: 'committed', applied: true }], edit: {} };
  assert.throws(() => verifyFrontendReorderReadback({ ...input, plan, current: plan.expectedAfter, journal }), /Sorted cells/);
  assert.throws(() => verifyFrontendReorderReadback({ ...input, plan, current: plan.expectedAfter, barrier: { ...input.barrier, replacementEditTriggerId: 'other-fresh-trigger' } }), /Sorted cells/);
});

test('retired identities survive rebind and empty capacity remains empty', () => {
  const input = fixture(); input.baseline.rows[2].retired = true;
  const plan = planFrontendReorder(input);
  assert.deepEqual(plan.baselineAfter.slots.keys, ['senior-z', 'gmc', 'senior-a', null]);
  assert.deepEqual(plan.baselineAfter.rows, input.baseline.rows);
});
