import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createNativeStagingRuntime, NATIVE_PROPERTIES as N } from '../../.build/v3/apps/google-adapter/src/native-runtime.js';
import { HOST_PROPERTIES as H } from '../../.build/v3/apps/google-adapter/src/staging-host.js';
import { createGoogleSigner } from '../../.build/v3/apps/google-adapter/src/apps-script.js';

const automation = 'automation@example.invalid';
const code = expected => error => error.code === expected;
const decisionHeaders = ['slot_id', 'request_id', 'base_version', 'draft_decision', 'draft_id', 'draft_state', 'draft_json'];
function fixture() {
  const config = {
    version: 1, environment: 'staging', resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',
    workerOrigin: 'https://worker.example.invalid', keyId: 'key.fixture', generation: 1, expectedAutomationEmail: automation,
    journal: { spreadsheetId: 'private-journal', sheetId: 1 },
    attendance: { formId: 'attendance-form', resourceKey: 'attendance-source', itemRoles: { event: '1', scope: '2', present: ['3'], completeness: '4' } },
    decisionInput: { spreadsheetId: 'review-book', sheetId: 2, resourceKey: 'review-source', slots: [{ row: 3, slotId: 'slot.one', requestId: 'request.one', baseVersion: 1 }] },
  };
  const projection = { version: 1, environment: 'staging', generation: 1, workerId: 'worker.fixture',
    attendance: { spreadsheetId: 'output-book', sheetId: 3 }, decisions: { spreadsheetId: 'output-book', sheetId: 4 }, cursors: { spreadsheetId: 'private-journal', sheetId: 5 } };
  const properties = new Map([[H.config, JSON.stringify(config)], [H.enabled, 'false'], [N.projectionConfig, JSON.stringify(projection)], [H.secret, 'fictional-signing-material-never-deploy']]);
  const state = { executor: automation, calls: [], writes: [], presentationWrites: [], flushes: 0, formOpens: 0, frozenNativeExtents: true, discardPresentation: false };
  const files = new Map();
  const books = new Map();
  const ownerPermission = { type: 'user', role: 'owner', emailAddress: automation };
  function addFile(id, mimeType) { const file = { id, mimeType, owners: [{ emailAddress: automation }], pages: [{ permissions: [{ ...ownerPermission }] }] }; files.set(id, file); return file; }
  function addSheet(bookId, id, title, values = []) {
    if (!books.has(bookId)) { books.set(bookId, []); addFile(bookId, 'application/vnd.google-apps.spreadsheet'); }
    const sheet = { id, title, values: structuredClone(values), formulas: new Map(), initialRows: values.length,
      properties: { sheetId: id, title, gridProperties: { rowCount: 30, columnCount: 20 } },
      tables: [], filterViews: [], conditionalFormats: [], developerMetadata: [], cells: new Map(), rowMetadata: [], columnMetadata: [],
      initialColumns: Math.max(0, ...values.map(r => r.length)), protections: [{ range: { sheetId: id }, warningOnly: false,
        editors: { users: [automation], groups: [], domainUsersCanEdit: false }, unprotectedRanges: [] }] };
    books.get(bookId).push(sheet); return sheet;
  }
  const journal = addSheet('private-journal', 1, 'Private Journal');
  const decision = addSheet('review-book', 2, 'Decision Input', [decisionHeaders, decisionHeaders, ['slot.one', 'request.one', 1, '', '', '', '']]);
  decision.protections[0].unprotectedRanges = [{ sheetId: 2, startRowIndex: 2, startColumnIndex: 3, endColumnIndex: 4 }];
  const attendance = addSheet('output-book', 3, "Attendance's View");
  const decisions = addSheet('output-book', 4, 'Recorded Decisions');
  const cursors = addSheet('private-journal', 5, 'Cursors');
  const form = addFile('attendance-form', 'application/vnd.google-apps.form');
  form.itemIds = [1, 2, 3, 4];
  const lock = { held: false, tryLock() { if (this.held) return false; this.held = true; return true; }, releaseLock() { this.held = false; } };
  const bytes = value => [...value].map(n => n > 127 ? n - 256 : n);
  function locate(bookId, a1) {
    const full = /^'((?:[^']|'')+)'$/.exec(a1);
    if (full) {
      const sheet = books.get(bookId).find(s => s.title === full[1].replace(/''/g, "'")); assert.ok(sheet);
      return { sheet, row: 0, column: 0, rows: sheet.values.length, columns: Math.max(0, ...sheet.values.map(r => r.length)) };
    }
    const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
    assert.ok(match, 'Exact quoted bounded A1 range');
    const sheet = books.get(bookId).find(s => s.title === match[1].replace(/''/g, "'"));
    assert.ok(sheet);
    const col = value => [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    return { sheet, row: Number(match[3]) - 1, column: col(match[2]) - 1, rows: Number(match[5]) - Number(match[3]) + 1, columns: col(match[4]) - col(match[2]) + 1 };
  }
  const services = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => 'draft.fixture',
      computeDigest: (_, value) => bytes(createHash('sha256').update(value).digest()),
      computeHmacSha256Signature: (value, secret) => bytes(createHmac('sha256', secret).update(value).digest()) },
    ScriptApp: { getOAuthToken: () => 'synthetic-not-a-real-token', getProjectTriggers: () => [], newTrigger() { throw Error('Unexpected trigger mutation'); }, deleteTrigger() { throw Error('Unexpected trigger mutation'); }, TriggerSource: {}, EventType: {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => state.executor }) },
    FormApp: { openById(id) { state.formOpens++; return { getId: () => id, getItems: () => files.get(id).itemIds.map(id => ({ getId: () => id })), getResponse() { throw Error('Unexpected response read'); } }; } },
    SpreadsheetApp: {
      openById(id) { if (!books.has(id)) throw Error('Unknown book'); return { getId: () => id, getSheets: () => books.get(id).map(sheet => ({ getSheetId: () => sheet.id, getName: () => sheet.title,
        getLastRow: () => state.frozenNativeExtents ? sheet.initialRows : sheet.values.length,
        getLastColumn: () => state.frozenNativeExtents ? sheet.initialColumns : Math.max(0, ...sheet.values.map(r => r.length)) })) }; },
      flush() { state.flushes++; },
    },
    LockService: { getScriptLock: () => lock }, nowSeconds: () => 1800000000,
    UrlFetchApp: { fetch(url, options) {
      assert.equal(options.followRedirects, false); assert.equal(options.validateHttpsCertificates, true);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-not-a-real-token');
      state.calls.push({ url, method: options.method });
      const u = new URL(url); let result;
      if (u.hostname === 'www.googleapis.com') {
        assert.equal(options.method, 'get');
        const [, id, suffix] = /^\/drive\/v3\/files\/([^/]+)(?:\/(permissions))?$/.exec(u.pathname);
        const file = files.get(decodeURIComponent(id)); assert.ok(file);
        result = suffix ? file.pages[Number(u.searchParams.get('pageToken') ?? 0)] : { id: file.id, mimeType: file.mimeType, owners: file.owners, ...(file.driveId ? { driveId: file.driveId } : {}) };
      } else {
        assert.equal(u.hostname, 'sheets.googleapis.com');
        const [, bookId, suffix = ''] = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
        assert.ok(books.has(bookId));
        if (suffix === '/values:batchUpdate') {
          assert.equal(options.method, 'post');
          const body = JSON.parse(options.payload); assert.equal(body.valueInputOption, 'RAW'); assert.equal(body.data.length, 1);
          state.writes.push(body); const d = body.data[0]; const range = locate(bookId, d.range);
          for (let r = 0; r < range.rows; r++) { range.sheet.values[range.row + r] ??= []; for (let c = 0; c < range.columns; c++) range.sheet.values[range.row + r][range.column + c] = d.values[r][c]; }
          result = { totalUpdatedCells: range.rows * range.columns };
        } else if (suffix === ':batchUpdate') {
          assert.equal(options.method, 'post');
          const body = JSON.parse(options.payload); state.presentationWrites.push(body);
          if (!state.discardPresentation) for (const request of body.requests) applyPresentationRequest(bookId, request);
          result = { replies: body.requests.map(() => ({})) };
        } else if (suffix.startsWith('/values/')) {
          assert.equal(u.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
          const range = locate(bookId, decodeURIComponent(suffix.slice('/values/'.length)));
          result = { values: Array.from({ length: range.rows }, (_, r) => Array.from({ length: range.columns }, (_, c) => range.sheet.values[range.row + r]?.[range.column + c] ?? '')) };
        } else if (u.searchParams.has('ranges')) {
          const selected = new Map();
          for (const a1 of u.searchParams.getAll('ranges')) {
            const range = locate(bookId, a1); const s = range.sheet;
            if (!selected.has(s.id)) selected.set(s.id, { properties: { sheetId: s.id }, data: [] });
            const block = { startRow: range.row, startColumn: range.column, rowData: Array.from({ length: range.rows }, (_, r) => ({ values: Array.from({ length: range.columns }, (_, c) => {
              const row = range.row + r; const column = range.column + c;
              const formula = s.formulas.get(`${row},${column}`); const value = s.values[row]?.[column];
              const entered = formula ? { formulaValue: formula } : value === undefined || value === '' ? undefined
                : typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value };
              return { ...structuredClone(s.cells.get(`${row},${column}`) ?? {}), ...(entered ? { userEnteredValue: entered } : {}) };
            }) })), rowMetadata: Array.from({ length: range.rows }, (_, r) => s.rowMetadata[range.row + r] ?? {}),
            columnMetadata: Array.from({ length: range.columns }, (_, c) => s.columnMetadata[range.column + c] ?? {}) };
            selected.get(s.id).data.push(block);
          }
          result = { spreadsheetId: bookId, sheets: [...selected.values()] };
        } else result = { spreadsheetId: bookId, sheets: books.get(bookId).map(s => ({ properties: s.properties, protectedRanges: s.protections,
          tables: s.tables, filterViews: s.filterViews, conditionalFormats: s.conditionalFormats, developerMetadata: s.developerMetadata, merges: [] })) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(result) };
    } },
  };
  function applyFields(target, value, fields) {
    for (const path of fields.split(',')) {
      const keys = path.trim().split('.'); let to = target; let from = value;
      for (const key of keys.slice(0, -1)) { to[key] ??= {}; to = to[key]; from = from?.[key]; }
      const last = keys.at(-1); if (from?.[last] === undefined) delete to[last]; else to[last] = structuredClone(from[last]);
    }
  }
  function applyPresentationRequest(bookId, request) {
    const sheets = books.get(bookId); const find = id => { const s = sheets.find(s => s.id === id); assert.ok(s); return s; };
    if (request.addTable) { const value = structuredClone(request.addTable.table); value.tableId ??= `google-generated-${value.range.sheetId}`; find(value.range.sheetId).tables.push(value); }
    else if (request.createDeveloperMetadata) { const value = structuredClone(request.createDeveloperMetadata.developerMetadata); value.metadataId = 100 + value.location.sheetId; find(value.location.sheetId).developerMetadata.push(value); }
    else if (request.updateTable) {
      const { table, fields } = request.updateTable; const target = sheets.flatMap(s => s.tables).find(t => t.tableId === table.tableId); assert.ok(target); applyFields(target, table, fields);
    } else if (request.updateSheetProperties) { const { properties, fields } = request.updateSheetProperties; applyFields(find(properties.sheetId).properties, properties, fields); }
    else if (request.updateDimensionProperties) {
      const { range, properties, fields } = request.updateDimensionProperties; const s = find(range.sheetId);
      const dimensions = range.dimension === 'ROWS' ? s.rowMetadata : s.columnMetadata;
      for (let i = range.startIndex ?? 0; i < range.endIndex; i++) { dimensions[i] ??= {}; applyFields(dimensions[i], properties, fields); }
    } else if (request.repeatCell || request.setDataValidation) {
      const { range } = request.repeatCell ?? request.setDataValidation; const s = find(range.sheetId);
      for (let r = range.startRowIndex ?? 0; r < range.endRowIndex; r++) for (let c = range.startColumnIndex ?? 0; c < range.endColumnIndex; c++) {
        const key = `${r},${c}`; const cell = s.cells.get(key) ?? {};
        if (request.repeatCell) applyFields(cell, request.repeatCell.cell, request.repeatCell.fields);
        else if (request.setDataValidation.rule) cell.dataValidation = structuredClone(request.setDataValidation.rule); else delete cell.dataValidation;
        s.cells.set(key, cell);
      }
    } else if (request.addFilterView) { const view = structuredClone(request.addFilterView.filter); find(view.range.sheetId).filterViews.push(view); }
    else if (request.updateFilterView) {
      const { filter, fields } = request.updateFilterView; const target = sheets.flatMap(s => s.filterViews).find(v => v.filterViewId === filter.filterViewId); assert.ok(target); applyFields(target, filter, fields);
    } else if (request.addConditionalFormatRule) { const { rule, index } = request.addConditionalFormatRule; find(rule.ranges[0].sheetId).conditionalFormats.splice(index, 0, structuredClone(rule)); }
    else if (request.deleteConditionalFormatRule) { const { sheetId, index } = request.deleteConditionalFormatRule; find(sheetId).conditionalFormats.splice(index, 1); }
    else if (request.updateCells) {
      const { start, range, rows, fields } = request.updateCells; const s = find(start?.sheetId ?? range.sheetId); const firstRow = start?.rowIndex ?? range.startRowIndex ?? 0; const firstCol = start?.columnIndex ?? range.startColumnIndex ?? 0;
      rows.forEach((row, r) => row.values.forEach((cell, c) => {
        if (fields.includes('userEnteredValue')) { s.values[firstRow + r] ??= []; const value = cell.userEnteredValue ?? {}; s.values[firstRow + r][firstCol + c] = value.stringValue ?? value.numberValue ?? value.boolValue ?? ''; }
        const key = `${firstRow + r},${firstCol + c}`; const target = s.cells.get(key) ?? {}; applyFields(target, cell, fields); s.cells.set(key, target);
      }));
    } else assert.fail(`Unimplemented presentation request ${Object.keys(request).join(',')}`);
  }
  const runtime = createNativeStagingRuntime(services);
  return { config, projection, properties, state, services, runtime, files, books, addSheet, form, journal, decision, attendance, decisions, cursors, lock,
    saveConfig() { properties.set(H.config, JSON.stringify(config)); }, saveProjection() { properties.set(N.projectionConfig, JSON.stringify(projection)); } };
}

