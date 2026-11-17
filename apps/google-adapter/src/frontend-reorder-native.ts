/** Paused, owner-reviewed physical maintenance. Provider calls stay behind explicit ports. */
import { AdapterError } from './index.js';
import { bindImmutableInputSlots, inputCanonical, type InputSurface } from './frontend-input.js';
import { inputSurfaceState, type FrontendInputJournal } from './frontend-input-journal.js';
import { planFrontendReorder, verifyFrontendReorderReadback, type FrontendReorderPlan } from './frontend-reorder.js';
import type { FrontendTableRead } from './frontend-publication.js';
import type { FrontendPublicationState } from './frontend-runtime.js';

export const INPUT_REORDER_PROPERTY = 'SHAMROCK_V3_INPUT_REORDER';
const KINDS = ['directory', 'leadership'] as const;
const UNCHANGED = ['attendance', 'blue', 'gold'] as const;
type Kind = typeof KINDS[number];
export interface NativeInputSetupReceipt {
  fingerprint: string; ids: Record<string, string>;
  confirmationNativeItems: Record<string, number>; confirmationShape: string;
}
export interface NativeReorderRequest {
  requestId: string; sequence: number; action: 'reorder' | 'continue-reorder';
  frontendSha256: string; journalSha256: string; recoveryFileId: string; recoverySha256: string;
}
export interface NativeReorderCheckpoint {
  version: 1; environment: 'staging'; generation: number;
  operationId: string; fingerprint: string;
  phase: 'prepared' | 'rotating' | 'planned' | 'write-pending' | 'cells-verified' | 'checkpointed' | 'complete';
  frontendBeforeSha256: string; journalSha256: string;
  setup: NativeInputSetupReceipt; retired: Record<string, string>; replacements: Record<string, string>;
  before: Record<Kind, FrontendTableRead>; unchangedSha256: Record<typeof UNCHANGED[number], string>;
  plans?: Record<Kind, FrontendReorderPlan>; frontendAfterSha256?: string;
}
export interface NativeReorderPorts {
  generation: number; fingerprint: string; mainId: string; bookIds: string[]; confirmationId: string;
  state: FrontendPublicationState; journal: FrontendInputJournal;
  sha256(text: string): string;
  /** Recheck both disabled config gates, durable pauses and a fresh signed Worker fence. */
  assertPaused(): void;
  /** Fence every configured book and verify exact closed field grants; never reopen them here. */
  fence(): void;
  read(surface: InputSurface): FrontendTableRead;
  saveState(state: FrontendPublicationState): void;
  recovery: { load(): unknown; save(checkpoint: NativeReorderCheckpoint): void };
  active: { read(): string | null; write(value: string | null): void };
  setup: { read(): NativeInputSetupReceipt | undefined; write(receipt: NativeInputSetupReceipt | undefined): void };
  listEdits(): { id: string; bookId: string }[];
  deleteEdit(id: string): void;
  createEdit(bookId: string): string;
  assertConfirmation(receipt: NativeInputSetupReceipt): void;
  writeRows(requests: Record<string, unknown>[]): void;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => inputCanonical(left) === inputCanonical(right);
const digest = (ports: NativeReorderPorts, value: unknown) => ports.sha256(inputCanonical(value));
function fail(message: string): never { throw new AdapterError('input_reorder', message); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }

/** Move complete native rows upwards only; the request never touches machine/display headers. */
export function nativeReorderRequests(plans: readonly FrontendReorderPlan[]): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  requireCondition(plans.length === 2 && plans[0].kind === 'directory' && plans[1].kind === 'leadership'
    && plans[0].before.sheetId !== plans[1].before.sheetId, 'Reorder exactly the reviewed Directory and Leadership Tables.');
  for (const plan of plans) {
    const length = plan.before.rows.length;
    requireCondition(length <= 500 && plan.before.range.startRowIndex === 1 && plan.before.range.endRowIndex === length + 2
      && plan.sourceRowIndices.length === length && new Set(plan.sourceRowIndices).size === length
      && plan.sourceRowIndices.every(i => Number.isSafeInteger(i) && i >= 0 && i < length), 'The whole-row permutation exceeds its reviewed body.');
    const current = Array.from({ length }, (_, i) => i);
    for (let target = 0; target < length; target++) {
      const source = current.indexOf(plan.sourceRowIndices[target]);
      if (source === target) continue;
      requireCondition(source > target, 'The row permutation is inconsistent.');
      requests.push({ moveDimension: { source: { sheetId: plan.before.sheetId, dimension: 'ROWS', startIndex: source + 2, endIndex: source + 3 }, destinationIndex: target + 2 } });
      current.splice(target, 0, current.splice(source, 1)[0]);
    }
  }
  requireCondition(requests.length <= 998, 'The row permutation exceeds one atomic Google batch.');
  return requests;
}

