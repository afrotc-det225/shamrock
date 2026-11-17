import type { FrontendSnapshot, SnapshotRevision } from '../../../packages/domain/src/admin.js';
import { buildFrontendReporting, type ReportingDiagnostic } from '../../../packages/domain/src/frontend-reporting.js';
import { validateRetainedHistorySummary, type RetainedHistorySummary, type ReviewedRetainedTerm } from '../../../packages/domain/src/retained-history-summary.js';
import { snapshotToFrontendReportingInput } from './frontend-publication.js';

type BaseReport = ReturnType<typeof buildFrontendReporting>;
type Report = BaseReport & { dashboard: BaseReport['dashboard'] & { retainedHistory?: (RetainedHistorySummary & { termId: string; label: string })[] } };
export interface NativeTermSummary {
  termId: string; label: string; sortOrder: number;
  percentage: number | null; rosterSource: 'current' | 'snapshot' | 'unavailable';
  attendanceByYear: { asYear: string; percentage: number | null }[];
  diagnostics: ReportingDiagnostic[];
  retainedSource?: RetainedHistorySummary;
}
export type FrontendDashboardSnapshot = FrontendSnapshot & {
  dashboardHistory?: { revision: SnapshotRevision; currentTermId: string; terms: NativeTermSummary[] };
};
function fail(): never { throw new Error('INVALID_DASHBOARD_HISTORY'); }
const equalRevision = (a: SnapshotRevision, b: SnapshotRevision) => a?.operations === b?.operations && a?.administration === b?.administration;

/** Extract only frozen-semester aggregates. The date does not affect attendance credit. */
export function summarizeNativeTerm(snapshot: FrontendSnapshot, termId: string): NativeTermSummary {
  const term = snapshot.terms.find(t => t.termId === termId);
  if (!term || term.isCurrent) fail();
  const report = buildFrontendReporting(snapshotToFrontendReportingInput(snapshot, '2000-01-01'));
  const trend = report.dashboard.termTrend.find(t => t.termId === termId);
  if (!trend) fail();
  return { ...trend, sortOrder: term.sortOrder,
    attendanceByYear: report.dashboard.attendanceByYear.map(row => {
      const value = row.terms.find(t => t.termId === termId); if (!value) fail();
      return { asYear: row.asYear, percentage: value.percentage };
    }), diagnostics: report.diagnostics.filter(d => d.termId === termId) };
}

/** Saved archived percentages and captured AS-year groups; unresolved rows remain in every mean. */
export function summarizeRetainedTerm(term: ReviewedRetainedTerm, input: RetainedHistorySummary): NativeTermSummary {
  const source = validateRetainedHistorySummary(input, { snapshotId: term.snapshotId, sourceSnapshotSha256: term.sourceSnapshotSha256, expectedPeriodLabel: term.expectedPeriodLabel });
  return { termId: term.termId, label: term.label, sortOrder: term.sortOrder, percentage: source.overall.percentage,
    rosterSource: 'snapshot', attendanceByYear: source.attendanceByYear.map(row => ({ asYear: row.asYear, percentage: row.overall.percentage })), diagnostics: [], retainedSource: source };
}

/** Keep the live Attendance matrix bounded while retaining the exact two-term Dashboard comparison. */
export function buildCoherentFrontendReporting(snapshot: FrontendDashboardSnapshot, asOfDate: string): Report {
  const report: Report = buildFrontendReporting(snapshotToFrontendReportingInput(snapshot, asOfDate));
  const history = snapshot.dashboardHistory;
  if (history === undefined) return report;
  const current = snapshot.terms.find(t => t.isCurrent);
  if (!current || !equalRevision(history.revision, snapshot.revision) || history.currentTermId !== current.termId || !Array.isArray(history.terms) || history.terms.length > 2) fail();
  const percent = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const seen = new Set<string>();
  for (const term of history.terms) {
    if (!term || typeof term.termId !== 'string' || term.termId === current.termId || seen.has(term.termId) || typeof term.label !== 'string'
      || !Number.isSafeInteger(term.sortOrder) || term.sortOrder >= current.sortOrder || !percent(term.percentage)
      || !['snapshot', 'unavailable'].includes(term.rosterSource) || !Array.isArray(term.attendanceByYear)
      || term.attendanceByYear.length !== report.dashboard.attendanceByYear.length
      || term.attendanceByYear.some((row, i) => row.asYear !== report.dashboard.attendanceByYear[i].asYear || !percent(row.percentage))
      || !Array.isArray(term.diagnostics) || term.diagnostics.some(d => d.termId !== term.termId)) fail();
    if (term.retainedSource) {
      const source = validateRetainedHistorySummary(term.retainedSource, term.retainedSource);
      if (term.rosterSource !== 'snapshot' || term.percentage !== source.overall.percentage || term.diagnostics.length
        || term.attendanceByYear.some((row, i) => row.percentage !== source.attendanceByYear[i].overall.percentage)) fail();
    }
    seen.add(term.termId);
  }
  const terms = history.terms.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  if (terms.length === 2 && terms[0].sortOrder === terms[1].sortOrder) fail();
  const currentTrend = report.dashboard.termTrend.find(t => t.termId === current.termId)!;
  report.dashboard.termTrend = [...terms.map(({termId,label,percentage,rosterSource}) => ({termId,label,percentage,rosterSource})), currentTrend];
  report.dashboard.attendanceByYear = report.dashboard.attendanceByYear.map((row, i) => ({ asYear: row.asYear,
    terms: [row.terms.find(t => t.termId === current.termId)!, ...terms.slice().reverse().map(t => ({termId:t.termId,label:t.label,percentage:t.attendanceByYear[i].percentage}))] }));
  const retained = terms.filter(term => term.retainedSource).map(term => ({ ...term.retainedSource!, termId: term.termId, label: term.label }));
  if (retained.length) report.dashboard.retainedHistory = retained;
  report.diagnostics = [...report.diagnostics, ...terms.flatMap(t => t.diagnostics)];
  report.needsReview = report.diagnostics.length > 0;
  return report;
}
