import {wingAdministratorGrants} from "../../../packages/domain/src/panel-read.js";
import {flightSection} from "./cadet-workspace.js";
import { canonicalPrincipal, cadetRoute, reportSection, eligibleSchoolSql, readCadetWorkspace } from "./cadet-workspace.js";
import type {WingTableCache} from './panel-cache.js';
import {browsePanel, profiles, type Profile} from "./panel-browse.js";
import { PANEL_VIEW_AS_PAGE_MAX_BYTES, type PanelViewAsAuthorization, type PanelViewAsKind, type PanelViewAsPage, type PanelViewAsStatus } from '../../../packages/domain/src/panel-view-as.js';
import { effectiveAdminGrants } from './permission-grants.js';
import { panelReadAuthority, panelSnapshotPage } from './panel-read.js';
import { frontendSnapshotPage } from './frontend-transport.js';
import { legacyHistoryPage } from './legacy-history-transport.js';
import { listLegacyHistory } from './legacy-history.js';
import { HttpError } from './http-error.js';

interface Env { DB: D1Database; ENVIRONMENT: string; GENERATION: string }
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_key, x) => object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = async (v: unknown): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(v))))].map(n => n.toString(16).padStart(2, '0')).join('');
const viewErrors: Record<string,string> = {
  NOT_AUTHORIZED: 'Your account does not have access to this action.',
  VIEW_AS_UNAVAILABLE: 'This view has ended or the cadet’s account access has changed. Exit view to select the cadet again.',
  VIEW_AS_CHANGED: 'The records or access changed while this page was loading.',
  PANEL_NOT_READY: 'The cadet list is being updated. Try again shortly.',
  NOT_FOUND: 'This cadet is no longer in the Directory.',
  VIEW_AS_AUDIT_CONFLICT: 'This selection has expired. Exit view to select the cadet again.',
  WRONG_GENERATION: 'This workspace has changed. Reopen SHAMROCK.',
};
const fail = (status: number, code: string): never => {
  throw new HttpError(status, code, viewErrors[code] ?? 'SHAMROCK could not complete this request.');
};
function identity(env: Env, input: unknown): Row & { principalId: string } {
  if (!object(input) || !id(input.principalId)) return fail(400, 'INVALID_VIEW_AS_REQUEST');
  if (input.environment !== env.ENVIRONMENT || input.generation !== Number(env.GENERATION)) fail(409, 'WRONG_GENERATION');
  return input as Row & { principalId: string };
}
/** Exactly the fullSnapshot predicate from resolvePanelAccess; broad derived read grants alone do not suffice. */
const full = (principal: string) => `EXISTS(SELECT 1 FROM principals p WHERE p.principal_id=${principal} AND p.active=1 AND (
  EXISTS(SELECT 1 FROM admin_grants g WHERE g.principal_id=p.principal_id AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')
  OR EXISTS(SELECT 1 FROM permission_managers m JOIN ${effectiveAdminGrants} g ON g.principal_id=m.principal_id
    WHERE m.principal_id=p.principal_id AND m.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')))`;
const administrator = (principal: string) => `(${full(principal)} AND (
  EXISTS(SELECT 1 FROM permission_managers WHERE principal_id=${principal} AND active=1) OR
  (SELECT COUNT(*) FROM admin_grants WHERE principal_id=${principal} AND scope_kind='wing' AND scope_key='*'
    AND capability IN (${wingAdministratorGrants.map(value=>"'"+value+"'").join(",")}))=${wingAdministratorGrants.length}))`;
