import { createHash, createHmac, randomUUID } from 'node:crypto';

// Requires the fictional fixture described in the staging runbook. Never run
// against an operational database. The runtime itself only accepts staging.
const args = process.argv.slice(2);
const options = Object.fromEntries(args.map(arg => {
  const separator = arg.indexOf('=');
  if (!arg.startsWith('--') || separator < 3) throw new Error('Use --origin=, --key-id= and --generation=.');
  return [arg.slice(2, separator), arg.slice(separator + 1)];
}));
if (args.length !== 3 || Object.keys(options).length !== 3 || ['origin', 'key-id', 'generation'].some(key => !options[key])) {
  throw new Error('Exactly three non-secret options are required: --origin, --key-id, --generation.');
}
const origin = new URL(options.origin);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Use an HTTPS staging origin without credentials or paths.');
}
const generation = Number(options.generation);
if (!Number.isSafeInteger(generation) || generation < 1 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options['key-id'])) {
  throw new Error('Invalid staging generation or key ID.');
}
let secret = '';
for await (const chunk of process.stdin) {
  secret += chunk;
  if (secret.length > 4096) throw new Error('Signing key input exceeds its bound.');
}
secret = secret.trim();
if (secret.length < 32) throw new Error('Supply the staging signing key through stdin, never a CLI argument.');

async function request(path, body, expected = 200, signed = true) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { 'content-type': 'application/json' };
  if (signed) {
    const canonical = `POST\n${path}\n${timestamp}\n${createHash('sha256').update(rawBody).digest('hex')}`;
    headers['x-shamrock-key-id'] = options['key-id'];
    headers['x-shamrock-timestamp'] = timestamp;
    headers['x-shamrock-signature'] = createHmac('sha256', secret).update(canonical).digest('hex');
  }
  const response = await fetch(new URL(path, origin), { method: 'POST', headers, body: rawBody, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (response.status !== expected) throw new Error(`Staging check ${path} expected ${expected}, received ${response.status}.`);
  return response.json();
}
const health = await fetch(new URL('/health', origin), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
if (health.status !== 200 || (await health.json()).phase !== 'isolated-prototype') throw new Error('Staging health check failed.');
await request('/v1/commands', {}, 401, false);
const runId = `smoke.${randomUUID()}`;
const makeCommand = (operation, actor, payload) => ({
  commandId: `${runId}.${operation}`, contractVersion: 1, environment: 'staging', generation,
  actor: { principalId: actor, evidence: 'authenticated-confirmation' },
  source: { kind: 'test', resourceKey: 'staging-smoke', submissionId: `${runId}.${operation}`, revision: 1 },
  operation, payload,
});
const committedIds = new Set();
async function accepted(command) {
  const receipt = await request('/v1/commands', command);
  if (receipt.status !== 'committed' || receipt.commandId !== command.commandId || receipt.operation !== command.operation) {
    throw new Error('Staging response did not prove this command committed.');
  }
  committedIds.add(command.commandId);
  return receipt;
}
const report = makeCommand('attendance.report', 'staging-representative', {
  reportId: `${runId}.report`, eventId: 'staging-event', unitId: 'staging-alpha', rosterVersion: 1,
  coveredPersonIds: ['staging-person-a', 'staging-person-b'], presentPersonIds: ['staging-person-a'], completeness: 'complete',
});
const first = await accepted(report);
const retry = await accepted(report);
if (JSON.stringify(first) !== JSON.stringify(retry)) throw new Error('Duplicate staging delivery changed the receipt.');
await accepted(makeCommand('excusal.submit', 'staging-cadet-a', {
  requestId: `${runId}.request`, eventId: 'staging-event', personId: 'staging-person-a', requestedOutcome: 'E', reason: 'Fictional staging request.',
}));
const decision = makeCommand('excusal.decide', 'staging-approver', {
  requestId: `${runId}.request`, expectedVersion: 1, decision: 'Approved', reason: 'Fictional staging decision.',
});
await accepted(decision);
const stale = structuredClone(decision);
stale.commandId += '.stale'; stale.source.submissionId += '.stale'; stale.payload.decision = 'Denied';
await request('/v1/commands', stale, 409);
const jobs = { environment: 'staging', generation, workerId: runId };
const expectedJobs = new Set([...committedIds].map(id => `projection:${createHash('sha256').update(id).digest('hex')}`));
let completed = 0;
for (let count = 0; count < 3; count++) {
  const claimed = await request('/v1/jobs/claim', jobs);
  if (!claimed.job || claimed.job.eventId !== 'staging-event' || claimed.job.unitId !== 'staging-alpha' || !expectedJobs.has(claimed.job.jobId)) {
    throw new Error('Unexpected staging job; stop and inspect the isolated fixture.');
  }
  const claim = { ...jobs, jobId: claimed.job.jobId, claimToken: claimed.job.claimToken };
  const projection = await request('/v1/jobs/project', claim);
  const present = projection.rows.find(row => row.personId === 'staging-person-a');
  const other = projection.rows.find(row => row.personId === 'staging-person-b');
  const approved = present?.requests.find(entry => entry.requestId === `${runId}.request`);
  if (present?.observedCode !== 'P' || other?.observedCode !== null || approved?.status !== 'Approved' || approved.version !== 2) {
    throw new Error('Staging projection did not preserve attendance and the approved request.');
  }
  // Only the local smoke consumer receives this synthetic projection. No Google
  // publication is claimed or performed by this acknowledgement.
  await request('/v1/jobs/ack', claim);
  expectedJobs.delete(claimed.job.jobId);
  completed++;
}
if (expectedJobs.size) throw new Error('Staging test did not consume every expected projection.');
console.log(JSON.stringify({ environment: 'staging', syntheticDataOnly: true, health: 'passed',
  unauthenticatedRequest: 'rejected', duplicateDelivery: 'deduplicated', staleDecision: 'rejected',
  commandsCommitted: committedIds.size, projectionJobsConsumedBySmokeTest: completed, googlePublicationTested: false,
}, null, 2));
