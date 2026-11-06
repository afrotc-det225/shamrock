import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalScenario } from '../../scripts/lib/v3-local-scenario.mjs';

test('Google command/signature contracts interoperate with the real local Worker and D1', async () => {
  const result = await runLocalScenario();
  assert.equal(result.receiptUnchangedOnRetry, true);
  assert.deepEqual(result.counts, { operation_commands: 3, audit_events: 3, attendance_reports: 1,
    attendance_observations: 1, excusal_record_decisions: 1 });
  assert.deepEqual(result.projectedRows, [
    { personId: 'person-a', displayName: 'Example A', observedCode: 'P',
      requests: [{ requestId: 'request-one', status: 'Approved', requestedOutcome: 'E', version: 2 }] },
    { personId: 'person-b', displayName: 'Example B', observedCode: null, requests: [] },
  ]);
  assert.equal(result.completedJobs, 3);
  assert.equal(result.output.recordedDecision, 'Approved');
  assert.equal(result.output.recordedVersion, 2);
  assert.equal(result.output.draftDecision, 'Denied');
  assert.equal(result.output.baseVersion, 1);
  assert.equal(result.staleDecisionStatus, 409);
  assert.equal(result.tamperedRequestStatus, 401);
  assert.equal(result.unknownEditorStatus, 'confirmation-required');
});
