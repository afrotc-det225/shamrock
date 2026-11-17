import { PanelError } from "../errors.mjs";

// The authenticated read captures identity and preview mode in one indexed query.
// Mutations below still reread the current preview after changing session state.
export function previewFromSession(user) {
  return user.preview_person_id === null ? null : {
    person_id: user.preview_person_id,
    entry_audit_id: user.preview_entry_audit_id,
    status: user.preview_status,
  };
}

export async function getPreview(env, user) {
  return env.PANEL_DB.prepare("SELECT person_id,entry_audit_id,status FROM session_previews WHERE token_hash=?")
    .bind(user.token_hash).first();
}
export const previewResponse = (value) => value ? {
  personId: value.person_id, entryAuditId: value.entry_audit_id,
  status: value.status, readOnly: true,
} : null;

export async function changePreview(env, user, backend, body) {
  if (env.VIEW_AS_ENABLED !== "1" && body?.personId !== null)
    throw new PanelError("NOT_FOUND", "View as is not available.", 404);
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "personId") ||
      (body.personId !== null && (typeof body.personId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.personId))))
    throw new PanelError("INVALID_REQUEST", "Select a cadet to view.");
  const existing = await getPreview(env, user);
  if (body.personId === null) {
    // Returning to one's own session must not depend on retained Wing authority.
    await env.PANEL_DB.prepare("DELETE FROM session_previews WHERE token_hash=?").bind(user.token_hash).run();
    let auditRecorded = true;
    if (existing) try {
      await backend.post("/v1/admin/panel/view-as/authorize", {
        ...backend.identity(), action: "exit", auditId: crypto.randomUUID(), entryAuditId: existing.entry_audit_id,
      });
    } catch { auditRecorded = false; }
    return { viewAs: null, auditRecorded };
  }
  if (existing) throw new PanelError("VIEW_AS_ACTIVE", "Exit the current view before selecting another cadet.", 409);
  const result = await backend.post("/v1/admin/panel/view-as/authorize", {
    ...backend.identity(), action: "enter", auditId: crypto.randomUUID(), targetPersonId: body.personId,
  });
  if (result.contractVersion !== "panel-view-as-v1" || result.readOnly !== true ||
      result.action !== "enter" || result.targetPersonId !== body.personId || typeof result.entryAuditId !== "string" ||
      !["ready", "no-active-principal", "ambiguous-principal", "no-verified-login", "no-panel-access"].includes(result.status))
    throw new PanelError("INVALID_RESPONSE", "This view could not be verified.", 502);
  const saved = await env.PANEL_DB.prepare(
    "INSERT INTO session_previews SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires>?) AND NOT EXISTS(SELECT 1 FROM proposals WHERE principal=? AND lease_until>? AND state='applying') ON CONFLICT(token_hash) DO NOTHING",
  ).bind(user.token_hash, body.personId, result.entryAuditId, result.status, user.token_hash, Date.now(), user.principal_id, Date.now()).run();
  if (!saved.meta.changes)
    throw new PanelError("CHANGE_IN_PROGRESS", "Wait for the current change to finish, then try View as again.", 409);
  return { viewAs: previewResponse(await getPreview(env, user)) };
}
