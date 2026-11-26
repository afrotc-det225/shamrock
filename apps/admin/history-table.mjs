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
