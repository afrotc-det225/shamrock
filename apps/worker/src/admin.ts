import { adminIdentifier, DIRECTORY_FIELDS, directoryLeadershipRole, operationallyActive, parseAdminCommand, type AdminCommand, type DirectoryRecord, type FrontendSnapshot, type LeadershipRecord, } from '../../../packages/domain/src/admin.js';
import { HttpError } from './http-error.js';
interface AdminEnv {
  DB: D1Database;
  ENVIRONMENT: string;
  GENERATION: string;
}
type Value = string | number | null;
const stmt = (db: D1Database, sql: string, ...values: Value[]) => db.prepare(sql).bind(...values);
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const control = (write = true) => `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write ? ' AND accepting_commands=1' : ''})`;
// Empty scope is wing-only. Flight grants cannot mutate a wing-wide event or Leadership contact.
function permission(principal: string, capability: string, scopes: string[]): {
  sql: string;
  values: Value[];
} {
  return { sql: `EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND active=1) AND (
  EXISTS(SELECT 1 FROM admin_grants WHERE principal_id=? AND capability=? AND scope_kind='wing' AND scope_key='*') OR
  (json_array_length(?)>0 AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE NOT EXISTS(
   SELECT 1 FROM admin_grants WHERE principal_id=? AND capability=? AND scope_kind='flight' AND scope_key=s.value))))`,
    values: [principal, principal, capability, JSON.stringify(scopes), JSON.stringify(scopes), principal, capability] };
}
function commandAuth(env: AdminEnv, c: AdminCommand, capability: string, scopes: string[]) {
  const p = permission(c.actor.principalId, capability, scopes);
  return { sql: `${control()} AND ${p.sql} AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)`, values: [env.ENVIRONMENT, Number(env.GENERATION), ...p.values, c.source.kind, c.source.resourceKey] };
}
interface Receipt {
  commandId: string;
  status: 'committed';
  operation: AdminCommand['operation'];
  result: {
    targetId: string;
    version: number;
  };
  pendingEffects: true;
}
interface StoredReceipt {
  hash: string;
  receipt: string;
  actorId: string;
  capability: string;
  scopes: string;
  sourceKind: string;
  sourceResource: string;
}
async function priorReceipt(env: AdminEnv, c: AdminCommand, hash: string): Promise<Receipt | null> {
  // All authorization facts and the receipt are read in one transaction, even on replay.
  const rows = await env.DB.batch<Record<string, unknown>>([
    stmt(env.DB, `SELECT payload_hash AS hash,receipt_json AS receipt,actor_id AS actorId,capability,scopes_json AS scopes,
   source_kind AS sourceKind,source_resource AS sourceResource FROM admin_commands WHERE command_id=?`, c.commandId),
    stmt(env.DB, `SELECT (${control()}) AS allowed`, env.ENVIRONMENT, Number(env.GENERATION)),
    stmt(env.DB, `SELECT active FROM principals WHERE principal_id=?`, c.actor.principalId),
    stmt(env.DB, `SELECT capability,scope_kind AS kind,scope_key AS scope FROM admin_grants WHERE principal_id=?`, c.actor.principalId),
    stmt(env.DB, `SELECT active FROM adapter_sources WHERE source_kind=? AND resource_key=?`, c.source.kind, c.source.resourceKey),
  ]);
  const row = rows[0].results[0] as unknown as StoredReceipt | undefined;
  if (!row)
    return null;
  const scopes = JSON.parse(row.scopes) as string[];
  const grants = rows[3].results as {
    capability: string;
    kind: string;
    scope: string;
  }[];
  const relevant = grants.filter(g => g.capability === row.capability);
  if (row.actorId !== c.actor.principalId || rows[1].results[0]?.allowed !== 1 || rows[2].results[0]?.active !== 1 || rows[4].results[0]?.active !== 1 ||
    !(relevant.some(g => g.kind === 'wing' && g.scope === '*') || (scopes.length > 0 && scopes.every(s => relevant.some(g => g.kind === 'flight' && g.scope === s))))) {
    throw new HttpError(403, 'NOT_AUTHORIZED', 'The actor, source or operation is not currently authorized.');
  }
  if (row.hash !== hash)
    throw new HttpError(409, 'COMMAND_ID_CONFLICT', 'This command ID was already used for different input.');
  return JSON.parse(row.receipt) as Receipt;
}
const profileColumns = ['last_name', 'first_name', 'as_year', 'rank', 'role', 'university', 'email', 'phone', 'dorm', 'cip_broad_area', 'cip_code', 'afsc', 'home_town', 'home_state', 'class_year', 'date_of_birth', 'flight_path_status', 'photo_link'];
const profileSelect = profileColumns.map((column, i) => `d.${column} AS ${DIRECTORY_FIELDS[i]}`).join(',');
const profileProjection = `SELECT d.person_id AS personId,d.version,d.flight_id AS flightId,${profileSelect} FROM directory_profiles d`;
export async function acceptAdminCommand(env: AdminEnv, input: unknown): Promise<Receipt> {
  const c = parseAdminCommand(input);
  if (c.environment !== env.ENVIRONMENT || c.generation !== Number(env.GENERATION))
    throw new HttpError(409, 'WRONG_GENERATION', 'Reload the current environment before submitting.');
  const hash = await digest(JSON.stringify(c));
  const previous = await priorReceipt(env, c, hash);
  if (previous)
    return previous;
  const now = new Date().toISOString();
  const writes: D1PreparedStatement[] = [];
  let before: unknown = null;
  let scopes: string[] = [];
  let targetId: string;
  let capability: string;
  let condition: string;
  let conditionValues: Value[];
  if (c.operation === 'directory.upsert') {
    const p = c.payload;
    targetId = p.personId;
    capability = 'directory.manage';
    const rows = await env.DB.batch<Record<string, unknown>>([
      stmt(env.DB, `${profileProjection} WHERE d.person_id=?`, p.personId),
      stmt(env.DB, 'SELECT unit_id AS flightId,active FROM memberships WHERE person_id=? ORDER BY unit_id', p.personId),
    ]);
    const existing = rows[0].results[0] as unknown as DirectoryRecord | undefined;
    const memberships = rows[1].results as {
      flightId: string;
      active: number;
    }[];
    if (memberships.filter(m => m.active).length > 1)
      throw new HttpError(409, 'AMBIGUOUS_SCOPE', 'Resolve multiple active Flight memberships before changing the Directory.');
    before = { profile: existing ?? null, memberships };
    scopes = [...new Set([existing?.flightId, ...memberships.filter(m => m.active).map(m => m.flightId), p.flightId].filter((v): v is string => !!v))].sort();
    // Guard both the profile version and membership topology captured before authorization.
    condition = `COALESCE((SELECT version FROM directory_profiles WHERE person_id=?),0)=? AND
   (SELECT json_group_array(json_object('flightId',unit_id,'active',active)) FROM
    (SELECT unit_id,active FROM memberships WHERE person_id=? ORDER BY unit_id))=?
   AND (? IS NULL OR EXISTS(SELECT 1 FROM flight_hierarchy WHERE unit_id=?))`;
    conditionValues = [p.personId, p.expectedVersion, p.personId, JSON.stringify(memberships), p.flightId, p.flightId];
    writes.push(stmt(env.DB, `INSERT INTO people(person_id,display_name) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET display_name=excluded.display_name`, p.personId, `${p.profile.lastName}, ${p.profile.firstName}`));
    const columns = ['person_id', 'version', 'flight_id', ...profileColumns, 'updated_at'];
    writes.push(stmt(env.DB, `INSERT INTO directory_profiles(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})
   ON CONFLICT(person_id) DO UPDATE SET ${columns.slice(1).map(k => `${k}=excluded.${k}`).join(',')}`, p.personId, p.expectedVersion + 1, p.flightId, ...DIRECTORY_FIELDS.map(k => p.profile[k]), now));
    // Preserve old membership rows and evidence. Deactivation and transfer never delete attendance or requests.
    writes.push(stmt(env.DB, 'UPDATE memberships SET active=0 WHERE person_id=?', p.personId));
    if (p.flightId !== null)
      writes.push(stmt(env.DB, `INSERT INTO memberships(person_id,unit_id,active) VALUES(?,?,?)
   ON CONFLICT(person_id,unit_id) DO UPDATE SET active=excluded.active`, p.personId, p.flightId, operationallyActive(p.profile) ? 1 : 0));
    writes.push(stmt(env.DB, `UPDATE organizational_units SET roster_version=roster_version+1 WHERE unit_id IN (SELECT value FROM json_each(?))`, JSON.stringify(scopes)));
    writes.push(stmt(env.DB, `INSERT INTO directory_membership_history(command_id,person_id,previous_flight_id,flight_id,active,accepted_at) VALUES(?,?,?,?,?,?)`, c.commandId, p.personId, existing?.flightId ?? memberships.find(m => m.active)?.flightId ?? null, p.flightId, operationallyActive(p.profile) ? 1 : 0, now));
  }
  else if (c.operation === 'leadership.upsert') {
    const p = c.payload;
    targetId = p.contactId;
    capability = 'leadership.manage';
    before = await stmt(env.DB, 'SELECT * FROM leadership_contacts WHERE contact_id=?', p.contactId).first();
    condition = `COALESCE((SELECT version FROM leadership_contacts WHERE contact_id=?),0)=? AND
   NOT EXISTS(SELECT 1 FROM leadership_contacts WHERE contact_id=? AND person_id IS NOT ?) AND
   (? IS NULL OR EXISTS(SELECT 1 FROM directory_profiles WHERE person_id=?))`;
    conditionValues = [p.contactId, p.expectedVersion, p.contactId, p.personId, p.personId, p.personId];
    const profile = p.profile ?? { lastName: '', firstName: '', rank: '', role: '', email: '', cellPhone: '' };
    writes.push(stmt(env.DB, `INSERT INTO leadership_contacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(contact_id) DO UPDATE SET version=excluded.version,last_name=excluded.last_name,first_name=excluded.first_name,
   rank=excluded.rank,role=excluded.role,email=excluded.email,cell_phone=excluded.cell_phone,reports_to=excluded.reports_to,
   office_phone=excluded.office_phone,office_location=excluded.office_location,active=excluded.active,updated_at=excluded.updated_at`, p.contactId, p.expectedVersion + 1, p.personId, profile.lastName, profile.firstName, profile.rank, profile.role, profile.email, profile.cellPhone, p.reportsTo, p.officePhone, p.officeLocation, p.active ? 1 : 0, now));
  }
  else {
    const p = c.payload;
    targetId = p.eventId;
    capability = 'events.manage';
    const current = await env.DB.batch<Record<string, unknown>>([
      stmt(env.DB, 'SELECT e.label,e.active,d.* FROM events e LEFT JOIN event_details d ON d.event_id=e.event_id WHERE e.event_id=?', p.eventId),
      stmt(env.DB, 'SELECT unit_id AS flightId FROM event_units WHERE event_id=? ORDER BY unit_id', p.eventId),
    ]);
    before = { event: current[0].results[0] ?? null, flights: current[1].results };
    condition = `COALESCE((SELECT version FROM event_details WHERE event_id=?),0)=? AND
   EXISTS(SELECT 1 FROM terms WHERE term_id=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM flight_hierarchy WHERE unit_id=f.value))
   AND NOT EXISTS(SELECT 1 FROM event_details WHERE event_id=? AND term_id<>?)`;
    conditionValues = [p.eventId, p.expectedVersion, p.termId, JSON.stringify(p.flightIds), p.eventId, p.termId];
    writes.push(stmt(env.DB, 'INSERT INTO events VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET label=excluded.label,active=excluded.active', p.eventId, p.label, p.status === 'active' ? 1 : 0));
    writes.push(stmt(env.DB, `INSERT INTO event_details VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET
   version=excluded.version,event_type=excluded.event_type,training_week=excluded.training_week,display_order=excluded.display_order,
   column_label=excluded.column_label,expected_group=excluded.expected_group,status=excluded.status,start_at=excluded.start_at,
   end_at=excluded.end_at,location=excluded.location,notes=excluded.notes,updated_at=excluded.updated_at`, p.eventId, p.expectedVersion + 1, p.termId, p.eventType, p.trainingWeek, p.displayOrder, p.columnLabel, p.expectedGroup, p.status, p.startAt, p.endAt, p.location, p.notes, now, c.actor.principalId, now));
    writes.push(stmt(env.DB, 'DELETE FROM event_units WHERE event_id=?', p.eventId));
    writes.push(stmt(env.DB, 'INSERT INTO event_units(event_id,unit_id) SELECT ?,value FROM json_each(?)', p.eventId, JSON.stringify(p.flightIds)));
  }
  const auth = commandAuth(env, c, capability, scopes);
  const allowed = await stmt(env.DB, `SELECT (${auth.sql}) AS allowed`, ...auth.values).first<{
    allowed: number;
  }>();
  if (allowed?.allowed !== 1)
    throw new HttpError(403, 'NOT_AUTHORIZED', 'The actor, source or operation is not currently authorized.');
  const receipt: Receipt = { commandId: c.commandId, status: 'committed', operation: c.operation, result: { targetId, version: c.payload.expectedVersion + 1 }, pendingEffects: true };
  const effects = (c.operation === 'leadership.upsert' ? ['frontend.refresh'] : ['frontend.refresh', 'forms.refresh']).map(kind => ({ effectId: crypto.randomUUID(), kind }));
  try {
    await env.DB.batch<Record<string, unknown>>([
      stmt(env.DB, `INSERT INTO command_assertions(command_id,ok) VALUES(?,(${auth.sql}) AND (${condition}) AND NOT EXISTS(SELECT 1 FROM operation_commands WHERE command_id=?))`, c.commandId, ...auth.values, ...conditionValues, c.commandId),
      stmt(env.DB, `INSERT INTO admin_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.commandId, hash, c.actor.principalId, c.operation, targetId, capability, JSON.stringify(scopes), c.source.kind, c.source.resourceKey, c.source.submissionId, c.source.revision, now, JSON.stringify(receipt)),
      ...writes,
      stmt(env.DB, `INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)`, c.commandId, c.actor.principalId, c.actor.evidence, c.operation, targetId, now, JSON.stringify(before), JSON.stringify(c.payload)),
      stmt(env.DB, `INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) SELECT json_extract(value,'$.effectId'),?,json_extract(value,'$.kind'),'pending',? FROM json_each(?)`, c.commandId, now, JSON.stringify(effects)),
      stmt(env.DB, 'DELETE FROM command_assertions WHERE command_id=?', c.commandId),
    ]);
  }
  catch {
    const raced = await priorReceipt(env, c, hash);
    if (raced)
      return raced;
    throw new HttpError(409, 'ADMIN_CONFLICT', 'The record, authority or source changed. Reload and review before retrying.');
  }
  return receipt;
}
interface ReadInput {
  environment: string;
  generation: number;
  principalId: string;
}
function readInput(input: unknown, env: AdminEnv, extra: string[] = []): ReadInput & Record<string, string | number> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, 'INVALID_ADMIN_REQUEST', 'Expected a bounded administrative request.');
  const row = input as Record<string, unknown>;
  const keys = ['environment', 'generation', 'principalId', ...extra];
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.environment !== env.ENVIRONMENT || row.generation !== Number(env.GENERATION))
    throw new HttpError(400, 'INVALID_ADMIN_REQUEST', 'Invalid request fields or environment.');
  for (const key of ['principalId', ...extra])
    adminIdentifier(row[key], key);
  return row as ReadInput & Record<string, string | number>;
}
const readerGuard = (env: AdminEnv, principalId: string, write = false) => {
  const p = permission(principalId, 'frontend.read', []);
  return { sql: `${control(write)} AND ${p.sql}`, values: [env.ENVIRONMENT, Number(env.GENERATION), ...p.values] };
};
export async function frontendSnapshot(env: AdminEnv, input: unknown): Promise<FrontendSnapshot> {
  const req = readInput(input, env);
  const guard = readerGuard(env, req.principalId);
  const bounds = [0, 0, 500, 200, 50, 20, 20, 200, 10000, 10000, 5000, 0];
  const results = await env.DB.batch<Record<string, unknown>>([
    stmt(env.DB, `SELECT (${guard.sql}) AS allowed`, ...guard.values),
    stmt(env.DB, `SELECT (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration`),
    stmt(env.DB, `${profileProjection} ORDER BY d.person_id LIMIT 501`),
    stmt(env.DB, `SELECT contact_id AS contactId,version,person_id AS personId,last_name AS lastName,first_name AS firstName,rank,role,email,cell_phone AS cellPhone,reports_to AS reportsTo,office_phone AS officePhone,office_location AS officeLocation,active FROM leadership_contacts ORDER BY contact_id LIMIT 201`),
    stmt(env.DB, `SELECT u.unit_id AS flightId,u.label,h.squadron_id AS squadronId,u.roster_version AS rosterVersion FROM organizational_units u LEFT JOIN flight_hierarchy h ON h.unit_id=u.unit_id ORDER BY u.unit_id LIMIT 51`),
    stmt(env.DB, 'SELECT squadron_id AS squadronId,label FROM squadrons ORDER BY squadron_id LIMIT 21'),
    stmt(env.DB, 'SELECT term_id AS termId,label,sort_order AS sortOrder,is_current AS isCurrent FROM terms ORDER BY sort_order LIMIT 21'),
    stmt(env.DB, `SELECT e.event_id AS eventId,d.version,d.term_id AS termId,d.event_type AS eventType,d.training_week AS trainingWeek,d.display_order AS displayOrder,e.label,d.column_label AS columnLabel,d.expected_group AS expectedGroup,d.status,d.start_at AS startAt,d.end_at AS endAt,d.location,d.notes FROM events e JOIN event_details d ON d.event_id=e.event_id ORDER BY d.display_order,e.event_id LIMIT 201`),
    stmt(env.DB, 'SELECT event_id AS eventId,unit_id AS flightId FROM event_units ORDER BY event_id,unit_id LIMIT 10001'),
    stmt(env.DB, `SELECT 'observation:'||o.observation_id AS factId,o.person_id AS personId,o.event_id AS eventId,a.audit_id AS 'order',o.code FROM attendance_observations o JOIN attendance_reports r ON r.report_id=o.report_id JOIN audit_events a ON a.command_id=r.command_id ORDER BY o.observation_id LIMIT 10001`),
    stmt(env.DB, `SELECT r.request_id AS requestId,r.person_id AS personId,r.event_id AS eventId,r.unit_id AS flightId,a.audit_id AS 'order',r.status,r.requested_outcome AS requestedOutcome,r.version FROM excusal_requests r JOIN audit_events a ON a.command_id=r.last_command_id ORDER BY r.request_id LIMIT 5001`),
    stmt(env.DB, `SELECT (SELECT COUNT(*) FROM people p WHERE NOT EXISTS(SELECT 1 FROM directory_profiles d WHERE d.person_id=p.person_id)) AS peopleMissingProfiles,
   (SELECT COUNT(*) FROM events e WHERE NOT EXISTS(SELECT 1 FROM event_details d WHERE d.event_id=e.event_id)) AS eventsMissingDetails`),
  ]);
  if (results[0].results[0]?.allowed !== 1)
    throw new HttpError(403, 'NOT_AUTHORIZED', 'A current Wing frontend read grant is required.');
  if (results.some((r, i) => bounds[i] > 0 && r.results.length > bounds[i]))
    throw new HttpError(409, 'SNAPSHOT_TOO_LARGE', 'This snapshot exceeds its reviewed bounds. Use a reviewed term-scoped export.');
  const people = (results[2].results as unknown as DirectoryRecord[]).map(p => ({ ...p, active: operationallyActive(p) }));
  const flights = results[4].results as unknown as FrontendSnapshot['flights'];
  const squadrons = results[5].results as unknown as FrontendSnapshot['squadrons'];
  const contacts = results[3].results as unknown as (Omit<LeadershipRecord, 'active'> & {
    active: number;
  })[];
  const leadership: LeadershipRecord[] = contacts.filter(c => c.personId === null).map(c => ({ ...c, active: !!c.active }));
  const contactsByPerson = new Map(contacts.filter(c => c.personId !== null).map(c => [c.personId, c]));
  const flightsById = new Map(flights.map(f => [f.flightId, f]));
  const squadsById = new Map(squadrons.map(s => [s.squadronId, s]));
  for (const p of people) {
    if (!p.active)
      continue;
    const f = p.flightId ? flightsById.get(p.flightId) : undefined;
    const role = directoryLeadershipRole(p.role, f?.label ?? '', f?.squadronId ? squadsById.get(f.squadronId)?.label ?? '' : '');
    if (!role)
      continue;
    const contact = contactsByPerson.get(p.personId);
    leadership.push({ contactId: contact?.contactId ?? `cadet:${p.personId}`, version: contact?.version ?? 0, personId: p.personId, lastName: p.lastName, firstName: p.firstName, rank: p.rank, role, email: p.email, cellPhone: p.phone, reportsTo: contact?.reportsTo ?? '', officePhone: contact?.officePhone ?? '', officeLocation: contact?.officeLocation ?? '', active: contact ? !!contact.active : true });
  }
  const counts = results[11].results[0];
  const diagnostics = [{ code: 'PEOPLE_MISSING_PROFILES', count: Number(counts.peopleMissingProfiles) }, { code: 'EVENTS_MISSING_DETAILS', count: Number(counts.eventsMissingDetails) },
    { code: 'FLIGHTS_MISSING_SQUADRON', count: flights.filter(f => f.squadronId === null).length }].filter(d => d.count > 0);
  return { contractVersion: 1, environment: req.environment as 'local' | 'staging', generation: req.generation, revision: results[1].results[0] as unknown as FrontendSnapshot['revision'], people, leadership, flights, squadrons,
    terms: results[6].results.map(t => ({ ...t, isCurrent: !!t.isCurrent })) as unknown as FrontendSnapshot['terms'], events: results[7].results as unknown as FrontendSnapshot['events'], eventFlights: results[8].results as unknown as FrontendSnapshot['eventFlights'], observations: results[9].results as unknown as FrontendSnapshot['observations'], requests: results[10].results as unknown as FrontendSnapshot['requests'], diagnostics };
}
export async function getAdminReceipt(env: AdminEnv, url: URL): Promise<unknown> {
  const id = adminIdentifier(url.pathname.slice('/v1/admin/commands/'.length));
  const principal = adminIdentifier(url.searchParams.get('principalId'));
  if ([...url.searchParams.keys()].some(k => k !== 'principalId') || url.searchParams.getAll('principalId').length !== 1)
    throw new HttpError(400, 'INVALID_RECEIPT_QUERY', 'Specify a command and principal.');
  // Authorize in SQL against the stored command scopes and current grants, not a cached role.
  const row = await stmt(env.DB, `SELECT c.receipt_json AS receipt FROM admin_commands c JOIN principals p ON p.principal_id=c.actor_id
  WHERE c.command_id=? AND c.actor_id=? AND p.active=1 AND ${control()} AND
  EXISTS(SELECT 1 FROM adapter_sources s WHERE s.source_kind=c.source_kind AND s.resource_key=c.source_resource AND s.active=1) AND (
   EXISTS(SELECT 1 FROM admin_grants g WHERE g.principal_id=c.actor_id AND g.capability=c.capability AND g.scope_kind='wing' AND g.scope_key='*') OR
   (json_array_length(c.scopes_json)>0 AND NOT EXISTS(SELECT 1 FROM json_each(c.scopes_json) s WHERE NOT EXISTS(
    SELECT 1 FROM admin_grants g WHERE g.principal_id=c.actor_id AND g.capability=c.capability AND g.scope_kind='flight' AND g.scope_key=s.value))))`, id, principal, env.ENVIRONMENT, Number(env.GENERATION)).first<{
    receipt: string;
  }>();
  if (!row)
    throw new HttpError(404, 'NOT_FOUND', 'The requested receipt is unavailable.');
  return JSON.parse(row.receipt);
}
export async function adminEffect(env: AdminEnv, action: 'claim' | 'project' | 'ack', input: unknown): Promise<unknown> {
  const req = readInput(input, env, action === 'claim' ? ['workerId', 'kind'] : ['workerId', 'effectId', 'claimToken']);
  const guard = readerGuard(env, req.principalId, true);
  const now = new Date().toISOString();
  if (action === 'claim') {
    if (!['frontend.refresh', 'forms.refresh'].includes(String(req.kind)))
      throw new HttpError(400, 'INVALID_ADMIN_REQUEST', 'Unsupported refresh effect kind.');
    const effect = await stmt(env.DB, `UPDATE admin_effects SET state='leased',worker_id=?,claim_token=?,lease_expires_at=?
   WHERE effect_id=(SELECT j.effect_id FROM admin_effects j WHERE j.state='pending' AND j.kind=? AND ${guard.sql}
    AND NOT EXISTS(SELECT 1 FROM admin_effects l WHERE l.kind=j.kind AND l.state='leased') ORDER BY j.created_at,j.effect_id LIMIT 1)
   RETURNING effect_id AS effectId,kind,claim_token AS claimToken,lease_expires_at AS leaseExpiresAt`, req.workerId, crypto.randomUUID(), new Date(Date.now() + 600000).toISOString(), req.kind, ...guard.values).first();
    return { effect };
  }
  const lease = `effect_id=? AND worker_id=? AND claim_token=? AND state='leased' AND lease_expires_at>? AND ${guard.sql}`;
  const values = [req.effectId, req.workerId, req.claimToken, now, ...guard.values];
  if (action === 'ack') {
    const result = await stmt(env.DB, `UPDATE admin_effects SET state='done',completed_at=? WHERE ${lease} RETURNING effect_id`, now, ...values).first();
    if (!result)
      throw new HttpError(409, 'LEASE_CONFLICT', 'The effect lease is no longer current.');
    return { acknowledged: true };
  }
  const effect = await stmt(env.DB, `SELECT effect_id AS effectId,kind FROM admin_effects WHERE ${lease}`, ...values).first();
  if (!effect)
    throw new HttpError(409, 'LEASE_CONFLICT', 'The effect lease is no longer current.');
  const snapshot = await frontendSnapshot(env, { environment: req.environment, generation: req.generation, principalId: req.principalId });
  // A pause/revocation or lease expiry during the snapshot must not authorize publication.
  if (!await stmt(env.DB, `SELECT effect_id FROM admin_effects WHERE ${lease}`, req.effectId, req.workerId, req.claimToken, new Date().toISOString(), ...guard.values).first())
    throw new HttpError(409, 'LEASE_CONFLICT', 'The effect lease is no longer current.');
  return { effect, snapshot };
}
