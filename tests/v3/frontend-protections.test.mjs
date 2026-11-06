import test from 'node:test';
import assert from 'node:assert/strict';
import { planFrontendProtections, verifyFrontendProtections, canEditFrontendCell,
  DIRECTORY_EDIT_FIELDS, LEADERSHIP_EDIT_FIELDS, FRONTEND_PROTECTION_PREFIX,
} from '../../.build/v3/apps/google-adapter/src/frontend-protections.js';

const invalid = error => error.code === 'invalid_frontend_protection';
const copy = value => structuredClone(value);
const people = { owner: 'owner@example.test', runtime: 'runtime@example.test', support: 'support@example.test',
  directory: 'directory@example.test', leadership: 'leadership@example.test', attendance: 'attendance@example.test',
  blue: 'blue@example.test', gold: 'gold@example.test', wing: 'wing@example.test', outsider: 'outsider@example.test' };
function fixture() {
  const surfaces = [
    { kind: 'directory', sheetId: 101, headers: ['person_id', 'last_name', 'first_name', ...DIRECTORY_EDIT_FIELDS, 'email', 'photo_link', 'profile_version'] },
    { kind: 'leadership', sheetId: 102, headers: ['assignment_id', ...LEADERSHIP_EDIT_FIELDS, 'role_version'] },
    { kind: 'attendance', sheetId: 103, headers: ['person_id', 'last_name', 'first_name', 'overall_attendance_pct', 'llab_attendance_pct', 'event:llab', 'event:pt', 'projection_revision'],
      eventColumns: [{ header: 'event:llab', eventId: 'event-llab' }, { header: 'event:pt', eventId: 'event-pt' }] },
    ...['blue', 'gold'].map((squadronId, index) => ({ kind: 'excusal', sheetId: 104 + index, squadronId,
      headers: ['request_id', 'display_name', 'decision', 'base_version', 'draft_state'] })),
    { kind: 'readonly', sheetId: 106, headers: ['summary'] },
    { kind: 'readonly', sheetId: 107, headers: ['legend'] },
  ].map(surface => ({ ...surface, dataEndRow: 8, gridRowCount: 30, gridColumnCount: 30 }));
  return { surfaces, access: { ownerEmail: people.owner, automationEmail: people.runtime,
    supportEditors: [people.support], directoryEditors: [people.directory], leadershipEditors: [people.leadership],
    attendanceEditors: [people.attendance], squadronCommanders: ['blue', 'gold'].map(squadronId => ({ squadronId, email: people[squadronId] })) },
  metadata: { sheets: surfaces.map(surface => ({ properties: { sheetId: surface.sheetId,
    gridProperties: { rowCount: surface.gridRowCount, columnCount: surface.gridColumnCount } }, protectedRanges: [] })) } };
}
function apply(input, requests) {
  let nextId = Math.max(0, ...input.metadata.sheets.flatMap(s => s.protectedRanges.map(p => p.protectedRangeId))) + 1;
  for (const request of requests) {
    if (request.addProtectedRange) {
      const p = copy(request.addProtectedRange.protectedRange); p.protectedRangeId = nextId++;
      const existing = input.metadata.sheets.find(s => s.properties.sheetId === p.range.sheetId).protectedRanges;
      if (Object.keys(p.range).length === 1) assert.equal(existing.some(e => Object.keys(e.range).length === 1), false, 'Google permits only one whole-sheet protection');
      existing.push(p);
    } else if (request.updateProtectedRange) {
      const { protectedRange: p, fields } = request.updateProtectedRange;
      const current = input.metadata.sheets.flatMap(s => s.protectedRanges).find(value => value.protectedRangeId === p.protectedRangeId);
      assert.ok(current);
      for (const key of fields.split(',')) { if (p[key] === undefined) delete current[key]; else current[key] = copy(p[key]); }
    } else if (request.deleteProtectedRange) {
      for (const sheet of input.metadata.sheets) sheet.protectedRanges = sheet.protectedRanges.filter(p => p.protectedRangeId !== request.deleteProtectedRange.protectedRangeId);
    } else assert.fail('The protection planner must never write cells or mutate sharing.');
  }
}
function inside(range, sheetId, rowIndex, columnIndex) {
  return range.sheetId === sheetId && rowIndex >= (range.startRowIndex ?? 0) && rowIndex < (range.endRowIndex ?? Infinity)
    && columnIndex >= (range.startColumnIndex ?? 0) && columnIndex < (range.endColumnIndex ?? Infinity);
}
/** Independently evaluate emitted strict native protections, including holes and file access. */
function nativeAllows(input, actor) {
  if (actor.email === people.owner) return true;
  if (!actor.workbookEditor) return false;
  const protections = input.metadata.sheets.find(s => s.properties.sheetId === actor.sheetId).protectedRanges;
  return protections.filter(p => !p.warningOnly && inside(p.range, actor.sheetId, actor.rowIndex, actor.columnIndex)
    && !(p.unprotectedRanges ?? []).some(h => inside(h, actor.sheetId, actor.rowIndex, actor.columnIndex)))
    .every(p => (p.editors.users ?? []).includes(actor.email));
}
function actor(input, kind, header, email, rowIndex = 2) {
  const surface = input.surfaces.find(s => s.kind === kind);
  return { email, workbookEditor: true, sheetId: surface.sheetId, rowIndex, columnIndex: surface.headers.indexOf(header) };
}

