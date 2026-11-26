import assert from 'node:assert/strict';
import test from 'node:test';
import { currentExcusalRequests } from '../src/attendance-events.mjs';

test('the working excusal queue and its pending count use only active events this term', () => {
  const snapshot = {
    terms: [{ termId: 'fall', isCurrent: true }, { termId: 'spring', isCurrent: false }],
    events: [
      { eventId: 'mando', termId: 'fall', status: 'active' },
      { eventId: 'llab', termId: 'fall', status: 'cancelled' },
      { eventId: 'prior', termId: 'spring', status: 'active' },
    ],
    requests: ['mando', 'llab', 'prior', 'unknown'].map(eventId => ({ eventId, status: 'Submitted' })),
  };
  assert.deepEqual(currentExcusalRequests(snapshot), [snapshot.requests[0]]);
  assert.equal(snapshot.requests.length, 4);
});
