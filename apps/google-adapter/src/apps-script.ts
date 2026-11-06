/**
 * Apps Script-compatible host ports. Bundled as an IIFE by build:v3.
 * This file registers no triggers, opens no resources and reads no secrets.
 * A future isolated host explicitly supplies the Google services and bindings.
 */
import {
  AdapterError, dispatchPending, enqueueCommand,
  type AdapterConfig, type Journal, type JournalEntry, type JournalStatus,
  type SignedRequest, type Signer, type Transport,
} from './index.js';
export * from './index.js';

export interface UtilitiesPort {
  DigestAlgorithm: { SHA_256: unknown };
  Charset: { UTF_8: unknown };
  computeDigest(algorithm: unknown, value: string, charset: unknown): number[];
  computeHmacSha256Signature(value: string, key: string, charset: unknown): number[];
}

export function createGoogleSigner(utilities: UtilitiesPort, secret: string): Signer {
  if (typeof secret !== 'string' || secret.length < 32) throw new AdapterError('missing_signing_key', 'A scoped signing key is required.');
  const hex = (bytes: number[]) => bytes.map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
  return {
    sha256: text => hex(utilities.computeDigest(utilities.DigestAlgorithm.SHA_256, text, utilities.Charset.UTF_8)),
    hmacSha256: text => hex(utilities.computeHmacSha256Signature(text, secret, utilities.Charset.UTF_8)),
  };
}

export interface UrlFetchPort {
  fetch(url: string, options: {
    method: 'post'; contentType: string; headers: Record<string, string>; payload: string;
    muteHttpExceptions: true; followRedirects: false; validateHttpsCertificates: true;
  }): { getResponseCode(): number; getContentText(): string };
}

export function createGoogleTransport(urlFetch: UrlFetchPort): Transport {
  return {
    send(request: SignedRequest) {
      const response = urlFetch.fetch(request.url, {
        method: 'post', contentType: 'application/json', headers: request.headers,
        payload: request.body, muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true,
      });
      return { status: response.getResponseCode(), body: response.getContentText() };
    },
  };
}

export interface SheetRangePort {
  getValues(): unknown[][];
  setValues(values: unknown[][]): unknown;
}
export interface SheetPort {
  getLastRow(): number;
  getLastColumn(): number;
  getRange(row: number, column: number, rows: number, columns: number): SheetRangePort;
}
export interface ScriptLockPort {
  tryLock(milliseconds: number): boolean;
  releaseLock(): void;
}

const HEADERS = ['command_id', 'payload_json', 'payload_hash', 'status', 'attempts', 'next_attempt_at', 'last_error'] as const;
const STATUSES: JournalStatus[] = ['pending', 'committed', 'conflict', 'rejected', 'needs-attention'];

interface JournalLimits { maxEntries: number; maxTotalCharacters: number; maxPayloadCharacters: number }
const DEFAULT_LIMITS: JournalLimits = { maxEntries: 1000, maxTotalCharacters: 1_000_000, maxPayloadCharacters: 45_000 };

function journalError(message: string): never { throw new AdapterError('journal_integrity', message); }

