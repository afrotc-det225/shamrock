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

const intent = (env,user) => env.PANEL_DB.prepare("SELECT person_id,entry_audit_id,exit_audit_id FROM session_preview_intents WHERE token_hash=?").bind(user.token_hash).first();
export async function getPreview(env, user) {
  return env.PANEL_DB.prepare(`SELECT person_id,entry_audit_id,status FROM session_previews WHERE token_hash=?
    UNION ALL SELECT person_id,entry_audit_id,'starting' AS status FROM session_preview_intents
    WHERE token_hash=? AND exit_audit_id IS NULL AND NOT EXISTS(SELECT 1 FROM session_previews WHERE token_hash=?) LIMIT 1`)
    .bind(user.token_hash,user.token_hash,user.token_hash).first();
}
export const previewResponse = value => value ? {
  personId:value.person_id,entryAuditId:value.entry_audit_id,status:value.status,readOnly:true,
} : null;
async function recordExit(env,user,backend,saved) {
  if(!saved?.exit_audit_id)return true;
  try {
    await backend.post("/v1/admin/panel/view-as/authorize",{
      ...backend.identity(),action:"exit",auditId:saved.exit_audit_id,entryAuditId:saved.entry_audit_id,
    });
    await env.PANEL_DB.prepare("DELETE FROM session_preview_intents WHERE token_hash=? AND entry_audit_id=? AND exit_audit_id=?")
      .bind(user.token_hash,saved.entry_audit_id,saved.exit_audit_id).run();
    return true;
  } catch { return false; }
}
export async function changePreview(env,user,backend,body) {
  if(env.VIEW_AS_ENABLED!=="1" && body?.personId!==null)
    throw new PanelError("NOT_FOUND","View as is not available.",404);
  if(!body || Object.keys(body).length!==1 || !Object.hasOwn(body,"personId") ||
      (body.personId!==null && (typeof body.personId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.personId))))
    throw new PanelError("INVALID_REQUEST","Select a cadet to view.");
  const existing=await getPreview(env,user);
  let saved=await intent(env,user);
  if(body.personId===null) {
    // Clearing local mode and retaining the exact exit request ID is one transaction.
    // A delayed enter response cannot recreate a mode whose intent is now closing.
    await env.PANEL_DB.batch([
      env.PANEL_DB.prepare(`INSERT INTO session_preview_intents SELECT token_hash,person_id,entry_audit_id,NULL FROM session_previews
        WHERE token_hash=? ON CONFLICT(token_hash) DO NOTHING`).bind(user.token_hash),
      env.PANEL_DB.prepare("UPDATE session_preview_intents SET exit_audit_id=COALESCE(exit_audit_id,?) WHERE token_hash=?").bind(crypto.randomUUID(),user.token_hash),
      env.PANEL_DB.prepare("DELETE FROM session_previews WHERE token_hash=?").bind(user.token_hash),
    ]);
    saved=await intent(env,user);
    return {viewAs:null,auditRecorded:await recordExit(env,user,backend,saved)};
  }
  if(existing && existing.person_id!==body.personId)
    throw new PanelError("VIEW_AS_ACTIVE","Exit the current view before selecting another cadet.",409);
  if(saved?.exit_audit_id) {
    if(!await recordExit(env,user,backend,saved))
      throw new PanelError("VIEW_AS_EXIT_PENDING","The previous preview exit could not be recorded. Try again.",503);
    saved=null;
  }
  if(!saved) {
    const auditId=existing?.entry_audit_id || crypto.randomUUID();
    const created=await env.PANEL_DB.prepare(`INSERT INTO session_preview_intents SELECT ?,?,?,NULL
      WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires>?)
      AND NOT EXISTS(SELECT 1 FROM proposals WHERE principal=? AND lease_until>? AND state='applying')
      ON CONFLICT(token_hash) DO NOTHING`)
      .bind(user.token_hash,body.personId,auditId,user.token_hash,Date.now(),user.principal_id,Date.now()).run();
    saved=await intent(env,user);
    if(!created.meta.changes && !saved)
      throw new PanelError("CHANGE_IN_PROGRESS","Wait for the current change to finish, then try View as again.",409);
  }
  if(saved.person_id!==body.personId || saved.exit_audit_id)
    throw new PanelError("VIEW_AS_ACTIVE","Exit the current view before selecting another cadet.",409);
  const result=await backend.post("/v1/admin/panel/view-as/authorize",{
    ...backend.identity(),action:"enter",auditId:saved.entry_audit_id,targetPersonId:saved.person_id,
  });
  if(result.contractVersion!=="panel-view-as-v1" || result.readOnly!==true || result.action!=="enter" ||
      result.targetPersonId!==saved.person_id || result.entryAuditId!==saved.entry_audit_id ||
      !["ready","no-active-principal","ambiguous-principal","no-verified-login","no-panel-access"].includes(result.status))
    throw new PanelError("INVALID_RESPONSE","This view could not be verified.",502);
  const published=await env.PANEL_DB.prepare(`INSERT INTO session_previews SELECT ?,?,?,?
    WHERE EXISTS(SELECT 1 FROM session_preview_intents WHERE token_hash=? AND entry_audit_id=? AND exit_audit_id IS NULL)
    AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires>?)
    ON CONFLICT(token_hash) DO UPDATE SET person_id=excluded.person_id,entry_audit_id=excluded.entry_audit_id,status=excluded.status`)
    .bind(user.token_hash,saved.person_id,saved.entry_audit_id,result.status,user.token_hash,saved.entry_audit_id,user.token_hash,Date.now()).run();
  if(!published.meta.changes)throw new PanelError("VIEW_AS_CANCELLED","This preview was cancelled. Select the person again.",409);
  return {viewAs:previewResponse(await getPreview(env,user)),directoryWorkspace:result.directoryWorkspace===true};
}
