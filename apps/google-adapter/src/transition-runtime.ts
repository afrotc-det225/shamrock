/** Private archive consumer. Frozen page capture precedes provider writes; ambiguous work remains resumable. */
import { AdapterError } from './index.js';
import type { ScriptLockPort } from './apps-script.js';
import { callMaintenance, type MaintenanceApi } from './notification-runtime.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import type { FrontendDataPage } from '../../../packages/domain/src/frontend-transport.js';
import { assembleTransitionSnapshot, TRANSITION_SNAPSHOT_PAGE_VERSION, type TransitionSnapshotDescriptor } from '../../../packages/domain/src/transition-transport.js';
export const TRANSITION_ARCHIVE_LIMITS = { pagesPerInvocation: 4, pageBytes: 128000, transportBytes: 5 * 1024 * 1024, snapshotBytes: 6 * 1024 * 1024, checkpointBytes: 8 * 1024 * 1024 } as const;
interface ArchiveIdentity { transitionId: string; asOfDate: string; planHash: string; claimToken: string; leaseExpiresAt: string }
export interface TransitionArchiveClaim extends ArchiveIdentity { snapshotHash: string; snapshot: FrontendSnapshot; descriptorHash?: string }
interface TransitionArchiveCapture extends ArchiveIdentity { descriptorHash: string; descriptor: TransitionSnapshotDescriptor; pages: FrontendDataPage[] }
export interface TransitionArchiveProof { snapshotHash: string; descriptorHash?: string; archiveBinding: string; protected: true; private: true; valuesOnly: true }
export interface TransitionArchiveCheckpoint {
    claim?: TransitionArchiveClaim;
    capture?: TransitionArchiveCapture;
    continuation?: string;
    writeComplete?: boolean;
    verificationContinuation?: string;
    serverComplete?: boolean;
}
export interface TransitionArchivePorts {
    api: MaintenanceApi; lock: ScriptLockPort; enabled(): boolean; assertPrivateState(): void;
    state: { load(): TransitionArchiveCheckpoint | undefined; save(value: TransitionArchiveCheckpoint): void; clear(): void };
    /** Resolve one stable transition before creating output. Never overwrite a different immutable hash. */
    archive: {
        write(claim: TransitionArchiveClaim, continuation?: string): { done: false; continuation: string } | { done: true };
        verify(claim: TransitionArchiveClaim): TransitionArchiveProof;
        verifyStep?(claim: TransitionArchiveClaim, continuation?: string): { done: false; continuation: string } | { done: true; proof: TransitionArchiveProof };
    };
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const bytes = (text: string) => encodeURIComponent(text).replace(/%[A-F0-9]{2}/g, 'x').length;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function identity(raw: Record<string, unknown>, transitionId: string): ArchiveIdentity {
    if (raw.transitionId !== transitionId || !identifier(raw.claimToken) || !digest(raw.planHash)
        || typeof raw.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.asOfDate)
        || typeof raw.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(raw.leaseExpiresAt))) fail('transition_claim', 'The immutable archive claim is invalid.');
    return { transitionId, asOfDate: raw.asOfDate, planHash: raw.planHash, claimToken: raw.claimToken, leaseExpiresAt: raw.leaseExpiresAt };
}
function verifyDescriptor(capture: TransitionArchiveCapture, api: MaintenanceApi): void {
    const d = capture.descriptor;
    if (!digest(capture.descriptorHash) || d?.contractVersion !== TRANSITION_SNAPSHOT_PAGE_VERSION || api.signer.sha256(JSON.stringify(d)) !== capture.descriptorHash
        || d.manifest?.environment !== api.config.environment || d.manifest?.generation !== api.config.generation
        || !Array.isArray(d.pages) || d.pages.length > 512 || !Array.isArray(capture.pages) || capture.pages.length > d.pages.length
        || d.pages.some((p, i) => p.sequence !== i || !digest(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > TRANSITION_ARCHIVE_LIMITS.pageBytes)
        || d.pages.reduce((n, p) => n + p.bytes, 0) > TRANSITION_ARCHIVE_LIMITS.transportBytes) fail('transition_snapshot', 'The frozen archive descriptor failed verification.');
    capture.pages.forEach((page, i) => verifyPage(capture, page, i, api));
}
function verifyPage(capture: TransitionArchiveCapture, page: FrontendDataPage, sequence: number, api: MaintenanceApi): void {
    const text = JSON.stringify(page), expected = capture.descriptor.pages[sequence];
    if (!expected || !page || page.section !== expected.section || page.offset !== expected.offset || bytes(text) !== expected.bytes || api.signer.sha256(text) !== expected.sha256)
        fail('transition_snapshot', 'A frozen archive page is missing, reordered or changed.');
}
function verifyClaim(claim: TransitionArchiveClaim, api: MaintenanceApi): void {
    const text = JSON.stringify(claim.snapshot);
    if (!digest(claim.snapshotHash) || claim.descriptorHash !== undefined && !digest(claim.descriptorHash)
        || !text || bytes(text) > TRANSITION_ARCHIVE_LIMITS.snapshotBytes || api.signer.sha256(text) !== claim.snapshotHash)
        fail('transition_snapshot', 'The retained assembled snapshot failed verification.');
}
/** A reviewed prepare invocation advances one durable Worker step; repeating the same envelope resumes it. */
export function continueTransitionPreparation(api: MaintenanceApi, command: Record<string, unknown>): Record<string, unknown> {
    const begin = callMaintenance(api, '/v1/admin/transitions/prepare/begin', command);
    if (begin.committed === true && begin.receipt && typeof begin.receipt === 'object') return begin.receipt as Record<string, unknown>;
    const progress = begin.preparation as Record<string, unknown>;
    if (progress?.commandId !== command.commandId || !['capturing', 'complete', 'consumed'].includes(String(progress.state)) || !Number.isSafeInteger(progress.sequence) || Number(progress.sequence) < 0)
        fail('transition_preparation', 'The preparation receipt does not match the reviewed command.');
    if (progress.state === 'complete' || progress.state === 'consumed') return callMaintenance(api, '/v1/admin/transitions/commands', command);
    const step = callMaintenance(api, '/v1/admin/transitions/prepare/step', { environment: api.config.environment, generation: api.config.generation,
        principalId: api.principalId, commandId: command.commandId, expectedSequence: progress.sequence });
    const next = step.preparation as Record<string, unknown>;
    if (next?.commandId !== command.commandId || !['capturing', 'complete'].includes(String(next.state)) || !Number.isSafeInteger(next.sequence) || Number(next.sequence) < Number(progress.sequence))
        fail('transition_preparation', 'The preparation continuation changed or moved backwards.');
    return next.state === 'complete' ? callMaintenance(api, '/v1/admin/transitions/commands', command) : { status: 'preparing', preparation: next };
}
export function continueTransitionArchive(ports: TransitionArchivePorts, transitionId: string): { state: string } {
    if (!ports.enabled()) return { state: 'paused' };
    if (!ports.lock.tryLock(1000)) return { state: 'busy' };
    try {
        ports.assertPrivateState();
        let retained = ports.state.load();
        const prior = retained?.claim ?? retained?.capture;
        if (retained && (!prior || Boolean(retained.claim) === Boolean(retained.capture) || prior.transitionId !== transitionId))
            fail('transition_claim', 'Finish the retained matching archive before another transition.');
        if (retained?.claim) verifyClaim(retained.claim, ports.api);
        if (retained?.capture) verifyDescriptor(retained.capture, ports.api);
        const base = { environment: ports.api.config.environment, generation: ports.api.config.generation, principalId: ports.api.principalId, workerId: ports.api.workerId, transitionId };
        if (!prior || Date.parse(prior.leaseExpiresAt) <= ports.api.nowSeconds() * 1000 + 30000) {
            if (retained?.claim) {
                const status = callMaintenance(ports.api, '/v1/admin/transitions/status', { environment: base.environment, generation: base.generation, principalId: base.principalId, transitionId });
                const archive = status.archive as { state?: string } | undefined;
                if (archive?.state === 'done' && status.snapshotHash === retained.claim.snapshotHash
                    && (retained.claim.descriptorHash === undefined || status.descriptorHash === retained.claim.descriptorHash)) {
                    retained = { ...retained, writeComplete: true, serverComplete: true }; ports.state.save(retained);
                }
            }
            if (!retained?.serverComplete) {
                const raw = callMaintenance(ports.api, '/v1/admin/transitions/archive/claim', base), common = identity(raw, transitionId);
                if (raw.snapshotTransport !== undefined) {
                    if (raw.snapshotHash !== null && !digest(raw.snapshotHash)) fail('transition_snapshot', 'The assembled snapshot receipt is invalid.');
                    const capture: TransitionArchiveCapture = { ...common, descriptorHash: String(raw.descriptorHash), descriptor: raw.snapshotTransport as TransitionSnapshotDescriptor, pages: retained?.capture?.pages ?? [] };
                    verifyDescriptor(capture, ports.api);
                    if (prior && (prior.planHash !== common.planHash || prior.asOfDate !== common.asOfDate || prior.descriptorHash !== capture.descriptorHash)) fail('transition_snapshot', 'Archive content changed after preparation.');
                    if (retained?.claim) {
                        if (raw.snapshotHash !== null && raw.snapshotHash !== retained.claim.snapshotHash) fail('transition_snapshot', 'The assembled snapshot receipt changed.');
                        retained = { ...retained, claim: { ...retained.claim, ...common } };
                    } else retained = { capture };
                } else {
                    const claim: TransitionArchiveClaim = { ...common, snapshotHash: String(raw.snapshotHash), snapshot: raw.snapshot as FrontendSnapshot };
                    verifyClaim(claim, ports.api);
                    if (prior && (retained?.capture || retained?.claim?.snapshotHash !== claim.snapshotHash || prior.planHash !== claim.planHash)) fail('transition_snapshot', 'Archive content changed after preparation.');
                    retained = { ...retained, claim };
                }
                ports.state.save(retained);
            }
        }
        if (!retained) fail('transition_claim', 'The archive claim was not retained.');
        if (retained.capture) {
            const capture = retained.capture;
            for (let count = 0; count < TRANSITION_ARCHIVE_LIMITS.pagesPerInvocation && capture.pages.length < capture.descriptor.pages.length; count++) {
                if (Date.parse(capture.leaseExpiresAt) <= ports.api.nowSeconds() * 1000 + 30000) return { state: 'capturing' };
                const sequence = capture.pages.length, result = callMaintenance(ports.api, '/v1/admin/transitions/archive/page', { ...base, claimToken: capture.claimToken, sequence });
                if (result.sequence !== sequence || result.descriptorHash !== capture.descriptorHash || result.sha256 !== capture.descriptor.pages[sequence].sha256) fail('transition_snapshot', 'The frozen archive page receipt changed.');
                const page = result.page as FrontendDataPage; verifyPage(capture, page, sequence, ports.api); capture.pages.push(page); ports.state.save(retained);
            }
            if (capture.pages.length < capture.descriptor.pages.length) return { state: 'capturing' };
            const assembled = assembleTransitionSnapshot(capture.descriptor, capture.pages, capture.descriptorHash, ports.api.signer.sha256);
            const { descriptor, pages, ...common } = capture;
            retained = { claim: { ...common, snapshot: assembled.snapshot, snapshotHash: assembled.assembledSnapshotHash } };
            verifyClaim(retained.claim!, ports.api); ports.state.save(retained);
        }
        const claim = retained.claim!;
        if (!retained.writeComplete) {
            const result = ports.archive.write(claim, retained.continuation);
            if (!result.done) {
                if (!result.continuation || result.continuation.length > 2000) fail('transition_continuation', 'Archive continuation is invalid.');
                ports.state.save({ ...retained, continuation: result.continuation }); return { state: 'continuing' };
            }
            retained = { ...retained, writeComplete: true }; ports.state.save(retained);
        }
        const verified = ports.archive.verifyStep ? ports.archive.verifyStep(claim, retained.verificationContinuation) : { done: true as const, proof: ports.archive.verify(claim) };
        if (!verified.done) {
            if (!verified.continuation || verified.continuation.length > 2000) fail('transition_continuation', 'Archive verification continuation is invalid.');
            ports.state.save({ ...retained, verificationContinuation: verified.continuation }); return { state: 'verifying' };
        }
        const proof = verified.proof;
        if (proof.snapshotHash !== claim.snapshotHash || proof.descriptorHash !== claim.descriptorHash || proof.protected !== true || proof.private !== true || proof.valuesOnly !== true)
            fail('transition_archive', 'A private, protected, values-only archive must pass read-back.');
        if (!retained.serverComplete) {
            const receipt = callMaintenance(ports.api, '/v1/admin/transitions/archive/ack', { ...base, claimToken: claim.claimToken, proof });
            if (receipt.status !== 'done') fail('transition_receipt', 'Archive completion was not confirmed.');
        }
        ports.state.clear(); return { state: 'ready-for-reviewed-acceptance' };
    } finally { ports.lock.releaseLock(); }
}
