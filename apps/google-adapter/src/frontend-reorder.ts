/** Explicit physical reordering is separate from ordinary keyed publication. No provider IO. */
import { AdapterError } from './index.js';
import { compareCadetsForDisplay, compareLeadershipForDisplay } from '../../../packages/domain/src/cadet-display-order.js';
import { bindImmutableInputSlots, inputCanonical } from './frontend-input.js';
import type { FrontendDraft, FrontendPublicationBaseline, FrontendPublicationRow, FrontendTableRead } from './frontend-publication.js';
import type { FrontendInputJournal } from './frontend-input-journal.js';

export interface FrontendReorderBarrier {
  /** Host must verify all three under the shared native lock, retaining the human edit fence. */
  nativeInputPaused: boolean;
  publicationPaused: boolean;
  setupReceiptInvalidated: boolean;
  /** All prior edit trigger IDs for this workbook; every one must have been removed. */
  retiredEditTriggerIds: string[];
  /** Newly installed sole edit trigger for this workbook, not yet admitted by a setup receipt. */
  replacementEditTriggerId: string;
}
export interface FrontendReorderPlan {
  kind: 'directory' | 'attendance' | 'leadership';
  before: FrontendTableRead;
  expectedAfter: FrontendTableRead;
  /** Zero-based body row permutation. Move entire cells, including chips and metadata. */
  sourceRowIndices: number[];
  baselineBefore: FrontendPublicationBaseline;
  baselineAfter: FrontendPublicationBaseline;
  barrier: FrontendReorderBarrier;
  journalSha256: string;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => inputCanonical(a) === inputCanonical(b);
function fail(message: string): never { throw new AdapterError('frontend_reorder', message); }
function checkBarrier(barrier: FrontendReorderBarrier): void {
  if (barrier.nativeInputPaused !== true || barrier.publicationPaused !== true || barrier.setupReceiptInvalidated !== true
    || !barrier.retiredEditTriggerIds.length || new Set(barrier.retiredEditTriggerIds).size !== barrier.retiredEditTriggerIds.length
    || barrier.retiredEditTriggerIds.some(id => typeof id !== 'string' || !id.trim())
    || typeof barrier.replacementEditTriggerId !== 'string' || !barrier.replacementEditTriggerId.trim()
    || barrier.retiredEditTriggerIds.includes(barrier.replacementEditTriggerId)) fail('Rotate every prior edit trigger while paused before reassigning physical rows.');
}
function settled(journal: FrontendInputJournal, generation: number): boolean {
  return journal.version === 1 && journal.environment === 'staging' && journal.generation === generation
    && Object.keys(journal.held ?? {}).length === 0 && Object.values(journal.entries).every(entry =>
      entry.superseded === true && entry.supersededApplied === true
      || entry.commands.length > 0 && entry.commands.every(command => command.status === 'committed' && command.applied === true));
}
function compareRows(kind: FrontendReorderPlan['kind'], a: FrontendPublicationRow, b: FrontendPublicationRow): number {
  if (Boolean(a.retired) !== Boolean(b.retired)) return a.retired ? 1 : -1;
  const name = (row: FrontendPublicationRow) => ({ firstName: String(row.values.first_name ?? ''), lastName: String(row.values.last_name ?? '') });
  return kind === 'leadership'
    ? compareLeadershipForDisplay({ ...name(a), contactId: a.key, rank: String(a.values.rank ?? ''), role: String(a.values.role ?? '') }, { ...name(b), contactId: b.key, rank: String(b.values.rank ?? ''), role: String(b.values.role ?? '') })
    : compareCadetsForDisplay({ ...name(a), personId: a.key, asYear: String(a.values.as_year ?? '') }, { ...name(b), personId: b.key, asYear: String(b.values.as_year ?? '') });
}
/**
 * Host-only maintenance primitive. It does not rotate triggers, write Sheets or save checkpoints.
 * Host must retain the barrier/fence throughout write, readback, checkpoint and exact grant restoration.
 */
export function planFrontendReorder(input: {
  kind: FrontendReorderPlan['kind']; current: FrontendTableRead; baseline: FrontendPublicationBaseline;
  drafts: readonly FrontendDraft[]; journal: FrontendInputJournal; editFenceVerified: boolean; barrier: FrontendReorderBarrier; sha256(text: string): string;
}): FrontendReorderPlan {
  checkBarrier(input.barrier);
  const journalSha256 = input.sha256(inputCanonical(input.journal));
  if (!/^[a-f0-9]{64}$/.test(journalSha256)) fail('A complete private journal digest is required.');
  if (!input.editFenceVerified || input.drafts.length || !settled(input.journal, input.baseline.generation)) fail('Resolve all frozen drafts and uncertain input evidence before sorting.');
  if (!input.baseline.slots) fail('Explicit reordering requires an existing reviewed physical binding.');
  const baseline = bindImmutableInputSlots({ baseline: input.baseline, current: input.current, keyHeader: input.kind === 'leadership' ? 'contact_id' : 'person_id', editFenceVerified: true });
  const byKey = new Map(baseline.rows.map(row => [row.key, row]));
  const sourceRowIndices = baseline.slots!.keys.map((_, i) => i).sort((a, b) => {
    const left = baseline.slots!.keys[a], right = baseline.slots!.keys[b];
    if (left === null || right === null) return left === right ? a - b : left === null ? 1 : -1;
    return compareRows(input.kind, byKey.get(left)!, byKey.get(right)!);
  });
  const expectedAfter = { ...copy(input.current), rows: sourceRowIndices.map(i => copy(input.current.rows[i])) };
  const baselineAfter = { ...copy(baseline), slots: { headers: [...baseline.slots!.headers], keys: sourceRowIndices.map(i => baseline.slots!.keys[i]) } };
  // Existing row objects/versions/bindings remain keyed and unchanged, including retired records.
  return { kind: input.kind, before: copy(input.current), expectedAfter, sourceRowIndices, baselineBefore: copy(input.baseline), baselineAfter, barrier: copy(input.barrier), journalSha256 };
}
/** No checkpoint may advance after a stale review, ambiguous write, or incomplete cell permutation. */
export function verifyFrontendReorderReadback(input: {
  plan: FrontendReorderPlan; current: FrontendTableRead; baseline: FrontendPublicationBaseline;
  drafts: readonly FrontendDraft[]; journal: FrontendInputJournal; editFenceVerified: boolean; barrier: FrontendReorderBarrier; sha256(text: string): string;
}): FrontendPublicationBaseline {
  const reviewed = planFrontendReorder({ ...input, kind: input.plan.kind, current: input.plan.before });
  if (!same(reviewed, input.plan) || !same(input.current, input.plan.expectedAfter)) fail('Sorted cells or reviewed checkpoints differ; keep native input paused and editing fenced.');
  return copy(input.plan.baselineAfter);
}
