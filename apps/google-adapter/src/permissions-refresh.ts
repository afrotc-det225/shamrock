/** Resumable permission publication. Provider IO and durable storage are injected and must be owner-private. */
import { AdapterError } from './index.js';
import type { RolePermissionPolicy } from '../../../packages/domain/src/permissions.js';
import type { FrontendProtectionAccess } from './frontend-protections.js';
export const PERMISSION_FENCE_PROPERTY = 'SHAMROCK_V3_PERMISSION_FENCED';
export interface PermissionClaim {
    jobId: string;
    version: number;
    claimToken: string;
    leaseExpiresAt: string;
}
export interface AppliedPermissionPolicy {
    version: number;
    policyHash: string;
    policy: RolePermissionPolicy;
}
export interface PermissionRefreshState {
    version: 1;
    pending?: {
        claim: PermissionClaim;
        project?: AppliedPermissionPolicy;
    };
    applied?: AppliedPermissionPolicy;
    completed?: {
        jobId: string;
        claimToken: string;
    };
}
export interface PermissionRefreshPorts {
    enabled(): boolean;
    lock: {
        tryLock(milliseconds: number): boolean;
        releaseLock(): void;
    };
    /** Local Script Properties marker: reading this must not load Drive. */
    claimStore: {
        load(): PermissionClaim | undefined;
        save(claim: PermissionClaim): void;
        clear(claim: PermissionClaim): void;
    };
    state: {
        load(): PermissionRefreshState;
        save(state: PermissionRefreshState): void;
    };
    /** Signed Worker request; these routes require the separately provisioned publisher principal. */
    request(action: 'claim' | 'project' | 'ack' | 'status', claim?: PermissionClaim): any;
    assertIsolation(): void;
    /** Set and read back a durable host-wide fence BEFORE changing protections. Every other publisher/input checks it. */
    setFence(): void;
    assertFenceMarker(): void;
    /** Strict owner/runtime-only protections on both books, verified from fresh metadata. */
    fenceProvider(): void;
    assertProviderFenced(): void;
    /** Remove all unapproved named/broad memberships first; verify fresh paginated provider metadata. */
    revokeMemberships(policy: RolePermissionPolicy): boolean;
    assertRevocations(policy: RolePermissionPolicy): void;
    addMemberships(policy: RolePermissionPolicy): boolean;
    assertMemberships(policy: RolePermissionPolicy): void;
    /** Install manager-narrowed native field policy, preserving keys/outputs/empty rows. */
    applyProtections(policy: RolePermissionPolicy): void;
    assertProtections(policy: RolePermissionPolicy): void;
    /** Remove marker only after current revision, exact membership/protection readback and durable applied policy. */
    clearFence(applied: AppliedPermissionPolicy): void;
    pause(): void;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string): never => { throw new AdapterError('permission_refresh', message); };
