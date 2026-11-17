/** One reviewed policy or one queued future-event refresh per atomic D1 transaction. */
import {EVENT_ROSTER_POLICY,operationalFlight} from '../../../packages/domain/src/event-rosters.js';
import {effectiveAdminGrants} from './permission-grants.js';
import {HttpError} from './http-error.js';
interface Env{DB:D1Database;ENVIRONMENT:string;GENERATION:string}
type Value=string|number|null;
const stmt=(db:D1Database,sql:string,...args:Value[])=>db.prepare(sql).bind(...args);
const digest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function fail(status:number,code:string,message='Review the future event roster before retrying.'):never{throw new HttpError(status,code,message);}
function object(value:unknown,keys:string[]):Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(400,'INVALID_ROSTER_REQUEST');return value as Record<string,any>;}
function context(env:Env,r:Record<string,any>){if(r.environment!==env.ENVIRONMENT||r.generation!==Number(env.GENERATION)||!identifier(r.principalId))fail(400,'INVALID_ROSTER_REQUEST');}
function authority(env:Env,principalId:string,write=false,source?:{kind:string;resourceKey:string}){
  return {sql:`EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?${write?' AND accepting_commands=1':''})
    AND EXISTS(SELECT 1 FROM principals p JOIN ${effectiveAdminGrants} g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND g.capability='events.manage' AND g.scope_kind='wing' AND g.scope_key='*')${source?' AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind=? AND resource_key=? AND active=1)':''}`,
    values:[env.ENVIRONMENT,Number(env.GENERATION),principalId,...(source?[source.kind,source.resourceKey]:[])] as Value[]};
}
const revisions=`SELECT (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration`;
/** Directory changes coalesce into one work item per future managed event, never a full matrix rewrite. */
export function markManagedFutureRosters(db:D1Database,commandId:string,now:string,flightIds:readonly string[]):D1PreparedStatement{
  return stmt(db,`INSERT INTO event_roster_refresh_work(event_id,cause_command_id,requested_at)
    SELECT p.event_id,?,? FROM event_roster_policies p JOIN event_details d ON d.event_id=p.event_id JOIN events e ON e.event_id=d.event_id
    WHERE p.enabled=1 AND d.status='active' AND e.active=1 AND julianday(d.start_at)>julianday(?)
      AND EXISTS(SELECT 1 FROM json_each(p.selected_flight_ids_json) f WHERE f.value IN(SELECT value FROM json_each(?)))
    ON CONFLICT(event_id) DO UPDATE SET cause_command_id=excluded.cause_command_id,requested_at=excluded.requested_at`,commandId,now,now,JSON.stringify(flightIds));
}
interface Member{personId:string;flightId:string;lastName:string;firstName:string;asYear:string;flightPathStatus:string;dateOfBirth:string|null;}
interface Plan{eventId:string;label:string;eventVersion:number;policyVersion:number;mode:'enable'|'refresh'|'disable';basisAt:string;startAt:string|null;policy:typeof EVENT_ROSTER_POLICY;
  revision:{operations:number;administration:number};selectedFlightIds:string[];currentFlightIds:string[];flightIds:string[];before:Member[];after:Member[];causeCommandId:string|null;
  changes:{added:string[];removed:string[];transferred:string[];profileChanged:string[];removedWithEvidence:string[]};}
