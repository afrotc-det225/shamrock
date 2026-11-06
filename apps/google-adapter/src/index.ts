import { parseCommand } from '../../../packages/domain/src/index.js';

/** The v3 prototype deliberately has no production trigger or resource binding. */
export type AdapterCommand = ReturnType<typeof parseCommand>;
export type Actor = AdapterCommand['actor'];
export type Decision = 'Approved' | 'Denied' | 'Withdrawn' | 'Superseded';

export interface AdapterConfig {
  baseUrl: string;
  keyId: string;
  environment: 'local' | 'staging';
  generation: number;
}

/** Implement with Utilities in Apps Script; the secret stays inside this port. */
export interface Signer {
  sha256(text: string): string;
  hmacSha256(text: string): string;
}

export interface SignedRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export class AdapterError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

function fail(code: string, message: string): never {
  throw new AdapterError(code, message);
}

function requireId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    fail('invalid_identity', `Invalid ${label}.`);
  }
  return value;
}

function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) fail('invalid_signer', 'Signing returned an invalid digest.');
  return value;
}

function validateConfig(config: AdapterConfig): void {
  if (config.environment !== 'local' && config.environment !== 'staging') {
    fail('invalid_environment', 'Only isolated local or staging environments are supported.');
  }
  const https = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(config.baseUrl);
  const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(config.baseUrl);
  if (!https && !(config.environment === 'local' && loopback)) {
    fail('invalid_endpoint', 'Use an HTTPS origin, or loopback HTTP for local testing.');
  }
  requireId(config.keyId, 'key identifier');
  if (!Number.isSafeInteger(config.generation) || config.generation < 1) {
    fail('invalid_generation', 'The deployment generation must be a positive integer.');
  }
}

