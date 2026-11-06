import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORTING_POLICY_VERSION, ReportingInputError, buildFrontendReporting,
  buildBirthdayView, calculateAttendanceCredit, calculateAttendancePercent,
} from '../../.build/v3/packages/domain/src/frontend-reporting.js';

const person = (personId, overrides = {}) => ({ personId, lastName: `Sample ${personId}`, firstName: 'Fictional', asYear: 'AS100',
  flightId: 'flight-alpha', flightPathStatus: 'Active 3/4', dateOfBirth: null, ...overrides });
const event = (eventId, overrides = {}) => ({ eventId, termId: 'term-current', label: eventId,
  type: 'mando', trainingWeek: 1, displayOrder: 0, eligiblePersonIds: ['cadet-a', 'cadet-b'], ...overrides });
const observation = (factId, personId, eventId, code, order = 1) => ({ factId, personId, eventId, code, order });
const request = (overrides = {}) => ({ requestId: 'request-a', personId: 'cadet-a', eventId: 'event-mando',
  order: 2, status: 'Approved', requestedOutcome: 'E', ...overrides });
function fixture() {
  return { policyVersion: REPORTING_POLICY_VERSION, asOfDate: '2027-01-12', currentTermId: 'term-current',
    people: [person('cadet-a'), person('cadet-b', { asYear: 'AS300', flightId: 'flight-bravo' })],
    flights: [{ flightId: 'flight-alpha', label: 'Alpha', squadronId: 'squadron-blue' },
      { flightId: 'flight-bravo', label: 'Bravo', squadronId: 'squadron-gold' },
      { flightId: 'flight-abroad', label: 'Abroad', squadronId: 'squadron-gold' }],
    squadrons: [{ squadronId: 'squadron-blue', label: 'Blue' }, { squadronId: 'squadron-gold', label: 'Gold' }],
    terms: [{ termId: 'term-current', label: 'Spring 2027', sortOrder: 3 }],
    events: [event('event-mando'), event('event-llab', { type: 'llab', displayOrder: 1 })],
    observations: [], corrections: [], requests: [] };
}
const matrix = result => result.matrices.find(m => m.termId === result.currentTermId);
const row = (result, id = 'cadet-a') => matrix(result).rows.find(r => r.personId === id);
const cell = (result, id = 'cadet-a', eventId = 'event-mando') => row(result, id).cells.find(c => c.eventId === eventId);

test('each operational code has the exact legacy credit and denominator treatment', () => {
  for (const code of ['P', 'T', 'E', 'ES', 'MED', 'A', 'U', 'R', 'D', 'N/A', null]) {
    const result = calculateAttendanceCredit([{ effectiveCode: code, eligible: true }]);
    const credited = ['P', 'T', 'E', 'ES', 'MED'].includes(code), counted = credited || ['A', 'U'].includes(code);
    assert.equal(result.numerator, Number(credited)); assert.equal(result.denominator, Number(counted));
    assert.equal(result.percentage, counted ? Number(credited) : 1);
    assert.equal(result.noCountedAttendance, !counted); assert.equal(result.eligibleEvents, 1);
  }
  assert.equal(calculateAttendancePercent(['P', 'T', 'A', 'R', 'N/A', '']), 2 / 3);
  assert.equal(calculateAttendancePercent([]), 1);
  assert.throws(() => calculateAttendancePercent(['unknown']), ReportingInputError);
});

test('matrix uses stable identities, typed LLAB, legacy AS ordering and mean person percentages', () => {
  const input = fixture(); input.events[0].label = 'Misleading LLAB name'; input.events[1].label = 'Same display';
  input.people[1].lastName = input.people[0].lastName; input.people[1].firstName = input.people[0].firstName;
  input.observations = [observation('fact-1', 'cadet-a', 'event-mando', 'P'), observation('fact-2', 'cadet-b', 'event-mando', 'A'), observation('fact-3', 'cadet-b', 'event-llab', 'P')];
  const result = buildFrontendReporting(input);
  assert.deepEqual(matrix(result).rows.map(r => r.personId), ['cadet-b', 'cadet-a']);
  assert.equal(row(result).overall.percentage, 1); assert.equal(row(result, 'cadet-b').overall.percentage, 0.5);
  assert.equal(row(result).llab.denominator, 0); assert.equal(row(result, 'cadet-b').llab.denominator, 1);
  assert.equal(result.dashboard.averageOverall, 0.75); // pooled 2/3 would be wrong
  assert.equal(result.dashboard.belowEighty, 1); assert.equal(result.dashboard.gmcCadets, 1); assert.equal(result.dashboard.pocCadets, 1);
  assert.deepEqual(matrix(result).eventColumns.map(c => c.machineHeader), ['event:event-mando', 'event:event-llab']);
});