// An unrelated accepted command may advance global revisions without changing this
// reviewed event. Recompute semantic intent on apply, then guard its new read revision.
const reviewHash=(plan:Plan)=>{const {revision,...reviewed}=plan;return digest(reviewed);};
async function prepare(env:Env,principalId:string,eventId:string,mode:Plan['mode'],basisAt:string,now:string):Promise<Plan>{
  if(!identifier(eventId)||!['enable','refresh','disable'].includes(mode)||!Number.isFinite(Date.parse(basisAt))||new Date(basisAt).toISOString()!==basisAt||Date.parse(basisAt)>Date.parse(now)||Date.parse(now)-Date.parse(basisAt)>15*60000)fail(400,'INVALID_ROSTER_REQUEST');
  const auth=authority(env,principalId),results=await env.DB.batch<Record<string,any>>([
    stmt(env.DB,`SELECT (${auth.sql}) AS allowed`,...auth.values),stmt(env.DB,revisions),
    stmt(env.DB,'SELECT d.event_id AS eventId,d.version,d.event_type AS type,d.status,d.start_at AS startAt,e.label,e.active FROM event_details d JOIN events e ON e.event_id=d.event_id WHERE d.event_id=?',eventId),
    stmt(env.DB,'SELECT p.version,p.enabled,p.policy,p.selected_flight_ids_json FROM event_roster_policies p WHERE p.event_id=?',eventId),
    stmt(env.DB,`SELECT u.unit_id AS flightId,u.label,EXISTS(SELECT 1 FROM event_units current WHERE current.event_id=? AND current.unit_id=u.unit_id) AS currentlySelected FROM organizational_units u WHERE u.unit_id IN(SELECT value FROM json_each(COALESCE((SELECT selected_flight_ids_json FROM event_roster_policies WHERE event_id=?),(SELECT json_group_array(unit_id) FROM event_units WHERE event_id=?)))) ORDER BY u.unit_id LIMIT 51`,eventId,eventId,eventId),
    stmt(env.DB,`SELECT d.person_id AS personId,d.flight_id AS flightId,d.last_name AS lastName,d.first_name AS firstName,d.as_year AS asYear,d.flight_path_status AS flightPathStatus,d.date_of_birth AS dateOfBirth,
      (SELECT COUNT(*) FROM memberships m WHERE m.person_id=d.person_id AND m.active=1) AS activeMemberships
      FROM directory_profiles d WHERE d.flight_id IN(SELECT value FROM json_each(COALESCE((SELECT selected_flight_ids_json FROM event_roster_policies WHERE event_id=?),(SELECT json_group_array(unit_id) FROM event_units WHERE event_id=?)))) AND d.flight_path_status NOT IN('Inactive','Commissioned','Dropped')
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1) ORDER BY d.person_id LIMIT 501`,eventId,eventId),
    stmt(env.DB,`SELECT m.person_id AS personId,m.flight_id AS flightId,m.last_name AS lastName,m.first_name AS firstName,m.as_year AS asYear,m.flight_path_status AS flightPathStatus,m.date_of_birth AS dateOfBirth
      FROM event_roster_members m JOIN event_details d ON d.event_id=m.event_id AND d.version=m.version WHERE m.event_id=? ORDER BY m.person_id LIMIT 501`,eventId),
    stmt(env.DB,`SELECT person_id AS personId FROM attendance_observations WHERE event_id=? UNION SELECT person_id FROM excusal_records WHERE event_id=? UNION SELECT person_id FROM attendance_corrections WHERE event_id=? UNION SELECT person_id FROM legacy_attendance_baselines WHERE event_id=? LIMIT 501`,eventId,eventId,eventId,eventId),
    stmt(env.DB,'SELECT cause_command_id AS causeCommandId FROM event_roster_refresh_work WHERE event_id=?',eventId),
  ]);
  if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED','Current Wing event-management authority is required.');const event=results[2].results[0],policy=results[3].results[0];
  if(!event)fail(404,'EVENT_NOT_FOUND');if(results[4].results.length>50||results[5].results.length>500||results[6].results.length>500||results[7].results.length>500)fail(409,'ROSTER_CAPACITY');
  if(mode!=='disable'&&(event.status!=='active'||event.active!==1||!event.startAt||Date.parse(event.startAt)<=Date.parse(now)))fail(409,'EVENT_ROSTER_NOT_FUTURE','Automatic roster refresh cannot rewrite a started, undated or inactive event.');
  if(mode!=='enable'&&(!policy||mode==='refresh'&&policy.enabled!==1))fail(409,'ROSTER_POLICY_NOT_ENABLED');
  if(results[5].results.some(p=>p.activeMemberships!==1))fail(409,'AMBIGUOUS_SCOPE');
  const selectedFlightIds=results[4].results.map(f=>String(f.flightId)),flightIds=results[4].results.filter(f=>event.type==='other'||operationalFlight(f.label)).map(f=>String(f.flightId));if(mode!=='disable'&&!flightIds.length)fail(409,'ROSTER_NO_OPERATIONAL_FLIGHTS');
  const before=results[6].results as Member[],after=mode==='disable'?before:results[5].results.filter(p=>flightIds.includes(p.flightId)).map(({activeMemberships,...p})=>p as Member),old=new Map(before.map(p=>[p.personId,p])),next=new Map(after.map(p=>[p.personId,p]));
  const removed=before.filter(p=>!next.has(p.personId)).map(p=>p.personId),evidence=new Set(results[7].results.map(r=>r.personId));
  return {eventId,label:event.label,eventVersion:event.version,policyVersion:policy?.version??0,mode,basisAt,startAt:event.startAt,policy:EVENT_ROSTER_POLICY,revision:results[1].results[0] as Plan['revision'],selectedFlightIds,currentFlightIds:results[4].results.filter(f=>f.currentlySelected===1).map(f=>String(f.flightId)),flightIds,before,after,causeCommandId:results[8].results[0]?.causeCommandId??null,
    changes:{added:after.filter(p=>!old.has(p.personId)).map(p=>p.personId),removed,transferred:after.filter(p=>old.has(p.personId)&&old.get(p.personId)!.flightId!==p.flightId).map(p=>p.personId),profileChanged:after.filter(p=>old.has(p.personId)&&JSON.stringify(old.get(p.personId))!==JSON.stringify(p)).map(p=>p.personId),removedWithEvidence:removed.filter(id=>evidence.has(id))}};
}
export async function previewEventRoster(env:Env,input:unknown){const r=object(input,['environment','generation','principalId','eventId','mode']);context(env,r);const now=new Date().toISOString(),plan=await prepare(env,r.principalId,r.eventId,r.mode,now,now);return {contractVersion:1,...plan,previewHash:await reviewHash(plan),preservesHistoricalVersions:true,preservesAttendanceEvidence:true};}
interface Command {commandId:string;contractVersion:1;environment:string;generation:number;actor:{principalId:string;evidence:string};source:{kind:string;resourceKey:string;submissionId:string;revision:number};operation:'event.roster.apply'|'event.roster.refresh';payload:{eventId:string;mode:Plan['mode'];basisAt:string;previewHash:string};}
function parseCommand(env:Env,input:unknown):Command{const r=object(input,['commandId','contractVersion','environment','generation','actor','source','operation','payload']),a=object(r.actor,['principalId','evidence']),s=object(r.source,['kind','resourceKey','submissionId','revision']),p=object(r.payload,['eventId','mode','basisAt','previewHash']);
  context(env,{...r,principalId:a.principalId});if(!identifier(r.commandId)||r.contractVersion!==1||r.operation!=='event.roster.apply'||!['google-edit','authenticated-confirmation'].includes(a.evidence)||!['sheet','test'].includes(s.kind)||!identifier(s.resourceKey)||!identifier(s.submissionId)||!Number.isSafeInteger(s.revision)||s.revision<1||!identifier(p.eventId)||!['enable','refresh','disable'].includes(p.mode)||typeof p.basisAt!=='string'||typeof p.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(p.previewHash))fail(400,'INVALID_ROSTER_REQUEST');return r as Command;}