function signBody(body: string, config: AdapterConfig, signer: Signer, nowSeconds: number, path = '/v1/commands'): SignedRequest {
  validateConfig(config);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) fail('invalid_clock', 'A valid clock is required.');
  // encodeURIComponent works in Apps Script; TextEncoder is not assumed available.
  const bytes = encodeURIComponent(body).replace(/%[A-F0-9]{2}/g, 'x').length;
  if (bytes > 64 * 1024) fail('payload_too_large', 'Split this operation into smaller reviewed batches.');
  const timestamp = String(nowSeconds);
  const canonical = `POST\n${path}\n${timestamp}\n${digest(signer.sha256(body))}`;
  return {
    url: `${config.baseUrl}${path}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shamrock-key-id': config.keyId,
      'x-shamrock-timestamp': timestamp,
      'x-shamrock-signature': digest(signer.hmacSha256(canonical)),
    },
    body,
  };
}

export function buildSignedJobRequest(
  path: '/v1/jobs/claim' | '/v1/jobs/project' | '/v1/jobs/ack',
  input: { workerId: string; jobId?: string; claimToken?: string },
  config: AdapterConfig,
  signer: Signer,
  nowSeconds: number,
): SignedRequest {
  requireId(input.workerId, 'adapter worker');
  if (path !== '/v1/jobs/claim' && path !== '/v1/jobs/project' && path !== '/v1/jobs/ack') fail('invalid_operation', 'Unsupported adapter job operation.');
  if (path !== '/v1/jobs/claim' && (!input.jobId || !input.claimToken)) fail('invalid_claim', 'A complete job claim is required.');
  const body = {
    environment: config.environment, generation: config.generation, workerId: input.workerId,
    ...(path === '/v1/jobs/claim' ? {} : { jobId: input.jobId, claimToken: input.claimToken }),
  };
  return signBody(JSON.stringify(body), config, signer, nowSeconds, path);
}

export function buildSignedCommandRequest(
  input: unknown,
  config: AdapterConfig,
  signer: Signer,
  nowSeconds: number,
): SignedRequest {
  const command = parseCommand(input);
  if (command.environment !== config.environment || command.generation !== config.generation) {
    fail('wrong_generation', 'The saved command belongs to another deployment.');
  }
  return signBody(JSON.stringify(command), config, signer, nowSeconds);
}

export type ChoiceReference =
  | { kind: 'event'; eventId: string }
  | { kind: 'person'; personId: string }
  | { kind: 'scope'; unitId: string; rosterVersion: number; coveredPersonIds: readonly string[] };

export interface FormCatalog {
  /** Trusted configuration, never taken from a respondent answer. */
  nativeFormId: string;
  resourceKey: string;
  itemRoles: { event: string; scope: string; present: readonly string[]; completeness: string };
  /** Retain historical references; never reuse a token for another target. */
  references: Readonly<Record<string, ChoiceReference>>;
}

export interface FormSnapshot {
  nativeFormId: string;
  responseId: string;
  revision: number;
  responderEmail: string;
  /** Set only after the host verifies the configured Form's email-collection policy. */
  verifiedResponder: boolean;
  answers: Readonly<Record<string, string | readonly string[]>>;
}

export interface PrincipalResolver {
  /** Lookup an enrolled principal from trusted Google evidence, not a user-entered email question. */
  resolveVerifiedEmail(email: string): string | undefined;
}

function scalar(snapshot: FormSnapshot, itemId: string): string {
  const value = snapshot.answers[itemId];
  if (typeof value !== 'string') fail('invalid_form_answer', 'A required Form answer is missing or ambiguous.');
  return value;
}

function choice(label: string, catalog: FormCatalog): ChoiceReference {
  const match = /\[sr:([A-Za-z0-9_.:-]{1,96})\]$/.exec(label);
  if (!match) fail('unknown_choice', 'This response needs a reviewed choice mapping.');
  const reference = catalog.references[match[1]];
  if (!reference) fail('unknown_choice', 'The referenced Form choice is not in the retained catalog.');
  return reference;
}

/** Choice text may change; only its immutable reference selects the target. */
export function attendanceCommandFromForm(
  snapshot: FormSnapshot,
  catalog: FormCatalog,
  principals: PrincipalResolver,
  config: AdapterConfig,
  signer: Signer,
): AdapterCommand {
  if (snapshot.nativeFormId !== catalog.nativeFormId) fail('wrong_source', 'This Form is not bound to the adapter.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(snapshot.responseId)) fail('invalid_identity', 'Invalid native response identifier.');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) fail('invalid_revision', 'A source revision is required.');
  if (!snapshot.verifiedResponder || !snapshot.responderEmail.trim()) {
    fail('confirmation_required', 'Verified responder identity is required.');
  }
  const principalId = principals.resolveVerifiedEmail(snapshot.responderEmail.trim().toLowerCase());
  if (!principalId) fail('confirmation_required', 'The responder is not an enrolled principal.');
  const event = choice(scalar(snapshot, catalog.itemRoles.event), catalog);
  const scope = choice(scalar(snapshot, catalog.itemRoles.scope), catalog);
  if (event.kind !== 'event' || scope.kind !== 'scope') fail('invalid_choice_role', 'Form choices have an invalid role.');
  const present = new Set<string>();
  for (const itemId of catalog.itemRoles.present) {
    const answer = snapshot.answers[itemId];
    if (answer === undefined || answer === '') continue;
    if (!Array.isArray(answer)) fail('invalid_form_answer', 'The presence list must be a checkbox response.');
    for (const label of answer) {
      const person = choice(label, catalog);
      if (person.kind !== 'person') fail('invalid_choice_role', 'A roster choice does not identify a person.');
      present.add(person.personId);
    }
  }
  const completeness = scalar(snapshot, catalog.itemRoles.completeness);
  if (completeness !== 'partial' && completeness !== 'complete') fail('invalid_completeness', 'Explicit report completeness is required.');
  const sourceIdentity = `${catalog.resourceKey}\n${snapshot.responseId}\n${snapshot.revision}`;
  const token = digest(signer.sha256(sourceIdentity));
  return parseCommand({
    commandId: `form.${token}`,
    contractVersion: 1,
    environment: config.environment,
    generation: config.generation,
    actor: { principalId, evidence: 'google-form' },
    source: { kind: 'form', resourceKey: catalog.resourceKey, submissionId: snapshot.responseId, revision: snapshot.revision },
    operation: 'attendance.report',
    payload: {
      reportId: `report.${token}`,
      eventId: event.eventId,
      unitId: scope.unitId,
      rosterVersion: scope.rosterVersion,
      coveredPersonIds: [...scope.coveredPersonIds],
      presentPersonIds: [...present],
      completeness,
    },
  });
}

export interface DecisionSlot {
  /** Stable slot and target metadata are never rebound while a draft is pending. */
  slotId: string;
  requestId: string;
  baseVersion: number;
}

export interface DecisionDraft extends DecisionSlot {
  draftId: string;
  decision: Decision;
  reason: string;
  resourceKey: string;
  actor?: Actor;
  status: 'ready' | 'confirmation-required';
}

/** Multi-cell triggers cannot attest an immutable pasted payload. Use explicit bulk review. */
export function captureDecisionDraft(input: {
  slot: DecisionSlot;
  draftId: string;
  resourceKey: string;
  decision: string;
  reason: string;
  editedCellCount: number;
  eventUserEmail?: string;
}, principals: PrincipalResolver): DecisionDraft {
  if (input.editedCellCount !== 1) fail('bulk_review_required', 'Review a frozen bulk draft before applying it.');
  requireId(input.slot.slotId, 'draft slot');
  requireId(input.slot.requestId, 'request identifier');
  requireId(input.draftId, 'draft identifier');
  requireId(input.resourceKey, 'source binding');
  if (!Number.isSafeInteger(input.slot.baseVersion) || input.slot.baseVersion < 1) fail('invalid_version', 'The recorded request version is missing.');
  if (!['Approved', 'Denied', 'Withdrawn', 'Superseded'].includes(input.decision)) {
    fail('invalid_decision', 'Choose a supported decision; clearing a cell does not reopen a request.');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.includes('\u0000') || input.reason.length > 4000) fail('invalid_reason', 'The decision reason is invalid.');
  const principalId = input.eventUserEmail
    ? principals.resolveVerifiedEmail(input.eventUserEmail.trim().toLowerCase())
    : undefined;
  return {
    ...input.slot,
    draftId: input.draftId,
    resourceKey: input.resourceKey,
    decision: input.decision as Decision,
    reason: input.reason,
    ...(principalId ? { actor: { principalId, evidence: 'google-edit' as const } } : {}),
    status: principalId ? 'ready' : 'confirmation-required',
  };
}

export function decisionCommandFromDraft(draft: DecisionDraft, config: AdapterConfig): AdapterCommand {
  if (draft.status !== 'ready' || !draft.actor) fail('confirmation_required', 'Keep the draft until an authorized person confirms it.');
  return parseCommand({
    commandId: `draft.${draft.draftId}`,
    contractVersion: 1,
    environment: config.environment,
    generation: config.generation,
    actor: draft.actor,
    source: { kind: 'sheet', resourceKey: draft.resourceKey, submissionId: draft.draftId, revision: 1 },
    operation: 'excusal.decide',
    payload: { requestId: draft.requestId, expectedVersion: draft.baseVersion, decision: draft.decision, reason: draft.reason },
  });
}

export type JournalStatus = 'pending' | 'committed' | 'conflict' | 'rejected' | 'needs-attention';
export interface JournalEntry {
  commandId: string;
  body: string;
  bodyHash: string;
  status: JournalStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

export interface Journal {
  /** Atomic under the journal's script lock; enforce capacity without deleting pending input. */
  insert(entry: JournalEntry): JournalEntry;
  due(nowSeconds: number, limit: number): JournalEntry[];
  /** Bounded lookup includes terminal outcomes; callers hold the same journal lock. */
  find(commandIds: readonly string[]): JournalEntry[];
  /** Compare expected attempts/status so a concurrent dispatch cannot silently overwrite state. */
  update(entry: JournalEntry, expected: { attempts: number; status: JournalStatus }): void;
}

export interface Transport {
  send(request: SignedRequest): { status: number; body: string };
}

export function enqueueCommand(input: unknown, journal: Journal, signer: Signer): JournalEntry {
  const command = parseCommand(input);
  const body = JSON.stringify(command);
  const entry: JournalEntry = {
    commandId: command.commandId, body, bodyHash: digest(signer.sha256(body)),
    status: 'pending', attempts: 0, nextAttemptAt: 0, lastError: '',
  };
  const stored = journal.insert(entry);
  if (stored.bodyHash !== entry.bodyHash || stored.body !== body) fail('command_collision', 'A saved command identifier has different content.');
  return stored;
}

/** Caller serializes dispatches with a script lock. Network timeouts retain the original payload. */
export function dispatchPending(
  journal: Journal,
  transport: Transport,
  config: AdapterConfig,
  signer: Signer,
  nowSeconds: number,
  options: { limit?: number; maxAttempts?: number } = {},
): { committed: number; pending: number; attention: number } {
  const limit = options.limit ?? 10;
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    fail('invalid_batch', 'Dispatch bounds are invalid.');
  }
  const summary = { committed: 0, pending: 0, attention: 0 };
  for (const entry of journal.due(nowSeconds, limit)) {
    const next: JournalEntry = { ...entry, attempts: entry.attempts + 1 };
    try {
      if (digest(signer.sha256(entry.body)) !== entry.bodyHash) fail('journal_integrity', 'Saved command integrity failed.');
      const command = parseCommand(JSON.parse(entry.body));
      if (command.commandId !== entry.commandId || command.environment !== config.environment || command.generation !== config.generation) {
        fail('journal_integrity', 'Saved command identity or deployment differs.');
      }
      const response = transport.send(signBody(entry.body, config, signer, nowSeconds));
      if (response.status >= 200 && response.status < 300) {
        const receipt: unknown = JSON.parse(response.body);
        if (!receipt || typeof receipt !== 'object' || !('commandId' in receipt) || receipt.commandId !== entry.commandId || !('status' in receipt) || receipt.status !== 'committed') {
          fail('unknown_outcome', 'The response did not prove the command was committed.');
        }
        next.status = 'committed';
        next.lastError = '';
      } else if (response.status === 409) {
        next.status = 'conflict';
        next.lastError = 'conflict';
      } else if (response.status === 400 || response.status === 404 || response.status === 422) {
        next.status = 'rejected';
        next.lastError = 'rejected';
      } else if (response.status === 401 || response.status === 403) {
        next.status = 'needs-attention';
        next.lastError = 'authorization_required';
      } else {
        next.lastError = 'delivery_pending';
      }
    } catch (error) {
      // Never copy raw HTTP errors, tokens, URLs or payloads into operator-visible status.
      next.lastError = error instanceof AdapterError ? error.code : 'delivery_pending';
      if (next.lastError === 'journal_integrity' || next.lastError === 'invalid_signer') next.status = 'needs-attention';
    }
    if (next.status === 'pending' && next.attempts >= maxAttempts) next.status = 'needs-attention';
    next.nextAttemptAt = next.status === 'pending' ? nowSeconds + Math.min(3600, 30 * 2 ** (next.attempts - 1)) : 0;
    journal.update(next, { attempts: entry.attempts, status: entry.status });
    if (next.status === 'committed') summary.committed++;
    else if (next.status === 'pending') summary.pending++;
    else summary.attention++;
  }
  return summary;
}

export interface RecordedDecision extends DecisionSlot {
  recordedDecision: string;
  recordedVersion: number;
  saveStatus: string;
}

export interface DecisionOutputPort {
  readSlot(slotId: string): (DecisionSlot & { recordedVersion: number }) | undefined;
  /** Write only protected recorded output cells. Never write IDs, names, drafts or sort rows. */
  writeRecorded(slotId: string, output: { decision: string; version: number; saveStatus: string }): void;
}

export function publishRecordedDecision(output: RecordedDecision, port: DecisionOutputPort): void {
  const slot = port.readSlot(output.slotId);
  if (!slot || slot.requestId !== output.requestId) fail('draft_target_changed', 'The draft target changed; publication needs repair.');
  if (!Number.isSafeInteger(output.recordedVersion) || output.recordedVersion < 1 || output.recordedVersion < slot.recordedVersion) {
    fail('stale_projection', 'A stale recorded decision cannot replace a newer one.');
  }
  port.writeRecorded(output.slotId, { decision: output.recordedDecision, version: output.recordedVersion, saveStatus: output.saveStatus });
}
