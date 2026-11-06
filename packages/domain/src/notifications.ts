/** Deterministic notification intents. No transport, clock, database or AI calls.
 * Import/shadow intents remain suppressed even after the deployment goes live. */
import type { AttendanceCode } from './index.js';

export const NOTICE_POLICY = { version: 'det225-notices-v1', timeZone: 'America/Indiana/Indianapolis', dailyHour: 5, weeklyHour: 17 } as const;
export type NotificationMode = 'live' | 'staging' | 'shadow' | 'import' | 'replay';
export interface NoticeRecipient { email: string; displayName: string }
export interface FlightNoticeContact { flightId: string; label: string; operational: boolean; commander?: NoticeRecipient; deputy?: NoticeRecipient }
export interface NoticeEvent {
  eventId: string; termId: string; label: string; type: 'Mando PT' | 'Secondary PT' | 'LLAB' | 'Other';
  startsAt: string; status: 'active' | 'cancelled' | 'inactive' | 'archived'; flightIds: string[];
}
export interface NoticeAttendance {
  eventId: string; personId: string; flightId: string; displayName: string;
  eligible: boolean | null; code: AttendanceCode | null; pendingRequest: boolean;
}
export interface NotificationIntent {
  key: string; policyVersion: string; kind: 'event-day' | 'weekly-review' | 'excusal-submitted' | 'excusal-decision';
  scopeId: string; localDate: string; state: 'queued' | 'blocked' | 'suppressed';
  blockedReason?: 'missing-recipient';
  to: string[]; cc: string[]; replyTo?: string; subject: string; body: string;
}
export interface ScheduledNoticeInput {
  now: string; mode: NotificationMode; events: NoticeEvent[]; flights: FlightNoticeContact[];
  attendance: NoticeAttendance[];
}
const signoff = '\n\nVery respectfully,\nSHAMROCK Automations';
const id = (value: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw Error('Invalid notification identity.');
  return value;
};
const label = (value: string, limit = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f]/.test(value)) throw Error('Invalid notification label.');
  return value;
};
const email = (value: string) => {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) throw Error('Invalid notification recipient.');
  return value.toLowerCase();
};
function instant(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Notification timestamps require UTC instants.');
  const result = new Date(value);
  if (result.toISOString() !== (value.length === 20 ? value.slice(0, -1) + '.000Z' : value)) throw Error('Notification timestamp is not a real calendar instant.');
  return result;
}
export function noticeLocalClock(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: NOTICE_POLICY.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(instant(value));
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, hour: Number(get('hour')), weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
}
function dateOffset(date: string, days: number): string {
  const day = new Date(date + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10);
}
function route(flight: FlightNoticeContact): { to: string[]; cc: string[] } {
  const commander = flight.commander ? email(flight.commander.email) : undefined;
  const deputy = flight.deputy ? email(flight.deputy.email) : undefined;
  return { to: commander ? [commander] : deputy ? [deputy] : [], cc: commander && deputy && commander !== deputy ? [deputy] : [] };
}
function intent(mode: NotificationMode, item: Omit<NotificationIntent, 'state' | 'policyVersion' | 'blockedReason'>): NotificationIntent {
  if (!['live', 'staging', 'shadow', 'import', 'replay'].includes(mode)) throw Error('An explicit notification mode is required.');
  return { ...item, policyVersion: NOTICE_POLICY.version,
    state: mode === 'live' ? item.to.length ? 'queued' : 'blocked' : 'suppressed',
    ...(!item.to.length ? { blockedReason: 'missing-recipient' as const } : {}) };
}
function facts(rows: NoticeAttendance[]): string {
  const list = (select: (row: NoticeAttendance) => boolean) => rows.filter(select).map(r => `- ${r.displayName}`).sort().join('\n') || 'None recorded';
  return [
    `Approved excusals:\n${list(r => ['E', 'ES', 'MED'].includes(r.code ?? ''))}`,
    `Pending excusal requests:\n${list(r => r.pendingRequest)}`,
    `Absent / unexcused records requiring follow-up:\n${list(r => r.code === 'A' || r.code === 'U')}`,
    `Attendance not yet established:\n${list(r => r.eligible === null || r.code === null || r.code === 'R' || r.code === 'D')}`,
  ].join('\n\n');
}

