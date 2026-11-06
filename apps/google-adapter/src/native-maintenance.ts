/** Owner-account native host. Planning is suppressed; no MailApp service is accepted or bound. */
import { AdapterError } from './index.js';
import { createGoogleSigner, createGoogleTransport, type ScriptLockPort, type UtilitiesPort } from './apps-script.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { MAINTENANCE_PROPERTIES, parseNativeMaintenanceConfig } from './maintenance-config.js';
import { callMaintenance, planNotificationWork, type MaintenanceApi } from './notification-runtime.js';
import { continueTransitionArchive, type TransitionArchiveClaim, type TransitionArchivePorts } from './transition-runtime.js';
import { buildCoherentFrontendModel } from './frontend-runtime.js';
import { REPORTING_POLICY_VERSION } from '../../../packages/domain/src/frontend-reporting.js';
interface NativeMaintenanceServices {
    PropertiesService: {
        getScriptProperties(): {
            getProperty(key: string): string | null;
            setProperty(key: string, value: string): unknown;
        };
    };
    Session: {
        getEffectiveUser(): {
            getEmail(): string;
        };
        getActiveUser?(): {
            getEmail(): string;
        };
    };
    ScriptApp: {
        getOAuthToken(): string;
    };
    Utilities: UtilitiesPort;
    LockService: {
        getScriptLock(): ScriptLockPort;
    };
    UrlFetchApp: {
        fetch(url: string, options: {
            method: 'get' | 'post' | 'patch';
            headers: Record<string, string>;
            contentType?: string;
            payload?: string;
            muteHttpExceptions: true;
            followRedirects: false;
            validateHttpsCertificates: true;
        }): {
            getResponseCode(): number;
            getContentText(): string;
        };
    };
}
type Scalar = string | number | boolean;
interface ArchiveTable {
    kind: string;
    title: string;
    sheetId: number;
    tableName: string;
    rows: Scalar[][];
    hash: string;
}
interface ArchiveState {
    version: 1;
    environment: 'staging';
    generation: number;
    archive?: NonNullable<ReturnType<TransitionArchivePorts['state']['load']>>;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const bytes = (value: string) => encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length;
const column = (index: number): string => { let n = index + 1, value = ''; while (n) {
    n--;
    value = String.fromCharCode(65 + n % 26) + value;
    n = Math.floor(n / 26);
} return value; };
const quoted = (name: string) => `'${name.replace(/'/g, "''")}'`;
/** Freeze values from D1, never from a possibly lagging live sheet. */
export function nativeArchiveTables(claim: TransitionArchiveClaim, sha: (value: string) => string): ArchiveTable[] {
    const token = sha(claim.transitionId).slice(0, 12), base = parseInt(token.slice(0, 7), 16) * 8;
    const asOfDate = claim.asOfDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate))
        fail('archive_date', 'The frozen archive date is missing.');
    const model = buildCoherentFrontendModel(claim.snapshot, asOfDate);
    const term = claim.snapshot.terms.find(t => t.isCurrent);
    if (!term)
        fail('archive_term', 'The source term is not explicit.');
    const matrix: {
        kind: string;
        rows: Scalar[][];
    }[] = model.tables.map(table => ({ kind: table.kind, rows: [table.columns.map(c => c.header), table.columns.map(c => c.label), ...table.rows.map(row => table.columns.map(c => {
                const value = row.values[c.header];
                return value === null || value === undefined ? '' : typeof value === 'object' ? value.fileUri : value;
            }))] }));
    const requests = claim.snapshot.requests.filter(r => claim.snapshot.events.some(e => e.eventId === r.eventId && e.termId === term.termId));
    matrix.push({ kind: 'excusals', rows: [['request_id', 'person_id', 'event_id', 'status', 'requested_outcome', 'reason', 'decision_reason', 'submitted_at', 'decided_at', 'version'],
            ['Request ID', 'Cadet ID', 'Event ID', 'Status', 'Requested outcome', 'Reason', 'Decision reason', 'Submitted', 'Decided', 'Version'],
            ...requests.map(r => [r.requestId, r.personId, r.eventId, r.status, r.requestedOutcome, r.reason, r.decisionReason ?? '', r.submittedAt, r.decidedAt ?? '', r.version])] });
    const serialized = JSON.stringify(claim.snapshot);
    if (sha(serialized) !== claim.snapshotHash || bytes(serialized) > 1500000)
        fail('archive_snapshot', 'The source snapshot is invalid or exceeds its reviewed bound.');
    const chunks: Scalar[][] = [];
    for (let offset = 0; offset < serialized.length; offset += 16000)
        chunks.push([chunks.length, serialized.slice(offset, offset + 16000)]);
    matrix.push({ kind: 'recovery', rows: [['sequence', 'content'], ['Part', 'Frozen recovery data'], [-1, JSON.stringify({ snapshotHash: claim.snapshotHash, planHash: claim.planHash, reportingPolicyVersion: REPORTING_POLICY_VERSION, asOfDate })], ...chunks] });
    return matrix.map((table, index) => {
        const rows = table.rows.length === 2 ? [...table.rows, table.rows[0].map(() => '')] : table.rows;
        return { kind: table.kind, title: `${term.label.slice(0, 48)} — ${table.kind} — ${token}`, sheetId: base + index,
            tableName: `Archive_${token}_${table.kind}`, rows, hash: sha(JSON.stringify(rows)) };
    });
}
export function createNativeMaintenanceRuntime(services: NativeMaintenanceServices, nowSeconds = () => Math.floor(Date.now() / 1000)) {
    const properties = services.PropertiesService.getScriptProperties();
    function google(url: string, method: 'get' | 'post' | 'patch' = 'get', body?: unknown, maximum = 2000000): Record<string, any> {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload && bytes(payload) > 1800000)
            fail('maintenance_capacity', 'A native maintenance write exceeds its bound.');
        let response: ReturnType<NativeMaintenanceServices['UrlFetchApp']['fetch']>;
        try {
            response = services.UrlFetchApp.fetch(url, { method, headers: { Authorization: `Bearer ${services.ScriptApp.getOAuthToken()}` }, ...(payload ? { contentType: 'application/json', payload } : {}), muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
        }
        catch {
            return fail('maintenance_google', 'A Google maintenance result is unknown; the saved operation is retained.');
        }
        const text = response.getContentText();
        if (response.getResponseCode() !== 200 || bytes(text) > maximum)
            fail('maintenance_google', `Google maintenance did not complete its bounded request (HTTP ${response.getResponseCode()}).`);
        try {
            const value = JSON.parse(text);
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw Error();
            return value;
        }
        catch {
            return fail('maintenance_google', 'Google maintenance returned invalid structured data.');
        }
    }
    const drive = (id: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
    const sheets = (id: string) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
    function inspect(id: string, owner: string): Record<string, any> {
        const metadata = google(`${drive(id)}?fields=id,name,mimeType,size,version,driveId,trashed,owners(emailAddress)`, 'get', undefined, 16000);
        if (!/^[1-9][0-9]*$/.test(String(metadata.version)) || metadata.id !== id || metadata.driveId || metadata.trashed || metadata.owners?.length !== 1 || String(metadata.owners[0].emailAddress).toLowerCase() !== owner)
            fail('maintenance_isolation', 'Maintenance resources must belong only to the intended automation account.');
        let pageToken = '', owners = 0;
        const seen = new Set<string>();
        do {
            const page = google(`${drive(id)}/permissions?pageSize=100&fields=nextPageToken,permissions(type,role,emailAddress,deleted)${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, 'get', undefined, 32000);
            if (!Array.isArray(page.permissions))
                fail('maintenance_isolation', 'Private sharing could not be fully inspected.');
            for (const p of page.permissions) {
                if (p.deleted || p.type !== 'user' || p.role !== 'owner' || String(p.emailAddress).toLowerCase() !== owner || ++owners > 1)
                    fail('maintenance_isolation', 'Archive and state sharing must be owner-only.');
            }
            pageToken = page.nextPageToken ?? '';
            if (typeof pageToken !== 'string' || pageToken.length > 2048 || seen.has(pageToken) || seen.size > 10)
                fail('maintenance_isolation', 'Private sharing pagination is incomplete.');
            if (pageToken)
                seen.add(pageToken);
        } while (pageToken);
        if (owners !== 1)
            fail('maintenance_isolation', 'The owner permission was not verified.');
        return metadata;
    }
    function configuration() {
        const rawHost = properties.getProperty(HOST_PROPERTIES.config), configId = properties.getProperty(CONFIG_FILE_ID_PROPERTY);
        if (!rawHost || !configId)
            return undefined;
        const host = parseStagingHostConfig(JSON.parse(rawHost));
        if (services.Session.getEffectiveUser().getEmail().trim().toLowerCase() !== host.expectedAutomationEmail)
            fail('maintenance_identity', 'Run under the intended staging automation account.');
        const file = inspect(configId, host.expectedAutomationEmail);
        if (file.mimeType !== 'application/json' || (!Number.isSafeInteger(Number(file.size)) || Number(file.size) < 1 || Number(file.size) > 65536))
            fail('maintenance_config', 'Use the reviewed private configuration file.');
        const map = google(`${drive(configId)}?alt=media`, 'get', undefined, 65536), raw = map[MAINTENANCE_PROPERTIES.config];
        if (raw === undefined)
            return undefined;
        if (typeof raw !== 'string' || bytes(raw) > 8000)
            fail('maintenance_config', 'Maintenance configuration is invalid or oversized.');
        const config = parseNativeMaintenanceConfig(JSON.parse(raw), host.generation);
        const denied = [configId, host.journal.spreadsheetId, host.decisionInput?.spreadsheetId];
        const frontend = map.SHAMROCK_V3_FRONTEND_CONFIG ? JSON.parse(map.SHAMROCK_V3_FRONTEND_CONFIG) : undefined;
        if (frontend)
            denied.push(frontend.stateFileId, frontend.main?.spreadsheetId, frontend.supplemental?.excusals?.spreadsheetId);
        if ([config.stateFileId, config.archiveSpreadsheetId].some(id => denied.includes(id)))
            fail('maintenance_isolation', 'Maintenance must use separate reviewed private storage.');
        const state = inspect(config.stateFileId, host.expectedAutomationEmail), archive = inspect(config.archiveSpreadsheetId, host.expectedAutomationEmail);
        if (state.mimeType !== 'application/json' || (!Number.isSafeInteger(Number(state.size)) || Number(state.size) < 1 || Number(state.size) > 2000000) || archive.mimeType !== 'application/vnd.google-apps.spreadsheet' || archive.name !== config.archiveExpectedTitle)
            fail('maintenance_isolation', 'State and archive metadata do not match the reviewed bindings.');
        const signer = createGoogleSigner(services.Utilities, properties.getProperty(HOST_PROPERTIES.secret) ?? '');
        const api: MaintenanceApi = { config: { environment: 'staging', generation: host.generation, baseUrl: host.workerOrigin, keyId: host.keyId }, principalId: config.principalId, workerId: config.workerId, signer, transport: createGoogleTransport(services.UrlFetchApp), nowSeconds };
        return { host, config, api };
    }
    function enabled() { return properties.getProperty(MAINTENANCE_PROPERTIES.paused) === 'false'; }
    function pause() { properties.setProperty(MAINTENANCE_PROPERTIES.paused, 'true'); if (enabled())
        fail('maintenance_pause', 'Maintenance pause was not saved.'); return { status: 'paused' }; }
    function resume() { const c = configuration(); if (!c?.config.enabled)
        fail('maintenance_config', 'Explicitly configure reviewed maintenance resources before enabling them.'); properties.setProperty(MAINTENANCE_PROPERTIES.paused, 'false'); if (!enabled())
        fail('maintenance_pause', 'Maintenance enablement was not saved.'); return { status: 'enabled', mail: 'suppressed' }; }
    function planNotifications() {
        if (!enabled())
            return { status: 'paused' };
        const c = configuration();
        if (!c?.config.enabled)
            return { status: 'disabled' };
        const lock = services.LockService.getScriptLock();
        if (!lock.tryLock(1000))
            return { status: 'busy' };
        try {
            return { status: 'suppressed', ...planNotificationWork(c.api, { kind: 'sheet', resourceKey: c.config.sourceResource }, true) };
        }
        finally {
            lock.releaseLock();
        }
    }
    function archive(transitionId: string) {
        if (!enabled())
            return { state: 'paused' };
        const candidate = configuration();
        if (!candidate?.config.enabled)
            return { state: 'disabled' };
        const c = candidate;
        let state: ArchiveState | undefined, version: string | undefined;
        const metadata = () => google(`${sheets(c.config.archiveSpreadsheetId)}?fields=spreadsheetId,sheets(properties,protectedRanges,tables)`);
        function readState() {
            const before = inspect(c.config.stateFileId, c.host.expectedAutomationEmail);
            const value = google(`${drive(c.config.stateFileId)}?alt=media`) as ArchiveState;
            const after = inspect(c.config.stateFileId, c.host.expectedAutomationEmail);
            if (String(before.version) !== String(after.version) || value.version !== 1 || value.environment !== 'staging' || value.generation !== c.host.generation)
                fail('maintenance_state', 'The private maintenance checkpoint changed or is invalid.');
            version = String(after.version);
            state = value;
            return state;
        }
        function saveState(value: ArchiveState) {
            const info = inspect(c.config.stateFileId, c.host.expectedAutomationEmail);
            if (!version || String(info.version) !== version || bytes(JSON.stringify(value)) > 2000000)
                fail('maintenance_state', 'The private maintenance checkpoint changed or exceeds its bound.');
            const result = google(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(c.config.stateFileId)}?uploadType=media&fields=id,version`, 'patch', value);
            if (result.id !== c.config.stateFileId || !/^[1-9][0-9]*$/.test(String(result.version)))
                fail('maintenance_state', 'Checkpoint persistence was not confirmed.');
            const reread = google(`${drive(c.config.stateFileId)}?alt=media`);
            if (c.api.signer.sha256(JSON.stringify(reread)) !== c.api.signer.sha256(JSON.stringify(value)))
                fail('maintenance_state', 'Checkpoint read-back differs.');
            version = String(result.version);
            state = clone(value);
        }
        function protect(sheet: any) {
            return Array.isArray(sheet.protectedRanges) && sheet.protectedRanges.some((p: any) => p.range?.sheetId === sheet.properties.sheetId
                && !Object.keys(p.range).some(k => k !== 'sheetId') && p.warningOnly !== true && !p.unprotectedRanges?.length
                && !p.editors?.domainUsersCanEdit && !(p.editors?.groups?.length) && (p.editors?.users ?? []).every((e: string) => e.toLowerCase() === c.host.expectedAutomationEmail));
        }
        function ensureTable(table: ArchiveTable) {
            const book = metadata(), present = book.sheets?.find((s: any) => s.properties.sheetId === table.sheetId);
            if (present) {
                if (present.properties.title !== table.title || !protect(present))
                    fail('archive_collision', 'The archive sheet identity/protection differs from the frozen binding.');
                return;
            }
            if (book.sheets?.some((s: any) => s.properties.title === table.title))
                fail('archive_collision', 'An archive title exists under a different identity.');
            const cols = table.rows[0].length;
            google(`${sheets(c.config.archiveSpreadsheetId)}:batchUpdate`, 'post', { requests: [
                    { addSheet: { properties: { sheetId: table.sheetId, title: table.title, hidden: table.kind === 'recovery', gridProperties: { rowCount: Math.max(3, table.rows.length), columnCount: cols, frozenRowCount: 2 } } } },
                    { addProtectedRange: { protectedRange: { range: { sheetId: table.sheetId }, description: `Immutable term archive ${table.hash}`, warningOnly: false, editors: { users: [c.host.expectedAutomationEmail], domainUsersCanEdit: false } } } },
                    { repeatCell: { range: { sheetId: table.sheetId }, cell: { userEnteredFormat: { textFormat: { fontFamily: 'Roboto', fontSize: 10 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat' } },
                    { updateDimensionProperties: { range: { sheetId: table.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
                    { updateDimensionProperties: { range: { sheetId: table.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols }, properties: { pixelSize: table.kind === 'attendance' ? 90 : 150 }, fields: 'pixelSize' } },
                    { repeatCell: { range: { sheetId: table.sheetId, startRowIndex: 1, endRowIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.043, green: 0.329, blue: 0.2 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontFamily: 'Roboto', fontSize: 10 } } }, fields: 'userEnteredFormat' } },
                ] });
        }
        const ports: TransitionArchivePorts = {
            api: c.api, lock: services.LockService.getScriptLock(), enabled: () => enabled() && c.config.enabled,
            assertPrivateState() { inspect(c.config.stateFileId, c.host.expectedAutomationEmail); inspect(c.config.archiveSpreadsheetId, c.host.expectedAutomationEmail); },
            state: { load: () => readState().archive, save(value) { saveState({ ...(state ?? readState()), archive: value }); }, clear() { const next = { ...(state ?? readState()) }; delete next.archive; saveState(next); } },
            archive: {
                write(claim, continuation) {
                    const tables = nativeArchiveTables(claim, c.api.signer.sha256);
                    let cursor = continuation ? JSON.parse(continuation) : { table: 0, row: 0 };
                    if (!Number.isSafeInteger(cursor.table) || !Number.isSafeInteger(cursor.row) || cursor.table < 0 || cursor.table >= tables.length || cursor.row < 0 || cursor.row >= tables[cursor.table].rows.length)
                        fail('archive_continuation', 'The saved archive cursor is invalid.');
                    const table = tables[cursor.table];
                    ensureTable(table);
                    const end = Math.min(table.rows.length, cursor.row + (table.kind === 'recovery' ? 10 : 50));
                    const rows = table.rows.slice(cursor.row, end).map(row => ({ values: row.map(value => ({ userEnteredValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } })) }));
                    google(`${sheets(c.config.archiveSpreadsheetId)}:batchUpdate`, 'post', { requests: [{ updateCells: { start: { sheetId: table.sheetId, rowIndex: cursor.row, columnIndex: 0 }, rows, fields: 'userEnteredValue' } }] });
                    if (end < table.rows.length)
                        return { done: false, continuation: JSON.stringify({ table: cursor.table, row: end }) };
                    const observed = metadata().sheets.find((s: any) => s.properties.sheetId === table.sheetId);
                    if (!observed.tables?.length)
                        google(`${sheets(c.config.archiveSpreadsheetId)}:batchUpdate`, 'post', { requests: [{ addTable: { table: { name: table.tableName, range: { sheetId: table.sheetId, startRowIndex: 1, endRowIndex: table.rows.length, startColumnIndex: 0, endColumnIndex: table.rows[0].length } } } }] });
                    if (cursor.table + 1 < tables.length)
                        return { done: false, continuation: JSON.stringify({ table: cursor.table + 1, row: 0 }) };
                    return { done: true };
                },
                verify() { return fail('archive_readback', 'Native archive verification requires its bounded continuation.'); },
                verifyStep(claim, continuation) {
                    const info = inspect(c.config.archiveSpreadsheetId, c.host.expectedAutomationEmail);
                    const tables = nativeArchiveTables(claim, c.api.signer.sha256), book = metadata();
                    const cursor = continuation ? JSON.parse(continuation) : { table: 0, row: 0, driveVersion: String(info.version) };
                    if (cursor.driveVersion !== String(info.version))
                        fail('archive_changed', 'The archive changed during read-back; review it before restarting verification.');
                    if (!Number.isSafeInteger(cursor.table) || !Number.isSafeInteger(cursor.row) || cursor.table < 0 || cursor.table >= tables.length || cursor.row < 0 || cursor.row >= tables[cursor.table].rows.length)
                        fail('archive_continuation', 'Archive verification cursor is invalid.');
                    for (const table of tables) {
                        const sheet = book.sheets?.find((s: any) => s.properties.sheetId === table.sheetId), native = sheet?.tables?.find((t: any) => t.name === table.tableName);
                        if (!sheet || sheet.properties.title !== table.title || !protect(sheet) || !native || native.range?.startRowIndex !== 1 || native.range?.endRowIndex !== table.rows.length || native.range?.endColumnIndex !== table.rows[0].length)
                            fail('archive_readback', 'Native archive Table/protection verification failed.');
                    }
                    const table = tables[cursor.table], end = Math.min(cursor.row + (table.kind === 'recovery' ? 10 : 50), table.rows.length);
                    const range = `${quoted(table.title)}!A${cursor.row + 1}:${column(table.rows[0].length - 1)}${end}`;
                    const read = google(`${sheets(c.config.archiveSpreadsheetId)}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(data(startRow,startColumn,rowData(values(userEnteredValue))))`);
                    const data = read.sheets?.[0]?.data?.[0];
                    if (!data || (data.startRow ?? 0) !== cursor.row || (data.startColumn ?? 0) !== 0)
                        fail('archive_readback', 'Archive grid read-back has an unexpected range.');
                    const actual = table.rows.slice(cursor.row, end).map((expected, r) => expected.map((_, col) => {
                        const value = data.rowData?.[r]?.values?.[col]?.userEnteredValue ?? {};
                        if (Object.hasOwn(value, 'formulaValue'))
                            fail('archive_readback', 'Archives require literal values; a formula was found.');
                        return value.stringValue ?? value.numberValue ?? value.boolValue ?? '';
                    }));
                    if (c.api.signer.sha256(JSON.stringify(actual)) !== c.api.signer.sha256(JSON.stringify(table.rows.slice(cursor.row, end))))
                        fail('archive_readback', 'The archive values do not match the frozen authoritative snapshot.');
                    const after = inspect(c.config.archiveSpreadsheetId, c.host.expectedAutomationEmail);
                    if (String(after.version) !== cursor.driveVersion)
                        fail('archive_changed', 'The archive changed during read-back.');
                    if (end < table.rows.length)
                        return { done: false, continuation: JSON.stringify({ ...cursor, row: end }) };
                    if (cursor.table + 1 < tables.length)
                        return { done: false, continuation: JSON.stringify({ ...cursor, table: cursor.table + 1, row: 0 }) };
                    return { done: true, proof: { snapshotHash: claim.snapshotHash, archiveBinding: 'term-archive-' + c.api.signer.sha256(claim.transitionId), protected: true, private: true, valuesOnly: true } };
                },
            },
        };
        return continueTransitionArchive(ports, transitionId);
    }
    function command(input: unknown) {
        const c = configuration();
        if (!enabled() || !c?.config.enabled)
            fail('maintenance_paused', 'Maintenance is paused.');
        if (services.Session.getActiveUser?.().getEmail().trim().toLowerCase() !== c.host.expectedAutomationEmail)
            fail('maintenance_actor', 'An identified automation-account operator must review this transition command.');
        if (!input || typeof input !== 'object' || Array.isArray(input))
            fail('maintenance_command', 'Supply the reviewed command identity, operation and payload.');
        const row = input as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== 'commandId,operation,payload')
            fail('maintenance_command', 'Unexpected transition command fields.');
        return callMaintenance(c.api, '/v1/admin/transitions/commands', { ...row, contractVersion: 1, environment: 'staging', generation: c.host.generation,
            actor: { principalId: c.config.principalId, evidence: 'authenticated-confirmation' }, source: { kind: 'sheet', resourceKey: c.config.sourceResource, submissionId: row.commandId, revision: 1 } });
    }
    return { pause, resume, planNotifications, archive, command };
}