function presentationFixture() {
  const f = fixture();
  f.books.get('review-book').splice(0, 1); f.books.get('output-book').push(f.decision);
  f.config.decisionInput.spreadsheetId = 'output-book'; delete f.config.decisionInput.slots;
  Object.assign(f.config.decisionInput, { mode: 'projection', maxSlots: 20 }); f.saveConfig();
  f.decision.values = []; f.decision.protections[0].unprotectedRanges[0].endRowIndex = 22;
  const legend = f.addSheet('output-book', 6, "Data Legend's Choices"); legend.properties.hidden = true;
  const presentation = { version: 1, environment: 'staging', generation: 1, legend: { spreadsheetId: 'output-book', sheetId: 6 } };
  f.properties.set(N.presentationConfig, JSON.stringify(presentation));
  f.runtime.initializeProjections();
  return { ...f, legend, presentation };
}

test('native presentation repair is optional and requires paused, private, protected and initialized bindings before writing', () => {
  const absent = fixture(); assert.deepEqual(absent.runtime.repairPresentation(), { status: 'presentation-not-configured' });
  assert.equal(absent.state.writes.length, 0); assert.equal(absent.state.presentationWrites.length, 0);
  for (const [change, expected] of [
    [f => f.properties.set(H.enabled, 'true'), 'pause_required'],
    [f => f.properties.set(N.projectionClaim, JSON.stringify({ fingerprint: 'unreviewed', claim: {} })), 'claim_integrity'],
    [f => f.properties.delete(N.projectionReceipt), 'projection_setup_required'],
    [f => { f.legend.properties.hidden = false; }, 'presentation_legend'],
    [f => { f.legend.protections[0].warningOnly = true; }, 'protection_unverified'],
    [f => { f.attendance.values[0][0] = 'changed_header'; }, 'presentation_headers'],
    [f => { f.files.get('private-journal').pages[0].permissions.push({ type: 'anyone', role: 'reader' }); }, 'private_resource_required'],
  ]) {
    const f = presentationFixture(); const before = structuredClone(f.decision.values); change(f);
    assert.throws(() => f.runtime.repairPresentation(), code(expected)); assert.equal(f.state.presentationWrites.length, 0);
    assert.deepEqual(f.decision.values, before); assert.equal(f.properties.has(N.presentationReceipt), false); assert.equal(f.lock.held, false);
  }
});

