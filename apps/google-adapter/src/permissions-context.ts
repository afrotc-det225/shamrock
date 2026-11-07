/** Owner-private permission configuration and applied state. Shared by native input and publication. */
import { AdapterError } from './index.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { createPrivateCheckpoint } from './private-checkpoint.js';
import { assertPermissionFenceClear, type PermissionRefreshState } from './permissions-refresh.js';
import type { NativeFrontendServices } from './frontend-runtime.js';
export const PERMISSION_PROPERTIES = { config: 'SHAMROCK_V3_PERMISSION_CONFIG', pause: 'SHAMROCK_V3_PERMISSION_PAUSED', claim: 'SHAMROCK_V3_PERMISSION_CLAIM', control: 'SHAMROCK_V3_PERMISSION_CONTROL_RECEIPT', setup: 'SHAMROCK_V3_PERMISSION_SETUP' } as const;
export interface NativePermissionConfig {
    version: 1;
    environment: 'staging';
    generation: number;
    enabled: boolean;
    resourceReview: 'NATIVE_PERMISSION_POLICY_REVIEWED_FOR_STAGING';
    workerId: string;
    principalId: string;
    stateFileId: string;
    mainReaders: string[];
    excusalReaders: string[];
    forbiddenSpreadsheetIds: string[];
    controlRequest?: {
        requestId: string;
        sequence: number;
        action: 'setup' | 'resume' | 'pause' | 'recover' | 'command';
        stateSha256: string;
        commandFileId?: string;
        commandSha256?: string;
        recoveryId?: string;
        previousExpiry?: string;
    };
}
export const permissionCanonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const fail = (message: string): never => { throw new AdapterError('permission_configuration', message); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const fileId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
export function parseNativePermissionConfig(value: unknown, generation: number): NativePermissionConfig {
    const c = value as NativePermissionConfig;
    if (!c || Object.keys(c).some(k => !['version', 'environment', 'generation', 'enabled', 'resourceReview', 'workerId', 'principalId', 'stateFileId', 'mainReaders', 'excusalReaders', 'forbiddenSpreadsheetIds', 'controlRequest'].includes(k)) || c.version !== 1 || c.environment !== 'staging' || c.generation !== generation || typeof c.enabled !== 'boolean' || c.resourceReview !== 'NATIVE_PERMISSION_POLICY_REVIEWED_FOR_STAGING' || !id(c.workerId) || !id(c.principalId) || !fileId(c.stateFileId))
        fail('Use a reviewed isolated permission configuration.');
    for (const entries of [c.mainReaders, c.excusalReaders])
        if (!Array.isArray(entries) || entries.length > 500 || new Set(entries).size !== entries.length || entries.some(e => typeof e !== 'string' || e !== e.trim().toLowerCase() || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e)))
            fail('Use bounded, explicit named viewer lists.');
    if (!Array.isArray(c.forbiddenSpreadsheetIds) || c.forbiddenSpreadsheetIds.length > 50 || c.forbiddenSpreadsheetIds.some(v => !fileId(v)))
        fail('Explicit production exclusion bindings are required.');
    if (c.controlRequest) {
        const r = c.controlRequest;
        if (Object.keys(r).some(k => !['requestId', 'sequence', 'action', 'stateSha256', ...(r.action === 'command' ? ['commandFileId', 'commandSha256'] : r.action === 'recover' ? ['recoveryId', 'previousExpiry'] : [])].includes(k)) || !id(r.requestId) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !['setup', 'resume', 'pause', 'recover', 'command'].includes(r.action) || !/^[a-f0-9]{64}$/.test(r.stateSha256))
            fail('Use a reviewed versioned permission control.');
        if (r.action === 'command' && (!fileId(r.commandFileId) || !/^[a-f0-9]{64}$/.test(r.commandSha256 ?? '')) || r.action === 'recover' && (!id(r.recoveryId) || !Number.isFinite(Date.parse(r.previousExpiry ?? ''))))
            fail('Permission command/recovery evidence is missing.');
    }
    return c;
}
export function createPermissionContext(services: NativeFrontendServices) {
    const props = services.PropertiesService.getScriptProperties();
    function api(url: string, body?: unknown): any {
        const response = services.UrlFetchApp.fetch(url, { method: body === undefined ? 'get' : 'patch', headers: { Authorization: `Bearer ${services.ScriptApp.getOAuthToken()}` }, ...(body === undefined ? {} : { contentType: 'application/json', payload: permissionCanonical(body) }), muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
        if (response.getResponseCode() !== 200)
            fail('The private permission file could not be verified.');
        const text = response.getContentText();
        if (text.length > 2000000)
            fail('The private permission file exceeds its bound.');
        try {
            return JSON.parse(text);
        }
        catch {
            return fail('The private permission file is invalid JSON.');
        }
    }
    const drive = (id: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
    function inspectPrivate(id: string, owner: string) {
        const meta = api(`${drive(id)}?fields=id,mimeType,size,version,trashed,owners(emailAddress),permissions(type,role,emailAddress,deleted)`);
        if (meta.id !== id || meta.trashed || meta.mimeType !== 'application/json' || Number(meta.size) > 2000000 || meta.owners?.length !== 1 || meta.owners[0].emailAddress !== owner || meta.permissions?.length !== 1 || meta.permissions[0].type !== 'user' || meta.permissions[0].role !== 'owner' || meta.permissions[0].emailAddress !== owner)
            fail('Permission configuration and checkpoints must be owner-only JSON files.');
        return meta;
    }
    function readPrivate(id: string, owner: string) {
        return { meta: inspectPrivate(id, owner), value: api(`${drive(id)}?alt=media`) };
    }
    let cached: ReturnType<typeof load> | undefined;
    function load() {
        const raw = props.getProperty(HOST_PROPERTIES.config);
        if (!raw)
            return undefined;
        const host = parseStagingHostConfig(JSON.parse(raw)), owner = services.Session.getEffectiveUser().getEmail().trim().toLowerCase();
        if (owner !== host.expectedAutomationEmail)
            fail('Use the configured automation identity.');
        let binding: any = props.getProperty(PERMISSION_PROPERTIES.config);
        const rootId = props.getProperty(CONFIG_FILE_ID_PROPERTY);
        if (!binding && rootId)
            binding = readPrivate(rootId, owner).value[PERMISSION_PROPERTIES.config];
        if (!binding)
            return undefined;
        if (typeof binding === 'string')
            binding = JSON.parse(binding);
        if (binding.version !== 1 || !fileId(binding.configFileId) || binding.configFileId === rootId)
            fail('Bind a separate owner-private permission configuration file.');
        const config = parseNativePermissionConfig(readPrivate(binding.configFileId, owner).value, host.generation);
        if ([rootId, binding.configFileId].includes(config.stateFileId))
            fail('Permission state must be a separate private file.');
        const state = createPrivateCheckpoint<PermissionRefreshState>({
            version() { return String(inspectPrivate(config.stateFileId, owner).version); },
            read() { return api(`${drive(config.stateFileId)}?alt=media`); },
            write(value) { api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.stateFileId)}?uploadType=media&fields=id`, value); },
            validate(value) { const v = value as PermissionRefreshState & {
                environment: string;
                generation: number;
            }; if (v.version !== 1 || v.environment !== 'staging' || v.generation !== config.generation)
                fail('The permission checkpoint belongs to another generation.'); return v; }, digest: permissionCanonical
        });
        return { config, host, owner, state, readPrivate: (id: string) => readPrivate(id, owner).value };
    }
    return { load() { return cached ?? (cached = load()); }, applied() { const c = this.load(); if (!c?.config.enabled)
            return undefined; assertPermissionFenceClear(props); const applied = c.state.load().applied; if (!applied)
            fail('Apply the first trusted permission policy before processing native input or publication.'); return applied; } };
}
