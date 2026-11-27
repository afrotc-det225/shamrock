// Prepare identity-only Sheets batches from the original physical rows.
// No provider calls. A coherent capture alone does not fence subsequent edits.
import { isDeepStrictEqual } from 'node:util';
import { importDigest } from './import-capture.mjs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}
function unique(items, keyOf) {
  const index = new Map();
  for (const item of items) {
    const key = keyOf(item);
    check(key != null && key !== '' && !index.has(key), 'Missing or ambiguous adoption identity');
    index.set(key, item);
  }
  return index;
}
function value(cell) {
  const v = cell?.effectiveValue ?? cell?.userEnteredValue ?? {};
  check(!v.errorValue && !v.formulaValue, 'Unresolved cell in adoption input');
  return v.stringValue ?? v.numberValue ?? v.boolValue ?? null;
}
function identity(fields, row) {
  return JSON.stringify(
    fields.map((k) =>
      String(row[k] ?? '')
        .trim()
        .toLowerCase()
    )
  );
}
function tableRows(packet, capture, role, name) {
  const target = packet.books[role],
    tab = target.tabs[name];
  const book = capture.resources.find((r) => r.key === role);
  check(book?.coherent && book.providerId === target.spreadsheetId, 'Capture target differs from original');
  const sheet = book.sheets.find((s) => s.metadata.properties.sheetId === tab.sheetId);
  const table = sheet?.metadata.tables?.[0],
    pin = tab.tables[0];
  check(
    sheet?.metadata.properties.title === name &&
      tab.tables.length === 1 &&
      sheet.metadata.tables.length === 1 &&
      table.tableId === pin.tableId &&
      isDeepStrictEqual(table.range, pin.originalRange) &&
      isDeepStrictEqual(
        table.columnProperties.map((c) => c.columnName),
        pin.originalColumns
      ),
    'Original Table has drifted'
  );
  const range = table.range,
    rows = sheet.rows;
  check(
    range.startRowIndex === 1 && !range.startColumnIndex && range.endRowIndex <= rows.length,
    'Unexpected native Table coordinates'
  );
  const headers = rows[0].map(value);
  while (headers.length && headers.at(-1) === null) headers.pop();
  unique(headers, (h) => h);
  const records = [];
  for (let i = 2; i < rows.length; i++) {
    const data = rows[i].map(value);
    if (data.every((v) => v === null || v === '')) continue;
    check(
      i < range.endRowIndex && data.slice(headers.length).every((v) => v === null || v === ''),
      'Unmapped data outside reviewed columns or rows'
    );
    records.push({ sheetRow: i + 1, values: Object.fromEntries(headers.map((h, j) => [h, data[j] ?? null])) });
  }
  return { table, sheet, headers, records };
}
function writeColumn(sheetId, columnIndex, startRowIndex, strings) {
  return {
    updateCells: {
      start: { sheetId, columnIndex, rowIndex: startRowIndex },
      fields: 'userEnteredValue',
      rows: strings.map((stringValue) => ({ values: [{ userEnteredValue: { stringValue } }] }))
    }
  };
}
function keyRequests(source, keyHeader, keyLabel, bindings) {
  const { sheet, table, headers } = source;
  const { sheetId, gridProperties } = sheet.metadata.properties;
  const k = headers.length;
  const end = table.range.endColumnIndex;
  check(!headers.includes(keyHeader) && (end === k || end === k + 1), 'Unexpected identity column layout');
  // The legacy Attendance Table can have one automatically named empty trailing column.
  const originalLabel = value(sheet.rows[1][k]);
  check(
    (originalLabel === null || (end === k + 1 && /^Column \d+$/.test(originalLabel))) &&
      sheet.rows.every((r, i) => i === 1 || !(r[k]?.userEnteredValue || r[k]?.chipRuns?.length || r[k]?.note)),
    'Identity destination is occupied'
  );
  const requests = [];
  if (gridProperties.columnCount <= k) requests.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: 1 } });
  if (end === k)
    requests.push({
      updateTable: { table: { tableId: table.tableId, range: { ...table.range, endColumnIndex: k + 1 } }, fields: 'range' }
    });
  requests.push(writeColumn(sheetId, k, 0, [keyHeader, keyLabel]));
  // Write only identified rows, coalescing contiguous slots.
  for (let start = 0; start < bindings.length; ) {
    let endIndex = start + 1;
    while (endIndex < bindings.length && bindings[endIndex].sheetRow === bindings[endIndex - 1].sheetRow + 1) endIndex++;
    requests.push(
      writeColumn(
        sheetId,
        k,
        bindings[start].sheetRow - 1,
        bindings.slice(start, endIndex).map((b) => b.key)
      )
    );
    start = endIndex;
  }
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: k, endIndex: k + 1 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser'
    }
  });
  return requests;
}
export function prepareNativeRows(packet, { capture, projection, operational, events }) {
  const { snapshotSha256, ...body } = capture;
  check(
    capture.consistent &&
      importDigest(body) === snapshotSha256 &&
      packet.manifestSha256 === capture.manifestSha256 &&
      operational.snapshotSha256 === snapshotSha256,
    'Reviewed evidence does not match the coherent capture'
  );
  const tables = {},
    requests = [],
    eventLabels = unique(events, (e) => e.label);
  unique(events, (e) => e.eventId);
  const directory = new Map();
  const directoryFields = ['last_name', 'first_name', 'as_year', 'flight', 'squadron'];
  let marks = 0,
    percentages = 0;
  for (const [kind, name] of [
    ['directory', 'Directory'],
    ['leadership', 'Leadership'],
    ['attendance', 'Attendance']
  ]) {
    const source = tableRows(packet, capture, 'main', name),
      plan = projection.plans[kind];
    check(
      isDeepStrictEqual(plan.nextBaseline.revision, projection.revision) &&
        plan.complete &&
        !plan.retainedDrafts.length &&
        !plan.diagnostics.length,
      'Projection has unresolved edits or a stale revision'
    );
    const projected = unique(
      plan.nextBaseline.rows.filter((r) => !r.retired),
      (r) => r.key
    );
    const keys = kind === 'leadership' ? source.headers : ['email', 'last_name', 'first_name'];
    const leadership = kind === 'leadership' ? unique(projected.values(), (r) => identity(keys, r.values)) : null;
    const lookup =
      kind === 'leadership'
        ? unique(
            operational.dispositions.filter((d) => d.kind === 'leadership' && d.disposition === 'adopted'),
            (d) => identity(keys, d.record)
          )
        : kind === 'directory'
          ? unique(projected.values(), (r) => identity(keys, r.values))
          : directory;
    const fixed = kind === 'attendance' ? 7 : source.headers.length;
    if (kind === 'attendance')
      check(source.headers.length - fixed === eventLabels.size, 'Active event count differs from original Attendance');
    const expected = [
      ...source.headers.slice(0, fixed),
      ...source.headers.slice(fixed).map((label) => {
        check(eventLabels.has(label), 'Unmapped original event header');
        return 'event:' + eventLabels.get(label).eventId;
      })
    ];
    const header = kind === 'leadership' ? 'contact_id' : 'person_id';
    const modelHeaders = plan.expectedAfter.headers;
    const retired = new Set((plan.nextBaseline.retiredEventColumns ?? []).map((c) => c.header));
    check(!expected.some((h) => retired.has(h)), 'Retired event still visible on the original Attendance sheet');
    check(
      isDeepStrictEqual([...expected, header].sort(), modelHeaders.filter((h) => !retired.has(h)).sort()),
      'Original and projected Table columns differ'
    );
    const bindings = source.records.map(({ sheetRow, values }) => {
      const match = lookup.get(identity(kind === 'attendance' ? directoryFields : keys, values));
      const key = kind === 'leadership' && match ? leadership.get(identity(keys, match.record))?.key : match?.key;
      check(projected.has(key), 'A populated original row has no verified D1 identity');
      if (kind === 'directory') {
        const tuple = identity(directoryFields, values);
        check(values.email && !directory.has(tuple), 'Ambiguous Directory identity for Attendance');
        directory.set(tuple, { key });
      }
      if (kind === 'attendance') {
        const row = projected.get(key).values;
        for (const [index, label] of source.headers.slice(fixed).entries()) {
          check(
            (values[label] === '' ? null : values[label]) === (row[expected[fixed + index]] ?? null),
            'Original attendance mark differs from D1'
          );
          marks++;
        }
        for (const field of ['overall_attendance_pct', 'llab_attendance_pct']) {
          const a = values[field],
            b = row[field];
          check(
            a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9),
            'Original attendance percentage differs from D1'
          );
          percentages++;
        }
      }
      return { sheetRow, key };
    });
    check(unique(bindings, (b) => b.key).size === projected.size, 'Projected and original row sets differ');
    const keyLabel = plan.expectedAfter.labels[modelHeaders.indexOf(header)];
    requests.push(...keyRequests(source, header, keyLabel, bindings));
    if (kind === 'attendance') {
      for (let i = fixed; i < expected.length; i++) requests.push(writeColumn(source.table.range.sheetId, i, 0, [expected[i]]));
    }
    tables[kind] = { tableId: source.table.tableId, headers: [...expected, header], bindings };
  }
  const dispositions = unique(
    operational.dispositions.filter((d) => d.kind === 'excusal'),
    (d) => d.record.request_id
  );
  const seen = new Set();
  for (const name of ['Blue', 'Gold']) {
    const source = tableRows(packet, capture, 'management', name);
    const queue = projection.queuePlans[name.toLowerCase()];
    check(
      isDeepStrictEqual(queue.nextBaseline.revision, projection.revision) &&
        queue.complete &&
        !queue.retainedDrafts.length &&
        !queue.diagnostics.length,
      'Queue projection has unresolved edits or a stale revision'
    );
    const active = unique(
      queue.nextBaseline.rows.filter((r) => !r.retired),
      (r) => r.key
    );
    const bindings = source.records.map(({ sheetRow, values }) => {
      const id = values.request_id,
        d = dispositions.get(id);
      check(
        id && !seen.has(id) && d && ['retired', 'adopted'].includes(d.disposition),
        'Unreviewed or duplicate original excusal'
      );
      seen.add(id);
      if (d.disposition === 'adopted') check(active.delete(d.requestId), 'Excusal assigned to a different queue or missing');
      return { sheetRow, originalRequestId: id, disposition: d.disposition, key: d.requestId ?? null };
    });
    check(active.size === 0, 'D1 queue has requests absent from the original queue');
    tables[name.toLowerCase()] = { tableId: source.table.tableId, bindings };
  }
  const responses = {};
  for (const [key, form] of Object.entries(packet.originals.forms)) {
    const source = capture.resources.find((r) => r.kind === 'form' && r.providerId === form.formId);
    check(
      source?.coherent && Array.isArray(source.responses) && source.responsesSha256 === importDigest(source.responses),
      'Missing or inconsistent original Form response history'
    );
    const hashes = [...unique(source.responses, (r) => r.responseId)].map(([id, r]) => ({ id, hash: importDigest(r) }));
    responses[key] = hashes;
  }
  const resourceDigests = Object.fromEntries(capture.resources.map((r) => [r.key, importDigest(r)]));
  return {
    snapshotSha256,
    resourceDigests,
    revision: projection.revision,
    marks,
    percentages,
    tables,
    responses,
    mainIdentityBatch: { spreadsheetId: packet.books.main.spreadsheetId, requests }
  };
}

