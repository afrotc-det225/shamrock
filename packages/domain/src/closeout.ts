/** Explicit Sunday policy: finalization is separate from observed attendance and notifications. */
import type { AttendanceCode } from './index.js';
import type { ReportingAttendanceCell } from './frontend-reporting.js';
import { noticeLocalClock, type FlightNoticeContact, type NotificationIntent } from './notifications.js';
export const CLOSEOUT_POLICY = { version: 'det225-sunday-closeout-v1', timeZone: 'America/Indiana/Indianapolis', weekday: 0, hour: 17 } as const;
export function closeoutWindow(asOf: string) {
    const clock = noticeLocalClock(asOf);
    if (clock.weekday !== 0 || clock.hour !== 17 || !/:00:00\.000Z$/.test(asOf))
        throw Error('Closeout requires the canonical Sunday 17:00 local window.');
    const start = new Date(clock.date + 'T12:00:00Z');
    start.setUTCDate(start.getUTCDate() - 7);
    return { start: start.toISOString().slice(0, 10), end: clock.date };
}
/** Request order is from the same causal stream as explicit attendance corrections.
 * A legacy D already states denied attendance and needs no fabricated request. */
export function closeoutCode(input: {
    cell: ReportingAttendanceCell;
    latestAttendanceOrder: number;
    requests: {
        status: string;
        order: number;
        legacyStateOnly?: boolean;
    }[];
}): 'A' | 'U' | null {
    const { cell } = input;
    if (cell.needsReview || cell.eligible !== true)
        return null;
    if (cell.effectiveCode === 'D')
        return 'U';
    if (cell.effectiveCode !== null && cell.effectiveCode !== 'A')
        return null;
    const active = input.requests.filter(r => !r.legacyStateOnly && !['Withdrawn', 'Superseded'].includes(r.status));
    if (active.length === 1 && active[0].status === 'Denied' && active[0].order >= input.latestAttendanceOrder)
        return 'U';
    return cell.effectiveCode === null ? 'A' : null;
}
export interface CloseoutNoticeRow {
    flightId: string;
    personId: string;
    name: string;
    eventId: string;
    eventLabel: string;
    code: AttendanceCode | null;
    needsReview: boolean;
}
export function closeoutNotices(input: {
    asOf: string;
    flights: FlightNoticeContact[];
    scopedFlightIds: string[];
    rows: CloseoutNoticeRow[];
    reviewCount: number;
}): NotificationIntent[] {
    const window = closeoutWindow(input.asOf);
    if (input.rows.length > 25000 || input.flights.length > 30)
        throw Error('Closeout notice capacity exceeded.');
    const valid = (email: string) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email);
    return input.flights.filter(f => f.operational && input.scopedFlightIds.includes(f.flightId)).map(f => {
        const commander = f.commander?.email.toLowerCase(), deputy = f.deputy?.email.toLowerCase();
        const to = commander && valid(commander) ? [commander] : deputy && valid(deputy) ? [deputy] : [];
        const cc = commander && valid(commander) && deputy && valid(deputy) && deputy !== commander ? [deputy] : [];
        const rows = input.rows.filter(r => r.flightId === f.flightId), issues = rows.filter(r => r.code === 'A' || r.code === 'U');
        const unresolved = rows.filter(r => r.needsReview || r.code === null || r.code === 'R' || r.code === 'D');
        const list = issues.map(r => `- ${r.name} — ${r.eventLabel}: ${r.code}`).sort().join('\n') || 'No A or U records are recorded for this Flight.';
        const body = `${f.label} Flight,\n\nSunday attendance closeout for the week of ${window.start}:\n\n${list}\n\nA means absent with no resolved request. U means final unexcused. The approved closeout policy finalizes blank eligible cells as A and unresolved denials as U even when a Flight report is missing. Recorded presence and other existing outcomes are preserved.\n\n${unresolved.length || input.reviewCount ? `${unresolved.length} current records remain pending or require review; ${input.reviewCount} closeout items require catalog/roster review. Check the spreadsheet before treating the week as complete.` : 'No pending or unresolved records remain in this snapshot.'}\n\nVery respectfully,\nSHAMROCK Automations`;
        return { key: JSON.stringify([CLOSEOUT_POLICY.version, 'weekly-review', f.flightId, window.start]), policyVersion: CLOSEOUT_POLICY.version, kind: 'weekly-review', scopeId: f.flightId, localDate: window.end, state: 'suppressed', ...(!to.length ? { blockedReason: 'missing-recipient' as const } : {}), to, cc, subject: `Attendance closeout — week of ${window.start}`, body };
    });
}
