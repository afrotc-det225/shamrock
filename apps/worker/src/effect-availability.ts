/** Cheap, read-only queue discovery. Never returns records, claims work or builds a snapshot. */
import {HttpError} from './http-error.js';
export async function adminEffectAvailability(env:{DB:D1Database;ENVIRONMENT:string;GENERATION:string},input:unknown){
  const value=input as {environment?:unknown;generation?:unknown;principalId?:unknown};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='environment,generation,principalId'
    ||value.environment!==env.ENVIRONMENT||value.generation!==Number(env.GENERATION)||typeof value.principalId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.principalId))throw new HttpError(400,'INVALID_ADMIN_REQUEST','Expected the current environment, generation and principal.');
  const result=await env.DB.prepare(`SELECT accepting_commands AS acceptingCommands,
    EXISTS(SELECT 1 FROM admin_effects WHERE state='pending' AND kind='frontend.refresh') AS frontendPending,
    EXISTS(SELECT 1 FROM admin_effects WHERE state='leased' AND kind='frontend.refresh') AS frontendLeased,
    EXISTS(SELECT 1 FROM admin_effects WHERE state='pending' AND kind='forms.refresh') AS formsPending,
    EXISTS(SELECT 1 FROM admin_effects WHERE state='leased' AND kind='forms.refresh') AS formsLeased
    FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND EXISTS(
      SELECT 1 FROM principals p JOIN admin_grants g ON g.principal_id=p.principal_id
      WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')`)
    .bind(env.ENVIRONMENT,Number(env.GENERATION),value.principalId).first<Record<string,number>>();
  if(!result)throw new HttpError(403,'NOT_AUTHORIZED','Current Wing frontend read authority is required.');
  return Object.fromEntries(Object.entries(result).map(([key,n])=>[key,n===1]));
}