test('explicit correction including clear survives replay without destroying original observation', () => {
  const input = fixture(); input.observations = [observation('observed', 'cadet-a', 'event-mando', 'P')];
  input.corrections = [observation('corrected', 'cadet-a', 'event-mando', 'T', 2), observation('cleared', 'cadet-a', 'event-mando', null, 3)];
  let result = buildFrontendReporting(input);
  assert.equal(cell(result).observedCode, 'P'); assert.equal(cell(result).effectiveCode, null);
  assert.equal(cell(result).correctionId, 'cleared'); assert.equal(cell(result).source, 'correction');
  assert.equal(row(result).overall.noCountedAttendance, true);
  input.observations.push(observation('later-report', 'cadet-a', 'event-mando', 'P', 4));
  result = buildFrontendReporting(input); assert.equal(cell(result).effectiveCode, 'P'); assert.equal(cell(result).source, 'observation');
});

test('observed P/T wins over pending or denied requests and remains independent of approval', () => {
  for (const code of ['P', 'T']) for (const status of ['Submitted', 'Denied', 'Approved']) {
    const input = fixture(); input.observations = [observation('presence', 'cadet-a', 'event-mando', code)]; input.requests = [request({ status })];
    const value = cell(buildFrontendReporting(input));
    assert.equal(value.observedCode, code); assert.equal(value.effectiveCode, code); assert.equal(value.requests[0].status, status);
  }
});

test('approved outcome supplies credit for absence, but a later explicit correction or clear wins', () => {
  for (const outcome of ['P', 'T', 'E', 'ES', 'MED']) {
    const input = fixture(); input.observations = [observation('absence', 'cadet-a', 'event-mando', 'A')]; input.requests = [request({ requestedOutcome: outcome })];
    let value = cell(buildFrontendReporting(input)); assert.equal(value.observedCode, 'A'); assert.equal(value.effectiveCode, outcome);
    for (const correction of ['U', null]) {
      input.corrections = [observation('later-correction', 'cadet-a', 'event-mando', correction, 3)];
      value = cell(buildFrontendReporting(input)); assert.equal(value.effectiveCode, correction); assert.equal(value.source, 'correction');
    }
  }
});

test('denial never manufactures U or D and withdrawal removes adjudication without stale restoration', () => {
  for (const status of ['Denied', 'Withdrawn', 'Superseded']) for (const observed of [null, 'A', 'T']) {
    const input = fixture(); input.observations = observed ? [observation('evidence', 'cadet-a', 'event-mando', observed)] : []; input.requests = [request({ status })];
    assert.equal(cell(buildFrontendReporting(input)).effectiveCode, observed);
  }
  const input = fixture(); input.requests = [request({ status: 'Submitted' })];
  assert.equal(cell(buildFrontendReporting(input)).effectiveCode, 'R');
  input.observations = [observation('later-absence', 'cadet-a', 'event-mando', 'A', 3)];
  assert.equal(cell(buildFrontendReporting(input)).effectiveCode, 'A');
});

test('overlapping unresolved requests and conflicting committed order require visible review', () => {
  const input = fixture(); input.observations = [observation('presence', 'cadet-a', 'event-mando', 'P')];
  input.requests = [request(), request({ requestId: 'request-b', order: 3, requestedOutcome: 'MED' })];
  let result = buildFrontendReporting(input);
  assert.equal(cell(result).effectiveCode, 'P'); assert.equal(cell(result).needsReview, true);
  assert.ok(result.diagnostics.some(d => d.code === 'overlapping-excusal-requests'));
  input.requests = []; input.corrections = [observation('conflicting', 'cadet-a', 'event-mando', 'A', 1)];
  result = buildFrontendReporting(input); assert.equal(cell(result).effectiveCode, null); assert.equal(cell(result).source, 'review');
  assert.ok(result.diagnostics.some(d => d.code === 'ambiguous-attendance-order'));
});