test('native presentation repairs real tables with fresh format and validation read-back while preserving rows and unrelated views', () => {
  const f = presentationFixture();
  const foreignView = { filterViewId: 14, title: 'Operator saved view', range: { sheetId: 3, startRowIndex: 1, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 10 } };
  f.attendance.filterViews.push(structuredClone(foreignView));
  const before = [f.attendance, f.decisions, f.decision, f.journal, f.cursors].map(s => structuredClone(s.values));
  const result = f.runtime.repairPresentation(); assert.equal(result.status, 'presentation-ready-paused'); assert.ok(result.requests > 0);
  assert.equal(f.properties.get(H.enabled), 'false'); assert.ok(f.properties.get(N.presentationReceipt));
  assert.deepEqual([f.attendance, f.decisions, f.decision, f.journal, f.cursors].map(s => s.values), before);
  assert.equal(f.legend.values.length, 6); assert.equal(f.legend.values[2][0], 'Approved');
  assert.equal(f.attendance.tables.length, 1); assert.equal(f.decisions.tables.length, 1); assert.equal(f.decision.tables.length, 1);
  assert.deepEqual(f.attendance.filterViews.find(v => v.filterViewId === 14), foreignView);
  const draftColumn = f.decision.values[0].indexOf('draft_decision');
  assert.equal(f.decision.cells.get(`21,${draftColumn}`).dataValidation.strict, true);
  assert.equal(f.decision.cells.get(`21,${draftColumn}`).dataValidation.condition.type, 'ONE_OF_RANGE');
  const allBefore = structuredClone(f.decision.values); f.runtime.repairPresentation();
  assert.deepEqual(f.decision.values, allBefore); assert.equal(f.decision.tables.length, 1); assert.equal(f.attendance.filterViews.length, 3);
});

