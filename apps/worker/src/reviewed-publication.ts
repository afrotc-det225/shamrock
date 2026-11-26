import { HttpError } from './http-error.js';

interface Pin { operations: number; administration: number }
/** A lost ACK can be replayed for the same immutable, terminal receipt. */
export const reviewedPublicationState = "(state='leased' OR (state='done' AND completed_by_effect_id=effect_id))";
const invalid = () => new HttpError(400,'INVALID_REVIEWED_PUBLICATION','Use a named staging publication and its reviewed snapshot revision.');

export function parsePublicationPin(value: unknown): Pin {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'administration,operations') throw invalid();
  const pin = value as Pin;
  if (![pin.operations,pin.administration].every(v=>Number.isSafeInteger(v) && v>=0)) throw invalid();
  return pin;
}
async function principalTag(principal: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(principal)));
  return Array.from(bytes.slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}
// The random token is persisted by the existing lease. Its immutable prefix also
// binds the owner and revision for projection, recovery and acknowledgements.
export async function reviewedPublicationToken(principal: string, pin: Pin) {
  return `reviewed.${pin.operations}.${pin.administration}.${await principalTag(principal)}.${crypto.randomUUID()}`;
}
export async function retainedPublicationPin(token: string, principal: string): Promise<Pin | undefined> {
  if (!token.startsWith('reviewed.')) return;
  const match = /^reviewed\.(\d{1,16})\.(\d{1,16})\.([0-9a-f]{24})\.([0-9a-f-]{36})$/.exec(token);
  if (!match || match[3] !== await principalTag(principal)) throw new HttpError(403,'NOT_AUTHORIZED','The reviewed publication belongs to its original principal.');
  return parsePublicationPin({operations:Number(match[1]),administration:Number(match[2])});
}

// Applied within the transaction using the effect, on every page and on recovery.
// Paused operation is restricted to the reviewed import that produced the pinned revision.
export function reviewedPublicationGuard(effectId: string, principal: string, generation: number, pin: Pin) {
  return {
    sql: `EXISTS(SELECT 1 FROM admin_effects me
      JOIN admin_commands c ON c.command_id=me.command_id AND c.operation='legacy.incremental-refresh' AND c.actor_id='service:legacy-import'
      JOIN legacy_import_runs i ON i.import_run_id=c.target_id AND i.state='complete' AND i.environment='staging'
      JOIN system_control s ON s.singleton=1 AND s.environment=i.environment AND s.generation=i.generation AND s.accepting_commands=0
      JOIN permission_policy_control p ON p.singleton=1 AND p.enabled=1
      JOIN notification_delivery_control n ON n.singleton=1 AND n.mode='suppressed'
      WHERE me.effect_id=? AND s.generation=? AND json_extract(i.manifest_json,'$.kind')='reviewed-incremental-staging-refresh'
      AND p.version=json_extract(i.manifest_json,'$.permissionPolicyVersion') AND p.policy_hash=json_extract(i.manifest_json,'$.permissionPolicyHash')
      AND json_extract(i.manifest_json,'$.administrationRevision')+json_extract(i.manifest_json,'$.administrationDelta')=?
      AND (SELECT COALESCE(MAX(audit_id),0) FROM admin_audit_events)=?
      AND (SELECT COALESCE(MAX(audit_id),0) FROM audit_events)=?
      AND EXISTS(SELECT 1 FROM admin_audit_events a WHERE a.command_id=c.command_id AND a.operation=c.operation AND a.target_id=c.target_id)
      AND EXISTS(SELECT 1 FROM principals u JOIN admin_grants g ON g.principal_id=u.principal_id
        WHERE u.principal_id=? AND u.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')
      AND NOT EXISTS(SELECT 1 FROM permission_refresh_jobs WHERE state='leased')
      AND NOT EXISTS(SELECT 1 FROM legacy_import_runs WHERE state<>'complete')
      AND NOT EXISTS(SELECT 1 FROM legacy_operational_adoptions WHERE state<>'complete')
      AND NOT EXISTS(SELECT 1 FROM event_roster_refresh_work))`,
    values: [effectId,generation,pin.administration,pin.administration,pin.operations,principal],
  };
}
