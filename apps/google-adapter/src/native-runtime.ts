/** Native Google services for the explicitly configured staging host. No resources,
 * permissions or triggers are provisioned by this module. */
import { AdapterError, type AdapterConfig, type Signer, type Transport } from './index.js';
import { createGoogleSigner, type SheetPort, type ScriptLockPort } from './apps-script.js';
import { appendProjectionDecisionSlots, initializeDynamicDecisionSlots, readDynamicDecisionSlots, DYNAMIC_DECISION_HEADERS } from './decision-slots.js';
import { planPresentationRepair, planPresentationGrowth, verifyPresentation, chunkPresentationRequests,
  type PresentationInput, type PresentationSurface, type SheetsMetadata } from './presentation.js';
import {
  createStagingHost, HOST_PROPERTIES, parseStagingHostConfig,
  type ExistingSheetReference, type StagingHostConfig, type StagingHostRuntime,
} from './staging-host.js';
import {
  consumeProjectionJobs, initializeProjectionSheets, upgradeRecordedDecisionLabels, PROJECTION_HEADERS,
  type ProjectionClaim, type ProjectionClaimStore, type ProjectionSheetKind,
  type ProjectionSheetPort, type ProjectionSheets,
} from './projection.js';

export const NATIVE_PROPERTIES = {
  projectionConfig: 'SHAMROCK_V3_PROJECTION_CONFIG',
  projectionReceipt: 'SHAMROCK_V3_PROJECTION_SETUP',
  projectionClaim: 'SHAMROCK_V3_PROJECTION_CLAIM',
  presentationConfig: 'SHAMROCK_V3_PRESENTATION_CONFIG',
  presentationReceipt: 'SHAMROCK_V3_PRESENTATION_SETUP',
} as const;

