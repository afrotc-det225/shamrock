import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExcusalPublicationTables, planExcusalPublication, frontendTimestampSerial, planDashboardPublication,
  verifyDashboardPublicationReadback } from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';
import { buildFrontendDashboard } from '../../.build/v3/apps/google-adapter/src/frontend-dashboard.js';
import { frontendLiteralCell, snapshotToFrontendReportingInput, verifyFrontendValidationReadback } from '../../.build/v3/apps/google-adapter/src/frontend-publication.js';
import { buildFrontendReporting } from '../../.build/v3/packages/domain/src/frontend-reporting.js';

function snapshot() {
  const people = ['a', 'b'].map((x, i) => ({ personId: `cadet-${x}`, firstName: `Sample ${x}`, lastName: 'Fictional', asYear: i ? 'AS300' : 'AS100', flightId: i ? 'flight-bravo' : 'flight-alpha', active: true,
    version: 1, flightPathStatus: 'Active 3/4', dateOfBirth: i ? null : '2005-03-01', email: '' }));
  return { contractVersion: 1, environment: 'local', generation: 1, revision: { operations: 3, administration: 2 }, people, leadership: [],
    flights: [{ flightId: 'flight-alpha', label: 'Alpha', squadronId: 'squadron-blue', rosterVersion: 1 }, { flightId: 'flight-bravo', label: 'Bravo', squadronId: 'squadron-gold', rosterVersion: 1 }],
    squadrons: [{ squadronId: 'squadron-blue', label: 'Blue' }, { squadronId: 'squadron-gold', label: 'Gold' }], terms: [{ termId: 'current', label: 'Spring 2027', isCurrent: true, sortOrder: 1 }],
    events: [{ eventId: 'event-llab', termId: 'current', label: 'LLAB', columnLabel: 'TW-1 LLAB', eventType: 'llab', trainingWeek: 1, displayOrder: 0, version: 1, eligiblePersonIds: ['cadet-a', 'cadet-b'] }],
    eventFlights: [], observations: [{ factId: 'present-a', personId: 'cadet-a', eventId: 'event-llab', order: 1, code: 'P' }], corrections: [], attendanceVersions: [], diagnostics: [],
    requests: ['a', 'b'].map((x, i) => ({ requestId: `request-${x}`, personId: `cadet-${x}`, eventId: 'event-llab', flightId: i ? 'flight-bravo' : 'flight-alpha', order: i + 2, status: i ? 'Submitted' : 'Approved', requestedOutcome: 'E', version: i ? 1 : 2, reason: 'Fictional scheduling conflict', submittedAt: '2027-01-12T13:00:00.000Z', submittedBy: `principal-${x}`, updatedAt: '2027-01-12T13:00:00.000Z', decidedAt: i ? null : '2027-01-12T13:00:00.000Z', decidedBy: null, decisionReason: null })) };
}
const binding = snapshot => ({ snapshot, blueSquadronId: 'squadron-blue', goldSquadronId: 'squadron-gold', timeZone: 'America/Indiana/Indianapolis' });
const dataRule = { strict: true, showCustomUi: true, condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='_Excusals Data Legend'!$A$3:$A$6" }] } };
function excusalInput(table, revision = { operations: 3, administration: 2 }) {
  return { generation: 1, revision, table, current: { sheetId: table.title === 'Blue' ? 201 : 202, tableId: `table-${table.title}`, gridRowCount: 502, gridColumnCount: 10,
    headers: table.columns.map(c => c.header), labels: table.columns.map(c => c.label), rows: table.rows.map(r => table.columns.map(c => frontendLiteralCell(r.values[c.header]))),
    range: { sheetId: table.title === 'Blue' ? 201 : 202, startRowIndex: 1, endRowIndex: table.rows.length + 2, startColumnIndex: 0, endColumnIndex: 10 }, hiddenColumns: [9], machineRowHidden: true },
    baseline: { generation: 1, revision, rows: structuredClone(table.rows) }, drafts: [], editFenceVerified: true,
    seeds: [{ key: 'excusal:decision', sheetId: 203, rowIndex: 2, columnIndex: 0, protected: true, hidden: true, nativeStyleVersion: 'decision-v1', expectedRule: dataRule, observedRule: dataRule }] };
}

test('Blue/Gold rows use stable request IDs, source flight scope, local timestamps and only decision input', () => {
  const source = snapshot(); source.people[0].flightId = 'flight-bravo'; // request was submitted through Alpha
  const tables = buildExcusalPublicationTables(binding(source));
  assert.deepEqual(tables.map(t => [t.title, t.rows[0].key]), [['Blue', 'request-a'], ['Gold', 'request-b']]);
  assert.equal(tables[0].rows[0].values.flight, 'Alpha'); assert.equal(tables[0].rows[0].values.decision, 'Approved');
  assert.equal(tables[1].rows[0].values.decision, null);
  assert.equal(tables[0].rows[0].commandBindings.decision.operation, 'excusal.decide');
  assert.equal(tables[0].rows[0].commandBindings.decision.expectedVersion, 2);
  assert.deepEqual(tables[0].columns.filter(c => c.editable).map(c => c.header), ['decision']);
  const expected = (Date.UTC(2027, 0, 12, 8) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(tables[0].rows[0].values.timestamp, expected);
  assert.throws(() => frontendTimestampSerial('2027-02-30T13:00:00Z', 'America/Indiana/Indianapolis'));
  const originalIntl = globalThis.Intl;
  try {
    globalThis.Intl = undefined;
    const native = buildExcusalPublicationTables({ ...binding(source), timestampSerial: (iso, zone) => {
      assert.equal(iso, '2027-01-12T13:00:00.000Z'); assert.equal(zone, 'America/Indiana/Indianapolis'); return expected;
    } });
    assert.equal(native[0].rows[0].values.timestamp, expected);
    assert.throws(() => buildExcusalPublicationTables({ ...binding(source), timestampSerial: () => NaN }));
  } finally { globalThis.Intl = originalIntl; }
});

test('decision publication preserves unsent edits and detects a recorded-version conflict', () => {
  const input = excusalInput(buildExcusalPublicationTables(binding(snapshot()))[0]);
  input.current.rows[0][1].userEnteredValue = { stringValue: 'Denied' };
  let plan = planExcusalPublication(input);
  assert.equal(plan.changedCells, 0); assert.equal(plan.complete, false); assert.equal(plan.retainedDrafts[0].command.entityId, 'request-a');
  assert.equal(plan.retainedDrafts[0].baseVersion, 2);
  input.table.rows[0].values.decision = 'Withdrawn'; input.table.rows[0].versions.decision = 3; input.table.rows[0].commandBindings.decision.expectedVersion = 3;
  plan = planExcusalPublication(input); assert.equal(plan.diagnostics[0].code, 'version-conflict');
  assert.equal(plan.expectedAfter.rows[0][1].userEnteredValue.stringValue, 'Denied');
});

test('new decision rows inherit the native arrow rule and require targeted validation read-back', () => {
  const table = buildExcusalPublicationTables(binding(snapshot()))[0], input = excusalInput(table);
  const added = structuredClone(table.rows[0]); added.key = 'request-second'; added.values.request_id = added.key; added.values.decision = null; added.versions.decision = 1; added.commandBindings.decision = { operation: 'excusal.decide', entityId: added.key, field: 'decision', expectedVersion: 1 }; table.rows.push(added);
  const plan = planExcusalPublication(input); assert.equal(plan.validationExpectations.length, 1);
  const [{ expectedRule, ...range }] = plan.validationExpectations;
  assert.equal(verifyFrontendValidationReadback(plan, [{ ...range, rows: [[expectedRule]] }]), true);
  assert.equal(verifyFrontendValidationReadback(plan, [{ ...range, rows: [[null]] }]), false);
  assert.ok(plan.requests.filter(r => r.copyPaste).every(r => r.copyPaste.pasteType === 'PASTE_DATA_VALIDATION'));
});

test('excusal publication rejects missing targets, ambiguous bindings and unsupported decisions', () => {
  const source = snapshot();
  assert.throws(() => buildExcusalPublicationTables({ ...binding(source), blueSquadronId: 'squadron-gold' }));
  source.requests[0].status = 'Unknown'; assert.throws(() => buildExcusalPublicationTables(binding(source)));
  source.requests[0].status = 'Approved'; source.requests[0].personId = 'missing'; assert.throws(() => buildExcusalPublicationTables(binding(source)));
  const input = excusalInput(buildExcusalPublicationTables(binding(snapshot()))[0]); input.drafts = [{ key: 'request-a', header: 'decision', baseVersion: 2, value: '' }];
  assert.throws(() => planExcusalPublication(input));
});

function dashboardInput(source = snapshot()) {
  const result = buildFrontendReporting(snapshotToFrontendReportingInput(source, '2027-01-12'));
  const actions = [{ label: 'Attendance', url: '#gid=104' }];
  const layout = buildFrontendDashboard({ sheetId: 101, dataSheetId: 106, actions,
    metrics: Array.from({ length: 6 }, (_, i) => ({ label: `Metric ${i}`, value: 0 })),
    charts: [0, 5, 8, 11].map((sourceColumn, i) => ({ title: `Old chart ${i}`, axis: 'Flight', sourceColumn, sourceEndRow: 2 })) });
  const canvas = Array.from({ length: 70 }, () => Array.from({ length: 12 }, () => ({})));
  for (const r of layout) if (r.updateCells) canvas[r.updateCells.start.rowIndex][r.updateCells.start.columnIndex] = r.updateCells.rows[0].values[0];
  const charts = layout.filter(r => r.addChart).map((r, i) => ({ chartId: i + 301, ...r.addChart.chart }));
  const current = { sheetId: 101, dataSheetId: 106, canvas, data: Array.from({ length: 52 }, () => Array.from({ length: 16 }, () => ({}))), canvasGrid: { rowCount: 1000, columnCount: 12 }, dataGrid: { rowCount: 1000, columnCount: 16 }, dataHidden: true,
    merges: layout.filter(r => r.mergeCells).map(r => r.mergeCells.range), charts };
  return { revision: source.revision, previousRevision: structuredClone(source.revision), reporting: { revision: source.revision, result }, current, chartIds: charts.map(c => c.chartId), actions, editFenceVerified: true };
}
const cell = (plan, row, col) => plan.expectedAfter.canvas[row][col].userEnteredValue;

test('Dashboard keeps compact layout and four chart identities while publishing real metrics, sources and birthdays', () => {
  const input = dashboardInput(), before = structuredClone(input), plan = planDashboardPublication(input);
  assert.deepEqual(input, before); assert.deepEqual(plan.expectedAfter.charts.map(c => c.chartId), [301, 302, 303, 304]);
  assert.deepEqual(plan.expectedAfter.charts.map(c => c.position), input.current.charts.map(c => c.position));
  assert.ok(plan.requests.every(r => !r.addChart && !r.deleteEmbeddedObject && !r.updateTable && !r.setDataValidation));
  assert.equal(cell(plan, 3, 4).numberValue, 2); assert.equal(cell(plan, 6, 4).numberValue, 1);
  assert.equal(plan.birthdayCount, 1); assert.equal(cell(plan, 49, 0).stringValue, 'Birthday calendar');
  assert.equal(cell(plan, 51, 0).stringValue, 'Fictional'); assert.match(cell(plan, 51, 3).stringValue, /C\/Fictional \(3\/1\)/);
  assert.equal(plan.expectedAfter.data[0][5].userEnteredValue.stringValue, 'Term');
  assert.equal(plan.expectedAfter.charts[0].spec.hiddenDimensionStrategy, 'SHOW_ALL');
  assert.equal(verifyDashboardPublicationReadback(plan, structuredClone(plan.expectedAfter)), true);
  const reordered = structuredClone(plan.expectedAfter);
  reordered.merges = reordered.merges.map(r => Object.fromEntries(Object.entries(r).reverse()));
  assert.equal(verifyDashboardPublicationReadback(plan, reordered), true);
  const missingChart = structuredClone(plan.expectedAfter); missingChart.charts.pop();
  assert.equal(verifyDashboardPublicationReadback(plan, missingChart), false);
  const bad = structuredClone(plan.expectedAfter); bad.canvas[3][4].userEnteredValue.numberValue = 99;
  assert.equal(verifyDashboardPublicationReadback(plan, bad), false);
});

test('Dashboard has honest empty states, clears old birthdays, and does not fabricate a zero average', () => {
  const source = snapshot(); source.people.forEach(p => p.dateOfBirth = null);
  const input = dashboardInput(source); input.current.canvas[55][0] = frontendLiteralCell('Old birthday output');
  let plan = planDashboardPublication(input); assert.equal(cell(plan, 51, 0).stringValue, 'No birthdays recorded.');
  assert.equal(cell(plan, 55, 0), undefined); assert.match(cell(plan, 47, 0).stringValue, /no counted attendance/);
  source.people.forEach(p => p.active = false); const empty = dashboardInput(source); plan = planDashboardPublication(empty);
  assert.equal(cell(plan, 6, 4), undefined); assert.equal(cell(plan, 3, 4).numberValue, 0);
});

test('Dashboard refuses stale snapshots, an unfenced refresh or a mismatched native canvas', () => {
  for (const mutate of [x => x.editFenceVerified = false, x => x.previousRevision.operations++, x => x.current.merges.pop(), x => x.chartIds[0] = 999,
    x => x.actions[0].url = 'https://example.invalid']) {
    const input = dashboardInput(); mutate(input); assert.throws(() => planDashboardPublication(input));
  }
});

test('native chart readback accepts only provider font/color representations, with strict data and axis checks', () => {
  const plan = planDashboardPublication(dashboardInput());
  const actual = structuredClone(plan.expectedAfter);
  const encoded = color => Object.fromEntries(Object.entries(color).map(([k, v]) => [k, Math.fround(Math.floor(v * 255 + 0.00001) / 255)]));
  for (const chart of actual.charts) {
    const spec = chart.spec;
    delete spec.backgroundColor; // Sheets omits the default white background.
    spec.titleTextFormat.fontFamily = spec.fontName;
    spec.titleTextFormat.foregroundColor = encoded(spec.titleTextFormat.foregroundColor);
    spec.titleTextFormat.foregroundColorStyle = { rgbColor: structuredClone(spec.titleTextFormat.foregroundColor) };
    for (const axis of spec.basicChart.axis) { axis.format = { fontFamily: spec.fontName }; axis.viewWindowOptions ??= {}; }
    for (const series of spec.basicChart.series) {
      series.colorStyle.rgbColor = encoded(series.colorStyle.rgbColor);
      series.color = structuredClone(series.colorStyle.rgbColor);
    }
  }
  assert.equal(verifyDashboardPublicationReadback(plan, actual), true);
  for (const mutate of [
    x => x.charts[0].spec.basicChart.axis[1].viewWindowOptions.viewWindowMax = 99,
    x => x.charts[0].spec.basicChart.axis[0].format.fontFamily = 'Arial',
    x => x.charts[0].spec.basicChart.series[0].series.sourceRange.sources[0].endRowIndex++,
    x => x.charts[0].spec.basicChart.series[0].color.red = 0.9,
    x => x.charts[0].spec.backgroundColor = { red: 0, green: 0, blue: 0 },
    x => x.charts[0].spec.hiddenDimensionStrategy = 'SKIP_HIDDEN_ROWS_AND_COLUMNS',
  ]) {
    const changed = structuredClone(actual); mutate(changed);
    assert.equal(verifyDashboardPublicationReadback(plan, changed), false);
  }
  const next = dashboardInput(); next.current = actual;
  assert.equal(planDashboardPublication(next).requests.some(r => r.updateChartSpec), false);
});
