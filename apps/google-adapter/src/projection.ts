/** Isolated projection publisher. The host binds existing sheets; this module never creates,
 * deletes, sorts or replaces a sheet, and never receives a decision-input sheet. */
import { AdapterError, buildSignedJobRequest, type AdapterConfig, type Signer, type Transport } from './index.js';
import type { ScriptLockPort } from './apps-script.js';

type Cell = string | number | boolean;
type Row = Record<string, Cell>;
export type ProjectionSheetKind = 'attendance' | 'decisions' | 'cursors';

export interface ProjectionSheetPort {
  getLastRow(): number;
  getLastColumn(): number;
  getRange(row: number, column: number, rows: number, columns: number): {
    getValues(): unknown[][];
    getFormulas(): string[][];
  };
  /** Must write literal values, including strings beginning '=' or apostrophe.
   * Bind to Sheets.Values.batchUpdate with valueInputOption RAW, not Range.setValues.
   * https://developers.google.com/sheets/api/reference/rest/v4/ValueInputOption */
  writeRaw(row: number, column: number, values: Cell[][]): void;
}
export type ProjectionSheets = Record<ProjectionSheetKind, ProjectionSheetPort>;

export const PROJECTION_HEADERS = {
  attendance: ['event_id', 'unit_id', 'person_id', 'event_label', 'unit_label', 'display_name',
    'observed_code', 'in_current_scope', 'generation', 'projection_revision'],
  decisions: ['event_id', 'unit_id', 'person_id', 'request_id', 'display_name', 'recorded_status',
    'requested_outcome', 'approved_outcome', 'recorded_version', 'generation', 'projection_revision', 'event_label', 'unit_label'],
  cursors: ['event_id', 'unit_id', 'generation', 'projection_revision', 'snapshot_hash'],
} as const;
const DISPLAY_HEADERS: Record<ProjectionSheetKind, readonly string[]> = {
  attendance: ['Event ID', 'Unit ID', 'Person ID', 'Event', 'Unit', 'Name', 'Observed attendance',
    'In current roster', 'Generation', 'Projection revision'],
  decisions: ['Event ID', 'Unit ID', 'Person ID', 'Request ID', 'Name', 'Recorded status',
    'Requested outcome', 'Approved outcome', 'Recorded version', 'Generation', 'Projection revision', 'Event', 'Unit'],
  cursors: ['Event ID', 'Unit ID', 'Generation', 'Projection revision', 'Snapshot hash'],
};
const KINDS: ProjectionSheetKind[] = ['attendance', 'decisions', 'cursors'];
const STATUSES = ['Submitted', 'Approved', 'Denied', 'Withdrawn', 'Superseded'] as const;
const OUTCOMES = ['P', 'T', 'E', 'ES', 'MED'] as const;

export interface ProjectionSnapshot {
  revision: number;
  event: { eventId: string; label: string };
  unit: { unitId: string; label: string };
  rows: {
    personId: string; displayName: string; observedCode: 'P' | null;
    requests: { requestId: string; status: typeof STATUSES[number]; requestedOutcome: typeof OUTCOMES[number]; version: number }[];
  }[];
}
export interface ProjectionClaim {
  jobId: string; claimToken: string; leaseExpiresAt: string;
  eventId: string; unitId: string; kind: 'attendance.projection';
}
export interface ProjectionClaimStore {
  /** Private durable storage, scoped to this adapter/environment/generation. */
  load(): ProjectionClaim | undefined;
  save(claim: ProjectionClaim): void;
  clear(claim: ProjectionClaim): void;
}
export interface ProjectionRuntime {
  config: AdapterConfig;
  signer: Signer;
  transport: Transport;
  nowSeconds(): number;
  workerId: string;
  lock: ScriptLockPort;
  sheets: ProjectionSheets;
  claimStore: ProjectionClaimStore;
  /** Must verify effective protection of the ENTIRE bound output table, including
   * headers, future rows and all listed columns. Warning-only protection is insufficient.
   * Ordinary editors must have no edit access; all writers must share this script lock. */
  assertProtected(kind: ProjectionSheetKind, headers: readonly string[]): void;
  /** Apply pending SpreadsheetApp operations before read-back. */
  flush(): void;
  /** Optional protected input-slot allocation under this same lock, after recorded
   * output read-back and before ACK. Failure retains the durable claim. */
  publishDecisionSlots?(snapshot: ProjectionSnapshot): void;
}

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
function object(value: unknown, keys: readonly string[], code = 'invalid_projection'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'Expected a structured projection value.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
    fail(code, 'The projection contract has unexpected or missing fields.');
  }
  return record;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('invalid_projection', 'Invalid projection identifier.');
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('invalid_projection', 'Invalid projection version.');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) fail('invalid_projection', 'Invalid projection label.');
  return value;
}
function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) fail('invalid_signer', 'Invalid projection digest.');
  return value;
}

