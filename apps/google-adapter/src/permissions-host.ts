/** Opt-in native host for trusted access turnover. Private controls are consumed once; no import-time IO. */
import { AdapterError } from './index.js';
import { createGoogleSigner } from './apps-script.js';
import { parseAdminCommand } from '../../../packages/domain/src/admin.js';
import { HOST_PROPERTIES } from './staging-host.js';
import { createNativeFrontendRuntime, type NativeFrontendServices, type NativeFrontendInputSession } from './frontend-runtime.js';
import { createPermissionContext, PERMISSION_PROPERTIES, permissionCanonical } from './permissions-context.js';
import { createNativePermissionApi, createNativePermissionProvider, type PermissionBook } from './permissions-native.js';
import { PERMISSION_FENCE_PROPERTY, runPermissionRefresh, type PermissionClaim, type PermissionRefreshState } from './permissions-refresh.js';
function fail(message: string): never { throw new AdapterError('native_permissions', message); }
type Change = {
    commandId: string;
    payloadSha256: string;
    command: unknown;
    path: string;
    providerEvidence: unknown;
    receipt?: unknown;
    controlHash?: string;
};
type State = PermissionRefreshState & {
    pendingChange?: Change;
};
export function createNativePermissionRuntime(services: NativeFrontendServices, frontend = createNativeFrontendRuntime(services)) {
    const props = services.PropertiesService.getScriptProperties(), context = createPermissionContext(services), now = services.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    function pause() { props.setProperty(PERMISSION_PROPERTIES.pause, 'true'); if (props.getProperty(PERMISSION_PROPERTIES.pause) !== 'true')
        fail('Permission processing could not be paused.'); return { status: 'paused' }; }
    function load() {
        const c = context.load();
        if (!c)
            return undefined;
        const signer = createGoogleSigner(services.Utilities, props.getProperty(HOST_PROPERTIES.secret) ?? '');
        function request(path: string, input: unknown) {
            const body = JSON.stringify(input), timestamp = String(now());
            if (body.length > 65536)
                fail('The permission command exceeds its bounded request.');
            const response = services.UrlFetchApp.fetch(c!.host.workerOrigin + path, { method: 'post', contentType: 'application/json', payload: body, headers: { 'x-shamrock-key-id': c!.host.keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(body)}`) }, muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
            const text = response.getContentText();
            if (text.length > 2000000)
                fail('Permission response exceeds its bound.');
            let result: any;
            try {
                result = JSON.parse(text);
            }
            catch {
                return fail('The permission response is ambiguous; the frozen operation is retained.');
            }
            return { status: response.getResponseCode(), body: result };
        }
        const base = { environment: 'staging', generation: c.config.generation, principalId: c.config.principalId };
        function rpc(action: string, extra: Record<string, unknown> = {}) { const result = request(`/v1/admin/permissions/${action}`, { ...base, ...extra }); if (result.status !== 200)
            fail(`Permission operation failed (${result.body?.error?.code ?? result.status}); retain the access fence for review.`); return result.body; }
        return { ...c, signer, request, rpc };
    }
    const claimStore = { load(): PermissionClaim | undefined { const raw = props.getProperty(PERMISSION_PROPERTIES.claim); return raw ? JSON.parse(raw) : undefined; }, save(claim: PermissionClaim) { const value = JSON.stringify(claim); props.setProperty(PERMISSION_PROPERTIES.claim, value); if (props.getProperty(PERMISSION_PROPERTIES.claim) !== value)
            fail('The permission claim did not persist.'); }, clear(claim: PermissionClaim) { const current = this.load(); if (permissionCanonical(current) !== permissionCanonical(claim))
            fail('The retained permission claim changed.'); props.deleteProperty(PERMISSION_PROPERTIES.claim); if (props.getProperty(PERMISSION_PROPERTIES.claim) !== null)
            fail('The completed permission claim did not clear.'); } };
    function setFence() { props.setProperty(PERMISSION_FENCE_PROPERTY, 'pending'); if (props.getProperty(PERMISSION_FENCE_PROPERTY) !== 'pending')
        fail('The shared access fence did not persist.'); }
    function provider(c: NonNullable<ReturnType<typeof load>>, session: NativeFrontendInputSession) {
        if (!session.protectionInput || !session.config.supplemental?.enabled || session.config.generation !== c.config.generation || session.automationEmail !== c.owner)
            fail('A complete isolated permission repair session is required.');
        const books: PermissionBook[] = [{ spreadsheetId: session.config.main.spreadsheetId, kind: 'main', fixedReaders: c.config.mainReaders, fixedAccess: session.config.access }, { spreadsheetId: session.config.supplemental.excusals.spreadsheetId, kind: 'excusals', fixedReaders: c.config.excusalReaders, fixedAccess: session.config.supplemental.excusals.access }];
        if (books.some(b => [c.config.stateFileId, session.config.stateFileId, c.host.journal.spreadsheetId, c.host.decisionInput?.spreadsheetId].includes(b.spreadsheetId)))
            fail('Permission books overlap private state or transport storage.');
        const api = createNativePermissionApi(services, id => { const input = session.protectionInput!(id); if (!input.metadata.sheets)
            fail('Complete native protection metadata is required.'); return { metadata: { sheets: input.metadata.sheets }, surfaces: [...input.surfaces] }; });
        return { api, books, native: createNativePermissionProvider({ books, forbiddenSpreadsheetIds: c.config.forbiddenSpreadsheetIds }, api) };
    }
    function setupFingerprint(c: NonNullable<ReturnType<typeof load>>, books: PermissionBook[]) { const { enabled, controlRequest, ...binding } = c.config; return c.signer.sha256(permissionCanonical({ binding, books })); }
    function submitInSession(command: unknown, session: NativeFrontendInputSession, controlHash?: string) {
        const c = load();
        if (!c?.config.enabled)
            fail('Enable only a reviewed native permission configuration.');
        const raw = command as any;
        if (!raw || raw.environment !== 'staging' || raw.generation !== c.config.generation)
            fail('The reviewed command belongs to another environment.');
        const path = typeof raw.operation === 'string' ? (raw.operation.startsWith('transition.') ? '/v1/admin/transitions/commands' : '/v1/admin/commands') : '/v1/admin/permissions/commands';
        // A known receipt is read/re-authorized before repeating any provider preparation.
        let result = c.request(path, command);
        if (result.status === 200) {
            const known = c.state.load() as State;
            if (known.pendingChange?.commandId === raw.commandId) {
                known.pendingChange!.receipt = result.body;
                c.state.save(known);
            }
            return result;
        }
        if (result.status !== 409 || result.body?.error?.code !== 'PERMISSION_FENCE_REQUIRED')
            return result;
        const normalized = ['directory.upsert', 'directory.selfUpdate', 'directory.enroll', 'leadership.upsert', 'event.upsert'].includes(raw.operation) ? parseAdminCommand(command) : command;
        const payloadSha256 = c.signer.sha256(JSON.stringify(normalized)), state = c.state.load() as State;
        if (state.pendingChange && !state.pendingChange.receipt && state.pendingChange.commandId !== raw.commandId)
            fail('Resolve the retained permission change before preparing another one.');
        const p = provider(c, session);
        setFence();
        p.native.assertIsolation();
        p.native.fenceProvider();
        p.native.assertProviderFenced();
        const policy = c.rpc('status');
        const evidence = { generation: c.config.generation, commandId: raw.commandId, payloadSha256, policyVersion: policy.version, books: p.books.map(b => ({ spreadsheetId: b.spreadsheetId, permissions: p.api.readPermissions(b.spreadsheetId), protections: p.api.readProtectionInput(b.spreadsheetId).metadata })) };
        if (state.pendingChange && state.pendingChange.commandId === raw.commandId && state.pendingChange.payloadSha256 !== payloadSha256)
            fail('A retained permission command cannot change.');
        state.pendingChange = { commandId: raw.commandId, payloadSha256, command, path, providerEvidence: evidence, ...(controlHash ? { controlHash } : {}) };
        c.state.save(state);
        c.rpc('fence', { commandId: raw.commandId, payloadSha256, expectedVersion: policy.version, checkpointSha256: c.signer.sha256(permissionCanonical(evidence)) });
        result = c.request(path, command);
        if (result.status === 200) {
            state.pendingChange.receipt = result.body;
            c.state.save(state);
        }
        else
            pause();
        return result;
    }
    function refresh() {
        const c = load();
        if (!c?.config.enabled || props.getProperty(PERMISSION_PROPERTIES.pause) === 'true')
            return { status: 'paused' };
        if (!props.getProperty(PERMISSION_PROPERTIES.setup))
            return { status: 'setup-required' };
        let claim = claimStore.load();
        if (!claim) {
            const response = c.rpc('claim', { workerId: c.config.workerId });
            if (!response.job)
                return { status: 'idle' };
            claim = response.job;
            claimStore.save(claim!);
        }
        try {
            return frontend.permissionSession(session => {
                const p = provider(c, session);
                if (props.getProperty(PERMISSION_PROPERTIES.setup) !== setupFingerprint(c, p.books))
                    fail('The permission bindings changed after setup.');
                const result = runPermissionRefresh({ enabled: () => c.config.enabled && props.getProperty(PERMISSION_PROPERTIES.pause) !== 'true', lock: { tryLock: () => true, releaseLock: () => { } }, claimStore, state: c.state,
                    request(action, lease) { return c.rpc(action, action === 'status' ? {} : action === 'claim' ? { workerId: c.config.workerId } : { workerId: c.config.workerId, jobId: lease!.jobId, claimToken: lease!.claimToken }); },
                    ...p.native, setFence, assertFenceMarker() { if (props.getProperty(PERMISSION_FENCE_PROPERTY) === null)
                        fail('The shared permission fence is missing.'); },
                    clearFence() { props.deleteProperty(PERMISSION_FENCE_PROPERTY); if (props.getProperty(PERMISSION_FENCE_PROPERTY) !== null)
                        fail('The verified permission fence did not clear.'); }, pause });
                return { status: result };
            });
        }
        catch (error) {
            if (error instanceof AdapterError && error.code === 'frontend_input_fenced')
                return { status: 'waiting-frontend' };
            pause();
            throw error;
        }
    }
    return { pause, refresh,
        submit(command: unknown, session?: NativeFrontendInputSession) { return session ? submitInSession(command, session) : frontend.permissionSession(s => submitInSession(command, s)); },
        applyControl() {
            const c = load(), r = c?.config.controlRequest;
            if (!c || !r)
                return { status: 'none' };
            const encoded = permissionCanonical(r), prior = props.getProperty(PERMISSION_PROPERTIES.control);
            if (prior === encoded)
                return { status: 'already-consumed' };
            if (prior) {
                const p = JSON.parse(prior);
                if (p.sequence >= r.sequence || p.requestId === r.requestId)
                    fail('A consumed permission control cannot be reused.');
            }
            return frontend.permissionSession(session => {
                const state = c.state.load() as State;
                if (c.signer.sha256(permissionCanonical(state)) !== r.stateSha256 && !(r.action === 'command' && state.pendingChange?.controlHash === c.signer.sha256(encoded)))
                    fail('The private permission checkpoint changed after review.');
                pause();
                const p = provider(c, session);
                let result: unknown = { status: 'paused' };
                if (r.action === 'setup') {
                    p.native.assertIsolation();
                    props.setProperty(PERMISSION_PROPERTIES.setup, setupFingerprint(c, p.books));
                    result = { status: 'setup-paused' };
                }
                if (r.action === 'resume') {
                    if (!c.config.enabled)
                        fail('Enable the reviewed permission configuration before resuming.');
                    if (props.getProperty(PERMISSION_PROPERTIES.setup) !== setupFingerprint(c, p.books))
                        fail('Verify this exact permission setup before resuming.');
                    props.deleteProperty(PERMISSION_PROPERTIES.pause);
                    if (props.getProperty(PERMISSION_PROPERTIES.pause) !== null)
                        fail('The permission pause did not clear.');
                    result = { status: 'ready' };
                }
                if (r.action === 'command') {
                    const command = c.readPrivate(r.commandFileId!);
                    if (c.signer.sha256(permissionCanonical(command)) !== r.commandSha256)
                        fail('The reviewed private command changed.');
                    result = submitInSession(command, session, c.signer.sha256(encoded));
                    if ((result as any).status !== 200)
                        fail('The reviewed permission command did not commit.');
                }
                if (r.action === 'recover') {
                    const claim = claimStore.load();
                    if (!claim || claim.leaseExpiresAt !== r.previousExpiry)
                        fail('Recover only the exact retained claim.');
                    setFence();
                    p.native.fenceProvider();
                    p.native.assertProviderFenced();
                    const recovered = c.rpc('recover', { recoveryId: r.recoveryId, workerId: c.config.workerId, jobId: claim.jobId, claimToken: claim.claimToken, previousExpiry: r.previousExpiry, checkpointSha256: c.signer.sha256(permissionCanonical(state)) });
                    claim.leaseExpiresAt = recovered.leaseExpiresAt;
                    if (state.pending)
                        state.pending.claim = claim;
                    c.state.save(state);
                    claimStore.save(claim);
                    result = { status: 'recovered-paused' };
                }
                props.setProperty(PERMISSION_PROPERTIES.control, encoded);
                if (props.getProperty(PERMISSION_PROPERTIES.control) !== encoded)
                    fail('Permission control consumption did not persist.');
                return result;
            });
        },
    };
}
