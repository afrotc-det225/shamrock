import type {ScheduledHints} from './scheduled-runtime.js';
/** Optional staging-only frontend consumer. All IO is explicit; loading performs no work. */
import { AdapterError, type AdapterConfig, type SignedRequest, type Signer, type Transport } from './index.js';
import { createGoogleSigner, createGoogleTransport, type ScriptLockPort, type UtilitiesPort } from './apps-script.js';
import {createPagedFrontendTransport} from './frontend-page-client.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { planFrontendProtections, verifyFrontendProtections, type FrontendProtectionAccess, type FrontendProtectionInput } from './frontend-protections.js';
import { planFrontendPublication, assertFrontendPublicationPreconditions, verifyFrontendPublicationReadback,
  buildFrontendPublicationModel, snapshotToFrontendReportingInput, verifyFrontendValidationReadback,
  type FrontendPublicationModel, type FrontendPublicationBaseline, type FrontendPublicationPlan,
  type FrontendTableRead, type FrontendValidationSeed, type FrontendDraft,
  type FrontendValidationExpectation, type FrontendValidationRead } from './frontend-publication.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { buildFrontendReporting } from '../../../packages/domain/src/frontend-reporting.js';
import { buildExcusalPublicationTables, planExcusalPublication, planDashboardPublication, verifyDashboardPublicationReadback, dashboardReadFingerprint,
  type DashboardPublicationPlan, type DashboardPublicationRead } from './frontend-supplemental.js';
import type { DashboardAction } from './frontend-dashboard.js';
import { createPrivateCheckpoint } from './private-checkpoint.js';
import type { SnapshotRevision } from '../../../packages/domain/src/admin.js';

export const FRONTEND_PROPERTIES = { config: 'SHAMROCK_V3_FRONTEND_CONFIG', claim: 'SHAMROCK_V3_FRONTEND_CLAIM', pause: 'SHAMROCK_V3_FRONTEND_PAUSED', resumeReceipt: 'SHAMROCK_V3_FRONTEND_RESUME_RECEIPT' } as const;

/** An explicit owner-private operator request, consumed once before clearing a pause.
 * It cannot repeatedly override a later automatic/manual pause on timer invocations. */
export function consumeFrontendResume(input: {
  request: { requestId: string; sequence: number; stateSha256: string }; readStateSha256(): string;
  properties: { getProperty(key: string): string | null; setProperty(key: string, value: string): unknown; deleteProperty(key: string): unknown };
  lock: ScriptLockPort;
}): 'already-consumed' | 'resumed' {
  const { request, properties, lock } = input;
  if (!id(request?.requestId) || !natural(request?.sequence) || request.sequence < 1 || !/^[a-f0-9]{64}$/.test(request?.stateSha256 ?? '')
    || Object.keys(request).sort().join(',') !== 'requestId,sequence,stateSha256') fail('frontend_control', 'An exact reviewed resume request is required.');
  if (!lock.tryLock(10000)) fail('frontend_busy', 'Another adapter operation is active.');
  try {
    const prior = properties.getProperty(FRONTEND_PROPERTIES.resumeReceipt);
    if (prior === canonical(request)) return 'already-consumed';
    if (prior && (record(JSON.parse(prior)).sequence >= request.sequence || record(JSON.parse(prior)).requestId === request.requestId)) fail('frontend_control', 'A consumed resume request cannot change its checkpoint.');
    if (request.stateSha256 !== input.readStateSha256()) fail('frontend_control', 'The private checkpoint changed after operator review.');
    properties.setProperty(FRONTEND_PROPERTIES.resumeReceipt, canonical(request));
    if (properties.getProperty(FRONTEND_PROPERTIES.resumeReceipt) !== canonical(request)) fail('frontend_control', 'Resume consumption did not persist.');
    properties.deleteProperty(FRONTEND_PROPERTIES.pause);
    if (properties.getProperty(FRONTEND_PROPERTIES.pause) !== null) fail('frontend_control', 'The pause override did not clear. Submit a new reviewed resume request.');
    return 'resumed';
  } finally { lock.releaseLock(); }
}
type Kind = 'directory' | 'leadership' | 'attendance';
const KINDS: Kind[] = ['directory', 'leadership', 'attendance'];
type SquadronQueue = 'blue' | 'gold';
const QUEUES: SquadronQueue[] = ['blue', 'gold'];
export interface FrontendSupplementalState {
  dashboardRevision: SnapshotRevision;
  baselines: Record<SquadronQueue, FrontendPublicationBaseline>;
  drafts: Record<SquadronQueue, FrontendDraft[]>;
}
export interface FrontendSupplementalPlans {
  dashboard: DashboardPublicationPlan;
  excusals: Record<SquadronQueue, FrontendPublicationPlan>;
}
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_GOOGLE_BYTES = 1_800_000;
const MAX_BATCH_REQUESTS = 1000;
const LEASE_RESERVE_SECONDS = 45;
export interface FrontendRefreshClaim { effectId: string; kind: 'frontend.refresh'; claimToken: string; leaseExpiresAt: string }
export interface FrontendPublicationState {
  version: 1; environment: 'staging'; generation: number;
  baselines: Record<Kind, FrontendPublicationBaseline>;
  drafts: Record<Kind, FrontendDraft[]>;
  supplemental?: FrontendSupplementalState;
  /** Written before the single atomic Google publication, retained across an ambiguous response. */
  pending?: { claim: FrontendRefreshClaim; plans: Record<Kind, FrontendPublicationPlan>; supplemental?: FrontendSupplementalPlans };
  completedClaim?: { effectId: string; claimToken: string };
  /** Exact committed input receipts applied to this checkpoint, for cross-file recovery. */
  inputReceipts?: Record<string, string>;
}
export interface FrontendRefreshPorts {
  config: AdapterConfig;
  workerId: string; principalId: string;
  signer: Signer; transport: Transport; lock: ScriptLockPort;
  recovery?: { recoveryId: string; checkpointSha256: string; previousExpiry: string };
  enabled(): boolean;
  nowSeconds(): number;
  /** Verify owner, workbook isolation and private state storage before even claiming. */
  assertIsolation(): void;
  claimStore: { load(): FrontendRefreshClaim | undefined; save(claim: FrontendRefreshClaim): void; clear(claim: FrontendRefreshClaim): void };
  state: { load(): FrontendPublicationState; save(state: FrontendPublicationState): void };
  buildModel(snapshot: FrontendSnapshot): FrontendPublicationModel;
  /** Real native protections, not a script mutex, must exclude every ordinary editor. */
  fenceEdits(): void;
  assertFenced(): void;
  /** Invalidate operation-local read caches before preconditions or read-back. */
  refreshReads?(): void;
  readTable(kind: Kind): FrontendTableRead;
  readSeeds(): FrontendValidationSeed[];
  /** Read only newly copied validation intervals, checking every destination rule. */
  verifyValidation(plan: FrontendPublicationPlan): boolean;
  supplemental?: {
    plan(snapshot: FrontendSnapshot, state: FrontendSupplementalState): FrontendSupplementalPlans;
    readDashboard(): DashboardPublicationRead;
    readExcusal(queue: SquadronQueue): FrontendTableRead;
    verifyValidation(plan: FrontendPublicationPlan): boolean;
    writeAtomic(requests: Record<string, unknown>[]): void;
  };
  /** One atomic batch across all three tables. Never split or use USER_ENTERED. */
  writeAtomic(requests: Record<string, unknown>[]): void;
  restoreEditPolicy(): void;
  assertEditPolicy(): void;
  pause(): void;
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function bytes(value: string): number { return encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length; }
function record(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('frontend_contract', 'Expected structured frontend data.');
  return input as Record<string, any>;
}
function parseClaim(value: unknown): FrontendRefreshClaim {
  const c = record(value);
  if (Object.keys(c).sort().join(',') !== 'claimToken,effectId,kind,leaseExpiresAt' || c.kind !== 'frontend.refresh'
    || !id(c.effectId) || !id(c.claimToken) || typeof c.leaseExpiresAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.leaseExpiresAt) || !Number.isFinite(Date.parse(c.leaseExpiresAt))) fail('frontend_claim', 'The frontend lease is invalid.');
  return clone(c) as FrontendRefreshClaim;
}
function validState(value: FrontendPublicationState, generation: number): FrontendPublicationState {
  if (!value || value.version !== 1 || value.environment !== 'staging' || value.generation !== generation
    || !value.baselines || !value.drafts || Object.keys(value.baselines).sort().join(',') !== KINDS.slice().sort().join(',')
    || Object.keys(value.drafts).sort().join(',') !== KINDS.slice().sort().join(',')) fail('frontend_state', 'Initialize the private frontend baseline before refreshing.');
  for (const kind of KINDS) if (value.baselines[kind].generation !== generation || !Array.isArray(value.baselines[kind].rows)
    || !Array.isArray(value.drafts[kind])) fail('frontend_state', 'The private frontend baseline is invalid.');
  if (value.supplemental) {
    const s = value.supplemental;
    if (!natural(s.dashboardRevision?.operations) || !natural(s.dashboardRevision?.administration)
      || Object.keys(s.baselines ?? {}).sort().join(',') !== 'blue,gold' || Object.keys(s.drafts ?? {}).sort().join(',') !== 'blue,gold') fail('frontend_state', 'The private supplemental baseline is invalid.');
    for (const queue of QUEUES) if (s.baselines[queue]?.generation !== generation || !Array.isArray(s.baselines[queue]?.rows) || !Array.isArray(s.drafts[queue])) fail('frontend_state', 'A squadron queue baseline is invalid.');
  }
  if (value.inputReceipts && (Object.keys(value.inputReceipts).length > 10000 || Object.entries(value.inputReceipts).some(([key, hash]) => !id(key) || !/^[a-f0-9]{64}$/.test(hash)))) fail('frontend_state', 'Applied input receipt evidence is invalid or needs archival.');
  if (bytes(JSON.stringify(value)) > MAX_STATE_BYTES) fail('frontend_capacity', 'The private frontend state exceeds its reviewed size.');
  return clone(value);
}

