/** Published responder permissions are independent of Drive editor sharing. */
import { AdapterError } from './index.js';
export interface NativeResponderAccess { version: 1; allowedEmails: readonly string[] }
const MAX_RESPONDERS = 1000, MAX_PAGES = 20;
function fail(): never { throw new AdapterError('form_responder_access', 'Review the exact named Form responders before processing or resuming.'); }
function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value.trim())) return fail();
  return value.trim().toLowerCase();
}
function reviewedEmails(policy: NativeResponderAccess | undefined, ownerEmail: string): string[] {
  const owner=email(ownerEmail);
  if (!policy || Object.keys(policy).sort().join(',') !== 'allowedEmails,version' || policy.version !== 1
    || !Array.isArray(policy.allowedEmails) || !policy.allowedEmails.length || policy.allowedEmails.length > MAX_RESPONDERS) fail();
  const expected = policy.allowedEmails.map(email).sort();
  if (new Set(expected).size !== expected.length || !expected.includes(owner)) fail();
  return expected;
}
export function assertNamedResponder(policy: NativeResponderAccess | undefined, ownerEmail: string, respondentEmail: unknown): void {
  if(!reviewedEmails(policy,ownerEmail).includes(email(respondentEmail)))fail();
}
/** Read every published-view page; owner access is inherent and must be reviewed explicitly. */
export function assertPublishedResponderAccess(input: {
  formId: string; ownerEmail: string; policy: NativeResponderAccess | undefined;
  read(url: string): any;
}): void {
  const owner=email(input.ownerEmail),expected=reviewedEmails(input.policy,owner);
  const actual = new Set([owner]), seenEmails = new Set<string>(), ids = new Set<string>(), tokens = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const fields = 'nextPageToken,permissions(id,type,role,emailAddress,view,deleted)';
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.formId)}/permissions?includePermissionsForView=published&pageSize=100&fields=${encodeURIComponent(fields)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const result = input.read(url);
    if (!result || !Array.isArray(result.permissions) || result.permissions.length > 100) fail();
    for (const permission of result.permissions) {
      if (!permission || typeof permission !== 'object') fail();
      if (permission.view !== undefined && permission.view !== 'published') fail();
      if (permission.view !== 'published') {
        // An approved Form editor can also respond, even without a separate published grant.
        if(permission.type==='user'&&['owner','writer'].includes(permission.role)){
          const address=email(permission.emailAddress);if(!expected.includes(address))fail();actual.add(address);
        }
        continue;
      }
      if (permission.deleted || permission.type !== 'user' || permission.role !== 'reader'
        || typeof permission.id !== 'string' || !permission.id || permission.id.length > 256 || ids.has(permission.id)) fail();
      const address = email(permission.emailAddress);
      if (seenEmails.has(address) || !expected.includes(address)) fail();
      ids.add(permission.id); seenEmails.add(address); actual.add(address);
    }
    const next = result.nextPageToken;
    if (next === undefined || next === '') {
      if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) fail();
      return;
    }
    if (typeof next !== 'string' || next.length > 2048 || tokens.has(next)) fail();
    tokens.add(next); pageToken = next;
  }
  fail();
}