test('an unconfirmed native presentation write cannot save its setup receipt and can be repaired again', () => {
  const f = presentationFixture(); f.state.discardPresentation = true;
  assert.throws(() => f.runtime.repairPresentation(), code('presentation_unverified'));
  assert.equal(f.properties.has(N.presentationReceipt), false); assert.equal(f.lock.held, false);
  f.state.discardPresentation = false; assert.equal(f.runtime.repairPresentation().status, 'presentation-ready-paused');
  assert.equal(f.attendance.tables.length, 1); assert.ok(f.properties.get(N.presentationReceipt));
  const fetch = f.services.UrlFetchApp.fetch;
  f.services.UrlFetchApp.fetch = (url, options) => options.method === 'post' && url.endsWith(':batchUpdate')
    ? { getResponseCode: () => 503, getContentText() { throw Error('Provider error body must not be read'); } } : fetch(url, options);
  assert.throws(() => f.runtime.repairPresentation(), code('google_write_failed'));
  assert.equal(f.properties.has(N.presentationReceipt), false, 'A previously valid receipt is removed before any repair write');
  assert.equal(f.properties.get(H.enabled), 'false'); assert.equal(f.lock.held, false);
});

test('projection presentation grows before ACK, retains failed claims and never restyles every publication', () => {
  const f = presentationFixture(); f.runtime.repairPresentation();
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.presentation', claimToken: 'claim.presentation', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 7, event: { eventId: 'event.one', label: 'Synthetic event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [1, 2].map(n => ({ personId: `person.${n}`, displayName: `Synthetic cadet ${n}`, observedCode: 'P', requests: [{ requestId: `request.${n}`, status: 'Submitted', requestedOutcome: 'E', version: 1 }] })) };
  const calls = []; const context = { config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    const route = new URL(request.url).pathname; calls.push(route);
    if (route.endsWith('/ack')) { assert.equal(f.attendance.tables[0].range.endRowIndex, 4); assert.equal(f.decision.tables[0].range.endRowIndex, 4); }
    return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } };
  const start = f.state.presentationWrites.length; f.state.discardPresentation = true;
  assert.throws(() => f.runtime.consumeProjection(context), code('presentation_unverified'));
  assert.equal(calls.some(route => route.endsWith('/ack')), false); assert.ok(f.properties.get(N.projectionClaim));
  const original = structuredClone(f.decision.values); f.state.discardPresentation = false;
  assert.deepEqual(f.runtime.consumeProjection(context), { published: 1, idle: false });
  assert.deepEqual(f.decision.values, original); assert.equal(calls.filter(route => route.endsWith('/claim')).length, 1);
  assert.equal(f.properties.has(N.projectionClaim), false);
  const changes = f.state.presentationWrites.slice(start).flatMap(batch => batch.requests);
  assert.ok(changes.length > 0); assert.ok(changes.every(request => (request.updateTable ?? request.updateFilterView)?.fields === 'range'));
  const end = f.state.presentationWrites.length; f.runtime.consumeProjection(context); assert.equal(f.state.presentationWrites.length, end);
});

test('projection acknowledges provider-normalized table headers and RAW body cells using effective format read-back', () => {
  const f = presentationFixture(); f.runtime.repairPresentation();
  for (const sheet of [f.attendance, f.decisions, f.decision]) for (const [key, cell] of sheet.cells) {
    const row = Number(key.split(',')[0]);
    if (row === 1) {
      cell.effectiveFormat = structuredClone(cell.userEnteredFormat);
      delete cell.userEnteredFormat.backgroundColorStyle;
      delete cell.userEnteredFormat.textFormat.foregroundColorStyle;
    } else if (row >= 2 && cell.userEnteredFormat?.numberFormat?.type === 'TEXT') delete cell.userEnteredFormat.numberFormat;
  }
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.normalized', claimToken: 'claim.normalized', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 7, event: { eventId: 'event.one', label: 'Synthetic event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [{ personId: 'person.one', displayName: 'Synthetic cadet', observedCode: 'P', requests: [] }] };
  let acknowledged = false;
  const context = { config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    const route = new URL(request.url).pathname;
    if (route.endsWith('/ack')) acknowledged = true;
    return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } };
  assert.deepEqual(f.runtime.consumeProjection(context), { published: 1, idle: false });
  assert.equal(acknowledged, true); assert.equal(f.properties.has(N.projectionClaim), false);
  const gridReads = f.state.calls.filter(call => new URL(call.url).searchParams.get('fields')?.includes('userEnteredFormat'));
  assert.ok(gridReads.length > 0); assert.ok(gridReads.every(call => new URL(call.url).searchParams.get('fields').includes('effectiveFormat')));
});

