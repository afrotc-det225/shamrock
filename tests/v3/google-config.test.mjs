import test from 'node:test';
import assert from 'node:assert/strict';
import { importStagingConfiguration, CONFIG_FILE_ID_PROPERTY } from '../../.build/v3/apps/google-adapter/src/staging-config.js';
import { HOST_PROPERTIES as H } from '../../.build/v3/apps/google-adapter/src/staging-host.js';
import { NATIVE_PROPERTIES as N } from '../../.build/v3/apps/google-adapter/src/native-runtime.js';

const automation = 'automation@example.invalid';
const M = {config: 'SHAMROCK_V3_MAINTENANCE_CONFIG', paused: 'SHAMROCK_V3_MAINTENANCE_PAUSED'};
const F = { config: 'SHAMROCK_V3_FRONTEND_CONFIG', paused: 'SHAMROCK_V3_FRONTEND_PAUSED' };
const code = expected => error => error.code === expected;
function fixture() {
  const host = {
    version: 1, environment: 'staging', resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',
    workerOrigin: 'https://worker.example.invalid', keyId: 'key.fixture', generation: 1, expectedAutomationEmail: automation,
    journal: { spreadsheetId: 'private-book', sheetId: 1 },
    attendance: { formId: 'attendance-form', resourceKey: 'attendance-source', itemRoles: { event: '1', scope: '2', present: ['3'], completeness: '4' } },
    excusal: { formId: 'excusal-form', resourceKey: 'excusal-source', itemRoles: { event: '5', outcome: '6', reason: '7' } },
    decisionInput: { spreadsheetId: 'operator-book', sheetId: 5, resourceKey: 'decisions-source', slots: [{ row: 3, slotId: 'slot.one', requestId: 'request.one', baseVersion: 1 }] },
  };
  const projection = { version: 1, environment: 'staging', generation: 1, workerId: 'worker.fixture',
    attendance: { spreadsheetId: 'operator-book', sheetId: 3 }, decisions: { spreadsheetId: 'operator-book', sheetId: 4 }, cursors: { spreadsheetId: 'private-book', sheetId: 2 } };
  const principal = { entries: [{ email: 'cadet@example.invalid', principalId: 'principal.one', personId: 'person.one' }] };
  const catalog = { references: { 'event.one': { kind: 'event', eventId: 'event.one' }, 'scope.one': { kind: 'scope', unitId: 'unit.one', rosterVersion: 1, coveredPersonIds: ['person.one'] } } };
  const map = { [H.config]: JSON.stringify(host), [H.principals]: JSON.stringify(principal), [H.attendanceCatalog]: JSON.stringify(catalog),
    [H.excusalCatalog]: JSON.stringify({ references: { 'event.one': { kind: 'event', eventId: 'event.one' } } }), [N.projectionConfig]: JSON.stringify(projection) };
  const properties = new Map([
    [CONFIG_FILE_ID_PROPERTY, 'private-config-file'], [H.secret, 'fixture-secret-untouched-never-read'], [H.enabled, 'true'],
    [H.config, 'previous-host'], [H.principals, 'previous-principals'], [H.attendanceCatalog, 'previous-attendance'], [H.excusalCatalog, 'previous-excusal'],
    [N.projectionConfig, 'previous-projection'], [H.setupReceipt, 'previous-host-receipt'], [N.projectionReceipt, 'previous-projection-receipt'],
    [N.projectionClaim, 'pending-claim-preserve'], [N.presentationConfig, 'previous-presentation'],
    [N.presentationReceipt, 'previous-presentation-receipt'], ['UNRELATED_SETTING', 'preserve'],
  ]);
  const metadata = { id: 'private-config-file', mimeType: 'application/json', owners: [{ emailAddress: automation }], trashed: false };
  const pages = [{ permissions: [{ type: 'user', role: 'owner', emailAddress: automation }] }];
  const state = { executor: automation, token: 'synthetic-oauth', calls: [], mutations: [], secretReads: 0, sourceOverride: null,
    declaredSize: null, failUrl: '', status: 200, failBatch: false, discardWrites: false, discardPause: false };
  const services = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) { if (key === H.secret) state.secretReads++; return properties.get(key) ?? null; },
      setProperty(key, value) { state.mutations.push(['set', key]); if (!state.discardPause) properties.set(key, value); },
      deleteProperty(key) { state.mutations.push(['delete', key]); properties.delete(key); },
      setProperties(values, deleteAllOthers) { state.mutations.push(['batch', Object.keys(values)]); assert.equal(deleteAllOthers, false); if (state.failBatch) throw Error('Sensitive provider body omitted'); if (!state.discardWrites) Object.entries(values).forEach(([key, value]) => properties.set(key, value)); },
    }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => state.executor }) },
    ScriptApp: { getOAuthToken: () => state.token },
    UrlFetchApp: { fetch(url, options) {
      assert.equal(properties.get(H.enabled), 'false', 'Pause precedes any remote read');
      assert.equal(options.method, 'get'); assert.equal(options.followRedirects, false); assert.equal(options.validateHttpsCertificates, true); assert.equal(options.muteHttpExceptions, true);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-oauth');
      state.calls.push(url);
      if (state.failUrl && url.includes(state.failUrl)) throw Error('Sensitive provider error omitted');
      const parsed = new URL(url); let body;
      const source = state.sourceOverride ?? JSON.stringify(map);
      if (parsed.pathname.endsWith('/permissions')) {
        const index = parsed.searchParams.get('pageToken') ? Number(parsed.searchParams.get('pageToken').replace('page-', '')) : 0;
        body = JSON.stringify(pages[index]);
      } else if (parsed.searchParams.get('alt') === 'media') body = source;
      else body = JSON.stringify({ ...metadata, size: state.declaredSize ?? String(Buffer.byteLength(source)) });
      return { getResponseCode: () => state.status, getContentText: () => body };
    } },
  };
  return { host, projection, principal, catalog, map, properties, metadata, pages, state, services,
    updateHost() { map[H.config] = JSON.stringify(host); }, updateProjection() { map[N.projectionConfig] = JSON.stringify(projection); },
    run() { return importStagingConfiguration(services); },
  };
}
function assertOnlyPaused(f, expected) {
  const before = new Map(f.properties);
  assert.throws(() => f.run(), expected);
  before.set(H.enabled, 'false'); before.set(F.paused, 'true'); before.set(M.paused, 'true'); before.set('SHAMROCK_V3_INPUT_PAUSED','true'); before.set('SHAMROCK_V3_FORMS_PAUSED','true'); before.set('SHAMROCK_V3_FORM_INTAKE_PAUSED','true'); assert.deepEqual(f.properties, before);
  assert.deepEqual(f.state.mutations, [['set', H.enabled], ['set', F.paused], ['set', M.paused], ['set','SHAMROCK_V3_INPUT_PAUSED'], ['set','SHAMROCK_V3_FORMS_PAUSED'], ['set','SHAMROCK_V3_FORM_INTAKE_PAUSED']]);
  assert.equal(f.state.secretReads, 0);
}

