import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { initializeLocalDatabase } from '../../scripts/lib/v3-local-database.mjs';
import { retainedHistorySummary, retainedHistoryAggregateSql } from '../../.build/v3/apps/worker/src/retained-history-summary.js';
import { buildRetainedHistorySummary, parseReviewedRetainedHistory, retainedHistoryCanonical, validateRetainedHistorySummary } from '../../.build/v3/packages/domain/src/retained-history-summary.js';
const sha = value => createHash('sha256').update(value).digest('hex');
const selection = { snapshotId: 'archive-prior', sourceSnapshotSha256: 'a'.repeat(64), expectedPeriodLabel: 'Prior term' };
const term = { ...selection, termId: 'retained-prior', label: 'Prior term', sortOrder: 1 };
const reviewed = terms => { const body = { version: 1, reviewId: 'fictional-reviewed-selection', terms }; return { ...body, selectionSha256: sha(retainedHistoryCanonical(body)) }; };
const bins = [{ asYear: 'AS100', rows: 2, unresolvedRows: 1, overallSum: 1.5, overallCount: 2, llabSum: 1, llabCount: 1, invalidRows: 0 },
  { asYear: 'unknown', rows: 1, unresolvedRows: 0, overallSum: .25, overallCount: 1, llabSum: 0, llabCount: 0, invalidRows: 0 }];

test('saved numeric means preserve unresolved rows, missing values and unknown AS-year contribution', () => {
  const summary = buildRetainedHistorySummary(selection, 3, bins);
  assert.equal(summary.overall.percentage, 1.75 / 3); assert.equal(summary.llab.percentage, 1);
  assert.deepEqual(summary.llab, { percentage: 1, contributors: 1, omitted: 2 });
  assert.equal(summary.unresolvedRows, 1); assert.equal(summary.unknownAsYearRows, 1);
  assert.equal(summary.attendanceByYear.find(row => row.asYear === 'AS100').overall.percentage, .75);
  assert.equal(summary.attendanceByYear.find(row => row.asYear === 'AS400').overall.percentage, null);
  assert.deepEqual(validateRetainedHistorySummary(summary, selection), summary);
  assert.equal(buildRetainedHistorySummary(selection, 0, []).overall.percentage, null);
  assert.deepEqual(buildRetainedHistorySummary(selection, 1, [{ asYear: 'AS100', rows: 1, unresolvedRows: 0, overallSum: 0, overallCount: 1, llabSum: 0, llabCount: 0, invalidRows: 0 }]).overall, { percentage: 0, contributors: 1, omitted: 0 });
});
test('reviewed selections require exact digest and never guess duplicate periods or identities', () => {
  const config = reviewed([term]); assert.deepEqual(parseReviewedRetainedHistory(config, sha), config);
  for (const mutate of [c => c.terms[0].snapshotId = 'other-copy', c => c.terms[0].label = 'Renamed', c => c.terms.push({ ...c.terms[0], snapshotId: 'duplicate-copy' })]) {
    const bad = structuredClone(config); mutate(bad); assert.throws(() => parseReviewedRetainedHistory(bad, sha));
  }
  assert.throws(() => buildRetainedHistorySummary(selection, 4, bins));
  assert.throws(() => buildRetainedHistorySummary(selection, 3, bins.map(row => ({ ...row, invalidRows: 1 }))));
  const summary = buildRetainedHistorySummary(selection, 3, bins); summary.overall.percentage = 1.1;
  assert.throws(() => validateRetainedHistorySummary(summary, selection));
});

