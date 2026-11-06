import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentDatabase, summarizeCapacity } from '../../scripts/lib/v3-capacity.mjs';
import { runCapacityScenario } from '../../scripts/lib/v3-capacity-scenario.mjs';

test('maximum interactive workloads stay within free D1 invocation and SQL limits', async () => {
  const report = await runCapacityScenario();
  assert.equal(report.withinInvocationLimits, true, JSON.stringify(report.samples));
  assert.deepEqual(report.fixture, { people: 500, events: 25, commands: 3, duplicateDeliveries: 1, completedJobs: 27 });
  assert.equal(report.hostedCpuMs, null);
  assert.equal(report.dailyUsage, null);
  assert.equal(report.productionReady, false);
  assert.equal(report.samples.find(sample => sample.label === 'excusal-25-events').invocations, 1);
  const attendance = report.samples.find(sample => sample.label === 'attendance-500');
  assert.equal(attendance.rowCountersAvailable, true);
  // Regression budget: the former correlated JSON scan read >130,000 rows.
  // This fixture budget is not a hosted daily-usage certification.
  assert.ok(attendance.localRowsRead < 20_000, 'Attendance must not scan the whole submitted list for every member.');
});

test('capacity instrumentation counts a D1 batch once and never turns missing counters into evidence', async () => {
  const probe = instrumentDatabase({
    prepare() { return { bind() { return this; }, all: async () => ({ results: [{ answer: 7 }], meta: {} }) }; },
    batch: async statements => statements.map(() => ({ results: [], meta: { rows_read: 2, rows_written: 3 } })),
  });
  probe.begin('batch');
  await probe.db.batch(Array.from({ length: 75 }, () => probe.db.prepare('SELECT ?').bind(1)));
  const batch = probe.end();
  assert.equal(batch.d1Calls, 1);
  assert.equal(batch.statements, 75);
  assert.equal(batch.localRowsWritten, 225);
  assert.equal(batch.withinInvocationLimits, true);
  probe.begin('missing');
  assert.equal(await probe.db.prepare('SELECT 7 AS answer').first('answer'), 7);
  const missing = probe.end();
  assert.equal(missing.rowCountersAvailable, false);
  assert.equal(summarizeCapacity([missing]).dailyUsage, null);
  probe.begin('oversize');
  await probe.db.prepare('SELECT ?').bind(...Array(101).fill(0)).all();
  assert.equal(probe.end().withinInvocationLimits, false);
});