/** Copy and canonicalize the complete snapshot before any spreadsheet mutation. */
export function parseProjectionSnapshot(input: unknown): ProjectionSnapshot {
  const raw = object(input, ['revision', 'event', 'unit', 'rows']);
  const event = object(raw.event, ['eventId', 'label']);
  const unit = object(raw.unit, ['unitId', 'label']);
  if (!Array.isArray(raw.rows) || raw.rows.length > 500) fail('projection_too_large', 'Projection exceeds the bounded roster size.');
  const people = new Set<string>();
  const requests = new Set<string>();
  const rows = raw.rows.map(value => {
    const row = object(value, ['personId', 'displayName', 'observedCode', 'requests']);
    const personId = id(row.personId);
    if (people.has(personId)) fail('invalid_projection', 'Duplicate projection person.');
    people.add(personId);
    if (row.observedCode !== null && row.observedCode !== 'P') fail('invalid_projection', 'Unsupported observation in this prototype.');
    if (!Array.isArray(row.requests) || row.requests.length > 1000) fail('projection_too_large', 'Projection exceeds the bounded request size.');
    const requestRows = row.requests.map(value => {
      const request = object(value, ['requestId', 'status', 'requestedOutcome', 'version']);
      const requestId = id(request.requestId);
      if (requests.has(requestId)) fail('invalid_projection', 'Duplicate projection request.');
      requests.add(requestId);
      if (!STATUSES.includes(request.status as typeof STATUSES[number]) || !OUTCOMES.includes(request.requestedOutcome as typeof OUTCOMES[number])) {
        fail('invalid_projection', 'Unsupported request status or outcome.');
      }
      return { requestId, status: request.status as typeof STATUSES[number], requestedOutcome: request.requestedOutcome as typeof OUTCOMES[number], version: positive(request.version) };
    }).sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
    return { personId, displayName: label(row.displayName), observedCode: row.observedCode as 'P' | null, requests: requestRows };
  }).sort((a, b) => a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0);
  if (requests.size > 1000) fail('projection_too_large', 'Projection exceeds the bounded request size.');
  return { revision: positive(raw.revision), event: { eventId: id(event.eventId), label: label(event.label) },
    unit: { unitId: id(unit.unitId), label: label(unit.label) }, rows };
}

