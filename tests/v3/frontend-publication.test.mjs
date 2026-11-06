import test from 'node:test';
import assert from 'node:assert/strict';
import { planFrontendPublication, planFrontendInitialization, frontendReadFingerprint, frontendLiteralCell,
  assertFrontendPublicationPreconditions, verifyFrontendPublicationReadback,
  snapshotToFrontendReportingInput, buildFrontendPublicationModel, applyFrontendReceipt, verifyFrontendValidationReadback } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import { buildFrontendReporting } from '../../.build/v3/packages/domain/src/frontend-reporting.js';

const photo = { fileUri: 'https://drive.google.com/file/d/fictional-photo/view' };
const columns = [
  { header: 'first_name', label: 'First Name', editable: false }, { header: 'role', label: 'Role', editable: true },
  { header: 'photo_link', label: 'Photo Link', editable: false, fileChip: true }, { header: 'person_id', label: 'Person ID', editable: false },
];
const record = (key, role = 'Cadet', version = 1) => ({ key, values: { first_name: `Fictional ${key}`, role, photo_link: photo, person_id: key }, versions: { role: version } });
const rule = { strict: true, showCustomUi: false, condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Data Legend'!$A$3:$A$12" }] } };
const seed = { key: 'attendance:code', sheetId: 99, rowIndex: 2, columnIndex: 0, protected: true, hidden: true, nativeStyleVersion: 'fictional-style-v1', expectedRule: rule, observedRule: rule };
function read(rows, cols = columns) {
  return { sheetId: 10, tableId: 'fixture-table', gridRowCount: 502, gridColumnCount: 160,
    headers: cols.map(c => c.header), labels: cols.map(c => c.label),
    rows: rows.map(r => cols.map(c => ({ ...frontendLiteralCell(r.values[c.header]), userEnteredFormat: { textFormat: { fontFamily: 'Roboto' } }, dataValidation: { opaqueNativeStyle: 'retain' } }))),
    range: { sheetId: 10, startRowIndex: 1, endRowIndex: rows.length + 2, startColumnIndex: 0, endColumnIndex: cols.length },
    hiddenColumns: [cols.findIndex(c => c.header === 'person_id')], machineRowHidden: true };
}
function fixture() {
  const rows = [record('cadet-a'), record('cadet-b')];
  return { generation: 1, revision: { operations: 1, administration: 1 },
    table: { kind: 'directory', keyHeader: 'person_id', columns, rows: structuredClone(rows) },
    current: read([rows[1], rows[0]]), baseline: { generation: 1, revision: { operations: 1, administration: 1 }, rows: structuredClone(rows) },
    drafts: [], seeds: [], editFenceVerified: true };
}
// Provider-shape simulator: update only the named CellData fields, never formatting/validation.
function apply(current, requests) {
  const result = structuredClone(current);
  const cells = [current.headers.map(frontendLiteralCell), current.labels.map(frontendLiteralCell), ...structuredClone(current.rows)];
  for (const r of requests) {
    if (r.updateSheetProperties) Object.assign(result, { gridRowCount: r.updateSheetProperties.properties.gridProperties.rowCount, gridColumnCount: r.updateSheetProperties.properties.gridProperties.columnCount });
    if (r.updateCells) {
      const x = r.updateCells, range = x.range;
      for (let row = range.startRowIndex; row < range.endRowIndex; row++) for (let col = range.startColumnIndex; col < range.endColumnIndex; col++) {
        cells[row] ??= []; cells[row][col] ??= {};
        const source = x.rows?.[row - range.startRowIndex]?.values?.[col - range.startColumnIndex] ?? {};
        for (const field of x.fields.split(',')) { if (Object.hasOwn(source, field)) cells[row][col][field] = structuredClone(source[field]); else delete cells[row][col][field]; }
      }
    }
    if (r.updateTable) result.range = structuredClone(r.updateTable.table.range);
    if (r.updateDimensionProperties) {
      const x = r.updateDimensionProperties;
      if (x.range.dimension === 'ROWS' && x.range.startIndex === 0) result.machineRowHidden = x.properties.hiddenByUser;
      if (x.range.dimension === 'COLUMNS' && x.properties.hiddenByUser) result.hiddenColumns = [...new Set([...result.hiddenColumns, x.range.startIndex])];
    }
  }
  const width = result.range.endColumnIndex, height = result.range.endRowIndex;
  result.headers = Array.from({ length: width }, (_, c) => cells[0][c].userEnteredValue.stringValue);
  result.labels = Array.from({ length: width }, (_, c) => cells[1][c].userEnteredValue.stringValue);
  result.rows = Array.from({ length: height - 2 }, (_, r) => Array.from({ length: width }, (_, c) => cells[r + 2]?.[c] ?? {}));
  return result;
}
const entered = cell => cell.userEnteredValue?.stringValue ?? cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.boolValue ?? null;

test('no-op preserves sorted row order, opaque validation, formatting and native file chips', () => {
  const input = fixture(), before = structuredClone(input), plan = planFrontendPublication(input);
  assert.equal(plan.requests.length, 0); assert.equal(plan.complete, true); assert.deepEqual(input, before);
  assert.deepEqual(plan.expectedAfter.rows.map(r => entered(r[3])), ['cadet-b', 'cadet-a']);
  assert.ok(verifyFrontendPublicationReadback(plan, input.current));
});

test('changed literal values use keyed rows and exact field masks, with formulas never interpreted', () => {
  const input = fixture(); input.revision.administration = 2;
  input.table.rows[0] = record('cadet-a', '=HYPERLINK("https://example.invalid","literal")', 2);
  const plan = planFrontendPublication(input), after = apply(input.current, plan.requests);
  assert.equal(plan.changedCells, 1); assert.equal(entered(after.rows[1][1]), input.table.rows[0].values.role);
  assert.deepEqual(after.rows[1][1].dataValidation, input.current.rows[1][1].dataValidation);
  assert.deepEqual(after.rows[1][1].userEnteredFormat, input.current.rows[1][1].userEnteredFormat);
  assert.ok(plan.requests.filter(r => r.updateCells).every(r => r.updateCells.fields === 'userEnteredValue'));
  assert.ok(verifyFrontendPublicationReadback(plan, after));
});

test('manual edits are preserved before trigger capture, with frozen base version and stale-server diagnostics', () => {
  const input = fixture(); input.current.rows[1][1].userEnteredValue = { stringValue: 'Flight Commander' };
  let plan = planFrontendPublication(input); assert.equal(plan.complete, false); assert.equal(plan.changedCells, 0);
  assert.equal(plan.diagnostics[0].code, 'unsent-edit'); assert.equal(plan.retainedDrafts[0].baseVersion, 1);
  assert.equal(plan.nextBaseline.rows.find(r => r.key === 'cadet-a').values.role, 'Cadet');
  input.revision.administration = 2; input.table.rows[0] = record('cadet-a', 'Wing Commander', 2);
  plan = planFrontendPublication(input); assert.equal(plan.diagnostics[0].code, 'version-conflict');
  assert.equal(entered(apply(input.current, plan.requests).rows[1][1]), 'Flight Commander');
});

test('queued drafts stay frozen even when UI matches server, and a second local edit is not erased', () => {
  const input = fixture(); input.drafts = [{ key: 'cadet-a', header: 'role', baseVersion: 1, value: 'Cadet' }];
  let plan = planFrontendPublication(input); assert.equal(plan.diagnostics[0].code, 'pending-draft'); assert.equal(plan.complete, false);
  input.current.rows[1][1].userEnteredValue = { stringValue: 'Second edit' };
  plan = planFrontendPublication(input); assert.ok(plan.diagnostics.some(d => d.code === 'draft-cell-changed'));
  assert.equal(plan.retainedDrafts[0].value, 'Cadet'); assert.equal(entered(plan.expectedAfter.rows[1][1]), 'Second edit');
});

test('only an exact authenticated receipt advances the frozen field baseline and removes its draft', () => {
  const input = fixture(), draft = { key: 'cadet-a', header: 'role', baseVersion: 1, value: 'Flight Commander' };
  input.current.rows[1][1].userEnteredValue = { stringValue: draft.value }; input.drafts = [draft];
  const receipt = { key: draft.key, header: draft.header, baseVersion: 1, committedVersion: 2, value: draft.value };
  const args = { baseline: input.baseline, drafts: input.drafts, draft, receiptVerified: true, receipt };
  assert.throws(() => applyFrontendReceipt({ ...args, receiptVerified: false }));
  assert.throws(() => applyFrontendReceipt({ ...args, receipt: { ...receipt, value: 'Different edit' } }));
  const accepted = applyFrontendReceipt(args); assert.equal(accepted.drafts.length, 0);
  assert.equal(input.baseline.rows[0].values.role, 'Cadet'); // immutable input
  input.baseline = accepted.baseline; input.drafts = accepted.drafts;
  input.revision.administration = 2; input.table.rows[0] = record('cadet-a', draft.value, 2);
  assert.equal(planFrontendPublication(input).complete, true);
  input.current.rows[1][1].userEnteredValue = { stringValue: 'A second local edit' };
  assert.equal(planFrontendPublication(input).retainedDrafts[0].baseVersion, 2);
});

test('native photo chips compare by URI, preserve normalized labels, and change with narrow chip mask', () => {
  const input = fixture(); input.current.rows[0][2].userEnteredValue = { stringValue: 'Fictional portrait.svg' };
  let plan = planFrontendPublication(input); assert.equal(plan.changedCells, 0);
  input.revision.administration = 2; input.table.rows[1].values.photo_link = { fileUri: 'https://drive.google.com/file/d/fictional-second-photo/view' };
  plan = planFrontendPublication(input); assert.equal(plan.changedCells, 1);
  assert.equal(plan.requests.find(r => r.updateCells).updateCells.fields, 'userEnteredValue,chipRuns');
  const after = apply(input.current, plan.requests); after.rows[0][2].userEnteredValue = { stringValue: 'Provider normalized name' };
  assert.ok(verifyFrontendPublicationReadback(plan, after));
  after.rows[0][2].chipRuns[0].chip.richLinkProperties.uri = photo.fileUri; assert.equal(verifyFrontendPublicationReadback(plan, after), false);
});

test('retiring a clean row clears its values inside the verified extent, but a dirty retired row remains', () => {
  const input = fixture(); input.table.rows = [input.table.rows[0]];
  let plan = planFrontendPublication(input), after = apply(input.current, plan.requests);
  assert.ok(after.rows[0].every(c => entered(c) === null && !c.chipRuns)); assert.equal(after.rows.length, 2);
  assert.equal(entered(after.rows[1][3]), 'cadet-a'); assert.ok(verifyFrontendPublicationReadback(plan, after));
  input.current.rows[0][1].userEnteredValue = { stringValue: 'Pending role' };
  plan = planFrontendPublication(input); assert.equal(plan.diagnostics[0].code, 'retired-row-with-edit');
  assert.equal(entered(plan.expectedAfter.rows[0][3]), 'cadet-b'); assert.equal(plan.complete, false);
});

function attendanceInput(rows = 2, events = 1) {
  const cols = [{ header: 'first_name', label: 'First Name', editable: false }, ...Array.from({ length: events }, (_, i) => ({ header: `event:event-${i}`, label: `Event ${i}`, editable: true, seedKey: 'attendance:code' })), { header: 'person_id', label: 'Person ID', editable: false }];
  const records = Array.from({ length: rows }, (_, i) => ({ key: `cadet-${i}`, values: Object.fromEntries(cols.map(c => [c.header, c.header === 'person_id' ? `cadet-${i}` : c.header === 'first_name' ? `Sample ${i}` : 'A'])), versions: Object.fromEntries(cols.filter(c => c.editable).map(c => [c.header, 1])), eventVersions: Object.fromEntries(cols.filter(c => c.editable).map(c => [c.header, 1])) }));
  return { generation: 1, revision: { operations: 1, administration: 1 }, table: { kind: 'attendance', keyHeader: 'person_id', columns: cols, rows: structuredClone(records) }, current: read(records, cols), baseline: { generation: 1, revision: { operations: 1, administration: 1 }, rows: records }, drafts: [], seeds: [seed], editFenceVerified: true };
}

test('new rows and events use protected native seeds without changing existing validation or moving identity', () => {
  const input = attendanceInput(); const oldKeyColumn = input.current.headers.indexOf('person_id');
  input.table.columns.splice(2, 0, { header: 'event:additional', label: 'Additional', editable: true, seedKey: 'attendance:code' });
  for (const row of input.table.rows) { row.values['event:additional'] = null; row.versions['event:additional'] = 0; row.eventVersions['event:additional'] = 1; }
  const newRow = structuredClone(input.table.rows[0]); newRow.key = 'cadet-new'; newRow.values.person_id = newRow.key; input.table.rows.push(newRow);
  const plan = planFrontendPublication(input);
  assert.equal(plan.expectedAfter.headers.indexOf('person_id'), oldKeyColumn);
  assert.equal(plan.expectedAfter.headers.at(-1), 'event:additional');
  assert.equal(plan.copiedValidationRanges, 2); // one original event/new row, one new event/all rows
  const validationReads = plan.validationExpectations.map(({ expectedRule, ...range }) => ({ ...range, rows: Array.from({ length: range.endRowIndex - range.startRowIndex }, () => [structuredClone(expectedRule)]) }));
  assert.equal(verifyFrontendValidationReadback(plan, validationReads), true);
  assert.equal(verifyFrontendValidationReadback(plan, validationReads.slice(1)), false);
  const missingValidation = structuredClone(validationReads); missingValidation[0].rows[0][0] = null;
  assert.equal(verifyFrontendValidationReadback(plan, missingValidation), false);
  const changedAffordance = structuredClone(validationReads); changedAffordance[0].rows[0][0].showCustomUi = true;
  assert.equal(verifyFrontendValidationReadback(plan, changedAffordance), false);
  assert.ok(plan.requests.filter(r => r.copyPaste).every(r => r.copyPaste.pasteType === 'PASTE_DATA_VALIDATION'));
  assert.ok(plan.requests.filter(r => r.updateTable).every(r => r.updateTable.fields === 'range' && !r.updateTable.table.columnProperties));
  const layout = plan.requests.filter(r => r.repeatCell || r.updateDimensionProperties?.fields === 'pixelSize');
  assert.equal(layout.find(r => r.updateDimensionProperties?.range.dimension === 'COLUMNS').updateDimensionProperties.properties.pixelSize, 75);
  assert.ok(layout.filter(r => r.updateDimensionProperties?.range.dimension === 'COLUMNS').every(r => r.updateDimensionProperties.range.startIndex === input.current.headers.length));
  assert.ok(layout.filter(r => r.repeatCell).every(r => {
    const { range, fields } = r.repeatCell;
    return (range.startColumnIndex >= input.current.headers.length || range.startRowIndex >= input.current.range.endRowIndex)
      && fields.split(',').every(f => f.startsWith('userEnteredFormat.') && !/background|foreground|color|validation/i.test(f));
  }));
  assert.ok(layout.every(r => !r.repeatCell?.cell.userEnteredValue && !r.repeatCell?.cell.dataValidation));
  const existingEventNewRows = layout.find(r => r.repeatCell?.range.startRowIndex === input.current.range.endRowIndex
    && r.repeatCell.range.startColumnIndex === 1 && r.repeatCell.cell.userEnteredFormat.numberFormat?.type === 'TEXT');
  assert.equal(existingEventNewRows.repeatCell.cell.userEnteredFormat.horizontalAlignment, 'CENTER');
  assert.equal(existingEventNewRows.repeatCell.cell.userEnteredFormat.textFormat.bold, true);
  assert.ok(verifyFrontendPublicationReadback(plan, apply(input.current, plan.requests)));
  input.seeds[0] = { ...seed, protected: false }; assert.throws(() => planFrontendPublication(input));
});

test('event catalog changes invalidate a pending attendance edit independently of attendance base version', () => {
  const input = attendanceInput(); input.current.rows[0][1].userEnteredValue = { stringValue: 'T' };
  input.table.rows[0].eventVersions['event:event-0'] = 2;
  const plan = planFrontendPublication(input);
  assert.equal(plan.diagnostics[0].code, 'version-conflict'); assert.equal(plan.retainedDrafts[0].expectedEventVersion, 1);
  assert.equal(plan.nextBaseline.rows[0].eventVersions['event:event-0'], 1);
});

test('review holds preserve existing values and percentages instead of publishing unresolved reporting output', () => {
  const input = attendanceInput(); input.table.rows[0].values['event:event-0'] = null; input.table.rows[0].versions['event:event-0'] = 2;
  input.table.holds = [{ key: 'cadet-0', header: 'event:event-0', reason: 'Ambiguous request' }];
  const plan = planFrontendPublication(input); assert.equal(plan.complete, false); assert.equal(plan.changedCells, 0);
  assert.equal(plan.diagnostics[0].code, 'reporting-review'); assert.equal(entered(plan.expectedAfter.rows[0][1]), 'A');
});

test('stale revisions, rebound identity, formula cells, noneditable tampering and lost fence fail before any writes', () => {
  for (const mutate of [x => x.editFenceVerified = false, x => x.generation = 2, x => x.revision.operations = 0,
    x => x.current.rows[0][3].userEnteredValue.stringValue = 'unknown-person',
    x => x.current.rows[0][0].userEnteredValue.stringValue = 'Unapproved name',
    x => x.current.rows[0][1].userEnteredValue = { formulaValue: '=1' },
    x => x.table.rows[0].values.role = 'Unversioned server change']) {
    const input = fixture(); mutate(input); assert.throws(() => planFrontendPublication(input));
  }
  const input = fixture(), plan = planFrontendPublication(input); assertFrontendPublicationPreconditions(plan, input.current);
  input.current.rows.reverse(); assert.throws(() => assertFrontendPublicationPreconditions(plan, input.current));
});

test('initialization requires empty data or an exact reviewed fictional reset, never a name-based join', () => {
  const input = fixture(); assert.throws(() => planFrontendInitialization(input));
  input.reviewedFictionalReset = { environment: 'staging', generation: 1, sheetId: 10, tableId: 'fixture-table', expectedRead: frontendReadFingerprint(input.current) };
  const plan = planFrontendInitialization(input); assertFrontendPublicationPreconditions(plan, input.current);
  assert.ok(verifyFrontendPublicationReadback(plan, apply(input.current, plan.requests)));
  assert.ok(plan.requests.every(r => !r.deleteSheet && !r.sortRange && !r.deleteDimension));
  input.reviewedFictionalReset.tableId = 'other-table'; assert.throws(() => planFrontendInitialization(input));
  const hidden = attendanceInput(2, 6); hidden.current.hiddenColumns = [2, 3, 4];
  hidden.reviewedFictionalReset = { environment: 'staging', generation: 1, sheetId: hidden.current.sheetId,
    tableId: hidden.current.tableId, expectedRead: frontendReadFingerprint(hidden.current) };
  const retained = planFrontendInitialization(hidden);
  assert.deepEqual(retained.expectedAfter.hiddenColumns, [2, 3, 4, 7]);
  assert.ok(verifyFrontendPublicationReadback(retained, apply(hidden.current, retained.requests)), 'reset retains reviewed pre-hidden physical columns');
});

test('500×128 refresh coalesces values into bounded requests and sub-megabyte batches', () => {
  const input = attendanceInput(500, 128); input.revision.operations = 2;
  for (const row of input.table.rows) for (const c of input.table.columns.filter(c => c.editable)) { row.values[c.header] = 'P'; row.versions[c.header] = 2; }
  const plan = planFrontendPublication(input);
  assert.equal(plan.changedCells, 64_000); assert.ok(plan.requests.length <= 20);
  assert.ok(plan.batches.every(batch => batch.length <= 100 && Buffer.byteLength(JSON.stringify({ requests: batch })) < 900_000));
  assert.ok(plan.requests.every(r => !r.appendDimension));
  input.table.columns.push({ header: 'event:excess', label: 'Excess', editable: true }); assert.throws(() => planFrontendPublication(input));
});

test('read-back catches wrong identities, values, missing hidden metadata and Table extents', () => {
  const input = fixture(), plan = planFrontendPublication(input);
  for (const mutate of [x => x.rows[0][3].userEnteredValue.stringValue = 'wrong', x => x.range.endRowIndex++, x => x.hiddenColumns = [], x => x.machineRowHidden = false]) {
    const after = structuredClone(plan.expectedAfter); mutate(after); assert.equal(verifyFrontendPublicationReadback(plan, after), false);
  }
});

test('domain snapshot mapping keeps explicit unknown eligibility and requires real cell versions', () => {
  const p = { personId: 'cadet-a', version: 1, active: true, flightId: 'flight-alpha', firstName: 'Sample', lastName: 'Fictional', asYear: 'AS100', rank: 'C/4C', role: 'Cadet', university: 'Notre Dame', email: '', phone: '', dorm: '', cipBroadArea: '', cipCode: '', afsc: '', homeTown: '', homeState: '', classYear: '2030', dateOfBirth: '2005-03-01', flightPathStatus: 'Active 3/4', photoLink: photo.fileUri };
  const snapshot = { contractVersion: 1, environment: 'local', generation: 1, revision: { operations: 1, administration: 1 }, people: [p], leadership: [],
    flights: [{ flightId: 'flight-alpha', label: 'Alpha', squadronId: 'squadron-blue', rosterVersion: 1 }], squadrons: [{ squadronId: 'squadron-blue', label: 'Blue' }],
    terms: [{ termId: 'term-current', label: 'Spring 2027', sortOrder: 1, isCurrent: true }],
    events: [{ eventId: 'event-a', termId: 'term-current', label: 'LLAB', columnLabel: 'LLAB', eventType: 'llab', trainingWeek: 1, displayOrder: 0, version: 3 }],
    eventFlights: [], observations: [], corrections: [], attendanceVersions: [], requests: [], diagnostics: [] };
  const normalized = snapshotToFrontendReportingInput(snapshot, '2027-01-12'); assert.equal(normalized.events[0].eligiblePersonIds, null);
  const result = buildFrontendReporting(normalized), args = { snapshot, reporting: { revision: snapshot.revision, result }, attendanceVersions: [{ personId: p.personId, eventId: 'event-a', version: 0 }] };
  const model = buildFrontendPublicationModel(args), [directory, leadership, attendance] = model.tables;
  assert.deepEqual(model.tables.map(t => t.keyHeader), ['person_id', 'contact_id', 'person_id']);
  assert.equal(typeof directory.rows[0].values.dob, 'number'); assert.equal(directory.rows[0].values.class_year, '2030');
  assert.deepEqual(directory.rows[0].readonlyHeaders, ['squadron']); assert.equal(directory.rows[0].commandBindings.flight.field, 'flightId');
  assert.equal(directory.rows[0].commandBindings.squadron, undefined);
  assert.deepEqual(directory.rows[0].values.photo_link, photo); assert.equal(leadership.rows.length, 0);
  assert.equal(attendance.rows[0].values.overall_attendance_pct, 1); assert.equal(attendance.rows[0].eventVersions['event:event-a'], 3);
  assert.throws(() => buildFrontendPublicationModel({ ...args, attendanceVersions: [] }));
  assert.throws(() => buildFrontendPublicationModel({ ...args, reporting: { revision: { operations: 2, administration: 1 }, result } }));
  const originalURL = globalThis.URL;
  try { globalThis.URL = undefined; assert.deepEqual(buildFrontendPublicationModel(args).tables[0].rows[0].values.photo_link, photo); }
  finally { globalThis.URL = originalURL; }
  snapshot.leadership = [{ contactId: 'contact-linked', contactVersion: 0, profileVersion: 1, publicationVersion: 1, personId: p.personId,
    lastName: p.lastName, firstName: p.firstName, rank: p.rank, role: 'Alpha Flight Commander', email: '', cellPhone: '', reportsTo: '', officePhone: '', officeLocation: '', active: true },
    { contactId: 'contact-manual', contactVersion: 4, profileVersion: null, publicationVersion: 4, personId: null,
      lastName: 'Fictional', firstName: 'Cadre', rank: 'Capt', role: 'Instructor', email: '', cellPhone: '', reportsTo: '', officePhone: '', officeLocation: '', active: true }];
  const linkedModel = buildFrontendPublicationModel(args).tables[1], linked = linkedModel.rows[0], manual = linkedModel.rows[1];
  assert.deepEqual(linked.readonlyHeaders, ['last_name', 'first_name', 'rank', 'role', 'email', 'cell_phone']);
  assert.deepEqual(Object.keys(linked.commandBindings), ['reports_to', 'office_phone', 'office_location']);
  assert.equal(linked.versions.office_phone, 1); assert.equal(linked.commandBindings.office_phone.expectedVersion, 0);
  assert.equal(manual.readonlyHeaders.length, 0); assert.equal(Object.keys(manual.commandBindings).length, 9);
  const baseRead = read(linkedModel.rows, linkedModel.columns); baseRead.hiddenColumns = [9];
  const publication = { generation: 1, revision: { operations: 1, administration: 2 }, table: linkedModel, current: baseRead,
    baseline: { generation: 1, revision: snapshot.revision, rows: structuredClone(linkedModel.rows) }, drafts: [], seeds: [], editFenceVerified: true };
  linked.values.last_name = 'Updated Directory name'; linked.versions = Object.fromEntries(Object.keys(linked.versions).map(h => [h, 2]));
  const refreshed = planFrontendPublication(publication); assert.equal(refreshed.changedCells, 1);
  baseRead.rows[0][7].userEnteredValue = { stringValue: '555-0100' };
  const pendingPlan = planFrontendPublication(publication), pending = pendingPlan.retainedDrafts[0];
  assert.equal(pending.command.operation, 'leadership.upsert'); assert.equal(pending.command.expectedVersion, 0); assert.equal(pending.baseVersion, 1);
  assert.equal(pendingPlan.diagnostics.find(d => d.header === 'office_phone').code, 'unsent-edit');
  const acknowledged = applyFrontendReceipt({ baseline: publication.baseline, drafts: [pending], draft: pending, receiptVerified: true,
    receipt: { key: pending.key, header: pending.header, baseVersion: 1, committedVersion: 3, value: pending.value, command: { ...pending.command, committedVersion: 1 } } });
  assert.equal(acknowledged.baseline.rows[0].versions.office_phone, 3); assert.equal(acknowledged.baseline.rows[0].commandBindings.office_phone.expectedVersion, 1);
  baseRead.rows[0][0].userEnteredValue = { stringValue: 'Edit on wrong sheet' }; assert.throws(() => planFrontendPublication(publication));
  snapshot.terms[0].roster = [{ personId: p.personId, lastName: p.lastName, firstName: p.firstName, asYear: p.asYear, flightId: p.flightId, flightPathStatus: p.flightPathStatus, dateOfBirth: p.dateOfBirth }];
  snapshot.people[0].active = false;
  assert.equal(buildFrontendReporting(snapshotToFrontendReportingInput(snapshot, '2027-01-12')).dashboard.totalCadets, 0);
});

test('immutable input slots reject physical sorting and never reuse retired identities', () => {
  const input = fixture();
  input.baseline.slots = { headers: [...input.current.headers], keys: ['cadet-b', 'cadet-a'] };
  let plan = planFrontendPublication(input);
  assert.deepEqual(plan.nextBaseline.slots.keys, ['cadet-b', 'cadet-a']);
  const sorted = structuredClone(input); sorted.current.rows.reverse();
  assert.throws(() => planFrontendPublication(sorted), /Immutable frontend/);
  input.table.rows = [record('cadet-a'), record('cadet-c')];
  plan = planFrontendPublication(input);
  assert.deepEqual(plan.nextBaseline.slots.keys, ['cadet-b', 'cadet-a', 'cadet-c']);
  const retired = plan.nextBaseline.rows.find(r => r.key === 'cadet-b');
  assert.equal(retired.retired, true); assert.deepEqual(retired.readonlyHeaders, input.current.headers);
  assert.equal(retired.values.person_id, 'cadet-b'); assert.equal(retired.values.first_name, null);
  assert.equal(verifyFrontendPublicationReadback(plan, apply(input.current, plan.requests)), true);
  const next = { ...input, current: plan.expectedAfter, baseline: plan.nextBaseline };
  next.table = { ...input.table, rows: [record('cadet-a'), record('cadet-b', 'Commander', 2), record('cadet-c')] };
  const returned = planFrontendPublication(next);
  assert.deepEqual(returned.nextBaseline.slots.keys, ['cadet-b', 'cadet-a', 'cadet-c']);
  assert.equal(returned.nextBaseline.rows.find(r => r.key === 'cadet-b').retired, undefined);
  assert.equal(returned.nextBaseline.rows.find(r => r.key === 'cadet-b').readonlyHeaders.includes('role'), false);
});

test('immutable slot retirement retains outstanding drafts instead of silently clearing them', () => {
  const input = fixture(); input.baseline.slots = { headers: [...input.current.headers], keys: ['cadet-b', 'cadet-a'] };
  input.current.rows[0][1] = frontendLiteralCell('Commander');
  input.table.rows = [record('cadet-a'), record('cadet-c')];
  const plan = planFrontendPublication(input);
  assert.deepEqual(plan.nextBaseline.slots.keys, ['cadet-b', 'cadet-a', 'cadet-c']);
  assert.equal(plan.nextBaseline.rows.find(r => r.key === 'cadet-b').retired, undefined);
  assert.equal(plan.retainedDrafts[0].key, 'cadet-b');
  assert.ok(plan.diagnostics.some(d => d.code === 'retired-row-with-edit'));
});
