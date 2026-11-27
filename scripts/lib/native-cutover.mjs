// Offline preparation. Provider identities in the returned packet are private.
import { isDeepStrictEqual as same } from 'node:util';
import { importDigest } from './import-capture.mjs';

const surfaces = {
  main: ['Dashboard', 'Dashboard Data', 'Directory', 'Leadership', 'Attendance', 'Data Legend'],
  management: ['Blue', 'Gold', '_Excusals Data Legend']
};
const formKeys = ['attendance', 'excusals', 'directory'];
const required = (ok, message) => {
  if (!ok) throw new Error(message);
};
function byId(items, key) {
  const result = new Map();
  for (const item of items) {
    const id = key(item);
    required(id !== undefined && id !== null && id !== '' && !result.has(id), 'Missing or duplicate native identity');
    result.set(id, item);
  }
  return result;
}

function formIdentity(form) {
  required(form.formId && form.responderUri && form.revisionId, 'Incomplete Google Form metadata');
  const items = form.items.map((item) => {
    const questions = item.questionGroupItem?.questions ?? (item.questionItem ? [item.questionItem.question] : []);
    return { itemId: item.itemId, questions: questions.map((q) => q.questionId) };
  });
  byId(items, (i) => i.itemId);
  byId(
    items.flatMap((i) => i.questions),
    (id) => id
  );
  return { formId: form.formId, responderUri: form.responderUri, linkedSheetId: form.linkedSheetId ?? null, items };
}
function workbookIdentity(book) {
  required(book.spreadsheetUrl && book.spreadsheetId, 'Missing spreadsheet URL or ID');
  byId(book.sheets, (s) => s.properties.sheetId);
  return {
    spreadsheetId: book.spreadsheetId,
    spreadsheetUrl: book.spreadsheetUrl,
    title: book.properties.title,
    tabs: book.sheets.map((s) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      tables: (s.tables ?? []).map((t) => t.tableId),
      charts: (s.charts ?? []).map((c) => c.chartId),
      filters: (s.filterViews ?? []).map((v) => v.filterViewId)
    }))
  };
}
function assertResourceManifest(production, reference, manifest) {
  const targets = manifest.resources;
  required(manifest.formatVersion === 1 && Array.isArray(targets), 'Expected a reviewed legacy capture manifest');
  byId(targets, (r) => r.providerId);
  const pins = byId(targets, (r) => r.key);
  required(
    ['main', 'management', 'backend'].every((k) => production.books[k]) &&
      same(Object.keys(production.forms).sort(), [...formKeys].sort()) &&
      same(Object.keys(reference.forms).sort(), [...formKeys].sort()),
    'Incomplete Google resource roles'
  );
  const originals = [
    ...Object.entries(production.books),
    ...Object.entries(production.forms).map(([k, f]) => ['form-' + (k === 'excusals' ? 'excusal' : k), f])
  ];
  required(pins.size === originals.length && production.books.backend, 'Incomplete original resource inventory');
  for (const [role, r] of originals) {
    const pin = pins.get(role);
    required(
      pin &&
        (r.formId
          ? pin.kind === 'form' && pin.providerId === r.formId
          : pin.kind === 'workbook' && pin.providerId === r.spreadsheetId) &&
        (!pin.expectedTitle || pin.expectedTitle === (r.properties?.title ?? r.info?.title)),
      'Original resource differs from reviewed capture manifest'
    );
  }
  const sources = [
    ...Object.values(reference.books).map((b) => b.spreadsheetId),
    ...Object.values(reference.forms).map((f) => f.formId)
  ];
  byId(sources, (id) => id);
  const originalIds = new Set(targets.map((r) => r.providerId));
  required(
    sources.every((id) => !originalIds.has(id)),
    'Staging and original identities overlap'
  );
}

function planWorkbook(role, original, reference) {
  const originals = byId(original.sheets, (s) => s.properties.title);
  const references = byId(reference.sheets, (s) => s.properties.title);
  const tabs = {};
  for (const title of surfaces[role]) {
    const live = originals.get(title),
      staged = references.get(title);
    required(live && staged, 'Required presentation tab missing');
    const tables = byId(live.tables ?? [], (t) => t.name);
    const stagedTables = byId(staged.tables ?? [], (t) => t.name);
    required(tables.size === stagedTables.size, 'Table inventory differs on a managed tab');
    tabs[title] = {
      sheetId: live.properties.sheetId,
      tables: [...stagedTables].map(([name, t]) => {
        const target = tables.get(name);
        required(
          target?.tableId && target.range.sheetId === live.properties.sheetId,
          'Existing presentation Table not found on the target tab'
        );
        return {
          name,
          tableId: target.tableId,
          originalRange: target.range,
          originalColumns: target.columnProperties.map((c) => c.columnName),
          projectedColumns: t.columnProperties.map((c) => c.columnName)
        };
      })
    };
  }
  return { spreadsheetId: original.spreadsheetId, expectedTitle: original.properties.title, tabs };
}