test('private owner-only configuration imports nonsecret bindings while paused and forces setup', () => {
  const f = fixture();
  assert.deepEqual(f.run(), { status: 'imported-paused', propertyCount: 5, next: 'setup-required' });
  for (const [key, value] of Object.entries(f.map)) assert.equal(f.properties.get(key), value);
  assert.equal(f.properties.get(H.enabled), 'false'); assert.equal(f.properties.has(H.setupReceipt), false); assert.equal(f.properties.has(N.projectionReceipt), false);
  assert.equal(f.properties.get(F.paused), 'true');
  assert.equal(f.properties.has(N.presentationConfig), false); assert.equal(f.properties.has(N.presentationReceipt), false);
  assert.equal(f.properties.get(H.secret), 'fixture-secret-untouched-never-read'); assert.equal(f.state.secretReads, 0);
  assert.equal(f.properties.get(N.projectionClaim), 'pending-claim-preserve'); assert.equal(f.properties.get('UNRELATED_SETTING'), 'preserve');
  assert.equal(f.state.calls.length, 3); assert.equal(f.state.mutations.filter(m => m[0] === 'batch').length, 1);
});

test('optional frontend bindings stay in the private file and imports pause both planes without touching claims or secrets', () => {
  const f = fixture();
  f.map[F.config] = JSON.stringify({ version: 1, environment: 'staging', generation: 1, enabled: true,
    resourceReview: 'EXISTING_FICTIONAL_FRONTEND_REVIEWED_FOR_STAGING', workerId: 'frontend-worker', principalId: 'reader', stateFileId: 'frontend-state',
    main: { spreadsheetId: 'frontend-main', expectedTitle: 'SHAMROCK — Staging', sheets: {} }, allowedFileEditors: [],
    access: { ownerEmail: automation, automationEmail: automation }, seeds: [] });
  f.properties.set(F.config, 'stale-property-override'); f.properties.set('SHAMROCK_V3_FRONTEND_CLAIM', 'retained-frontend-claim');
  assert.equal(f.run().propertyCount, 5);
  assert.equal(f.properties.has(F.config), false); assert.equal(f.properties.get(F.paused), 'true');
  assert.equal(f.properties.get('SHAMROCK_V3_FRONTEND_CLAIM'), 'retained-frontend-claim'); assert.equal(f.state.secretReads, 0);
  const bad = fixture(); bad.map[F.config] = f.map[F.config].replace('"generation":1', '"generation":2');
  assertOnlyPaused(bad, code('configuration_invalid'));
});