function parseClaim(input: unknown): ProjectionClaim {
  const raw = object(input, ['jobId', 'claimToken', 'leaseExpiresAt', 'eventId', 'unitId', 'kind'], 'invalid_claim');
  if (raw.kind !== 'attendance.projection' || typeof raw.leaseExpiresAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.leaseExpiresAt) || !Number.isFinite(Date.parse(raw.leaseExpiresAt))) {
    fail('invalid_claim', 'Invalid projection lease.');
  }
  return { jobId: id(raw.jobId), claimToken: id(raw.claimToken), eventId: id(raw.eventId), unitId: id(raw.unitId),
    kind: raw.kind, leaseExpiresAt: raw.leaseExpiresAt };
}
function key(row: Row, kind: ProjectionSheetKind): string {
  return kind === 'decisions' ? id(row.request_id) : JSON.stringify(kind === 'attendance'
    ? [id(row.event_id), id(row.unit_id), id(row.person_id)] : [id(row.event_id), id(row.unit_id)]);
}
interface Table { headers: string[]; rows: Row[]; sourceValues: unknown[][] }
function readTable(sheet: ProjectionSheetPort, kind: ProjectionSheetKind, maxRows: number,
  expected: readonly string[] = PROJECTION_HEADERS[kind]): Table {
  const height = sheet.getLastRow();
  const width = sheet.getLastColumn();
  if (!Number.isSafeInteger(height) || height < 2 || height > maxRows + 2 || width !== expected.length) {
    fail('projection_schema', 'The projection sheet schema or size needs review.');
  }
  const range = sheet.getRange(1, 1, height, width);
  const values = range.getValues();
  const formulas = range.getFormulas();
  if (values.length !== height || values.some(row => row.length !== width)
    || formulas.length !== height || formulas.some(row => row.length !== width || row.some(Boolean))) {
    fail('projection_schema', 'Projection output must contain literal values with the expected shape.');
  }
  const headers = values[0];
  if (new Set(headers).size !== expected.length || expected.some(name => !headers.includes(name))) {
    fail('projection_schema', 'The projection machine headers need repair.');
  }
  const names = headers as string[];
  const found = new Set<string>();
  const rows = values.slice(2).map(cells => {
    if (cells.some(cell => !['string', 'number', 'boolean'].includes(typeof cell))) fail('projection_schema', 'Unsupported projection cell value.');
    const row = Object.fromEntries(names.map((name, index) => [name, cells[index]])) as Row;
    const rowKey = key(row, kind);
    if (found.has(rowKey)) fail('projection_schema', 'Duplicate or rebound projection row.');
    found.add(rowKey);
    positive(row.generation); positive(row.projection_revision);
    if (kind === 'decisions') { id(row.event_id); id(row.unit_id); id(row.person_id); positive(row.recorded_version); }
    if (expected.includes('event_label')) { label(row.event_label); label(row.unit_label); }
    return row;
  });
  return { headers: names, rows, sourceValues: values };
}

/** Explicit paused maintenance only. The native host must hold the shared lock,
 * check all three output protections/ownership, and refuse outstanding claims.
 * Upgrades only the immediately preceding eleven-column recorded-output schema.
 * Labels come from consistently published attendance scopes, never guessed IDs.
 * One RAW write appends two columns; all original cells and cursors are preserved.
 */