/** The picker needs only the delegation capability and the directory display fields. */
export async function viewAsPeople(env: Env, input: unknown) {
  const req = identity(env, input);
  if (Object.keys(req).sort().join(',') !== 'environment,generation,principalId') return fail(400,'INVALID_VIEW_AS_REQUEST');
  const [result] = await env.DB.batch<Row>([env.DB.prepare(`WITH actor AS (SELECT ? AS id)
    SELECT ${administrator('(SELECT id FROM actor)')} AS allowed,
      EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?)
      AND (SELECT COUNT(*) FROM terms WHERE is_current=1)=1
      AND NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE state<>'complete')
      AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE state<>'complete')
      AND NOT EXISTS(SELECT 1 FROM event_roster_refresh_work) AS ready,
      (SELECT entries FROM cadet_attendance_index WHERE kind='directory_profiles' AND bucket='*') AS entries`)
    .bind(req.principalId,env.ENVIRONMENT,Number(env.GENERATION))]);
  const row=result.results[0];
  if(row?.allowed!==1)return fail(403,'NOT_AUTHORIZED');
  if(row.ready!==1)return fail(409,'PANEL_NOT_READY');
  const people=Object.values(JSON.parse(String(row.entries ?? '{}'))) as string[][];
  people.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const packed=JSON.stringify(people);
  if(people.length>2000 || packed.length>900000)return fail(409,'BROWSE_TOO_LARGE');
  return {tables:{people:packed}};
}
interface Binding { hasRosterPrincipal: boolean; schoolEmail: string | null; schoolCadetPrincipal: string | null; directoryEmail: string | null; raw: string; targetPrincipalId: string | null; status: PanelViewAsStatus; fullSnapshot: boolean }
/** Small private capture repeated inside every data batch. Email evidence stays in the capture, never the response. */
function bindingQuery(env: Env, actor: string, person: string, entry: string | null) {
  const sql = `WITH actor AS (SELECT ? AS id), target AS (
    SELECT p.principal_id AS id,a.email,a.evidence FROM principals p LEFT JOIN principal_accounts a ON a.principal_id=p.principal_id
    WHERE p.person_id=? AND p.active=1 ORDER BY (p.principal_id LIKE 'school.%') DESC,p.principal_id LIMIT 3)
    SELECT json_array(
      EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?),
      ${administrator('(SELECT id FROM actor)')},EXISTS(SELECT 1 FROM people WHERE person_id=?),
      json((SELECT json_group_array(json_array(id,email,evidence)) FROM target)),${full("(SELECT id FROM target ORDER BY (id LIKE 'school.%') DESC,id LIMIT 1)")},
      json((SELECT json_array(audit_id,actor_id,target_person_id,target_principal_id,status,
        EXISTS(SELECT 1 FROM panel_view_as_audit x WHERE x.entry_audit_id=a.audit_id AND x.action='exit'))
        FROM panel_view_as_audit a WHERE a.audit_id=? AND a.action='enter' AND a.environment=? AND a.generation=?)),
      (SELECT lower(d.email) FROM directory_profiles d WHERE d.person_id=? AND (${eligibleSchoolSql} OR lower(d.email) LIKE '%@gmail.com')
        AND d.flight_path_status NOT IN ('Inactive','Commissioned','Dropped')
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1)
        AND NOT EXISTS(SELECT 1 FROM principals p WHERE p.person_id=d.person_id AND p.active=0)
        AND NOT EXISTS(SELECT 1 FROM directory_profiles other WHERE lower(other.email)=lower(d.email) AND other.person_id<>d.person_id))) AS binding`;
  const values = [actor, person, env.ENVIRONMENT, Number(env.GENERATION), person, entry, env.ENVIRONMENT, Number(env.GENERATION),person];
  return { sql, values, statement: () => env.DB.prepare(sql).bind(...values) };
}
async function decodeBinding(raw: unknown, actor: string, person: string, entry: string | null): Promise<Binding> {
  if (typeof raw !== 'string') return fail(409, 'VIEW_AS_CHANGED');
  const [valid, actorFull, exists, capturedTargets, targetFull, saved, email] = JSON.parse(raw);
  if (valid !== 1 || actorFull !== 1) fail(403, 'NOT_AUTHORIZED');
  if (exists !== 1) fail(404, 'NOT_FOUND');
  // A Directory principal created for delegated edits carries no Google verification.
  const canonical=typeof email==='string' ? await canonicalPrincipal(email) : null;
  const targets=capturedTargets.filter((row:unknown[])=>!(row[0]===canonical && row[1]===null));
  const school = targets.find((row:unknown[])=>String(row[0]).startsWith('school.'));
  let sameSchoolIdentity = false, schoolCadetPrincipal:string|null=null;
  if (school && typeof email === 'string' && (!school[1] || school[1]===email)) {
    const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email.trim().toLowerCase()));
    const suffix=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
    const cadet=targets.find((row:unknown[])=>row[0]==='google.'+suffix && row[1]===email
      && ['authenticated-confirmation','google-form'].includes(String(row[2])));
    sameSchoolIdentity=school[0]==='school.'+suffix && (targets.length===1 || targets.length===2 && !!cadet);
    if(sameSchoolIdentity && cadet)schoolCadetPrincipal=String(cadet[0]);
  }
  const schoolWing = sameSchoolIdentity && targetFull===1;
  const targetPrincipalId = schoolWing ? String(school[0]) : sameSchoolIdentity ? schoolCadetPrincipal : targets.length===1 ? String(targets[0][0]) : null;
  const directoryEmail = typeof email==='string' && !targetFull && (sameSchoolIdentity || targets.length===0 || targets.length===1 && targets[0][1]===email) ? email : null;
  const status: PanelViewAsStatus = directoryEmail || schoolWing ? 'ready' : targets.length === 0 ? 'no-active-principal' : targets.length !== 1 ? 'ambiguous-principal'
    : school || typeof targets[0][1] !== 'string' || !targets[0][1].trim() || !['google-form', 'authenticated-confirmation'].includes(targets[0][2]) ? 'no-verified-login' : 'ready';
  if (entry && (!saved || saved[0] !== entry || saved[1] !== actor || saved[2] !== person || saved[3] !== targetPrincipalId || saved[4] !== 'ready' || saved[5] !== 0 || status !== 'ready')) fail(403, 'VIEW_AS_UNAVAILABLE');
  return { raw, hasRosterPrincipal:capturedTargets.length !== targets.length, schoolEmail:schoolWing ? email : null, schoolCadetPrincipal, directoryEmail, targetPrincipalId, status, fullSnapshot: targetFull === 1 };
}
function guardedEnvironment(env: Env, query: ReturnType<typeof bindingQuery>, expected: string): Env {
  // Only existing read implementations receive this wrapper. Authority/mapping and data are one D1 snapshot.
  const db = { prepare: (sql: string) => env.DB.prepare(sql), async batch<T>(statements: D1PreparedStatement[]) {
    const results = await env.DB.batch<T | Row>([...statements, query.statement()]);
    if ((results.at(-1)?.results[0] as Row | undefined)?.binding !== expected) fail(409, 'VIEW_AS_CHANGED');
    return results.slice(0, -1) as D1Result<T>[];
  } } as D1Database;
  return { ...env, DB: db };
}
async function readBinding(env: Env, actor: string, person: string, entry: string | null) {
  const query = bindingQuery(env, actor, person, entry), result = await env.DB.batch<Row>([query.statement()]);
  return { query, binding: await decodeBinding(result[0].results[0]?.binding, actor, person, entry) };
}
const auditSelect = `SELECT audit_id,entry_audit_id,action,environment,generation,actor_id,target_person_id,target_principal_id,status,request_hash,
  EXISTS(SELECT 1 FROM panel_view_as_audit x WHERE x.entry_audit_id=a.audit_id AND x.action='exit') AS closed FROM panel_view_as_audit a WHERE audit_id=?`;