export function verifyOriginalResponses(packet, capture) {
  const { snapshotSha256, ...body } = capture;
  check(
    capture.consistent && importDigest(body) === snapshotSha256 && packet.manifestSha256 === capture.manifestSha256,
    'Response verification needs a coherent original capture'
  );
  for (const [key, form] of Object.entries(packet.originals.forms)) {
    const source = capture.resources.find((r) => r.kind === 'form' && r.providerId === form.formId);
    check(source?.coherent && Array.isArray(source.responses), 'Original response source missing');
    const current = unique(source.responses, (r) => r.responseId);
    for (const { id, hash } of packet.rows.responses[key]) {
      check(current.has(id) && importDigest(current.get(id)) === hash, 'An original Form response is missing or changed');
    }
  }
}

export function verifyFrozenSources(packet, capture) {
  const { snapshotSha256, ...body } = capture;
  check(
    capture.consistent && importDigest(body) === snapshotSha256 && capture.manifestSha256 === packet.manifestSha256,
    'A coherent recapture of the original resources is required'
  );
  const actual = Object.fromEntries(capture.resources.map((r) => [r.key, importDigest(r)]));
  check(
    isDeepStrictEqual(actual, packet.rows.resourceDigests),
    'Original source changed since preparation; regenerate the cutover packet'
  );
}
