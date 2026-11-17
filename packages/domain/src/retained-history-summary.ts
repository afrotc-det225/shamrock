/** Bounded saved-value summaries. They never reconstruct a person's historical identity or eligibility. */
import { AS_YEAR_DISPLAY_ORDER } from './cadet-display-order.js';
export const RETAINED_HISTORY_SUMMARY_VERSION = 'retained-history-summary-v1' as const;
export interface RetainedHistorySelection { snapshotId: string; sourceSnapshotSha256: string; expectedPeriodLabel: string }
export interface ReviewedRetainedTerm extends RetainedHistorySelection { termId: string; label: string; sortOrder: number }
export interface ReviewedRetainedHistory { version: 1; reviewId: string; selectionSha256: string; terms: ReviewedRetainedTerm[] }
export interface SavedPercentageSummary { percentage: number | null; contributors: number; omitted: number }
export interface RetainedHistorySummary extends RetainedHistorySelection {
  rows: number; unresolvedRows: number; unknownAsYearRows: number;
  overall: SavedPercentageSummary; llab: SavedPercentageSummary;
  attendanceByYear: { asYear: string; rows: number; overall: SavedPercentageSummary; llab: SavedPercentageSummary }[];
}
export interface RetainedHistorySummaryResponse { contractVersion: typeof RETAINED_HISTORY_SUMMARY_VERSION; environment: 'local' | 'staging'; generation: number; summaries: RetainedHistorySummary[] }
export const retainedHistoryCanonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
function fail(): never { throw new Error('INVALID_RETAINED_HISTORY_SUMMARY'); }
export function parseRetainedHistorySelections(input: unknown): RetainedHistorySelection[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) fail();
  for (const row of input) if (!object(row) || !keys(row, 'expectedPeriodLabel,snapshotId,sourceSnapshotSha256') || !id(row.snapshotId) || !digest(row.sourceSnapshotSha256) || !label(row.expectedPeriodLabel)) fail();
  if (new Set(input.map(row => row.snapshotId)).size !== input.length || new Set(input.map(row => row.expectedPeriodLabel.toLowerCase())).size !== input.length) fail();
  return input.map(row => ({ ...row }));
}
/** Structural validation is available at config load; transport always supplies SHA-256 before using a selection. */
export function parseReviewedRetainedHistory(input: unknown, sha256?: (text: string) => string): ReviewedRetainedHistory {
  if (!object(input) || !keys(input, 'reviewId,selectionSha256,terms,version') || input.version !== 1 || !id(input.reviewId) || !digest(input.selectionSha256)
    || !Array.isArray(input.terms) || input.terms.length < 1 || input.terms.length > 2) fail();
  for (const row of input.terms) if (!object(row) || !keys(row, 'expectedPeriodLabel,label,snapshotId,sortOrder,sourceSnapshotSha256,termId') || !id(row.termId) || !label(row.label) || !Number.isSafeInteger(row.sortOrder)) fail();
  parseRetainedHistorySelections(input.terms.map(({ snapshotId, sourceSnapshotSha256, expectedPeriodLabel }) => ({ snapshotId, sourceSnapshotSha256, expectedPeriodLabel })));
  for (const field of ['termId', 'label', 'sortOrder'] as const) if (new Set(input.terms.map(row => row[field])).size !== input.terms.length) fail();
  if (sha256 && sha256(retainedHistoryCanonical({ version: input.version, reviewId: input.reviewId, terms: input.terms })) !== input.selectionSha256) fail();
  return JSON.parse(JSON.stringify(input)) as ReviewedRetainedHistory;
}
export interface RetainedSummaryBin { asYear: string; rows: number; unresolvedRows: number; overallSum: number; overallCount: number; llabSum: number; llabCount: number; invalidRows: number }
/** Consume only compact SQL aggregates, never full event/roster payloads. Unknown years still contribute to the Wing mean. */
export function buildRetainedHistorySummary(selection: RetainedHistorySelection, expectedRows: number, bins: RetainedSummaryBin[]): RetainedHistorySummary {
  parseRetainedHistorySelections([selection]);
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0 || expectedRows > 500 || !Array.isArray(bins) || bins.length > AS_YEAR_DISPLAY_ORDER.length + 1 || new Set(bins.map(row => row.asYear)).size !== bins.length) fail();
  const known = new Set<string>(AS_YEAR_DISPLAY_ORDER);
  for (const bin of bins) {
    if (!known.has(bin.asYear) && bin.asYear !== 'unknown' || ![bin.rows, bin.unresolvedRows, bin.overallCount, bin.llabCount, bin.invalidRows].every(v => Number.isSafeInteger(v) && v >= 0)
      || bin.invalidRows !== 0 || bin.unresolvedRows > bin.rows || bin.overallCount > bin.rows || bin.llabCount > bin.rows
      || ![bin.overallSum, bin.llabSum].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
      || bin.overallSum > bin.overallCount + 1e-12 || bin.llabSum > bin.llabCount + 1e-12) fail();
  }
  const sum = (field: keyof Omit<RetainedSummaryBin, 'asYear'>) => bins.reduce((n, bin) => n + bin[field], 0);
  if (sum('rows') !== expectedRows) fail();
  const metric = (rows: number, total: number, count: number): SavedPercentageSummary => ({ percentage: count ? total / count : null, contributors: count, omitted: rows - count });
  return { ...selection, rows: expectedRows, unresolvedRows: sum('unresolvedRows'), unknownAsYearRows: bins.find(bin => bin.asYear === 'unknown')?.rows ?? 0,
    overall: metric(expectedRows, sum('overallSum'), sum('overallCount')), llab: metric(expectedRows, sum('llabSum'), sum('llabCount')),
    attendanceByYear: AS_YEAR_DISPLAY_ORDER.map(asYear => { const bin = bins.find(row => row.asYear === asYear); return { asYear, rows: bin?.rows ?? 0,
      overall: metric(bin?.rows ?? 0, bin?.overallSum ?? 0, bin?.overallCount ?? 0), llab: metric(bin?.rows ?? 0, bin?.llabSum ?? 0, bin?.llabCount ?? 0) }; }) };
}
/** Reject malformed summaries at the consumer boundary before any workbook planning. */
export function validateRetainedHistorySummary(input: unknown, selection: RetainedHistorySelection): RetainedHistorySummary {
  parseRetainedHistorySelections([{ snapshotId: selection.snapshotId, sourceSnapshotSha256: selection.sourceSnapshotSha256, expectedPeriodLabel: selection.expectedPeriodLabel }]);
  if (!object(input) || !keys(input, 'attendanceByYear,expectedPeriodLabel,llab,overall,rows,snapshotId,sourceSnapshotSha256,unknownAsYearRows,unresolvedRows')
    || input.snapshotId !== selection.snapshotId || input.sourceSnapshotSha256 !== selection.sourceSnapshotSha256 || input.expectedPeriodLabel !== selection.expectedPeriodLabel
    || !Array.isArray(input.attendanceByYear) || input.attendanceByYear.length !== AS_YEAR_DISPLAY_ORDER.length) fail();
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 500;
  if (!count(input.rows) || !count(input.unresolvedRows) || input.unresolvedRows > input.rows || !count(input.unknownAsYearRows) || input.unknownAsYearRows > input.rows) fail();
  const metric = (m: unknown, rows: number) => {
    if (!object(m) || !keys(m, 'contributors,omitted,percentage') || !count(m.contributors) || !count(m.omitted) || m.contributors + m.omitted !== rows
      || (m.contributors === 0 ? m.percentage !== null : typeof m.percentage !== 'number' || !Number.isFinite(m.percentage) || m.percentage < 0 || m.percentage > 1)) fail();
  };
  metric(input.overall, input.rows); metric(input.llab, input.rows);
  let knownRows = 0;
  for (const [i, row] of input.attendanceByYear.entries()) {
    if (!object(row) || !keys(row, 'asYear,llab,overall,rows') || row.asYear !== AS_YEAR_DISPLAY_ORDER[i] || !count(row.rows)) fail();
    metric(row.overall, row.rows); metric(row.llab, row.rows); knownRows += row.rows;
  }
  if (knownRows + input.unknownAsYearRows !== input.rows) fail();
  for (const field of ['overall', 'llab'] as const) {
    const total = input[field] as unknown as SavedPercentageSummary;
    const known = input.attendanceByYear.reduce((sum, row) => ({ contributors: sum.contributors + row[field].contributors,
      numerator: sum.numerator + (row[field].percentage ?? 0) * row[field].contributors }), { contributors: 0, numerator: 0 });
    const unknownContributors = total.contributors - known.contributors;
    const unknownNumerator = (total.percentage ?? 0) * total.contributors - known.numerator;
    if (unknownContributors < 0 || unknownContributors > input.unknownAsYearRows || unknownNumerator < -1e-10 || unknownNumerator > unknownContributors + 1e-10) fail();
  }
  return JSON.parse(JSON.stringify(input)) as RetainedHistorySummary;
}
