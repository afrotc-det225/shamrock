/** Strict native protection plans for the replacement frontend. Pure: no Google IO.
 * Sheet ownership and runtime authority remain separate from operational edit grants.
 * Apply every request in one atomic spreadsheets.batchUpdate, then verify fresh metadata.
 */
import { AdapterError } from './index.js';

export type FrontendSurfaceKind = 'directory' | 'leadership' | 'attendance' | 'excusal' | 'readonly';
export interface FrontendProtectionSurface {
  kind: FrontendSurfaceKind;
  sheetId: number;
  headers: readonly string[];
  /** One-based final occupied row, including machine/display header rows. */
  dataEndRow: number;
  gridRowCount: number;
  gridColumnCount: number;
  /** Trusted stable scope, never inferred from a mutable sheet title. */
  squadronId?: string;
  /** Explicit catalog mapping. Unknown columns are never assumed to be events. */
  eventColumns?: readonly { header: string; eventId: string }[];
  decisionHeader?: 'decision' | 'draft_decision';
}
export interface FrontendProtectionAccess {
  ownerEmail: string;
  automationEmail: string;
  /** Global operational support: business input only, not IDs, headers or outputs. */
  supportEditors: readonly string[];
  directoryEditors: readonly string[];
  leadershipEditors: readonly string[];
  attendanceEditors: readonly string[];
  squadronCommanders: readonly { squadronId: string; email: string }[];
}
export interface FrontendProtectionInput {
  surfaces: readonly FrontendProtectionSurface[];
  access: FrontendProtectionAccess;
  /** Full sheets/protectedRanges metadata for this workbook, read as automation/owner. */
  metadata: { sheets?: Record<string, any>[] };
  /** Explicit one-time adoption of reviewed old preview protections. Never wildcard. */
  adoptProtectionIds?: readonly number[];
}
export interface FrontendGridRange {
  sheetId: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}
export interface FrontendProtectionRequirement {
  description: string;
  range: FrontendGridRange;
  warningOnly: false;
  editors: { users: string[]; groups: []; domainUsersCanEdit: false };
  unprotectedRanges: FrontendGridRange[];
}
export interface FrontendProtectionPlan {
  requests: Record<string, any>[];
  requirements: FrontendProtectionRequirement[];
}

