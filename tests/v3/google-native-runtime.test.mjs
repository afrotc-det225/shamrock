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
  const properties = new Map([[H.config, JSON.stringify(config)], [H.enabled, 'false'], [N.projectionConfig, JSON.stringify(projection)]]);
  const state = { executor: automation, calls: [], writes: [], flushes: 0, formOpens: 0, frozenNativeExtents: true };
  const files = new Map();
  const books = new Map();
  const ownerPermission = { type: 'user', role: 'owner', emailAddress: automation };
  function addFile(id, mimeType) { const file = { id, mimeType, owners: [{ emailAddress: automation }], pages: [{ permissions: [{ ...ownerPermission }] }] }; files.set(id, file); return file; }
  function addSheet(bookId, id, title, values = []) {
    if (!books.has(bookId)) { books.set(bookId, []); addFile(bookId, 'application/vnd.google-apps.spreadsheet'); }
    const sheet = { id, title, values: structuredClone(values), formulas: new Map(), initialRows: values.length,
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
        const [, bookId, suffix = ''] = /^\/v4\/spreadsheets\/([^/]+)(.*)$/.exec(u.pathname);
        assert.ok(books.has(bookId));
        if (suffix === '/values:batchUpdate') {
          assert.equal(options.method, 'post');
          const body = JSON.parse(options.payload); assert.equal(body.valueInputOption, 'RAW'); assert.equal(body.data.length, 1);
          state.writes.push(body); const d = body.data[0]; const range = locate(bookId, d.range);
          for (let r = 0; r < range.rows; r++) { range.sheet.values[range.row + r] ??= []; for (let c = 0; c < range.columns; c++) range.sheet.values[range.row + r][range.column + c] = d.values[r][c]; }
          result = { totalUpdatedCells: range.rows * range.columns };
        } else if (suffix.startsWith('/values/')) {
          assert.equal(u.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
          const range = locate(bookId, decodeURIComponent(suffix.slice('/values/'.length)));
          result = { values: Array.from({ length: range.rows }, (_, r) => Array.from({ length: range.columns }, (_, c) => range.sheet.values[range.row + r]?.[range.column + c] ?? '')) };
        } else if (u.searchParams.has('ranges')) {
          const range = locate(bookId, u.searchParams.get('ranges'));
          result = { sheets: [{ properties: { sheetId: range.sheet.id }, data: [{ rowData: Array.from({ length: range.rows }, (_, r) => ({ values: Array.from({ length: range.columns }, (_, c) => {
            const formula = range.sheet.formulas.get(`${range.row + r},${range.column + c}`); return formula ? { userEnteredValue: { formulaValue: formula } } : {};
          }) })) }] }] };
        } else result = { spreadsheetId: bookId, sheets: books.get(bookId).map(s => ({ properties: { sheetId: s.id }, protectedRanges: s.protections })) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(result) };
    } },
  };
  const runtime = createNativeStagingRuntime(services);
  return { config, projection, properties, state, services, runtime, files, form, journal, decision, attendance, decisions, cursors, lock,
    saveConfig() { properties.set(H.config, JSON.stringify(config)); }, saveProjection() { properties.set(N.projectionConfig, JSON.stringify(projection)); } };
}

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
  f.runtime.initializeProjections(); assert.equal(f.decision.values.length, 2); assert.equal(f.decision.values[0].length, 14);
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