interface NativeProperties {
  getProperty(key: string): string | null;
  setProperty(key: string, value: string): unknown;
  deleteProperty(key: string): unknown;
}
interface NativeSheet {
  getSheetId(): number;
  getName(): string;
  getLastRow(): number;
  getLastColumn(): number;
}
interface NativeSpreadsheet { getId(): string; getSheets(): NativeSheet[] }
export interface NativeStagingServices {
  PropertiesService: { getScriptProperties(): NativeProperties };
  Utilities: StagingHostRuntime['utilities'];
  UrlFetchApp: StagingHostRuntime['urlFetch'];
  ScriptApp: StagingHostRuntime['scriptApp'];
  Session: StagingHostRuntime['session'];
  FormApp: { openById(id: string): ReturnType<StagingHostRuntime['formApp']['openById']> & {
    getItems(): { getId(): number }[];
  } };
  SpreadsheetApp: { openById(id: string): NativeSpreadsheet; flush(): void };
  LockService: { getScriptLock(): ScriptLockPort };
  nowSeconds?: () => number;
}
export interface NativeProjectionConfig {
  version: 1;
  environment: 'staging';
  generation: number;
  workerId: string;
  attendance: ExistingSheetReference;
  decisions: ExistingSheetReference;
  cursors: ExistingSheetReference;
}
export interface NativePresentationConfig {
  version: 1;
  environment: 'staging';
  generation: number;
  legend: ExistingSheetReference;
}
type Json = Record<string, unknown>;
type Cell = string | number | boolean;
type BoundSheet = SheetPort & ProjectionSheetPort & { getSheetId(): number };
const KINDS: ProjectionSheetKind[] = ['attendance', 'decisions', 'cursors'];
// Invalidate setup evidence when the protected slot identity/schema contract changes,
// even when the private resource IDs and staging generation remain the same.
const NATIVE_CONTRACT = 'dynamic-decision-v2:presentation-v1';

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('native_configuration', 'Expected structured staging configuration or metadata.');
  return value as Json;
}
function positive(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('native_configuration', 'A configured number is invalid.');
  return value;
}
function reference(value: unknown): ExistingSheetReference {
  const v = object(value);
  if (typeof v.spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v.spreadsheetId)) fail('native_configuration', 'An existing workbook binding is invalid.');
  return { spreadsheetId: v.spreadsheetId, sheetId: positive(v.sheetId, 0) };
}
function sameRef(left: ExistingSheetReference, right: ExistingSheetReference): boolean {
  return left.spreadsheetId === right.spreadsheetId && left.sheetId === right.sheetId;
}
function canonicalEmail(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) fail('native_identity', 'Google account identity could not be verified.');
  return value.trim().toLowerCase();
}
function columnName(column: number): string {
  let result = '';
  for (let n = positive(column); n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

/** Optional presentation binds only an existing, separate tab in the reviewed operator workbook. */
export function parseNativePresentationConfig(value: unknown, host: StagingHostConfig, projection: NativeProjectionConfig): NativePresentationConfig {
  const v = object(value);
  if (Object.keys(v).sort().join(',') !== 'environment,generation,legend,version'
    || v.version !== 1 || v.environment !== 'staging' || positive(v.generation) !== host.generation
    || projection.environment !== 'staging' || projection.generation !== host.generation
    || host.decisionInput?.mode !== 'projection') fail('native_configuration', 'Presentation requires reviewed staging projection and dynamic input bindings.');
  const raw = object(v.legend);
  if (Object.keys(raw).sort().join(',') !== 'sheetId,spreadsheetId') fail('native_configuration', 'The presentation legend binding contains unexpected fields.');
  const legend = reference(raw);
  if ([projection.attendance, projection.decisions, host.decisionInput].some(ref => ref.spreadsheetId !== legend.spreadsheetId || sameRef(ref, legend))
    || legend.spreadsheetId === host.journal.spreadsheetId || sameRef(legend, projection.cursors)) {
    fail('native_configuration', 'Presentation surfaces and a distinct legend must share the reviewed operator workbook.');
  }
  return { version: 1, environment: 'staging', generation: host.generation, legend };
}

export function createNativeStagingRuntime(services: NativeStagingServices): StagingHostRuntime & {
  initializeProjections(): { status: string }; repairPresentation(): { status: string; requests?: number };
} {
  const properties = services.PropertiesService.getScriptProperties();
  const nativeLock = services.LockService.getScriptLock();
  let lockHeld = false;
  const reads = new Map<string, string>();
  const extents = new Map<string, { rows: number; columns: number }>();
  const sharedLock: ScriptLockPort = {
    tryLock(milliseconds) {
      if (lockHeld || !nativeLock.tryLock(milliseconds)) return false;
      // Another cooperating execution may have written since our last lock section.
      reads.clear(); extents.clear(); lockHeld = true;
      return true;
    },
    releaseLock() {
      reads.clear(); extents.clear(); lockHeld = false;
      nativeLock.releaseLock();
    },
  };
  function readJson(key: string): { raw: string; value: Json } {
    const raw = properties.getProperty(key);
    if (!raw || encodeURIComponent(raw).replace(/%[A-F0-9]{2}/g, 'x').length > 8000) fail('native_configuration', 'Required private staging configuration is missing or too large.');
    try { return { raw, value: object(JSON.parse(raw)) }; }
    catch { return fail('native_configuration', 'Private staging configuration contains invalid JSON.'); }
  }
  function host() {
    const saved = readJson(HOST_PROPERTIES.config);
    const config = parseStagingHostConfig(saved.value);
    let executor = '';
    try { executor = canonicalEmail(services.Session.getEffectiveUser().getEmail()); } catch { /* fail closed */ }
    if (executor !== config.expectedAutomationEmail) fail('wrong_automation_identity', 'Run this host under the configured staging automation account.');
    return { config, raw: saved.raw };
  }
  function api(url: string, body?: unknown): Json {
    const cached = body === undefined && lockHeld ? reads.get(url) : undefined;
    if (cached !== undefined) return object(JSON.parse(cached));
    const token = services.ScriptApp.getOAuthToken();
    if (!token) fail('google_authorization', 'Authorize the staging Google services before continuing.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && payload.length > 2_000_000) fail('google_request_size', 'The bounded Google request is too large.');
    let response: ReturnType<StagingHostRuntime['urlFetch']['fetch']>;
    try {
      response = services.UrlFetchApp.fetch(url, {
        method: body === undefined ? 'get' : 'post', headers: { Authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload, contentType: 'application/json' }),
        muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true,
      });
    } catch { return fail('google_transport', 'A Google request did not complete; saved work was retained.'); }
    const status = response.getResponseCode();
    if (status !== 200) {
      // Expose only fixed labels and a valid HTTP integer. Google error bodies can
      // include resource identifiers, request values and account information.
      const safeStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? String(status) : 'unknown';
      const category = status === 429 ? 'rate-limited' : status === 401 ? 'authorization'
        : status === 403 ? 'forbidden' : status === 404 ? 'not-found'
          : status === 400 || status === 422 ? 'invalid-request'
            : status === 408 || status === 504 ? 'timeout'
              : status >= 500 && status <= 599 ? 'server-error' : 'other';
      const service = url.startsWith('https://sheets.googleapis.com/') ? 'Sheets'
        : url.startsWith('https://www.googleapis.com/drive/') ? 'Drive' : 'API';
      const operation = body === undefined ? 'read' : 'write';
      fail(body === undefined ? 'google_read_failed' : 'google_write_failed',
        `Google ${service} ${operation} failed (HTTP ${safeStatus}; ${category}). Saved work was retained.`);
    }
    const text = response.getContentText();
    if (text.length > 2_000_000) fail('google_response_size', 'Google returned an unexpectedly large response.');
    try {
      const result = object(JSON.parse(text));
      if (body === undefined && lockHeld) reads.set(url, text);
      return result;
    }
    catch { return fail('google_response', 'Google returned invalid structured metadata.'); }
  }
  function sheetsUrl(id: string): string { return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`; }
  function openNative(ref: ExistingSheetReference): NativeSheet {
    let book: NativeSpreadsheet;
    try { book = services.SpreadsheetApp.openById(ref.spreadsheetId); }
    catch { return fail('configured_resource_unavailable', 'A configured staging workbook is unavailable.'); }
    const sheet = book.getSheets().find(item => item.getSheetId() === ref.sheetId);
    if (book.getId() !== ref.spreadsheetId || !sheet) fail('configured_resource_unavailable', 'A configured existing staging tab is unavailable.');
    return sheet;
  }
  const boundSheets = new Map<string, BoundSheet>();
  function bindSheet(ref: ExistingSheetReference, native?: NativeSheet): BoundSheet {
    const cacheKey = JSON.stringify([ref.spreadsheetId, ref.sheetId]);
    const cached = boundSheets.get(cacheKey);
    if (cached) return cached;
    const source = native ?? openNative(ref);
    function extent(): { rows: number; columns: number } {
      const cached = lockHeld ? extents.get(cacheKey) : undefined;
      if (cached) return cached;
      const title = `'${source.getName().replace(/'/g, "''")}'`;
      const data = api(`${sheetsUrl(ref.spreadsheetId)}/values/${encodeURIComponent(title)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
      const values = data.values ?? [];
      if (!Array.isArray(values) || values.length > 2002 || values.some(row => !Array.isArray(row) || row.length > 100)) {
        fail('google_request_size', 'The configured staging table exceeds its bounded capacity.');
      }
      const result = { rows: values.length, columns: Math.max(0, ...values.map(row => row.length)) };
      if (lockHeld) extents.set(cacheKey, result);
      return result;
    }
    function range(row: number, column: number, rows: number, columns: number): string {
      [row, column, rows, columns].forEach(v => positive(v));
      if (rows > 2002 || columns > 100 || rows * columns > 30_000) fail('google_request_size', 'The requested staging range exceeds its bound.');
      return `'${source.getName().replace(/'/g, "''")}'!${columnName(column)}${row}:${columnName(column + columns - 1)}${row + rows - 1}`;
    }
    function writeRaw(row: number, column: number, input: unknown[][]): void {
      if (!Array.isArray(input) || !input.length || !Array.isArray(input[0]) || !input[0].length) fail('google_values', 'A nonempty rectangular output range is required.');
      const width = input[0].length;
      if (input.some(cells => !Array.isArray(cells) || cells.length !== width || cells.some(cell => !['string', 'number', 'boolean'].includes(typeof cell) || (typeof cell === 'number' && !Number.isFinite(cell))))) {
        fail('google_values', 'Only bounded literal spreadsheet values are supported.');
      }
      const a1 = range(row, column, input.length, width);
      const result = api(`${sheetsUrl(ref.spreadsheetId)}/values:batchUpdate`, {
        valueInputOption: 'RAW', data: [{ range: a1, majorDimension: 'ROWS', values: input }],
      });
      if (result.totalUpdatedCells !== input.length * width) fail('google_write_unconfirmed', 'Google did not confirm the complete output range.');
      // Keep only operation-local ownership/protection metadata. Every cell and
      // formula read-back after a write must reach Google again.
      const prefix = sheetsUrl(ref.spreadsheetId);
      for (const url of reads.keys()) {
        if (url.startsWith(`${prefix}/values/`) || url.startsWith(`${prefix}?ranges=`)) reads.delete(url);
      }
      const previous = lockHeld ? extents.get(cacheKey) : undefined;
      if (previous) extents.set(cacheKey, { rows: Math.max(previous.rows, row + input.length - 1), columns: Math.max(previous.columns, column + width - 1) });
    }
    const bound: BoundSheet = {
      getSheetId: () => source.getSheetId(),
      // Cooperating executions can append between separate journal lock sections.
      // REST extent reads avoid both native cache staleness and local row allocators.
      getLastRow: () => extent().rows,
      getLastColumn: () => extent().columns,
      writeRaw: (row, column, values: Cell[][]) => writeRaw(row, column, values),
      getRange(row, column, rows, columns) {
        const a1 = range(row, column, rows, columns);
        return {
          getValues() {
            const data = api(`${sheetsUrl(ref.spreadsheetId)}/values/${encodeURIComponent(a1)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
            const values = data.values === undefined ? [] : data.values;
            if (!Array.isArray(values) || values.length > rows || values.some(v => !Array.isArray(v) || v.length > columns)) fail('google_values', 'Google returned an unexpected range shape.');
            return Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => (values[r] as unknown[] | undefined)?.[c] ?? ''));
          },
          getFormulas() {
            const data = api(`${sheetsUrl(ref.spreadsheetId)}?ranges=${encodeURIComponent(a1)}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(rowData(values(userEnteredValue(formulaValue)))))')}`);
            if (!Array.isArray(data.sheets) || data.sheets.length !== 1 || object(object(data.sheets[0]).properties).sheetId !== ref.sheetId) fail('google_values', 'Formula metadata did not match the bound tab.');
            const blocks = object(data.sheets[0]).data ?? [];
            if (!Array.isArray(blocks) || blocks.length > 1) fail('google_values', 'Google returned unexpected formula metadata.');
            // Partial response masks may omit all GridData when no formulaValue
            // fields exist. The requested tab identity was verified above.
            const rowData = blocks.length ? object(blocks[0]).rowData ?? [] : [];
            if (!Array.isArray(rowData) || rowData.length > rows) fail('google_values', 'Google returned unexpected formula rows.');
            return Array.from({ length: rows }, (_, r) => {
              const cells = r < rowData.length ? object(rowData[r]).values ?? [] : [];
              if (!Array.isArray(cells) || cells.length > columns) fail('google_values', 'Google returned unexpected formula cells.');
              return Array.from({ length: columns }, (_, c) => {
                const entered = c < cells.length ? object(cells[c]).userEnteredValue : undefined;
                const formula = entered === undefined ? undefined : object(entered).formulaValue;
                if (formula !== undefined && typeof formula !== 'string') fail('google_values', 'Google returned invalid formula metadata.');
                return formula ?? '';
              });
            });
          },
          setValues(values: unknown[][]) {
            if (values.length !== rows || values.some(cells => cells.length !== columns)) fail('google_values', 'Output values do not match the requested range.');
            writeRaw(row, column, values);
          },
        };
      },
    };
    boundSheets.set(cacheKey, bound);
    return bound;
  }
  function assertOwnedFile(id: string, mimeType: string): void {
    const { config } = host();
    const data = api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent('id,mimeType,driveId,owners(emailAddress)')}`);
    if (data.id !== id || data.mimeType !== mimeType || data.driveId
      || !Array.isArray(data.owners) || data.owners.length !== 1 || canonicalEmail(object(data.owners[0]).emailAddress) !== config.expectedAutomationEmail) {
      fail('staging_owner_required', 'The staging resource must be owned by its configured automation account.');
    }
  }
  function assertTrustedFile(id: string, mimeType: string, allowReadOnly: boolean): void {
    assertOwnedFile(id, mimeType); const { config } = host();
    let pageToken = ''; let sawOwner = false; const seen = new Set<string>();
    do {
      const data = api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/permissions?supportsAllDrives=true&pageSize=100&fields=${encodeURIComponent('nextPageToken,permissions(type,role,emailAddress,deleted)')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (!Array.isArray(data.permissions)) fail('private_resource_required', 'Resource sharing could not be fully verified.');
      for (const value of data.permissions) {
        const p = object(value);
        if (p.deleted === true) continue;
        if (allowReadOnly && (p.role === 'reader' || p.role === 'commenter')) continue;
        if (p.type !== 'user' || canonicalEmail(p.emailAddress) !== config.expectedAutomationEmail || !['owner', 'writer', 'reader', 'commenter'].includes(String(p.role))) {
          fail('private_resource_required', allowReadOnly ? 'Only the staging automation account may edit the source Form.' : 'The command journal must be private to the staging automation account.');
        }
        if (p.role === 'owner') sawOwner = true;
      }
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') fail('private_resource_required', 'Resource sharing pagination is invalid.');
      pageToken = data.nextPageToken as string | undefined ?? '';
      if (pageToken && (seen.has(pageToken) || seen.size >= 25)) fail('private_resource_required', 'Resource sharing pagination could not be completed.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    if (!sawOwner) fail('private_resource_required', 'Resource owner access could not be verified.');
  }
  function protection(ref: ExistingSheetReference): Json {
    assertOwnedFile(ref.spreadsheetId, 'application/vnd.google-apps.spreadsheet');
    const data = api(`${sheetsUrl(ref.spreadsheetId)}?fields=${encodeURIComponent('spreadsheetId,sheets(properties(sheetId),protectedRanges(range,warningOnly,editors,unprotectedRanges))')}`);
    if (data.spreadsheetId !== ref.spreadsheetId || !Array.isArray(data.sheets)) fail('protection_unverified', 'The output protection metadata is unavailable.');
    const sheets = data.sheets.map(object).filter(s => object(s.properties).sheetId === ref.sheetId);
    const ranges = sheets.length === 1 ? sheets[0].protectedRanges : undefined;
    if (!Array.isArray(ranges) || ranges.length !== 1) fail('protection_unverified', 'Use one strict whole-tab protection for the staging table.');
    const p = object(ranges[0]); const range = object(p.range); const editors = p.editors === undefined ? {} : object(p.editors);
    const { config } = host();
    const users = editors.users ?? []; const groups = editors.groups ?? [];
    if (range.sheetId !== ref.sheetId || (range.startRowIndex !== undefined && range.startRowIndex !== 0)
      || (range.startColumnIndex !== undefined && range.startColumnIndex !== 0) || range.endRowIndex !== undefined || range.endColumnIndex !== undefined
      || p.warningOnly === true || editors.domainUsersCanEdit === true || !Array.isArray(groups) || groups.length !== 0
      || !Array.isArray(users) || users.some(user => canonicalEmail(user) !== config.expectedAutomationEmail)) {
      fail('protection_unverified', 'The staging table allows an unapproved editor or is not fully protected.');
    }
    if (p.unprotectedRanges !== undefined && !Array.isArray(p.unprotectedRanges)) fail('protection_unverified', 'The staging protection exceptions are invalid.');
    return p;
  }
  function projectionBinding() {
    const h = host(); const saved = readJson(NATIVE_PROPERTIES.projectionConfig); const v = saved.value;
    if (Object.keys(v).sort().join(',') !== ['version', 'environment', 'generation', 'workerId', ...KINDS].sort().join(',')
      || v.version !== 1 || v.environment !== 'staging' || positive(v.generation) !== h.config.generation
      || typeof v.workerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.workerId)) {
      fail('native_configuration', 'The projection binding must match the reviewed staging generation.');
    }
    const config: NativeProjectionConfig = { version: 1, environment: 'staging', generation: h.config.generation, workerId: v.workerId,
      attendance: reference(v.attendance), decisions: reference(v.decisions), cursors: reference(v.cursors) };
    for (const kind of KINDS) {
      if ((kind !== 'cursors' && config[kind].spreadsheetId === h.config.journal.spreadsheetId)
        || sameRef(config[kind], h.config.journal)
        || (h.config.decisionInput && sameRef(config[kind], h.config.decisionInput))
        || KINDS.some(other => other !== kind && sameRef(config[kind], config[other]))) fail('native_configuration', 'Projection outputs must be distinct from each other, the private journal, and decision inputs.');
    }
    const bytes = services.Utilities.computeDigest(services.Utilities.DigestAlgorithm.SHA_256, `${NATIVE_CONTRACT}\n${h.raw}\n${saved.raw}`, services.Utilities.Charset.UTF_8);
    const fingerprint = bytes.map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail('native_configuration', 'The projection binding digest is invalid.');
    const sheets: ProjectionSheets = { attendance: bindSheet(config.attendance), decisions: bindSheet(config.decisions), cursors: bindSheet(config.cursors) };
    function assertProtected(kind: ProjectionSheetKind, _headers: readonly string[]) {
      if (kind === 'cursors' && config.cursors.spreadsheetId === h.config.journal.spreadsheetId) {
        assertTrustedFile(config.cursors.spreadsheetId, 'application/vnd.google-apps.spreadsheet', false);
      }
      const p = protection(config[kind]);
      if (Array.isArray(p.unprotectedRanges) && p.unprotectedRanges.length) fail('protection_unverified', 'Projection output cannot contain editable exceptions.');
    }
    return { host: h.config, config, fingerprint, sheets, assertProtected };
  }
  function assertDecisionProtection(ref: ExistingSheetReference, protectedHeaders: readonly string[], allowEmpty = false) {
    const { config } = host(); const binding = config.decisionInput;
    if (!binding || !sameRef(ref, binding)) fail('protection_unverified', 'Decision inputs differ from the configured binding.');
    const sheet = bindSheet(ref); const width = sheet.getLastColumn();
    const headers = allowEmpty && width === 0 && sheet.getLastRow() === 0 && binding.mode === 'projection'
      ? [...DYNAMIC_DECISION_HEADERS] : sheet.getRange(1, 1, 1, width).getValues()[0];
    if (new Set(headers).size !== headers.length || protectedHeaders.some(header => !headers.includes(header)) || !headers.includes('draft_decision')) fail('protection_unverified', 'Decision columns are missing or ambiguous.');
    const editableColumn = headers.indexOf('draft_decision');
    const p = protection(ref); const covered = new Set<number>();
    for (const value of (p.unprotectedRanges ?? []) as unknown[]) {
      const hole = object(value);
      if (hole.sheetId !== ref.sheetId || hole.startColumnIndex !== editableColumn || hole.endColumnIndex !== editableColumn + 1
        || typeof hole.startRowIndex !== 'number' || !Number.isSafeInteger(hole.startRowIndex) || hole.startRowIndex < 2
        || (hole.endRowIndex !== undefined && (typeof hole.endRowIndex !== 'number' || !Number.isSafeInteger(hole.endRowIndex) || hole.endRowIndex <= hole.startRowIndex))) {
        fail('protection_unverified', 'Only decision-input cells below both header rows may be editable.');
      }
      if (binding.mode === 'projection') {
        if (typeof hole.endRowIndex !== 'number' || hole.endRowIndex > binding.maxSlots + 2) fail('protection_unverified', 'Dynamic input exceptions must end at the reviewed slot capacity.');
        for (let row = hole.startRowIndex; row < hole.endRowIndex; row++) covered.add(row);
      }
    }
    if (binding.mode === 'projection' && Array.from({ length: binding.maxSlots }, (_, index) => index + 2).some(row => !covered.has(row))) {
      fail('protection_unverified', 'Every reviewed dynamic slot must have its decision cell editable; metadata stays protected.');
    }
  }
  function claimStore(fingerprint: string): ProjectionClaimStore {
    function load(): ProjectionClaim | undefined {
      const raw = properties.getProperty(NATIVE_PROPERTIES.projectionClaim);
      if (!raw) return undefined;
      let saved: Json;
      try { saved = object(JSON.parse(raw)); } catch { return fail('claim_integrity', 'The saved projection claim needs operator review.'); }
      if (saved.fingerprint !== fingerprint || !saved.claim || typeof saved.claim !== 'object' || Array.isArray(saved.claim)) fail('claim_integrity', 'A saved claim belongs to different bindings; reconcile it before changing configuration.');
      return saved.claim as unknown as ProjectionClaim;
    }
    return {
      load,
      save(claim) {
        const prior = load();
        if (prior && JSON.stringify(prior) !== JSON.stringify(claim)) fail('claim_integrity', 'An unresolved projection claim cannot be replaced.');
        const raw = JSON.stringify({ fingerprint, claim });
        if (raw.length > 8000) fail('claim_integrity', 'The projection claim is too large.');
        properties.setProperty(NATIVE_PROPERTIES.projectionClaim, raw);
      },
      clear(claim) {
        if (JSON.stringify(load()) !== JSON.stringify(claim)) fail('claim_integrity', 'The acknowledged claim does not match durable storage.');
        properties.deleteProperty(NATIVE_PROPERTIES.projectionClaim);
      },
    };
  }
  function dynamicContext(binding: NonNullable<StagingHostConfig['decisionInput']> & { mode: 'projection' }) {
    const { config } = host();
    return { binding, config: { baseUrl: config.workerOrigin, keyId: config.keyId, environment: 'staging' as const, generation: config.generation },
      signer: createGoogleSigner(services.Utilities, properties.getProperty(HOST_PROPERTIES.secret) ?? '') };
  }
  function presentationBinding(bound: ReturnType<typeof projectionBinding>) {
    if (!properties.getProperty(NATIVE_PROPERTIES.presentationConfig)) return undefined;
    const saved = readJson(NATIVE_PROPERTIES.presentationConfig);
    const config = parseNativePresentationConfig(saved.value, bound.host, bound.config);
    const fingerprint = services.Utilities.computeDigest(services.Utilities.DigestAlgorithm.SHA_256,
      `presentation-v1\n${bound.fingerprint}\n${saved.raw}`, services.Utilities.Charset.UTF_8)
      .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
    return { config, fingerprint };
  }
  function presentationInput(bound: ReturnType<typeof projectionBinding>, binding: NonNullable<ReturnType<typeof presentationBinding>>, checkSlots: boolean): PresentationInput {
    const inputBinding = bound.host.decisionInput;
    if (inputBinding?.mode !== 'projection') fail('native_configuration', 'Presentation requires dynamic decision inputs.');
    for (const kind of ['attendance', 'decisions'] as const) bound.assertProtected(kind, PROJECTION_HEADERS[kind]);
    assertDecisionProtection(inputBinding, DYNAMIC_DECISION_HEADERS.filter(header => header !== 'draft_decision'));
    const legendProtection = protection(binding.config.legend);
    if (Array.isArray(legendProtection.unprotectedRanges) && legendProtection.unprotectedRanges.length) fail('protection_unverified', 'The presentation legend must be fully protected.');
    if (checkSlots) readDynamicDecisionSlots(bindSheet(inputBinding), dynamicContext(inputBinding));
    const spreadsheetId = binding.config.legend.spreadsheetId;
    const metadataFields = 'spreadsheetId,sheets(properties,tables,filterViews,conditionalFormats,merges,protectedRanges,developerMetadata)';
    const metadata = api(`${sheetsUrl(spreadsheetId)}?fields=${encodeURIComponent(metadataFields)}`);
    if (metadata.spreadsheetId !== spreadsheetId || !Array.isArray(metadata.sheets)) fail('presentation_metadata', 'Presentation workbook metadata could not be verified.');
    const sheetMetadata = (ref: ExistingSheetReference) => {
      const matches = (metadata.sheets as unknown[]).map(object).filter(sheet => object(sheet.properties).sheetId === ref.sheetId);
      if (matches.length !== 1) fail('presentation_metadata', 'A presentation tab is missing or ambiguous.');
      return matches[0];
    };
    const legendMetadata = sheetMetadata(binding.config.legend);
    const legendProperties = object(legendMetadata.properties);
    if (legendProperties.hidden !== true) fail('presentation_legend', 'The explicitly bound legend must already be hidden.');
    const legend = bindSheet(binding.config.legend);
    if (legend.getLastColumn() > 2 || legend.getLastRow() > 6) fail('presentation_legend', 'The legend tab contains unrelated data.');
    const refs = [bound.config.attendance, bound.config.decisions, inputBinding];
    const roles: PresentationSurface['role'][] = ['attendance', 'decisions', 'decision-input'];
    const surfaces: PresentationSurface[] = refs.map((ref, index) => {
      const meta = sheetMetadata(ref); const p = object(meta.properties); const grid = object(p.gridProperties);
      const sheet = bindSheet(ref); const columns = sheet.getLastColumn(); const rows = sheet.getLastRow();
      const expected = index === 2 ? DYNAMIC_DECISION_HEADERS : PROJECTION_HEADERS[index === 0 ? 'attendance' : 'decisions'];
      if (columns !== expected.length || rows < 2) fail('presentation_headers', 'Initialize the reviewed presentation schemas before styling.');
      const gridRowCount = positive(grid.rowCount); const gridColumnCount = positive(grid.columnCount);
      if (gridRowCount > 2002 || gridColumnCount > 100 || gridRowCount < Math.max(3, rows) || gridColumnCount < columns) fail('presentation_bounds', 'The presentation grid exceeds its reviewed bounds.');
      const capacityRows = index === 2 ? inputBinding.maxSlots + 2 : gridRowCount;
      if (capacityRows > gridRowCount) fail('presentation_bounds', 'The decision input grid is smaller than its configured capacity.');
      // Resolve actual header order from the single fresh bounded GridData read
      // below, rather than separate values/formula requests for each surface.
      return { role: roles[index], sheetId: ref.sheetId, title: openNative(ref).getName(), headers: [...expected], displayHeaders: [],
        dataEndRow: Math.max(3, rows), gridRowCount, gridColumnCount, capacityRows };
    });
    const quotedRange = (title: string, endColumn: number, startRow: number, endRow: number) => `'${title.replace(/'/g, "''")}'!A${startRow}:${columnName(endColumn)}${endRow}`;
    const ranges = surfaces.flatMap(surface => [quotedRange(surface.title, surface.headers.length, 1, 3),
      quotedRange(surface.title, surface.headers.length, surface.capacityRows!, surface.capacityRows!)]);
    ranges.push(quotedRange(openNative(binding.config.legend).getName(), 2, 1, 6));
    const gridFields = 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,dataValidation,note)),rowMetadata,columnMetadata))';
    const cells = api(`${sheetsUrl(spreadsheetId)}?${ranges.map(range => `ranges=${encodeURIComponent(range)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent(gridFields)}`);
    if (cells.spreadsheetId !== spreadsheetId || !Array.isArray(cells.sheets)) fail('presentation_metadata', 'Presentation cell read-back is unavailable.');
    for (const raw of cells.sheets) {
      const cellSheet = object(raw); const id = object(cellSheet.properties).sheetId;
      const target = (metadata.sheets as unknown[]).map(object).find(sheet => object(sheet.properties).sheetId === id);
      if (!target) fail('presentation_metadata', 'Presentation cell metadata references an unexpected tab.');
      target.data = cellSheet.data;
    }
    // The bounded GridData read supplies fresh literal schema/display headers,
    // arbitrary column order and formula rejection in the same request as styles.
    for (const surface of surfaces) {
      const meta = sheetMetadata({ spreadsheetId, sheetId: surface.sheetId });
      if (!Array.isArray(meta.data)) fail('presentation_headers', 'Presentation header read-back is unavailable.');
      const blocks = meta.data.map(object);
      const headers: string[][] = [[], []];
      for (let row = 0; row < 2; row++) for (let column = 0; column < surface.headers.length; column++) {
        const block = blocks.find(block => (Number(block.startRow) || 0) <= row && (Number(block.startColumn) || 0) <= column
          && Array.isArray(block.rowData) && block.rowData.length > row - (Number(block.startRow) || 0));
        const rowData = block && object((block.rowData as unknown[])[row - (Number(block.startRow) || 0)]);
        const values = rowData?.values;
        const cell = Array.isArray(values) ? values[column - (Number(block!.startColumn) || 0)] : undefined;
        const entered = cell && object(cell).userEnteredValue;
        const value = entered && object(entered).stringValue;
        if (typeof value !== 'string' || !value.trim() || Object.keys(object(entered)).some(key => key !== 'stringValue')) fail('presentation_headers', 'Presentation headers must be nonempty literal strings.');
        headers[row].push(value);
      }
      if (new Set(headers[0]).size !== surface.headers.length || surface.headers.some(header => !headers[0].includes(header))) fail('presentation_headers', 'Presentation machine headers are missing or ambiguous.');
      surface.headers = headers[0]; surface.displayHeaders = headers[1];
    }
    return { surfaces, legend: { sheetId: binding.config.legend.sheetId, title: openNative(binding.config.legend).getName(),
      values: legend.getLastRow() ? legend.getRange(1, 1, legend.getLastRow(), 2).getValues() : [] }, metadata: metadata as unknown as SheetsMetadata, requireCellReadback: true };
  }
  function applyPresentation(bound: ReturnType<typeof projectionBinding>, mode: 'repair' | 'growth'): number {
    const binding = presentationBinding(bound);
    if (!binding) return 0;
    if (mode === 'growth' && properties.getProperty(NATIVE_PROPERTIES.presentationReceipt) !== binding.fingerprint) fail('presentation_setup_required', 'Repair the configured presentation while staging is paused before publication.');
    let input = presentationInput(bound, binding, mode === 'repair');
    let requestCount = 0;
    for (let phase = 0; phase < (mode === 'repair' ? 2 : 1); phase++) {
      const plan = mode === 'repair' ? planPresentationRepair(input) : planPresentationGrowth(input);
      if (mode === 'repair' && phase === 0) {
        properties.deleteProperty(NATIVE_PROPERTIES.presentationReceipt);
        if (properties.getProperty(NATIVE_PROPERTIES.presentationReceipt) !== null) fail('presentation_unverified', 'The previous presentation receipt could not be invalidated.');
      }
      for (const requests of chunkPresentationRequests(plan.requests)) {
        api(`${sheetsUrl(binding.config.legend.spreadsheetId)}:batchUpdate`, { requests });
        // These plans only mutate metadata and the explicit legend. Keep verified
        // operational value/extents and Drive ACL reads within this same lock;
        // obtain fresh formats, tables, protection and headers via bounded GridData.
        const prefix = sheetsUrl(binding.config.legend.spreadsheetId);
        const formulaMask = encodeURIComponent('sheets(properties(sheetId),data(rowData(values(userEnteredValue(formulaValue)))))');
        const legendChanged = requests.some(request => request.updateCells);
        const legendValuesPrefix = `${prefix}/values/${encodeURIComponent(`'${input.legend.title.replace(/'/g, "''")}'`)}`;
        for (const url of reads.keys()) {
          if ((url.startsWith(`${prefix}?`) && !url.includes(formulaMask))
            || (legendChanged && url.startsWith(legendValuesPrefix))) reads.delete(url);
        }
        if (legendChanged) extents.delete(JSON.stringify([binding.config.legend.spreadsheetId, binding.config.legend.sheetId]));
      }
      requestCount += plan.requests.length;
      // Google assigns native Table identities. A minimal create is followed by a
      // fresh metadata read and a separate configuration phase, never guessed IDs.
      if (mode !== 'repair' || !plan.requests.some(request => request.addTable)) break;
      input = presentationInput(bound, binding, false);
    }
    const verified = verifyPresentation(presentationInput(bound, binding, false));
    if (!verified.ready) fail('presentation_unverified', `Presentation read-back did not confirm managed tables, formats or validation (${verified.issues.slice(0, 3).join(', ')}). Repair remains incomplete.`);
    if (mode === 'repair') {
      properties.setProperty(NATIVE_PROPERTIES.presentationReceipt, binding.fingerprint);
      if (properties.getProperty(NATIVE_PROPERTIES.presentationReceipt) !== binding.fingerprint) fail('presentation_unverified', 'The presentation setup receipt was not persisted.');
    }
    return requestCount;
  }
  return {
    properties, utilities: services.Utilities, urlFetch: services.UrlFetchApp, scriptApp: services.ScriptApp,
    session: services.Session, formApp: { openById(id) {
      const { config } = host();
      if (id !== config.attendance.formId && id !== config.excusal?.formId) fail('wrong_source', 'This source Form is outside the reviewed staging configuration.');
      assertTrustedFile(id, 'application/vnd.google-apps.form', true);
      const form = services.FormApp.openById(id);
      const roles = id === config.attendance.formId ? config.attendance.itemRoles : config.excusal!.itemRoles;
      const required = Object.values(roles).flat();
      const actual = form.getItems().map(item => String(item.getId()));
      if (new Set(required).size !== required.length || new Set(actual).size !== actual.length || required.some(item => !actual.includes(item))) {
        fail('form_binding_changed', 'Configured native Form item identities are missing or ambiguous.');
      }
      return form;
    } },
    spreadsheetApp: { openById(id) {
      const book = services.SpreadsheetApp.openById(id);
      return { getId: () => book.getId(), getSheets: () => book.getSheets().map(sheet => bindSheet({ spreadsheetId: id, sheetId: sheet.getSheetId() }, sheet)) };
    } },
    lockService: { getScriptLock: () => sharedLock },
    nowSeconds: services.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
    configurationFingerprint() {
      const raw = properties.getProperty(NATIVE_PROPERTIES.projectionConfig) ?? '';
      const presentation = properties.getProperty(NATIVE_PROPERTIES.presentationConfig) ?? '';
      if (raw.length > 8000 || presentation.length > 8000) fail('native_configuration', 'The projection or presentation configuration exceeds its bound.');
      return services.Utilities.computeDigest(services.Utilities.DigestAlgorithm.SHA_256, `${NATIVE_CONTRACT}\n${raw}\n${presentation}`, services.Utilities.Charset.UTF_8)
        .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
    },
    assertJournalPrivate(ref) {
      const { config } = host();
      if (!sameRef(ref, config.journal)) fail('private_journal_required', 'The journal binding differs from reviewed configuration.');
      assertTrustedFile(ref.spreadsheetId, 'application/vnd.google-apps.spreadsheet', false);
    },
    assertDecisionProtection(ref, protectedHeaders) {
      assertDecisionProtection(ref, protectedHeaders);
    },
    consumeProjection(context: { config: AdapterConfig; signer: Signer; transport: Transport; nowSeconds: () => number }) {
      if (!properties.getProperty(NATIVE_PROPERTIES.projectionConfig)) return { status: 'not-configured' };
      const bound = projectionBinding();
      if (context.config.environment !== 'staging' || context.config.generation !== bound.config.generation
        || context.config.baseUrl !== bound.host.workerOrigin || context.config.keyId !== bound.host.keyId) fail('native_configuration', 'Projection delivery differs from the verified host binding.');
      if (properties.getProperty(NATIVE_PROPERTIES.projectionReceipt) !== bound.fingerprint) fail('projection_setup_required', 'Initialize reviewed projection bindings while staging is paused.');
      const binding = bound.host.decisionInput;
      const presentation = presentationBinding(bound);
      if (presentation && properties.getProperty(NATIVE_PROPERTIES.presentationReceipt) !== presentation.fingerprint) fail('presentation_setup_required', 'Repair the configured presentation while staging is paused before publication.');
      return consumeProjectionJobs({ ...context, workerId: bound.config.workerId, lock: sharedLock, sheets: bound.sheets,
        assertProtected: bound.assertProtected, flush: () => services.SpreadsheetApp.flush(), claimStore: claimStore(bound.fingerprint),
        ...(binding?.mode === 'projection' || presentation ? { publishDecisionSlots(snapshot) {
          if (binding?.mode === 'projection') {
            assertDecisionProtection(binding, DYNAMIC_DECISION_HEADERS.filter(header => header !== 'draft_decision'));
            appendProjectionDecisionSlots(snapshot, bindSheet(binding), { binding, config: context.config, signer: context.signer });
          }
          if (presentation) applyPresentation(bound, 'growth');
        } } : {}),
      });
    },
    initializeProjections() {
      if (properties.getProperty(HOST_PROPERTIES.enabled) === 'true') fail('pause_required', 'Pause staging before initializing projection outputs.');
      const bound = projectionBinding();
      if (!sharedLock.tryLock(100)) fail('projection_busy', 'Another staging operation is in progress.');
      try {
        if (properties.getProperty(HOST_PROPERTIES.enabled) === 'true') fail('pause_required', 'Pause staging before initializing projection outputs.');
        if (claimStore(bound.fingerprint).load()) fail('claim_integrity', 'Reconcile the outstanding claim before initializing output bindings.');
        for (const kind of KINDS) bound.assertProtected(kind, PROJECTION_HEADERS[kind]);
        upgradeRecordedDecisionLabels(bound.sheets, { generation: bound.host.generation });
        const binding = bound.host.decisionInput;
        if (binding?.mode === 'projection') {
          // The protected origin column is an additive upgrade; validate all existing
          // columns before the migration and require the complete schema afterward.
          assertDecisionProtection(binding, DYNAMIC_DECISION_HEADERS.filter(header => header !== 'draft_decision' && header !== 'slot_origin_row' && header !== 'slot_context_hash'), true);
          const sheet = bindSheet(binding);
          initializeDynamicDecisionSlots(sheet, sheet.getLastRow() ? dynamicContext(binding) : undefined);
          assertDecisionProtection(binding, DYNAMIC_DECISION_HEADERS.filter(header => header !== 'draft_decision'));
        }
        initializeProjectionSheets(bound.sheets);
        services.SpreadsheetApp.flush();
        // A second pass validates the initialized headers through REST read-back.
        initializeProjectionSheets(bound.sheets);
        properties.setProperty(NATIVE_PROPERTIES.projectionReceipt, bound.fingerprint);
        return { status: 'projection-ready-paused' };
      } finally { sharedLock.releaseLock(); }
    },
    repairPresentation() {
      if (properties.getProperty(HOST_PROPERTIES.enabled) === 'true') fail('pause_required', 'Pause staging before repairing spreadsheet presentation.');
      const bound = projectionBinding();
      if (!presentationBinding(bound)) return { status: 'presentation-not-configured' };
      if (!sharedLock.tryLock(100)) fail('projection_busy', 'Another staging operation is in progress.');
      try {
        if (properties.getProperty(HOST_PROPERTIES.enabled) === 'true') fail('pause_required', 'Pause staging before repairing spreadsheet presentation.');
        if (claimStore(bound.fingerprint).load()) fail('claim_integrity', 'Reconcile the outstanding projection claim before presentation repair.');
        assertTrustedFile(bound.host.journal.spreadsheetId, 'application/vnd.google-apps.spreadsheet', false);
        if (properties.getProperty(NATIVE_PROPERTIES.projectionReceipt) !== bound.fingerprint) fail('projection_setup_required', 'Initialize the reviewed projection schemas before presentation repair.');
        const requests = applyPresentation(bound, 'repair');
        return { status: 'presentation-ready-paused', requests };
      } finally { sharedLock.releaseLock(); }
    },
  };
}

export function createNativeStagingHost(services: NativeStagingServices) {
  const runtime = createNativeStagingRuntime(services);
  return { ...createStagingHost(runtime), initializeProjections: () => runtime.initializeProjections(), repairPresentation: () => runtime.repairPresentation() };
}