/** Entry/exit audit is isolated from operational commands, audit revisions and refresh queues. */
export async function authorizePanelViewAs(env: Env, input: unknown): Promise<PanelViewAsAuthorization> {
  const req = identity(env, input);
  if (!['enter', 'exit'].includes(String(req.action)) || !id(req.auditId)) fail(400, 'INVALID_VIEW_AS_REQUEST');
  const enter = req.action === 'enter', keys = enter ? 'action,auditId,environment,generation,principalId,targetPersonId' : 'action,auditId,entryAuditId,environment,generation,principalId';
  if (Object.keys(req).sort().join(',') !== keys || !id(enter ? req.targetPersonId : req.entryAuditId)) fail(400, 'INVALID_VIEW_AS_REQUEST');
  const requestHash = await digest(req), now = new Date().toISOString();
  if (!enter) {
    const prior = (await env.DB.batch<Row>([env.DB.prepare(auditSelect).bind(req.entryAuditId)]))[0].results[0];
    if (!prior || prior.action !== 'enter' || prior.actor_id !== req.principalId || prior.environment !== env.ENVIRONMENT || prior.generation !== Number(env.GENERATION)) fail(403, 'NOT_AUTHORIZED');
    // Losing Wing access never traps a session in preview. This writes only its own exit audit.
    const results = await env.DB.batch<Row>([
      env.DB.prepare(`INSERT INTO panel_view_as_audit SELECT ?,audit_id,'exit',environment,generation,actor_id,target_person_id,target_principal_id,'exited',?,?
        FROM panel_view_as_audit WHERE audit_id=? AND action='enter' AND actor_id=? AND environment=? AND generation=?
        AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?) ON CONFLICT(audit_id) DO NOTHING`)
        .bind(req.auditId, requestHash, now, req.entryAuditId, req.principalId, env.ENVIRONMENT, Number(env.GENERATION), env.ENVIRONMENT, Number(env.GENERATION)),
      env.DB.prepare(auditSelect).bind(req.auditId),
    ]);
    const saved = results[1].results[0];
    if (!saved || saved.request_hash !== requestHash) fail(409, 'VIEW_AS_AUDIT_CONFLICT');
    return { contractVersion: 'panel-view-as-v1', readOnly: true, action: 'exit', entryAuditId: String(req.entryAuditId), targetPersonId: String(saved.target_person_id), targetPrincipalId: saved.target_principal_id as string | null, status: 'exited', access: null };
  }
  // For a directory target, evaluate the binding and record entry in one statement.
  // RETURNING is empty for retries, non-directory targets and failed checks. Those
  // cases go through the detailed conflict, access and audit handling below.
  const candidate=bindingQuery(env,req.principalId,String(req.targetPersonId),null);
  const [attempt]=await env.DB.batch<Row>([env.DB.prepare(`WITH captured(b) AS MATERIALIZED (${candidate.sql})
    INSERT INTO panel_view_as_audit
    SELECT ?,?,'enter',?,?,?,?,json_extract(b,'$[3][0][0]'),'ready',?,? FROM captured
    WHERE json_extract(b,'$[0]')=1 AND json_extract(b,'$[1]')=1 AND json_extract(b,'$[2]')=1
      AND json_extract(b,'$[4]')=0 AND json_type(b,'$[6]')='text'
      AND COALESCE(json_extract(b,'$[3][0][0]'),'') NOT LIKE 'school.%'
      AND (json_array_length(b,'$[3]')=0 OR (json_array_length(b,'$[3]')=1 AND json_extract(b,'$[3][0][1]')=json_extract(b,'$[6]')))
    ON CONFLICT(audit_id) DO NOTHING RETURNING target_person_id,target_principal_id`)
    .bind(...candidate.values,req.auditId,req.auditId,env.ENVIRONMENT,Number(env.GENERATION),req.principalId,req.targetPersonId,requestHash,now)]);
  const inserted=attempt.results[0];
  if(inserted)return {contractVersion:'panel-view-as-v1',readOnly:true,action:'enter',directoryWorkspace:true,
    entryAuditId:String(req.auditId),targetPersonId:String(inserted.target_person_id),targetPrincipalId:inserted.target_principal_id as string|null,status:'ready',access:null};
  const person = String(req.targetPersonId), { query, binding } = await readBinding(env, req.principalId, person, null);
  let status = binding.status, access: PanelViewAsAuthorization['access'] = null;
  if (status === 'ready' && !binding.directoryEmail) {
    try { access = (await panelReadAuthority(guardedEnvironment(env, query, binding.raw), { environment: req.environment, generation: req.generation, principalId: binding.targetPrincipalId })).access; }
    catch (error) { if (error instanceof HttpError && error.code === 'NOT_AUTHORIZED') status = 'no-panel-access'; else throw error; }
  }
  const results = await env.DB.batch<Row>([
    env.DB.prepare(`INSERT INTO panel_view_as_audit SELECT ?,?,'enter',?,?,?,?,?,?,?,? WHERE (${query.sql})=? ON CONFLICT(audit_id) DO NOTHING`)
      .bind(req.auditId, req.auditId, env.ENVIRONMENT, Number(env.GENERATION), req.principalId, person, binding.targetPrincipalId, status, requestHash, now, ...query.values, binding.raw),
    env.DB.prepare(auditSelect).bind(req.auditId), ...(binding.directoryEmail ? [] : [query.statement()]),
  ]);
  // A successful conditional insert already validated the binding in this transaction.
  // Idempotent retries must still prove the current mapping before returning the existing entry.
  const checked=results[2] ?? (!results[0].meta?.changes ? (await env.DB.batch<Row>([query.statement()]))[0] : null);
  if (checked && checked.results[0]?.binding !== binding.raw) fail(409, 'VIEW_AS_CHANGED');
  const saved = results[1].results[0];
  if (!saved || saved.request_hash !== requestHash || saved.target_principal_id !== binding.targetPrincipalId) fail(409, 'VIEW_AS_AUDIT_CONFLICT');
  if (saved.closed === 1 || saved.status !== status) fail(409, 'VIEW_AS_CHANGED');
  return { contractVersion: 'panel-view-as-v1', readOnly: true, action: 'enter', directoryWorkspace:!!(binding.directoryEmail || binding.schoolEmail), entryAuditId: String(req.auditId), targetPersonId: person, targetPrincipalId: binding.targetPrincipalId, status, access };
}

