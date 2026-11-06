/** Explicit provider ports; no globals, installed triggers, credentials or mail calls on load. */
import { AdapterError, type AdapterConfig, type Signer, type Transport } from './index.js';
import type { ScriptLockPort } from './apps-script.js';
import { NOTICE_POLICY, noticeLocalClock } from '../../../packages/domain/src/notifications.js';
import type { DeliveryClaimResult, DeliveryMessage } from '../../worker/src/notifications.js';
export interface MaintenanceApi {
    config: AdapterConfig;
    principalId: string;
    workerId: string;
    signer: Signer;
    transport: Transport;
    nowSeconds(): number;
}
export function callMaintenance(api: MaintenanceApi, path: string, input: unknown): Record<string, unknown> {
    if (!/^\/v1\/admin\/(notifications|transitions)\/[a-z/]+$/.test(path))
        throw new AdapterError('maintenance_path', 'Unsupported maintenance operation.');
    if (!/^https:\/\//.test(api.config.baseUrl) || /[?#]/.test(api.config.baseUrl))
        throw new AdapterError('maintenance_origin', 'Use the configured HTTPS Worker origin.');
    const body = JSON.stringify(input), digest = api.signer.sha256(body), timestamp = String(api.nowSeconds());
    const signature = api.signer.hmacSha256(`POST\n${path}\n${timestamp}\n${digest}`);
    if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(signature))
        throw new AdapterError('maintenance_signer', 'Signing failed.');
    const response = api.transport.send({ method: 'POST', url: api.config.baseUrl + path, body,
        headers: { 'content-type': 'application/json', 'x-shamrock-key-id': api.config.keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature } });
    if (response.body.length > 2000000)
        throw new AdapterError('maintenance_response', 'Maintenance response exceeded its bound.');
    if (response.status !== 200)
        throw new AdapterError('maintenance_http', `Maintenance operation returned HTTP ${response.status}.`);
    try {
        const value = JSON.parse(response.body);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw Error();
        return value;
    }
    catch {
        throw new AdapterError('maintenance_response', 'Maintenance returned an invalid response.');
    }
}
export interface NotificationClientState {
    /** Saved before claiming, so an unknown HTTP result reuses the exact same claim. */
    claimId?: string;
    claim?: Extract<DeliveryClaimResult, {
        attempted: true;
    }>;
    phase?: 'claimed' | 'dispatching' | 'result';
    result?: {
        outcome: 'confirmed' | 'known-not-sent' | 'lost-result';
        providerReference: string | null;
    };
}
export interface NotificationPorts {
    api: MaintenanceApi;
    lock: ScriptLockPort;
    enabled(): boolean;
    assertPrivateState(): void;
    state: {
        load(): NotificationClientState;
        save(value: NotificationClientState): void;
    };
    newClaimId(): string;
    provider: {
        remainingRecipients(): number;
        send(message: DeliveryMessage): {
            outcome: 'confirmed';
            providerReference?: string;
        } | {
            outcome: 'known-not-sent';
        };
    };
}
const identity = (api: MaintenanceApi) => ({ environment: api.config.environment, generation: api.config.generation, principalId: api.principalId });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Stage/import mail never reaches the provider. A restart after dispatching records uncertainty. */
export function flushNotificationDelivery(ports: NotificationPorts): {
    state: string;
} {
    if (!ports.enabled())
        return { state: 'paused' };
    if (ports.api.config.environment !== 'local')
        return { state: 'suppressed' };
    if (!ports.lock.tryLock(1000))
        return { state: 'busy' };
    try {
        ports.assertPrivateState();
        let state = clone(ports.state.load());
        const base = { ...identity(ports.api), workerId: ports.api.workerId };
        if (!state.claim) {
            if (!state.claimId) {
                state.claimId = ports.newClaimId();
                ports.state.save(state);
            }
            const claim = callMaintenance(ports.api, '/v1/admin/notifications/delivery/claim', { ...base, claimId: state.claimId }) as DeliveryClaimResult;
            if (!claim.attempted) {
                ports.state.save({});
                return { state: claim.state ?? claim.reason ?? 'idle' };
            }
            if (claim.mode !== 'local-test' || !claim.message.to.length || [...claim.message.to, ...claim.message.cc, ...(claim.message.replyTo ? [claim.message.replyTo] : [])].some(address => !address.endsWith('.invalid')))
                throw new AdapterError('notification_suppression', 'Only fictional local recipients can reach this delivery port.');
            state = { claimId: state.claimId, claim, phase: 'claimed' };
            ports.state.save(state);
        }
        const claim = state.claim!;
        if (state.phase === 'dispatching') {
            state.phase = 'result';
            state.result = { outcome: 'lost-result', providerReference: null };
            ports.state.save(state);
        }
        if (state.phase === 'claimed') {
            const recipients = new Set([...claim.message.to, ...claim.message.cc]).size;
            if (Date.parse(claim.expiresAt) <= ports.api.nowSeconds() * 1000 + 30000) {
                state.result = { outcome: 'lost-result', providerReference: null };
            }
            else if (ports.provider.remainingRecipients() < recipients) {
                state.result = { outcome: 'known-not-sent', providerReference: null };
            }
            else {
                state.phase = 'dispatching';
                ports.state.save(state);
                let result: NotificationClientState['result'] = { outcome: 'lost-result', providerReference: null };
                try {
                    const delivery = ports.provider.send(claim.message);
                    if (delivery.outcome === 'known-not-sent')
                        result = { outcome: 'known-not-sent', providerReference: null };
                    else if (delivery.outcome === 'confirmed' && (delivery.providerReference === undefined || /^[A-Za-z0-9_.:-]{1,128}$/.test(delivery.providerReference)))
                        result = { outcome: 'confirmed', providerReference: delivery.providerReference ?? null };
                }
                catch { /* Provider throws cannot prove that Gmail did not accept a message. */ }
                state.result = result;
            }
            state.phase = 'result';
            ports.state.save(state);
        }
        if (state.phase !== 'result' || !state.result)
            throw new AdapterError('notification_state', 'The private delivery checkpoint needs review.');
        const receipt = callMaintenance(ports.api, '/v1/admin/notifications/delivery/complete', { ...base,
            attemptId: claim.attemptId, claimToken: claim.claimToken, ...state.result });
        if (receipt.attemptId !== claim.attemptId || !['sent', 'queued', 'uncertain'].includes(String(receipt.state)))
            throw new AdapterError('notification_receipt', 'Delivery receipt does not match the retained attempt.');
        ports.state.save({});
        return { state: String(receipt.state) };
    }
    finally {
        ports.lock.releaseLock();
    }
}
/** Native MailApp wrapper is dependency-injected and has no staging/global binding.
 * MailApp returns no provider ID. A normal return confirms API acceptance, not inbox delivery. */