test('native paused setup upgrades legacy 14-column slots without changing frozen drafts or existing target identities', () => {
  const f = presentationFixture(); const headers = f.decision.values[0].slice(0, 14); const labels = f.decision.values[1].slice(0, 14);
  const slotId = `slot.${createHash('sha256').update(JSON.stringify(['decision-slot-v1', 'staging', 1, f.config.decisionInput.resourceKey, 3, 'request.one', 2])).digest('hex')}`;
  const row = [slotId, 'request.one', 2, 'Denied', 'draft.frozen', 'Committed: Denied', '{"frozen":"payload"}',
    'event.one', 'unit.one', 'person.one', 'Synthetic event', 'Synthetic cadet', 'E', 'Submitted'];
  f.decision.values = [headers, labels, structuredClone(row)]; const start = f.state.writes.length;
  f.runtime.initializeProjections();
  assert.deepEqual(f.decision.values[2].slice(0, 14), row); assert.equal(f.decision.values[2][14], 3); assert.match(f.decision.values[2][15], /^[a-f0-9]{64}$/);
  const writes = f.state.writes.slice(start); assert.equal(writes.length, 1); assert.match(writes[0].data[0].range, /!O1:P3$/);
  assert.equal(f.properties.get(H.enabled), 'false'); assert.equal(f.runtime.repairPresentation().status, 'presentation-ready-paused');
});

test('native paused setup appends event and unit labels to legacy recorded output without rewriting its original cells', () => {
  const f = fixture(); f.runtime.initializeProjections();
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.labels', claimToken: 'claim.labels', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 4, event: { eventId: 'event.one', label: 'Synthetic event' }, unit: { unitId: 'unit.one', label: 'Synthetic unit' }, rows: [{ personId: 'person.one', displayName: 'Synthetic cadet', observedCode: 'P', requests: [{ requestId: 'request.one', status: 'Submitted', requestedOutcome: 'E', version: 1 }] }] };
  f.runtime.consumeProjection({ config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    const route = new URL(request.url).pathname; return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } });
  f.decisions.values = f.decisions.values.map(row => row.slice(0, 11)); const original = structuredClone(f.decisions.values); const start = f.state.writes.length;
  f.runtime.initializeProjections();
  assert.deepEqual(f.decisions.values.map(row => row.slice(0, 11)), original); assert.deepEqual(f.decisions.values[2].slice(11), ['Synthetic event', 'Synthetic unit']);
  assert.equal(f.state.writes.length - start, 1); assert.match(f.state.writes.at(-1).data[0].range, /!L1:M3$/);
  assert.equal(f.properties.has(N.projectionClaim), false); assert.equal(f.properties.get(H.enabled), 'false');
});

test('schema contract and optional presentation configuration changes invalidate setup without replacing old claims', () => {
  const f = presentationFixture(); const current = f.runtime.configurationFingerprint();
  const oldFingerprint = createHash('sha256').update(`${f.properties.get(H.config)}\n${f.properties.get(N.projectionConfig)}`).digest('hex');
  const oldClaim = JSON.stringify({ fingerprint: oldFingerprint, claim: { jobId: 'old-contract-claim' } });
  f.properties.set(N.projectionClaim, oldClaim); const before = f.state.writes.length;
  assert.throws(() => f.runtime.initializeProjections(), code('claim_integrity'));
  assert.equal(f.properties.get(N.projectionClaim), oldClaim); assert.equal(f.state.writes.length, before);
  f.presentation.legend.sheetId = 7; f.properties.set(N.presentationConfig, JSON.stringify(f.presentation));
  assert.notEqual(f.runtime.configurationFingerprint(), current);
  const expectedOldHost = createHash('sha256').update(f.properties.get(N.projectionConfig)).digest('hex');
  f.properties.delete(N.presentationConfig); assert.notEqual(f.runtime.configurationFingerprint(), expectedOldHost);
});

test('setup rechecks pause after acquiring the shared lock before schema or value writes', () => {
  const f = fixture(); const acquire = f.lock.tryLock.bind(f.lock);
  f.lock.tryLock = () => { const locked = acquire(); f.properties.set(H.enabled, 'true'); return locked; };
  assert.throws(() => f.runtime.initializeProjections(), code('pause_required'));
  assert.equal(f.state.writes.length, 0); assert.equal(f.lock.held, false);
});

test('presentation repair and growth use bounded Google calls and metadata-only publication writes', t => {
  const f = presentationFixture();
  const counts = start => {
    const calls = f.state.calls.slice(start).filter(call => call.url.startsWith('https://sheets.googleapis.com/'));
    return { get: calls.filter(call => call.method === 'get').length, post: calls.filter(call => call.method === 'post').length };
  };
  let start = f.state.calls.length; f.runtime.repairPresentation(); const first = counts(start);
  start = f.state.calls.length; f.runtime.repairPresentation(); const repeated = counts(start);
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.bounded', claimToken: 'claim.bounded', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 1, event: { eventId: 'event.one', label: 'Synthetic event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [1, 2].map(n => ({ personId: `person.${n}`, displayName: `Synthetic cadet ${n}`, observedCode: 'P', requests: [{ requestId: `request.${n}`, status: 'Submitted', requestedOutcome: 'E', version: 1 }] })) };
  start = f.state.calls.length;
  f.runtime.consumeProjection({ config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    const route = new URL(request.url).pathname; return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } });
  const growth = counts(start); t.diagnostic(`Fictional Sheets call counts: ${JSON.stringify({ first, repeated, growth })}`);
  assert.ok(first.get <= 20 && first.post <= 4); assert.ok(repeated.get <= 15 && repeated.post <= 3); assert.ok(growth.get <= 32 && growth.post <= 7);
});