/** Revalidate an existing preview without replaying entry audit or counting its records. */
export async function panelViewAsAuthority(env: Env, input: unknown) {
  const req=identity(env,input);
  if(Object.keys(req).sort().join(',')!=='entryAuditId,environment,generation,principalId,targetPersonId'
    ||!id(req.entryAuditId)||!id(req.targetPersonId))fail(400,'INVALID_VIEW_AS_REQUEST');
  const person=String(req.targetPersonId),entry=String(req.entryAuditId),{query,binding}=await readBinding(env,req.principalId,person,entry);
  if(binding.directoryEmail) throw new HttpError(409,'CADET_WORKSPACE','Open the cadet workspace for this preview.');
  if(!binding.targetPrincipalId)fail(403,'NOT_AUTHORIZED');
  const authority=await panelReadAuthority(guardedEnvironment(env,query,binding.raw),{
    environment:req.environment,generation:req.generation,principalId:binding.targetPrincipalId});
  const kind=binding.fullSnapshot?'snapshot':'panel';
  const revision=binding.fullSnapshot?{operations:authority.revision.operations,administration:authority.revision.administration}:authority.revision;
  // Exactly the existing current-snapshot transfer binding; catalog and History
  // tokens remain independent and are never accepted by this access-only route.
  const source={revision,scope:authority.scope,catalog:null};
  const viewRevision=await digest({actorPrincipalId:req.principalId,entryAuditId:entry,targetPersonId:person,
    targetPrincipalId:binding.targetPrincipalId,binding:binding.raw,kind,source});
  return {contractVersion:'panel-view-as-access-v1',readOnly:true,environment:env.ENVIRONMENT,generation:Number(env.GENERATION),
    entryAuditId:entry,targetPersonId:person,viewRevision,scope:authority.scope,access:authority.access,
    revision:binding.fullSnapshot?{...revision,access:viewRevision}:revision};
}

