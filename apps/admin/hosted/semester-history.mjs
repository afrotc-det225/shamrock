import { createHash } from "node:crypto";
import { PanelError } from "../errors.mjs";
import { json } from "./http.mjs";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function catalogKey(generation, snapshots) {
  const sources = snapshots.map(s => [s.snapshotId, s.sourceSnapshotSha256]).sort(([a], [b]) => a.localeCompare(b, "en"));
  return `history/v1/g${generation}/catalog/${hash(JSON.stringify(sources))}`;
}
export const fileKey = version => `history/v1/files/${version}`;
const changed = () => new PanelError("SNAPSHOT_CHANGED", "History changed. Reload the semester list.", 409);
const missing = () => new PanelError("HISTORY_UNPUBLISHED", "This semester archive is awaiting publication.", 503);

// Only the actual or effective Wing reader can obtain the catalog. Both checks
// use the same guarded backend as the native History reader, including View as.
export async function semesterHistory(backend, store, input) {
  const source = await backend.historyPage(null);
  const key = catalogKey(backend.generation, source.snapshots);
  if (!source.snapshots.length && input === null) return json({ semesters: [] });
  const catalog = await store.get(key, "json");
  if (!catalog || !Array.isArray(catalog.semesters)) throw missing();
  if (!input) return json({ semesters: catalog.semesters });
  const item = catalog.semesters.find(s => s.version === input.version);
  if (!item || !/^[a-f0-9]{64}$/.test(item.version)) throw changed();
  const bytes = await store.get(fileKey(item.version), "arrayBuffer");
  if (!bytes || hash(new Uint8Array(bytes)) !== item.version) throw missing();
  // All published files have exactly Wing History visibility. Verify it again
  // after KV IO, including the active View as entry and effective target.
  const after = await backend.panelAuthority();
  if (!after.access?.capabilities?.fullSnapshot) throw changed();
  return new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8" } });
}
