import test from 'node:test';
import assert from 'node:assert/strict';
import { importDigest } from '../../scripts/lib/import-capture.mjs';
import { prepareNativeCutover, verifyNativeContinuity } from '../../scripts/lib/native-cutover.mjs';
import { prepareNativeRows, verifyOriginalResponses } from '../../scripts/lib/native-cutover-rows.mjs';
import { prepareFirstPublication, verifyPublishedTables } from '../../scripts/lib/native-cutover-publication.mjs';
import { rehearseNativeCutover } from '../../scripts/lib/native-cutover-rehearsal.mjs';

const surfaces = {
  main: ['Dashboard', 'Dashboard Data', 'Directory', 'Leadership', 'Attendance', 'Data Legend'],
  management: ['Blue', 'Gold', '_Excusals Data Legend'],
  backend: ['Responses'],
  archive: ['History']
};
const common = { last_name: 'Example', first_name: 'Sample', as_year: 'AS100', flight: 'Alpha', squadron: 'Blue' };
const keyRow = {
  directory: { ...common, email: 'sample@example.invalid' },
  leadership: { last_name: 'Example', first_name: 'Sample', role: 'Example role' },
  attendance: { ...common, overall_attendance_pct: 1, llab_attendance_pct: 1, 'Sample event': 'P' }
};
const excusal = {
  timestamp: 'Example time',
  decision: 'Approved',
  event: 'Sample event',
  reason: 'Example',
  requested_outcome: 'E',
  email: 'sample@example.invalid',
  last_name: 'Example',
  first_name: 'Sample',
  flight: 'Alpha',
  request_id: 'request-one'
};
function cell(v) {
  return v == null ? {} : { userEnteredValue: typeof v === 'number' ? { numberValue: v } : { stringValue: v } };
}
function seal(capture) {
  delete capture.snapshotSha256;
  capture.snapshotSha256 = importDigest(capture);
}
const item = (itemId) => ({
  itemId,
  title: 'Question',
  questionItem: { question: { questionId: itemId + 'q', choiceQuestion: { type: 'RADIO', options: [{ value: 'Before' }] } } }
});
function fixture() {
  const original = { books: {}, forms: {} },
    staging = { books: {}, forms: {} };
  const manifest = { formatVersion: 1, resources: [] },
    capture = { consistent: true, resources: [] };
  const projection = { plans: {}, queuePlans: {}, revision: { operations: 1, administration: 1 } };
  const dispositions = [];
  let seq = 0;
  for (const [key, names] of Object.entries(surfaces)) {
    const id = 'original-' + key;
    const book = {
      spreadsheetId: id,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      properties: { title: key },
      sheets: []
    };
    const resource = { key, providerId: id, kind: 'workbook', coherent: true, sheets: [] };
    manifest.resources.push({ key, providerId: id, kind: 'workbook' });
    for (const name of names) {
      const kind = name.toLowerCase(),
        queue = ['blue', 'gold'].includes(kind),
        sheetId = seq++;
      const raw = keyRow[kind]
        ? [keyRow[kind]]
        : queue
          ? kind === 'blue'
            ? [excusal, { ...excusal, request_id: 'historical' }]
            : []
          : [];
      const headers = Object.keys(queue ? excusal : (keyRow[kind] ?? {}));
      const rows = [headers.map(cell), headers.map(cell), ...raw.map((r) => headers.map((h) => cell(r[h])))];
      const properties = { sheetId, title: name, gridProperties: { rowCount: rows.length, columnCount: headers.length } };
      const range = { sheetId, startRowIndex: 1, startColumnIndex: 0, endRowIndex: rows.length, endColumnIndex: headers.length };
      const tables = headers.length
        ? [{ name: kind, tableId: 'table-' + kind, range, columnProperties: headers.map((columnName) => ({ columnName })) }]
        : [];
      const sheet = { properties, tables };
      resource.sheets.push({ metadata: structuredClone(sheet), rows });
      book.sheets.push(sheet);
      if (!headers.length) continue;
      const idHeader = queue ? 'request_id' : kind === 'leadership' ? 'contact_id' : 'person_id';
      const modelHeaders = headers.map((h) => (h === 'Sample event' ? 'event:exercise' : h));
      if (!queue) modelHeaders.push(idHeader);
      const baselines = raw
        .filter((r) => r.request_id !== 'historical')
        .map((r) => {
          const id = queue ? r.request_id : kind === 'leadership' ? 'canonical-contact' : 'cadet-example';
          const values = Object.fromEntries(headers.map((h, i) => [modelHeaders[i], r[h]]));
          values[idHeader] = id;
          if (queue) values.timestamp = 45000;
          return { key: id, values, versions: {} };
        });
      (queue ? projection.queuePlans : projection.plans)[kind] = {
        complete: true,
        retainedDrafts: [],
        diagnostics: [],
        nextBaseline: { rows: baselines, revision: projection.revision },
        expectedAfter: {
          headers: modelHeaders,
          labels: modelHeaders,
          rows: baselines.map((r) => modelHeaders.map((h) => cell(r.values[h])))
        }
      };
    }
    original.books[key] = book;
    capture.resources.push(resource);
    if (key === 'main' || key === 'management') {
      const ref = structuredClone(book);
      ref.spreadsheetId = 'reference-' + key;
      ref.sheets.forEach((s) => {
        s.properties.sheetId += 100;
        s.tables.forEach((t) => {
          t.tableId += '-copy';
          t.range.sheetId += 100;
        });
      });
      staging.books[key] = ref;
    }
  }
  for (const key of ['attendance', 'excusals', 'directory']) {
    const id = 'original-' + key,
      form = {
        formId: id,
        responderUri: 'https://docs.google.com/forms/d/e/' + id + '/viewform',
        linkedSheetId: original.books.backend.spreadsheetId,
        info: { title: key },
        revisionId: 'rev-one',
        settings: { emailCollectionType: 'RESPONDER_INPUT' },
        items: [item('question')]
      };
    original.forms[key] = form;
    const ref = structuredClone(form);
    ref.formId = 'reference-' + key;
    ref.settings.emailCollectionType = 'VERIFIED';
    ref.items[0].questionItem.question.choiceQuestion.options = [
      { value: 'After', ...(key === 'attendance' ? { goToSectionId: 'section' } : {}) }
    ];
    if (key === 'attendance')
      ref.items.push(
        { itemId: 'section', pageBreakItem: {} },
        {
          itemId: 'checkbox',
          questionItem: {
            question: { questionId: 'additional', choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'One' }] } }
          }
        }
      );
    staging.forms[key] = ref;
    const manifestKey = 'form-' + (key === 'excusals' ? 'excusal' : key);
    manifest.resources.push({ key: manifestKey, providerId: id, kind: 'form' });
    const responses = [{ responseId: 'prior', answers: { questionq: { textAnswers: { answers: [{ value: 'Before' }] } } } }];
    capture.resources.push({
      key: manifestKey,
      providerId: id,
      kind: 'form',
      coherent: true,
      responses,
      responsesSha256: importDigest(responses)
    });
  }
  capture.manifestSha256 = importDigest(manifest);
  seal(capture);
  dispositions.push(
    { kind: 'leadership', disposition: 'adopted', record: keyRow.leadership },
    ...['request-one', 'historical'].map((id, i) => ({
      kind: 'excusal',
      disposition: i ? 'retired' : 'adopted',
      requestId: id,
      record: { request_id: id }
    }))
  );
  return {
    inventory: { production: original, staging },
    manifest,
    capture,
    projection,
    operational: { snapshotSha256: capture.snapshotSha256, dispositions },
    events: [{ eventId: 'exercise', label: 'Sample event' }]
  };
}
function prepare(f) {
  const packet = prepareNativeCutover(f.inventory, f.manifest);
  packet.rows = prepareNativeRows(packet, f);
  packet.publication = prepareFirstPublication(packet, f.capture, f.projection);
  return packet;
}
test('in-place rehearsal preserves original bookmark, question, answer and row identities across differently numbered copies', () => {
  const f = fixture(),
    p = prepare(f);
  assert.equal(p.books.main.tabs.Attendance.sheetId, f.inventory.production.books.main.sheets[4].properties.sheetId);
  assert.equal(p.forms.attendance.batch.requests.filter((r) => r.createItem).length, 2);
  assert.deepEqual(p.forms.attendance.batch.writeControl, { requiredRevisionId: 'rev-one' });
  assert.equal(p.dashboardActions[0].url, f.inventory.production.forms.attendance.responderUri);
  const { capture, production } = rehearseNativeCutover(p, f.inventory, f.capture);
  assert.equal(production.forms.attendance.items[0].questionItem.question.questionId, 'questionq');
  assert.deepEqual(p.publication.baselineTemplates.blue.slots.keys, ['request-one', 'historical']);
  verifyPublishedTables(p, capture);
  const originalForm = capture.resources.find((r) => r.kind === 'form');
  originalForm.responses.push({ responseId: 'later' });
  seal(capture);
  verifyOriginalResponses(p, capture);
  originalForm.responses[0].answers = {};
  seal(capture);
  assert.throws(() => verifyOriginalResponses(p, capture), /response is missing or changed/);
});
test('rejects a wrong destination, replaced question, changed revision, missing original tab, or overlapping source and target', () => {
  for (const breakIt of [
    (f) => (f.inventory.production.forms.directory.linkedSheetId = 'other'),
    (f) => (f.inventory.staging.forms.directory.items[0].questionItem.question.questionId = 'replacement'),
    (f) => (f.inventory.staging.books.main.spreadsheetId = f.inventory.production.books.main.spreadsheetId),
    (f) => f.inventory.production.books.main.sheets.pop()
  ]) {
    const f = fixture();
    breakIt(f);
    assert.throws(() => prepare(f));
  }
  const f = fixture(),
    p = prepare(f);
  f.inventory.production.forms.attendance.revisionId = 'rev-two';
  assert.throws(() => verifyNativeContinuity(p, f.inventory.production), /changed after preparation/);
});
test('fails closed on swapped queue, ambiguous identity, missing disposition, unexpected decision, or attendance conflict', () => {
  for (const breakIt of [
    (f) => {
      const q = f.projection.queuePlans;
      [q.blue, q.gold] = [q.gold, q.blue];
    },
    (f) =>
      f.projection.plans.directory.nextBaseline.rows.push({
        ...f.projection.plans.directory.nextBaseline.rows[0],
        key: 'duplicate'
      }),
    (f) => f.operational.dispositions.pop(),
    (f) => (f.projection.queuePlans.blue.expectedAfter.rows[0][1] = cell('Denied')),
    (f) => (f.projection.plans.attendance.nextBaseline.rows[0].values['event:exercise'] = 'A')
  ]) {
    const f = fixture();
    breakIt(f);
    assert.throws(() => prepare(f));
  }
});
test('published readback detects missing data and retained slot edits', () => {
  const f = fixture(),
    p = prepare(f),
    { capture } = rehearseNativeCutover(p, f.inventory, f.capture);
  capture.resources.find((r) => r.key === 'management').sheets[0].rows[3][1] = cell('Denied');
  seal(capture);
  assert.throws(() => verifyPublishedTables(p, capture), /Published data differs/);
});

test('freeze detects an edit after the last reviewed capture even if the native IDs still match', async () => {
  const { verifyFrozenSources } = await import('../../scripts/lib/native-cutover-rows.mjs');
  const f = fixture(),
    p = prepare(f);
  verifyFrozenSources(p, f.capture);
  f.capture.resources[0].versionAfter = 'changed';
  seal(f.capture);
  assert.throws(() => verifyFrozenSources(p, f.capture), /changed since preparation/);
});