export const FRONTEND_PROTECTION_PREFIX = 'SHAMROCK_FRONTEND_V1:';
export const DIRECTORY_EDIT_FIELDS = [
  'as_year', 'rank', 'role', 'flight', 'squadron', 'university', 'phone', 'dorm',
  'cip_broad_area', 'cip_code', 'desired_assigned_afsc', 'home_town', 'home_state',
  'class_year', 'dob', 'flight_path_status',
] as const;
export const LEADERSHIP_EDIT_FIELDS = [
  'last_name', 'first_name', 'rank', 'role', 'reports_to', 'email', 'cell_phone',
  'office_phone', 'office_location',
] as const;
const RESERVED = new Set<string>([
  ...DIRECTORY_EDIT_FIELDS, ...LEADERSHIP_EDIT_FIELDS, 'photo_link',
  'overall_attendance_pct', 'llab_attendance_pct', 'decision', 'draft_decision',
  'recorded_status', 'requested_outcome', 'approved_outcome', 'draft_state',
  'event_label', 'unit_label', 'flight_label', 'squadron_label', 'display_name',
]);
const RANGE_KEYS = ['sheetId', 'startRowIndex', 'endRowIndex', 'startColumnIndex', 'endColumnIndex'];
const MAX_SURFACES = 40;
const MAX_ROWS = 10002;
const MAX_COLUMNS = 500;
const MAX_REQUESTS = 1000;
function fail(message: string): never { throw new AdapterError('invalid_frontend_protection', message); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function email(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value.trim()) || value.length > 254) {
    fail('Every protection editor must have an explicit valid email address.');
  }
  return value.trim().toLowerCase();
}
function emails(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 500) fail('The protection editor list is missing or exceeds its bound.');
  return [...new Set(values.map(email))].sort();
}
function stableId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}
function machineField(header: string): boolean {
  return /(^_|_id$|_ids$|_version$|^version$|^generation$|^projection_|^slot_|^draft_|_hash$|_json$|_revision$)/.test(header);
}
function normalizedAccess(access: FrontendProtectionAccess): FrontendProtectionAccess {
  if (!access || !Array.isArray(access.squadronCommanders) || access.squadronCommanders.length > 100) fail('An explicit protection access policy is required.');
  const assignments = access.squadronCommanders.map(value => {
    if (!stableId(value.squadronId)) fail('Squadron grants require stable scope identifiers.');
    return { squadronId: value.squadronId, email: email(value.email) };
  });
  if (new Set(assignments.map(value => value.squadronId)).size !== assignments.length) fail('A squadron commander assignment is ambiguous.');
  return { ownerEmail: email(access.ownerEmail), automationEmail: email(access.automationEmail),
    supportEditors: emails(access.supportEditors), directoryEditors: emails(access.directoryEditors),
    leadershipEditors: emails(access.leadershipEditors), attendanceEditors: emails(access.attendanceEditors), squadronCommanders: assignments };
}
function validate(input: FrontendProtectionInput): FrontendProtectionAccess {
  const access = normalizedAccess(input.access);
  if (!Array.isArray(input.surfaces) || !input.surfaces.length || input.surfaces.length > MAX_SURFACES) fail('The frontend sheet inventory is missing or exceeds its bound.');
  if (!Array.isArray(input.metadata?.sheets) || input.metadata.sheets.length !== input.surfaces.length) fail('Every workbook sheet must have an explicit protection policy.');
  if (new Set(input.surfaces.map(s => s.sheetId)).size !== input.surfaces.length) fail('Protection sheet bindings must be unique.');
  const allProtectionIds = new Set<number>();
  for (const surface of input.surfaces) {
    if (!['directory', 'leadership', 'attendance', 'excusal', 'readonly'].includes(surface.kind)
      || !integer(surface.sheetId, 0, 2147483647) || !integer(surface.gridRowCount, 2, MAX_ROWS)
      || !integer(surface.gridColumnCount, 1, MAX_COLUMNS) || !integer(surface.dataEndRow, 2, surface.gridRowCount)
      || !Array.isArray(surface.headers) || surface.headers.length > surface.gridColumnCount
      || (surface.kind !== 'readonly' && !surface.headers.length)
      || surface.headers.some((h: string) => typeof h !== 'string' || !h || h.trim() !== h || h.length > 200)
      || new Set(surface.headers).size !== surface.headers.length) fail('A frontend protection surface has invalid or ambiguous bounds or headers.');
    const sheets = input.metadata.sheets.filter(s => s.properties?.sheetId === surface.sheetId);
    if (sheets.length !== 1 || sheets[0].properties.gridProperties?.rowCount !== surface.gridRowCount
      || sheets[0].properties.gridProperties?.columnCount !== surface.gridColumnCount) fail('The protection sheet inventory differs from fresh provider metadata.');
    const protections = sheets[0].protectedRanges ?? [];
    if (!Array.isArray(protections)) fail('Provider protection metadata is invalid.');
    for (const protection of protections) {
      if (!integer(protection.protectedRangeId, 0, 2147483647) || allProtectionIds.has(protection.protectedRangeId)) fail('Provider protection identifiers are missing or duplicated.');
      allProtectionIds.add(protection.protectedRangeId);
    }
    if (surface.kind === 'excusal') {
      if (!stableId(surface.squadronId)) fail('Excusal protections require an explicit stable squadron.');
      const header = surface.decisionHeader ?? 'decision';
      if (!['decision', 'draft_decision'].includes(header) || !surface.headers.includes(header)) fail('The excusal decision column is missing.');
    }
    if (surface.kind === 'attendance') {
      if (!Array.isArray(surface.eventColumns) || surface.eventColumns.length > MAX_COLUMNS) fail('Attendance protections require an explicit event catalog mapping.');
      if (new Set(surface.eventColumns.map((e: { header: string; eventId: string }) => e.header)).size !== surface.eventColumns.length
        || new Set(surface.eventColumns.map((e: { header: string; eventId: string }) => e.eventId)).size !== surface.eventColumns.length) fail('Attendance event column identity is ambiguous.');
      for (const event of surface.eventColumns) {
        if (!stableId(event.eventId) || !surface.headers.includes(event.header) || RESERVED.has(event.header)
          || machineField(event.header)) fail('Attendance event mapping targets a missing or protected field.');
      }
    } else if (surface.eventColumns?.length) fail('Only an attendance surface may declare event columns.');
  }
  const adopt = input.adoptProtectionIds ?? [];
  if (!Array.isArray(adopt) || new Set(adopt).size !== adopt.length || adopt.some(id => !allProtectionIds.has(id))) fail('Protection adoption must name existing reviewed protection identifiers.');
  return access;
}
function permittedColumns(surface: FrontendProtectionSurface, access: FrontendProtectionAccess): { column: number; users: string[] }[] {
  let fields: readonly string[] = []; let operational: readonly string[] = [];
  if (surface.kind === 'directory') { fields = DIRECTORY_EDIT_FIELDS; operational = access.directoryEditors; }
  if (surface.kind === 'leadership') { fields = LEADERSHIP_EDIT_FIELDS; operational = access.leadershipEditors; }
  if (surface.kind === 'attendance') { fields = surface.eventColumns!.map(e => e.header); operational = access.attendanceEditors; }
  if (surface.kind === 'excusal') {
    fields = [surface.decisionHeader ?? 'decision'];
    operational = access.squadronCommanders.filter(value => value.squadronId === surface.squadronId).map(value => value.email);
  }
  if (surface.kind === 'readonly' || surface.dataEndRow === 2) return [];
  const users = emails([...operational, ...access.supportEditors]);
  if (!users.length) return [];
  return surface.headers.flatMap((header, column) => fields.includes(header) ? [{ column, users }] : []);
}
function desired(input: FrontendProtectionInput, access: FrontendProtectionAccess): FrontendProtectionRequirement[] {
  const requirements: FrontendProtectionRequirement[] = [];
  const runtime = emails([access.ownerEmail, access.automationEmail]);
  for (const surface of input.surfaces) {
    const blocks: { first: number; last: number; users: string[] }[] = [];
    for (const entry of permittedColumns(surface, access)) {
      const previous = blocks.at(-1);
      if (previous && previous.last + 1 === entry.column && JSON.stringify(previous.users) === JSON.stringify(entry.users)) previous.last = entry.column;
      else blocks.push({ first: entry.column, last: entry.column, users: entry.users });
    }
    const ranges = blocks.map(block => ({ sheetId: surface.sheetId, startRowIndex: 2, endRowIndex: surface.dataEndRow,
      startColumnIndex: block.first, endColumnIndex: block.last + 1 }));
    requirements.push({ description: `${FRONTEND_PROTECTION_PREFIX}${surface.sheetId}:sheet`, range: { sheetId: surface.sheetId },
      warningOnly: false, editors: { users: runtime, groups: [], domainUsersCanEdit: false }, unprotectedRanges: ranges });
    blocks.forEach((block, index) => requirements.push({ description: `${FRONTEND_PROTECTION_PREFIX}${surface.sheetId}:input:${block.first}-${block.last}`,
      range: ranges[index], warningOnly: false,
      editors: { users: emails([...runtime, ...block.users]), groups: [], domainUsersCanEdit: false }, unprotectedRanges: [] }));
  }
  return requirements;
}
function rangeKey(value: any): string | null {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !RANGE_KEYS.includes(key))) return null;
  if (!integer(value.sheetId, 0, 2147483647)) return null;
  const normalized: Record<string, number> = { sheetId: value.sheetId };
  for (const key of RANGE_KEYS.slice(1)) {
    if (value[key] === undefined) continue;
    if (!integer(value[key], 0, 2147483647)) return null;
    if (key.startsWith('start') && value[key] === 0) continue;
    normalized[key] = value[key];
  }
  return JSON.stringify(normalized);
}
function matches(actual: Record<string, any>, expected: FrontendProtectionRequirement, owner: string): boolean {
  if (actual.description !== expected.description || ![undefined, false].includes(actual.warningOnly) || actual.namedRangeId || actual.tableId
    || actual.requestingUserCanEdit === false || rangeKey(actual.range) !== rangeKey(expected.range)
    || !actual.editors || ![undefined, false].includes(actual.editors.domainUsersCanEdit)
    || !Array.isArray(actual.editors.groups ?? []) || (actual.editors.groups ?? []).length) return false;
  let users: string[];
  try { users = emails([...(actual.editors.users ?? []), owner]); } catch { return false; }
  if (JSON.stringify(users) !== JSON.stringify(expected.editors.users)) return false;
  const holes = actual.unprotectedRanges ?? [];
  if (!Array.isArray(holes)) return false;
  const keys = holes.map(rangeKey);
  return !keys.includes(null) && JSON.stringify(keys.sort()) === JSON.stringify(expected.unprotectedRanges.map(rangeKey).sort());
}

