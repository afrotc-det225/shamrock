import test from 'node:test';
import assert from 'node:assert/strict';
import { planScheduledNotices, planExcusalNotice, noticeLocalClock, advanceDelivery } from '../../.build/v3/packages/domain/src/notifications.js';

const contact = n => ({ email: `${n}@example.invalid`, displayName: n });
const fixture = () => ({ now: '2026-11-06T10:00:00Z', mode: 'live',
  flights: [{ flightId: 'alpha', label: 'Alpha', operational: true, commander: contact('commander'), deputy: contact('deputy') },
    { flightId: 'abroad', label: 'Abroad', operational: false, commander: contact('abroad') }],
  events: [{ eventId: 'event1', termId: 'fall', label: 'TW-10 LLAB', type: 'LLAB', startsAt: '2026-11-06T20:00:00Z', status: 'active', flightIds: ['alpha', 'abroad'] }],
  attendance: [
    { eventId: 'event1', personId: 'p1', flightId: 'alpha', displayName: 'Cadet One', eligible: true, code: 'P', pendingRequest: true },
    { eventId: 'event1', personId: 'p2', flightId: 'alpha', displayName: 'Cadet Two', eligible: true, code: 'D', pendingRequest: false },
  ],
});

test('daily notices preserve commander/deputy routing and leave attendance evidence unchanged', () => {
  const x = fixture(), before = structuredClone(x), [notice] = planScheduledNotices(x);
  assert.deepEqual(x, before); assert.equal(notice.kind, 'event-day');
  assert.deepEqual(notice.to, ['commander@example.invalid']); assert.deepEqual(notice.cc, ['deputy@example.invalid']);
  assert.match(notice.body, /Pending excusal requests:\n- Cadet One/);
  assert.match(notice.body, /Attendance not yet established:\n- Cadet Two/);
  assert.doesNotMatch(notice.body, /perfect attendance|all cadets are present/);
  assert.equal(planScheduledNotices(x).length, 1, 'nonoperational Abroad flight excluded');
  assert.equal(planScheduledNotices({ ...x, now: '2026-11-06T09:59:00Z' }).length, 0);
});

test('cancelled/inactive events and secondary PT do not generate event-day messages', () => {
  for (const patch of [{ status: 'cancelled' }, { status: 'inactive' }, { status: 'archived' }, { type: 'Secondary PT' }, { type: 'Other' }]) {
    const x = fixture(); Object.assign(x.events[0], patch); assert.deepEqual(planScheduledNotices(x), []);
  }
});

test('missing commander falls back to deputy; missing both leaves a visible blocked intent', () => {
  const x = fixture(); delete x.flights[0].commander;
  const [fallback] = planScheduledNotices(x); assert.deepEqual(fallback.to, ['deputy@example.invalid']); assert.deepEqual(fallback.cc, []);
  delete x.flights[0].deputy;
  const [blocked] = planScheduledNotices(x); assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blockedReason, 'missing-recipient');
});

test('local-day keys are stable through retries and DST uses local wall-clock scheduling', () => {
  const x = fixture(); assert.equal(planScheduledNotices(x)[0].key, planScheduledNotices({ ...x, now: '2026-11-06T10:55:00Z' })[0].key);
  assert.deepEqual(noticeLocalClock('2026-03-08T09:00:00Z'), { date: '2026-03-08', hour: 5, weekday: 0 });
  assert.deepEqual(noticeLocalClock('2026-11-01T10:00:00Z'), { date: '2026-11-01', hour: 5, weekday: 0 });
  assert.deepEqual(noticeLocalClock('2026-01-01T02:00:00Z'), { date: '2025-12-31', hour: 21, weekday: 3 });
});

test('Sunday review covers the preceding Sunday–Saturday and never infers an unexcused absence', () => {
  const x = fixture(); x.now = '2026-11-08T22:00:00Z';
  const [review] = planScheduledNotices(x); assert.equal(review.kind, 'weekly-review'); assert.match(review.subject, /2026-11-01/);
  assert.match(review.body, /2026-11-01 through 2026-11-07/); assert.equal(x.attendance[1].code, 'D');
  const initial = review.key; x.events[0].termId = 'other-term'; assert.equal(planScheduledNotices(x)[0].key, initial, 'catalog corrections do not create a second weekly send');
  x.events = []; x.attendance = []; assert.deepEqual(planScheduledNotices(x), [], 'no eligible events means no fabricated success message');
});

test('all non-live modes suppress intents durably; resuming cannot release historical mail', () => {
  for (const mode of ['staging', 'shadow', 'import', 'replay']) assert.equal(planScheduledNotices({ ...fixture(), mode })[0].state, 'suppressed');
  assert.throws(() => advanceDelivery('suppressed', 'routing-repaired'));
  assert.throws(() => advanceDelivery('suppressed', 'claim'));
});

test('excusal submission and versioned decisions use the exact current chain of command', () => {
  const x = { mode: 'live', now: '2026-11-06T10:00:00Z', requestId: 'r1', version: 1, squadronId: 'blue', eventLabel: 'LLAB',
    cadet: contact('cadet'), commander: contact('squadron'), status: 'Submitted', reason: 'Academic conflict' };
  const submitted = planExcusalNotice(x); assert.deepEqual(submitted.to, ['squadron@example.invalid']); assert.deepEqual(submitted.cc, ['cadet@example.invalid']);
  const decided = planExcusalNotice({ ...x, version: 2, status: 'Approved' });
  assert.deepEqual(decided.to, ['cadet@example.invalid']); assert.deepEqual(decided.cc, ['squadron@example.invalid']);
  assert.equal(decided.replyTo, 'squadron@example.invalid'); assert.notEqual(decided.key, submitted.key);
  assert.match(decided.body, /SHAMROCK Automations$/); assert.equal(planExcusalNotice({ ...x, commander: undefined }).state, 'blocked');
});

test('uncertain provider delivery is never retried automatically; only proven no-send retries', () => {
  assert.equal(advanceDelivery('queued', 'claim'), 'sending'); assert.equal(advanceDelivery('sending', 'confirmed'), 'sent');
  assert.equal(advanceDelivery('sending', 'known-not-sent'), 'queued'); assert.equal(advanceDelivery('sending', 'lost-result'), 'uncertain');
  assert.throws(() => advanceDelivery('uncertain', 'claim')); assert.throws(() => advanceDelivery('sent', 'claim'));
  assert.equal(advanceDelivery('queued', 'quota-exhausted'), 'blocked'); assert.throws(() => advanceDelivery('sending', 'quota-exhausted'));
});

test('ambiguous or malformed facts and header injection fail before planning mail', () => {
  const x = fixture(); x.attendance.push({ ...x.attendance[0] }); assert.throws(() => planScheduledNotices(x));
  const y = fixture(); y.flights[0].commander.email = 'a@example.invalid\nBcc:b@example.invalid'; assert.throws(() => planScheduledNotices(y));
  const z = fixture(); z.events[0].label = 'LLAB\nInjected'; assert.throws(() => planScheduledNotices(z));
});
