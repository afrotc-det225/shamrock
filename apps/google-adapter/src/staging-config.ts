/** Import reviewed, nonsecret staging bindings from an automation-owned private JSON file.
 * This module never uploads files, installs triggers, enables processing or reads the bridge secret. */
import { AdapterError } from './index.js';
import { MAINTENANCE_PROPERTIES, parseNativeMaintenanceConfig } from './maintenance-config.js';
import { HOST_PROPERTIES, parseStagingHostConfig, type StagingHostConfig } from './staging-host.js';
import { NATIVE_PROPERTIES, parseNativePresentationConfig, type NativeProjectionConfig } from './native-runtime.js';

export const CONFIG_FILE_ID_PROPERTY = 'SHAMROCK_V3_CONFIG_FILE_ID';
const PROPERTY_LIMIT = 8_000;
const FILE_LIMIT = 65_536;
// Kept here without importing frontend-runtime, which already imports this module.
// Frontend bindings remain file-owned so later API updates do not require a UI import.
const FRONTEND_CONFIG_PROPERTY = 'SHAMROCK_V3_FRONTEND_CONFIG';
const FRONTEND_PAUSE_PROPERTY = 'SHAMROCK_V3_FRONTEND_PAUSED';
const FORMS_CONFIG_PROPERTY = 'SHAMROCK_V3_FORMS_CONFIG';
const FORMS_PAUSE_PROPERTY = 'SHAMROCK_V3_FORMS_PAUSED';
const FORM_INTAKE_PAUSE_PROPERTY = 'SHAMROCK_V3_FORM_INTAKE_PAUSED';
const ALLOWED: readonly string[] = [HOST_PROPERTIES.config, HOST_PROPERTIES.principals, HOST_PROPERTIES.attendanceCatalog,
  HOST_PROPERTIES.excusalCatalog, NATIVE_PROPERTIES.projectionConfig, NATIVE_PROPERTIES.presentationConfig, FRONTEND_CONFIG_PROPERTY, MAINTENANCE_PROPERTIES.config, FORMS_CONFIG_PROPERTY];