/** Only allowlisted read functions can run, under both real-actor and target authority in every batch. */
export async function panelViewAsPage(env: Env, input: unknown): Promise<PanelViewAsPage> {
  const req = identity(env, input);
  if (Object.keys(req).sort().join(',') !== 'entryAuditId,environment,generation,kind,page,principalId,targetPersonId,viewRevision'
    || !id(req.entryAuditId) || !id(req.targetPersonId) || !['panel', 'snapshot', 'history', 'history-list'].includes(String(req.kind))
    || !object(req.page) || ['environment', 'generation', 'principalId'].some(k => Object.hasOwn(req.page as Row, k))
    || req.viewRevision !== null && !sha(req.viewRevision)) fail(400, 'INVALID_VIEW_AS_REQUEST');
  const kind = req.kind as PanelViewAsKind, page = req.page as Row;
  const start = kind === 'history-list' ? Object.keys(page).length === 0
    : page.section === 'manifest' && page.offset === 0 && (kind === 'history' ? page.sourceSnapshotSha256 === null : page.revision === null)
      || kind === 'snapshot' && ['term-catalog', 'directory-catalog', 'contacts-catalog'].includes(String(page.section)) && page.offset === 0 && page.revision === null;
  if (req.viewRevision === null ? !start : start || kind === 'history-list') fail(400, 'INVALID_VIEW_AS_REQUEST');
  const person = String(req.targetPersonId), entry = String(req.entryAuditId), { query, binding } = await readBinding(env, req.principalId, person, entry);
  if (binding.directoryEmail || !binding.targetPrincipalId || kind !== 'panel' && !binding.fullSnapshot) return fail(403, 'NOT_AUTHORIZED');
  if (kind === 'panel' && binding.fullSnapshot) fail(400, 'VIEW_AS_TRANSPORT_MISMATCH');
  const guarded = guardedEnvironment(env, query, binding.raw), body = { ...page, environment: req.environment, generation: req.generation, principalId: binding.targetPrincipalId };
  const result = kind === 'panel' ? await panelSnapshotPage(guarded, body)
    : kind === 'snapshot' ? await frontendSnapshotPage(guarded, body)
      : kind === 'history' ? await legacyHistoryPage(guarded, body) : await listLegacyHistory(guarded, body);
  const data = result as Row;
  const source = kind === 'history' ? { snapshotId: data.snapshotId, sourceSnapshotSha256: data.sourceSnapshotSha256, importedAt: data.importedAt }
    : kind === 'history-list' ? data : { revision: data.revision, scope: data.scope, catalog: kind === 'snapshot' && !data.scope ? page.section : null };
  const viewRevision = await digest({ actorPrincipalId: req.principalId, entryAuditId: entry, targetPersonId: person, targetPrincipalId: binding.targetPrincipalId, binding: binding.raw, kind, source });
  if (req.viewRevision !== null && req.viewRevision !== viewRevision) fail(409, 'VIEW_AS_CHANGED');
  const response: PanelViewAsPage = { contractVersion: 'panel-view-as-page-v1', readOnly: true, environment: env.ENVIRONMENT as PanelViewAsPage['environment'], generation: Number(env.GENERATION), entryAuditId: entry, targetPersonId: person, targetPrincipalId: binding.targetPrincipalId, viewRevision, kind, page: result };
  if (new TextEncoder().encode(JSON.stringify(response)).length > PANEL_VIEW_AS_PAGE_MAX_BYTES) fail(409, 'VIEW_AS_PAGE_TOO_LARGE');
  return response;
}

