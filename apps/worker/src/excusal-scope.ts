/** Submission-time Squadron ownership is independent of today's Flight hierarchy. */
import { effectivePermissionMembers } from './permission-grants.js';
export const excusalScopeSelect = `sc.squadron_id AS capturedSquadronId,sc.squadron_label AS capturedSquadronLabel,sc.flight_label AS capturedFlightLabel,sc.evidence AS scopeEvidence`;
export const excusalScopeJoin = `LEFT JOIN excusal_request_scopes sc ON sc.request_id=r.request_id`;
export function captureExcusalScopes(db: D1Database, requestIds: string[], flightId: string, now: string): D1PreparedStatement {
    return db.prepare(`INSERT INTO excusal_request_scopes
    SELECT selected.value,u.unit_id,s.squadron_id,u.label,s.label,'submission',? FROM json_each(?) selected
    JOIN organizational_units u ON u.unit_id=? JOIN flight_hierarchy h ON h.unit_id=u.unit_id JOIN squadrons s ON s.squadron_id=h.squadron_id`).bind(now, JSON.stringify(requestIds), flightId);
}
/** Explicit grants retain their explicit scope. Derived commanders use the request's retained Squadron. */
export function excusalDecisionPermission(principalId: string, requestId: string, flightId: string) {
    return { sql: decisionPredicate('?', '?', '?'), values: [principalId, flightId, requestId] };
}
/** Same authorization as mutation, correlated to the trusted excusal_records SQL alias r. */
export function excusalDecisionRowPermission(principalId: string) {
    return { sql: decisionPredicate('?', 'r.unit_id', 'r.request_id'), values: [principalId] };
}
function decisionPredicate(principal: string, flight: string, request: string): string {
    return `EXISTS(SELECT 1 FROM principals p WHERE p.principal_id=${principal} AND p.active=1 AND (
    EXISTS(SELECT 1 FROM access_grants g WHERE g.principal_id=p.principal_id AND g.capability='excusal.decide' AND g.unit_id=${flight} AND g.subject_scope='unit')
    OR EXISTS(SELECT 1 FROM permission_policy_control pc JOIN principal_accounts a ON a.principal_id=p.principal_id
      JOIN ${effectivePermissionMembers} member ON member.principal_id=p.principal_id
      JOIN json_each(pc.policy_json,'$.google.squadronCommanders') commander
      WHERE pc.singleton=1 AND pc.enabled=1 AND json_extract(commander.value,'$.email')=a.email
      AND json_extract(commander.value,'$.squadronId')=(SELECT sc.squadron_id FROM excusal_records decision_request
        LEFT JOIN excusal_request_scopes sc ON sc.request_id=decision_request.request_id WHERE decision_request.request_id=${request}))))`;
}
