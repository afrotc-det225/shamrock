import { AdapterError } from './index.js';
import type { SnapshotRevision } from '../../../packages/domain/src/admin.js';
import { verifyFrontendProtections, type FrontendProtectionAccess } from './frontend-protections.js';

/** A short-lived owner-private request to publish two reviewed effects with every human input closed. */
export interface ClosedPublicationWindow {
  version: 1;
  frontendEffectId: string;
  formsEffectId: string;
  revision: SnapshotRevision;
  expiresAt: string;
}

function reject(message: string): never { throw new AdapterError('closed_publication', message); }

export function assertClosedPublicationWindow(input: unknown, nowSeconds: number): asserts input is ClosedPublicationWindow {
  const w = input as ClosedPublicationWindow;
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
  if (!w || Object.keys(w).sort().join(',') !== 'expiresAt,formsEffectId,frontendEffectId,revision,version'
    || w.version !== 1 || !id(w.frontendEffectId) || !id(w.formsEffectId) || w.frontendEffectId === w.formsEffectId
    || !w.revision || Object.keys(w.revision).sort().join(',') !== 'administration,operations'
    || !Object.values(w.revision).every(n => Number.isSafeInteger(n) && n >= 0)
    || typeof w.expiresAt !== 'string' || !Number.isSafeInteger(nowSeconds)) reject('Use two exact effects, a revision and an expiry for private publication.');
  const expires = Date.parse(w.expiresAt), now = nowSeconds * 1000;
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== w.expiresAt || expires <= now || expires > now + 60 * 60 * 1000)
    reject('The closed publication window must expire within the next hour.');
}

/** Check default and published Drive access, an exact native book binding and the
 * complete owner-only protection policy, including hidden tabs. Never repairs access. */
export function assertClosedPublicationBook(input: {
  spreadsheetId: string; expectedTitle: string; owner: string; access: FrontendProtectionAccess;
  read(url: string): Record<string, any>;
}): void {
  if (input.access.ownerEmail !== input.owner || input.access.automationEmail !== input.owner) reject('Closed publication requires the automation account to own the workbook.');
  const drive = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(input.spreadsheetId);
  const file = input.read(drive + '?fields=id,name,mimeType,trashed,driveId,owners(emailAddress)');
  if (file.id !== input.spreadsheetId || file.name !== input.expectedTitle || file.trashed || file.driveId
    || file.mimeType !== 'application/vnd.google-apps.spreadsheet' || file.owners?.length !== 1 || file.owners[0].emailAddress !== input.owner)
    reject('The closed publication workbook has a different owner or binding.');
  const acl = input.read(drive + '/permissions?includePermissionsForView=published&pageSize=100&fields=nextPageToken,permissions(type,role,emailAddress,view,deleted)');
  const p = acl.permissions?.[0];
  if (acl.nextPageToken || acl.permissions?.length !== 1 || !p || p.type !== 'user' || p.role !== 'owner'
    || p.emailAddress !== input.owner || p.deleted || p.view) reject('Closed publication requires owner-only sharing in both Drive views.');
  const metadata = input.read('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(input.spreadsheetId)
    + '?fields=spreadsheetId,sheets(properties(sheetId,gridProperties(rowCount,columnCount)),protectedRanges)');
  if (metadata.spreadsheetId !== input.spreadsheetId || !Array.isArray(metadata.sheets) || !metadata.sheets.length) reject('The native workbook protection metadata is unavailable.');
  const access = { ...input.access, supportEditors: [], permissionManagers: [], directoryEditors: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [] };
  const surfaces = metadata.sheets.map((s: any) => ({kind: 'readonly' as const, sheetId: s.properties.sheetId, headers: [], dataEndRow: 2,
    gridRowCount: s.properties.gridProperties.rowCount, gridColumnCount: s.properties.gridProperties.columnCount}));
  if (!verifyFrontendProtections({ access, surfaces, metadata }).ready) reject('Every tab must already have its complete closed protection policy.');
}
