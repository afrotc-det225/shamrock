/** Native Google permission provider. No IO occurs on import; ordinary execution uses public APIs only. */
import { AdapterError } from './index.js';
import { planFrontendProtections, verifyFrontendProtections, type FrontendProtectionAccess, type FrontendProtectionSurface } from './frontend-protections.js';
import { permissionPolicyAccess, type AppliedPermissionPolicy } from './permissions-refresh.js';
import type { RolePermissionPolicy } from '../../../packages/domain/src/permissions.js';
export interface GooglePermission {
    id: string;
    type: string;
    role: string;
    emailAddress?: string;
    deleted?: boolean;
    permissionDetails?: {
        inherited?: boolean;
    }[];
}
export interface PermissionBook {
    spreadsheetId: string;
    kind: 'main' | 'excusals';
    fixedReaders: string[];
    fixedAccess: FrontendProtectionAccess;
}
export interface PermissionGoogleApi {
    /** Full file owners; file must be a separately bound, automation-owned staging spreadsheet. */
    readFile(id: string): {
        id: string;
        mimeType: string;
        owners: {
            emailAddress: string;
        }[];
    };
    /** Must collect ALL pages, with id,type,role,emailAddress,deleted,permissionDetails. No truncated defaults. */
    readPermissions(id: string): GooglePermission[];
    /** Fresh native metadata plus stable-header/key-resolved occupied row bounds, including hidden sheets. */
    readProtectionInput(id: string): {
        metadata: {
            sheets: Record<string, any>[];
        };
        surfaces: FrontendProtectionSurface[];
    };
    batchUpdate(id: string, requests: Record<string, unknown>[]): void;
    deletePermission(fileId: string, permissionId: string): void;
    /** Public Drive API permissions.create with sendNotificationEmail=false. Never sends invitation email. */
    createPermission(fileId: string, permission: {
        type: 'user';
        role: 'reader' | 'writer';
        emailAddress: string;
    }, sendNotificationEmail: false): void;
}
const fail = (message: string): never => { throw new AdapterError('permission_provider', message); };
const email = (v: string) => v.trim().toLowerCase();
const unique = (v: string[]) => [...new Set(v.map(email))].sort();
const closed = (access: FrontendProtectionAccess): FrontendProtectionAccess => ({ ...access, permissionManagers: [], supportEditors: [], directoryEditors: [], leadershipEditors: [], attendanceEditors: [], squadronCommanders: [] });
function desiredMemberships(book: PermissionBook, policy: RolePermissionPolicy): Map<string, 'reader' | 'writer'> {
    const access = permissionPolicyAccess(book.fixedAccess, { version: 1, policyHash: '', policy }), out = new Map<string, 'reader' | 'writer'>();
    const writers = book.kind === 'main' ? [...access.supportEditors, ...access.directoryEditors, ...access.permissionManagers!, ...access.leadershipEditors, ...access.attendanceEditors] : [...access.supportEditors, ...access.squadronCommanders.map(c => c.email)];
    const readers = [...book.fixedReaders, ...(book.kind === 'excusals' ? policy.google.excusalViewers : [])];
    for (const address of unique(readers))
        out.set(address, 'reader');
    for (const address of unique([...writers, access.automationEmail]))
        out.set(address, 'writer');
    out.delete(email(access.ownerEmail));
    return out;
}
/** Every step rereads live metadata. A partial/ambiguous API result is reconciled, never blindly replayed. */
export function createNativePermissionProvider(config: {
    books: PermissionBook[];
    forbiddenSpreadsheetIds: string[];
    maxMembershipMutations?: number;
}, api: PermissionGoogleApi) {
    if (config.books.length !== 2 || new Set(config.books.map(b => b.spreadsheetId)).size !== 2 || new Set(config.books.map(b => b.kind)).size !== 2 || config.books.some(b => config.forbiddenSpreadsheetIds.includes(b.spreadsheetId)))
        fail('Permission publication requires two distinct isolated frontend books.');
    const limit = config.maxMembershipMutations ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        fail('Membership mutation bound is invalid.');
    function read(book: PermissionBook) {
        const file = api.readFile(book.spreadsheetId);
        if (file.id !== book.spreadsheetId || file.mimeType !== 'application/vnd.google-apps.spreadsheet' || file.owners.length !== 1 || email(file.owners[0].emailAddress) !== email(book.fixedAccess.ownerEmail))
            fail('The staging spreadsheet owner or type changed.');
        const permissions = api.readPermissions(book.spreadsheetId);
        if (!Array.isArray(permissions) || permissions.length > 1000 || new Set(permissions.map(p => p.id)).size !== permissions.length || permissions.some(p => !p.id || !p.type || !p.role))
            fail('Complete bounded permission metadata is required.');
        const owners = permissions.filter(p => p.role === 'owner');
        if (owners.length !== 1 || owners[0].type !== 'user' || email(owners[0].emailAddress ?? '') !== email(book.fixedAccess.ownerEmail))
            fail('Native owner membership differs from the binding.');
        return permissions.filter(p => !p.deleted && p.role !== 'owner');
    }
    function revokeList(book: PermissionBook, policy: RolePermissionPolicy) {
        const desired = desiredMemberships(book, policy);
        return read(book).filter(p => p.type !== 'user' || desired.get(email(p.emailAddress ?? '')) !== p.role);
    }
    function verify(policy: RolePermissionPolicy, exact: boolean) {
        for (const book of config.books) {
            const desired = desiredMemberships(book, policy), actual = read(book);
            if (actual.some(p => p.type !== 'user' || desired.get(email(p.emailAddress ?? '')) !== p.role))
                fail('Unapproved native memberships remain.');
            if (exact && ([...desired].some(([address, role]) => actual.filter(p => email(p.emailAddress ?? '') === address && p.role === role).length !== 1)))
                fail('Approved native memberships are missing or duplicated.');
        }
    }
    function protection(book: PermissionBook, policy?: RolePermissionPolicy) {
        const input = api.readProtectionInput(book.spreadsheetId), access = policy ? permissionPolicyAccess(book.fixedAccess, { version: 1, policyHash: '', policy }) : closed(book.fixedAccess);
        return { ...input, access };
    }
    return {
        assertIsolation() { for (const book of config.books)
            read(book); },
        fenceProvider() { for (const book of config.books) {
            const input = protection(book), plan = planFrontendProtections(input);
            if (plan.requests.length)
                api.batchUpdate(book.spreadsheetId, plan.requests);
        } },
        assertProviderFenced() { for (const book of config.books)
            if (!verifyFrontendProtections(protection(book)).ready)
                fail('Native protection fencing was not verified.'); },
        revokeMemberships(policy: RolePermissionPolicy): boolean {
            let remaining = limit;
            for (const book of config.books)
                for (const permission of revokeList(book, policy)) {
                    if (!remaining--)
                        return false;
                    if (permission.permissionDetails?.some(d => d.inherited))
                        fail('An inherited permission must be resolved in the owning folder before access can reopen.');
                    api.deletePermission(book.spreadsheetId, permission.id);
                }
            return config.books.every(book => !revokeList(book, policy).length);
        },
        assertRevocations(policy: RolePermissionPolicy) { verify(policy, false); },
        addMemberships(policy: RolePermissionPolicy): boolean {
            verify(policy, false);
            let remaining = limit;
            for (const book of config.books) {
                const actual = read(book);
                for (const [address, role] of desiredMemberships(book, policy))
                    if (!actual.some(p => p.type === 'user' && email(p.emailAddress ?? '') === address && p.role === role)) {
                        if (!remaining--)
                            return false;
                        api.createPermission(book.spreadsheetId, { type: 'user', role, emailAddress: address }, false);
                    }
            }
            verify(policy, true);
            return true;
        },
        assertMemberships(policy: RolePermissionPolicy) { verify(policy, true); },
        applyProtections(policy: RolePermissionPolicy) { for (const book of config.books) {
            const plan = planFrontendProtections(protection(book, policy));
            if (plan.requests.length)
                api.batchUpdate(book.spreadsheetId, plan.requests);
        } },
        assertProtections(policy: RolePermissionPolicy) { for (const book of config.books)
            if (!verifyFrontendProtections(protection(book, policy)).ready)
                fail('The native field policy did not verify.'); },
    };
}
/** Reusable access resolver for a publisher/input host. Never merge stale derived identities from old config. */
export function resolveAppliedPermissionIdentity(applied: AppliedPermissionPolicy, address: string): {
    principalId: string;
    personId?: string;
} {
    const matches = applied.policy.accounts.filter(a => a.active && email(a.email) === email(address));
    if (matches.length !== 1)
        fail('The account is not enrolled in the current trusted policy.');
    return { principalId: matches[0].principalId, ...(matches[0].personId === null ? {} : { personId: matches[0].personId }) };
}
export interface NativePermissionHttpServices {
    ScriptApp: {
        getOAuthToken(): string;
    };
    UrlFetchApp: {
        fetch(url: string, options: {
            method: 'get' | 'post' | 'delete';
            headers: Record<string, string>;
            payload?: string;
            contentType?: string;
            muteHttpExceptions: true;
            followRedirects: false;
            validateHttpsCertificates: true;
        }): {
            getResponseCode(): number;
            getContentText(): string;
        };
    };
}
/** Authenticated public-API bridge. Native grid/header lookup is supplied by the existing keyed frontend host. */
export function createNativePermissionApi(services: NativePermissionHttpServices, readProtectionInput: PermissionGoogleApi['readProtectionInput']): PermissionGoogleApi {
    function request(url: string, method: 'get' | 'post' | 'delete' = 'get', body?: unknown): any {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload && payload.length > 1000000)
            fail('Permission provider batch exceeds its reviewed bound.');
        const response = services.UrlFetchApp.fetch(url, { method, headers: { Authorization: `Bearer ${services.ScriptApp.getOAuthToken()}` }, ...(payload === undefined ? {} : { payload, contentType: 'application/json' }), muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
        const status = response.getResponseCode(), text = response.getContentText();
        if (status < 200 || status >= 300)
            fail('A Google permission request failed; access remains fenced for readback and recovery.');
        if (text.length > 2000000)
            fail('Google permission metadata exceeds its reviewed bound.');
        if (!text)
            return {};
        try {
            return JSON.parse(text);
        }
        catch {
            return fail('Google permission response was not valid JSON.');
        }
    }
    const drive = (id: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
    return {
        readFile: id => request(`${drive(id)}?fields=id,mimeType,owners(emailAddress)`),
        readPermissions(id) {
            const result: GooglePermission[] = [], seen = new Set<string>();
            let token = '';
            do {
                if (seen.has(token) || seen.size >= 10)
                    fail('Google permission pagination did not complete within its bound.');
                seen.add(token);
                const page = request(`${drive(id)}/permissions?pageSize=100&fields=nextPageToken,permissions(id,type,role,emailAddress,deleted,permissionDetails(inherited))${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
                if (!Array.isArray(page.permissions) || page.permissions.length > 100 || page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')
                    fail('Google permission page was incomplete.');
                result.push(...page.permissions);
                token = page.nextPageToken ?? '';
            } while (token);
            return result;
        }, readProtectionInput,
        batchUpdate(id, requests) { request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, 'post', { requests }); },
        deletePermission(id, permissionId) { request(`${drive(id)}/permissions/${encodeURIComponent(permissionId)}`, 'delete'); },
        createPermission(id, permission, sendNotificationEmail) { if (sendNotificationEmail !== false)
            fail('Invitation emails are disabled.'); request(`${drive(id)}/permissions?sendNotificationEmail=false&fields=id`, 'post', permission); },
    };
}