function validateClaim(value: any): PermissionClaim {
    if (!value || typeof value !== 'object' || !['jobId', 'claimToken'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[k])) || !Number.isSafeInteger(value.version) || value.version < 1 || !Number.isFinite(Date.parse(value.leaseExpiresAt)))
        fail('The permission claim is invalid.');
    return value;
}
/** One idle Worker request and no Google/state IO. Any ambiguity retains the fence and checkpoint. */
export function runPermissionRefresh(p: PermissionRefreshPorts): 'paused' | 'busy' | 'idle' | 'pending' | 'superseded' | 'complete' {
    if (!p.enabled())
        return 'paused';
    if (!p.lock.tryLock(10000))
        return 'busy';
    let fenced = false;
    try {
        let claim = p.claimStore.load();
        if (!claim) {
            const response = p.request('claim');
            if (!response?.job)
                return 'idle';
            claim = validateClaim(response.job);
            p.claimStore.save(claim);
        }
        claim = validateClaim(claim);
        p.assertIsolation();
        p.setFence();
        p.assertFenceMarker();
        fenced = true;
        p.fenceProvider();
        p.assertProviderFenced();
        const state = p.state.load();
        if (state.version !== 1)
            fail('The permission checkpoint is invalid.');
        if (state.pending && !same(state.pending.claim, claim))
            fail('Another permission checkpoint requires reconciliation.');
        // A lost ACK response is reconciled against its exact retained claim; no new lease is invented.
        if (state.completed?.jobId === claim.jobId && state.completed.claimToken === claim.claimToken) {
            const ack = p.request('ack', claim);
            if (!ack?.acknowledged)
                fail('The completed permission receipt could not be confirmed.');
            if (ack.current && state.applied?.version === claim.version) {
                p.assertMemberships(state.applied.policy);
                p.applyProtections(state.applied.policy);
                p.assertProtections(state.applied.policy);
                const status = p.request('status');
                if (!status?.applied || status.version !== state.applied.version || status.policyHash !== state.applied.policyHash)
                    fail('A newer policy must be applied before reopening.');
                p.clearFence(state.applied);
                fenced = false;
            }
            p.claimStore.clear(claim);
            return ack.current ? 'complete' : 'superseded';
        }
        const projection = p.request('project', claim);
        if (!projection || projection.version !== claim.version || typeof projection.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(projection.policyHash))
            fail('The frozen permission projection is invalid.');
        if (!projection.current) {
            p.request('ack', claim);
            delete state.pending;
            state.completed = { jobId: claim.jobId, claimToken: claim.claimToken };
            p.state.save(state);
            p.claimStore.clear(claim);
            return 'superseded';
        }
        const applied: AppliedPermissionPolicy = { version: projection.version, policyHash: projection.policyHash, policy: projection.policy };
        if (state.pending?.project && !same(state.pending.project, applied))
            fail('A retained permission projection changed.');
        state.pending = { claim: copy(claim), project: copy(applied) };
        p.state.save(state);
        if (!p.revokeMemberships(applied.policy))
            return 'pending';
        p.assertRevocations(applied.policy);
        if (!p.addMemberships(applied.policy))
            return 'pending';
        p.assertMemberships(applied.policy);
        const current = p.request('project', claim);
        if (!current.current || current.policyHash !== applied.policyHash) {
            p.request('ack', claim);
            delete state.pending;
            state.completed = { jobId: claim.jobId, claimToken: claim.claimToken };
            p.state.save(state);
            p.claimStore.clear(claim);
            return 'superseded';
        }
        // Retain the authoritative identity/access map before opening any native business cells.
        state.applied = copy(applied);
        state.completed = { jobId: claim.jobId, claimToken: claim.claimToken };
        delete state.pending;
        p.state.save(state);
        const ack = p.request('ack', claim);
        if (!ack?.acknowledged)
            fail('The permission receipt could not be confirmed.');
        if (!ack.current) {
            p.claimStore.clear(claim);
            return 'superseded';
        }
        p.applyProtections(applied.policy);
        p.assertProtections(applied.policy);
        const status = p.request('status');
        if (!status?.applied || status.version !== applied.version || status.policyHash !== applied.policyHash)
            fail('A newer access policy must be applied before reopening.');
        p.clearFence(applied);
        fenced = false;
        p.claimStore.clear(claim);
        return 'complete';
    }
    catch (error) {
        if (fenced) {
            try {
                p.fenceProvider();
                p.assertProviderFenced();
            }
            catch { /* Preserve marker and checkpoint even if Google is unavailable. */ }
        }
        p.pause();
        throw error;
    }
    finally {
        p.lock.releaseLock();
    }
}
/** Static explicit support grants stay explicit; derived Leadership and commander grants are replaced. */
export function permissionPolicyAccess(fixed: FrontendProtectionAccess, applied: AppliedPermissionPolicy): FrontendProtectionAccess {
    if (applied.policy.policyVersion !== 'det225-leadership-permissions-v1')
        fail('Unsupported trusted access policy.');
    return { ...fixed, permissionManagers: [...applied.policy.google.permissionManagers], leadershipEditors: [...applied.policy.google.leadershipEditors], attendanceEditors: [...applied.policy.google.attendanceEditors], squadronCommanders: copy(applied.policy.google.squadronCommanders) };
}
/** Used by BOTH native inputs and the frontend publisher, including setup-only mode. */
export function assertPermissionFenceClear(properties: {
    getProperty(key: string): string | null;
}): void {
    if (properties.getProperty(PERMISSION_FENCE_PROPERTY) !== null)
        fail('Access changes are being verified. The frontend remains fenced.');
}