test('formatting read-back checks fresh literal headers despite cached operational value reads', () => {
  const f = presentationFixture(); f.runtime.repairPresentation(); const fetch = f.services.UrlFetchApp.fetch;
  f.services.UrlFetchApp.fetch = (url, options) => {
    const response = fetch(url, options);
    if (options.method === 'post' && url.endsWith(':batchUpdate')) f.attendance.values[0][0] = 'unexpected_header';
    return response;
  };
  assert.throws(() => f.runtime.repairPresentation(), code('presentation_headers'));
  assert.equal(f.properties.has(N.presentationReceipt), false); assert.equal(f.lock.held, false);
});

test('native construction performs no resource IO and rejects production or wrong executor before IO', () => {
  const f = fixture(); assert.equal(f.state.calls.length, 0);
  f.config.environment = 'production'; f.saveConfig();
  assert.throws(() => f.runtime.assertJournalPrivate(f.config.journal), code('staging_configuration_required'));
  f.config.environment = 'staging'; f.saveConfig(); f.state.executor = 'other@example.invalid';
  assert.throws(() => f.runtime.assertJournalPrivate(f.config.journal), code('wrong_automation_identity'));
  assert.equal(f.state.calls.length, 0);
});

test('private journal ACL check follows all pages and rejects ordinary readers, groups and public sharing', () => {
  for (const permission of [{ type: 'user', role: 'reader', emailAddress: 'reader@example.invalid' }, { type: 'group', role: 'writer', emailAddress: 'group@example.invalid' }, { type: 'anyone', role: 'reader' }]) {
    const f = fixture(); const file = f.files.get('private-journal');
    file.pages[0].nextPageToken = '1'; file.pages.push({ permissions: [permission] });
    assert.throws(() => f.runtime.assertJournalPrivate(f.config.journal), code('private_resource_required'));
    assert.ok(f.state.calls.some(c => c.url.includes('pageToken=1')));
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture(); f.runtime.assertJournalPrivate(f.config.journal);
  f.files.get('private-journal').pages[0].nextPageToken = '0';
  assert.throws(() => f.runtime.assertJournalPrivate(f.config.journal), code('private_resource_required'));
});

test('source Form allows read-only respondents but rejects untrusted editors and changed native item IDs', () => {
  const f = fixture(); f.form.pages[0].permissions.push({ type: 'anyone', role: 'reader' });
  assert.equal(f.runtime.formApp.openById('attendance-form').getId(), 'attendance-form');
  f.form.pages[0].nextPageToken = '1'; f.form.pages.push({ permissions: [{ type: 'user', role: 'writer', emailAddress: 'editor@example.invalid' }] });
  assert.throws(() => f.runtime.formApp.openById('attendance-form'), code('private_resource_required'));
  assert.equal(f.state.formOpens, 1, 'Untrusted source rejected before native access');
  f.form.pages.length = 1; delete f.form.pages[0].nextPageToken; f.form.itemIds = [1, 2, 3, 99];
  assert.throws(() => f.runtime.formApp.openById('attendance-form'), code('form_binding_changed'));
});

test('projection initialization requires strict whole-sheet protections and matching paused generation', () => {
  const changes = [p => { p.warningOnly = true; }, p => { p.editors.domainUsersCanEdit = true; }, p => { p.editors.groups = ['group@example.invalid']; }, p => { p.editors.users.push('other@example.invalid'); }, p => { p.range.endRowIndex = 20; }, p => { p.unprotectedRanges = [{ sheetId: 3 }]; }];
  for (const change of changes) {
    const f = fixture(); change(f.attendance.protections[0]);
    assert.throws(() => f.runtime.initializeProjections(), code('protection_unverified'));
    assert.equal(f.state.writes.length, 0); assert.equal(f.lock.held, false);
  }
  const f = fixture(); f.properties.set(H.enabled, 'true');
  assert.throws(() => f.runtime.initializeProjections(), code('pause_required'));
  f.properties.set(H.enabled, 'false'); f.projection.generation = 2; f.saveProjection();
  assert.throws(() => f.runtime.initializeProjections(), code('native_configuration'));
  assert.equal(f.state.writes.length, 0);
});

test('only a distinct protected cursor tab may share the owner-private journal workbook', () => {
  const f = fixture();
  f.runtime.initializeProjections();
  assert.equal(f.journal.values.length, 0); assert.equal(f.cursors.values.length, 2);
  f.projection.cursors = { ...f.config.journal }; f.saveProjection();
  assert.throws(() => f.runtime.initializeProjections(), code('native_configuration'));
  const g = fixture(); g.projection.attendance = { spreadsheetId: 'private-journal', sheetId: 99 }; g.saveProjection();
  assert.throws(() => g.runtime.initializeProjections(), code('native_configuration'));
});

test('RAW host ranges preserve literals and authoritative extents across reopenings and interleaved executions', () => {
  const f = fixture();
  const first = f.runtime.spreadsheetApp.openById('private-journal').getSheets()[0];
  first.getRange(1, 1, 1, 2).setValues([['=literal', "'literal"]]);
  const reopened = f.runtime.spreadsheetApp.openById('private-journal').getSheets()[0];
  assert.equal(reopened.getLastRow(), 1); assert.equal(reopened.getLastColumn(), 2);
  reopened.getRange(reopened.getLastRow() + 1, 1, 1, 2).setValues([['next', 'row']]);
  assert.deepEqual(first.getRange(1, 1, 2, 2).getValues(), [['=literal', "'literal"], ['next', 'row']]);
  assert.deepEqual(first.getRange(1, 1, 1, 2).getFormulas(), [['', '']]);
  assert.equal(f.journal.values.length, 2);
  // Another cooperating execution appends after this invocation releases its lock.
  f.journal.values.push(['intervening', 'execution']);
  assert.equal(reopened.getLastRow(), 3);
  reopened.getRange(reopened.getLastRow() + 1, 1, 1, 2).setValues([['after', 'interleaving']]);
  assert.deepEqual(f.journal.values[2], ['intervening', 'execution']);
  assert.deepEqual(f.journal.values[3], ['after', 'interleaving']);
  const shared = f.runtime.lockService.getScriptLock();
  assert.equal(shared.tryLock(100), true);
  assert.equal(first.getLastRow(), 4);
  const readsBefore = f.state.calls.length;
  assert.equal(first.getLastRow(), 4); assert.equal(first.getLastColumn(), 2);
  assert.equal(f.state.calls.length, readsBefore, 'Extent reads share only this lock section');
  shared.releaseLock(); f.journal.values.push(['another', 'invocation']);
  assert.equal(shared.tryLock(100), true);
  assert.equal(first.getLastRow(), 5, 'New lock acquisition invalidates old extents');
  shared.releaseLock();
});

test('decision protection permits only draft column cells below both header rows', () => {
  const f = fixture(); const protectedHeaders = decisionHeaders.filter(h => h !== 'draft_decision');
  f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders);
  f.decision.protections[0].unprotectedRanges[0].startRowIndex = 1;
  assert.throws(() => f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders), code('protection_unverified'));
  f.decision.protections[0].unprotectedRanges[0].startRowIndex = 2;
  f.decision.protections[0].unprotectedRanges[0].startColumnIndex = 2;
  assert.throws(() => f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders), code('protection_unverified'));
});