/** Unknown protections are left untouched unless their exact IDs were explicitly adopted. */
export function planFrontendProtections(input: FrontendProtectionInput): FrontendProtectionPlan {
  const access = validate(input); const requirements = desired(input, access);
  const actual = input.metadata.sheets!.flatMap(sheet => sheet.protectedRanges ?? []);
  const managed = actual.filter(p => String(p.description ?? '').startsWith(FRONTEND_PROTECTION_PREFIX));
  const adopted = new Set(input.adoptProtectionIds ?? []);
  if (actual.some(p => !managed.includes(p) && !adopted.has(p.protectedRangeId))) fail('Unmanaged protections require explicit review before frontend adoption.');
  if (new Set(managed.map(p => p.description)).size !== managed.length) fail('Managed protection descriptions are duplicated.');
  const requests: Record<string, any>[] = [];
  const retained = new Set<number>();
  for (const requirement of requirements) {
    let existing = managed.find(p => p.description === requirement.description);
    // Google permits only one whole-sheet protection. Adopt the reviewed guard
    // in place instead of adding a second guard before deleting the old one.
    if (!existing && requirement.description.endsWith(':sheet')) {
      const candidates = actual.filter(p => adopted.has(p.protectedRangeId) && rangeKey(p.range) === rangeKey(requirement.range));
      if (candidates.length > 1) fail('Whole-sheet protection adoption is ambiguous.');
      existing = candidates[0];
    }
    if (existing) retained.add(existing.protectedRangeId);
    if (!existing) requests.push({ addProtectedRange: { protectedRange: requirement } });
    else if (!matches(existing, requirement, access.ownerEmail)) {
      // Explicit editor mask is essential: changing warningOnly alone can grant every workbook editor.
      requests.push({ updateProtectedRange: { protectedRange: { ...requirement, protectedRangeId: existing.protectedRangeId },
        fields: 'description,range,warningOnly,editors,unprotectedRanges,namedRangeId,tableId' } });
    }
  }
  for (const protection of actual) if (!retained.has(protection.protectedRangeId)) {
    requests.push({ deleteProtectedRange: { protectedRangeId: protection.protectedRangeId } });
  }
  if (requests.length > MAX_REQUESTS) fail('Protection repair exceeds one bounded atomic batch; retain the closed workbook and review its scope.');
  return { requests, requirements };
}