test('every cell matches the exact policy for all operational roles and an unrelated workbook editor', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  assert.deepEqual(verifyFrontendProtections(input), { ready: true, issues: [] });
  for (const email of Object.values(people)) for (const surface of input.surfaces) {
    for (const rowIndex of [0, 1, 2, 7, 8, 29]) for (let columnIndex = 0; columnIndex < 30; columnIndex++) {
      const a = { email, workbookEditor: true, sheetId: surface.sheetId, rowIndex, columnIndex };
      assert.equal(nativeAllows(input, a), canEditFrontendCell(input, a), `${email} sheet ${surface.sheetId} row ${rowIndex} column ${columnIndex}`);
    }
  }
});

test('Directory grants only the sixteen propagated fields; identity, photo, contact email and versions stay closed', () => {
  const input = fixture();
  for (const header of DIRECTORY_EDIT_FIELDS) assert.equal(canEditFrontendCell(input, actor(input, 'directory', header, people.directory)), true);
  for (const header of ['person_id', 'last_name', 'first_name', 'email', 'photo_link', 'profile_version']) {
    assert.equal(canEditFrontendCell(input, actor(input, 'directory', header, people.directory)), false);
    assert.equal(canEditFrontendCell(input, actor(input, 'directory', header, people.support)), false);
  }
  assert.equal(canEditFrontendCell(input, actor(input, 'directory', 'phone', people.attendance)), false);
});

test('Leadership retains business edits without making headers or assignment identity editable', () => {
  const input = fixture();
  for (const header of LEADERSHIP_EDIT_FIELDS) assert.equal(canEditFrontendCell(input, actor(input, 'leadership', header, people.leadership)), true);
  for (const header of ['assignment_id', 'role_version']) assert.equal(canEditFrontendCell(input, actor(input, 'leadership', header, people.support)), false);
  assert.equal(canEditFrontendCell(input, actor(input, 'leadership', 'role', people.leadership, 1)), false);
});

test('Attendance event corrections exclude generated percentages, identity, headers, spare rows and unknown columns', () => {
  const input = fixture();
  for (const header of ['event:llab', 'event:pt']) assert.equal(canEditFrontendCell(input, actor(input, 'attendance', header, people.attendance)), true);
  for (const header of ['person_id', 'last_name', 'overall_attendance_pct', 'llab_attendance_pct', 'projection_revision']) {
    assert.equal(canEditFrontendCell(input, actor(input, 'attendance', header, people.support)), false);
  }
  assert.equal(canEditFrontendCell(input, actor(input, 'attendance', 'event:pt', people.attendance, 8)), false);
  assert.equal(canEditFrontendCell(input, { ...actor(input, 'attendance', 'event:pt', people.attendance), columnIndex: 29 }), false);
});

