import {authorityStatements,readPanelContext} from './panel-read.js';
import {HttpError} from './http-error.js';

type Env = {DB:D1Database; ENVIRONMENT:string; GENERATION:string};
export type PanelContext = Awaited<ReturnType<typeof readPanelContext>>;
export async function attendanceDelta(env:Env,input:unknown, current?:PanelContext) {
  const req=input as Record<string,unknown> | null;
  if (!req || Object.keys(req).sort().join(',')!=='access,administration,environment,from,generation,principalId,termId' ||
      req.environment!==env.ENVIRONMENT || req.generation!==Number(env.GENERATION) ||
      typeof req.principalId!=='string' || typeof req.termId!=='string' || typeof req.access!=='string' ||
      !Number.isSafeInteger(req.from) || Number(req.from)<0 || !Number.isSafeInteger(req.administration))
    throw new HttpError(400,'INVALID_PANEL_REQUEST','Reload the current attendance matrix.');
  const {first,access,control,revision}=current ?? await readPanelContext(env,req.principalId);
  if (!access.capabilities.fullSnapshot) throw new HttpError(403,'NOT_AUTHORIZED','Reload with current access.');
  const size=revision.operations-Number(req.from);
  if (size<1 || size>64 || req.termId!==control.termId || req.access!==revision.access ||
      req.administration!==revision.administration) return {available:false};
  // Preserve audit order, including repeated edits to one cell and explicit clears.
  // A missing record, a different operation or a term change requires a full capture.
  const query=env.DB.prepare(`SELECT a.audit_id AS n,a.operation,p.rowid AS person,e.rowid AS event,
    c.correction_id AS id,c.code,d.term_id AS term FROM audit_events a
    LEFT JOIN attendance_corrections c ON c.command_id=a.command_id
    LEFT JOIN people p ON p.person_id=c.person_id LEFT JOIN events e ON e.event_id=c.event_id
    LEFT JOIN event_details d ON d.event_id=e.event_id
    WHERE a.audit_id>? AND a.audit_id<=? ORDER BY a.audit_id LIMIT 65`).bind(req.from,revision.operations);
  const fence=authorityStatements(env,req.principalId);
  const result=await env.DB.batch<Record<string,unknown>>([...fence,query]);
  if (JSON.stringify(first)!==JSON.stringify(result.slice(0,-1).map(r=>r.results)))
    throw new HttpError(409,'SNAPSHOT_CHANGED','Reload the current attendance matrix.');
  const rows=result[fence.length].results;
  if (rows.length!==size || rows.some((r,i)=>r.n!==Number(req.from)+i+1 || r.operation!=='attendance.correct' ||
      r.term!==req.termId || typeof r.id!=='string' || !Number.isSafeInteger(r.person) || !Number.isSafeInteger(r.event)))
    return {available:false};
  return {available:true,from:req.from,revision,rows:rows.map(r=>[r.person,r.event,'correction:'+r.id,r.n,r.code])};
}
