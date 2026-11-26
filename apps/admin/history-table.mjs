export function compactReport(report) {
  const headers = report.eventColumns.map(c => c.snapshotEventId);
  return { headers: report.eventColumns.map(c => c.header), summary: {
    unresolvedRows: report.summary.unresolvedRows, formulaMismatches: report.summary.formulaMismatches
  }, rows: report.rows.map(row => {
    const codes = new Map(row.cells.map(cell => [cell.eventId, cell.code]));
    if (codes.size !== headers.length || headers.some(id => !codes.has(id))) throw Error('Incomplete report row');
    return { rowId:row.rowId, firstName:row.firstName, lastName:row.lastName, asYear:row.asYear, flight:row.flight,
      identityStatus:row.identityStatus, overall:row.overall.stored, llab:row.llab.stored,
      codes:headers.map(id => codes.get(id)) };
  }) };
}

// Published alongside the private semester catalog. No identities or cells are included.
export const historyChartsKey = generation => `history/v1/g${generation}/chart-averages-v1`;
export function semesterAverages(label, rows) {
  const mean = values => {
    const present = values.filter(Number.isFinite);
    return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
  };
  const years = new Map();
  for (const row of rows) {
    const year = String(row.asYear).replace(/\s/g, "").toUpperCase();
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(row.overall);
  }
  return {label, overall:mean(rows.map(r => r.overall)), llab:mean(rows.map(r => r.llab)),
    byYear:Object.fromEntries([...years].map(([year, values]) => [year, mean(values)]))};
}