test('a squadron commander can edit only their own Decision; wing access alone grants no decisions', () => {
  const input = fixture();
  for (const surface of input.surfaces.filter(s => s.kind === 'excusal')) for (const email of [people.blue, people.gold, people.wing, people.support]) {
    for (let columnIndex = 0; columnIndex < surface.headers.length; columnIndex++) {
      const allowed = columnIndex === 2 && (email === people[surface.squadronId] || email === people.support);
      assert.equal(canEditFrontendCell(input, { email, workbookEditor: true, sheetId: surface.sheetId, rowIndex: 2, columnIndex }), allowed);
    }
  }
  input.surfaces[3].decisionHeader = 'draft_decision'; input.surfaces[3].headers[2] = 'draft_decision';
  assert.equal(canEditFrontendCell(input, { email: people.blue, workbookEditor: true, sheetId: 104, rowIndex: 2, columnIndex: 2 }), true);
});

test('file viewers cannot gain access from a range grant; ownership bypass is explicit', () => {
  const input = fixture();
  assert.equal(canEditFrontendCell(input, { ...actor(input, 'directory', 'phone', people.directory), workbookEditor: false }), false);
  assert.equal(canEditFrontendCell(input, { ...actor(input, 'directory', 'person_id', people.owner), workbookEditor: false }), true);
  assert.equal(canEditFrontendCell(input, actor(input, 'directory', 'person_id', people.runtime)), true);
});

test('second repair is a no-op and role turnover removes old grants with stable native IDs', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  assert.equal(planFrontendProtections(input).requests.length, 0);
  const old = copy(input.metadata);
  input.access.squadronCommanders[0].email = 'replacement@example.test';
  input.access.supportEditors = [];
  assert.equal(verifyFrontendProtections(input).ready, false);
  const plan = planFrontendProtections(input);
  assert.ok(plan.requests.length > 0);
  assert.ok(plan.requests.every(r => r.updateProtectedRange));
  assert.ok(plan.requests.every(r => r.updateProtectedRange.fields.includes('editors')));
  apply(input, plan.requests); assert.equal(verifyFrontendProtections(input).ready, true);
  assert.deepEqual(input.metadata.sheets.map(s => s.protectedRanges.map(p => p.protectedRangeId)), old.sheets.map(s => s.protectedRanges.map(p => p.protectedRangeId)));
  assert.equal(nativeAllows(input, { email: people.blue, workbookEditor: true, sheetId: 104, rowIndex: 2, columnIndex: 2 }), false);
  assert.equal(nativeAllows(input, { email: 'replacement@example.test', workbookEditor: true, sheetId: 104, rowIndex: 2, columnIndex: 2 }), true);
});

test('repair detects broad holes, wildcard access, warning-only and unapproved editors', () => {
  const clean = fixture(); apply(clean, planFrontendProtections(clean).requests);
  for (const tamper of [
    p => { p.warningOnly = true; }, p => { p.editors.domainUsersCanEdit = true; },
    p => { p.editors.users.push(people.outsider); }, p => { p.editors.groups = ['all@example.test']; },
    p => { p.unprotectedRanges.push({ sheetId: 101 }); }, p => { delete p.editors; },
    p => { p.range.endRowIndex = 8; }, p => { p.namedRangeId = 'unexpected'; },
  ]) {
    const input = copy(clean); tamper(input.metadata.sheets[0].protectedRanges[0]);
    assert.equal(verifyFrontendProtections(input).ready, false);
    apply(input, planFrontendProtections(input).requests); assert.equal(verifyFrontendProtections(input).ready, true);
  }
});

test('protected ranges must cover holes: deleting one input restriction is detected and repaired', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  input.metadata.sheets[0].protectedRanges.splice(1, 1);
  assert.equal(verifyFrontendProtections(input).ready, false);
  apply(input, planFrontendProtections(input).requests);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'phone', people.outsider)), false);
});

