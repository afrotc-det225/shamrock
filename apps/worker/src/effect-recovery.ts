/** Deliberate recovery by the same adapter, after exclusive provider reconciliation.
 * A recovery renews a retained lease. It never steals/requeues/acknowledges work. */
import { HttpError } from './http-error.js';
interface Env { DB: D1Database; ENVIRONMENT: string; GENERATION: string }
interface Recovery {
  environment: 'local' | 'staging'; generation: number; principalId: string;
  recoveryId: string; workerId: string; effectId: string; claimToken: string;
  previousExpiry: string; checkpointSha256: string;
  providerState: 'before' | 'after' | 'partial' | 'completed'; producerFenced: true; exclusiveWriter: true;
}
const keys = ['environment','generation','principalId','recoveryId','workerId','effectId','claimToken','previousExpiry','checkpointSha256','providerState','producerFenced','exclusiveWriter'];
const canonical = (v: unknown): string => JSON.stringify(v, (_k,x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k,x[k]])) : x);
const digest = async (v: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))), b => b.toString(16).padStart(2,'0')).join('');
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function parse(input: unknown, env: Env): Recovery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400,'INVALID_RECOVERY','Use a reviewed recovery request.');
  const r = input as Recovery;
  if (Object.keys(r).sort().join(',') !== keys.slice().sort().join(',') || !['local','staging'].includes(r.environment)
    || r.environment !== env.ENVIRONMENT || !Number.isSafeInteger(r.generation) || r.generation !== Number(env.GENERATION)
    || ![r.principalId,r.recoveryId,r.workerId,r.effectId,r.claimToken].every(id) || !/^[a-f0-9]{64}$/.test(r.checkpointSha256)
    || !['before','after','partial','completed'].includes(r.providerState) || r.producerFenced !== true || r.exclusiveWriter !== true
    || typeof r.previousExpiry !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.previousExpiry)
    || !Number.isFinite(Date.parse(r.previousExpiry))) throw new HttpError(400,'INVALID_RECOVERY','Recovery requires the exact retained lease and verified checkpoint.');
  return r;
}
export async function recoverAdminEffect(env: Env, input: unknown): Promise<unknown> {
  const r = parse(input, env), hash = await digest(canonical(r));
  const sql = (query: string, ...values: (string|number)[]) => env.DB.prepare(query).bind(...values);
  // Recovery is permitted while the command gate is paused, but never across
  // generations or a revoked principal/grant. The same grant already owns effects.
  const guard = `EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=?)
    AND EXISTS(SELECT 1 FROM principals p JOIN admin_grants g ON g.principal_id=p.principal_id
      WHERE p.principal_id=? AND p.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')`;
  const authority = [r.environment,r.generation,r.principalId];
  const prior = await env.DB.batch<Record<string, unknown>>([
    sql(`SELECT (${guard}) AS allowed`, ...authority),
    sql('SELECT request_sha256,receipt_json FROM admin_effect_recoveries WHERE recovery_id=?',r.recoveryId),
  ]);
  if (prior[0].results[0]?.allowed !== 1) throw new HttpError(403,'NOT_AUTHORIZED','Current Wing refresh authority is required for reconciliation.');
  const old = prior[1].results[0];
  if (old) {
    if (old.request_sha256 !== hash) throw new HttpError(409,'RECOVERY_CONFLICT','A recovery ID cannot be reused for another checkpoint.');
    return JSON.parse(String(old.receipt_json));
  }
  const now = new Date().toISOString(), renewedExpiry = new Date(Date.now()+600000).toISOString();
  if (Date.parse(r.previousExpiry) > Date.now()+45000) throw new HttpError(409,'LEASE_STILL_CURRENT','Reconcile only an expired or nearly expired retained lease.');
  const receipt = { recoveryId:r.recoveryId, effectId:r.effectId, workerId:r.workerId, claimToken:r.claimToken, leaseExpiresAt:renewedExpiry,
    checkpointSha256:r.checkpointSha256, providerState:r.providerState, status:'renewed' };
  const assertion = crypto.randomUUID();
  try {
    await env.DB.batch([
      sql(`INSERT INTO command_assertions VALUES(?,EXISTS(SELECT 1 FROM admin_effects WHERE effect_id=? AND state='leased'
        AND worker_id=? AND claim_token=? AND lease_expires_at=? AND ${guard}))`,assertion,r.effectId,r.workerId,r.claimToken,r.previousExpiry,...authority),
      sql(`INSERT INTO admin_effect_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,r.recoveryId,r.effectId,r.principalId,r.workerId,r.generation,hash,r.checkpointSha256,r.providerState,r.previousExpiry,renewedExpiry,now,JSON.stringify(receipt)),
      sql(`UPDATE admin_effects SET lease_expires_at=? WHERE effect_id=? AND state='leased' AND worker_id=? AND claim_token=? AND lease_expires_at=?`,renewedExpiry,r.effectId,r.workerId,r.claimToken,r.previousExpiry),
      sql('DELETE FROM command_assertions WHERE command_id=?',assertion),
    ]);
  } catch {
    // A lost response/concurrent identical delivery has one immutable receipt.
    const replay = await env.DB.batch<Record<string, unknown>>([sql(`SELECT (${guard}) AS allowed`,...authority),sql('SELECT request_sha256,receipt_json FROM admin_effect_recoveries WHERE recovery_id=?',r.recoveryId)]);
    if (replay[0].results[0]?.allowed === 1 && replay[1].results[0]?.request_sha256 === hash) return JSON.parse(String(replay[1].results[0].receipt_json));
    throw new HttpError(409,'RECOVERY_CONFLICT','The retained lease or current authority changed. Keep its provider checkpoint for reconciliation.');
  }
  return receipt;
}