/** Shared browse endpoint, including the real actor and target fence on every preview D1 batch. */
export async function panelBrowse(env:Env,input:unknown,wingCache?:WingTableCache) {
  const req=identity(env,input), preview=Object.hasOwn(req,'entryAuditId');
  const targeted = Object.hasOwn(req,'recordId');
  if (targeted && (!['event-editor','directory-editor'].includes(String(req.profile)) || !id(req.recordId)))
    return fail(400,'INVALID_PANEL_REQUEST');
  if (Object.keys(req).sort().join(',') !== (preview?'entryAuditId,environment,generation,principalId,profile,'+(targeted?'recordId,':'')+'targetPersonId':'environment,generation,principalId,profile'+(targeted?',recordId':'')) ||
      !profiles.includes(req.profile as Profile)) throw new HttpError(400,'INVALID_PANEL_REQUEST','Invalid page.');
  const actor = {environment:env.ENVIRONMENT,generation:Number(env.GENERATION),principalId:req.principalId};
  if (!preview) return browsePanel(env,actor,req.profile as Profile,wingCache,req.recordId as string|undefined);
  if (['view-as-people'].includes(String(req.profile))) return fail(403,'NOT_AUTHORIZED');
  if (!id(req.entryAuditId)||!id(req.targetPersonId)) return fail(400,'INVALID_VIEW_AS_REQUEST');
  const {query,binding}=await readBinding(env,req.principalId,req.targetPersonId,req.entryAuditId);
  if((targeted || ['semester','event-editor','directory-editor','diagnostics'].includes(String(req.profile))) && !binding.fullSnapshot)return fail(403,'NOT_AUTHORIZED');
  if(binding.directoryEmail || !binding.targetPrincipalId)return fail(403,'NOT_AUTHORIZED');
  return browsePanel(guardedEnvironment(env,query,binding.raw),{...actor,principalId:binding.targetPrincipalId},req.profile as Profile,undefined,req.recordId as string|undefined);
}

