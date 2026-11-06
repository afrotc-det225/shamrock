import { AdapterError } from './index.js';
export const MAINTENANCE_PROPERTIES = { config: 'SHAMROCK_V3_MAINTENANCE_CONFIG', paused: 'SHAMROCK_V3_MAINTENANCE_PAUSED' } as const;
export interface NativeMaintenanceConfig {
    version: 1;
    environment: 'staging';
    generation: number;
    enabled: boolean;
    resourceReview: 'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING';
    principalId: string;
    workerId: string;
    sourceResource: string;
    stateFileId: string;
    archiveSpreadsheetId: string;
    archiveExpectedTitle: string;
}
export function parseNativeMaintenanceConfig(value: unknown, generation: number): NativeMaintenanceConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AdapterError('maintenance_config', 'Expected private maintenance bindings.');
    const r = value as Record<string, unknown>;
    const keys = ['version', 'environment', 'generation', 'enabled', 'resourceReview', 'principalId', 'workerId', 'sourceResource', 'stateFileId', 'archiveSpreadsheetId', 'archiveExpectedTitle'];
    if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) || r.version !== 1 || r.environment !== 'staging'
        || r.generation !== generation || typeof r.enabled !== 'boolean' || r.resourceReview !== 'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING'
        || ['principalId', 'workerId', 'sourceResource'].some(k => typeof r[k] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(String(r[k])))
        || ['stateFileId', 'archiveSpreadsheetId'].some(k => typeof r[k] !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(String(r[k])))
        || r.stateFileId === r.archiveSpreadsheetId || typeof r.archiveExpectedTitle !== 'string' || !/staging/i.test(r.archiveExpectedTitle) || r.archiveExpectedTitle.length > 200)
        throw new AdapterError('maintenance_config', 'Bind separate reviewed staging maintenance resources and an explicit generation.');
    return { version: 1, environment: 'staging', generation, enabled: r.enabled,
        resourceReview: 'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING',
        principalId: String(r.principalId), workerId: String(r.workerId), sourceResource: String(r.sourceResource),
        stateFileId: String(r.stateFileId), archiveSpreadsheetId: String(r.archiveSpreadsheetId), archiveExpectedTitle: r.archiveExpectedTitle };
}