test('native publication retains ambiguous ACK claims durably and recovers without a new claim', () => {
  const f = fixture(); assert.deepEqual(f.runtime.initializeProjections(), { status: 'projection-ready-paused' });
  assert.equal(f.state.writes.length, 3); assert.ok(f.properties.get(N.projectionReceipt));
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.one', claimToken: 'claim.one', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 7, event: { eventId: 'event.one', label: '=literal event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [{ personId: 'person.one', displayName: "'literal name", observedCode: 'P', requests: [{ requestId: 'request.one', status: 'Approved', requestedOutcome: 'E', version: 2 }] }] };
  const calls = []; let ackWorks = false;
  const context = { config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000,
    transport: { send(request) { assert.equal(f.lock.held, true); const route = new URL(request.url).pathname; calls.push(route);
      const body = route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true };
      return { status: route.endsWith('/ack') && !ackWorks ? 503 : 200, body: JSON.stringify(body) };
    } } };
  const beforePublication = f.state.calls.length;
  assert.throws(() => f.runtime.consumeProjection(context), code('projection_delivery'));
  const publicationCalls = f.state.calls.slice(beforePublication);
  const sheetReads = publicationCalls.filter(c => new URL(c.url).hostname === 'sheets.googleapis.com' && c.method === 'get').length;
  assert.ok(sheetReads <= 20, `One projection consumed ${sheetReads} Sheets reads`);
  assert.equal(publicationCalls.filter(c => c.method === 'post').length, 3);
  assert.deepEqual(JSON.parse(f.properties.get(N.projectionClaim)).claim, claim);
  assert.equal(f.lock.held, false);
  assert.equal(f.attendance.values[2][3], '=literal event'); assert.equal(f.attendance.values[2][5], "'literal name");
  assert.throws(() => f.runtime.initializeProjections(), code('claim_integrity'));
  // A new invocation reloads durable Script Properties and fresh native extents.
  f.state.frozenNativeExtents = false; const resumed = createNativeStagingRuntime(f.services); ackWorks = true;
  assert.deepEqual(resumed.consumeProjection(context), { published: 1, idle: false });
  assert.equal(calls.filter(route => route.endsWith('/claim')).length, 1);
  assert.equal(f.properties.has(N.projectionClaim), false); assert.equal(f.lock.held, false);
  const before = resumed.configurationFingerprint(); f.projection.workerId = 'worker.changed'; f.saveProjection();
  assert.notEqual(resumed.configurationFingerprint(), before);
  assert.throws(() => resumed.consumeProjection(context), code('projection_setup_required'));
});

test('native dynamic slots require the entire bounded input area and initialize only a reviewed empty tab', () => {
  const f = fixture(); delete f.config.decisionInput.slots; Object.assign(f.config.decisionInput, { mode: 'projection', maxSlots: 4 }); f.saveConfig(); f.decision.values = [];
  assert.throws(() => f.runtime.initializeProjections(), code('protection_unverified'));
  f.decision.protections[0].unprotectedRanges[0].endRowIndex = 6;
  f.runtime.initializeProjections(); assert.equal(f.decision.values.length, 2); assert.equal(f.decision.values[0].length, 16);
  const protectedHeaders = f.decision.values[0].filter(h => h !== 'draft_decision');
  f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders);
  f.decision.protections[0].unprotectedRanges[0].endRowIndex = 5;
  assert.throws(() => f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders), code('protection_unverified'));
  f.decision.protections[0].unprotectedRanges[0].endRowIndex = 7;
  assert.throws(() => f.runtime.assertDecisionProtection(f.config.decisionInput, protectedHeaders), code('protection_unverified'));
});

