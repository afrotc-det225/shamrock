/** Existing explicit grants remain independent. Derived grants fail closed if their source drifts. */
const validMember = `EXISTS(SELECT 1 FROM permission_policy_control pc WHERE pc.singleton=1 AND pc.enabled=1)
 AND EXISTS(SELECT 1 FROM role_permission_members rm JOIN principal_accounts a ON a.principal_id=rm.principal_id
   JOIN principals p ON p.principal_id=rm.principal_id AND p.active=1
   WHERE rm.principal_id=g.principal_id AND rm.policy_version=(SELECT version FROM permission_policy_control WHERE singleton=1) AND (
     (rm.source_kind='directory' AND EXISTS(SELECT 1 FROM directory_profiles d
       WHERE d.person_id=rm.source_id AND p.person_id=d.person_id AND d.version=rm.source_version AND lower(d.email)=a.email AND d.role=rm.source_role AND d.flight_id IS rm.source_flight_id AND d.flight_path_status=rm.source_status
       AND d.flight_path_status NOT IN ('Inactive','Commissioned','Dropped')
       AND EXISTS(SELECT 1 FROM memberships m WHERE m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1)
       AND COALESCE((SELECT c.contact_id FROM leadership_contacts c WHERE c.person_id=d.person_id),'')=COALESCE(rm.linked_contact_id,'')
       AND (SELECT c.active FROM leadership_contacts c WHERE c.person_id=d.person_id) IS rm.linked_contact_active
       AND COALESCE((SELECT c.version FROM leadership_contacts c WHERE c.person_id=d.person_id),0)=COALESCE(rm.linked_contact_version,0)))
     OR (rm.source_kind='leadership' AND p.person_id IS NULL AND EXISTS(SELECT 1 FROM leadership_contacts c
       WHERE c.contact_id=rm.source_id AND c.person_id IS NULL AND c.version=rm.source_version AND c.active=1 AND lower(c.email)=a.email AND c.role=rm.source_role))))`;
export const effectiveAccessGrants = `(SELECT principal_id,capability,unit_id,subject_scope FROM access_grants
 UNION SELECT g.principal_id,g.capability,g.unit_id,g.subject_scope FROM role_access_grants g WHERE ${validMember})`;
export const effectiveAdminGrants = `(SELECT principal_id,capability,scope_kind,scope_key FROM admin_grants
 UNION SELECT g.principal_id,g.capability,g.scope_kind,g.scope_key FROM role_admin_grants g WHERE ${validMember})`;