async function existingReceipt(env:Env,c:Command,hash:string){const auth=authority(env,c.actor.principalId,true,c.source),results=await env.DB.batch<Record<string,any>>([stmt(env.DB,`SELECT (${auth.sql}) AS allowed`,...auth.values),stmt(env.DB,'SELECT payload_hash AS hash,actor_id AS actorId,receipt_json AS receipt FROM admin_commands WHERE command_id=?',c.commandId)]);if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');const known=results[1].results[0];if(!known)return null;if(known.hash!==hash||known.actorId!==c.actor.principalId)fail(409,'COMMAND_ID_CONFLICT');return JSON.parse(known.receipt);}
async function commit(env:Env,c:Command,plan:Plan,hash:string,now:string){
  const auth=authority(env,c.actor.principalId,true,c.source),changed=plan.mode!=='disable'&&(plan.mode==='enable'||JSON.stringify(plan.currentFlightIds)!==JSON.stringify(plan.flightIds)||Object.values(plan.changes).some(rows=>rows.length));
  const version=plan.eventVersion+(changed?1:0),policyVersion=plan.policyVersion+(plan.mode==='refresh'?0:1),receipt={commandId:c.commandId,status:'committed',operation:c.operation,result:{targetId:plan.eventId,version,policyVersion,changes:plan.changes},pendingEffects:true};
  const condition=`EXISTS(SELECT 1 FROM event_details WHERE event_id=? AND version=?${plan.mode!=='disable'?" AND status='active' AND julianday(start_at)>julianday(?)":''})
    AND COALESCE((SELECT version FROM event_roster_policies WHERE event_id=?),0)=?
    AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=? AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=?
    AND COALESCE((SELECT cause_command_id FROM event_roster_refresh_work WHERE event_id=?),'')=?`;
  const values:Value[]=[plan.eventId,plan.eventVersion,...(plan.mode!=='disable'?[now]:[]),plan.eventId,plan.policyVersion,plan.revision.administration,plan.revision.operations,plan.eventId,plan.causeCommandId??''];
  const writes:D1PreparedStatement[]=[];
  if(plan.mode==='refresh')writes.push(stmt(env.DB,'UPDATE event_roster_policies SET last_refreshed_at=? WHERE event_id=?',now,plan.eventId));
  else writes.push(stmt(env.DB,`INSERT INTO event_roster_policies VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,selected_flight_ids_json=excluded.selected_flight_ids_json,approved_command_id=excluded.approved_command_id,approved_actor_id=excluded.approved_actor_id,approved_at=excluded.approved_at,last_refreshed_at=excluded.last_refreshed_at`,plan.eventId,policyVersion,EVENT_ROSTER_POLICY,plan.mode==='disable'?0:1,JSON.stringify(plan.selectedFlightIds),c.commandId,c.actor.principalId,now,now));
  if(changed){writes.push(stmt(env.DB,'UPDATE event_details SET version=?,updated_at=? WHERE event_id=?',version,now,plan.eventId),stmt(env.DB,'INSERT INTO event_roster_versions VALUES(?,?,?,?)',plan.eventId,version,c.commandId,now),
      stmt(env.DB,`INSERT INTO event_roster_members SELECT ?,?,json_extract(value,'$.personId'),json_extract(value,'$.flightId'),json_extract(value,'$.lastName'),json_extract(value,'$.firstName'),json_extract(value,'$.asYear'),json_extract(value,'$.flightPathStatus'),json_extract(value,'$.dateOfBirth') FROM json_each(?)`,plan.eventId,version,JSON.stringify(plan.after)),
      stmt(env.DB,'DELETE FROM event_units WHERE event_id=?',plan.eventId),stmt(env.DB,'INSERT INTO event_units SELECT ?,value FROM json_each(?)',plan.eventId,JSON.stringify(plan.flightIds)));}
  writes.push(stmt(env.DB,'DELETE FROM event_roster_refresh_work WHERE event_id=?',plan.eventId));
  const effects=await Promise.all(['frontend.refresh','forms.refresh'].map(async kind=>({kind,effectId:'roster-effect.'+await digest([c.commandId,kind])})));
  try{await env.DB.batch([
    stmt(env.DB,`INSERT INTO command_assertions VALUES(?,(${auth.sql}) AND (${condition}))`,c.commandId,...auth.values,...values),stmt(env.DB,"INSERT INTO command_registry VALUES(?,'admin')",c.commandId),
    stmt(env.DB,`INSERT INTO admin_commands VALUES(?,?,?,?,?,'events.manage','[]',?,?,?,?,?,?)`,c.commandId,hash,c.actor.principalId,c.operation,plan.eventId,c.source.kind,c.source.resourceKey,c.source.submissionId,c.source.revision,now,JSON.stringify(receipt)),...writes,
    stmt(env.DB,`INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)`,c.commandId,c.actor.principalId,c.actor.evidence,c.operation,plan.eventId,now,JSON.stringify({eventVersion:plan.eventVersion,policyVersion:plan.policyVersion,roster:plan.before}),JSON.stringify({version,policyVersion,policy:EVENT_ROSTER_POLICY,enabled:plan.mode!=='disable',selectedFlightIds:plan.selectedFlightIds,flightIds:plan.flightIds,roster:plan.after,causeCommandId:plan.causeCommandId,changes:plan.changes})),
    stmt(env.DB,"INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) SELECT json_extract(value,'$.effectId'),?,json_extract(value,'$.kind'),'pending',? FROM json_each(?)",c.commandId,now,JSON.stringify(effects)),stmt(env.DB,'DELETE FROM command_assertions WHERE command_id=?',c.commandId),
  ]);}catch{const known=await existingReceipt(env,c,hash);if(known)return known;fail(409,'EVENT_ROSTER_CONFLICT','The event, roster, authority or source changed. Reload its preview.');}return receipt;
}
export async function applyEventRoster(env:Env,input:unknown){const c=parseCommand(env,input),hash=await digest(c),known=await existingReceipt(env,c,hash);if(known)return known;const now=new Date().toISOString(),plan=await prepare(env,c.actor.principalId,c.payload.eventId,c.payload.mode,c.payload.basisAt,now);if(await reviewHash(plan)!==c.payload.previewHash)fail(409,'EVENT_ROSTER_PREVIEW_CHANGED');return commit(env,c,plan,hash,now);}
/** The configured service principal is the actor; the approving policy and initiating Directory command are explicit audit provenance. */
export async function refreshEventRoster(env:Env,input:unknown){const r=object(input,['environment','generation','principalId','sourceResource']);context(env,r);if(!identifier(r.sourceResource))fail(400,'INVALID_ROSTER_REQUEST');const auth=authority(env,r.principalId,true,{kind:'sheet',resourceKey:r.sourceResource}),results=await env.DB.batch<Record<string,any>>([
  stmt(env.DB,`SELECT (${auth.sql}) AS allowed`,...auth.values),stmt(env.DB,`SELECT w.event_id AS eventId FROM event_roster_refresh_work w JOIN event_details d ON d.event_id=w.event_id ORDER BY d.start_at,w.event_id LIMIT 1`),stmt(env.DB,'SELECT COUNT(*) AS pending FROM event_roster_refresh_work')]);
  if(results[0].results[0]?.allowed!==1)fail(403,'NOT_AUTHORIZED');const pending=Number(results[2].results[0].pending),event=results[1].results[0];if(!event)return {state:'idle',pending:0};
  const now=new Date().toISOString();let plan:Plan;try{plan=await prepare(env,r.principalId,event.eventId,'refresh',now,now);}catch(error){if(error instanceof HttpError&&['EVENT_ROSTER_NOT_FUTURE','ROSTER_POLICY_NOT_ENABLED'].includes(error.code))return {state:'review-required',eventId:event.eventId,pending};throw error;}
  const commandId='roster.'+await digest([plan.eventId,plan.eventVersion,plan.policyVersion,plan.causeCommandId]),c:Command={commandId,contractVersion:1,environment:env.ENVIRONMENT,generation:Number(env.GENERATION),actor:{principalId:r.principalId,evidence:'policy-automation'},source:{kind:'sheet',resourceKey:r.sourceResource,submissionId:commandId,revision:1},operation:'event.roster.refresh',payload:{eventId:plan.eventId,mode:'refresh',basisAt:now,previewHash:await digest(plan)}};
  await commit(env,c,plan,await digest(c),now);return {state:'refreshed',eventId:plan.eventId,pending:Math.max(0,pending-1)};
}