/** Must exist only inside withJournalLock; participating adapter executions serialize throughout dispatch. */
function sheetJournal(sheet: SheetPort, limits: JournalLimits): Journal {
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, HEADERS.length).setValues([[...HEADERS]]);
  if (sheet.getLastColumn() !== HEADERS.length) journalError('The journal schema needs repair.');
  const headers = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (headers.length !== HEADERS.length || new Set(headers).size !== HEADERS.length || HEADERS.some(h => !headers.includes(h))) {
    journalError('The journal headers are invalid.');
  }
  const columns = Object.fromEntries(HEADERS.map(h => [h, headers.indexOf(h)])) as Record<typeof HEADERS[number], number>;
  function read(): { row: number; entry: JournalEntry }[] {
    const count = sheet.getLastRow() - 1;
    if (count > limits.maxEntries) journalError('The journal exceeds its configured capacity.');
    if (count === 0) return [];
    const ids = new Set<string>();
    return sheet.getRange(2, 1, count, HEADERS.length).getValues().map((values, index) => {
      const get = (key: typeof HEADERS[number]) => values[columns[key]];
      const commandId = get('command_id');
      const body = get('payload_json');
      const bodyHash = get('payload_hash');
      const status = get('status');
      const attempts = get('attempts');
      const nextAttemptAt = get('next_attempt_at');
      const lastError = get('last_error');
      if (typeof commandId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(commandId) || ids.has(commandId)
        || typeof body !== 'string' || body.length > limits.maxPayloadCharacters
        || typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyHash)
        || typeof status !== 'string' || !STATUSES.includes(status as JournalStatus)
        || typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0
        || typeof nextAttemptAt !== 'number' || !Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0
        || typeof lastError !== 'string') journalError('A saved journal row is invalid.');
      ids.add(commandId);
      return { row: index + 2, entry: { commandId, body, bodyHash, status: status as JournalStatus, attempts, nextAttemptAt, lastError } };
    });
  }
  function write(row: number, entry: JournalEntry) {
    const record: Record<typeof HEADERS[number], unknown> = {
      command_id: entry.commandId, payload_json: entry.body, payload_hash: entry.bodyHash,
      status: entry.status, attempts: entry.attempts, next_attempt_at: entry.nextAttemptAt, last_error: entry.lastError,
    };
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([headers.map(h => record[h as typeof HEADERS[number]])]);
  }
  return {
    insert(entry) {
      const rows = read();
      const existing = rows.find(row => row.entry.commandId === entry.commandId);
      if (existing) return existing.entry;
      if (rows.length >= limits.maxEntries || entry.body.length > limits.maxPayloadCharacters
        || rows.reduce((sum, row) => sum + row.entry.body.length, entry.body.length) > limits.maxTotalCharacters) {
        throw new AdapterError('journal_full', 'Pending input was not discarded. The journal needs operator attention.');
      }
      write(rows.length + 2, entry);
      return { ...entry };
    },
    due(nowSeconds, limit) {
      return read().map(row => row.entry).filter(entry => entry.status === 'pending' && entry.nextAttemptAt <= nowSeconds).slice(0, limit);
    },
    find(commandIds) {
      if (commandIds.length > 1000) journalError('The journal lookup exceeds its configured bound.');
      const wanted = new Set(commandIds);
      return read().map(row => row.entry).filter(entry => wanted.has(entry.commandId));
    },
    update(entry, expected) {
      const found = read().find(row => row.entry.commandId === entry.commandId);
      if (!found || found.entry.status !== expected.status || found.entry.attempts !== expected.attempts
        || found.entry.body !== entry.body || found.entry.bodyHash !== entry.bodyHash) {
        journalError('Journal state changed during dispatch; inspect before retrying.');
      }
      write(found.row, entry);
    },
  };
}

export function withJournalLock<T>(
  sheet: SheetPort, lock: ScriptLockPort, operation: (journal: Journal) => T,
  overrides: Partial<JournalLimits> = {},
): T {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new AdapterError('invalid_capacity', 'Journal capacity must use positive integer bounds.');
  }
  if (!lock.tryLock(100)) throw new AdapterError('adapter_busy', 'The adapter is already processing saved input.');
  try { return operation(sheetJournal(sheet, limits)); }
  finally { lock.releaseLock(); }
}

export function enqueueGoogleCommand(input: unknown, sheet: SheetPort, lock: ScriptLockPort, signer: Signer): JournalEntry {
  return withJournalLock(sheet, lock, journal => enqueueCommand(input, journal, signer));
}

export function flushGoogleCommands(
  sheet: SheetPort, lock: ScriptLockPort, urlFetch: UrlFetchPort,
  config: AdapterConfig, signer: Signer, nowSeconds: number,
): { committed: number; pending: number; attention: number } {
  return withJournalLock(sheet, lock, journal => dispatchPending(journal, createGoogleTransport(urlFetch), config, signer, nowSeconds, { limit: 5 }));
}

export interface NativeFormResponse {
  getId(): string | null;
  getRespondentEmail(): string;
  getItemResponses(): { getItem(): { getId(): number }; getResponse(): unknown }[];
}

/** Read only native response identity/email, never an answer labelled Email or Session effective user. */
export function snapshotGoogleForm(
  source: { getId(): string }, response: NativeFormResponse,
  verifiedEmailConfiguration: boolean, revision = 1,
): import('./index.js').FormSnapshot {
  const responseId = response.getId();
  if (!responseId) throw new AdapterError('missing_response_identity', 'A submitted native Form response is required.');
  const answers: Record<string, string | string[]> = {};
  for (const item of response.getItemResponses()) {
    const id = String(item.getItem().getId());
    if (Object.prototype.hasOwnProperty.call(answers, id)) throw new AdapterError('duplicate_item', 'The response contains duplicate item identities.');
    const answer = item.getResponse();
    if (typeof answer === 'string') answers[id] = answer;
    else if (Array.isArray(answer) && answer.every(value => typeof value === 'string')) answers[id] = [...answer];
    else throw new AdapterError('unsupported_item', 'This response contains an unsupported item type.');
  }
  return {
    nativeFormId: source.getId(), responseId, revision,
    responderEmail: response.getRespondentEmail(), verifiedResponder: verifiedEmailConfiguration, answers,
  };
}

/** e.user may be omitted; absence means confirmation, never substitute the trigger creator. */
export function googleEditActorEmail(event: { user?: { getEmail(): string } }): string | undefined {
  try { return event.user?.getEmail().trim().toLowerCase() || undefined; }
  catch { return undefined; }
}
