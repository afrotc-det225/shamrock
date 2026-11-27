// Bootstrap only the two generated reporting tabs. The normal D1 Dashboard
// planner supplies the data, formulas and four chart specs after layout adoption.
import { isDeepStrictEqual as same } from 'node:util';
import { buildFrontendDashboard } from '../../.build/v3/apps/google-adapter/src/frontend-dashboard.js';
import {
  planDashboardPublication,
  verifyDashboardPublicationReadback
} from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';
import { importDigest } from './import-capture.mjs';

const titles = [
  ['Overall Attendance by AS Year — Current vs Historical'],
  ['Detachment Attendance Trend by Term', 'Wing Attendance Trend by Term'],
  ['Current Overall Attendance by Flight'],
  ['Current Roster by AS Year']
];
const grid = (height, width) => Array.from({ length: height }, () => Array.from({ length: width }, () => ({})));
function check(ok, message) {
  if (!ok) throw new Error(message);
}
export function prepareNativeDashboard(packet, capture, reporting) {
  const { snapshotSha256, ...body } = capture;
  check(
    snapshotSha256 === packet.rows.snapshotSha256 &&
      importDigest(body) === snapshotSha256 &&
      same(reporting.revision, packet.rows.revision) &&
      !reporting.result.needsReview,
    'Dashboard source or reporting revision needs review'
  );
  const book = capture.resources.find((r) => r.providerId === packet.books.main.spreadsheetId);
  const managed = (name) => book.sheets.find((s) => s.metadata.properties.sheetId === packet.books.main.tabs[name].sheetId);
  const canvas = managed('Dashboard'),
    data = managed('Dashboard Data');
  check(
    canvas &&
      data &&
      data.metadata.properties.hidden &&
      !data.metadata.charts?.length &&
      !data.metadata.merges?.length &&
      [canvas, data].every((s) => !s.metadata.tables?.length && !s.rows.some((r) => r.some((c) => c.note || c.chipRuns?.length))),
    'Reporting tabs include unreviewed operator content'
  );
  const sheetId = canvas.metadata.properties.sheetId,
    dataSheetId = data.metadata.properties.sheetId;
  const charts = canvas.metadata.charts,
    chartIds = titles.map((group) => {
      const matches = charts.filter((c) => group.includes(c.spec.title));
      check(matches.length === 1, 'Dashboard chart mapping needs review');
      return matches[0].chartId;
    });
  check(charts.length === 4 && new Set(chartIds).size === 4, 'Unexpected chart inventory');
  const requests = [],
    sizes = [];
  for (const [sheet, width, max] of [
    [canvas, 12, 602],
    [data, 16, 1002]
  ]) {
    const p = sheet.metadata.properties,
      prior = p.gridProperties;
    check(prior.rowCount <= max && prior.columnCount <= width, 'Dashboard source exceeds the reviewed canvas');
    const rowCount = Math.max(prior.rowCount, sheet === canvas ? 70 : 2);
    if (rowCount !== prior.rowCount || width !== prior.columnCount)
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: p.sheetId, gridProperties: { rowCount, columnCount: width } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount'
        }
      });
    sizes.push({ rowCount, columnCount: width });
    for (const range of sheet.metadata.merges ?? []) requests.push({ unmergeCells: { range } });
    requests.push({
      repeatCell: {
        range: { sheetId: p.sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: width },
        cell: {},
        fields: 'userEnteredValue'
      }
    });
  }
  const metrics = ['Total cadets', 'GMC cadets', 'POC cadets', 'Average overall', 'Average LLAB', 'Below 80%'].map(
    (label, i) => ({ label, value: 0, format: [3, 4].includes(i) ? 'percent' : 'count' })
  );
  const layout = buildFrontendDashboard({
    sheetId,
    dataSheetId,
    actions: packet.dashboardActions,
    metrics,
    charts: titles.map((t) => ({ title: t[0], axis: 'Cadets', sourceEndRow: 2, sourceColumn: 0 }))
  });
  let chart = 0;
  for (const r of layout) {
    if (r.addChart)
      requests.push({
        updateEmbeddedObjectPosition: {
          objectId: chartIds[chart++],
          newPosition: r.addChart.chart.position,
          fields: 'anchorCell,widthPixels,heightPixels'
        }
      });
    else if (!r.updateCells) requests.push(r); // The normal planner writes the actual metrics and actions.
  }
  const current = {
    sheetId,
    dataSheetId,
    canvas: grid(sizes[0].rowCount, 12),
    data: grid(sizes[1].rowCount, 16),
    canvasGrid: sizes[0],
    dataGrid: sizes[1],
    dataHidden: true,
    merges: layout.filter((r) => r.mergeCells).map((r) => r.mergeCells.range),
    charts
  };
  const plan = planDashboardPublication({
    revision: reporting.revision,
    previousRevision: reporting.revision,
    reporting,
    current,
    chartIds,
    actions: packet.dashboardActions,
    editFenceVerified: true
  }); // simulated fenced state; actual publication requires the operator fence
  requests.push(...plan.requests);
  check(
    requests.length <= 1000 && Buffer.byteLength(JSON.stringify({ requests })) <= 1800000,
    'Dashboard exceeds the atomic request budget'
  );
  const positions = Object.fromEntries(
    requests
      .filter((r) => r.updateEmbeddedObjectPosition)
      .map((r) => [r.updateEmbeddedObjectPosition.objectId, r.updateEmbeddedObjectPosition.newPosition])
  );
  return {
    spreadsheetId: book.providerId,
    manifestSha256: capture.manifestSha256,
    requests,
    expectedAfter: plan.expectedAfter,
    chartIds,
    positions
  };
}

export function verifyAdoptedDashboard(plan, capture) {
  const { snapshotSha256, ...body } = capture;
  check(
    capture.consistent && capture.manifestSha256 === plan.manifestSha256 && importDigest(body) === snapshotSha256,
    'Expected coherent Dashboard capture'
  );
  const book = capture.resources.find((r) => r.providerId === plan.spreadsheetId && r.kind === 'workbook'),
    expected = plan.expectedAfter;
  const canvas = book?.sheets.find((s) => s.metadata.properties.sheetId === expected.sheetId);
  const data = book?.sheets.find((s) => s.metadata.properties.sheetId === expected.dataSheetId);
  check(canvas && data, 'Original Dashboard or data tab missing');
  const extent = (s) => ({
    rowCount: s.metadata.properties.gridProperties.rowCount,
    columnCount: s.metadata.properties.gridProperties.columnCount
  });
  const read = (s, height, width) =>
    Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => s.rows[r]?.[c] ?? {}));
  const actual = {
    sheetId: expected.sheetId,
    dataSheetId: expected.dataSheetId,
    canvasGrid: extent(canvas),
    dataGrid: extent(data),
    canvas: read(canvas, expected.canvas.length, 12),
    data: read(data, expected.data.length, 16),
    merges: canvas.metadata.merges,
    charts: canvas.metadata.charts,
    dataHidden: data.metadata.properties.hidden
  };
  check(verifyDashboardPublicationReadback(plan, actual), 'Dashboard links, data, chart specs or layout differ');
  for (const chart of actual.charts) {
    const p = plan.positions[chart.chartId]?.overlayPosition,
      a = chart.position?.overlayPosition;
    check(
      p &&
        a &&
        p.widthPixels === a.widthPixels &&
        p.heightPixels === a.heightPixels &&
        ['sheetId', 'rowIndex', 'columnIndex'].every((k) => (a.anchorCell[k] ?? 0) === (p.anchorCell[k] ?? 0)),
      'Dashboard chart position differs'
    );
  }
}