test('optional excusal catalog is removed only after a valid import without that source', () => {
  const f = fixture(); delete f.host.excusal; f.updateHost(); delete f.map[H.excusalCatalog];
  assert.equal(f.run().propertyCount, 4); assert.equal(f.properties.has(H.excusalCatalog), false); assert.equal(f.properties.get(H.secret), 'fixture-secret-untouched-never-read');
});

test('owner-only permission pagination must finish before downloading content', () => {
  const f = fixture(); f.pages.unshift({ permissions: [], nextPageToken: 'page-1' });
  f.run(); assert.equal(f.state.calls.length, 4); assert.match(f.state.calls[2], /pageToken=page-1/); assert.match(f.state.calls[3], /alt=media/);
  const g = fixture(); g.pages[0].nextPageToken = 'page-1'; g.pages.push({ permissions: [{ type: 'user', role: 'reader', emailAddress: 'other@example.invalid' }] });
  assertOnlyPaused(g, code('configuration_private_required')); assert.ok(g.state.calls.every(url => !url.includes('alt=media')));
});

test('shared, non-owned, non-JSON, trashed and Shared Drive files never replace properties', () => {
  for (const change of [
    f => { f.metadata.owners = [{ emailAddress: 'other@example.invalid' }]; },
    f => { f.metadata.owners.push({ emailAddress: automation }); },
    f => { f.metadata.driveId = 'shared-drive'; },
    f => { f.metadata.mimeType = 'text/plain'; },
    f => { f.metadata.trashed = true; },
    f => { f.metadata.id = 'different-file'; },
  ]) { const f = fixture(); change(f); assertOnlyPaused(f, code('configuration_owner_required')); }
  for (const permission of [
    { type: 'anyone', role: 'reader' }, { type: 'domain', role: 'reader' }, { type: 'group', role: 'writer' },
    { type: 'user', role: 'reader', emailAddress: automation }, { type: 'user', role: 'writer', emailAddress: 'other@example.invalid' },
  ]) { const f = fixture(); f.pages[0].permissions.push(permission); assertOnlyPaused(f, code('configuration_private_required')); }
});

test('missing owner proof and repeated permission page tokens fail closed', () => {
  const f = fixture(); f.pages[0].permissions = []; assertOnlyPaused(f, code('configuration_private_required'));
  const g = fixture(); g.pages[0].nextPageToken = 'page-1'; g.pages.push({ permissions: [], nextPageToken: 'page-1' }); assertOnlyPaused(g, code('configuration_private_required'));
  const h = fixture(); delete h.pages[0].permissions; assertOnlyPaused(h, code('configuration_private_required'));
});

