import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontendDashboard } from '../../.build/v3/apps/google-adapter/src/frontend-dashboard.js';

const input = () => ({ sheetId: 101, dataSheetId: 106,
  actions: [{ label: 'Attendance', url: '#gid=104' }],
  metrics: Array.from({ length: 6 }, (_, i) => ({ label: `Metric ${i}`, value: i })),
  charts: Array.from({ length: 4 }, (_, i) => ({ title: `Chart ${i}`, axis: 'Flight', sourceColumn: i * 2, sourceEndRow: 5 })),
});

test('Dashboard starts with its title and actions, without rehearsal banners or inactive buttons', () => {
  const requests = buildFrontendDashboard(input());
  const writes = requests.flatMap(r => r.updateCells ? [r.updateCells] : []);
  assert.equal(writes.find(w => w.start.rowIndex === 0).rows[0].values[0].userEnteredValue.stringValue, 'SHAMROCK Dashboard');
  assert.equal(writes.find(w => w.start.rowIndex === 1).rows[0].values[0].userEnteredValue.stringValue, 'Quick actions');
  assert.equal(writes.filter(w => w.rows[0].values[0].userEnteredValue.formulaValue).length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /preview|fictional|test only/i);
  const charts = requests.flatMap(r => r.addChart ? [r.addChart.chart] : []);
  assert.deepEqual(charts.map(c => c.position.overlayPosition.anchorCell.rowIndex), [9, 9, 22, 22]);
  assert.equal(charts.every(c => c.spec.hiddenDimensionStrategy === 'SHOW_ALL'), true);
  assert.equal(requests.some(r => r.setDataValidation || r.updateTable || r.deleteSheet), false);
});

test('Dashboard rejects formula/link injection and nonnumeric or unbounded chart data', () => {
  for (const url of ['javascript:alert(1)', 'https://example.com', '#gid=1\",\"bad', 'https://docs.google.com/\"&IMPORTRANGE(\"x']) {
    assert.throws(() => buildFrontendDashboard({ ...input(), actions: [{ label: 'Open', url }] }));
  }
  assert.throws(() => buildFrontendDashboard({ ...input(), metrics: [{ label: 'Bad', value: NaN }, ...input().metrics.slice(1)] }));
  assert.throws(() => buildFrontendDashboard({ ...input(), charts: [{ ...input().charts[0], sourceEndRow: 0 }, ...input().charts.slice(1)] }));
});