export function upgradeRecordedDecisionLabels(sheets: ProjectionSheets, options: { generation: number }): { upgraded: boolean; rows: number } {
  const generation = positive(options.generation), target = sheets.decisions;
  if (target.getLastRow() === 0 && target.getLastColumn() === 0) return { upgraded: false, rows: 0 };
  const width = target.getLastColumn();
  if (width !== 11 && width !== PROJECTION_HEADERS.decisions.length) fail('projection_schema', 'The recorded-output upgrade requires the exact preceding or current schema.');
  const decisions = readTable(target, 'decisions', 2000, width === 11 ? PROJECTION_HEADERS.decisions.slice(0, 11) : PROJECTION_HEADERS.decisions);
  if (decisions.rows.some(row => row.generation !== generation)) fail('wrong_generation', 'Recorded outputs belong to another deployment generation.');
  if (width === PROJECTION_HEADERS.decisions.length) return { upgraded: false, rows: decisions.rows.length };
  const attendance = readTable(sheets.attendance, 'attendance', 2000), cursors = readTable(sheets.cursors, 'cursors', 2000);
  if ([...attendance.rows, ...cursors.rows].some(row => row.generation !== generation)) fail('wrong_generation', 'Published label sources belong to another deployment generation.');
  const scopeKey = (row: Row) => JSON.stringify([id(row.event_id), id(row.unit_id)]);
  const published = new Map(cursors.rows.map(row => {
    if (typeof row.snapshot_hash !== 'string') fail('projection_schema', 'The publication watermark hash is malformed.');
    digest(row.snapshot_hash);
    return [scopeKey(row), Number(row.projection_revision)] as const;
  }));
  const labels = new Map<string, [string, string]>();
  for (const row of attendance.rows) {
    const key = scopeKey(row), revision = published.get(key);
    if (!revision || row.projection_revision !== revision) fail('projection_schema', 'Attendance labels do not match their publication watermark.');
    const pair: [string, string] = [label(row.event_label), label(row.unit_label)];
    if (labels.has(key) && !same(labels.get(key), pair)) fail('projection_conflict', 'Published attendance labels disagree for a recorded-output scope.');
    labels.set(key, pair);
  }
  const additions: Cell[][] = [['event_label', 'unit_label'], ['Event', 'Unit'], ...decisions.rows.map(row => {
    const key = scopeKey(row), pair = labels.get(key), revision = published.get(key);
    if (!pair || !revision || row.projection_revision !== revision) fail('projection_schema', 'A recorded request lacks consistent published event and unit labels.');
    return [...pair];
  })];
  const expected = decisions.sourceValues.map((row, index) => [...row, ...additions[index]]);
  // All validation precedes the sole append. A provider ambiguity requires a fresh
  // read: a complete upgrade is idempotent; partial schemas are never guessed.
  target.writeRaw(1, 12, additions);
  const actual = readTable(target, 'decisions', 2000);
  if (!same(actual.sourceValues, expected)) fail('projection_readback', 'The recorded-output upgrade did not preserve and verify every original cell.');
  return { upgraded: true, rows: decisions.rows.length };
}

/** Explicit setup only. Initializes EMPTY, already configured tabs; existing sheets
 * are validated without altering headers, formatting, protections or filter views.
 * The host must protect the tables before enabling publication. */