export async function previewCadetWorkspace<E extends Env>(env:E, input:unknown,
  submit:(guarded:E,...args:Parameters<Parameters<typeof cadetRoute>[2]>)=>Promise<unknown>) {
  const req=identity(env,input);
  const action = Object.hasOwn(req,'action');
  const keys = 'entryAuditId,environment,generation,principalId,'+(Object.hasOwn(req,'section')?'section,':'')+'targetPersonId';
  if(req.section!==undefined && !reportSection(req.section) && !flightSection(req.section) && !['overview','overview-charts','profile','report','attendance','flight','excusals','directory','leadership'].includes(String(req.section)))return fail(400,'INVALID_VIEW_AS_REQUEST');
  if(Object.keys(req).sort().join(',')!==(action?'action,'+keys:keys)
    || !id(req.entryAuditId) || !id(req.targetPersonId)) return fail(400,'INVALID_VIEW_AS_REQUEST');
  if (!action && (req.section==='profile' || req.section==='attendance')) {
    // Hints only identify candidate rows. Validate the open audit and the actor's
    // live grants in the same transaction as those rows before decoding any data.
    const [hint]=await env.DB.batch<Row>([env.DB.prepare(`SELECT lower(d.email) AS email,a.target_principal_id AS principal
      FROM panel_view_as_audit a JOIN directory_profiles d ON d.person_id=a.target_person_id
      WHERE a.audit_id=? AND a.actor_id=? AND a.target_person_id=? AND a.action='enter'`)
      .bind(req.entryAuditId,req.principalId,req.targetPersonId)]);
    const email=String(hint.results[0]?.email ?? ''),principal=hint.results[0]?.principal as string|null ?? null;
    if(!principal?.startsWith("school.")){
      const person=req.targetPersonId,entry=req.entryAuditId,actor=req.principalId;
      const query=bindingQuery(env,actor,person,entry);
      const db={prepare:(sql:string)=>env.DB.prepare(sql),async batch<T>(statements:D1PreparedStatement[]) {
        const results=await env.DB.batch<T|Row>([query.statement(),...statements]);
        const binding=await decodeBinding((results[0].results[0] as Row)?.binding,actor,person,entry);
        if(!binding.directoryEmail || binding.directoryEmail!==email || binding.targetPrincipalId!==principal)fail(403,'VIEW_AS_UNAVAILABLE');
        return results.slice(1) as D1Result<T>[];
      }} as D1Database;
      return {...await readCadetWorkspace({...env,DB:db},email,principal ?? undefined,req.section),readOnly:false};
    }
  }
  const {query,binding}=await readBinding(env,req.principalId,req.targetPersonId,req.entryAuditId);
  const email=binding.schoolEmail ?? binding.directoryEmail;
  const principal=binding.schoolEmail ? binding.schoolCadetPrincipal : binding.targetPrincipalId;
  if(!email) return fail(403,'VIEW_AS_UNAVAILABLE');
  if(!action) return {...await readCadetWorkspace(guardedEnvironment(env,query,binding.raw),email,principal ?? undefined,req.section),readOnly:false};
  if(!object(req.action) || !object(req.action.fields) || !id(req.action.id)) return fail(400,'INVALID_VIEW_AS_REQUEST');
  if (['register','link'].includes(String(req.action.kind))) return fail(403,'VIEW_AS_UNAVAILABLE');
  const effective = principal ?? await canonicalPrincipal(email);
  let expected=binding.raw;
  if(!principal && !binding.hasRosterPrincipal){
    const state=await readCadetWorkspace(guardedEnvironment(env,query,expected),email,effective,'profile');
    if(!state.writable)throw new HttpError(409,'WRITES_PAUSED','Submissions are paused.');
    if(state.profile?.personId!==req.targetPersonId)return fail(403,'VIEW_AS_UNAVAILABLE');
    // Provision only the roster identity and its self-service grant. Google verification
    // is recorded separately when the cadet actually authenticates.
    const db=env.DB;
    await writeEnvironment(env,query,expected).DB.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)
        THEN 1 ELSE json('writes paused') END`).bind(req.environment,req.generation),
      db.prepare('INSERT INTO principals(principal_id,person_id,active) VALUES(?,?,1) ON CONFLICT DO NOTHING').bind(effective,req.targetPersonId),
      db.prepare(`INSERT INTO access_grants(principal_id,capability,unit_id,subject_scope) SELECT ?, 'excusal.submit', ?, 'self' WHERE EXISTS(
        SELECT 1 FROM principals WHERE principal_id=? AND person_id=? AND active=1) ON CONFLICT DO NOTHING`).bind(effective,state.profile.flightId,effective,req.targetPersonId),
    ]);
    const fresh=(await readBinding(env,req.principalId,req.targetPersonId,req.entryAuditId)).binding;
    if((fresh.schoolEmail ?? fresh.directoryEmail)!==email || fresh.targetPrincipalId!==binding.targetPrincipalId)return fail(409,'VIEW_AS_CHANGED');
    expected=fresh.raw;
  }
  const guarded=writeEnvironment(env,query,expected);
  return cadetRoute(guarded,{environment:req.environment,generation:req.generation,principalId:effective,
    email,action:req.action},(c,g)=>submit(guarded,c,g),req.entryAuditId,!principal);

}

function writeEnvironment<E extends Env>(env:E,query:ReturnType<typeof bindingQuery>,expected:string):E {
  // A failed precondition aborts the same D1 transaction that would save the edit.
  // SELECT only: read batches incur no writes to maintain the fence.
  const db = {prepare:(sql:string)=>env.DB.prepare(sql), async batch<T>(statements:D1PreparedStatement[]) {
    const fence=env.DB.prepare(`SELECT CASE WHEN (${query.sql})=? THEN 1 ELSE json('view changed') END`).bind(...query.values,expected);
    return (await env.DB.batch<T>([fence,...statements])).slice(1);
  }} as D1Database;
  return {...env,DB:db};
}

// Only panel proposal paths reach this adapter. The authenticated operator, directory
// mapping and open entry must still match inside the transaction that commits.
export async function delegatePanel<E extends Env>(env:E,input:unknown){
  const req=identity(env,input);
  if(!id(req.entryAuditId)||!id(req.targetPersonId)||!object(req.payload)) return fail(400,'INVALID_VIEW_AS_REQUEST');
  const {query,binding}=await readBinding(env,req.principalId,req.targetPersonId,req.entryAuditId);
  if(!binding.targetPrincipalId||binding.directoryEmail) return fail(403,'VIEW_AS_UNAVAILABLE');
  const path=String(req.path),payload=req.payload;
  if(!['/v1/admin/panel/authorize','/v1/admin/panel/commands','/v1/admin/commands'].includes(path))return fail(403,'NOT_AUTHORIZED');
  if(path==='/v1/admin/commands' && !binding.fullSnapshot)return fail(403,'NOT_AUTHORIZED');
  const principalId=binding.targetPrincipalId;
  if(path.endsWith('authorize'))return {path,env:writeEnvironment(env,query,binding.raw),input:{...payload,principalId}};
  if(!id(payload.commandId)||!object(payload.source)||!object(payload.actor))return fail(400,'INVALID_VIEW_AS_REQUEST');
  const commandId='view.'+req.entryAuditId+'.'+payload.commandId;
  return {path,env:writeEnvironment(env,query,binding.raw),input:{...payload,commandId,actor:{...payload.actor,principalId},source:{...payload.source,submissionId:commandId}}};
}