export function createMailAppProvider(mail: {
    getRemainingDailyQuota(): number;
    sendEmail(message: {
        to: string;
        cc?: string;
        replyTo?: string;
        subject: string;
        body: string;
        name: string;
    }): void;
}): NotificationPorts['provider'] {
    return { remainingRecipients: () => mail.getRemainingDailyQuota(), send(message) {
            const required = new Set([...message.to, ...message.cc]).size;
            if (!required || mail.getRemainingDailyQuota() < required)
                return { outcome: 'known-not-sent' };
            mail.sendEmail({ to: message.to.join(','), ...(message.cc.length ? { cc: message.cc.join(',') } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}), subject: message.subject, body: message.body, name: 'SHAMROCK Automations' });
            return { outcome: 'confirmed' };
        } };
}
function scheduledTime(now: string): string | null {
    const clock = noticeLocalClock(now);
    const hour = clock.weekday === 0 && clock.hour >= NOTICE_POLICY.weeklyHour ? NOTICE_POLICY.weeklyHour : NOTICE_POLICY.dailyHour;
    if (clock.hour < hour)
        return null;
    const desired = Date.parse(`${clock.date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
    return [4, 5].map(offset => new Date(desired + offset * 3600000).toISOString()).find(candidate => { const result = noticeLocalClock(candidate); return result.date === clock.date && result.hour === hour; }) ?? null;
}
/** One deterministic scheduled command and at most five committed-version tasks per invocation. */
export function planNotificationWork(api: MaintenanceApi, source: {
    kind: 'sheet' | 'test';
    resourceKey: string;
}, enabled: boolean): {
    planned: boolean;
    processed: number;
} {
    if (!enabled)
        return { planned: false, processed: 0 };
    const asOf = scheduledTime(new Date(api.nowSeconds() * 1000).toISOString());
    let planned = false;
    if (asOf) {
        const commandId = 'notice-schedule-' + api.signer.sha256(JSON.stringify([NOTICE_POLICY.version, asOf]));
        callMaintenance(api, '/v1/admin/notifications/plan', { commandId, contractVersion: 1, environment: api.config.environment, generation: api.config.generation,
            actor: { principalId: api.principalId, evidence: 'registered-automation' }, source: { ...source, submissionId: commandId, revision: 1 }, operation: 'notifications.plan', payload: { kind: 'scheduled', asOf, requestId: null } });
        planned = true;
    }
    const status = callMaintenance(api, '/v1/admin/notifications/status', identity(api));
    if (!Array.isArray(status.pendingTasks))
        throw new AdapterError('notification_tasks', 'Notification backlog response is invalid.');
    let processed = 0;
    for (const task of status.pendingTasks.slice(0, 5)) {
        if (!task || typeof task.taskId !== 'string')
            throw new AdapterError('notification_tasks', 'Notification task identity is invalid.');
        callMaintenance(api, '/v1/admin/notifications/process', { ...identity(api), sourceKind: source.kind, sourceResource: source.resourceKey, taskId: task.taskId });
        processed++;
    }
    return { planned, processed };
}