test('native projection creates immutable dynamic slots before ACK and appends later versions without draft writes', () => {
  const f = fixture(); delete f.config.decisionInput.slots; Object.assign(f.config.decisionInput, { mode: 'projection', maxSlots: 4 }); f.saveConfig(); f.decision.values = [];
  f.decision.protections[0].unprotectedRanges[0].endRowIndex = 6; f.runtime.initializeProjections();
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.one', claimToken: 'claim.one', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 7, event: { eventId: 'event.one', label: '=literal event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [{ personId: 'person.one', displayName: '=literal name', observedCode: 'P', requests: [{ requestId: 'request.one', status: 'Submitted', requestedOutcome: 'E', version: 1 }] }] };
  const context = { config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    assert.equal(f.lock.held, true); const route = new URL(request.url).pathname;
    if (route.endsWith('/ack')) { assert.equal(f.decision.values.at(-1)[2], snapshot.rows[0].requests[0].version); assert.equal(f.decision.values.at(-1)[11], '=literal name'); }
    return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } };
  const start = f.state.writes.length; f.runtime.consumeProjection(context); assert.equal(f.decision.values.length, 3);
  const inputWrites = f.state.writes.slice(start).filter(write => write.data[0].range.includes('Decision Input'));
  assert.equal(inputWrites.length, 2); assert.ok(inputWrites.every(write => !write.data[0].range.includes('!D')));
  f.decision.values[2][3] = 'Denied'; f.decision.values[2][4] = 'draft.saved'; f.decision.values[2][6] = 'saved frozen payload';
  const original = structuredClone(f.decision.values[2]); snapshot.revision++; snapshot.rows[0].requests[0].version = 2; snapshot.rows[0].requests[0].status = 'Approved'; claim.jobId = 'job.two';
  f.runtime.consumeProjection(context); assert.equal(f.decision.values.length, 4); assert.deepEqual(f.decision.values[2], original); assert.equal(f.decision.values[3][2], 2);
  assert.equal(f.properties.has(N.projectionClaim), false);
});

test('native HTTP failures retain safe service, operation and status diagnostics without reading Google error bodies', () => {
  for (const [status, category] of [[429, 'rate-limited'], [401, 'authorization'], [403, 'forbidden'], [404, 'not-found'], [400, 'invalid-request'], [503, 'server-error'], [504, 'timeout'], [302, 'other']]) {
    const f = fixture(); const sheet = f.runtime.spreadsheetApp.openById('review-book').getSheets()[0]; let calls = 0;
    f.services.UrlFetchApp.fetch = () => { calls++; return { getResponseCode: () => status, getContentText() { throw Error('Raw provider error body must never be read or exposed'); } }; };
    assert.throws(() => sheet.getRange(1, 1, 1, 1).getValues(), error => {
      assert.equal(error.code, 'google_read_failed'); assert.equal(error.message, `Google Sheets read failed (HTTP ${status}; ${category}). Saved work was retained.`); return true;
    });
    assert.equal(calls, 1, 'Diagnostics do not add an automatic retry');
  }
  const f = fixture(); const sheet = f.runtime.spreadsheetApp.openById('review-book').getSheets()[0];
  f.services.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503, getContentText() { throw Error('Must not expose provider payload'); } });
  assert.throws(() => sheet.getRange(3, 6, 1, 1).setValues([['Synthetic status']]), error => error.code === 'google_write_failed' && error.message === 'Google Sheets write failed (HTTP 503; server-error). Saved work was retained.');
  assert.throws(() => f.runtime.assertJournalPrivate(f.config.journal), error => error.code === 'google_read_failed' && error.message === 'Google Drive read failed (HTTP 503; server-error). Saved work was retained.');
});

test('a Google 429 retains the durable projection claim without ACK or payload changes and later resumes it', () => {
  const f = fixture(); f.runtime.initializeProjections(); const originalJournal = structuredClone(f.journal.values);
  const signer = createGoogleSigner(f.services.Utilities, 'fictional-signing-material-never-deploy');
  const claim = { jobId: 'job.rate-limit', claimToken: 'claim.fixture', leaseExpiresAt: new Date((1800000000 + 300) * 1000).toISOString(), eventId: 'event.one', unitId: 'unit.one', kind: 'attendance.projection' };
  const snapshot = { revision: 7, event: { eventId: 'event.one', label: 'Synthetic event' }, unit: { unitId: 'unit.one', label: 'Unit' }, rows: [{ personId: 'person.one', displayName: 'Synthetic cadet', observedCode: 'P', requests: [{ requestId: 'request.one', status: 'Denied', requestedOutcome: 'E', version: 2 }] }] };
  const calls = []; const context = { config: { baseUrl: f.config.workerOrigin, keyId: f.config.keyId, environment: 'staging', generation: 1 }, signer, nowSeconds: () => 1800000000, transport: { send(request) {
    const route = new URL(request.url).pathname; calls.push(route);
    return { status: 200, body: JSON.stringify(route.endsWith('/claim') ? { job: claim } : route.endsWith('/project') ? snapshot : { acknowledged: true }) };
  } } };
  const fetch = f.services.UrlFetchApp.fetch; let throttled = true;
  f.services.UrlFetchApp.fetch = (url, options) => throttled && url.startsWith('https://sheets.googleapis.com/') && options.method === 'get'
    ? { getResponseCode: () => 429, getContentText() { throw Error('Private response details must not be read'); } } : fetch(url, options);
  assert.throws(() => f.runtime.consumeProjection(context), error => error.code === 'google_read_failed' && /HTTP 429; rate-limited/.test(error.message));
  assert.deepEqual(JSON.parse(f.properties.get(N.projectionClaim)).claim, claim); assert.equal(calls.some(route => route.endsWith('/ack')), false); assert.equal(f.lock.held, false); assert.deepEqual(f.journal.values, originalJournal);
  throttled = false; assert.deepEqual(f.runtime.consumeProjection(context), { published: 1, idle: false });
  assert.equal(calls.filter(route => route.endsWith('/claim')).length, 1); assert.equal(calls.filter(route => route.endsWith('/ack')).length, 1); assert.equal(f.properties.has(N.projectionClaim), false); assert.deepEqual(f.journal.values, originalJournal);
});
