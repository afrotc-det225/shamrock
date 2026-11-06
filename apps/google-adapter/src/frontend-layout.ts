/** Compact native Attendance layout. Never changes values, validation, colors or Tables. */
export interface AttendanceLayoutInput {
  sheetId: number;
  headers: readonly string[];
  labels: readonly string[];
  eventHeaders: readonly string[];
  dataEndRow: number;
}
type Request = Record<string, unknown>;
const WIDTHS: Record<string, number> = {
  last_name: 110, first_name: 100, as_year: 60, flight: 75, squadron: 60,
  overall_attendance_pct: 75, llab_attendance_pct: 75,
};
function validate(input: AttendanceLayoutInput): void {
  if (!Number.isSafeInteger(input.sheetId) || input.sheetId < 0 || !Number.isSafeInteger(input.dataEndRow)
    || input.dataEndRow < 3 || input.dataEndRow > 10002 || input.headers.length !== input.labels.length
    || input.headers.length > 160 || new Set(input.headers).size !== input.headers.length
    || input.eventHeaders.some(h => !input.headers.includes(h))) throw Error('Invalid Attendance layout bounds.');
}
const dimension = (sheetId: number, kind: 'ROWS' | 'COLUMNS', start: number, end: number, pixels: number): Request => ({
  updateDimensionProperties: { range: { sheetId, dimension: kind, startIndex: start, endIndex: end },
    properties: { pixelSize: pixels }, fields: 'pixelSize' },
});
function format(input: AttendanceLayoutInput, startRow: number, endRow: number, startColumn: number, endColumn: number,
  style: Record<string, unknown>, fields: string): Request {
  return { repeatCell: { range: { sheetId: input.sheetId, startRowIndex: startRow, endRowIndex: endRow,
    startColumnIndex: startColumn, endColumnIndex: endColumn }, cell: { userEnteredFormat: style }, fields } };
}
function columns(input: AttendanceLayoutInput, headers: readonly string[]): Request[] {
  const requests: Request[] = [];
  for (const header of headers) {
    const index = input.headers.indexOf(header), event = input.eventHeaders.includes(header);
    // Native Table headers reserve room for their menu. Fit whole short words
    // such as Mando and Secondary without returning to oversized 130px cells.
    const longestWord = Math.max(0, ...input.labels[index].split(/\s+/).map(word => word.length));
    const width = event ? Math.max(75, Math.min(95, Math.ceil((34 + longestWord * 6) / 5) * 5)) : WIDTHS[header];
    if (width === undefined) continue;
    requests.push(dimension(input.sheetId, 'COLUMNS', index, index + 1, width));
    requests.push(format(input, 1, 2, index, index + 1, {
      textFormat: { fontFamily: 'Roboto', fontSize: event || header.endsWith('_pct') ? 8 : 9, bold: true },
      wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE',
    }, 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment'));
    if (event) requests.push(format(input, 2, input.dataEndRow, index, index + 1, {
      numberFormat: { type: 'TEXT' }, horizontalAlignment: 'CENTER', textFormat: { fontSize: 9, bold: true },
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.bold'));
  }
  return requests;
}
function rows(input: AttendanceLayoutInput, startRow: number): Request[] {
  if (startRow >= input.dataEndRow) return [];
  const requests = [dimension(input.sheetId, 'ROWS', startRow, input.dataEndRow, 23),
    format(input, startRow, input.dataEndRow, 0, input.headers.length, {
      textFormat: { fontFamily: 'Roboto', fontSize: 9 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP',
    }, 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy')];
  for (const header of input.eventHeaders) {
    const column = input.headers.indexOf(header);
    requests.push(format(input, startRow, input.dataEndRow, column, column + 1, {
      numberFormat: { type: 'TEXT' }, horizontalAlignment: 'CENTER', textFormat: { bold: true },
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold'));
  }
  for (const header of ['overall_attendance_pct', 'llab_attendance_pct']) {
    const column = input.headers.indexOf(header); if (column < 0) continue;
    requests.push(format(input, startRow, input.dataEndRow, column, column + 1, {
      numberFormat: { type: 'PERCENT', pattern: '0.0%' }, horizontalAlignment: 'CENTER',
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment'));
  }
  return requests;
}
function headerHeight(input: AttendanceLayoutInput): number {
  const longest = Math.max(0, ...input.eventHeaders.map(h => input.labels[input.headers.indexOf(h)].length));
  return Math.min(76, Math.max(40, 12 + 12 * Math.ceil(longest / 12)));
}
/** Explicit layout repair/initialization. Saved Flight filter views continue to
 * work with the production-standard Year/Flight/Squadron columns collapsed. */
export function buildAttendanceLayout(input: AttendanceLayoutInput, collapseIdentityDetails = true): Request[] {
  validate(input);
  const requests = [dimension(input.sheetId, 'ROWS', 1, 2, headerHeight(input)), ...rows(input, 2), ...columns(input, input.headers)];
  if (collapseIdentityDetails) for (const header of ['as_year', 'flight', 'squadron']) {
    const index = input.headers.indexOf(header); if (index < 0) continue;
    requests.push({ updateDimensionProperties: { range: { sheetId: input.sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
      properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  }
  return requests;
}
/** Routine publication sizes new rows/columns and retains existing user widths. */
export function buildAttendanceGrowthLayout(input: AttendanceLayoutInput, previousHeaders: readonly string[], previousEndRow: number): Request[] {
  validate(input);
  if (!Number.isSafeInteger(previousEndRow) || previousEndRow < 2 || previousEndRow > 10002
    || previousHeaders.some(h => !input.headers.includes(h))) throw Error('Invalid previous Attendance bounds.');
  const added = input.headers.filter(h => !previousHeaders.includes(h));
  return [...rows(input, Math.max(2, previousEndRow)), ...columns(input, added),
    ...(added.some(h => input.eventHeaders.includes(h)) ? [dimension(input.sheetId, 'ROWS', 1, 2, headerHeight(input))] : [])];
}
