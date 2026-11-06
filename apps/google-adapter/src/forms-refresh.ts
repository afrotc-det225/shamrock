/** Resumable all-Form publication. A private checkpoint precedes every native mutation. */
import { AdapterError, type AdapterConfig, type Signer } from './index.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { formReadFingerprint, formsCanonical, planNativeFormPublication, retainFormEdition, verifyNativeFormPlan, verifyFormBeforeContinuations,
  type FormEdition, type ManagedFormBinding, type NativeFormPlan, type NativeFormRead } from './forms-publication.js';

export interface FormsClaim { effectId: string; claimToken: string; kind: 'forms.refresh'; leaseExpiresAt: string }
export interface FormsState {
  version: 1; environment: 'local' | 'staging'; generation: number;
  editions: Record<string, FormEdition>; current: Record<string, string>;
  published?: Record<string, string>;
  canAccept?: Record<string, boolean>;
  claim?: FormsClaim;
  pending?: { plans: NativeFormPlan[]; previouslyAccepting: Record<string, boolean> };
  completed?: { claim: FormsClaim; reopen: Record<string, boolean> };
}
export interface FormsRefreshPorts {
  config: AdapterConfig; enabled(): boolean; intakeEnabled(): boolean; now(): number;
  signer: Signer; bindings: ManagedFormBinding[];
  lock: { tryLock(milliseconds: number): boolean; releaseLock(): void };
  assertIsolation(): void;
  state: { load(): FormsState; save(state: FormsState): void };
  effects: { claim(): FormsClaim | null; project(claim: FormsClaim): { effect: { effectId: string; kind: string }; snapshot: FrontendSnapshot }; ack(claim: FormsClaim): void };
  forms: { read(binding: ManagedFormBinding): NativeFormRead; setAccepting(binding: ManagedFormBinding, enabled: boolean): void;
    write(binding: ManagedFormBinding, requests: Record<string, unknown>[], requiredRevisionId: string): void;
    setSubmitContinuation?(binding: ManagedFormBinding, sectionId: string): void };
  pause(): void;
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function consumeFormsRefresh(io: FormsRefreshPorts): { status: 'disabled' | 'idle' | 'published'; forms?: number } {
  if (!io.enabled()) return { status: 'disabled' };
  if (!io.lock.tryLock(100)) fail('forms_busy', 'Another Form operation is in progress.');
  let touched = false;
  try {
    if (!io.enabled()) return { status: 'disabled' };
    io.assertIsolation();
    const bindings = io.bindings;
    if (bindings.length !== 3 || new Set(bindings.map(b => b.key)).size !== 3 || new Set(bindings.map(b => b.formId)).size !== 3) fail('forms_binding', 'Three distinct reviewed Forms are required.');
    let state = io.state.load();
    if (state.version !== 1 || state.environment !== io.config.environment || state.generation !== io.config.generation || !state.editions || !state.current) fail('forms_state', 'The private Form state belongs to another generation.');
    touched = Boolean(state.pending || state.completed);
    const save = () => { if (formsCanonical(state).length > 5_000_000) fail('forms_capacity', 'Private Form history needs reviewed archival.'); io.state.save(copy(state)); };
    if (!state.claim) { const claim = io.effects.claim(); if (!claim) return { status: 'idle' }; state.claim = claim; save(); }
    const claim = state.claim;
    const currentClaim = () => { if (claim.kind !== 'forms.refresh' || !claim.effectId || !claim.claimToken || !Number.isFinite(Date.parse(claim.leaseExpiresAt)) || Date.parse(claim.leaseExpiresAt) <= io.now()) fail('forms_lease', 'The retained Form lease requires operator reconciliation.'); };
    currentClaim();
    const bound = (key: string) => bindings.find(b => b.key === key) ?? fail('forms_binding', 'A retained Form binding is unavailable.');
    if (!state.completed) {
      if (!state.pending) {
        const projected = io.effects.project(claim);
        if (projected.effect.effectId !== claim.effectId || projected.effect.kind !== 'forms.refresh' || projected.snapshot.environment !== io.config.environment || projected.snapshot.generation !== io.config.generation) fail('forms_snapshot', 'Form publication requires one coherent matching snapshot.');
        const reads = bindings.map(b => io.forms.read(b));
        const plans = bindings.map((binding, i) => planNativeFormPublication({ snapshot: projected.snapshot, binding, current: reads[i], signer: io.signer, previousEdition: state.editions[state.current[binding.key]] }));
        // Catalog history is frozen alongside the plans before a respondent can see a new token.
        for (const plan of plans) state.editions = retainFormEdition(state.editions, plan.edition);
        state.pending = { plans, previouslyAccepting: Object.fromEntries(bindings.map((b, i) => [b.key, reads[i].acceptingResponses])) }; save();
      }
      const pending = state.pending;
      if (pending.plans.length !== 3 || pending.plans.some(p => formsCanonical(p.binding) !== formsCanonical(bound(p.binding.key)))) fail('forms_state', 'Retained publication bindings changed.');
      for (const b of bindings) { touched = true; io.forms.setAccepting(b, false); if (io.forms.read(b).acceptingResponses) fail('forms_fence', 'A Form did not close for safe publication.'); }
      for (const plan of pending.plans) {
        currentClaim(); const read = io.forms.read(plan.binding);
        if (verifyNativeFormPlan(plan, read)) continue; // An ambiguous successful write is not repeated.
        if (!verifyFormBeforeContinuations(plan, read)) {
          if (formReadFingerprint(read) !== plan.expectedBefore) fail('forms_changed', 'A Form changed outside the retained publication plan.');
          if (plan.requests.length) io.forms.write(plan.binding, plan.requests, read.revisionId);
        }
        let after = io.forms.read(plan.binding);
        if (plan.continuations?.length && !verifyNativeFormPlan(plan, after)) {
          if (!verifyFormBeforeContinuations(plan, after) || !io.forms.setSubmitContinuation) fail('forms_readback', 'Additive Form content or continuation provider did not verify.');
          for (const sectionId of plan.continuations) {
            currentClaim();
            if (after.pageBreakNavigation?.[sectionId]?.action !== 'SUBMIT') io.forms.setSubmitContinuation(plan.binding, sectionId);
            after = io.forms.read(plan.binding);
            if (!verifyFormBeforeContinuations(plan, after)) fail('forms_readback', 'A Form changed while finishing new section navigation.');
          }
        }
        if (!verifyNativeFormPlan(plan, after)) fail('forms_readback', 'Native Form choices did not verify; intake remains closed.');
      }
      currentClaim();
      for (const plan of pending.plans) if (!verifyNativeFormPlan(plan, io.forms.read(plan.binding))) fail('forms_readback', 'One Form changed before the shared checkpoint.');
      state.published ??= {};
      state.canAccept ??= {};
      for (const plan of pending.plans) { state.current[plan.binding.key] = plan.edition.editionId; state.published[plan.binding.key] = formReadFingerprint(plan.expectedAfter); state.canAccept[plan.binding.key] = plan.canAccept; }
      state.completed = { claim: copy(claim), reopen: Object.fromEntries(pending.plans.map(p => [p.binding.key, pending.previouslyAccepting[p.binding.key] && p.canAccept])) };
      delete state.pending; save();
    }
    if (formsCanonical(state.completed.claim) !== formsCanonical(claim)) fail('forms_claim', 'The completed Form checkpoint does not match its lease.');
    currentClaim();
    for (const b of bindings) {
      if (state.published?.[b.key] !== formReadFingerprint(io.forms.read(b))) fail('forms_changed', 'A completed Form changed before reopening or acknowledgement.');
      const reopen = io.intakeEnabled() && state.completed.reopen[b.key] === true;
      io.forms.setAccepting(b, reopen);
      if (io.forms.read(b).acceptingResponses !== reopen) fail('forms_fence', 'The verified intake state could not be restored.');
    }
    io.effects.ack(claim); delete state.claim; delete state.completed; save();
    return { status: 'published', forms: bindings.length };
  } catch (error) {
    if (touched) for (const binding of io.bindings) { try { io.forms.setAccepting(binding, false); } catch { /* retain durable plan and report original failure */ } }
    io.pause(); throw error;
  } finally { io.lock.releaseLock(); }
}
