/** Optional owner-only rehearsal host. Operational staging intents remain permanently suppressed. */
import { AdapterError } from './index.js';
import { createGoogleSigner } from './apps-script.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { createPrivateCheckpoint } from './private-checkpoint.js';
import { createMailAppProvider } from './notification-runtime.js';
import type { NativeFrontendServices } from './frontend-runtime.js';
export const OWNER_MAIL_PROPERTIES = { config: 'SHAMROCK_V3_OWNER_MAIL_CONFIG', pause: 'SHAMROCK_V3_OWNER_MAIL_PAUSED', setup: 'SHAMROCK_V3_OWNER_MAIL_SETUP', control: 'SHAMROCK_V3_OWNER_MAIL_CONTROL' } as const;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const fileId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (message: string): never => { throw new AdapterError('owner_mail', message); };
export interface NativeOwnerMailConfig {
    version: 1;
    environment: 'staging';
    generation: number;
    enabled: boolean;
    resourceReview: 'OWNER_ONLY_MAIL_REHEARSAL_REVIEWED';
    principalId: string;
    workerId: string;
    stateFileId: string;
    controlRequest?: {
        requestId: string;
        sequence: number;
        action: 'setup' | 'pause' | 'resume' | 'prepare';
        stateSha256: string;
        caseId?: string;
        noticeId?: string;
        payloadHash?: string;
    };
}
interface Claim {
    attempted: true;
    mode: 'owner-rehearsal';
    caseId: string;
    attemptId: string;
    claimToken: string;
    expiresAt: string;
    message: {
        to: string[];
        cc: string[];
        subject: string;
        body: string;
    };
}
interface State {
    version: 1;
    environment: 'staging';
    generation: number;
    review?: {
        caseId: string;
        noticeId: string;
        payloadHash: string;
        reviewHash: string;
    };
    pendingControl?: string;
    delivery?: {
        claimId: string;
        claim?: Claim;
        phase?: 'claimed' | 'dispatching' | 'result';
        outcome?: 'confirmed' | 'known-not-sent' | 'lost-result';
    };
    receipt?: {
        caseId: string;
        attemptId: string;
        state: 'sent' | 'not-sent' | 'uncertain';
    };
}
export interface NativeOwnerMailServices extends NativeFrontendServices {
    MailApp: {
        getRemainingDailyQuota(): number;
        sendEmail(message: {
            to: string;
            cc?: string;
            replyTo?: string;
            subject: string;
            body: string;
            name: string;
        }): void;
    };
}
export function parseNativeOwnerMailConfig(value: unknown, generation: number): NativeOwnerMailConfig {
    const c = value as NativeOwnerMailConfig;
    if (!c || Object.keys(c).some(k => !['version', 'environment', 'generation', 'enabled', 'resourceReview', 'principalId', 'workerId', 'stateFileId', 'controlRequest'].includes(k)) || c.version !== 1 || c.environment !== 'staging' || c.generation !== generation || typeof c.enabled !== 'boolean' || c.resourceReview !== 'OWNER_ONLY_MAIL_REHEARSAL_REVIEWED' || !id(c.principalId) || !id(c.workerId) || !fileId(c.stateFileId))
        fail('Use a reviewed, isolated owner-mail configuration.');
    const r = c.controlRequest;
    if (r && (!id(r.requestId) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !['setup', 'pause', 'resume', 'prepare'].includes(r.action) || !hash(r.stateSha256) || Object.keys(r).some(k => !['requestId', 'sequence', 'action', 'stateSha256', ...(r.action === 'prepare' ? ['caseId', 'noticeId', 'payloadHash'] : [])].includes(k)) || r.action === 'prepare' && (!id(r.caseId) || !id(r.noticeId) || !hash(r.payloadHash))))
        fail('Use an exact versioned owner-mail review.');
    return c;
}
function validateState(v: unknown, generation: number): State {
    const s = v as State;
    if (!s || s.version !== 1 || s.environment !== 'staging' || s.generation !== generation || Object.keys(s).some(k => !['version', 'environment', 'generation', 'review', 'pendingControl', 'delivery', 'receipt'].includes(k)))
        fail('The owner-mail checkpoint is invalid.');
    if (s.review && (!id(s.review.caseId) || !id(s.review.noticeId) || !hash(s.review.payloadHash) || !hash(s.review.reviewHash)))
        fail('The retained mail review is invalid.');
    if (s.delivery && (!s.review || !id(s.delivery.claimId) || s.delivery.phase && !['claimed', 'dispatching', 'result'].includes(s.delivery.phase) || s.delivery.outcome && !['confirmed', 'known-not-sent', 'lost-result'].includes(s.delivery.outcome)))
        fail('The retained delivery phase is invalid.');
    if (s.pendingControl && !hash(s.pendingControl) || s.receipt && (!id(s.receipt.caseId) || !id(s.receipt.attemptId) || !['sent', 'not-sent', 'uncertain'].includes(s.receipt.state)))
        fail('The retained mail receipt is invalid.');
    return s;
}
function checkedClaim(value: unknown, owner: string, caseId: string): Claim {
    const c = value as Claim;
    if (!c || c.attempted !== true || c.mode !== 'owner-rehearsal' || c.caseId !== caseId || !id(c.attemptId) || !id(c.claimToken) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.expiresAt) || !Number.isFinite(Date.parse(c.expiresAt))
        || !c.message || Object.keys(c.message).sort().join(',') !== 'body,cc,subject,to' || canonical(c.message.to) !== canonical([owner]) || canonical(c.message.cc) !== '[]' || typeof c.message.subject !== 'string' || !c.message.subject.startsWith('[STAGING REHEARSAL] ') || /[\r\n]/.test(c.message.subject) || typeof c.message.body !== 'string' || canonical(c.message).length > 32000)
        fail('Only the exact reviewed message to the automation owner may reach MailApp.');
    return c;
}
export function createNativeOwnerMailRuntime(services: NativeOwnerMailServices) {
    const props = services.PropertiesService.getScriptProperties(), now = services.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    function pause() { props.setProperty(OWNER_MAIL_PROPERTIES.pause, 'true'); if (props.getProperty(OWNER_MAIL_PROPERTIES.pause) !== 'true')
        fail('Mail rehearsal pause did not persist.'); return { status: 'paused' }; }
    function load() {
        const rawHost = props.getProperty(HOST_PROPERTIES.config);
        if (!rawHost)
            return undefined;
        const host = parseStagingHostConfig(JSON.parse(rawHost)), owner = services.Session.getEffectiveUser().getEmail().trim().toLowerCase();
        if (owner !== host.expectedAutomationEmail)
            fail('Use the configured automation owner.');
        const google = (url: string, body?: unknown): any => { const result = services.UrlFetchApp.fetch(url, { method: body === undefined ? 'get' : 'patch', headers: { Authorization: `Bearer ${services.ScriptApp.getOAuthToken()}` }, ...(body === undefined ? {} : { contentType: 'application/json', payload: canonical(body) }), muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true }); const text = result.getContentText(); if (result.getResponseCode() !== 200 || text.length > 128000)
            fail('The private mail file could not be verified.'); try {
            return JSON.parse(text);
        }
        catch {
            return fail('The private mail file is invalid JSON.');
        } };
        const drive = (file: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file)}`;
        const inspect = (file: string) => { const meta = google(`${drive(file)}?fields=id,mimeType,size,version,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted)`); if (meta.id !== file || meta.trashed || meta.driveId || meta.mimeType !== 'application/json' || !Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 1 || Number(meta.size) > 128000 || meta.owners?.length !== 1 || meta.owners[0].emailAddress !== owner || meta.permissions?.length !== 1 || meta.permissions[0].type !== 'user' || meta.permissions[0].role !== 'owner' || meta.permissions[0].deleted || meta.permissions[0].emailAddress !== owner)
            fail('Mail configuration and checkpoint files must be owner-only.'); return meta; };
        const read = (file: string) => { inspect(file); return google(`${drive(file)}?alt=media`); };
        const root = props.getProperty(CONFIG_FILE_ID_PROPERTY);
        let pointer: any = props.getProperty(OWNER_MAIL_PROPERTIES.config);
        if (!pointer && root)
            pointer = read(root)[OWNER_MAIL_PROPERTIES.config];
        if (!pointer)
            return undefined;
        if (typeof pointer === 'string')
            pointer = JSON.parse(pointer);
        if (Object.keys(pointer).sort().join(',') !== 'configFileId,version' || pointer.version !== 1 || !fileId(pointer.configFileId) || pointer.configFileId === root)
            fail('Bind a separate reviewed owner-mail configuration.');
        const config = parseNativeOwnerMailConfig(read(pointer.configFileId), host.generation);
        if ([root, pointer.configFileId, host.journal.spreadsheetId, host.decisionInput?.spreadsheetId].includes(config.stateFileId))
            fail('Use a separate private owner-mail checkpoint.');
        const signer = createGoogleSigner(services.Utilities, props.getProperty(HOST_PROPERTIES.secret) ?? '');
        const state = createPrivateCheckpoint<State>({ version: () => String(inspect(config.stateFileId).version), read: () => google(`${drive(config.stateFileId)}?alt=media`), write(value) { if (canonical(value).length > 128000)
                fail('Mail checkpoint exceeds its bound.'); google(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.stateFileId)}?uploadType=media&fields=id`, value); }, validate: value => validateState(value, config.generation), digest: canonical });
        const base = { environment: 'staging', generation: config.generation, principalId: config.principalId };
        function rpc(action: string, extra: Record<string, unknown>) { const path = `/v1/admin/notifications/rehearsal/${action}`, body = JSON.stringify({ ...base, ...extra }), timestamp = String(now()); const result = services.UrlFetchApp.fetch(host.workerOrigin + path, { method: 'post', headers: { 'x-shamrock-key-id': host.keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(body)}`) }, contentType: 'application/json', payload: body, muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true }); const text = result.getContentText(); if (result.getResponseCode() !== 200 || text.length > 64000)
            fail('The signed rehearsal result is unknown; retain the checkpoint.'); try {
            return JSON.parse(text);
        }
        catch {
            return fail('The signed rehearsal result is invalid.');
        } }
        const binding = () => { const { enabled, controlRequest, ...immutable } = config; return signer.sha256(canonical({ owner, hostOrigin: host.workerOrigin, keyId: host.keyId, config: immutable })); };
        const status = (caseId: string) => { const response = rpc('status', { caseId }); if (response.enabled !== true || response.ownerEmail !== owner)
            fail('Worker and Google rehearsal owner bindings differ.'); return response; };
        return { host, owner, config, state, signer, rpc, binding, status };
    }
    function withLock<T>(work: () => T): T { const lock = services.LockService.getScriptLock(); if (!lock.tryLock(1000))
        fail('Another adapter operation is active.'); try {
        return work();
    }
    finally {
        lock.releaseLock();
    } }
    function applyControl() {
        return withLock(() => {
            const c = load(), r = c?.config.controlRequest;
            if (!c || !r)
                return { status: 'none' };
            const encoded = canonical(r), prior = props.getProperty(OWNER_MAIL_PROPERTIES.control);
            if (prior === encoded)
                return { status: 'already-consumed' };
            if (prior) {
                const previous = JSON.parse(prior);
                if (previous.sequence >= r.sequence || previous.requestId === r.requestId)
                    fail('A consumed owner-mail control cannot be reused.');
            }
            const state = c.state.load(), controlHash = c.signer.sha256(encoded);
            if (c.signer.sha256(canonical(state)) !== r.stateSha256 && state.pendingControl !== controlHash)
                fail('The private mail checkpoint changed after review.');
            pause();
            let status = 'paused';
            if (r.action === 'setup') {
                c.status(state.review?.caseId ?? 'owner-mail-setup');
                props.setProperty(OWNER_MAIL_PROPERTIES.setup, c.binding());
                if (props.getProperty(OWNER_MAIL_PROPERTIES.setup) !== c.binding())
                    fail('Owner-mail setup did not persist.');
                status = 'setup-paused';
            }
            if (r.action === 'prepare') {
                if (state.delivery || state.review && !state.receipt && state.review.caseId !== r.caseId)
                    fail('Reconcile the retained case before preparing another.');
                state.pendingControl = controlHash;
                c.state.save(state);
                const result = c.rpc('prepare', { caseId: r.caseId, noticeId: r.noticeId, payloadHash: r.payloadHash });
                if (result.caseId !== r.caseId || !hash(result.reviewHash) || result.state !== 'ready')
                    fail('A fresh reviewed case was not prepared.');
                state.review = { caseId: r.caseId!, noticeId: r.noticeId!, payloadHash: r.payloadHash!, reviewHash: result.reviewHash };
                delete state.receipt;
                c.state.save(state);
                status = 'prepared-paused';
            }
            if (r.action === 'resume') {
                if (!c.config.enabled || !state.review || props.getProperty(OWNER_MAIL_PROPERTIES.setup) !== c.binding())
                    fail('Set up and review the exact enabled mail binding before resuming.');
                const observed = c.status(state.review!.caseId);
                if (observed.case?.reviewHash !== state.review!.reviewHash || observed.case?.state !== 'ready' && !state.delivery)
                    fail('The Worker review no longer matches.');
                props.setProperty(OWNER_MAIL_PROPERTIES.pause, 'false');
                if (props.getProperty(OWNER_MAIL_PROPERTIES.pause) !== 'false')
                    fail('Mail resume did not persist.');
                status = 'ready';
            }
            props.setProperty(OWNER_MAIL_PROPERTIES.control, encoded);
            if (props.getProperty(OWNER_MAIL_PROPERTIES.control) !== encoded)
                fail('Mail control receipt did not persist.');
            return { status };
        });
    }
    function flush() {
        if (props.getProperty(OWNER_MAIL_PROPERTIES.pause) !== 'false')
            return { status: 'paused' };
        return withLock(() => {
            const c = load();
            if (!c?.config.enabled)
                return { status: 'disabled' };
            if (props.getProperty(OWNER_MAIL_PROPERTIES.setup) !== c.binding())
                fail('Owner-mail bindings changed after setup.');
            const state = c.state.load();
            if (!state.review || state.receipt)
                return { status: state.receipt?.state ?? 'idle' };
            c.status(state.review.caseId);
            if (!state.delivery) {
                state.delivery = { claimId: 'mail-' + c.signer.sha256(JSON.stringify([state.review.caseId, c.config.workerId, state.review.reviewHash])) };
                c.state.save(state);
            }
            const d = state.delivery;
            if (!d.claim) {
                const claim = c.rpc('claim', { caseId: state.review.caseId, reviewHash: state.review.reviewHash, claimId: d.claimId, workerId: c.config.workerId });
                if (claim.attempted === false) {
                    if (claim.caseId !== state.review.caseId || !id(claim.attemptId) || !['sent', 'not-sent', 'uncertain'].includes(claim.state))
                        fail('Rehearsal claim is unavailable.');
                    state.receipt = { caseId: claim.caseId, attemptId: claim.attemptId, state: claim.state };
                    delete state.delivery;
                    c.state.save(state);
                    pause();
                    return { status: claim.state };
                }
                d.claim = checkedClaim(claim, c.owner, state.review.caseId);
                d.phase = 'claimed';
                c.state.save(state);
            }
            const claim = checkedClaim(d.claim, c.owner, state.review.caseId);
            if (d.phase === 'dispatching') {
                d.phase = 'result';
                d.outcome = 'lost-result';
                c.state.save(state);
            }
            if (d.phase === 'claimed') {
                if (Date.parse(claim.expiresAt) <= now() * 1000 + 30000)
                    d.outcome = 'lost-result';
                else if (!(services.MailApp.getRemainingDailyQuota() >= 1))
                    d.outcome = 'known-not-sent';
                else {
                    d.phase = 'dispatching';
                    c.state.save(state);
                    d.outcome = 'lost-result';
                    try {
                        const sent = createMailAppProvider(services.MailApp).send(claim.message);
                        d.outcome = sent.outcome;
                    }
                    catch { /* API exception cannot prove non-delivery. */ }
                }
                d.phase = 'result';
                c.state.save(state);
            }
            if (d.phase !== 'result' || !d.outcome)
                fail('The retained mail phase requires review.');
            const receipt = c.rpc('complete', { attemptId: claim.attemptId, claimToken: claim.claimToken, workerId: c.config.workerId, outcome: d.outcome });
            if (receipt.caseId !== claim.caseId || receipt.attemptId !== claim.attemptId || !['sent', 'not-sent', 'uncertain'].includes(receipt.state))
                fail('The delivery receipt does not match the retained attempt.');
            state.receipt = { caseId: receipt.caseId, attemptId: receipt.attemptId, state: receipt.state };
            delete state.delivery;
            c.state.save(state);
            pause();
            return { status: receipt.state };
        });
    }
    return { pause, applyControl, flush, status() { const c = load(); if (!c)
            return { status: 'unconfigured' }; const s = c.state.load(); return { enabled: c.config.enabled, paused: props.getProperty(OWNER_MAIL_PROPERTIES.pause) !== 'false', reviewed: !!s.review, pending: !!s.delivery, state: s.receipt?.state ?? s.delivery?.phase ?? 'idle' }; } };
}