test('secret, enabled, receipt, bootstrap and unknown property names are forbidden in the file', () => {
  for (const key of [H.secret, H.enabled, H.setupReceipt, N.projectionReceipt, N.projectionClaim, N.presentationReceipt, CONFIG_FILE_ID_PROPERTY, 'UNEXPECTED']) {
    const f = fixture(); f.map[key] = JSON.stringify({ fixture: true }); assertOnlyPaused(f, code('configuration_keys'));
  }
  const f = fixture(); delete f.map[N.projectionConfig]; assertOnlyPaused(f, code('configuration_keys'));
  const g = fixture(); delete g.map[H.excusalCatalog]; assertOnlyPaused(g, code('configuration_keys'));
});

test('optional presentation binds a distinct legend only within the reviewed staging operator workbook', () => {
  const configure = f => {
    delete f.host.decisionInput.slots; Object.assign(f.host.decisionInput, { mode: 'projection', maxSlots: 20 }); f.updateHost();
    const value = { version: 1, environment: 'staging', generation: 1, legend: { spreadsheetId: 'operator-book', sheetId: 6 } };
    f.map[N.presentationConfig] = JSON.stringify(value); return value;
  };
  const valid = fixture(); configure(valid); assert.equal(valid.run().propertyCount, 6);
  assert.equal(valid.properties.get(N.presentationConfig), valid.map[N.presentationConfig]);
  assert.equal(valid.properties.has(N.presentationReceipt), false);
  assert.equal(valid.properties.get(N.projectionClaim), 'pending-claim-preserve');
  for (const change of [
    value => { value.environment = 'production'; }, value => { value.generation = 2; },
    value => { value.legend.spreadsheetId = 'other-book'; }, value => { value.legend.sheetId = 3; },
    value => { value.legend.sheetId = 4; }, value => { value.legend.sheetId = 5; },
    value => { value.legend.unexpected = true; }, value => { value.extra = true; },
  ]) {
    const f = fixture(); const value = configure(f); change(value); f.map[N.presentationConfig] = JSON.stringify(value);
    assertOnlyPaused(f, code('native_configuration'));
  }
  const fixed = fixture(); fixed.map[N.presentationConfig] = JSON.stringify({ version: 1, environment: 'staging', generation: 1, legend: { spreadsheetId: 'operator-book', sheetId: 6 } });
  assertOnlyPaused(fixed, code('native_configuration'));
});

test('configuration must be explicit staging and its expected executor must match the actual account', () => {
  const f = fixture(); f.host.environment = 'production'; f.updateHost(); assertOnlyPaused(f, code('staging_configuration_required'));
  const g = fixture(); delete g.host.resourceReview; g.updateHost(); assertOnlyPaused(g, code('staging_configuration_required'));
  const h = fixture(); h.host.expectedAutomationEmail = 'other@example.invalid'; h.updateHost(); assertOnlyPaused(h, code('configuration_identity'));
  const i = fixture(); i.host.unexpectedSecret = 'must-not-be-imported'; i.updateHost(); assertOnlyPaused(i, code('configuration_invalid'));
});

test('invalid JSON, property types and multibyte size limits preserve the previous configuration', () => {
  const f = fixture(); f.map[H.principals] = '{invalid'; assertOnlyPaused(f, code('configuration_invalid'));
  const g = fixture(); g.map[H.principals] = { entries: [] }; assertOnlyPaused(g, code('configuration_invalid'));
  const h = fixture(); h.map[H.attendanceCatalog] = JSON.stringify({ references: {}, extra: 'é'.repeat(4100) }); assertOnlyPaused(h, code('configuration_size'));
  const i = fixture(); i.state.sourceOverride = '['; assertOnlyPaused(i, code('configuration_invalid'));
  const j = fixture(); j.state.sourceOverride = 'x'.repeat(65_537); assertOnlyPaused(j, code('configuration_size')); assert.ok(j.state.calls.every(url => !url.includes('alt=media')));
  const k = fixture(); k.state.declaredSize = '1'; assertOnlyPaused(k, code('configuration_changed'));
});