export function initializeProjectionSheets(sheets: ProjectionSheets): void {
  for (const kind of KINDS) {
    const sheet = sheets[kind];
    if (sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {
      sheet.writeRaw(1, 1, [[...PROJECTION_HEADERS[kind]], [...DISPLAY_HEADERS[kind]]]);
    } else readTable(sheet, kind, 2000);
  }
}

function asValues(table: Table): Cell[][] { return table.rows.map(row => table.headers.map(name => row[name])); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function scope(row: Row, snapshot: ProjectionSnapshot): boolean { return row.event_id === snapshot.event.eventId && row.unit_id === snapshot.unit.unitId; }

/** Caller must hold the shared script lock. Produces only recorded facts; no absence,
 * attendance percentage, final attendance code or decision-input values are inferred. */
export function publishProjectionSnapshot(
  input: unknown,
  runtime: Pick<ProjectionRuntime, 'config' | 'signer' | 'sheets' | 'assertProtected' | 'flush'>,
  options: { maxRows?: number; beforeWrite?: () => void } = {},
): { revision: number; attendanceRows: number; requestRows: number } {
  const snapshot = parseProjectionSnapshot(input);
  const generation = positive(runtime.config.generation);
  if (runtime.config.environment !== 'local' && runtime.config.environment !== 'staging') fail('invalid_environment', 'Only isolated publication is supported.');
  const maxRows = options.maxRows ?? 2000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 2000) fail('projection_too_large', 'Invalid publication row bound.');
  const hash = digest(runtime.signer.sha256(JSON.stringify(snapshot)));
  const tables = {} as Record<ProjectionSheetKind, Table>;
  const originals = {} as Record<ProjectionSheetKind, Cell[][]>;
  for (const kind of KINDS) {
    runtime.assertProtected(kind, PROJECTION_HEADERS[kind]);
    tables[kind] = readTable(runtime.sheets[kind], kind, maxRows);
    originals[kind] = asValues(tables[kind]);
    for (const row of tables[kind].rows) {
      if (row.generation !== generation) fail('wrong_generation', 'The output table belongs to a different deployment generation.');
      if (scope(row, snapshot) && Number(row.projection_revision) > snapshot.revision) fail('stale_projection', 'A newer snapshot is already recorded.');
    }
  }
  const cursor = tables.cursors.rows.find(row => scope(row, snapshot));
  if (cursor?.projection_revision === snapshot.revision && cursor.snapshot_hash !== hash) fail('projection_conflict', 'The same revision contains different facts.');
  const incomingRequests = new Map(snapshot.rows.flatMap(person => person.requests.map(request => [request.requestId, { person, request }] as const)));
  for (const existing of tables.decisions.rows) {
    const incoming = incomingRequests.get(String(existing.request_id));
    if (incoming && (!scope(existing, snapshot) || existing.person_id !== incoming.person.personId)) fail('projection_conflict', 'A request row cannot change its subject or scope.');
    if (!scope(existing, snapshot)) continue;
    if (!incoming) fail('projection_incomplete', 'A previously published request is missing from the snapshot.');
    if (Number(existing.recorded_version) > incoming.request.version) fail('stale_projection', 'A newer request version is already recorded.');
    if (existing.recorded_version === incoming.request.version && (existing.recorded_status !== incoming.request.status
      || existing.requested_outcome !== incoming.request.requestedOutcome)) fail('projection_conflict', 'The same request version contains different facts.');
  }
  function upsert(kind: ProjectionSheetKind, row: Row): void {
    const rows = tables[kind].rows;
    const index = rows.findIndex(existing => key(existing, kind) === key(row, kind));
    if (index < 0) rows.push(row); else rows[index] = row;
  }
  const presentIds = new Set(snapshot.rows.map(person => person.personId));
  for (const row of tables.attendance.rows) {
    if (scope(row, snapshot) && !presentIds.has(String(row.person_id))) {
      row.in_current_scope = false;
      row.projection_revision = snapshot.revision;
    }
  }
  for (const person of snapshot.rows) {
    const existing = tables.attendance.rows.find(row => scope(row, snapshot) && row.person_id === person.personId);
    // This slice only adds P observations. A newer snapshot cannot remove existing P.
    if (existing?.observed_code === 'P' && person.observedCode !== 'P') fail('projection_conflict', 'Observation removal needs an explicit correction workflow.');
    upsert('attendance', { event_id: snapshot.event.eventId, unit_id: snapshot.unit.unitId, person_id: person.personId,
      event_label: snapshot.event.label, unit_label: snapshot.unit.label, display_name: person.displayName,
      observed_code: person.observedCode ?? '', in_current_scope: true, generation, projection_revision: snapshot.revision });
    for (const request of person.requests) upsert('decisions', {
      event_id: snapshot.event.eventId, unit_id: snapshot.unit.unitId, person_id: person.personId, request_id: request.requestId,
      display_name: person.displayName, recorded_status: request.status, requested_outcome: request.requestedOutcome,
      approved_outcome: request.status === 'Approved' ? request.requestedOutcome : '', recorded_version: request.version,
      generation, projection_revision: snapshot.revision, event_label: snapshot.event.label, unit_label: snapshot.unit.label,
    });
  }
  upsert('cursors', { event_id: snapshot.event.eventId, unit_id: snapshot.unit.unitId, generation, projection_revision: snapshot.revision, snapshot_hash: hash });
  if (KINDS.some(kind => tables[kind].rows.length > maxRows)) fail('projection_too_large', 'The output table needs a reviewed paging strategy.');
  function write(kind: ProjectionSheetKind): void {
    const values = asValues(tables[kind]);
    if (same(values, originals[kind])) return;
    options.beforeWrite?.();
    runtime.assertProtected(kind, PROJECTION_HEADERS[kind]);
    // Exactly one bounded RAW data-range write per changed table; never headers or inputs.
    runtime.sheets[kind].writeRaw(3, 1, values);
  }
  function verify(kind: ProjectionSheetKind): void {
    runtime.assertProtected(kind, PROJECTION_HEADERS[kind]);
    const actual = readTable(runtime.sheets[kind], kind, maxRows);
    if (!same(actual.headers, tables[kind].headers) || !same(asValues(actual), asValues(tables[kind]))) {
      fail('projection_readback', 'Published output did not read back exactly; retain the claim for review.');
    }
  }
  write('attendance'); write('decisions'); runtime.flush();
  verify('attendance'); verify('decisions');
  // Commit the watermark only after every output range reads back exactly.
  write('cursors'); runtime.flush(); verify('cursors');
  return { revision: snapshot.revision, attendanceRows: snapshot.rows.length, requestRows: incomingRequests.size };
}

/** Bounded synchronous Apps Script consumer. Failed/ambiguous publication keeps the
 * durable claim and never ACKs. A lease is never stolen; expiry/ambiguous ACK requires
 * explicit reconciliation. Physical protection and a single cooperating writer are
 * required: a script lock cannot stop an owner or an external Sheets API writer. */
export function consumeProjectionJobs(runtime: ProjectionRuntime, options: { limit?: number; maxRows?: number } = {}): { published: number; idle: boolean } {
  const limit = options.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) fail('invalid_batch', 'Publication batches must contain one to five jobs.');
  if (!runtime.lock.tryLock(100)) fail('projection_busy', 'Another publication is in progress.');
  try {
    let published = 0;
    function send(path: '/v1/jobs/claim' | '/v1/jobs/project' | '/v1/jobs/ack', claim?: ProjectionClaim): unknown {
      const response = runtime.transport.send(buildSignedJobRequest(path, { workerId: runtime.workerId,
        ...(claim ? { jobId: claim.jobId, claimToken: claim.claimToken } : {}) }, runtime.config, runtime.signer, runtime.nowSeconds()));
      if (response.status !== 200) fail('projection_delivery', 'The projection operation needs retry or operator review.');
      if (typeof response.body !== 'string' || response.body.length > 2_000_000) fail('invalid_projection', 'Invalid projection response size.');
      try { return JSON.parse(response.body); } catch { fail('invalid_projection', 'Invalid projection response.'); }
    }
    for (let i = 0; i < limit; i++) {
      let claim = runtime.claimStore.load();
      if (!claim) {
        const response = object(send('/v1/jobs/claim'), ['job'], 'invalid_claim');
        if (response.job === null) return { published, idle: true };
        claim = parseClaim(response.job);
        runtime.claimStore.save(claim);
        if (!same(runtime.claimStore.load(), claim)) fail('claim_integrity', 'The projection claim did not persist.');
      } else claim = parseClaim(claim);
      const lease = claim;
      function checkLease(): void {
        if (Date.parse(lease.leaseExpiresAt) <= (runtime.nowSeconds() + 15) * 1000) fail('lease_expired', 'The publication lease needs operator reconciliation.');
      }
      checkLease();
      const snapshot = parseProjectionSnapshot(send('/v1/jobs/project', claim));
      if (snapshot.event.eventId !== claim.eventId || snapshot.unit.unitId !== claim.unitId) fail('projection_scope', 'The snapshot does not match its leased resource.');
      publishProjectionSnapshot(snapshot, runtime, { maxRows: options.maxRows, beforeWrite: checkLease });
      checkLease();
      runtime.publishDecisionSlots?.(snapshot);
      checkLease();
      const ack = object(send('/v1/jobs/ack', claim), ['acknowledged'], 'invalid_ack');
      if (ack.acknowledged !== true) fail('invalid_ack', 'Publication acknowledgement is ambiguous.');
      runtime.claimStore.clear(claim);
      if (runtime.claimStore.load() !== undefined) fail('claim_integrity', 'The acknowledged claim could not be cleared.');
      published++;
    }
    return { published, idle: false };
  } finally { runtime.lock.releaseLock(); }
}
