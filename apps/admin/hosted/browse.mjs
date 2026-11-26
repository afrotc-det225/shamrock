import { createHash } from "node:crypto";
import { PanelError } from "../errors.mjs";
export const browseProfiles = ["cadets","cadet-details","leadership","attendance","excusals","overview","semester"];
const cache = new Map();
// Each entry is private to the current actor, preview entry, effective scope and data revisions.
export async function browseState(backend, authority, requested) {
  const profile = authority.access.capabilities.fullSnapshot || requested === "excusals" ? requested : "attendance";
  const binding = a => JSON.stringify([backend.binding,profile,a.scope,a.access,a.revision,backend.viewRevision]);
  const key = binding(authority), cached = cache.get(key);
  if (cached && cached.until > Date.now()) {
    backend.browseSource = 'memory';
    return cached.value;
  }
  // A named Cache API namespace is accessible only inside the Worker. These
  // entries never use a public route or the default HTTP response cache.
  let edge, address;
  if (globalThis.caches && ["attendance","excusals"].includes(profile) && backend.env?.APP_ORIGIN) {
    const digest = createHash("sha256").update(key).digest("hex");
    address = new URL("/_private/browse/"+digest, backend.env.APP_ORIGIN).href;
    try {
      edge = await caches.open("shamrock-private-browse-v2");
      const hit = await edge.match(address);
      if (hit) {
        const view = await hit.json();
        backend.browseSource = 'edge';
        return view;
      }
    } catch { /* Cache outage or eviction falls back to the authorized data path. */ }
  }
  backend.browseSource = 'database';
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
    if (edge) {
      try {
        await edge.put(address,new Response(JSON.stringify(view),{headers:{
          "Content-Type":"application/json","Cache-Control":"max-age=600",
        }}));
      } catch { /* The authorized response remains usable when storage is unavailable. */ }
    }
  }
  return view;
}