/** Caller holds the shared ScriptLock for the entire operation and all durable writes. */
export function runPausedNativeReorder(ports: NativeReorderPorts, request: NativeReorderRequest): { status: 'reordered-paused'; rows: number } {
  ports.assertPaused();
  requireCondition(ports.state.generation === ports.generation && ports.journal.generation === ports.generation
    && !ports.state.pending && ports.bookIds.length === 2 && new Set(ports.bookIds).size === 2 && ports.bookIds.includes(ports.mainId), 'Use one complete paused native generation.');
  requireCondition(digest(ports, ports.state) === request.frontendSha256 && digest(ports, ports.journal) === request.journalSha256, 'The reviewed frontend or journal checkpoint changed.');
  for (const surface of [...KINDS, ...UNCHANGED]) requireCondition(!inputSurfaceState(ports.state, surface).drafts.length, 'Resolve every frozen draft before physical maintenance.');
  requireCondition(!Object.keys(ports.journal.held ?? {}).length && Object.values(ports.journal.entries).every(entry =>
    entry.superseded === true && entry.supersededApplied === true || entry.commands.length > 0 && entry.commands.every(command => command.status === 'committed' && command.applied === true)), 'Resolve all retained or uncertain input evidence before physical maintenance.');
  const raw = ports.recovery.load();
  requireCondition(digest(ports, raw) === request.recoverySha256, 'The reviewed private recovery checkpoint changed.');
  let checkpoint: NativeReorderCheckpoint;
  const save = () => ports.recovery.save(checkpoint);
  if (request.action === 'reorder') {
    requireCondition(same(raw, { version: 1, environment: 'staging', generation: ports.generation, status: 'empty' }) && ports.active.read() === null, 'Start with a fresh empty private recovery file.');
    const setup = ports.setup.read();
    requireCondition(setup?.fingerprint === ports.fingerprint && same(Object.keys(setup.ids).sort(), [...ports.bookIds, ports.confirmationId].sort()), 'Verify native setup before retiring its edit triggers.');
    const edits = ports.listEdits();
    requireCondition(edits.length === ports.bookIds.length && new Set(edits.map(t => t.id)).size === edits.length
      && ports.bookIds.every(bookId => edits.filter(t => t.bookId === bookId && t.id === setup.ids[bookId]).length === 1), 'The existing native edit triggers do not match their setup receipt.');
    ports.assertConfirmation(setup);
    ports.fence();
    const before = Object.fromEntries(KINDS.map(kind => [kind, ports.read(kind)])) as Record<Kind, FrontendTableRead>;
    const unchanged = Object.fromEntries(UNCHANGED.map(kind => [kind, ports.read(kind)])) as Record<typeof UNCHANGED[number], FrontendTableRead>;
    const retired = Object.fromEntries(ports.bookIds.map(bookId => [bookId, setup.ids[bookId]]));
    // Validate current values without asserting a trigger barrier that has not happened yet.
    for (const kind of [...KINDS, ...UNCHANGED]) {
      const table = inputSurfaceState(ports.state, kind);
      bindImmutableInputSlots({ current: kind === 'directory' || kind === 'leadership' ? before[kind] : unchanged[kind], baseline: table.baseline,
        keyHeader: kind === 'leadership' ? 'contact_id' : kind === 'blue' || kind === 'gold' ? 'request_id' : 'person_id', editFenceVerified: true });
    }
    checkpoint = { version: 1, environment: 'staging', generation: ports.generation, operationId: request.requestId, fingerprint: ports.fingerprint,
      phase: 'prepared', frontendBeforeSha256: request.frontendSha256, journalSha256: request.journalSha256,
      setup: copy(setup), retired, replacements: {}, before,
      unchangedSha256: Object.fromEntries(UNCHANGED.map(kind => [kind, digest(ports, unchanged[kind])])) as NativeReorderCheckpoint['unchangedSha256'] };
    save();
  } else {
    checkpoint = raw as NativeReorderCheckpoint;
    requireCondition(checkpoint?.version === 1 && checkpoint.environment === 'staging' && checkpoint.generation === ports.generation
      && checkpoint.fingerprint === ports.fingerprint && typeof checkpoint.operationId === 'string'
      && ['prepared', 'rotating', 'planned', 'write-pending', 'cells-verified', 'checkpointed', 'complete'].includes(checkpoint.phase)
      && same(Object.keys(checkpoint.retired ?? {}).sort(), ports.bookIds.slice().sort()) && checkpoint.journalSha256 === request.journalSha256,
    'The recovery checkpoint does not match this paused native operation.');
  }
  const marker = inputCanonical({ operationId: checkpoint.operationId, recoveryFileId: request.recoveryFileId });
  requireCondition(ports.active.read() === null || ports.active.read() === marker, 'Another physical maintenance operation is retained.');
  ports.active.write(marker);
  ports.fence();
  requireCondition(digest(ports, ports.state) === checkpoint.frontendBeforeSha256 || checkpoint.frontendAfterSha256 && digest(ports, ports.state) === checkpoint.frontendAfterSha256, 'The retained frontend checkpoint is neither the reviewed before nor after state.');
  const original = copy(ports.state);
  if (checkpoint.plans) for (const kind of KINDS) original.baselines[kind] = copy(checkpoint.plans[kind].baselineBefore);
  requireCondition(digest(ports, original) === checkpoint.frontendBeforeSha256, 'An unrelated frontend checkpoint field changed during maintenance.');
  for (const kind of UNCHANGED) requireCondition(digest(ports, ports.read(kind)) === checkpoint.unchangedSha256[kind], 'An untouched input Table changed during maintenance.');
  ports.assertConfirmation(checkpoint.setup);
  if (checkpoint.phase === 'prepared' || checkpoint.phase === 'rotating') {
    const existing = ports.setup.read();
    requireCondition(!existing || same(existing, checkpoint.setup), 'The setup receipt changed before trigger rotation.');
    ports.setup.write(undefined);
    checkpoint.phase = 'rotating'; save();
    for (const trigger of ports.listEdits()) {
      requireCondition(ports.bookIds.includes(trigger.bookId), 'An unbound native edit trigger appeared during maintenance.');
      if (checkpoint.retired[trigger.bookId] === trigger.id) ports.deleteEdit(trigger.id);
    }
    for (const bookId of ports.bookIds) {
      const actual = ports.listEdits().filter(t => t.bookId === bookId);
      const saved = checkpoint.replacements[bookId];
      requireCondition(actual.length <= 1 && (!saved || actual.length === 1 && actual[0].id === saved), 'Review unexpected replacement native edit triggers while paused.');
      // A successful create whose checkpoint write was interrupted is recognized by its sole exact native handler/source.
      const replacement = saved ?? actual[0]?.id ?? ports.createEdit(bookId);
      requireCondition(typeof replacement === 'string' && replacement.length > 0 && !Object.values(checkpoint.retired).includes(replacement), 'A retired native edit trigger cannot be reused.');
      checkpoint.replacements[bookId] = replacement; save();
    }
    checkpoint.plans = {} as Record<Kind, FrontendReorderPlan>;
    for (const kind of KINDS) {
      requireCondition(same(ports.read(kind), checkpoint.before[kind]), 'Cells changed before the reviewed physical reorder.');
      const table = inputSurfaceState(ports.state, kind);
      checkpoint.plans[kind] = planFrontendReorder({ kind, current: checkpoint.before[kind], baseline: table.baseline, drafts: table.drafts,
        journal: ports.journal, editFenceVerified: true, sha256: ports.sha256,
        barrier: { nativeInputPaused: true, publicationPaused: true, setupReceiptInvalidated: true,
          retiredEditTriggerIds: [checkpoint.retired[ports.mainId]], replacementEditTriggerId: checkpoint.replacements[ports.mainId] } });
    }
    const after = copy(ports.state);
    for (const kind of KINDS) after.baselines[kind] = copy(checkpoint.plans[kind].baselineAfter);
    checkpoint.frontendAfterSha256 = digest(ports, after); checkpoint.phase = 'planned'; save();
  }
  requireCondition(checkpoint.plans && checkpoint.frontendAfterSha256, 'The retained row plans are incomplete.');
  const edits = ports.listEdits();
  requireCondition(edits.length === ports.bookIds.length && new Set(edits.map(t => t.id)).size === edits.length
    && ports.bookIds.every(bookId => edits.filter(t => t.bookId === bookId && t.id === checkpoint.replacements[bookId]).length === 1)
    && Object.values(checkpoint.replacements).every(id => !Object.values(checkpoint.retired).includes(id)), 'Replacement native edit triggers changed during maintenance.');
  const replacementReceipt = { ...copy(checkpoint.setup), ids: { ...checkpoint.setup.ids, ...checkpoint.replacements } };
  requireCondition(ports.setup.read() === undefined || ['checkpointed', 'complete'].includes(checkpoint.phase) && same(ports.setup.read(), replacementReceipt), 'An unexpected native setup receipt appeared before completion.');
  if (ports.setup.read() !== undefined) ports.setup.write(undefined);
  ports.assertPaused();
  if (checkpoint.phase === 'planned' || checkpoint.phase === 'write-pending') {
    requireCondition(ports.setup.read() === undefined, 'Native setup must remain invalid while moving physical rows.');
    const current = Object.fromEntries(KINDS.map(kind => [kind, ports.read(kind)])) as Record<Kind, FrontendTableRead>;
    const before = KINDS.every(kind => same(current[kind], checkpoint.plans![kind].before));
    const after = KINDS.every(kind => same(current[kind], checkpoint.plans![kind].expectedAfter));
    requireCondition(before || after, 'Neither complete before nor complete after rows were observed; retain the fence for review.');
    if (!after) {
      checkpoint.phase = 'write-pending'; save();
      ports.writeRows(nativeReorderRequests(KINDS.map(kind => checkpoint.plans![kind])));
    }
  }
  ports.fence();
  const next = copy(original);
  for (const kind of KINDS) {
    const plan = checkpoint.plans[kind];
    next.baselines[kind] = verifyFrontendReorderReadback({ plan, current: ports.read(kind), baseline: original.baselines[kind],
      drafts: inputSurfaceState(original, kind).drafts, journal: ports.journal, editFenceVerified: true,
      barrier: { nativeInputPaused: true, publicationPaused: true, setupReceiptInvalidated: true,
        retiredEditTriggerIds: [checkpoint.retired[ports.mainId]], replacementEditTriggerId: checkpoint.replacements[ports.mainId] }, sha256: ports.sha256 });
  }
  for (const kind of UNCHANGED) requireCondition(digest(ports, ports.read(kind)) === checkpoint.unchangedSha256[kind], 'An untouched input Table changed during the row move.');
  requireCondition(digest(ports, next) === checkpoint.frontendAfterSha256, 'The planned slot-only checkpoint differs.');
  checkpoint.phase = 'cells-verified'; save();
  if (!same(ports.state, next)) ports.saveState(next);
  ports.fence(); ports.assertPaused(); ports.assertConfirmation(checkpoint.setup);
  checkpoint.phase = 'checkpointed'; save();
  ports.setup.write(replacementReceipt);
  requireCondition(same(ports.setup.read(), replacementReceipt), 'The replacement native setup receipt did not persist.');
  checkpoint.phase = 'complete'; save(); ports.active.write(null);
  return { status: 'reordered-paused', rows: KINDS.reduce((total, kind) => total + checkpoint.plans![kind].sourceRowIndices.filter((source, target) => source !== target).length, 0) };
}
