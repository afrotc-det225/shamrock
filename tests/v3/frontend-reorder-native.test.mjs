import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runPausedNativeReorder, nativeReorderRequests } from '../../.build/v3/apps/google-adapter/src/frontend-reorder-native.js';
import { bindImmutableInputSlots, inputCanonical } from '../../.build/v3/apps/google-adapter/src/frontend-input.js';
import { frontendLiteralCell } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
const copy = value => structuredClone(value), sha = text => createHash('sha256').update(text).digest('hex'), hash = value => sha(inputCanonical(value));
function fixture() {
  const fx = { paused: true, fenced: false, active: null, events: [], writes: 0, nextTrigger: 0, failures: {},
    edits: [{ id: 'old-main', bookId: 'main' }, { id: 'old-excusals', bookId: 'excusals' }],
    setup: { fingerprint: 'binding', ids: { main: 'old-main', excusals: 'old-excusals', confirmation: 'confirmation-trigger' }, confirmationNativeItems: { reference: 101, summary: 102, action: 103 }, confirmationShape: 'form-shape' },
    recovery: { version: 1, environment: 'staging', generation: 1, status: 'empty' },
    state: { version: 1, environment: 'staging', generation: 1, baselines: {}, drafts: {}, supplemental: { dashboardRevision: { operations: 3, administration: 5 }, baselines: {}, drafts: {} }, inputReceipts: { preserved: 'receipt' } },
    journal: { version: 1, environment: 'staging', generation: 1, entries: {} }, tables: {} };
  function step(name) { fx.events.push(name); if (fx.failures[name]) { delete fx.failures[name]; throw Error(`interrupted:${name}`); } }
  for (const [index, kind] of ['directory', 'leadership', 'attendance', 'blue', 'gold'].entries()) {
    const keyHeader = kind === 'leadership' ? 'contact_id' : ['blue', 'gold'].includes(kind) ? 'request_id' : 'person_id';
    const headers = ['last_name', 'first_name', 'as_year', 'rank', 'role', 'photo_link', keyHeader];
    const record = (key, year, last, rank, role) => ({ key, values: { last_name: last, first_name: 'Cadet', as_year: year, rank, role, photo_link: { fileUri: 'https://drive.google.com/file/d/fictional-photo/view' }, [keyHeader]: key }, versions: { role: 3 }, commandBindings: { role: { operation: kind === 'leadership' ? 'leadership.upsert' : 'directory.upsert', entityId: key, field: 'role', expectedVersion: 3 } } });
    const records = [record(`${kind}-junior`, 'AS100', 'Zulu', 'C/4C', 'Cadet'), record(`${kind}-senior`, 'AS400', 'Able', 'C/Col', 'Wing Commander')];
    const rows = records.map((row, r) => headers.map((h, c) => ({ ...frontendLiteralCell(row.values[h]), note: `retained-${r}-${c}`, userEnteredFormat: { textFormat: { fontSize: 10 } }, dataValidation: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Cadet' }] } }, ...(c === 0 ? { maintenanceRowMetadata: { pixelSize: 21 + r }, maintenanceOutsideCells: [{ note: `outside-${r}` }] } : {}) })));
    const current = { sheetId: index + 1, tableId: `table-${kind}`, gridRowCount: 50, gridColumnCount: 10, headers, labels: headers, rows,
      range: { sheetId: index + 1, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: headers.length }, hiddenColumns: [6], machineRowHidden: true,
      filterViews: [{ filterViewId: index + 20, title: 'Alpha Flight', tableId: `table-${kind}` }], maintenanceMetadata: { charts: [], tables: [{ tableId: `table-${kind}` }], columnMetadata: [{ pixelSize: 90 }] } };
    fx.tables[kind] = current;
    const target = ['blue', 'gold'].includes(kind) ? fx.state.supplemental : fx.state;
    target.baselines[kind] = bindImmutableInputSlots({ baseline: { generation: 1, revision: { operations: 3, administration: 5 }, rows: records }, current, keyHeader, editFenceVerified: true });
    target.drafts[kind] = [];
  }
  const ports = { generation: 1, fingerprint: 'binding', mainId: 'main', bookIds: ['main', 'excusals'], confirmationId: 'confirmation', sha256: sha,
    assertPaused() { assert(fx.paused, 'paused gates required'); step('assert-paused'); },
    fence() { fx.fenced = true; step('fence'); }, read: kind => copy(fx.tables[kind]),
    saveState(state) { assert(fx.fenced && fx.active && !fx.setup); step('before-state'); fx.state = copy(state); step('after-state'); },
    recovery: { load: () => copy(fx.recovery), save(value) { step(`before-recovery-${value.phase}`); fx.recovery = copy(value); step(`after-recovery-${value.phase}`); } },
    active: { read: () => fx.active, write(value) { fx.active = value; step(value === null ? 'clear-active' : 'set-active'); } },
    setup: { read: () => copy(fx.setup), write(value) { assert(fx.fenced && fx.active); fx.setup = copy(value); step(value ? 'install-setup' : 'invalidate-setup'); } },
    listEdits: () => copy(fx.edits), deleteEdit(id) { assert(!fx.setup && fx.fenced && fx.active); fx.edits = fx.edits.filter(t => t.id !== id); step(`delete-${id}`); },
    createEdit(bookId) { assert(!fx.setup && fx.fenced && fx.active); const id = `fresh-${++fx.nextTrigger}`; fx.edits.push({ id, bookId }); step(`create-${bookId}`); return id; },
    assertConfirmation(receipt) { assert.equal(receipt.ids.confirmation, 'confirmation-trigger'); assert.equal(receipt.confirmationShape, 'form-shape'); step('confirmation'); },
    writeRows(requests) {
      assert(!fx.setup && fx.fenced && fx.active && fx.paused); assert.equal(fx.recovery.phase, 'write-pending');
      assert.equal(fx.edits.length, 2); assert(fx.edits.every(t => t.id.startsWith('fresh-'))); fx.writes++; step('before-rows');
      const next = copy(fx.tables);
      for (const { moveDimension: move } of requests) { const table = Object.values(next).find(t => t.sheetId === move.source.sheetId); assert(move.source.startIndex >= 2 && move.destinationIndex >= 2); table.rows.splice(move.destinationIndex - 2, 0, table.rows.splice(move.source.startIndex - 2, 1)[0]); }
      fx.tables = next; step('after-rows');
    } };
  const request = (action = 'reorder', sequence = 1) => ({ requestId: `review-${sequence}`, sequence, action, frontendSha256: hash(fx.state), journalSha256: hash(fx.journal), recoveryFileId: 'recovery', recoverySha256: hash(fx.recovery) });
  const run = (review = request()) => { ports.state = copy(fx.state); ports.journal = copy(fx.journal); return runPausedNativeReorder(ports, review); };
  return { fx, ports, request, run };
}

test('paused native maintenance rotates both edit triggers and atomically moves complete rows before rebinding only slots', () => {
  const f = fixture(), before = copy(f.fx), result = f.run();
  assert.deepEqual(result, { status: 'reordered-paused', rows: 4 }); assert.equal(f.fx.writes, 1); assert(f.fx.paused && f.fx.fenced); assert.equal(f.fx.active, null);
  for (const kind of ['directory', 'leadership']) {
    assert.deepEqual(f.fx.tables[kind].rows, before.tables[kind].rows.slice().reverse());
    assert.deepEqual(f.fx.state.baselines[kind].rows, before.state.baselines[kind].rows);
    assert.deepEqual(f.fx.state.baselines[kind].slots.keys, before.state.baselines[kind].slots.keys.slice().reverse());
  }
  for (const kind of ['attendance', 'blue', 'gold']) assert.deepEqual(f.fx.tables[kind], before.tables[kind]);
  assert.deepEqual(f.fx.state.supplemental, before.state.supplemental); assert.deepEqual(f.fx.state.inputReceipts, before.state.inputReceipts); assert.deepEqual(f.fx.journal, before.journal);
  assert.equal(f.fx.setup.ids.confirmation, before.setup.ids.confirmation); assert.notEqual(f.fx.setup.ids.main, before.setup.ids.main); assert.notEqual(f.fx.setup.ids.excusals, before.setup.ids.excusals);
  assert(f.fx.events.indexOf('invalidate-setup') < f.fx.events.indexOf('delete-old-main')); assert(f.fx.events.indexOf('after-state') < f.fx.events.indexOf('install-setup'));
  assert.equal(f.fx.recovery.phase, 'complete');
});

test('no operation starts with drafts, held evidence, unsettled commands, changed review or an open gate', () => {
  for (const mutate of [f => f.fx.state.drafts.attendance.push({ key: 'attendance-junior', header: 'role', value: 'edit', baseVersion: 3 }),
    f => { f.fx.journal.held = { unknown: { event: {}, issue: 'identity' } }; }, f => { f.fx.journal.entries.unsettled = { commands: [{ status: 'queued', attempted: true }] }; },
    f => { f.fx.paused = false; }]) {
    const f = fixture(); mutate(f); assert.throws(() => f.run()); assert.equal(f.fx.writes, 0); assert.equal(f.fx.active, null); assert(f.fx.setup); assert.equal(f.fx.recovery.status, 'empty');
  }
  const stale = fixture(), review = stale.request(); stale.fx.state.inputReceipts.other = 'later'; assert.throws(() => stale.run(review), /checkpoint changed/); assert.equal(stale.fx.writes, 0);
  for (const kind of ['directory', 'leadership', 'attendance', 'blue', 'gold']) { const dirty = fixture(); dirty.fx.tables[kind].rows[0][4] = frontendLiteralCell('Uncaptured edit'); assert.throws(() => dirty.run(), /unsent native values/); assert.equal(dirty.fx.active, null); assert(dirty.fx.setup); assert.equal(dirty.fx.writes, 0); }
});

test('interruption after removing an old trigger stays fenced and a separately reviewed continuation finishes', () => {
  const f = fixture(); f.fx.failures['delete-old-main'] = true; assert.throws(() => f.run(), /interrupted/);
  assert(f.fx.paused && f.fx.fenced && f.fx.active); assert.equal(f.fx.setup, undefined); assert.equal(f.fx.writes, 0); assert.equal(f.fx.recovery.phase, 'rotating');
  assert.equal(f.run(f.request('continue-reorder', 2)).status, 'reordered-paused'); assert.equal(f.fx.edits.length, 2); assert.equal(f.fx.writes, 1);
});

test('a successful trigger creation with an interrupted response is recovered once from its exact sole source', () => {
  const f = fixture(); f.fx.failures['create-main'] = true; assert.throws(() => f.run(), /interrupted/); const main = f.fx.edits.find(t => t.bookId === 'main').id;
  f.run(f.request('continue-reorder', 2)); assert.equal(f.fx.setup.ids.main, main); assert.equal(f.fx.nextTrigger, 2);
});

test('ambiguous whole-batch response is resolved from exact after cells without another row move', () => {
  const f = fixture(); f.fx.failures['after-rows'] = true; assert.throws(() => f.run(), /interrupted/); assert.equal(f.fx.recovery.phase, 'write-pending'); assert.equal(f.fx.setup, undefined);
  const originalKeys = copy(f.fx.state.baselines.directory.slots.keys); assert.notDeepEqual(f.fx.tables.directory.rows.map(r => r[6].userEnteredValue.stringValue), originalKeys);
  f.run(f.request('continue-reorder', 2)); assert.equal(f.fx.writes, 1); assert.equal(f.fx.recovery.phase, 'complete');
});

test('interrupted checkpoint acknowledgement or final setup receipt remains paused and resumes the same new binding', () => {
  for (const point of ['before-state', 'after-state', 'install-setup', 'after-recovery-complete']) {
    const f = fixture(); f.fx.failures[point] = true; assert.throws(() => f.run(), /interrupted/); assert(f.fx.active && f.fx.paused && f.fx.fenced);
    const edits = copy(f.fx.edits); f.run(f.request('continue-reorder', 2)); assert.equal(f.fx.writes, 1); assert.deepEqual(f.fx.edits, edits); assert.equal(f.fx.active, null);
  }
});

test('partial rows, altered metadata, other Table changes and unrelated checkpoint changes never advance setup', () => {
  for (const mutate of [f => { f.fx.tables.directory.rows[0][0].note = 'changed'; }, f => { f.fx.tables.leadership.rows.reverse(); },
    f => { f.fx.tables.attendance.rows[0][0].note = 'changed'; }, f => { f.fx.state.inputReceipts.new = 'unexpected'; }]) {
    const f = fixture(); f.fx.failures['after-rows'] = true; assert.throws(() => f.run()); mutate(f);
    assert.throws(() => f.run(f.request('continue-reorder', 2))); assert(f.fx.active && f.fx.fenced && f.fx.paused); assert.equal(f.fx.setup, undefined); assert.equal(f.fx.writes, 1);
  }
});

test('a modified journal or extra replacement trigger cannot be silently adopted by recovery', () => {
  const journal = fixture(); journal.fx.failures['delete-old-main'] = true; assert.throws(() => journal.run()); journal.fx.journal.entries.later = { commands: [{ status: 'committed', applied: true }] };
  assert.throws(() => journal.run(journal.request('continue-reorder', 2))); assert.equal(journal.fx.writes, 0);
  const trigger = fixture(); trigger.fx.failures['create-main'] = true; assert.throws(() => trigger.run()); trigger.fx.edits.push({ id: 'unexpected', bookId: 'main' });
  assert.throws(() => trigger.run(trigger.request('continue-reorder', 2)), /replacement/); assert.equal(trigger.fx.writes, 0); assert.equal(trigger.fx.setup, undefined);
});

test('request builder cannot move headers, duplicate identities or an additional sheet', () => {
  const f = fixture(); f.run(); const plans = ['directory', 'leadership'].map(k => copy(f.fx.recovery.plans[k]));
  assert.equal(nativeReorderRequests(plans).length, 2); plans[0].sourceRowIndices = [0, 0]; assert.throws(() => nativeReorderRequests(plans));
  assert.throws(() => nativeReorderRequests([f.fx.recovery.plans.directory]));
});
