/** Internal policy contexts are deliberately partial; never publish them as a full frontend snapshot. */
import { adminIdentifier,type FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import { noticeLocalClock } from '../../../packages/domain/src/notifications.js';
import { closeoutWindow } from '../../../packages/domain/src/closeout.js';
import { frontendSnapshot,type FrontendReadScope } from './admin.js';
import { effectiveAdminGrants } from './permission-grants.js';
import { HttpError } from './http-error.js';
interface Env {DB:D1Database;ENVIRONMENT:string;GENERATION:string}
type Value=string|number|null;
const stmt=(db:D1Database,sql:string,...values:Value[])=>db.prepare(sql).bind(...values);
const shift=(date:string,days:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const revisionSql=`SELECT (SELECT COALESCE(MAX(audit_id),0) FROM audit_events) AS operations,(SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events) AS administration`;
async function scopeRead(env:Env,principalId:string,query:D1PreparedStatement):Promise<{revision:FrontendSnapshot['revision'];rows:Record<string,unknown>[]}>{
  adminIdentifier(principalId);const result=await env.DB.batch<Record<string,unknown>>([
    stmt(env.DB,`SELECT EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?) AND EXISTS(SELECT 1 FROM principals p JOIN ${effectiveAdminGrants} g ON g.principal_id=p.principal_id WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*') AS allowed,NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE state<>'complete') AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE state<>'complete') AS ready`,env.ENVIRONMENT,Number(env.GENERATION),principalId),stmt(env.DB,revisionSql),query]);
  if(result[0].results[0]?.allowed!==1)throw new HttpError(403,'NOT_AUTHORIZED','Current Wing read authority is required.');if(result[0].results[0]?.ready!==1)throw new HttpError(409,'SNAPSHOT_IMPORT_ACTIVE','Finish the import before reporting.');
  return {revision:result[1].results[0] as unknown as FrontendSnapshot['revision'],rows:result[2].results};
}
const context=(env:Env,principalId:string,scope:FrontendReadScope)=>frontendSnapshot(env,{environment:env.ENVIRONMENT,generation:Number(env.GENERATION),principalId},scope);
/** Routing is current, while a retained excusal task may subsequently substitute its immutable request version. */
export async function readNotificationContext(env:Env,principalId:string,recipe:{kind:'scheduled'|'excusal';asOf:string;requestId:string|null}):Promise<FrontendSnapshot>{
  const clock=noticeLocalClock(recipe.asOf);
  if(recipe.kind==='excusal'){
    adminIdentifier(recipe.requestId);const read=await scopeRead(env,principalId,stmt(env.DB,`SELECT event_id AS eventId FROM excusal_records r WHERE request_id=? AND (origin='native' OR EXISTS(SELECT 1 FROM legacy_operational_adoptions a WHERE a.adoption_id=r.legacy_adoption_id AND a.state='complete'))`,recipe.requestId));
    if(read.rows.length!==1)throw new HttpError(404,'NOT_FOUND','The requested excusal is unavailable.');return context(env,principalId,{eventIds:[String(read.rows[0].eventId)],requestId:recipe.requestId!,includeAttendanceFacts:false,expectedRevision:read.revision});
  }
  if(recipe.kind!=='scheduled'||recipe.requestId!==null)throw new HttpError(400,'INVALID_NOTIFICATION','Invalid notification context.');
  const weekly=clock.weekday===0&&clock.hour>=17,start=weekly?shift(clock.date,-7):clock.date;
  const read=await scopeRead(env,principalId,stmt(env.DB,`SELECT event_id AS eventId,event_type AS type,start_at AS startAt FROM event_details WHERE status='active' AND start_at>=? AND start_at<? ORDER BY event_id LIMIT 201`,start+'T00:00:00.000Z',shift(clock.date,2)+'T00:00:00.000Z'));
  if(read.rows.length>200)throw new HttpError(409,'CONTEXT_TOO_LARGE','Use a bounded notification event window.');
  const eventIds=read.rows.filter(e=>{const date=noticeLocalClock(String(e.startAt)).date;return weekly&&date>=start&&date<clock.date||clock.hour>=5&&date===clock.date&&['mando','llab'].includes(String(e.type));}).map(e=>String(e.eventId));
  return context(env,principalId,{eventIds,expectedRevision:read.revision});
}
/** Freeze only the current due event catalog/roster; prepare does not need attendance facts. */
export async function readCloseoutPreparationContext(env:Env,principalId:string,asOf:string):Promise<FrontendSnapshot>{
  const window=closeoutWindow(asOf),read=await scopeRead(env,principalId,stmt(env.DB,`SELECT d.event_id AS eventId,d.start_at AS startAt FROM event_details d JOIN terms t ON t.term_id=d.term_id AND t.is_current=1 WHERE d.status='active' AND d.start_at>=? AND d.start_at<? ORDER BY d.event_id LIMIT 201`,window.start+'T00:00:00.000Z',shift(window.end,1)+'T00:00:00.000Z'));
  if(read.rows.length>200)throw new HttpError(409,'CONTEXT_TOO_LARGE','Use a bounded closeout event window.');const eventIds=read.rows.filter(e=>{const date=noticeLocalClock(String(e.startAt)).date;return date>=window.start&&date<window.end;}).map(e=>String(e.eventId));
  return context(env,principalId,{eventIds,includeAttendanceFacts:false,expectedRevision:read.revision});
}
/** Read the next fifty exact subjects, or the retained closeout event set for its final notices. */
export async function readCloseoutStepContext(env:Env,principalId:string,closeoutId:string,items:readonly {event_id:string;person_id:string}[]):Promise<FrontendSnapshot>{
  adminIdentifier(closeoutId);if(items.length>50)throw new HttpError(409,'CONTEXT_TOO_LARGE','Use a bounded closeout step.');
  const read=await scopeRead(env,principalId,stmt(env.DB,'SELECT DISTINCT event_id AS eventId FROM closeout_items WHERE closeout_id=? ORDER BY event_id LIMIT 201',closeoutId));if(read.rows.length>200)throw new HttpError(409,'CONTEXT_TOO_LARGE','Use a bounded closeout event set.');
  return context(env,principalId,{eventIds:items.length?[...new Set(items.map(i=>i.event_id))]:read.rows.map(e=>String(e.eventId)),...(items.length?{personIds:[...new Set(items.map(i=>i.person_id))]}:{}),expectedRevision:read.revision});
}