const REQUIRED = [HOST_PROPERTIES.config, HOST_PROPERTIES.principals, HOST_PROPERTIES.attendanceCatalog, NATIVE_PROPERTIES.projectionConfig];
type Json = Record<string, unknown>;
export interface StagingConfigurationServices {
  PropertiesService: { getScriptProperties(): {
    getProperty(key: string): string | null;
    setProperty(key: string, value: string): unknown;
    setProperties(values: Record<string, string>, deleteAllOthers: boolean): unknown;
    deleteProperty(key: string): unknown;
  } };
  UrlFetchApp: { fetch(url: string, options: {
    method: 'get'; headers: Record<string, string>; muteHttpExceptions: true;
    followRedirects: false; validateHttpsCertificates: true;
  }): { getResponseCode(): number; getContentText(): string } };
  ScriptApp: { getOAuthToken(): string };
  Session: { getEffectiveUser(): { getEmail(): string } };
}

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('configuration_invalid', 'Expected structured nonsecret staging configuration.');
  return value as Json;
}
function keys(value: Json, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail('configuration_invalid', 'Configuration contains unexpected or missing fields.');
  }
}
function bytes(value: string): number {
  try { return encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length; }
  catch { return fail('configuration_invalid', 'Configuration contains invalid Unicode.'); }
}
function json(text: string, limit: number): Json {
  if (!text || bytes(text) > limit) fail('configuration_size', 'Configuration exceeds its bounded staging size.');
  try { return object(JSON.parse(text)); }
  catch (error) { if (error instanceof AdapterError) throw error; return fail('configuration_invalid', 'Configuration contains invalid JSON.'); }
}
function email(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) fail('configuration_identity', 'The automation account identity could not be verified.');
  return value.trim().toLowerCase();
}
function id(value: unknown, limit = 128): string {
  if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail('configuration_invalid', 'A configured logical identifier is invalid.');
  return value;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('configuration_invalid', 'A configured version or position is invalid.');
  return value;
}
/** The host parser owns host field validation; this only rejects ignored extra fields. */
function sameShape(value: unknown, parsed: unknown): void {
  if (Array.isArray(parsed)) {
    if (!Array.isArray(value) || value.length !== parsed.length) fail('configuration_invalid', 'Configuration structure is invalid.');
    parsed.forEach((item, index) => sameShape(value[index], item));
  } else if (parsed && typeof parsed === 'object') {
    const source = object(value); const expected = parsed as Json;
    keys(source, Object.keys(expected));
    Object.keys(expected).forEach(key => sameShape(source[key], expected[key]));
  }
}
function validatePrincipals(value: Json) {
  keys(value, ['entries']);
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 50) fail('configuration_invalid', 'Configure a bounded enrolled-principal registry.');
  const seen = new Set<string>();
  for (const raw of value.entries) {
    const entry = object(raw); keys(entry, ['email', 'principalId'], ['personId']);
    const address = email(entry.email); id(entry.principalId);
    if (entry.personId !== undefined) id(entry.personId);
    if (seen.has(address)) fail('configuration_invalid', 'Enrolled email mappings must be unique.');
    seen.add(address);
  }
}
function validateCatalog(value: Json) {
  keys(value, ['references']); const references = object(value.references);
  if (Object.keys(references).length > 500) fail('configuration_invalid', 'The staging choice catalog is too large.');
  for (const [token, raw] of Object.entries(references)) {
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(token)) fail('configuration_invalid', 'A choice token is invalid.');
    const reference = object(raw);
    if (reference.kind === 'event') { keys(reference, ['kind', 'eventId']); id(reference.eventId); }
    else if (reference.kind === 'person') { keys(reference, ['kind', 'personId']); id(reference.personId); }
    else if (reference.kind === 'scope') {
      keys(reference, ['kind', 'unitId', 'rosterVersion', 'coveredPersonIds']); id(reference.unitId); integer(reference.rosterVersion);
      if (!Array.isArray(reference.coveredPersonIds) || reference.coveredPersonIds.length < 1 || reference.coveredPersonIds.length > 500) fail('configuration_invalid', 'A choice scope needs a bounded roster snapshot.');
      const people = reference.coveredPersonIds.map(value => id(value));
      if (new Set(people).size !== people.length) fail('configuration_invalid', 'A roster snapshot contains duplicate people.');
    } else fail('configuration_invalid', 'A choice reference has an unsupported kind.');
  }
}
function validateProjection(value: Json, host: StagingHostConfig) {
  const kinds = ['attendance', 'decisions', 'cursors'] as const;
  keys(value, ['version', 'environment', 'generation', 'workerId', ...kinds]);
  if (value.version !== 1 || value.environment !== 'staging' || integer(value.generation) !== host.generation) fail('configuration_invalid', 'Projection configuration must match the staging generation.');
  id(value.workerId);
  const targets = new Set<string>();
  for (const kind of kinds) {
    const ref = object(value[kind]); keys(ref, ['spreadsheetId', 'sheetId']);
    if (typeof ref.spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(ref.spreadsheetId)) fail('configuration_invalid', 'An existing projection workbook binding is invalid.');
    integer(ref.sheetId, 0);
    const key = JSON.stringify([ref.spreadsheetId, ref.sheetId]);
    if (targets.has(key) || (ref.spreadsheetId === host.journal.spreadsheetId && (kind !== 'cursors' || ref.sheetId === host.journal.sheetId))
      || (host.decisionInput && ref.spreadsheetId === host.decisionInput.spreadsheetId && ref.sheetId === host.decisionInput.sheetId)) {
      fail('configuration_invalid', 'Projection outputs must not overwrite each other, the journal or decision inputs.');
    }
    targets.add(key);
  }
}

