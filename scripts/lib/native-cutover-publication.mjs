// Project the verified staging Tables onto original rows by stable identity.
// Each request targets one column and one contiguous run of actual differences.
import { isDeepStrictEqual as same } from 'node:util';
import { importDigest } from './import-capture.mjs';
import { excusalRowFormats } from '../../.build/v3/apps/google-adapter/src/frontend-supplemental.js';

const allowedDifferences = {
  directory: ['class_year', 'cip_code', 'photo_link', 'email'],
  leadership: [],
  attendance: ['overall_attendance_pct', 'llab_attendance_pct'],
  blue: ['timestamp', 'event', 'email'],
  gold: ['timestamp', 'event', 'email']
};
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function literal(cell, header) {
  const v = cell?.userEnteredValue,
    runs = cell?.chipRuns;
  if (runs?.length) {
    check(
      header === 'photo_link' && runs.length === 1 && (runs[0].startIndex ?? 0) === 0 && runs[0].chip?.richLinkProperties?.uri,
      'Unrecognized rich cell'
    );
    return {
      userEnteredValue: { stringValue: '@' },
      chipRuns: [{ startIndex: 0, chip: { richLinkProperties: { uri: runs[0].chip.richLinkProperties.uri } } }]
    };
  }
  return v ? { userEnteredValue: v } : {};
}
function resource(uri) {
  const url = new URL(uri);
  check(
    url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname),
    'Unverified photo link conversion'
  );
  const id = url.pathname.match(/\/d\/([\w-]+)(?:\/|$)/)?.[1] ?? url.searchParams.get('id');
  check(id, 'Photo has no stable Drive identity');
  return [id, url.searchParams.get('resourcekey')];
}
function assertReviewedChange(kind, header, cell, before, after) {
  check(allowedDifferences[kind].includes(header), 'Original business value differs outside reviewed presentation conversions');
  const a = before.userEnteredValue ?? {},
    b = after.userEnteredValue ?? {};
  check(!('formulaValue' in b), 'Unexpected formula in D1 projection');
  if (header === 'photo_link') {
    const uris = [before, after].map((c) => c.chipRuns?.[0]?.chip.richLinkProperties.uri ?? c.userEnteredValue?.stringValue);
    check(uris.every(Boolean) && same(resource(uris[0]), resource(uris[1])), 'Photo file identity or access key changed');
  } else if (['class_year', 'cip_code'].includes(header)) {
    check(
      typeof a.numberValue === 'number' &&
        typeof b.stringValue === 'string' &&
        (b.stringValue === cell.formattedValue || (b.stringValue.trim() && Number(b.stringValue) === a.numberValue)),
      'Unexplained Directory identifier conversion'
    );
  } else if (kind === 'directory' && header === 'email') {
    check(a.stringValue?.trim().toLowerCase() === b.stringValue?.trim().toLowerCase(), 'Directory mailbox differs');
  } else if (kind === 'attendance') {
    const original = cell.effectiveValue?.numberValue;
    check(
      typeof original === 'number' && typeof b.numberValue === 'number' && Math.abs(original - b.numberValue) < 1e-9,
      'Unverified attendance percentage conversion'
    );
  }
}
function runs(column, index, sheetId, fields) {
  const requests = [];
  for (let i = 0; i < column.length; ) {
    const first = i;
    while (++i < column.length && column[i].row === column[i - 1].row + 1) {}
    requests.push({
      updateCells: {
        start: { sheetId, rowIndex: column[first].row, columnIndex: index },
        fields,
        rows: column.slice(first, i).map((c) => ({ values: [c.cell] }))
      }
    });
  }
  return requests;
}
export function prepareFirstPublication(packet, capture, projection) {
  const batches = {},
    evidence = {},
    baselineTemplates = {};
  for (const [role, kinds] of Object.entries({ main: ['directory', 'leadership', 'attendance'], management: ['blue', 'gold'] })) {
    const book = capture.resources.find((r) => r.key === role);
    const requests = [];
    for (const kind of kinds) {
      const target = packet.rows.tables[kind],
        planned = (role === 'main' ? projection.plans : projection.queuePlans)[kind];
      const sheet = book.sheets.find((s) => s.metadata.tables?.some((t) => t.tableId === target.tableId));
      const { sheetId } = sheet.metadata.properties;
      const grid = planned.expectedAfter,
        keyHeader = role === 'management' ? 'request_id' : kind === 'leadership' ? 'contact_id' : 'person_id';
      const headers = target.headers ?? sheet.rows[0].map((c) => c.userEnteredValue.stringValue);
      check(
        new Set(headers).size === headers.length && headers.every((h) => grid.headers.includes(h)),
        'Unexpected original Table headers'
      );
      const model = new Map();
      for (const row of grid.rows) {
        const id = row[grid.headers.indexOf(keyHeader)]?.userEnteredValue?.stringValue;
        if (!id) {
          check(
            row.every((c) => !c.userEnteredValue),
            'Projected row missing stable identity'
          );
          continue;
        }
        check(!model.has(id), 'Duplicate native projection row');
        model.set(id, row);
      }
      let changedCells = 0;
      const expectedRows = [];
      for (const binding of target.bindings) {
        const source = sheet.rows[binding.sheetRow - 1];
        if (binding.disposition === 'retired') {
          expectedRows.push(headers.map((h, i) => literal(source[i], h)));
          continue;
        }
        const projected = model.get(binding.key);
        check(projected, 'Missing native projection row');
        expectedRows.push(headers.map((h) => literal(projected[grid.headers.indexOf(h)], h)));
      }
      // Freeze slots in original order. Only domain values and command versions
      // transferable to the accepted D1 revision are used; never staging state or credentials.
      const baseByKey = new Map(planned.nextBaseline.rows.map((r) => [r.key, r]));
      const slotKeys = Array(sheet.metadata.tables[0].range.endRowIndex - 2).fill(null);
      const rows = target.bindings.map((binding, j) => {
        const key = binding.originalRequestId ?? binding.key;
        slotKeys[binding.sheetRow - 3] = key;
        if (binding.disposition === 'retired') {
          const values = Object.fromEntries(
            headers.map((h, i) => {
              const v = expectedRows[j][i].userEnteredValue ?? {};
              check(!v.formulaValue, 'Formula in retained queue row needs review');
              return [h, v.stringValue ?? v.numberValue ?? v.boolValue ?? null];
            })
          );
          return {
            key,
            retired: true,
            retainedLegacyExcusal: true,
            values,
            versions: { decision: 0 },
            readonlyHeaders: headers,
            commandBindings: {}
          };
        }
        check(key === binding.key, 'Active request identity changed during adoption');
        const base = baseByKey.get(key);
        check(base && !base.retired, 'Original row lacks an active domain binding');
        for (const [i, h] of headers.entries()) {
          const native = expectedRows[j][i],
            v = native.userEnteredValue ?? {};
          const projectedValue = native.chipRuns
            ? { fileUri: native.chipRuns[0].chip.richLinkProperties.uri }
            : (v.stringValue ?? v.numberValue ?? v.boolValue ?? null);
          const baseline = base.values[h];
          check(same(projectedValue, baseline === '' ? null : baseline), 'Native projection differs from its keyed baseline');
        }
        const result = { ...base };
        for (const field of ['values', 'versions', 'eventVersions', 'commandBindings'])
          if (base[field]) result[field] = Object.fromEntries(Object.entries(base[field]).filter(([h]) => headers.includes(h)));
        result.readonlyHeaders = (base.readonlyHeaders ?? []).filter((h) => headers.includes(h));
        return result;
      });
      baselineTemplates[kind] = { revision: projection.revision, rows, slots: { headers, keys: slotKeys } };
      for (const [i, header] of headers.entries()) {
        const column = [];
        for (const [j, binding] of target.bindings.entries()) {
          if (binding.disposition === 'retired' || header === keyHeader) continue;
          const row = binding.sheetRow - 1,
            cell = sheet.rows[row][i] ?? {};
          const before = literal(cell, header),
            after = expectedRows[j][i];
          if (same(before, after)) continue;
          assertReviewedChange(kind, header, cell, before, after);
          column.push({ row, cell: after });
        }
        requests.push(...runs(column, i, sheetId, header === 'photo_link' ? 'userEnteredValue,chipRuns' : 'userEnteredValue'));
        changedCells += column.length;
      }
      if (role === 'management') {
        const active = target.bindings.filter((b) => b.disposition === 'adopted');
        for (let i = 0; i < active.length; ) {
          const start = i++;
          while (i < active.length && active[i].sheetRow === active[i - 1].sheetRow + 1) i++;
          requests.push(...excusalRowFormats(sheetId, active[start].sheetRow - 1, active[i - 1].sheetRow, headers));
        }
      }
      // Verify values by original physical position, including retired queue rows.
      evidence[kind] = {
        sheetId,
        tableId: target.tableId,
        headers,
        positions: target.bindings.map((b) => b.sheetRow),
        bodyHash: importDigest(expectedRows),
        changedCells
      };
    }
    batches[role] = { spreadsheetId: book.providerId, requests };
  }
  return { batches, evidence, baselineTemplates };
}
export function verifyPublishedTables(packet, capture) {
  const { snapshotSha256, ...body } = capture;
  check(
    capture.consistent && snapshotSha256 === importDigest(body) && capture.manifestSha256 === packet.manifestSha256,
    'Expected coherent original workbook capture'
  );
  for (const [kind, e] of Object.entries(packet.publication.evidence)) {
    const role = ['blue', 'gold'].includes(kind) ? 'management' : 'main';
    const book = capture.resources.find((r) => r.key === role && r.providerId === packet.books[role].spreadsheetId);
    const sheet = book?.sheets.find((s) => s.metadata.properties.sheetId === e.sheetId);
    const table = sheet?.metadata.tables?.find((t) => t.tableId === e.tableId);
    check(table && table.range.endColumnIndex === e.headers.length, 'Adopted native Table extent differs');
    check(
      same(
        e.headers,
        sheet.rows[0].slice(0, e.headers.length).map((c) => c?.userEnteredValue?.stringValue)
      ),
      'Adopted machine headers differ'
    );
    const positions = new Set(e.positions);
    check(
      sheet.rows.slice(2).every((r, i) => positions.has(i + 3) || r.every((c) => !c.userEnteredValue && !c.chipRuns?.length)),
      'Unexpected original Table row after adoption'
    );
    const actual = e.positions.map((n) => {
      check(n <= table.range.endRowIndex, 'Adopted row lies outside Table');
      return e.headers.map((h, i) => literal(sheet.rows[n - 1]?.[i], h));
    });
    check(importDigest(actual) === e.bodyHash, 'Published data differs at original Table positions');
  }
}
