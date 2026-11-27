import {effectiveAdminGrants} from "../../../.build/v3/apps/worker/src/permission-grants.js";
export const administratorReply=()=>({content:"SHAMROCK administrators",adminDirectory:true});
export function asksForAdministrators(message){
  return message?.role==="user" && /^(?:who (?:are|is)|which (?:users|accounts|people) are|(?:please )?(?:list|show|name)(?: me)?) (?:all )?(?:(?:the|our|current|currently|shamrock|system|panel|staging) )*admin(?:istrator)?s?(?: (?:of|for|in) (?:the )?(?:shamrock|system|panel))?[?.! ]*$/i.test(message.content?.trim() || "");
}
// Mirrors the explicit Wing grant and permission-manager paths in resolvePanelAccess.
export async function currentAdministrators(db){
  const {results}=await db.prepare(`WITH wing AS (
    SELECT principal_id FROM admin_grants WHERE capability='frontend.read' AND scope_kind='wing' AND scope_key='*'
    UNION SELECT m.principal_id FROM permission_managers m JOIN ${effectiveAdminGrants} g ON g.principal_id=m.principal_id
    WHERE m.active=1 AND g.capability='frontend.read' AND g.scope_kind='wing' AND g.scope_key='*')
    SELECT coalesce(nullif(trim(d.first_name||' '||d.last_name),''),nullif(trim(c.first_name||' '||c.last_name),''),nullif(pe.display_name,''),a.email,p.principal_id) AS name,
    EXISTS(SELECT 1 FROM permission_managers m WHERE m.active=1 AND m.principal_id=p.principal_id) AS managesAccess
    FROM wing JOIN principals p ON p.principal_id=wing.principal_id AND p.active=1
    LEFT JOIN people pe ON pe.person_id=p.person_id LEFT JOIN directory_profiles d ON d.person_id=p.person_id
    LEFT JOIN principal_accounts a ON a.principal_id=p.principal_id
    LEFT JOIN leadership_contacts c ON c.contact_id=(SELECT min(l.contact_id) FROM leadership_contacts l WHERE l.active=1 AND l.email<>'' AND lower(l.email)=a.email)
    ORDER BY name,p.principal_id`).all();
  return {administrators:results};
}