/** Fresh metadata must prove every intended grant and no additional editable hole. */
export function verifyFrontendProtections(input: FrontendProtectionInput): { ready: boolean; issues: string[] } {
  const access = validate(input); const requirements = desired(input, access); const issues: string[] = [];
  for (const surface of input.surfaces) {
    const actual = input.metadata.sheets!.find(s => s.properties.sheetId === surface.sheetId)!.protectedRanges ?? [];
    const expected = requirements.filter(p => p.range.sheetId === surface.sheetId);
    if (actual.length !== expected.length) issues.push(`${surface.sheetId}:protection-count`);
    for (const requirement of expected) {
      const found = actual.filter((p: any) => p.description === requirement.description);
      if (found.length !== 1 || !matches(found[0], requirement, access.ownerEmail)) issues.push(requirement.description);
    }
  }
  return { ready: issues.length === 0, issues };
}

/** Expected policy model, not a replacement for provider verification or Worker authorization.
 * workbookEditor is explicit because a range grant never confers Drive file access.
 */
export function canEditFrontendCell(input: FrontendProtectionInput, actor: {
  email: string; workbookEditor: boolean; sheetId: number; rowIndex: number; columnIndex: number;
}): boolean {
  const access = validate(input); const principal = email(actor.email);
  const surface = input.surfaces.find(s => s.sheetId === actor.sheetId);
  if (!surface || !integer(actor.rowIndex, 0, surface.gridRowCount - 1) || !integer(actor.columnIndex, 0, surface.gridColumnCount - 1)) return false;
  if (principal === access.ownerEmail) return true; // Google ownership cannot be removed by a cell protection.
  if (!actor.workbookEditor) return false;
  if (principal === access.automationEmail) return true;
  if (actor.rowIndex < 2 || actor.rowIndex >= surface.dataEndRow) return false;
  return permittedColumns(surface, access).some(entry => entry.column === actor.columnIndex && entry.users.includes(principal));
}