export function importStagingConfiguration(services: StagingConfigurationServices): { status: 'imported-paused'; propertyCount: number; next: 'setup-required' } {
  const properties = services.PropertiesService.getScriptProperties();
  // Pause before even reading the proposed configuration; this does not cancel an already-running execution.
  try {
    properties.setProperty(HOST_PROPERTIES.enabled, 'false');
    properties.setProperty(FRONTEND_PAUSE_PROPERTY, 'true');
    properties.setProperty(MAINTENANCE_PROPERTIES.paused, 'true');
    properties.setProperty(FORMS_PAUSE_PROPERTY, 'true'); properties.setProperty(FORM_INTAKE_PAUSE_PROPERTY, 'true');
    if (properties.getProperty(HOST_PROPERTIES.enabled) !== 'false' || properties.getProperty(FRONTEND_PAUSE_PROPERTY) !== 'true' || properties.getProperty(MAINTENANCE_PROPERTIES.paused) !== 'true' || properties.getProperty(FORMS_PAUSE_PROPERTY) !== 'true' || properties.getProperty(FORM_INTAKE_PAUSE_PROPERTY) !== 'true') throw new Error('Pause was not persisted.');
  } catch { return fail('configuration_write_failed', 'Processing could not be paused; configuration was not imported.'); }
  let executor = '';
  try { executor = email(services.Session.getEffectiveUser().getEmail()); } catch { /* fail closed below */ }
  if (!executor) fail('configuration_identity', 'Run configuration import under the intended automation account.');
  const fileId = properties.getProperty(CONFIG_FILE_ID_PROPERTY);
  if (!fileId || !/^[A-Za-z0-9_-]{1,512}$/.test(fileId)) fail('configuration_file_required', 'Set the private configuration file ID in Script Properties first.');
  let token = '';
  try { token = services.ScriptApp.getOAuthToken(); } catch { /* fail closed below */ }
  if (!token) fail('configuration_authorization', 'Authorize private Drive metadata and content reads first.');
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  function fetchText(url: string, limit: number): string {
    let response: ReturnType<StagingConfigurationServices['UrlFetchApp']['fetch']>;
    try { response = services.UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true }); }
    catch { return fail('configuration_fetch_failed', 'Google could not confirm the private configuration read.'); }
    if (response.getResponseCode() !== 200) fail('configuration_fetch_failed', 'Google did not authorize or complete the private configuration read.');
    const text = response.getContentText();
    if (bytes(text) > limit) fail('configuration_size', 'Google returned an oversized configuration response.');
    return text;
  }
  const metadata = json(fetchText(`${fileUrl}?supportsAllDrives=true&fields=${encodeURIComponent('id,mimeType,size,driveId,trashed,owners(emailAddress)')}`, 16_384), 16_384);
  if (metadata.id !== fileId || metadata.mimeType !== 'application/json' || metadata.driveId || metadata.trashed === true
    || !Array.isArray(metadata.owners) || metadata.owners.length !== 1 || email(object(metadata.owners[0]).emailAddress) !== executor) {
    fail('configuration_owner_required', 'Use a private JSON file owned by the executing automation account outside Shared Drives.');
  }
  if (typeof metadata.size !== 'string' || !/^[0-9]+$/.test(metadata.size) || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 1 || Number(metadata.size) > FILE_LIMIT) {
    fail('configuration_size', 'The private JSON configuration must fit within 64 KiB.');
  }
  let pageToken = ''; let ownerCount = 0; const seen = new Set<string>();
  do {
    const page = json(fetchText(`${fileUrl}/permissions?supportsAllDrives=true&pageSize=100&fields=${encodeURIComponent('nextPageToken,permissions(type,role,emailAddress,deleted)')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, 32_768), 32_768);
    if (!Array.isArray(page.permissions) || page.permissions.length > 100) fail('configuration_private_required', 'Configuration sharing could not be fully verified.');
    for (const raw of page.permissions) {
      const permission = object(raw);
      if (permission.deleted === true) continue;
      if (permission.type !== 'user' || permission.role !== 'owner' || email(permission.emailAddress) !== executor || ++ownerCount !== 1) {
        fail('configuration_private_required', 'The configuration file must be accessible only to its automation-account owner.');
      }
    }
    if (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') fail('configuration_private_required', 'Configuration sharing pagination is invalid.');
    pageToken = page.nextPageToken as string | undefined ?? '';
    if (pageToken && (seen.has(pageToken) || seen.size >= 10 || pageToken.length > 2048)) fail('configuration_private_required', 'Configuration sharing pagination could not be completed.');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  if (ownerCount !== 1) fail('configuration_private_required', 'The configuration owner permission could not be verified.');
  const source = fetchText(`${fileUrl}?alt=media`, FILE_LIMIT);
  if (bytes(source) !== Number(metadata.size)) fail('configuration_changed', 'The configuration file changed during import; retry after saving it.');
  const map = json(source, FILE_LIMIT);
  if (Object.keys(map).some(key => !ALLOWED.includes(key)) || REQUIRED.some(key => !Object.prototype.hasOwnProperty.call(map, key))) {
    fail('configuration_keys', 'Import only the approved nonsecret staging property names.');
  }
  const pending: Record<string, string> = {}; const parsed: Record<string, Json> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string') fail('configuration_invalid', 'Each imported property must contain a JSON string.');
    parsed[key] = json(value, key === FRONTEND_CONFIG_PROPERTY ? 16_000 : PROPERTY_LIMIT);
    if (key !== FRONTEND_CONFIG_PROPERTY && key !== MAINTENANCE_PROPERTIES.config && key !== FORMS_CONFIG_PROPERTY) pending[key] = value;
  }
  const host = parseStagingHostConfig(parsed[HOST_PROPERTIES.config]); sameShape(parsed[HOST_PROPERTIES.config], host);
  if (host.expectedAutomationEmail !== executor) fail('configuration_identity', 'The proposed staging configuration belongs to a different automation account.');
  if (host.excusal && !pending[HOST_PROPERTIES.excusalCatalog]) fail('configuration_keys', 'The configured excusal Form requires its choice catalog.');
  validatePrincipals(parsed[HOST_PROPERTIES.principals]); validateCatalog(parsed[HOST_PROPERTIES.attendanceCatalog]);
  if (parsed[HOST_PROPERTIES.excusalCatalog]) validateCatalog(parsed[HOST_PROPERTIES.excusalCatalog]);
  validateProjection(parsed[NATIVE_PROPERTIES.projectionConfig], host);
  if (parsed[NATIVE_PROPERTIES.presentationConfig]) {
    parseNativePresentationConfig(parsed[NATIVE_PROPERTIES.presentationConfig], host,
      parsed[NATIVE_PROPERTIES.projectionConfig] as unknown as NativeProjectionConfig);
  }
  const forms = parsed[FORMS_CONFIG_PROPERTY];
  if (forms) { keys(forms, ['version', 'configFileId']); if (forms.version !== 1) fail('configuration_invalid', 'Unsupported managed Forms configuration.'); id(forms.configFileId, 512); if (forms.configFileId === fileId) fail('configuration_invalid', 'Managed Forms config needs a separate owner-only file.'); }
  const frontend = parsed[FRONTEND_CONFIG_PROPERTY];
  if (frontend) {
    keys(frontend, ['version', 'environment', 'generation', 'enabled', 'resourceReview', 'workerId', 'principalId', 'stateFileId', 'main', 'allowedFileEditors', 'access', 'seeds'], ['supplemental']);
    if (frontend.version !== 1 || frontend.environment !== 'staging' || frontend.generation !== host.generation || typeof frontend.enabled !== 'boolean'
      || frontend.resourceReview !== 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING') fail('configuration_invalid', 'Frontend configuration must match the reviewed staging generation.');
    id(frontend.workerId); id(frontend.principalId); id(frontend.stateFileId, 512);
    const main = object(frontend.main); keys(main, ['spreadsheetId', 'expectedTitle', 'sheets']); id(main.spreadsheetId, 512);
    if (typeof main.expectedTitle !== 'string' || main.expectedTitle.length > 200 || !/staging/i.test(main.expectedTitle)
      || !Array.isArray(frontend.allowedFileEditors) || !Array.isArray(frontend.seeds)) fail('configuration_invalid', 'Frontend configuration requires an exact staging binding and bounded access/seed lists.');
    const access = object(frontend.access);
    if (email(access.ownerEmail) !== executor || email(access.automationEmail) !== executor) fail('configuration_identity', 'Frontend ownership must match the staging account.');
    if (main.spreadsheetId === host.journal.spreadsheetId || main.spreadsheetId === host.decisionInput?.spreadsheetId
      || frontend.stateFileId === main.spreadsheetId || frontend.stateFileId === fileId) fail('configuration_invalid', 'Frontend, private state and existing transport resources must remain separate.');
    // Full native binding, role and seed validation occurs before a refresh can write.
    // Import never copies this optional file-owned value into Script Properties.
  }

  if (parsed[MAINTENANCE_PROPERTIES.config]) parseNativeMaintenanceConfig(parsed[MAINTENANCE_PROPERTIES.config], host.generation);

  // All file, ACL and configuration validation finishes before any configuration mutation.
  // PropertiesService offers no transaction guarantee: a provider write failure stays paused
  // with setup receipts removed, and must never be reported as a completed import.
  try {
    properties.deleteProperty(HOST_PROPERTIES.setupReceipt);
    properties.deleteProperty(NATIVE_PROPERTIES.projectionReceipt);
    properties.deleteProperty(NATIVE_PROPERTIES.presentationReceipt);
    properties.deleteProperty(FRONTEND_CONFIG_PROPERTY);
    properties.deleteProperty(MAINTENANCE_PROPERTIES.config);
    properties.deleteProperty(FORMS_CONFIG_PROPERTY);
    properties.setProperties(pending, false);
    if (!pending[HOST_PROPERTIES.excusalCatalog]) properties.deleteProperty(HOST_PROPERTIES.excusalCatalog);
    if (!pending[NATIVE_PROPERTIES.presentationConfig]) properties.deleteProperty(NATIVE_PROPERTIES.presentationConfig);
    if (Object.entries(pending).some(([key, value]) => properties.getProperty(key) !== value)
      || (!pending[HOST_PROPERTIES.excusalCatalog] && properties.getProperty(HOST_PROPERTIES.excusalCatalog) !== null)
      || (!pending[NATIVE_PROPERTIES.presentationConfig] && properties.getProperty(NATIVE_PROPERTIES.presentationConfig) !== null)
      || properties.getProperty(HOST_PROPERTIES.enabled) !== 'false'
      || properties.getProperty(MAINTENANCE_PROPERTIES.paused) !== 'true' || properties.getProperty(MAINTENANCE_PROPERTIES.config) !== null
      || properties.getProperty(FRONTEND_PAUSE_PROPERTY) !== 'true' || properties.getProperty(FRONTEND_CONFIG_PROPERTY) !== null
      || properties.getProperty(FORMS_PAUSE_PROPERTY) !== 'true' || properties.getProperty(FORM_INTAKE_PAUSE_PROPERTY) !== 'true' || properties.getProperty(FORMS_CONFIG_PROPERTY) !== null
      || properties.getProperty(HOST_PROPERTIES.setupReceipt) !== null || properties.getProperty(NATIVE_PROPERTIES.projectionReceipt) !== null
      || properties.getProperty(NATIVE_PROPERTIES.presentationReceipt) !== null) {
      fail('configuration_write_failed', 'Configuration persistence could not be verified; processing remains paused.');
    }
  } catch { return fail('configuration_write_failed', 'Configuration persistence could not be verified; run setup only after a successful import.'); }
  return { status: 'imported-paused', propertyCount: Object.keys(pending).length, next: 'setup-required' };
}
