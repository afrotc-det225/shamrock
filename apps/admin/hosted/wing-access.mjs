import {PanelError} from "../errors.mjs";
import {isUnifiedSite} from "./site.mjs";

// Explicit day-to-day Wing capabilities. Permission management and
// Assistant ownership are independent authorities.
const capabilities=["frontend.read","directory.manage","leadership.manage","events.manage","attendance.correct"];
const active="flight_path_status NOT IN ('Inactive','Commissioned','Dropped')";
const manager="EXISTS(SELECT 1 FROM permission_managers m JOIN principals p USING(principal_id) WHERE m.principal_id=? AND m.active=1 AND p.active=1)";
const key=(actor,id)=>"assistant/wing-grant/"+encodeURIComponent(actor)+"/"+id;
const conflict=()=>new PanelError("STALE_ACCESS","The account or your permissions changed, or changes are paused. Review a new grant.",409);

export async function schoolWingAccess(db,principal,email,googlePrincipal=null){
  if(!db || !email)return false;
  return Boolean(await db.prepare(`SELECT 1 FROM principals p JOIN directory_profiles d USING(person_id)
    JOIN admin_grants g USING(principal_id) WHERE p.principal_id=? AND p.active=1 AND lower(trim(d.email))=? AND ${active}
    AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*'
    AND (? IS NULL OR EXISTS(SELECT 1 FROM principals login JOIN principal_accounts a USING(principal_id)
      WHERE login.principal_id=? AND login.active=1 AND login.person_id=p.person_id AND a.email=d.email COLLATE NOCASE
      AND a.evidence IN ('authenticated-confirmation','google-form')))`).bind(principal,email,googlePrincipal,googlePrincipal).first());
}

export async function prepareWingGrant(env,actor,personId,hash){
  if(!isUnifiedSite(env))throw conflict();
  const row=await env.DB.prepare(`SELECT first_name,last_name,lower(trim(email)) AS email,version FROM directory_profiles
    WHERE person_id=? AND ${active} AND ${manager}`).bind(personId,actor).first();
  if(!row?.email)throw conflict();
  const principal="school."+await hash(row.email);
  const action={expiresAt:Date.now()+900000,id:crypto.randomUUID(),personId,principal,email:row.email,version:row.version,name:(row.first_name+" "+row.last_name).trim()};
  await env.HISTORY_FILES.put(key(actor,action.id),JSON.stringify(action),{expirationTtl:900});
  return {content:"Grant "+action.name+" ("+action.email+") Wing access to view records and manage the Directory, leadership, events, and attendance corrections? Includes Assistant and View as. Permission management and Google workbook sharing are separate.",wingGrant:{id:action.id}};
}

export async function applyWingGrant(env,actor,id){
  if(!isUnifiedSite(env) || !/^[a-f0-9-]{36}$/.test(id))throw conflict();
  const db=env.DB, operation="access.grantWing";
  const receipt=()=>db.prepare("SELECT target_id FROM admin_audit_events WHERE command_id=? AND actor_id=? AND operation=?").bind(id,actor,operation).first();
  if(await receipt())return {complete:true};
  const a=await env.HISTORY_FILES.get(key(actor,id),"json");
  if(!a || a.id!==id || a.expiresAt<=Date.now())throw conflict();
  const sql=(q,...v)=>db.prepare(q).bind(...v);
  const pending="EXISTS(SELECT 1 FROM admin_commands WHERE command_id=? AND actor_id=? AND operation=? AND target_id=?) AND NOT EXISTS(SELECT 1 FROM admin_audit_events WHERE command_id=?)";
  const guard=[id,actor,operation,a.principal,id];
  const now=new Date().toISOString();
  await db.batch([
    sql(`INSERT OR IGNORE INTO command_registry SELECT ?,'admin' WHERE ${manager}
      AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND generation=? AND accepting_commands=1)
      AND EXISTS(SELECT 1 FROM directory_profiles WHERE person_id=? AND version=? AND lower(trim(email))=? AND ${active})
      AND NOT EXISTS(SELECT 1 FROM principals WHERE principal_id=? AND (active<>1 OR person_id IS NOT ?))`,
      id,actor,Number(env.GENERATION),a.personId,a.version,a.email,a.principal,a.personId),
    sql(`INSERT OR IGNORE INTO admin_commands(command_id,payload_hash,actor_id,operation,target_id,capability,scopes_json,source_kind,source_resource,source_submission,source_revision,accepted_at,receipt_json) SELECT ?,?,?,?,?,?,'["wing"]','sheet','assistant-wing-access',?,1,?,'{}'
      FROM command_registry WHERE command_id=? AND ledger='admin'`,id,id,actor,operation,a.principal,"permission.manage",id,now,id),
    sql(`INSERT OR IGNORE INTO principals SELECT ?,?,1 WHERE ${pending}`,a.principal,a.personId,...guard),
    ...capabilities.map(cap=>sql(`INSERT OR IGNORE INTO admin_grants SELECT ?,?,'wing','*' WHERE ${pending}`,a.principal,cap,...guard)),
    sql(`INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json)
      SELECT ?,?,'authenticated-confirmation',?,?,?,'{}',? WHERE ${pending}`,id,actor,operation,a.principal,now,JSON.stringify({capabilities}),...guard)
  ]);
  if(!await receipt())throw conflict();
  return {complete:true};
}