test('registry, catalog and projection semantics validate before any batch property write', () => {
  const f = fixture(); f.principal.entries.push({ ...f.principal.entries[0] }); f.map[H.principals] = JSON.stringify(f.principal); assertOnlyPaused(f, code('configuration_invalid'));
  const g = fixture(); g.catalog.references['scope.one'].coveredPersonIds.push('person.one'); g.map[H.attendanceCatalog] = JSON.stringify(g.catalog); assertOnlyPaused(g, code('configuration_invalid'));
  const h = fixture(); h.projection.generation = 2; h.updateProjection(); assertOnlyPaused(h, code('configuration_invalid'));
  const i = fixture(); i.projection.attendance = { ...i.host.journal }; i.updateProjection(); assertOnlyPaused(i, code('configuration_invalid'));
  const j = fixture(); j.projection.cursors = { ...j.host.journal }; j.updateProjection(); assertOnlyPaused(j, code('configuration_invalid'));
  const k = fixture(); k.projection.decisions = { spreadsheetId: k.host.decisionInput.spreadsheetId, sheetId: k.host.decisionInput.sheetId }; k.updateProjection(); assertOnlyPaused(k, code('configuration_invalid'));
});

test('missing bootstrap, account identity and OAuth consent stop without configuration changes', () => {
  const f = fixture(); f.properties.delete(CONFIG_FILE_ID_PROPERTY); assertOnlyPaused(f, code('configuration_file_required')); assert.equal(f.state.calls.length, 0);
  const g = fixture(); g.state.executor = ''; assertOnlyPaused(g, code('configuration_identity')); assert.equal(g.state.calls.length, 0);
  const h = fixture(); h.state.token = ''; assertOnlyPaused(h, code('configuration_authorization')); assert.equal(h.state.calls.length, 0);
});

test('Google failures expose no remote response or token and leave all previous settings intact', () => {
  const f = fixture(); f.state.status = 403; assertOnlyPaused(f, code('configuration_fetch_failed'));
  const g = fixture(); g.state.failUrl = 'alt=media'; assertOnlyPaused(g, error => error.code === 'configuration_fetch_failed' && !error.message.includes('Sensitive'));
});

test('a property provider failure is never reported as an atomic successful import', () => {
  for (const mode of ['failBatch', 'discardWrites']) {
    const f = fixture(); f.state[mode] = true;
    assert.throws(() => f.run(), code('configuration_write_failed'));
    assert.equal(f.properties.get(H.enabled), 'false'); assert.equal(f.properties.has(H.setupReceipt), false); assert.equal(f.properties.has(N.projectionReceipt), false);
    assert.equal(f.properties.get(H.secret), 'fixture-secret-untouched-never-read'); assert.equal(f.state.secretReads, 0);
  }
});

test('an unconfirmed pause stops before downloading or replacing any configuration', () => {
  const f = fixture(); const before = new Map(f.properties); f.state.discardPause = true;
  assert.throws(() => f.run(), code('configuration_write_failed'));
  assert.deepEqual(f.properties, before); assert.equal(f.state.calls.length, 0); assert.equal(f.state.mutations.length, 6);
});


test('optional maintenance configuration stays file-owned and imports pause it', () => {
 const f=fixture();f.map[M.config]=JSON.stringify({version:1,environment:'staging',generation:1,enabled:true,
 resourceReview:'EXISTING_PRIVATE_MAINTENANCE_REVIEWED_FOR_STAGING',principalId:'automation',workerId:'maintenance-worker',sourceResource:'maintenance-source',stateFileId:'maintenance-state',archiveSpreadsheetId:'maintenance-archive',archiveExpectedTitle:'SHAMROCK staging archives'});
 f.properties.set(M.config,'stale-binding');assert.equal(f.run().propertyCount,5);assert.equal(f.properties.has(M.config),false);assert.equal(f.properties.get(M.paused),'true');
});
