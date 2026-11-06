import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import {
  attendanceCommandFromForm, buildSignedCommandRequest, buildSignedJobRequest,
  captureDecisionDraft, decisionCommandFromDraft, publishRecordedDecision,
} from '../../.build/v3/apps/google-adapter/src/index.js';
import { createGoogleSigner } from '../../.build/v3/apps/google-adapter/src/apps-script.js';
import { initializeLocalDatabase } from './v3-local-database.mjs';

// Entirely fictional. No provider credentials, Google resources, or retained database.
export async function runLocalScenario() {
  const secret = randomBytes(32).toString('hex');
  const config = { baseUrl: 'https://scenario.invalid', keyId: 'local-scenario', environment: 'local', generation: 1 };
  // Google Utilities represents binary digest bytes as signed integers.
  const signedBytes = bytes => Array.from(bytes, byte => byte > 127 ? byte - 256 : byte);
  const signer = createGoogleSigner({
    DigestAlgorithm: { SHA_256: 'SHA-256' }, Charset: { UTF_8: 'UTF-8' },
    computeDigest: (_algorithm, value) => signedBytes(createHash('sha256').update(value).digest()),
    computeHmacSha256Signature: (value, key) => signedBytes(createHmac('sha256', key).update(value).digest()),
  }, secret);
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../../.build/v3-artifacts/worker.mjs', import.meta.url)),
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'local-scenario' },
    bindings: { ENVIRONMENT: config.environment, GENERATION: '1', BRIDGE_KEY_ID: config.keyId, BRIDGE_SECRET: secret },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    await initializeLocalDatabase(db);
    await db.batch([
      db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
      db.prepare("INSERT INTO people VALUES('person-a','Example A'),('person-b','Example B')"),
      db.prepare("INSERT INTO principals VALUES('representative',NULL,1),('cadet-a','person-a',1),('approver',NULL,1)"),
      db.prepare("INSERT INTO organizational_units VALUES('alpha','Alpha',1)"),
      db.prepare("INSERT INTO memberships VALUES('person-a','alpha',1),('person-b','alpha',1)"),
      db.prepare("INSERT INTO events VALUES('event-one','Fictional training',1)"),
      db.prepare("INSERT INTO event_units VALUES('event-one','alpha')"),
      db.prepare("INSERT INTO access_grants VALUES('representative','attendance.report','alpha','unit'),('cadet-a','excusal.submit','alpha','self'),('approver','excusal.decide','alpha','unit')"),
      db.prepare("INSERT INTO adapter_sources VALUES('form','attendance-form',1),('sheet','decision-sheet',1),('test','scenario-console',1)"),
    ]);
    const now = () => Math.floor(Date.now() / 1000);
    async function send(request) {
      const response = await mf.dispatchFetch(request.url, { method: request.method, headers: request.headers, body: request.body });
      return { status: response.status, body: await response.json() };
    }
    async function accepted(request) {
      const response = await send(request);
      if (response.status !== 200) throw new Error(`Local scenario failed: ${response.status} ${response.body.error?.code ?? 'unknown response'}`);
      return response.body;
    }
    const signed = input => buildSignedCommandRequest(input, config, signer, now());
    const job = (path, input) => buildSignedJobRequest(path, { workerId: 'scenario-adapter', ...input }, config, signer, now());
    const principals = { resolveVerifiedEmail: email => ({
      'representative@example.invalid': 'representative', 'approver@example.invalid': 'approver',
    })[email] };
    const attendance = attendanceCommandFromForm({
      nativeFormId: 'fictional-form', responseId: 'native-response-one', revision: 1,
      responderEmail: 'representative@example.invalid', verifiedResponder: true,
      answers: { event: 'Training [sr:event]', scope: 'Alpha [sr:alpha.v1]', present: ['Example A [sr:person-a]'], complete: 'complete' },
    }, {
      nativeFormId: 'fictional-form', resourceKey: 'attendance-form',
      itemRoles: { event: 'event', scope: 'scope', present: ['present'], completeness: 'complete' },
      references: {
        event: { kind: 'event', eventId: 'event-one' },
        'alpha.v1': { kind: 'scope', unitId: 'alpha', rosterVersion: 1, coveredPersonIds: ['person-a', 'person-b'] },
        'person-a': { kind: 'person', personId: 'person-a' },
      },
    }, principals, config, signer);
    const originalReceipt = await accepted(signed(attendance));
    // Duplicate delivery uses the same frozen command; no timeout is injected here.
    const retriedReceipt = await accepted(signed(attendance));
    await accepted(signed({
      commandId: 'scenario-request', contractVersion: 1, environment: 'local', generation: 1,
      actor: { principalId: 'cadet-a', evidence: 'authenticated-confirmation' },
      source: { kind: 'test', resourceKey: 'scenario-console', submissionId: 'request-one', revision: 1 },
      operation: 'excusal.submit',
      payload: { requestId: 'request-one', eventId: 'event-one', personId: 'person-a', requestedOutcome: 'E', reason: 'Fictional scheduling conflict.' },
    }));
    const draftInput = {
      slot: { slotId: 'slot-one', requestId: 'request-one', baseVersion: 1 },
      draftId: 'decision-one', resourceKey: 'decision-sheet', decision: 'Approved',
      reason: 'Fictional approval rationale.', editedCellCount: 1, eventUserEmail: 'approver@example.invalid',
    };
    const unknownEditor = captureDecisionDraft({ ...draftInput, eventUserEmail: undefined }, principals);
    const draft = captureDecisionDraft(draftInput, principals);
    await accepted(signed(decisionCommandFromDraft(draft, config)));
    const stale = decisionCommandFromDraft({ ...draft, draftId: 'stale-decision', decision: 'Denied' }, config);
    const staleResponse = await send(signed(stale));
    const tampered = signed(attendance);
    tampered.body = tampered.body.replace('representative', 'another-principal');
    const tamperedResponse = await send(tampered);

    // In-memory output port demonstrates the contract, not live Google rendering.
    const output = { slotId: draft.slotId, requestId: draft.requestId, baseVersion: 1,
      recordedVersion: 1, recordedDecision: 'Submitted', draftDecision: 'Denied' };
    let projectedRows;
    let completedJobs = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const claimed = await accepted(job('/v1/jobs/claim', {}));
      if (!claimed.job) break;
      const identity = { jobId: claimed.job.jobId, claimToken: claimed.job.claimToken };
      const projection = await accepted(job('/v1/jobs/project', identity));
      projectedRows = projection.rows;
      const request = projection.rows.flatMap(row => row.requests).find(row => row.requestId === 'request-one');
      if (!request) throw new Error('The current projection omitted the submitted request.');
      publishRecordedDecision({ slotId: output.slotId, requestId: request.requestId, baseVersion: output.baseVersion,
        recordedDecision: request.status, recordedVersion: request.version, saveStatus: 'Saved',
      }, {
        readSlot: () => output,
        writeRecorded: (_slotId, recorded) => {
          output.recordedDecision = recorded.decision;
          output.recordedVersion = recorded.version;
        },
      });
      await accepted(job('/v1/jobs/ack', identity));
      completedJobs++;
    }
    const counts = {};
    for (const table of ['operation_commands', 'audit_events', 'attendance_reports', 'attendance_observations', 'excusal_decisions']) {
      counts[table] = (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
    }
    return {
      mode: 'local-fictional-data', receiptUnchangedOnRetry: JSON.stringify(originalReceipt) === JSON.stringify(retriedReceipt),
      counts, projectedRows, completedJobs, output,
      staleDecisionStatus: staleResponse.status, tamperedRequestStatus: tamperedResponse.status,
      unknownEditorStatus: unknownEditor.status,
    };
  } finally {
    await mf.dispose();
  }
}