test('equal-order correction and approval, or conflicting P/T adjudication, is never silently resolved', () => {
  const input = fixture(); input.corrections = [observation('clear', 'cadet-a', 'event-mando', null, 2)]; input.requests = [request()];
  let result = buildFrontendReporting(input); assert.equal(cell(result).effectiveCode, null);
  assert.ok(result.diagnostics.some(d => d.code === 'ambiguous-request-precedence'));
  input.corrections = []; input.observations = [observation('tardy', 'cadet-a', 'event-mando', 'T')]; input.requests = [request({ requestedOutcome: 'P' })];
  result = buildFrontendReporting(input); assert.equal(cell(result).effectiveCode, 'T');
  assert.ok(result.diagnostics.some(d => d.code === 'approval-conflicts-with-presence'));
});

test('eligibility snapshots remain separate from codes and unknown scope never means everyone eligible', () => {
  const input = fixture(); input.events[0].eligiblePersonIds = ['cadet-b']; input.events[1].eligiblePersonIds = null;
  input.observations = [observation('out-of-scope-evidence', 'cadet-a', 'event-mando', 'P')];
  const result = buildFrontendReporting(input);
  assert.equal(cell(result).eligible, false); assert.equal(cell(result).effectiveCode, 'P');
  assert.equal(row(result).overall.denominator, 0); // preserve evidence, exclude explicitly ineligible credit
  assert.equal(row(result).overall.numerator, 0); assert.equal(row(result).overall.noCountedAttendance, true);
  assert.equal(row(result).overall.eligibleEvents, 0); assert.equal(row(result).overall.unknownEligibilityEvents, 1);
  assert.ok(result.diagnostics.some(d => d.code === 'evidence-outside-eligibility'));
  assert.ok(result.diagnostics.some(d => d.code === 'unknown-eligibility'));
  assert.equal(cell(result, 'cadet-b', 'event-llab').effectiveCode, null); // no inferred absence/N/A
});

test('historical term roster preserves alumni and previous flight while current roster excludes nonoperational statuses', () => {
  const input = fixture(); input.people[0].flightPathStatus = 'Commissioned'; input.people[0].flightId = 'flight-bravo';
  input.terms.unshift({ termId: 'term-old', label: 'Fall 2026', sortOrder: 2, roster: [person('cadet-a')] });
  input.events.push(event('event-old', { termId: 'term-old', eligiblePersonIds: ['cadet-a'] }));
  input.observations = [observation('old-present', 'cadet-a', 'event-old', 'P')];
  const result = buildFrontendReporting(input), old = result.matrices.find(m => m.termId === 'term-old');
  assert.deepEqual(matrix(result).rows.map(r => r.personId), ['cadet-b']);
  assert.equal(old.rows[0].personId, 'cadet-a'); assert.equal(old.rows[0].flight, 'Alpha'); assert.equal(old.rows[0].overall.percentage, 1);
  assert.equal(old.rosterSource, 'snapshot'); assert.equal(result.dashboard.termTrend.length, 2);
});

test('missing historical roster is explicit and charts include only the two newest prior terms', () => {
  const input = fixture();
  for (let i = 0; i < 3; i++) input.terms.push({ termId: `term-history-${i}`, label: `Fictional term ${i}`, sortOrder: i });
  const result = buildFrontendReporting(input);
  assert.equal(result.diagnostics.filter(d => d.code === 'missing-historical-roster').length, 3);
  assert.deepEqual(result.dashboard.termTrend.map(t => t.termId), ['term-history-1', 'term-history-2', 'term-current']);
  assert.equal(result.dashboard.termTrend[0].percentage, null);
});