/** Reuses the adapter's exact HMAC canonical format, with a narrow administrative path allowlist. */
export function buildSignedFrontendRequest(action: 'claim' | 'project' | 'ack', input: {
  principalId: string; workerId: string; claim?: FrontendRefreshClaim;
}, config: AdapterConfig, signer: Signer, nowSeconds: number): SignedRequest {
  if (!['claim', 'project', 'ack'].includes(action) || config.environment !== 'staging' || !natural(config.generation) || config.generation < 1
    || !/^https:\/\/[A-Za-z0-9.-]+$/.test(config.baseUrl) || !id(config.keyId) || !id(input.principalId) || !id(input.workerId)
    || !natural(nowSeconds) || nowSeconds < 1) fail('frontend_configuration', 'An isolated signed frontend request is required.');
  const claim = action === 'claim' ? undefined : parseClaim(input.claim);
  const path = `/v1/admin/effects/${action}`;
  const body = JSON.stringify({ environment: 'staging', generation: config.generation, principalId: input.principalId, workerId: input.workerId,
    ...(claim ? { effectId: claim.effectId, claimToken: claim.claimToken } : { kind: 'frontend.refresh' }) });
  const hash = signer.sha256(body), timestamp = String(nowSeconds);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_signer', 'Frontend signing returned an invalid digest.');
  const signature = signer.hmacSha256(`POST\n${path}\n${timestamp}\n${hash}`);
  if (!/^[a-f0-9]{64}$/.test(signature)) fail('invalid_signer', 'Frontend signing returned an invalid signature.');
  return { url: config.baseUrl + path, method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-shamrock-key-id': config.keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signature } };
}

/** The API explicitly defines absent person/event version entries as zero. Values
 * present in the snapshot remain authoritative; audit sequence is not recomputed here.
 */
export function buildCoherentFrontendModel(snapshot: FrontendSnapshot, asOfDate: string): FrontendPublicationModel {
  if (!Array.isArray(snapshot.attendanceVersions) || !Array.isArray(snapshot.corrections)
    || !Array.isArray(snapshot.diagnostics) || snapshot.diagnostics.some(d => d.count > 0)) fail('frontend_snapshot_incomplete', 'Complete the explicit roster, event and profile records before publishing the frontend.');
  const result = buildFrontendReporting(snapshotToFrontendReportingInput(snapshot, asOfDate));
  const versions = new Map<string, number>();
  for (const entry of snapshot.attendanceVersions) {
    const key = JSON.stringify([entry.personId, entry.eventId]);
    if (!id(entry.personId) || !id(entry.eventId) || !natural(entry.version) || versions.has(key)) fail('frontend_contract', 'Attendance version tokens are invalid or ambiguous.');
    versions.set(key, entry.version);
  }
  const current = result.matrices.find(m => m.termId === result.currentTermId)!;
  const attendanceVersions = current.rows.flatMap(row => current.eventColumns.map(event => ({ personId: row.personId, eventId: event.eventId,
    version: versions.get(JSON.stringify([row.personId, event.eventId])) ?? 0 })));
  return buildFrontendPublicationModel({ snapshot, reporting: { revision: snapshot.revision, result }, attendanceVersions });
}

/** Map field locks only through the protected key and verified private baseline.
 * Empty Table placeholders remain closed; names and physical row numbers are not identities.
 */
export function frontendRowLocks(kind: Kind | 'excusal', table: FrontendTableRead, baseline: FrontendPublicationBaseline): { rowIndex: number; headers: string[] }[] {
  const keyHeader = kind === 'leadership' ? 'contact_id' : kind === 'excusal' ? 'request_id' : 'person_id', keyColumn = table.headers.indexOf(keyHeader);
  if (keyColumn < 0) fail('frontend_state', 'Protected stable frontend identity is required before restoring edits.');
  const rows = new Map(baseline.rows.map(row => [row.key, row])); const seen = new Set<string>();
  if (rows.size !== baseline.rows.length) fail('frontend_state', 'The published field policy contains duplicate identities.');
  return table.rows.map((cells, index) => {
    const key = cells[keyColumn]?.userEnteredValue?.stringValue;
    if (!key) {
      if (cells.some(c => Object.keys(c.userEnteredValue ?? {}).length || c.chipRuns?.length)) fail('frontend_state', 'A populated frontend row lost its protected identity.');
      return { rowIndex: index + 2, headers: [...table.headers] };
    }
    const row = rows.get(key);
    if (!id(key) || !row || seen.has(key)) fail('frontend_state', 'Frontend row identity differs from the private published policy.');
    seen.add(key);
    if (kind === 'leadership' && !Array.isArray(row.readonlyHeaders)) fail('frontend_state', 'Leadership requires an explicit per-contact field ownership policy.');
    const headers = row.readonlyHeaders ?? [];
    if (!Array.isArray(headers) || new Set(headers).size !== headers.length || headers.some(h => !table.headers.includes(h))) fail('frontend_state', 'The published field ownership policy is invalid.');
    return { rowIndex: index + 2, headers: [...headers] };
  }).filter(row => row.headers.length > 0);
}

/** Targeted native validation reads. Bounded chunks avoid re-reading validation for
 * every existing matrix cell; omitted rules become null and fail exact verification.
 */
export function readFrontendValidationRanges(expectations: readonly FrontendValidationExpectation[], io: {
  sheetTitle(sheetId: number): string;
  read(ranges: string[]): { sheets?: Record<string, any>[] };
}): FrontendValidationRead[] {
  if (!Array.isArray(expectations) || expectations.length > MAX_BATCH_REQUESTS) fail('frontend_validation', 'The validation read plan exceeds its bound.');
  const result: FrontendValidationRead[] = [];
  type Slice = { index: number; start: number; end: number; a1: string; cells: number };
  const slices: Slice[] = [];
  const column = (index: number) => { let text = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text; return text; };
  let totalCells = 0;
  expectations.forEach((range, index) => {
    if (!natural(range.sheetId) || !natural(range.startRowIndex) || range.startRowIndex < 2
      || !natural(range.endRowIndex) || range.endRowIndex > 502 || range.endRowIndex <= range.startRowIndex
      || !natural(range.startColumnIndex) || !natural(range.endColumnIndex) || range.endColumnIndex > 160
      || range.endColumnIndex <= range.startColumnIndex) fail('frontend_validation', 'A copied validation interval exceeds its exact frontend bounds.');
    const width = range.endColumnIndex - range.startColumnIndex, height = range.endRowIndex - range.startRowIndex;
    totalCells += width * height;
    if (totalCells > 80_000) fail('frontend_validation', 'Copied validation exceeds the reviewed per-table cell bound.');
    const title = io.sheetTitle(range.sheetId);
    if (typeof title !== 'string' || !title || title.length > 100) fail('frontend_validation', 'A validation destination sheet is missing.');
    result.push({ sheetId: range.sheetId, startRowIndex: range.startRowIndex, endRowIndex: range.endRowIndex,
      startColumnIndex: range.startColumnIndex, endColumnIndex: range.endColumnIndex,
      rows: Array.from({ length: height }, () => Array.from({ length: width }, () => null)) });
    const step = Math.floor(2000 / width), quoted = `'${title.replace(/'/g, "''")}'`;
    for (let start = range.startRowIndex; start < range.endRowIndex; start += step) {
      const end = Math.min(start + step, range.endRowIndex);
      slices.push({ index, start, end, cells: (end - start) * width,
        a1: `${quoted}!${column(range.startColumnIndex)}${start + 1}:${column(range.endColumnIndex - 1)}${end}` });
    }
  });
  let offset = 0;
  while (offset < slices.length) {
    const batch: Slice[] = []; let cells = 0, queryBytes = 0;
    while (offset < slices.length) {
      const slice = slices[offset], size = encodeURIComponent(slice.a1).length + 8;
      if (batch.length && (batch.length >= 12 || cells + slice.cells > 2000 || queryBytes + size > 1300)) break;
      if (size > 1300) fail('frontend_validation', 'A validation range exceeds the Google request URL bound.');
      batch.push(slice); cells += slice.cells; queryBytes += size; offset++;
    }
    const data = io.read(batch.map(slice => slice.a1));
    if (!Array.isArray(data.sheets)) fail('frontend_validation', 'Google omitted validation read-back metadata.');
    for (const slice of batch) {
      const expected = expectations[slice.index], matches = data.sheets.filter(sheet => sheet.properties?.sheetId === expected.sheetId);
      if (matches.length !== 1 || !Array.isArray(matches[0].data)) fail('frontend_validation', 'Google omitted or duplicated a validation destination.');
      const blocks = matches[0].data.filter((block: any) => (block.startRow ?? 0) === slice.start && (block.startColumn ?? 0) === expected.startColumnIndex);
      if (blocks.length !== 1) fail('frontend_validation', 'Validation read-back bounds do not match the exact request.');
      for (let row = slice.start; row < slice.end; row++) for (let col = expected.startColumnIndex; col < expected.endColumnIndex; col++) {
        result[slice.index].rows[row - expected.startRowIndex][col - expected.startColumnIndex] =
          blocks[0].rowData?.[row - slice.start]?.values?.[col - expected.startColumnIndex]?.dataValidation ?? null;
      }
    }
  }
  return result;
}

/** Read only existing physical columns; the planner receives a padded canvas for future growth. */
export function readFrontendDashboardValues(input: {
  canvas: { sheetId: number; title: string; rowCount: number; columnCount: number };
  data: { sheetId: number; title: string; rowCount: number; columnCount: number };
}, read: (ranges: string[]) => { sheets?: Record<string, any>[] }): Pick<DashboardPublicationRead, 'canvas' | 'data'> {
  const specs = [{ key: 'canvas' as const, binding: input.canvas, width: 12, maxRows: 602 },
    { key: 'data' as const, binding: input.data, width: 16, maxRows: 1002 }];
  const ranges = specs.map(({ binding: b, width, maxRows }) => {
    if (!natural(b.sheetId) || !natural(b.rowCount) || b.rowCount < 1 || b.rowCount > maxRows
      || !natural(b.columnCount) || b.columnCount < 1 || b.columnCount > width
      || typeof b.title !== 'string' || !b.title || b.title.length > 100) fail('frontend_dashboard', 'Dashboard read bounds differ from the physical grid.');
    return `'${b.title.replace(/'/g, "''")}'!A1:${String.fromCharCode(64 + b.columnCount)}${b.rowCount}`;
  });
  const response = read(ranges);
  const cells = specs.map(({ binding: b, width }) => {
    const sheets = response.sheets?.filter(s => s.properties?.sheetId === b.sheetId);
    const blocks = sheets?.length === 1 ? sheets[0].data : undefined;
    if (!Array.isArray(blocks) || blocks.length !== 1 || (blocks[0].startRow ?? 0) !== 0 || (blocks[0].startColumn ?? 0) !== 0)
      fail('frontend_dashboard', 'Dashboard read-back has invalid bounds.');
    return Array.from({ length: b.rowCount }, (_, r) => Array.from({ length: width }, (_, c) =>
      c < b.columnCount ? blocks[0].rowData?.[r]?.values?.[c] ?? {} : {}));
  });
  return { canvas: cells[0], data: cells[1] };
}

/** Narrow growth-layout allowlist: no values, colors, validation or unrelated tabs. */
export function assertNativeAttendanceLayoutRequest(request: Record<string, any>, attendanceSheetId: number): void {
  const entries = Object.entries(request);
  if (entries.length !== 1) fail('frontend_request', 'Attendance layout must have one bounded operation.');
  const [operation, body] = entries[0], r = body?.range;
  if (!r || r.sheetId !== attendanceSheetId) fail('frontend_request', 'Attendance layout targets an unbound sheet.');
  if (operation === 'updateDimensionProperties') {
    if (body.fields !== 'pixelSize' || Object.keys(body.properties ?? {}).join(',') !== 'pixelSize'
      || !natural(r.startIndex) || !natural(r.endIndex) || r.endIndex <= r.startIndex) fail('frontend_request', 'Attendance size update is invalid.');
    const pixels = body.properties.pixelSize;
    const allowed = r.dimension === 'ROWS'
      ? (r.startIndex === 1 && r.endIndex === 2 && (pixels === 21 || natural(pixels) && pixels >= 40 && pixels <= 76))
        || (r.startIndex >= 2 && r.endIndex <= 502 && [21, 23].includes(pixels))
      : r.dimension === 'COLUMNS' && r.endIndex <= 160 && r.endIndex === r.startIndex + 1 && [60, 75, 80, 85, 90, 95, 100, 110, 115].includes(pixels);
    if (!allowed) fail('frontend_request', 'Attendance dimension size exceeds the approved compact layout.');
    return;
  }
  const allowedFields = ['textFormat.fontFamily', 'textFormat.fontSize', 'textFormat.bold', 'verticalAlignment', 'wrapStrategy', 'horizontalAlignment', 'numberFormat'];
  if (operation !== 'repeatCell' || !natural(r.startRowIndex) || r.startRowIndex < 1 || !natural(r.endRowIndex) || r.endRowIndex > 502 || r.endRowIndex <= r.startRowIndex
    || !natural(r.startColumnIndex) || !natural(r.endColumnIndex) || r.endColumnIndex > 160 || r.endColumnIndex <= r.startColumnIndex
    || typeof body.fields !== 'string' || !body.fields.split(',').every((field: string) => allowedFields.some(allowed => field === `userEnteredFormat.${allowed}`))
    || Object.keys(body.cell ?? {}).join(',') !== 'userEnteredFormat') fail('frontend_request', 'Attendance formatting exceeds the approved field masks.');
  const style = body.cell.userEnteredFormat, font = style.textFormat;
  if (Object.keys(style).some(key => !['textFormat', 'verticalAlignment', 'wrapStrategy', 'horizontalAlignment', 'numberFormat'].includes(key))
    || (font && (Object.keys(font).some(key => !['fontFamily', 'fontSize', 'bold'].includes(key)) || (font.fontFamily !== undefined && font.fontFamily !== 'Roboto')
      || (font.fontSize !== undefined && ![5, 7, 8, 9, 10].includes(font.fontSize)) || (font.bold !== undefined && typeof font.bold !== 'boolean')))
    || (style.verticalAlignment !== undefined && style.verticalAlignment !== 'MIDDLE') || (style.horizontalAlignment !== undefined && !['LEFT', 'CENTER'].includes(style.horizontalAlignment))
    || (style.wrapStrategy !== undefined && !['WRAP', 'CLIP'].includes(style.wrapStrategy))
    || (style.numberFormat && !equal(style.numberFormat, { type: 'TEXT' }) && !equal(style.numberFormat, { type: 'PERCENT', pattern: '0.0%' }))) fail('frontend_request', 'Attendance formatting differs from the compact native layout.');
}

/** One effect per run. A failed write never releases the edit fence or discards a claim. */
export function consumeFrontendRefresh(runtime: FrontendRefreshPorts): { status: 'disabled' | 'idle' | 'published' | 'published-with-drafts'; changedCells?: number; retainedDrafts?: number } {
  if (!runtime.enabled()) return { status: 'disabled' };
  if (!runtime.lock.tryLock(100)) fail('frontend_busy', 'Another frontend publication is in progress.');
  let fenced = false;
  try {
    if (!runtime.enabled()) return { status: 'disabled' };
    runtime.assertIsolation();
    let state = validState(runtime.state.load(), runtime.config.generation);
    if (Boolean(runtime.supplemental) !== Boolean(state.supplemental)) fail('frontend_state', 'The configured visible surfaces and private baseline must agree before claiming.');
    const boundedRequests = (requests: Record<string, unknown>[]) => {
      if (requests.length > MAX_BATCH_REQUESTS || bytes(JSON.stringify({ requests })) > MAX_GOOGLE_BYTES) fail('frontend_capacity', 'Publication exceeds one atomic workbook batch. Retain its fence for review.');
      return requests;
    };
    const send = (action: 'claim' | 'project' | 'ack', claim?: FrontendRefreshClaim): Record<string, any> => {
      if (!runtime.enabled()) fail('frontend_paused', 'Frontend publication was paused; retained work needs review.');
      const response = runtime.transport.send(buildSignedFrontendRequest(action, { workerId: runtime.workerId, principalId: runtime.principalId, claim }, runtime.config, runtime.signer, runtime.nowSeconds()));
      if (response.status !== 200) fail('frontend_delivery', `The frontend ${action} request did not complete (HTTP ${response.status}). Retained work needs review.`);
      if (typeof response.body !== 'string' || bytes(response.body) > MAX_STATE_BYTES) fail('frontend_contract', 'The frontend response exceeds its reviewed bound.');
      try { return record(JSON.parse(response.body)); } catch { return fail('frontend_contract', 'The frontend response is invalid.'); }
    };
    let claim = runtime.claimStore.load();
    if (!claim) {
      if (state.pending) fail('frontend_claim', 'A pending publication lost its durable claim; reconcile before continuing.');
      const response = send('claim');
      if (Object.keys(response).join(',') !== 'effect') fail('frontend_claim', 'The frontend claim response is invalid.');
      if (response.effect === null) return { status: 'idle' };
      claim = parseClaim(response.effect); runtime.claimStore.save(claim);
      if (!equal(runtime.claimStore.load(), claim)) fail('frontend_claim', 'The frontend lease did not persist.');
    } else claim = parseClaim(claim);
    if (Date.parse(claim.leaseExpiresAt) <= (runtime.nowSeconds() + LEASE_RESERVE_SECONDS) * 1000
      || state.pending && !equal(state.pending.claim, claim)) {
      const recovery = runtime.recovery;
      if (!recovery || !id(recovery.recoveryId) || recovery.previousExpiry !== (state.pending?.claim.leaseExpiresAt ?? claim.leaseExpiresAt)
        || runtime.signer.sha256(canonical(state)) !== recovery.checkpointSha256) fail('frontend_lease_expired', 'Review the retained checkpoint and submit an explicit lease recovery request.');
      if (state.pending && (state.pending.claim.effectId !== claim.effectId || state.pending.claim.claimToken !== claim.claimToken)) fail('frontend_claim', 'Recovery cannot replace another publication claim.');
      fenced = true; runtime.fenceEdits(); runtime.assertFenced(); runtime.refreshReads?.();
      let providerState: 'before' | 'after' | 'partial' | 'completed' = state.completedClaim ? 'completed' : 'before';
      if (state.completedClaim && (state.completedClaim.effectId !== claim.effectId || state.completedClaim.claimToken !== claim.claimToken)) fail('frontend_claim', 'Completed publication belongs to another claim.');
      if (state.pending) {
        const { plans, supplemental } = state.pending;
        const reads = Object.fromEntries(KINDS.map(kind => [kind, runtime.readTable(kind)])) as Record<Kind, FrontendTableRead>;
        const dashboard = supplemental ? runtime.supplemental!.readDashboard() : undefined;
        const mainAfter = KINDS.every(k => verifyFrontendPublicationReadback(plans[k], reads[k]))
          && (!supplemental || verifyDashboardPublicationReadback(supplemental.dashboard, dashboard!));
        if (!mainAfter) {
          KINDS.forEach(k => assertFrontendPublicationPreconditions(plans[k], reads[k]));
          if (supplemental && dashboardReadFingerprint(dashboard!) !== supplemental.dashboard.expectedRead) fail('frontend_readback', 'Recovery found mixed Main state.');
        } else if (KINDS.some(k => !runtime.verifyValidation(plans[k]))) fail('frontend_validation', 'Recovery must verify copied Main controls.');
        let queuesAfter = mainAfter;
        if (supplemental) {
          const reads = Object.fromEntries(QUEUES.map(q => [q, runtime.supplemental!.readExcusal(q)])) as Record<SquadronQueue, FrontendTableRead>;
          queuesAfter = QUEUES.every(q => verifyFrontendPublicationReadback(supplemental.excusals[q], reads[q]));
          if (!queuesAfter) QUEUES.forEach(q => assertFrontendPublicationPreconditions(supplemental.excusals[q], reads[q]));
          else if (QUEUES.some(q => !runtime.supplemental!.verifyValidation(supplemental.excusals[q]))) fail('frontend_validation', 'Recovery must verify copied decision controls.');
        }
        providerState = mainAfter && queuesAfter ? 'after' : mainAfter || queuesAfter ? 'partial' : 'before';
      }
      // Reuse the validated identity/config/clock, but sign the exact recovery path/body.
      const signed = buildSignedFrontendRequest('project', { workerId: runtime.workerId, principalId: runtime.principalId, claim }, runtime.config, runtime.signer, runtime.nowSeconds());
      const body = JSON.stringify({ environment: runtime.config.environment, generation: runtime.config.generation, principalId: runtime.principalId,
        workerId: runtime.workerId, recoveryId: recovery.recoveryId, effectId: claim.effectId, claimToken: claim.claimToken,
        previousExpiry: recovery.previousExpiry, checkpointSha256: recovery.checkpointSha256, providerState, producerFenced: true, exclusiveWriter: true });
      const path = '/v1/admin/effects/recover';
      signed.url = runtime.config.baseUrl + path; signed.body = body;
      signed.headers['x-shamrock-signature'] = runtime.signer.hmacSha256(`POST\n${path}\n${signed.headers['x-shamrock-timestamp']}\n${runtime.signer.sha256(body)}`);
      const response = runtime.transport.send(signed);
      if (response.status !== 200 || typeof response.body !== 'string' || bytes(response.body) > 8192) fail('frontend_recovery', 'Lease recovery did not return a verified receipt.');
      const receipt = record(JSON.parse(response.body));
      if (receipt.status !== 'renewed' || receipt.recoveryId !== recovery.recoveryId || receipt.effectId !== claim.effectId || receipt.workerId !== runtime.workerId
        || receipt.claimToken !== claim.claimToken || receipt.checkpointSha256 !== recovery.checkpointSha256 || receipt.providerState !== providerState) fail('frontend_recovery', 'Recovery receipt does not match the frozen request.');
      claim = parseClaim({ ...claim, leaseExpiresAt: receipt.leaseExpiresAt });
      runtime.claimStore.save(claim);
      if (!equal(runtime.claimStore.load(), claim)) fail('frontend_recovery', 'Renewed claim did not persist.');
      if (state.pending) { state.pending.claim = clone(claim); runtime.state.save(state); if (!equal(runtime.state.load(), state)) fail('frontend_recovery', 'Renewed private checkpoint did not persist.'); }
    }
    const lease = claim;
    const checkLease = () => { if (Date.parse(lease.leaseExpiresAt) <= (runtime.nowSeconds() + LEASE_RESERVE_SECONDS) * 1000) fail('frontend_lease_expired', 'The frontend lease needs reconciliation before further writes.'); };
    checkLease();
    const projected = send('project', claim);
    if (!projected.effect || projected.effect.effectId !== claim.effectId || projected.effect.kind !== 'frontend.refresh'
      || projected.snapshot?.contractVersion !== 1 || projected.snapshot.environment !== 'staging'
      || projected.snapshot.generation !== runtime.config.generation) fail('frontend_contract', 'The snapshot does not match the leased staging effect.');
    if (state.completedClaim?.effectId === claim.effectId && state.completedClaim.claimToken === claim.claimToken) {
      // A prior run completed publication and restored the field policy. New human
      // drafts may now exist: do not replay the previous publication over them.
      runtime.restoreEditPolicy(); runtime.assertEditPolicy();
    } else {
      fenced = true; runtime.fenceEdits(); runtime.assertFenced(); checkLease();
      if (state.pending) {
        if (!equal(state.pending.claim, claim)) fail('frontend_claim', 'A pending publication belongs to another lease.');
      } else {
        const model = runtime.buildModel(projected.snapshot as FrontendSnapshot);
        if (model.generation !== runtime.config.generation || !equal(model.revision, projected.snapshot.revision)
          || model.tables.length !== 3 || new Set(model.tables.map(t => t.kind)).size !== 3) fail('frontend_contract', 'Frontend projections must share one coherent snapshot.');
        const seeds = runtime.readSeeds(); runtime.refreshReads?.(); const plans = {} as Record<Kind, FrontendPublicationPlan>;
        for (const kind of KINDS) {
          const table = model.tables.find(t => t.kind === kind);
          if (!table) fail('frontend_contract', 'A required frontend table is missing.');
          plans[kind] = planFrontendPublication({ generation: model.generation, revision: model.revision, table,
            current: runtime.readTable(kind), baseline: state.baselines[kind], drafts: state.drafts[kind], seeds, editFenceVerified: true });
        }
        state.pending = { claim: clone(claim), plans };
        if (runtime.supplemental) {
          const extra = runtime.supplemental.plan(projected.snapshot as FrontendSnapshot, state.supplemental!);
          if (!equal(extra.dashboard.revision, model.revision) || QUEUES.some(queue => extra.excusals[queue].nextBaseline.generation !== model.generation
            || !equal(extra.excusals[queue].nextBaseline.revision, model.revision))) fail('frontend_contract', 'Every visible frontend surface must use the same coherent snapshot.');
          state.pending.supplemental = extra;
        }
        boundedRequests([...KINDS.flatMap(kind => plans[kind].requests), ...(state.pending.supplemental?.dashboard.requests ?? [])]);
        if (state.pending.supplemental) boundedRequests(QUEUES.flatMap(queue => state.pending!.supplemental!.excusals[queue].requests));
        runtime.state.save(validState(state, runtime.config.generation));
        if (!equal(runtime.state.load(), state)) fail('frontend_state', 'The pending publication did not persist.');
      }
      const plans = state.pending!.plans;
      const supplemental = state.pending!.supplemental;
      if (Boolean(runtime.supplemental) !== Boolean(supplemental)) fail('frontend_state', 'The retained publication has a different visible-surface contract.');
      runtime.refreshReads?.();
      const reads = Object.fromEntries(KINDS.map(kind => [kind, runtime.readTable(kind)])) as Record<Kind, FrontendTableRead>;
      const dashboardRead = supplemental ? runtime.supplemental!.readDashboard() : undefined;
      const alreadyWritten = KINDS.every(kind => verifyFrontendPublicationReadback(plans[kind], reads[kind]))
        && (!supplemental || verifyDashboardPublicationReadback(supplemental.dashboard, dashboardRead!));
      if (!alreadyWritten) {
        for (const kind of KINDS) assertFrontendPublicationPreconditions(plans[kind], reads[kind]);
        if (supplemental && dashboardReadFingerprint(dashboardRead!) !== supplemental.dashboard.expectedRead) fail('frontend_readback', 'Main is neither the frozen original nor the complete planned publication.');
        runtime.assertFenced(); checkLease();
        const requests = boundedRequests([...KINDS.flatMap(kind => plans[kind].requests), ...(supplemental?.dashboard.requests ?? [])]);
        if (requests.length) runtime.writeAtomic(requests);
      }
      runtime.assertFenced(); runtime.refreshReads?.();
      for (const kind of KINDS) if (!verifyFrontendPublicationReadback(plans[kind], runtime.readTable(kind))) fail('frontend_readback', 'Published frontend cells did not read back exactly; the edit fence is retained.');
      for (const kind of KINDS) if (!runtime.verifyValidation(plans[kind])) fail('frontend_validation', 'Copied native validation did not read back exactly; the edit fence is retained.');
      if (supplemental) {
        const extra = runtime.supplemental!;
        if (!verifyDashboardPublicationReadback(supplemental.dashboard, extra.readDashboard())) fail('frontend_readback', 'Dashboard publication did not verify; both workbook fences are retained.');
        runtime.refreshReads?.();
        const queueReads = Object.fromEntries(QUEUES.map(queue => [queue, extra.readExcusal(queue)])) as Record<SquadronQueue, FrontendTableRead>;
        if (!QUEUES.every(queue => verifyFrontendPublicationReadback(supplemental.excusals[queue], queueReads[queue]))) {
          for (const queue of QUEUES) assertFrontendPublicationPreconditions(supplemental.excusals[queue], queueReads[queue]);
          runtime.assertFenced(); checkLease();
          const requests = boundedRequests(QUEUES.flatMap(queue => supplemental.excusals[queue].requests));
          if (requests.length) extra.writeAtomic(requests);
        }
        runtime.assertFenced(); runtime.refreshReads?.();
        for (const queue of QUEUES) {
          if (!verifyFrontendPublicationReadback(supplemental.excusals[queue], extra.readExcusal(queue)) || !extra.verifyValidation(supplemental.excusals[queue])) fail('frontend_readback', 'Squadron publication or validation did not verify; both workbook fences are retained.');
        }
        state.supplemental = { dashboardRevision: clone(supplemental.dashboard.revision),
          baselines: Object.fromEntries(QUEUES.map(queue => [queue, clone(supplemental.excusals[queue].nextBaseline)])) as FrontendSupplementalState['baselines'],
          drafts: Object.fromEntries(QUEUES.map(queue => [queue, clone(supplemental.excusals[queue].retainedDrafts)])) as FrontendSupplementalState['drafts'] };
      }
      checkLease();
      for (const kind of KINDS) { state.baselines[kind] = clone(plans[kind].nextBaseline); state.drafts[kind] = clone(plans[kind].retainedDrafts); }
      // Persist accepted baselines before reopening editable fields. Keep the pending
      // material until the complete edit policy has been verified as restored.
      runtime.state.save(validState(state, runtime.config.generation));
      if (!equal(runtime.state.load(), state)) fail('frontend_state', 'The verified publication baseline did not persist.');
      state.completedClaim = { effectId: claim.effectId, claimToken: claim.claimToken }; delete state.pending;
      runtime.state.save(validState(state, runtime.config.generation));
      if (!equal(runtime.state.load(), state)) fail('frontend_state', 'The completed frontend checkpoint did not persist.');
      runtime.restoreEditPolicy(); runtime.assertEditPolicy(); fenced = false;
    }
    checkLease();
    const ack = send('ack', claim);
    if (Object.keys(ack).join(',') !== 'acknowledged' || ack.acknowledged !== true) fail('frontend_ack', 'The frontend acknowledgement is ambiguous.');
    runtime.claimStore.clear(claim);
    if (runtime.claimStore.load() !== undefined) fail('frontend_claim', 'The acknowledged frontend claim could not be cleared.');
    const retainedDrafts = KINDS.reduce((sum, kind) => sum + state.drafts[kind].length, 0)
      + (state.supplemental ? QUEUES.reduce((sum, queue) => sum + state.supplemental!.drafts[queue].length, 0) : 0);
    return { status: retainedDrafts ? 'published-with-drafts' : 'published', retainedDrafts };
  } catch (error) {
    // A failure while fenced must remain visibly paused. Never reopen stale ranges
    // from finally; a verified recovery or explicit operator reconciliation is needed.
    if (fenced) runtime.pause();
    throw error;
  } finally { runtime.lock.releaseLock(); }
}

export interface NativeFrontendConfig {
  version: 1; environment: 'staging'; generation: number; enabled: boolean;
  resourceReview: 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING';
  workerId: string; principalId: string; stateFileId: string;
  resumeRequest?: { requestId: string; sequence: number; stateSha256: string };
  leaseRecovery?: { recoveryId: string; checkpointSha256: string; previousExpiry: string };
  main: { spreadsheetId: string; expectedTitle: string; sheets: Record<Kind, { sheetId: number; tableId: string }> };
  allowedFileEditors: string[];
  access: FrontendProtectionAccess;
  seeds: { key: string; sheetId: number; rowIndex: number; columnIndex: number; nativeStyleVersion: string; expectedRule: unknown }[];
  supplemental?: { enabled: false } | {
    enabled: true;
    dashboard: { sheetId: number; dataSheetId: number; chartIds: number[]; actions: DashboardAction[] };
    excusals: { spreadsheetId: string; expectedTitle: string; allowedFileEditors: string[]; access: FrontendProtectionAccess;
      sheets: Record<SquadronQueue, { sheetId: number; tableId: string; squadronId: string }>;
      seeds: NativeFrontendConfig['seeds']; };
  };
}
export interface NativeFrontendInputSession {
  config: NativeFrontendConfig; automationEmail: string; adapter: AdapterConfig;
  signer: Signer; transport: Transport; nowSeconds(): number;
  state: FrontendPublicationState;
  read(surface: 'directory'|'leadership'|'attendance'|'blue'|'gold'): FrontendTableRead;
  save(state: FrontendPublicationState): void;
  fence(): void; restore(): void;
}
export interface NativeFrontendServices {
  scheduled?: ScheduledHints;
  PropertiesService: { getScriptProperties(): { getProperty(key: string): string | null; setProperty(key: string, value: string): unknown; deleteProperty(key: string): unknown } };
  Utilities: UtilitiesPort & { formatDate?(date: Date, timeZone: string, format: string): string };
  UrlFetchApp: { fetch(url: string, options: { method: 'get' | 'post' | 'patch'; headers: Record<string, string>; payload?: string; contentType?: string;
    muteHttpExceptions: true; followRedirects: false; validateHttpsCertificates: true }): { getResponseCode(): number; getContentText(): string } };
  ScriptApp: { getOAuthToken(): string };
  Session: { getEffectiveUser(): { getEmail(): string } };
  LockService: { getScriptLock(): ScriptLockPort };
  nowSeconds?: () => number;
}

/** Native binding deliberately accepts a pure domain model builder. It must use the
 * coherent snapshot's declared policy and actual versions; no endpoint fetches inside it.
 * The root host wires snapshotToFrontendReportingInput/buildFrontendReporting here.
 */
export function createNativeFrontendRuntime(services: NativeFrontendServices,
  modelBuilder?: (snapshot: FrontendSnapshot) => FrontendPublicationModel) {
  const properties = services.PropertiesService.getScriptProperties();
  const pauseFrontend = () => {
    properties.setProperty(FRONTEND_PROPERTIES.pause, 'true');
    if (properties.getProperty(FRONTEND_PROPERTIES.pause) !== 'true') fail('frontend_state', 'The frontend pause override did not persist.');
  };
  const now = services.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const account = () => services.Session.getEffectiveUser().getEmail().trim().toLowerCase();
  function api(url: string, body?: unknown, patch = false, max = MAX_STATE_BYTES): Record<string, any> {
    const token = services.ScriptApp.getOAuthToken(); if (!token) fail('frontend_google_auth', 'Authorize the staging automation account.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && bytes(payload) > max) fail('frontend_capacity', 'The bounded Google request is too large.');
    let response: ReturnType<NativeFrontendServices['UrlFetchApp']['fetch']>;
    try { response = services.UrlFetchApp.fetch(url, { method: patch ? 'patch' : body === undefined ? 'get' : 'post',
      headers: { Authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload, contentType: 'application/json' }),
      muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true }); }
    catch { return fail('frontend_google_transport', 'A Google request was ambiguous; retained frontend work needs review.'); }
    if (response.getResponseCode() !== 200) fail('frontend_google_response', `Google frontend operation failed (HTTP ${response.getResponseCode()}). Retained work needs review.`);
    const text = response.getContentText(); if (bytes(text) > max) fail('frontend_capacity', 'The Google frontend response exceeds its bound.');
    try { return record(JSON.parse(text)); } catch { return fail('frontend_google_response', 'Google returned invalid frontend metadata.'); }
  }
  const driveUrl = (fileId: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const sheetsUrl = (fileId: string) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}`;
  const email = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('frontend_configuration', 'A configured editor identity is invalid.');
    return value.trim().toLowerCase();
  };
  const fileId = (value: unknown): string => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) fail('frontend_configuration', 'A configured resource identity is invalid.'); return value; };
  function inspectFile(file: string, owner: string, editors: readonly string[] = []): Record<string, any> {
    const metadata = api(`${driveUrl(file)}?fields=${encodeURIComponent('id,name,mimeType,size,version,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted)')}`);
    if (metadata.id !== file || metadata.trashed || metadata.driveId || metadata.owners?.length !== 1 || email(metadata.owners[0].emailAddress) !== owner
      || !Array.isArray(metadata.permissions) || metadata.permissions.length !== new Set([owner, ...editors]).size
      || metadata.permissions.some((p: any) => p.deleted || p.type !== 'user' || ![owner, ...editors].includes(email(p.emailAddress))
        || p.role !== (email(p.emailAddress) === owner ? 'owner' : 'writer'))) fail('frontend_isolation', 'Frontend ownership and exact private sharing could not be verified.');
    return metadata;
  }
  function configuration(): { frontend: NativeFrontendConfig; host: ReturnType<typeof parseStagingHostConfig> } | undefined {
    const rawHost = properties.getProperty(HOST_PROPERTIES.config);
    if (!rawHost) return undefined;
    const host = parseStagingHostConfig(JSON.parse(rawHost));
    if (account() !== host.expectedAutomationEmail) fail('frontend_identity', 'Run frontend publication under the staging automation account.');
    let raw = properties.getProperty(FRONTEND_PROPERTIES.config);
    if (!raw) {
      const configFile = properties.getProperty(CONFIG_FILE_ID_PROPERTY); if (!configFile) return undefined;
      const info = inspectFile(fileId(configFile), host.expectedAutomationEmail);
      if (info.mimeType !== 'application/json' || Number(info.size) > 65536) fail('frontend_configuration', 'Use the reviewed private staging configuration file.');
      const map = api(`${driveUrl(configFile)}?alt=media`, undefined, false, 65536);
      raw = map[FRONTEND_PROPERTIES.config]; if (raw === undefined) return undefined;
    }
    if (typeof raw !== 'string' || bytes(raw) > 16000) fail('frontend_configuration', 'Frontend configuration is invalid or too large.');
    const f = record(JSON.parse(raw)) as NativeFrontendConfig;
    if (f.version !== 1 || f.environment !== 'staging' || f.generation !== host.generation || typeof f.enabled !== 'boolean'
      || f.resourceReview !== 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING' || !id(f.workerId) || !id(f.principalId)
      || !f.main || !f.main.sheets || typeof f.main.expectedTitle !== 'string' || f.main.expectedTitle.length > 200 || !/staging/i.test(f.main.expectedTitle)
      || !f.access || email(f.access.ownerEmail) !== host.expectedAutomationEmail
      || email(f.access.automationEmail) !== host.expectedAutomationEmail || !Array.isArray(f.allowedFileEditors)
      || f.allowedFileEditors.length > 50 || !Array.isArray(f.seeds) || f.seeds.length > 30) fail('frontend_configuration', 'Frontend bindings must match the reviewed isolated staging host.');
    fileId(f.stateFileId); fileId(f.main.spreadsheetId);
    if (f.stateFileId === f.main.spreadsheetId || [host.journal.spreadsheetId, host.decisionInput?.spreadsheetId].includes(f.main.spreadsheetId)
      || f.stateFileId === properties.getProperty(CONFIG_FILE_ID_PROPERTY)) fail('frontend_configuration', 'Frontend state, user sheets and existing transport resources must stay separate.');
    if (new Set(f.allowedFileEditors.map(email)).size !== f.allowedFileEditors.length || f.allowedFileEditors.includes(host.expectedAutomationEmail)) fail('frontend_configuration', 'Frontend sharing must list distinct non-owner editors.');
    if (Object.keys(f.main.sheets).sort().join(',') !== KINDS.slice().sort().join(',') || new Set(KINDS.map(k => f.main.sheets[k]?.sheetId)).size !== 3) fail('frontend_configuration', 'Bind all three distinct frontend Tables.');
    for (const kind of KINDS) if (!natural(f.main.sheets[kind].sheetId) || typeof f.main.sheets[kind].tableId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(f.main.sheets[kind].tableId)) fail('frontend_configuration', 'A frontend Table binding is invalid.');
    if (f.supplemental !== undefined && typeof f.supplemental?.enabled !== 'boolean') fail('frontend_configuration', 'Supplemental publication requires an explicit gate.');
    if (f.supplemental?.enabled) {
      const { dashboard: d, excusals: e } = f.supplemental;
      if (!d || !natural(d.sheetId) || !natural(d.dataSheetId) || new Set([d.sheetId, d.dataSheetId, ...KINDS.map(k => f.main.sheets[k].sheetId)]).size !== 5
        || !Array.isArray(d.chartIds) || d.chartIds.length !== 4 || new Set(d.chartIds).size !== 4 || d.chartIds.some(v => !natural(v))
        || !Array.isArray(d.actions) || d.actions.length > 6 || !e || typeof e.expectedTitle !== 'string' || e.expectedTitle.length > 200 || !/staging/i.test(e.expectedTitle)
        || !e.access || email(e.access.ownerEmail) !== host.expectedAutomationEmail || email(e.access.automationEmail) !== host.expectedAutomationEmail
        || !Array.isArray(e.allowedFileEditors) || e.allowedFileEditors.length > 50 || new Set(e.allowedFileEditors.map(email)).size !== e.allowedFileEditors.length
        || e.allowedFileEditors.includes(host.expectedAutomationEmail) || !Array.isArray(e.seeds) || e.seeds.length > 30
        || Object.keys(e.sheets ?? {}).sort().join(',') !== 'blue,gold') fail('frontend_configuration', 'Full visible-sheet publication bindings are incomplete.');
      fileId(e.spreadsheetId);
      if ([f.main.spreadsheetId, f.stateFileId, host.journal.spreadsheetId, host.decisionInput?.spreadsheetId, properties.getProperty(CONFIG_FILE_ID_PROPERTY)].includes(e.spreadsheetId)
        || new Set(QUEUES.map(queue => e.sheets[queue]?.sheetId)).size !== 2 || new Set(QUEUES.map(queue => e.sheets[queue]?.squadronId)).size !== 2) fail('frontend_configuration', 'Excusals must bind its own reviewed workbook and distinct squadron queues.');
      for (const queue of QUEUES) if (!natural(e.sheets[queue].sheetId) || !id(e.sheets[queue].squadronId)
        || typeof e.sheets[queue].tableId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(e.sheets[queue].tableId)) fail('frontend_configuration', 'A squadron Table binding is invalid.');
    }
    return { frontend: clone(f), host };
  }
  function refresh(inputOperation?: (session: NativeFrontendInputSession) => unknown, allowPausedInput = false) {
    const loaded = configuration();
    // Only explicit input setup/control may inspect a disabled publisher. Ordinary
    // refresh and edit delivery retain both independent publication gates.
    if (!loaded || !loaded.frontend.enabled && !(inputOperation && allowPausedInput)) return { status: 'disabled' as const };
    const { frontend: config, host } = loaded;
    const supplemental = config.supplemental?.enabled ? config.supplemental : undefined;
    const signer = createGoogleSigner(services.Utilities, properties.getProperty(HOST_PROPERTIES.secret) ?? '');
    if (config.resumeRequest) {
      consumeFrontendResume({ request: config.resumeRequest, properties, lock: services.LockService.getScriptLock(), readStateSha256() {
        const info = inspectFile(config.stateFileId, host.expectedAutomationEmail);
        if (info.mimeType !== 'application/json' || Number(info.size) > MAX_STATE_BYTES) fail('frontend_state', 'A private bounded checkpoint is required for resume.');
        const state = api(`${driveUrl(config.stateFileId)}?alt=media`);
        validState(state as FrontendPublicationState, config.generation);
        return signer.sha256(canonical(state));
      } });
    }
    if (properties.getProperty(FRONTEND_PROPERTIES.pause) === 'true' && !allowPausedInput) return { status: 'disabled' as const };
    if (!inputOperation && services.scheduled) {
      const available=services.scheduled.availability(config.principalId);
      if (!available.acceptingCommands) return {status:'disabled' as const};
      if (!services.scheduled.reconcile && !properties.getProperty(FRONTEND_PROPERTIES.claim) && !available.frontendPending && !available.frontendLeased) return {status:'idle' as const};
    }
    let publishedBaselines: FrontendPublicationState['baselines'] | undefined;
    let publishedSupplemental: FrontendSupplementalState | undefined;
    let metadataCache: Record<string, any> | undefined, cellsCache: Record<string, any> | undefined;
    let excusalMetadataCache: Record<string, any> | undefined, excusalCellsCache: Record<string, any> | undefined, dashboardCache: DashboardPublicationRead | undefined;
    const invalidateReads = () => { metadataCache = undefined; cellsCache = undefined; excusalMetadataCache = undefined; excusalCellsCache = undefined; dashboardCache = undefined; };
    const readMetadata = () => metadataCache ??= api(`${sheetsUrl(config.main.spreadsheetId)}?fields=${encodeURIComponent('spreadsheetId,sheets(properties,tables,protectedRanges,merges,charts)')}`);
    const readExcusalMetadata = () => excusalMetadataCache ??= api(`${sheetsUrl(supplemental!.excusals.spreadsheetId)}?fields=${encodeURIComponent('spreadsheetId,sheets(properties,tables,protectedRanges)')}`);
    const column = (index: number) => { let result = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
    const quoted = (title: string) => `'${title.replace(/'/g, "''")}'`;
    function readTable(kind: Kind): FrontendTableRead {
      const metadata = readMetadata(), binding = config.main.sheets[kind];
      const sheet = metadata.sheets?.find((s: any) => s.properties?.sheetId === binding.sheetId);
      const table = sheet?.tables?.find((t: any) => t.tableId === binding.tableId);
      if (!sheet || sheet.tables.length !== 1 || !table || table.range.startRowIndex !== 1 || (table.range.startColumnIndex ?? 0) !== 0
        || !natural(table.range.endRowIndex) || table.range.endRowIndex > 502 || !natural(table.range.endColumnIndex) || table.range.endColumnIndex > 160) fail('frontend_table', 'A configured native frontend Table is missing or exceeds its bound.');
      if (!cellsCache) {
        const ranges = KINDS.map(k => {
          const bound = config.main.sheets[k], s = metadata.sheets?.find((entry: any) => entry.properties?.sheetId === bound.sheetId);
          const t = s?.tables?.find((entry: any) => entry.tableId === bound.tableId);
          if (!t || !natural(t.range.endRowIndex) || t.range.endRowIndex > 502 || !natural(t.range.endColumnIndex) || t.range.endColumnIndex > 160) fail('frontend_table', 'A configured frontend Table exceeds its bound.');
          return `${quoted(s.properties.title)}!A1:${column(t.range.endColumnIndex - 1)}${t.range.endRowIndex}`;
        });
        cellsCache = api(`${sheetsUrl(config.main.spreadsheetId)}?${ranges.map(a1 => `ranges=${encodeURIComponent(a1)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,chipRuns)),rowMetadata(hiddenByUser),columnMetadata(hiddenByUser)))')}`);
      }
      const data = cellsCache;
      const source = data.sheets?.find((s: any) => s.properties?.sheetId === binding.sheetId)?.data?.[0];
      if (!source || (source.startRow ?? 0) !== 0 || (source.startColumn ?? 0) !== 0) fail('frontend_table', 'Frontend cell read-back has invalid bounds.');
      const width = table.range.endColumnIndex;
      const row = (r: number) => Array.from({ length: width }, (_, c) => source.rowData?.[r]?.values?.[c] ?? {});
      const headers = row(0).map((c: any) => c.userEnteredValue?.stringValue ?? ''), labels = row(1).map((c: any) => c.userEnteredValue?.stringValue ?? '');
      return { sheetId: binding.sheetId, tableId: binding.tableId, gridRowCount: sheet.properties.gridProperties.rowCount,
        gridColumnCount: sheet.properties.gridProperties.columnCount, headers, labels, rows: Array.from({ length: table.range.endRowIndex - 2 }, (_, r) => row(r + 2)),
        range: { ...table.range, startColumnIndex: 0 }, hiddenColumns: Array.from({ length: width }, (_, c) => c).filter(c => source.columnMetadata?.[c]?.hiddenByUser === true), machineRowHidden: source.rowMetadata?.[0]?.hiddenByUser === true };
    }
    function readExcusal(queue: SquadronQueue): FrontendTableRead {
      const book = supplemental!.excusals, metadata = readExcusalMetadata(), binding = book.sheets[queue];
      const sheet = metadata.sheets?.find((s: any) => s.properties?.sheetId === binding.sheetId);
      const table = sheet?.tables?.find((t: any) => t.tableId === binding.tableId);
      if (!sheet || sheet.tables.length !== 1 || !table || table.range.startRowIndex !== 1 || (table.range.startColumnIndex ?? 0) !== 0
        || !natural(table.range.endRowIndex) || table.range.endRowIndex > 502 || !natural(table.range.endColumnIndex) || table.range.endColumnIndex > 160) fail('frontend_table', 'A squadron queue Table is missing or exceeds its bound.');
      if (!excusalCellsCache) {
        const ranges = QUEUES.map(q => {
          const b = book.sheets[q], s = metadata.sheets?.find((entry: any) => entry.properties?.sheetId === b.sheetId), t = s?.tables?.find((entry: any) => entry.tableId === b.tableId);
          if (!t || !natural(t.range.endRowIndex) || t.range.endRowIndex > 502 || !natural(t.range.endColumnIndex) || t.range.endColumnIndex > 160) fail('frontend_table', 'A squadron queue read exceeds its bound.');
          return `${quoted(s.properties.title)}!A1:${column(t.range.endColumnIndex - 1)}${t.range.endRowIndex}`;
        });
        excusalCellsCache = api(`${sheetsUrl(book.spreadsheetId)}?${ranges.map(a1 => `ranges=${encodeURIComponent(a1)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,chipRuns)),rowMetadata(hiddenByUser),columnMetadata(hiddenByUser)))')}`);
      }
      const source = excusalCellsCache.sheets?.find((s: any) => s.properties?.sheetId === binding.sheetId)?.data?.[0];
      if (!source || (source.startRow ?? 0) !== 0 || (source.startColumn ?? 0) !== 0) fail('frontend_table', 'Squadron queue read-back bounds are invalid.');
      const width = table.range.endColumnIndex, row = (r: number) => Array.from({ length: width }, (_, c) => source.rowData?.[r]?.values?.[c] ?? {});
      return { sheetId: binding.sheetId, tableId: binding.tableId, gridRowCount: sheet.properties.gridProperties.rowCount, gridColumnCount: sheet.properties.gridProperties.columnCount,
        headers: row(0).map((c: any) => c.userEnteredValue?.stringValue ?? ''), labels: row(1).map((c: any) => c.userEnteredValue?.stringValue ?? ''),
        rows: Array.from({ length: table.range.endRowIndex - 2 }, (_, r) => row(r + 2)), range: { ...table.range, startColumnIndex: 0 },
        hiddenColumns: Array.from({ length: width }, (_, c) => c).filter(c => source.columnMetadata?.[c]?.hiddenByUser === true), machineRowHidden: source.rowMetadata?.[0]?.hiddenByUser === true };
    }
    function readDashboard(): DashboardPublicationRead {
      if (dashboardCache) return dashboardCache;
      const bound = supplemental!.dashboard, metadata = readMetadata();
      const canvas = metadata.sheets?.find((s: any) => s.properties?.sheetId === bound.sheetId), data = metadata.sheets?.find((s: any) => s.properties?.sheetId === bound.dataSheetId);
      if (!canvas || !data || canvas.tables?.length || data.tables?.length || canvas.properties.gridProperties.columnCount !== 12
        || canvas.properties.gridProperties.rowCount > 602 || data.properties.gridProperties.rowCount > 1002 || data.properties.gridProperties.columnCount > 16) fail('frontend_dashboard', 'Dashboard managed bounds differ from the reviewed canvas.');
      const cells = readFrontendDashboardValues({
        canvas: { sheetId: bound.sheetId, title: canvas.properties.title, ...canvas.properties.gridProperties },
        data: { sheetId: bound.dataSheetId, title: data.properties.title, ...data.properties.gridProperties },
      }, ranges => api(`${sheetsUrl(config.main.spreadsheetId)}?${ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue))))')}`));
      const grid = (s: any) => ({ rowCount: s.properties.gridProperties.rowCount, columnCount: s.properties.gridProperties.columnCount });
      const ranges = (value: any): any => {
        if (Array.isArray(value)) return value.map(ranges);
        if (!value || typeof value !== 'object') return value;
        const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ranges(child)]));
        return natural(result.sheetId) && natural(result.endRowIndex) && natural(result.endColumnIndex)
          ? { ...result, startRowIndex: result.startRowIndex ?? 0, startColumnIndex: result.startColumnIndex ?? 0 } : result;
      };
      dashboardCache = { sheetId: bound.sheetId, dataSheetId: bound.dataSheetId, ...cells,
        canvasGrid: grid(canvas), dataGrid: grid(data), dataHidden: data.properties.hidden === true, merges: ranges(canvas.merges ?? []), charts: ranges(canvas.charts ?? []) };
      return dashboardCache;
    }
    function readNativeSeeds(bookId: string, metadata: Record<string, any>, seeds: NativeFrontendConfig['seeds']): FrontendValidationSeed[] {
      const located = seeds.map(seed => {
        const sheet = metadata.sheets.find((s: any) => s.properties.sheetId === seed.sheetId);
        if (!sheet || !natural(seed.rowIndex) || seed.rowIndex < 2 || !natural(seed.columnIndex)) fail('frontend_seed', 'The native validation seed binding is invalid.');
        return { seed, sheet, a1: `${quoted(sheet.properties.title)}!${column(seed.columnIndex)}${seed.rowIndex + 1}` };
      });
      if (!located.length) return [];
      const data = api(`${sheetsUrl(bookId)}?${located.map(item => `ranges=${encodeURIComponent(item.a1)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(startRow,startColumn,rowData(values(dataValidation))))')}`);
      return located.map(({ seed, sheet }) => {
        const block = data.sheets?.find((s: any) => s.properties.sheetId === seed.sheetId)?.data?.find((b: any) => (b.startRow ?? 0) === seed.rowIndex && (b.startColumn ?? 0) === seed.columnIndex);
        return { ...seed, hidden: sheet.properties.hidden === true, protected: true, observedRule: block?.rowData?.[0]?.values?.[0]?.dataValidation };
      });
    }
    function verifyNativeValidation(plan: FrontendPublicationPlan, bookId: string, metadata: Record<string, any>, sheetIds: number[]): boolean {
      const observations = readFrontendValidationRanges(plan.validationExpectations, {
        sheetTitle(sheetId) {
          if (!sheetIds.includes(sheetId)) fail('frontend_validation', 'Validation read-back targets an unbound sheet.');
          return metadata.sheets?.find((sheet: any) => sheet.properties?.sheetId === sheetId)?.properties.title;
        },
        read(ranges) { return api(`${sheetsUrl(bookId)}?${ranges.map(a1 => `ranges=${encodeURIComponent(a1)}`).join('&')}&includeGridData=true&fields=${encodeURIComponent('sheets(properties(sheetId),data(startRow,startColumn,rowData(values(dataValidation))))')}`, undefined, false, MAX_GOOGLE_BYTES); },
      });
      return verifyFrontendValidationReadback(plan, observations);
    }
    function protectionInput(closed: boolean): FrontendProtectionInput {
      const metadata = readMetadata();
      const access = closed ? { ...config.access, supportEditors: [], permissionManagers: [], directoryEditors: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [] } : config.access;
      // A closed sheet has no editable holes, so cell reads cannot add assurance.
      // Verify its complete native guard from metadata alone on every fence check.
      if (closed) return { access, metadata, surfaces: metadata.sheets.map((s: any) => ({ kind: 'readonly', sheetId: s.properties.sheetId,
        headers: [], dataEndRow: 2, gridRowCount: s.properties.gridProperties.rowCount, gridColumnCount: s.properties.gridProperties.columnCount })) };
      const tables = Object.fromEntries(KINDS.map(kind => [kind, readTable(kind)])) as Record<Kind, FrontendTableRead>;
      return { access, metadata, surfaces: metadata.sheets.map((s: any) => {
        const kind = KINDS.find(k => config.main.sheets[k].sheetId === s.properties.sheetId), grid = s.properties.gridProperties;
        if (!kind) return { kind: 'readonly', sheetId: s.properties.sheetId, headers: [], dataEndRow: 2, gridRowCount: grid.rowCount, gridColumnCount: grid.columnCount };
        const t = tables[kind]; return { kind, sheetId: s.properties.sheetId, headers: t.headers, dataEndRow: t.range.endRowIndex,
          gridRowCount: grid.rowCount, gridColumnCount: grid.columnCount,
          ...(!closed ? { readonlyCells: frontendRowLocks(kind, t, publishedBaselines?.[kind] ?? fail('frontend_state', 'Load the published field policy before restoring edits.')) } : {}),
          ...(kind === 'attendance' ? { eventColumns: t.headers.filter(h => h.startsWith('event:')).map(h => ({ header: h, eventId: h.slice(6) })) } : {}) };
      }) };
    }
    function excusalProtectionInput(closed: boolean): FrontendProtectionInput {
      const book = supplemental!.excusals, metadata = readExcusalMetadata();
      const access = closed ? { ...book.access, supportEditors: [], permissionManagers: [], directoryEditors: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [] } : book.access;
      if (closed) return { access, metadata, surfaces: metadata.sheets.map((s: any) => ({ kind: 'readonly', sheetId: s.properties.sheetId,
        headers: [], dataEndRow: 2, gridRowCount: s.properties.gridProperties.rowCount, gridColumnCount: s.properties.gridProperties.columnCount })) };
      return { access, metadata, surfaces: metadata.sheets.map((s: any) => {
        const queue = QUEUES.find(q => book.sheets[q].sheetId === s.properties.sheetId), grid = s.properties.gridProperties;
        if (!queue) return { kind: 'readonly', sheetId: s.properties.sheetId, headers: [], dataEndRow: 2, gridRowCount: grid.rowCount, gridColumnCount: grid.columnCount };
        const table = readExcusal(queue);
        return { kind: 'excusal', sheetId: s.properties.sheetId, headers: table.headers, dataEndRow: table.range.endRowIndex,
          gridRowCount: grid.rowCount, gridColumnCount: grid.columnCount, squadronId: book.sheets[queue].squadronId,
          ...(!closed ? { readonlyCells: frontendRowLocks('excusal', table, publishedSupplemental?.baselines[queue] ?? fail('frontend_state', 'Load the squadron queue baseline before restoring decisions.')) } : {}) };
      }) };
    }
    const applyRequests = (requests: Record<string, unknown>[], bookId = config.main.spreadsheetId) => {
      if (requests.length > MAX_BATCH_REQUESTS) fail('frontend_capacity', 'Frontend batch exceeds its request bound.');
      try { api(`${sheetsUrl(bookId)}:batchUpdate`, { requests }, false, MAX_GOOGLE_BYTES); }
      finally { invalidateReads(); }
    };
    const writeContent = (requests: Record<string, unknown>[], excusals = false) => {
      const bookId = excusals ? supplemental!.excusals.spreadsheetId : config.main.spreadsheetId;
      const bindings = excusals ? QUEUES.map(q => supplemental!.excusals.sheets[q]) : KINDS.map(kind => config.main.sheets[kind]);
      const seeds = excusals ? supplemental!.excusals.seeds : config.seeds;
      const sheetIds = new Set(bindings.map(b => b.sheetId));
      const tableIds = new Set(bindings.map(b => b.tableId));
      const boundedRange = (range: any) => range && sheetIds.has(range.sheetId) && natural(range.startRowIndex ?? 0)
        && natural(range.endRowIndex) && range.endRowIndex <= 502 && range.endRowIndex > (range.startRowIndex ?? 0)
        && natural(range.startColumnIndex ?? 0) && natural(range.endColumnIndex) && range.endColumnIndex <= 160
        && range.endColumnIndex > (range.startColumnIndex ?? 0);
      for (const request of requests) {
        const entries = Object.entries(request); if (entries.length !== 1) fail('frontend_request', 'A retained frontend request is invalid.');
        const [operation, raw] = entries[0], body = record(raw);
        const dashboard = !excusals ? supplemental?.dashboard : undefined;
        const dashboardSheet = body.range?.sheetId ?? body.properties?.sheetId;
        if (dashboard && (operation === 'updateChartSpec' || [dashboard.sheetId, dashboard.dataSheetId].includes(dashboardSheet))) {
          const isData = dashboardSheet === dashboard.dataSheetId, maxRows = isData ? 1002 : 602, maxColumns = isData ? 16 : 12;
          const inRange = (r: any) => r && [dashboard.sheetId, dashboard.dataSheetId].includes(r.sheetId) && natural(r.startRowIndex ?? 0)
            && natural(r.endRowIndex) && r.endRowIndex > (r.startRowIndex ?? 0) && r.endRowIndex <= maxRows
            && natural(r.startColumnIndex ?? 0) && natural(r.endColumnIndex) && r.endColumnIndex > (r.startColumnIndex ?? 0) && r.endColumnIndex <= maxColumns;
          if (operation === 'updateCells') {
            if (!inRange(body.range) || body.fields !== 'userEnteredValue' || !Array.isArray(body.rows)
              || body.rows.length !== body.range.endRowIndex - (body.range.startRowIndex ?? 0)
              || body.rows.some((row: any) => !Array.isArray(row.values) || row.values.length !== body.range.endColumnIndex - (body.range.startColumnIndex ?? 0)
                || row.values.some((cell: any) => cell.userEnteredValue?.formulaValue && !dashboard.actions.some(a => cell.userEnteredValue.formulaValue === `=HYPERLINK("${a.url}","Open →")`)))) fail('frontend_request', 'Dashboard cell write is outside its approved bounds or links.');
          } else if (operation === 'updateChartSpec') {
            if (!dashboard.chartIds.includes(body.chartId) || !body.spec?.basicChart) fail('frontend_request', 'An unbound Dashboard chart update was retained.');
            const chart = body.spec.basicChart;
            const sources = [...(chart.domains ?? []).map((d: any) => d.domain), ...(chart.series ?? []).map((s: any) => s.series)];
            if (!sources.length || sources.some((s: any) => !Array.isArray(s?.sourceRange?.sources) || s.sourceRange.sources.some((r: any) => r.sheetId !== dashboard.dataSheetId || !natural(r.startRowIndex ?? 0) || !natural(r.endRowIndex) || r.endRowIndex > 1002 || !natural(r.startColumnIndex ?? 0) || !natural(r.endColumnIndex) || r.endColumnIndex > 16))) fail('frontend_request', 'Dashboard charts must use the bound hidden source sheet.');
          } else if (operation === 'mergeCells' || operation === 'unmergeCells') {
            if (isData || !inRange(body.range) || body.range.startRowIndex < 47 || (operation === 'mergeCells' && body.mergeType !== 'MERGE_ALL')) fail('frontend_request', 'Dashboard merge is outside the owned footer.');
          } else if (operation === 'repeatCell') {
            if (!inRange(body.range) || !['userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment', 'userEnteredFormat.textFormat.bold', 'userEnteredFormat.numberFormat'].includes(body.fields)) fail('frontend_request', 'Dashboard formatting exceeds the approved field masks.');
          } else if (operation === 'updateDimensionProperties') {
            if (isData || body.range.dimension !== 'ROWS' || !natural(body.range.startIndex) || body.range.startIndex < 51 || !natural(body.range.endIndex) || body.range.endIndex > 602 || body.fields !== 'pixelSize' || body.properties?.pixelSize !== 48) fail('frontend_request', 'Dashboard birthday layout exceeds its bounds.');
          } else if (operation === 'updateSheetProperties') {
            if (body.fields === 'hidden') { if (!isData || body.properties.hidden !== true) fail('frontend_request', 'Only the Dashboard data sheet may be hidden.'); }
            else if (body.fields !== 'gridProperties.rowCount,gridProperties.columnCount' || !natural(body.properties.gridProperties?.rowCount) || body.properties.gridProperties.rowCount > maxRows || body.properties.gridProperties.columnCount !== maxColumns) fail('frontend_request', 'Dashboard grid update exceeds its approved bounds.');
          } else fail('frontend_request', 'Unsupported operation on the Dashboard.');
          continue;
        }
        if (operation === 'updateCells') {
          if (!boundedRange(body.range) || !['userEnteredValue', 'userEnteredValue,chipRuns'].includes(body.fields)
            || !Array.isArray(body.rows) || body.rows.length !== body.range.endRowIndex - (body.range.startRowIndex ?? 0)
            || body.rows.some((r: any) => !Array.isArray(r.values) || r.values.length !== body.range.endColumnIndex - (body.range.startColumnIndex ?? 0))) fail('frontend_request', 'A retained frontend cell write exceeds its exact target.');
        } else if (operation === 'updateTable') {
          if (body.fields !== 'range' || !tableIds.has(body.table?.tableId) || !boundedRange(body.table?.range)) fail('frontend_request', 'A retained frontend Table write is outside the approved bindings.');
        } else if (operation === 'updateSheetProperties') {
          if (body.fields !== 'gridProperties.rowCount,gridProperties.columnCount' || !sheetIds.has(body.properties?.sheetId)
            || !natural(body.properties?.gridProperties?.rowCount) || body.properties.gridProperties.rowCount < 3 || body.properties.gridProperties.rowCount > 10002
            || !natural(body.properties?.gridProperties?.columnCount) || body.properties.gridProperties.columnCount < 1 || body.properties.gridProperties.columnCount > 512) fail('frontend_request', 'A retained frontend grid update is invalid.');
        } else if (!excusals && (operation === 'repeatCell' || (operation === 'updateDimensionProperties' && body.fields === 'pixelSize'))) {
          assertNativeAttendanceLayoutRequest(request, config.main.sheets.attendance.sheetId);
        } else if (operation === 'updateDimensionProperties') {
          if (body.fields !== 'hiddenByUser' || body.properties?.hiddenByUser !== true || !sheetIds.has(body.range?.sheetId)
            || !['ROWS', 'COLUMNS'].includes(body.range.dimension) || !natural(body.range.startIndex) || !natural(body.range.endIndex)
            || body.range.endIndex <= body.range.startIndex || body.range.endIndex > 160) fail('frontend_request', 'A retained frontend hidden-identity update is invalid.');
        } else if (operation === 'copyPaste') {
          const source = body.source;
          if (!boundedRange(body.destination) || body.pasteType !== 'PASTE_DATA_VALIDATION' || body.pasteOrientation !== 'NORMAL'
            || !seeds.some(seed => source?.sheetId === seed.sheetId && source.startRowIndex === seed.rowIndex && source.endRowIndex === seed.rowIndex + 1
              && source.startColumnIndex === seed.columnIndex && source.endColumnIndex === seed.columnIndex + 1)) fail('frontend_request', 'A retained validation copy is outside its protected seed binding.');
        } else fail('frontend_request', 'Unsupported operation in the retained frontend publication.');
      }
      applyRequests(requests, bookId);
    };
    const assertPolicy = (closed: boolean) => {
      invalidateReads();
      if (!verifyFrontendProtections(protectionInput(closed)).ready || (supplemental && !verifyFrontendProtections(excusalProtectionInput(closed)).ready)) fail('frontend_protection', 'The exact frontend edit protection policy is not verified across its configured books.');
    };
    const setPolicy = (closed: boolean) => {
      const plan = planFrontendProtections(protectionInput(closed)); if (plan.requests.length) applyRequests(plan.requests);
      if (supplemental) { const other = planFrontendProtections(excusalProtectionInput(closed)); if (other.requests.length) applyRequests(other.requests, supplemental.excusals.spreadsheetId); }
      assertPolicy(closed);
    };
    const checkpoint = createPrivateCheckpoint<FrontendPublicationState>({
      version() { const info = inspectFile(config.stateFileId, host.expectedAutomationEmail);
        if (Number(info.size) > MAX_STATE_BYTES) fail('frontend_state', 'The private state file exceeds its bound.'); return String(info.version); },
      read: () => api(`${driveUrl(config.stateFileId)}?alt=media`),
      write(value) { const updated = api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.stateFileId)}?uploadType=media&fields=id,version`, value, true);
        if (updated.id !== config.stateFileId || !updated.version) fail('frontend_state', 'Private state persistence was not acknowledged.'); },
      validate: value => validState(value as FrontendPublicationState, host.generation), digest: value => signer.sha256(canonical(value)),
    });
    const runtime: FrontendRefreshPorts = {
      config: { baseUrl: host.workerOrigin, keyId: host.keyId, environment: 'staging', generation: host.generation }, workerId: config.workerId, principalId: config.principalId,
      recovery: config.leaseRecovery,
      signer, transport: createPagedFrontendTransport(createGoogleTransport(services.UrlFetchApp), {environment:'staging',generation:config.generation,baseUrl:host.workerOrigin,keyId:host.keyId},signer,now), lock: services.LockService.getScriptLock(), nowSeconds: now,
      enabled: () => config.enabled && properties.getProperty(FRONTEND_PROPERTIES.pause) !== 'true',
      assertIsolation() {
        if (account() !== host.expectedAutomationEmail) fail('frontend_identity', 'Frontend execution identity changed.');
        const book = inspectFile(config.main.spreadsheetId, host.expectedAutomationEmail, config.allowedFileEditors);
        if (book.mimeType !== 'application/vnd.google-apps.spreadsheet' || book.name !== config.main.expectedTitle) fail('frontend_isolation', 'The frontend binding is not the reviewed native staging spreadsheet.');
        if (supplemental) {
          const other = inspectFile(supplemental.excusals.spreadsheetId, host.expectedAutomationEmail, supplemental.excusals.allowedFileEditors);
          if (other.mimeType !== 'application/vnd.google-apps.spreadsheet' || other.name !== supplemental.excusals.expectedTitle) fail('frontend_isolation', 'The Excusals binding is not the reviewed native staging spreadsheet.');
        }
        const state = inspectFile(config.stateFileId, host.expectedAutomationEmail);
        if (state.mimeType !== 'application/json' || Number(state.size) > MAX_STATE_BYTES) fail('frontend_state', 'The private frontend state file is invalid or oversized.');
      },
      claimStore: {
        load() { const raw = properties.getProperty(FRONTEND_PROPERTIES.claim); return raw ? parseClaim(JSON.parse(raw)) : undefined; },
        save(claim) { properties.setProperty(FRONTEND_PROPERTIES.claim, JSON.stringify(claim)); },
        clear(claim) { const raw = properties.getProperty(FRONTEND_PROPERTIES.claim); if (!raw || !equal(JSON.parse(raw), claim)) fail('frontend_claim', 'The retained frontend claim changed.'); properties.deleteProperty(FRONTEND_PROPERTIES.claim); },
      },
      state: {
        load() { const verified = checkpoint.load();
          publishedBaselines = clone(verified.baselines); publishedSupplemental = verified.supplemental ? clone(verified.supplemental) : undefined; return verified; },
        save(value) { checkpoint.save(value); publishedBaselines = clone(value.baselines);
          publishedSupplemental = value.supplemental ? clone(value.supplemental) : undefined; },
      },
      buildModel: modelBuilder ?? (snapshot => {
        if (!services.Utilities.formatDate) fail('frontend_configuration', 'A detachment-local calendar date provider is required.');
        return buildCoherentFrontendModel(snapshot, services.Utilities.formatDate(new Date(now() * 1000), 'America/Indiana/Indianapolis', 'yyyy-MM-dd'));
      }), fenceEdits: () => setPolicy(true), assertFenced: () => assertPolicy(true), readTable, refreshReads: invalidateReads,
      readSeeds() { assertPolicy(true); return readNativeSeeds(config.main.spreadsheetId, readMetadata(), config.seeds); },
      verifyValidation: plan => verifyNativeValidation(plan, config.main.spreadsheetId, readMetadata(), KINDS.map(kind => config.main.sheets[kind].sheetId)),
      writeAtomic: requests => writeContent(requests), restoreEditPolicy: () => setPolicy(false), assertEditPolicy: () => assertPolicy(false),
      pause: pauseFrontend,
    };
    if (supplemental) runtime.supplemental = {
      plan(snapshot, state) {
        if (!services.Utilities.formatDate) fail('frontend_configuration', 'A detachment-local date provider is required.');
        const reporting = { revision: snapshot.revision, result: buildFrontendReporting(snapshotToFrontendReportingInput(snapshot,
          services.Utilities.formatDate(new Date(now() * 1000), 'America/Indiana/Indianapolis', 'yyyy-MM-dd'))) };
        const dashboard = planDashboardPublication({ revision: snapshot.revision, previousRevision: state.dashboardRevision, reporting,
          current: readDashboard(), chartIds: supplemental.dashboard.chartIds, actions: supplemental.dashboard.actions, editFenceVerified: true });
        const models = buildExcusalPublicationTables({ snapshot, blueSquadronId: supplemental.excusals.sheets.blue.squadronId,
          goldSquadronId: supplemental.excusals.sheets.gold.squadronId, timeZone: 'America/Indiana/Indianapolis',
          timestampSerial(iso, timeZone) {
            const local = services.Utilities.formatDate!(new Date(iso), timeZone, 'yyyy-MM-dd HH:mm:ss');
            if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(local)) fail('frontend_contract', 'The native timestamp formatter returned invalid calendar fields.');
            return (Date.parse(local.replace(' ', 'T') + 'Z') - Date.UTC(1899, 11, 30)) / 86400000;
          } });
        const seeds = readNativeSeeds(supplemental.excusals.spreadsheetId, readExcusalMetadata(), supplemental.excusals.seeds);
        const excusals = Object.fromEntries(QUEUES.map(queue => {
          const table = models.find(model => model.squadronId === supplemental.excusals.sheets[queue].squadronId)!;
          return [queue, planExcusalPublication({ generation: snapshot.generation, revision: snapshot.revision, table, current: readExcusal(queue),
            baseline: state.baselines[queue], drafts: state.drafts[queue], seeds, editFenceVerified: true })];
        })) as FrontendSupplementalPlans['excusals'];
        return { dashboard, excusals };
      },
      readDashboard, readExcusal,
      verifyValidation: plan => verifyNativeValidation(plan, supplemental.excusals.spreadsheetId, readExcusalMetadata(), QUEUES.map(q => supplemental.excusals.sheets[q].sheetId)),
      writeAtomic: requests => writeContent(requests, true),
    };
    if (inputOperation) {
      if (!runtime.lock.tryLock(25_000)) fail('frontend_busy', 'Another adapter operation is active.');
      try {
        if (!runtime.enabled() && !allowPausedInput) return {status: 'disabled' as const};
        runtime.assertIsolation(); const state = runtime.state.load();
        if (runtime.claimStore.load() || state.pending) fail('frontend_input_fenced', 'Finish the retained publication before processing spreadsheet input.');
        runtime.refreshReads?.(); runtime.assertEditPolicy();
        return inputOperation({config, automationEmail: host.expectedAutomationEmail, adapter: runtime.config, signer, transport: runtime.transport, nowSeconds: now, state,
          read: surface => surface === 'blue' || surface === 'gold' ? runtime.supplemental?.readExcusal(surface) ?? fail('frontend_configuration', 'The squadron queue is not bound.') : runtime.readTable(surface),
          save: value => { runtime.state.save(value); if (!equal(runtime.state.load(), value)) fail('frontend_state', 'The input checkpoint did not persist.'); },
          fence: () => { runtime.fenceEdits(); runtime.assertFenced(); runtime.refreshReads?.(); },
          restore: () => { runtime.restoreEditPolicy(); runtime.assertEditPolicy(); runtime.refreshReads?.(); },
        });
      } finally { runtime.lock.releaseLock(); }
    }
    return consumeFrontendRefresh(runtime);
  }
  return { refresh: () => refresh(), inputSession: (operation: (session: NativeFrontendInputSession) => unknown, options: {allowPaused?: boolean} = {}) => refresh(operation, options.allowPaused === true),
    pause() { pauseFrontend(); return { status: 'paused' as const }; },
    resume() {
      const configured = configuration(); if (!configured || !configured.frontend.enabled) fail('frontend_configuration', 'Enable only a reviewed staging frontend configuration.');
      properties.deleteProperty(FRONTEND_PROPERTIES.pause);
      if (properties.getProperty(FRONTEND_PROPERTIES.pause) !== null) fail('frontend_state', 'The frontend pause override could not be cleared.');
      return { status: 'ready-for-staging-retry' as const };
    },
  };
}