// Only additive optional checkbox/section creation and narrowly masked option updates.
// Never recreate an existing question. Separate creation from changes to branching.
function planForm(original, reference, role) {
  const target = formIdentity(original);
  formIdentity(reference);
  const old = byId(original.items, (i) => i.itemId);
  required(
    same(
      original.items.map((i) => i.itemId),
      reference.items.filter((i) => old.has(i.itemId)).map((i) => i.itemId)
    ),
    'Original Form items were removed, reordered or replaced in the reference'
  );
  required(reference.settings?.emailCollectionType === 'VERIFIED', 'Reference Form needs verified respondent identity');
  const creates = [],
    updates = [],
    addedSections = [];
  const sectionIds = new Set(reference.items.filter((i) => i.pageBreakItem).map((i) => i.itemId));
  for (const [index, item] of reference.items.entries()) {
    const prior = old.get(item.itemId);
    const choice = item.questionItem?.question?.choiceQuestion;
    for (const option of choice?.options ?? []) {
      required(!option.goToSectionId || sectionIds.has(option.goToSectionId), 'Unresolved Form branch');
    }
    if (!prior) {
      const question = item.questionItem?.question;
      required(
        role === 'attendance' &&
          (item.pageBreakItem ||
            (choice?.type === 'CHECKBOX' &&
              !question.required &&
              choice.options.every((o) => !o.goToAction && !o.goToSectionId))),
        'Unreviewed new Form item type'
      );
      creates.push({ createItem: { item, location: { index } } });
      if (item.pageBreakItem) addedSections.push(item.itemId);
      continue;
    }
    if (same(prior, item)) continue;
    const next = structuredClone(prior);
    required(choice && next.questionItem?.question?.choiceQuestion, 'Existing Form structure differs');
    next.questionItem.question.choiceQuestion.options = choice.options;
    required(same(next, item), 'Existing question ID, title, type or non-choice settings differ');
    updates.push({ updateItem: { item: next, location: { index }, updateMask: 'questionItem.question.choiceQuestion.options' } });
  }
  const settings =
    original.settings.emailCollectionType === 'VERIFIED'
      ? []
      : [{ updateSettings: { settings: { emailCollectionType: 'VERIFIED' }, updateMask: 'emailCollectionType' } }];
  return {
    target,
    expectedTitle: original.info.title,
    originalMetadataHash: importDigest(original),
    batch: { writeControl: { requiredRevisionId: original.revisionId }, requests: [...creates, ...updates, ...settings] },
    verifyNewSubmitContinuations: addedSections,
    expectedItemsHash: importDigest(reference.items),
    expectedEnvelopeHash: importDigest({
      info: original.info,
      settings: { ...original.settings, emailCollectionType: 'VERIFIED' }
    })
  };
}

export function prepareNativeCutover({ production, staging }, manifest) {
  assertResourceManifest(production, staging, manifest);
  const originals = { books: {}, forms: {} },
    books = {},
    forms = {};
  for (const [key, b] of Object.entries(production.books)) originals.books[key] = workbookIdentity(b);
  for (const role of Object.keys(surfaces)) books[role] = planWorkbook(role, production.books[role], staging.books[role]);
  for (const key of formKeys) {
    const original = production.forms[key];
    required(
      original?.linkedSheetId === production.books.backend.spreadsheetId,
      'Original response destination differs from the operational Backend'
    );
    forms[key] = planForm(original, staging.forms[key], key);
    originals.forms[key] = forms[key].target;
  }
  const tabUrl = (role, name) => new URL('#gid=' + books[role].tabs[name].sheetId, originals.books[role].spreadsheetUrl).href;
  const dashboardActions = [
    ['Submit attendance', forms.attendance.target.responderUri],
    ['Request an excusal', forms.excusals.target.responderUri],
    ['Update Directory profile', forms.directory.target.responderUri],
    ['Attendance', tabUrl('main', 'Attendance')],
    ['Blue excusals', tabUrl('management', 'Blue')],
    ['Gold excusals', tabUrl('management', 'Gold')]
  ].map(([label, url]) => ({ label, url }));
  return { formatVersion: 1, manifestSha256: importDigest(manifest), originals, books, forms, dashboardActions };
}

export function verifyNativeContinuity(packet, production, { published = false } = {}) {
  required(packet.formatVersion === 1, 'Unknown native adoption packet');
  for (const [key, prior] of Object.entries(packet.originals.books)) {
    const now = workbookIdentity(production.books[key]);
    required(
      now.spreadsheetId === prior.spreadsheetId && now.spreadsheetUrl === prior.spreadsheetUrl && now.title === prior.title,
      'Spreadsheet identity changed'
    );
    for (const tab of prior.tabs) {
      const found = now.tabs.find((t) => t.sheetId === tab.sheetId && t.title === tab.title);
      required(
        found && ['tables', 'charts', 'filters'].every((k) => tab[k].every((id) => found[k].includes(id))),
        'An original tab, Table, chart or filter identity changed'
      );
    }
  }
  for (const key of formKeys) {
    const f = production.forms[key],
      prior = packet.originals.forms[key],
      now = formIdentity(f);
    const ids = new Set(prior.items.map((i) => i.itemId));
    required(
      now.formId === prior.formId &&
        now.responderUri === prior.responderUri &&
        now.linkedSheetId === prior.linkedSheetId &&
        same(
          now.items.filter((i) => ids.has(i.itemId)),
          prior.items
        ),
      'Original responder link, response destination or question identity changed'
    );
    if (!published)
      required(
        importDigest(f) === packet.forms[key].originalMetadataHash,
        'Original Form changed after preparation; collect and prepare again'
      );
    if (published)
      required(
        importDigest(f.items) === packet.forms[key].expectedItemsHash &&
          importDigest({ info: f.info, settings: f.settings }) === packet.forms[key].expectedEnvelopeHash,
        'Published Form choices, routing or respondent verification differ'
      );
  }
}