test('flight and squadron views do not leak other cadets and flight chart excludes Abroad', () => {
  const input = fixture(); input.people.push(person('cadet-away', { flightId: 'flight-abroad' }));
  let result = buildFrontendReporting(input); assert.ok(!result.dashboard.attendanceByFlight.some(f => f.flight === 'Abroad'));
  input.scope = { kind: 'flight', flightId: 'flight-alpha' }; result = buildFrontendReporting(input);
  assert.deepEqual(matrix(result).rows.map(r => r.personId), ['cadet-a']); assert.equal(result.dashboard.totalCadets, 1);
  input.scope = { kind: 'squadron', squadronId: 'squadron-gold' }; result = buildFrontendReporting(input);
  assert.deepEqual(new Set(matrix(result).rows.map(r => r.personId)), new Set(['cadet-b', 'cadet-away']));
  assert.ok(result.dashboard.attendanceBySquadron.every(s => s.squadron === 'Gold'));
});

test('birthday view uses Sunday–Saturday groups, duplicate-surname initials and Google Feb29 rollover', () => {
  const people = [person('cadet-leap', { lastName: 'Example', firstName: 'Aster', dateOfBirth: '2004-02-29' }),
    person('cadet-second', { lastName: 'Example', firstName: 'Birch', dateOfBirth: '2005-03-06' }),
    person('cadet-third', { lastName: 'Sample', dateOfBirth: '2005-03-07' }), person('cadet-empty')];
  const result = buildBirthdayView(people, '2027-12-01');
  assert.equal(result[0].birthdayThisYear, '2027-03-01'); assert.equal(result[0].weekStartsOn, '2027-02-28');
  assert.equal(result[0].display, 'C/A. Example (3/1)'); assert.deepEqual(result.map(r => r.group), [1, 1, 2]);
  assert.equal(buildBirthdayView(people, '2028-01-01')[0].birthdayThisYear, '2028-02-29');
  assert.throws(() => buildBirthdayView([person('invalid', { dateOfBirth: '2005-02-29' })], '2027-01-01'), ReportingInputError);
});

test('event order is typed, Third Hour stays retired, and identity is independent of duplicate display labels', () => {
  const input = fixture(); input.events = [event('event-other', { type: 'other', trainingWeek: 2, label: 'Same' }),
    event('event-secondary', { type: 'secondary', label: 'Same' }), event('event-mando', { label: 'Same' }),
    event('event-retired', { type: 'third-hour' }), event('event-llab', { type: 'llab', label: 'Same' })];
  const result = buildFrontendReporting(input);
  assert.deepEqual(matrix(result).eventColumns.map(e => e.eventId), ['event-mando', 'event-secondary', 'event-llab', 'event-other']);
  assert.equal(new Set(matrix(result).eventColumns.map(e => e.machineHeader)).size, 4);
});

test('input order does not change results, input is untouched, and no data is explicitly distinguished', () => {
  const input = fixture(), before = structuredClone(input), first = buildFrontendReporting(input);
  assert.deepEqual(input, before);
  for (const name of ['people', 'flights', 'squadrons', 'terms', 'events']) input[name].reverse();
  assert.deepEqual(buildFrontendReporting(input), first);
  assert.equal(first.dashboard.noCountedAttendanceCadets, 2); assert.equal(first.dashboard.averageOverall, 1);
  const empty = fixture(); empty.people = []; empty.events.forEach(e => e.eligiblePersonIds = []);
  assert.equal(buildFrontendReporting(empty).dashboard.averageOverall, null);
});

test('untrusted IDs, invalid states, duplicate entities and excessive matrix size fail closed', () => {
  for (const mutate of [x => x.people.push({ ...x.people[0] }), x => x.people[0].flightId = 'missing',
    x => x.events[0].eligiblePersonIds = ['unknown'], x => x.policyVersion = 'invented-policy',
    x => x.requests.push(request({ requestedOutcome: 'unknown' })),
    x => x.observations.push(observation('bad', 'cadet-a', 'event-mando', 'P', 0)),
    x => x.terms.push({ ...x.terms[0], termId: 'other' })]) {
    const input = fixture(); mutate(input); assert.throws(() => buildFrontendReporting(input), ReportingInputError);
  }
  const large = fixture(); large.people = Array.from({ length: 500 }, (_, i) => person(`cadet-${i}`));
  large.events = Array.from({ length: 201 }, (_, i) => event(`event-${i}`, { eligiblePersonIds: null }));
  assert.throws(() => buildFrontendReporting(large), error => error instanceof ReportingInputError && error.path === 'matrix.capacity');
});