/** A 5-minute scheduler may call this repeatedly. Stable keys deduplicate the same
 * local event-day or Sunday window, including DST changes. It does not finalize
 * blank/denied records into A/U: notifications never manufacture evidence. */
export function planScheduledNotices(input: ScheduledNoticeInput): NotificationIntent[] {
  const clock = noticeLocalClock(input.now);
  if (!['live', 'staging', 'shadow', 'import', 'replay'].includes(input.mode)
    || !Array.isArray(input.events) || !Array.isArray(input.flights) || !Array.isArray(input.attendance)
    || input.events.length > 250 || input.flights.length > 30 || input.attendance.length > 50000) throw Error('Notification planning exceeds its bounded snapshot.');
  const flights = new Set<string>(), events = new Set<string>(), pairs = new Set<string>();
  input.flights.forEach(f => { if (flights.has(id(f.flightId)) || typeof f.operational !== 'boolean') throw Error('Ambiguous notification flight.'); flights.add(f.flightId); label(f.label); route(f); });
  input.events.forEach(e => {
    if (events.has(id(e.eventId))) throw Error('Ambiguous notification event.'); events.add(e.eventId); id(e.termId); label(e.label); instant(e.startsAt);
    if (!['Mando PT', 'Secondary PT', 'LLAB', 'Other'].includes(e.type) || !['active', 'cancelled', 'inactive', 'archived'].includes(e.status)
      || new Set(e.flightIds).size !== e.flightIds.length || e.flightIds.some(f => !flights.has(f))) throw Error('Invalid notification event scope.');
  });
  const byEventFlight = new Map<string, NoticeAttendance[]>();
  input.attendance.forEach(row => {
    id(row.personId); label(row.displayName);
    if (!events.has(row.eventId) || !flights.has(row.flightId) || ![true, false, null].includes(row.eligible)
      || typeof row.pendingRequest !== 'boolean' || ![null, 'P', 'T', 'A', 'R', 'D', 'U', 'E', 'ES', 'MED', 'N/A'].includes(row.code)) throw Error('Invalid notification attendance fact.');
    const key = JSON.stringify([row.personId, row.eventId]); if (pairs.has(key)) throw Error('Duplicate notification attendance fact.'); pairs.add(key);
    if (row.eligible !== false) { const bucket = JSON.stringify([row.eventId, row.flightId]); byEventFlight.set(bucket, [...(byEventFlight.get(bucket) ?? []), row]); }
  });
  const result: NotificationIntent[] = [];
  if (clock.hour >= NOTICE_POLICY.dailyHour) for (const event of input.events) {
    if (event.status !== 'active' || !['Mando PT', 'LLAB'].includes(event.type) || noticeLocalClock(event.startsAt).date !== clock.date) continue;
    for (const flight of input.flights.filter(f => f.operational && event.flightIds.includes(f.flightId))) {
      const rows = byEventFlight.get(JSON.stringify([event.eventId, flight.flightId])) ?? [];
      result.push(intent(input.mode, { key: JSON.stringify([NOTICE_POLICY.version, 'event-day', event.termId, event.eventId, flight.flightId, clock.date]),
        kind: 'event-day', scopeId: flight.flightId, localDate: clock.date, ...route(flight),
        subject: `${event.type} attendance status — ${event.label}`,
        body: `${flight.label} Flight,\n\nAttendance status for ${event.label}:\n\n${facts(rows)}\n\nThis is a status summary. No request or absence of a request establishes attendance. Verify the roster and submit attendance for the event.${signoff}` }));
    }
  }
  if (clock.weekday === 0 && clock.hour >= NOTICE_POLICY.weeklyHour) {
    const start = dateOffset(clock.date, -7), end = clock.date;
    for (const flight of input.flights.filter(f => f.operational)) {
      const scoped = input.events.filter(e => e.status === 'active' && e.flightIds.includes(flight.flightId)
        && noticeLocalClock(e.startsAt).date >= start && noticeLocalClock(e.startsAt).date < end);
      if (!scoped.length) continue;
      const sections = scoped.map(event => {
        const rows = byEventFlight.get(JSON.stringify([event.eventId, flight.flightId])) ?? [];
        return `${event.label}\n${rows.length ? facts(rows) : 'No eligible roster records are available; review the event roster.'}`;
      });
      result.push(intent(input.mode, { key: JSON.stringify([NOTICE_POLICY.version, 'weekly-review', flight.flightId, start]),
        kind: 'weekly-review', scopeId: flight.flightId, localDate: clock.date, ...route(flight), subject: `Attendance follow-up — week of ${start}`,
        body: `${flight.label} Flight,\n\nReview the completed training week, ${start} through ${dateOffset(end, -1)}:\n\n${sections.join('\n\n')}\n\nResolve pending requests and missing attendance records. This review does not assign an unexcused absence or claim perfect attendance.${signoff}` }));
    }
  }
  return result;
}