async function database(t) {
  const secret = 'fictional-summary-test-secret-never-deploy', key = 'fixture-key';
  const mf = new Miniflare({ modules: true, scriptPath: resolve('.build/v3-artifacts/worker.mjs'), compatibilityDate: '2026-07-01', d1Databases: { DB: 'summary-fixture' }, bindings: { ENVIRONMENT: 'staging', GENERATION: '1', BRIDGE_KEY_ID: key, BRIDGE_SECRET: secret }, log: new Log(LogLevel.NONE) });
  t.after(() => mf.dispose()); const db = await mf.getD1Database('DB'); await initializeLocalDatabase(db);
  const insert = (table, row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row));
  const at = '2026-11-01T00:00:00.000Z';
  await db.batch([db.prepare("INSERT INTO system_control VALUES(1,'staging',1,0)"), db.prepare("INSERT INTO principals VALUES('reader',NULL,1),('outsider',NULL,1)"), db.prepare("INSERT INTO admin_grants VALUES('reader','frontend.read','wing','*'),('outsider','frontend.read','flight','alpha')"),
    insert('legacy_import_runs', { import_run_id: 'run', snapshot_sha256: selection.sourceSnapshotSha256, plan_sha256: 'b'.repeat(64), reconciliation_sha256: 'c'.repeat(64), review_reference: 'fictional-review', environment: 'staging', generation: 1, state: 'complete', expected_occurrences: 4, expected_profiles: 1, expected_events: 1, expected_baselines: 1, expected_batches: 1, manifest_json: '{}', started_at: at, completed_at: at }),
    insert('legacy_matrix_snapshots', { matrix_snapshot_id: selection.snapshotId, import_run_id: 'run', source_resource_key: 'fictional-archive', source_sheet_id: 1, metadata_json: JSON.stringify({ periodLabel: selection.expectedPeriodLabel, isCurrent: false, columns: [] }), roster_json: '[]' })]);
  for (const [i, [year, overall, llab]] of [['AS100', .5, null], ['AS100', 1, 1], ['Unmapped', .25, '75%'], ['AS400', true, false]].entries()) {
    const occurrenceId = `row-${i}`, personId = i === 0 ? null : `person-${i}`, payload = { occurrenceId, personId, identityLabels: ['example', `cadet-${i}`, year.toLowerCase(), 'alpha', 'blue'], overall, llab };
    await db.batch([insert('legacy_source_occurrences', { import_run_id: 'run', occurrence_id: occurrenceId, fingerprint: sha(occurrenceId), source_kind: 'matrix', disposition: 'evidence-only', locator_json: JSON.stringify({ rowIndex: i + 2 }), raw_json: JSON.stringify(['Example', `Cadet-${i}`, year, 'Alpha', 'Blue'].map(stringValue => ({ effectiveValue: { stringValue } }))), normalized_json: null, diagnostics_json: '{}' }), insert('legacy_matrix_snapshot_rows', { matrix_snapshot_id: selection.snapshotId, source_occurrence_id: occurrenceId, person_id: personId, payload_json: JSON.stringify(payload) })]);
  }
  const env = { DB: db, ENVIRONMENT: 'staging', GENERATION: '1' }, request = { environment: 'staging', generation: 1, principalId: 'reader', selections: [selection] };
  const send = async (input, authenticated = true) => { const path = '/v1/admin/history/summary', body = JSON.stringify(input), timestamp = String(Math.floor(Date.now() / 1000)); return mf.dispatchFetch(`https://fixture.invalid${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-shamrock-key-id': key, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': authenticated ? createHmac('sha256', secret).update(`POST\n${path}\n${timestamp}\n${sha(body)}`).digest('hex') : '0'.repeat(64) } }); };
  return { db, env, request, send };
}

test('signed summary reads at most five statements and emits only aggregates without identities or source payloads', async t => {
  const { db, env, request, send } = await database(t); let statements = 0;
  const wrapped = { ...env, DB: { prepare: sql => db.prepare(sql), batch: queries => { statements = queries.length; return db.batch(queries); } } };
  const result = await retainedHistorySummary(wrapped, request); assert.equal(statements, 3);
  const summary = result.summaries[0]; assert.equal(summary.rows, 4); assert.equal(summary.overall.percentage, 1.75 / 3); assert.equal(summary.overall.omitted, 1); assert.equal(summary.llab.omitted, 3); assert.equal(summary.unresolvedRows, 1);
  const text = JSON.stringify(result); assert(!text.includes('person-')); assert(!text.includes('Cadet-')); assert(!text.includes('raw_json')); assert(text.length < 8000);
  assert.equal((await send(request, false)).status, 401); const response = await send(request); assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_commands').first()).n, 0);
  assert.match(retainedHistoryAggregateSql, /LIMIT 501/);
  const second = { ...selection, snapshotId: 'archive-second', expectedPeriodLabel: 'Earlier term' };
  await db.batch([db.prepare("INSERT INTO legacy_matrix_snapshots SELECT 'archive-second',import_run_id,source_resource_key,source_sheet_id,json_set(metadata_json,'$.periodLabel','Earlier term'),roster_json FROM legacy_matrix_snapshots WHERE matrix_snapshot_id=?").bind(selection.snapshotId),
    db.prepare("INSERT INTO legacy_matrix_snapshot_rows SELECT 'archive-second',source_occurrence_id,person_id,payload_json FROM legacy_matrix_snapshot_rows WHERE matrix_snapshot_id=?").bind(selection.snapshotId)]);
  const two = await retainedHistorySummary(wrapped, { ...request, selections: [selection, second] });
  assert.equal(statements, 5); assert.equal(two.summaries.length, 2); assert.equal(two.summaries[1].overall.percentage, summary.overall.percentage);
  await db.prepare("DELETE FROM admin_grants WHERE principal_id='reader'").run();
  await assert.rejects(retainedHistorySummary(wrapped, request), e => e.code === 'NOT_AUTHORIZED');
});
test('current Wing authority, import completion and exact selected source are mandatory', async t => {
  const { db, env, request } = await database(t);
  await assert.rejects(retainedHistorySummary(env, { ...request, principalId: 'outsider' }), e => e.code === 'NOT_AUTHORIZED');
  await assert.rejects(retainedHistorySummary(env, { ...request, generation: 2 }), e => e.code === 'WRONG_GENERATION');
  for (const selected of [{ ...selection, sourceSnapshotSha256: 'd'.repeat(64) }, { ...selection, expectedPeriodLabel: 'Different term' }]) await assert.rejects(retainedHistorySummary(env, { ...request, selections: [selected] }), e => e.code === 'HISTORY_SELECTION_CHANGED');
  await db.prepare("UPDATE legacy_matrix_snapshots SET metadata_json=json_set(metadata_json,'$.isCurrent',json('true'))").run();
  await assert.rejects(retainedHistorySummary(env, request), e => e.code === 'HISTORY_SELECTION_CHANGED');
  await db.prepare("UPDATE legacy_import_runs SET state='loading'").run(); await assert.rejects(retainedHistorySummary(env, request), e => e.code === 'NOT_FOUND');
  await db.prepare("UPDATE principals SET active=0 WHERE principal_id='reader'").run(); await assert.rejects(retainedHistorySummary(env, request), e => e.code === 'NOT_AUTHORIZED');
});
test('invalid saved numeric values or mismatched source labels stop publication rather than truncate history', async t => {
  const { db, env, request } = await database(t);
  await db.prepare("UPDATE legacy_matrix_snapshot_rows SET payload_json=json_set(payload_json,'$.overall',1.25) WHERE source_occurrence_id='row-0'").run();
  await assert.rejects(retainedHistorySummary(env, request), e => e.code === 'INVALID_LEGACY_HISTORY');
  await db.prepare("UPDATE legacy_matrix_snapshot_rows SET payload_json=json_set(payload_json,'$.overall',0.5,'$.identityLabels[2]','as400') WHERE source_occurrence_id='row-0'").run();
  await assert.rejects(retainedHistorySummary(env, request), e => e.code === 'INVALID_LEGACY_HISTORY');
});


test('captured AS-year tab and NBSP whitespace matches saved labels without changing the category', async t => {
  const { db, env, request } = await database(t);
  await db.prepare("UPDATE legacy_source_occurrences SET raw_json=json_set(raw_json,'$[2].effectiveValue.stringValue',?) WHERE occurrence_id='row-0'").bind('\tAS100\u00a0').run();
  let result = await retainedHistorySummary(env, request);
  assert.equal(result.summaries[0].attendanceByYear.find(row => row.asYear === 'AS100').rows, 2);
  await db.batch([db.prepare("UPDATE legacy_source_occurrences SET raw_json=json_set(raw_json,'$[2].effectiveValue.stringValue',?) WHERE occurrence_id='row-0'").bind('AS\u00a0100'),
    db.prepare("UPDATE legacy_matrix_snapshot_rows SET payload_json=json_set(payload_json,'$.identityLabels[2]',?) WHERE source_occurrence_id='row-0'").bind('as\u00a0100')]);
  result = await retainedHistorySummary(env, request);
  assert.equal(result.summaries[0].attendanceByYear.find(row => row.asYear === 'AS100').rows, 2);
  assert.equal(result.summaries[0].overall.percentage, 1.75 / 3);
});

test('consumer refuses cross-bin contributor and weighted-mean inconsistency', () => {
  const summary = buildRetainedHistorySummary(selection, 2, [bins[0]]);
  const count = structuredClone(summary); count.overall.contributors = 1; count.overall.omitted = 1;
  assert.throws(() => validateRetainedHistorySummary(count, selection));
  const mean = structuredClone(summary); mean.overall.percentage = .2;
  assert.throws(() => validateRetainedHistorySummary(mean, selection));
});

test('predecessor summary reads its explicit AS-year column and accepts the original first data row',async t=>{
 const f=await database(t),metadata={periodLabel:selection.expectedPeriodLabel,isCurrent:false,columns:[],sourceFormat:'predecessor-human-headers-v1',sourceIdentityColumns:[1,2,0,4,null],dataStartRowIndex:1};
 await f.db.prepare('UPDATE legacy_matrix_snapshots SET metadata_json=?').bind(JSON.stringify(metadata)).run();
 for(const r of (await f.db.prepare('SELECT occurrence_id,raw_json,locator_json FROM legacy_source_occurrences').all()).results){const raw=JSON.parse(r.raw_json),converted=[raw[2],raw[0],raw[1],{effectiveValue:{stringValue:'typed@example.invalid'}},raw[3]],locator=JSON.parse(r.locator_json);locator.rowIndex--;await f.db.prepare('UPDATE legacy_source_occurrences SET raw_json=?,locator_json=? WHERE occurrence_id=?').bind(JSON.stringify(converted),JSON.stringify(locator),r.occurrence_id).run();}
 const result=await retainedHistorySummary(f.env,f.request);assert.equal(result.summaries[0].attendanceByYear.find(r=>r.asYear==='AS100').rows,2);assert.ok(!JSON.stringify(result).includes('typed@example.invalid'));
 metadata.sourceIdentityColumns=[1,2,3,4,null];await f.db.prepare('UPDATE legacy_matrix_snapshots SET metadata_json=?').bind(JSON.stringify(metadata)).run();await assert.rejects(retainedHistorySummary(f.env,f.request),e=>e.code==='INVALID_LEGACY_HISTORY');
});