test('exact adoption replaces reviewed preview protections; unrelated rules are never silently removed', () => {
  const input = fixture(); input.metadata.sheets[0].protectedRanges.push({ protectedRangeId: 77, description: 'old preview', range: { sheetId: 101 } });
  input.metadata.sheets[0].protectedRanges.push({ protectedRangeId: 78, description: 'old extra field', range: { sheetId: 101, startRowIndex: 0, endRowIndex: 2 } });
  assert.throws(() => planFrontendProtections(input), invalid);
  input.adoptProtectionIds = [77, 78]; const plan = planFrontendProtections(input);
  assert.ok(plan.requests.at(-1).deleteProtectedRange);
  assert.equal(plan.requests.at(-1).deleteProtectedRange.protectedRangeId, 78);
  assert.equal(plan.requests[0].updateProtectedRange.protectedRange.protectedRangeId, 77);
  apply(input, plan.requests); delete input.adoptProtectionIds;
  assert.equal(verifyFrontendProtections(input).ready, true);
  assert.equal(input.metadata.sheets[0].protectedRanges[0].protectedRangeId, 77);
});

test('empty surfaces and removing all role grants close inputs; growth opens only newly occupied rows', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  input.surfaces[0].dataEndRow = 2;
  input.access.supportEditors = []; input.access.attendanceEditors = [];
  apply(input, planFrontendProtections(input).requests);
  assert.equal(verifyFrontendProtections(input).ready, true);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'phone', people.directory)), false);
  assert.equal(nativeAllows(input, actor(input, 'attendance', 'event:pt', people.attendance)), false);
  input.surfaces[0].dataEndRow = 10;
  apply(input, planFrontendProtections(input).requests);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'phone', people.directory, 9)), true);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'phone', people.directory, 10)), false);
});

test('reordered columns preserve field-level scope and do not leak grants by old position', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  for (const s of input.surfaces) s.headers.reverse();
  apply(input, planFrontendProtections(input).requests);
  assert.equal(verifyFrontendProtections(input).ready, true);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'phone', people.directory)), true);
  assert.equal(nativeAllows(input, actor(input, 'directory', 'person_id', people.directory)), false);
});

test('provider omission of implicit owner and empty defaults still verifies without needless repair', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  for (const sheet of input.metadata.sheets) for (const p of sheet.protectedRanges) {
    p.editors.users = p.editors.users.filter(e => e !== people.owner); delete p.editors.groups; delete p.editors.domainUsersCanEdit;
    delete p.warningOnly; if (!p.unprotectedRanges.length) delete p.unprotectedRanges;
  }
  assert.equal(verifyFrontendProtections(input).ready, true); assert.deepEqual(planFrontendProtections(input).requests, []);
});

test('ambiguous or incomplete inventory and attempted metadata event grants fail closed', () => {
  for (const tamper of [
    i => { i.surfaces.pop(); }, i => { i.surfaces[0].headers.push('person_id'); },
    i => { i.surfaces[0].dataEndRow = 31; }, i => { i.surfaces[0].gridRowCount = 31; },
    i => { i.access.squadronCommanders.push({ squadronId: 'blue', email: people.gold }); },
    i => { i.access.supportEditors.push('not an email'); }, i => { i.adoptProtectionIds = [900]; },
    i => { i.surfaces[2].eventColumns = [{ header: 'person_id', eventId: 'fake' }]; },
    i => { i.surfaces[2].eventColumns = [{ header: 'overall_attendance_pct', eventId: 'fake' }]; },
    i => { i.surfaces[2].eventColumns.push({ header: 'event:llab', eventId: 'fake' }); },
    i => { i.surfaces[3].squadronId = ''; },
  ]) { const input = fixture(); tamper(input); assert.throws(() => planFrontendProtections(input), invalid); }
});

test('managed duplicate identities are rejected instead of selecting an arbitrary rule', () => {
  const input = fixture(); apply(input, planFrontendProtections(input).requests);
  const p = copy(input.metadata.sheets[0].protectedRanges[0]); p.protectedRangeId = 999;
  assert.ok(p.description.startsWith(FRONTEND_PROTECTION_PREFIX)); input.metadata.sheets[0].protectedRanges.push(p);
  assert.throws(() => planFrontendProtections(input), invalid);
});