export function planExcusalNotice(input: { mode: NotificationMode; now: string; requestId: string; version: number;
  squadronId: string; eventLabel: string; cadet: NoticeRecipient; commander?: NoticeRecipient;
  status: 'Submitted' | 'Approved' | 'Denied' | 'Withdrawn' | 'Superseded'; previousStatus?: string; reason: string;
}): NotificationIntent {
  id(input.requestId); id(input.squadronId); label(input.eventLabel); label(input.cadet.displayName); email(input.cadet.email);
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !['Submitted', 'Approved', 'Denied', 'Withdrawn', 'Superseded'].includes(input.status)
    || typeof input.reason !== 'string' || input.reason.length > 8000 || input.reason.includes('\0')) throw Error('Invalid excusal notice.');
  if (input.previousStatus !== undefined) label(input.previousStatus, 32);
  const commander = input.commander ? email(input.commander.email) : undefined;
  const submitted = input.status === 'Submitted', cadet = email(input.cadet.email), kind = submitted ? 'excusal-submitted' : 'excusal-decision';
  // Missing commander is a visible routing issue for both submissions and decisions.
  // Never invent a reply-to account or impersonate the commander's signature.
  return intent(input.mode, { key: JSON.stringify([NOTICE_POLICY.version, kind, input.requestId, input.version]),
    kind, scopeId: input.squadronId, localDate: noticeLocalClock(input.now).date,
    to: commander ? submitted ? [commander] : [cadet] : [], cc: commander && commander !== cadet ? submitted ? [cadet] : [commander] : [],
    ...(commander ? { replyTo: submitted ? cadet : commander } : {}),
    subject: `${submitted ? 'New excusal request' : 'Excusal decision'} — ${input.cadet.displayName} — ${input.eventLabel}`,
    body: `${input.cadet.displayName}\nEvent: ${input.eventLabel}\nStatus: ${input.status}${input.previousStatus ? `\nPrevious status: ${input.previousStatus}` : ''}\n\nReason:\n${input.reason}\n\n${submitted ? 'Review this request in the squadron excusal sheet.' : 'For questions or reconsideration, contact the flight or squadron commander through the chain of command.'}${signoff}` });
}

export type DeliveryState = 'queued' | 'sending' | 'sent' | 'blocked' | 'suppressed' | 'uncertain';
export type DeliveryEvent = 'claim' | 'confirmed' | 'known-not-sent' | 'lost-result' | 'quota-exhausted' | 'routing-repaired';
/** Persist 'sending' before calling the mail provider. A crash/unknown result is
 * uncertain, never an automatic retry. Suppression cannot be undone by resume. */
export function advanceDelivery(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  if (state === 'suppressed' || state === 'sent' || state === 'uncertain') throw Error('A terminal or uncertain delivery cannot be automatically retried.');
  if (state === 'queued' && event === 'claim') return 'sending';
  if (state === 'sending' && event === 'confirmed') return 'sent';
  if (state === 'sending' && event === 'known-not-sent') return 'queued';
  if (state === 'sending' && event === 'lost-result') return 'uncertain';
  if (state === 'queued' && event === 'quota-exhausted') return 'blocked';
  if (state === 'blocked' && event === 'routing-repaired') return 'queued';
  throw Error('Invalid notification delivery transition.');
}
