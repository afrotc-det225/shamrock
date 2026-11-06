/** Private archive consumer. A continued or ambiguous provider operation is never acknowledged. */
import { AdapterError } from './index.js';
import type { ScriptLockPort } from './apps-script.js';
import { callMaintenance, type MaintenanceApi } from './notification-runtime.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
export interface TransitionArchiveClaim {
    transitionId: string;
    snapshotHash: string;
    planHash: string;
    claimToken: string;
    leaseExpiresAt: string;
    snapshot: FrontendSnapshot;
}
export interface TransitionArchiveProof {
    snapshotHash: string;
    archiveBinding: string;
    protected: true;
    private: true;
    valuesOnly: true;
}
export interface TransitionArchivePorts {
    api: MaintenanceApi;
    lock: ScriptLockPort;
    enabled(): boolean;
    assertPrivateState(): void;
    state: {
        load(): {
            claim: TransitionArchiveClaim;
            continuation?: string;
        } | undefined;
        save(value: {
            claim: TransitionArchiveClaim;
            continuation?: string;
        }): void;
        clear(): void;
    };
    /** Must resolve a stable transition ID before creating a new archive. Never overwrite a different hash.
     * Retrying a verified chunk is idempotent; provider responses, layout and read-back stay private. */
    archive: {
        write(claim: TransitionArchiveClaim, continuation?: string): {
            done: false;
            continuation: string;
        } | {
            done: true;
        };
        verify(claim: TransitionArchiveClaim): TransitionArchiveProof;
    };
}
export function continueTransitionArchive(ports: TransitionArchivePorts, transitionId: string): {
    state: string;
} {
    if (!ports.enabled())
        return { state: 'paused' };
    if (!ports.lock.tryLock(1000))
        return { state: 'busy' };
    try {
        ports.assertPrivateState();
        let retained = ports.state.load();
        if (retained && retained.claim.transitionId !== transitionId)
            throw new AdapterError('transition_claim', 'Finish the retained archive before another transition.');
        const identity = { environment: ports.api.config.environment, generation: ports.api.config.generation, principalId: ports.api.principalId, workerId: ports.api.workerId, transitionId };
        if (!retained || Date.parse(retained.claim.leaseExpiresAt) <= ports.api.nowSeconds() * 1000 + 30000) {
            if (retained) {
                const status = callMaintenance(ports.api, '/v1/admin/transitions/status', { environment: ports.api.config.environment, generation: ports.api.config.generation, principalId: ports.api.principalId, transitionId });
                const archive = status.archive as {
                    state?: string;
                } | undefined;
                if (archive?.state === 'done' && status.snapshotHash === retained.claim.snapshotHash) {
                    const proof = ports.archive.verify(retained.claim);
                    if (proof.snapshotHash !== retained.claim.snapshotHash || !proof.protected || !proof.private || !proof.valuesOnly)
                        throw new AdapterError('transition_archive', 'The retained archive failed verification.');
                    ports.state.clear();
                    return { state: 'ready-for-reviewed-acceptance' };
                }
            }
            const raw = callMaintenance(ports.api, '/v1/admin/transitions/archive/claim', identity);
            const claim: TransitionArchiveClaim = { transitionId: String(raw.transitionId), snapshotHash: String(raw.snapshotHash), planHash: String(raw.planHash),
                claimToken: String(raw.claimToken), leaseExpiresAt: String(raw.leaseExpiresAt), snapshot: raw.snapshot as FrontendSnapshot };
            if (claim.transitionId !== transitionId || !/^[a-f0-9]{64}$/.test(claim.snapshotHash) || ports.api.signer.sha256(JSON.stringify(claim.snapshot)) !== claim.snapshotHash)
                throw new AdapterError('transition_snapshot', 'The immutable archive snapshot failed verification.');
            if (retained && retained.claim.snapshotHash !== claim.snapshotHash)
                throw new AdapterError('transition_snapshot', 'Archive content changed after preparation.');
            retained = { claim, ...(retained?.continuation ? { continuation: retained.continuation } : {}) };
            ports.state.save(retained);
        }
        const result = ports.archive.write(retained.claim, retained.continuation);
        if (!result.done) {
            if (!result.continuation || result.continuation.length > 2000)
                throw new AdapterError('transition_continuation', 'Archive continuation is invalid.');
            ports.state.save({ claim: retained.claim, continuation: result.continuation });
            return { state: 'continuing' };
        }
        const proof = ports.archive.verify(retained.claim);
        if (proof.snapshotHash !== retained.claim.snapshotHash || proof.protected !== true || proof.private !== true || proof.valuesOnly !== true)
            throw new AdapterError('transition_archive', 'A private, protected, values-only archive must pass read-back.');
        const receipt = callMaintenance(ports.api, '/v1/admin/transitions/archive/ack', { ...identity, claimToken: retained.claim.claimToken, proof });
        if (receipt.status !== 'done')
            throw new AdapterError('transition_receipt', 'Archive completion was not confirmed.');
        ports.state.clear();
        return { state: 'ready-for-reviewed-acceptance' };
    }
    finally {
        ports.lock.releaseLock();
    }
}
