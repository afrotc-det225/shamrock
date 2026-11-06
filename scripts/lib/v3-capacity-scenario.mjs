import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import worker from '../../.build/v3-artifacts/worker.mjs';
import { initializeLocalDatabase } from './v3-local-database.mjs';
import { instrumentDatabase, summarizeCapacity } from './v3-capacity.mjs';

// Deliberately exercises the current maximum interactive roster and excusal
// selection. No provider credentials, Google resources, or retained database.
export async function runCapacityScenario() {
  const secret = randomBytes(32).toString('hex');
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../../.build/v3-artifacts/worker.mjs', import.meta.url)),
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'capacity-fixture' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    await initializeLocalDatabase(db);
    const people = Array.from({ length: 500 }, (_, index) => `person-${String(index).padStart(3, '0')}`);
    const events = Array.from({ length: 25 }, (_, index) => `event-${String(index).padStart(2, '0')}`);
    await db.batch([
      db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
      db.prepare("INSERT INTO people SELECT value,'Fictional '||value FROM json_each(?)").bind(JSON.stringify(people)),
      db.prepare("INSERT INTO principals VALUES('representative',NULL,1),('cadet','person-000',1),('approver',NULL,1)"),
      db.prepare("INSERT INTO organizational_units VALUES('alpha','Fictional Alpha',1)"),
      db.prepare("INSERT INTO memberships SELECT person_id,'alpha',1 FROM people"),
      db.prepare("INSERT INTO events SELECT value,'Fictional '||value,1 FROM json_each(?)").bind(JSON.stringify(events)),
      db.prepare("INSERT INTO event_units SELECT event_id,'alpha' FROM events"),
      db.prepare("INSERT INTO access_grants VALUES('representative','attendance.report','alpha','unit'),('cadet','excusal.submit','alpha','self'),('approver','excusal.decide','alpha','unit')"),
      db.prepare("INSERT INTO adapter_sources VALUES('test','capacity-console',1)"),
    ]);
    const probe = instrumentDatabase(db);
    const samples = [];
    const env = { DB: probe.db, ENVIRONMENT: 'local', GENERATION: '1', BRIDGE_KEY_ID: 'capacity-key', BRIDGE_SECRET: secret };
    async function send(label, path, input, expectedStatus = 200) {
      const body = JSON.stringify(input);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const digest = createHash('sha256').update(body).digest('hex');
      const signature = createHmac('sha256', secret).update(`POST\n${path}\n${timestamp}\n${digest}`).digest('hex');
      probe.begin(label);
      const response = await worker.fetch(new Request(`https://capacity.invalid${path}`, {
        method: 'POST', body, headers: { 'content-type': 'application/json', 'x-shamrock-key-id': 'capacity-key',
          'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature },
      }), env);
      const sample = probe.end();
      samples.push(sample);
      const result = await response.json();
      if (response.status !== expectedStatus) throw new Error(`Capacity fixture ${label}: unexpected ${response.status} (${result.error?.code ?? 'unknown'}).`);
      return result;
    }
    const command = (operation, principalId, payload) => ({
      commandId: operation, contractVersion: 1, environment: 'local', generation: 1,
      actor: { principalId, evidence: 'authenticated-confirmation' },
      source: { kind: 'test', resourceKey: 'capacity-console', submissionId: operation, revision: 1 }, operation, payload,
    });
    const attendance = command('attendance.report', 'representative', {
      reportId: 'capacity-report', eventId: events[0], unitId: 'alpha', rosterVersion: 1,
      coveredPersonIds: people, presentPersonIds: people, completeness: 'complete',
    });
    await send('attendance-500', '/v1/commands', attendance);
    await send('identical-retry', '/v1/commands', attendance);
    await send('excusal-25-events', '/v1/commands', command('excusal.submitMany', 'cadet', {
      personId: people[0], requestedOutcome: 'E', reason: 'Fictional capacity rehearsal.',
      events: events.map(eventId => ({ eventId, requestId: `request-${eventId}` })),
    }));
    await send('decision', '/v1/commands', command('excusal.decide', 'approver', {
      requestId: `request-${events[0]}`, expectedVersion: 1, decision: 'Approved', reason: 'Fictional decision.',
    }));
    const job = extra => ({ environment: 'local', generation: 1, workerId: 'capacity-adapter', ...extra });
    let jobs = 0;
    while (jobs <= 27) {
      const claimed = await send('job-claim', '/v1/jobs/claim', job({}));
      if (!claimed.job) break;
      const identity = { jobId: claimed.job.jobId, claimToken: claimed.job.claimToken };
      const projection = await send('projection-500', '/v1/jobs/project', job(identity));
      if (projection.rows.length !== 500) throw new Error('Incomplete capacity projection.');
      await send('job-ack', '/v1/jobs/ack', job(identity));
      jobs++;
    }
    if (jobs !== 27) throw new Error('Unexpected capacity job count.');
    const report = summarizeCapacity(samples);
    // Keep output compact while retaining per-invocation maxima and workload sums.
    const labels = [...new Set(samples.map(sample => sample.label))];
    report.samples = labels.map(label => {
      const group = samples.filter(sample => sample.label === label);
      const max = key => Math.max(...group.map(sample => sample[key]));
      const sum = key => group.reduce((total, sample) => total + sample[key], 0);
      return { label, invocations: group.length, maxD1Calls: max('d1Calls'), maxStatements: max('statements'),
        maxParameters: max('maxParameters'), maxSqlBytes: max('maxSqlBytes'),
        localRowsRead: sum('localRowsRead'), localRowsWritten: sum('localRowsWritten'),
        rowCountersAvailable: group.every(sample => sample.rowCountersAvailable),
        withinInvocationLimits: group.every(sample => sample.withinInvocationLimits) };
    });
    report.fixture = { people: people.length, events: events.length, commands: 3, duplicateDeliveries: 1, completedJobs: jobs };
    return report;
  } finally { await mf.dispose(); }
}
