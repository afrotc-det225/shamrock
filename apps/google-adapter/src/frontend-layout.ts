/** Production Attendance layout. Never changes values, validation, colors or Tables. */
export interface AttendanceLayoutInput {
  sheetId: number;
  headers: readonly string[];
  labels: readonly string[];
  eventHeaders: readonly string[];
  dataEndRow: number;
}
type Request = Record<string, unknown>;
const WIDTHS: Record<string, number> = {
  last_name: 115, first_name: 115, as_year: 100, flight: 75, squadron: 75,
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
    // Production uses uniform event widths, including long event labels.
    const width = event ? 75 : WIDTHS[header];
    if (width === undefined) continue;
    requests.push(dimension(input.sheetId, 'COLUMNS', index, index + 1, width));
    requests.push(format(input, 1, 2, index, index + 1, {
      textFormat: { fontFamily: 'Roboto', fontSize: event ? 5 : 10, bold: true },
      wrapStrategy: event ? 'WRAP' : 'CLIP', verticalAlignment: 'MIDDLE', horizontalAlignment: 'LEFT',
    }, 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment,userEnteredFormat.horizontalAlignment'));
    if (event || header.endsWith('_pct')) requests.push(format(input, 2, input.dataEndRow, index, index + 1, {
      numberFormat: event ? { type: 'TEXT' } : { type: 'PERCENT', pattern: '0.0%' }, horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', textFormat: { fontFamily: 'Roboto', fontSize: 10, bold: true },
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.bold'));
  }
  return requests;
}
function rows(input: AttendanceLayoutInput, startRow: number): Request[] {
  if (startRow >= input.dataEndRow) return [];
  const requests = [dimension(input.sheetId, 'ROWS', startRow, input.dataEndRow, 21),
    format(input, startRow, input.dataEndRow, 0, input.headers.length, {
      textFormat: { fontFamily: 'Roboto', fontSize: 10, bold: false }, verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', horizontalAlignment: 'LEFT',
    }, 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.bold,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.horizontalAlignment')];
  for (const header of input.eventHeaders) {
    const column = input.headers.indexOf(header);
    requests.push(format(input, startRow, input.dataEndRow, column, column + 1, {
      numberFormat: { type: 'TEXT' }, horizontalAlignment: 'CENTER', textFormat: { bold: true },
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold'));
  }
  for (const header of ['overall_attendance_pct', 'llab_attendance_pct']) {
    const column = input.headers.indexOf(header); if (column < 0) continue;
    requests.push(format(input, startRow, input.dataEndRow, column, column + 1, {
      numberFormat: { type: 'PERCENT', pattern: '0.0%' }, horizontalAlignment: 'CENTER', textFormat: { bold: true },
    }, 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold'));
  }
  return requests;
}
/** Explicit layout repair/initialization. Saved Flight filter views continue to
 * work with Year/Flight/Squadron hidden directly, without dimension groups. */
export function buildAttendanceLayout(input: AttendanceLayoutInput, collapseIdentityDetails = true): Request[] {
  validate(input);
  const requests: Request[] = [{ updateSheetProperties: { properties: { sheetId: input.sheetId,
    gridProperties: { frozenRowCount: 2, frozenColumnCount: 2, hideGridlines: false } },
  fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.hideGridlines' } },
  dimension(input.sheetId, 'ROWS', 0, 2, 21), ...rows(input, 2), ...columns(input, input.headers),
  { updateDimensionProperties: { range: { sheetId: input.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
    properties: { hiddenByUser: true }, fields: 'hiddenByUser' } }];
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
  return [...rows(input, Math.max(2, previousEndRow)), ...columns(input, added)];
}
