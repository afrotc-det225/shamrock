import { PanelError } from "../errors.mjs";
export const browseProfiles = ["cadets","cadet-details","leadership","attendance","excusals","overview"];
const cache = new Map();
// Each entry is private to the current actor, preview entry, effective scope and data revisions.
export async function browseState(backend, authority, requested) {
  const profile = authority.access.capabilities.fullSnapshot || requested === "excusals" ? requested : "attendance";
  const binding = a => JSON.stringify([backend.binding,profile,a.scope,a.access,a.revision,backend.viewRevision]);
  const key = binding(authority), cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const view = await backend.send("/v1/admin/panel/browse",{...backend.identity(),profile,
    ...(backend.preview ? {entryAuditId:backend.preview.entry_audit_id,targetPersonId:backend.preview.person_id} : {})});
  const after = await backend.panelAuthority();
  if (binding(after) !== key || view.profile !== profile || view.scope.termId !== authority.scope.termId ||
      view.revision.operations !== authority.revision.operations || view.revision.administration !== authority.revision.administration ||
      (!backend.preview && view.revision.access !== authority.revision.access))
    throw new PanelError("SNAPSHOT_CHANGED","Records or access changed. Reload the page.",409);
  if (Object.values(view.tables).reduce((n,t)=>n+String(t).length,0)<=300000) {
    if (cache.size>=24) cache.delete(cache.keys().next().value);
    cache.set(key,{until:Date.now()+60000,value:view});
  }
  return view;
}
