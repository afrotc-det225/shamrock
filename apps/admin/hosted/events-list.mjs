import { PanelError } from "../errors.mjs";

const entries = new Map();
const unavailable = () => { throw new PanelError("SNAPSHOT_CHANGED", "Reload the current Events list.", 409); };

// One bounded, ephemeral cache per Worker isolate. An entry is never an authority.
export async function eventsState(backend) {
  if (backend.preview) unavailable();
  const authority = await backend.panelAuthority();
  const {scope, revision, access} = authority;
  if (!access.capabilities.fullSnapshot) return null;
  const key = JSON.stringify([backend.binding, scope, revision]);
  const hit = entries.get(key);
  if (hit && hit.until > Date.now()) return {authority, eventsList:hit.list};
  const version = {operations:revision.operations, administration:revision.administration};
  async function read(section, limit) {
    const rows = [];
    do {
      const page = await backend.post("/v1/admin/snapshot/page", {
        ...backend.identity(), section, offset:rows.length, revision:version,
      });
      if (page.section !== section || page.offset !== rows.length ||
          page.scope?.termId !== scope.termId || page.scope.currentTermId !== scope.currentTermId ||
          page.revision?.operations !== version.operations || page.revision.administration !== version.administration ||
          !Array.isArray(page.rows) || rows.length + page.rows.length > limit) unavailable();
      rows.push(...page.rows);
      if (page.nextOffset === null) return rows;
      if (!page.rows.length || page.nextOffset !== rows.length) unavailable();
    } while (rows.length < limit);
    unavailable();
  }
  const terms = await read("terms", 20);
  const events = await read("events", 200);
  const current = await backend.panelAuthority();
  if (!current.access.capabilities.fullSnapshot || JSON.stringify(current.revision) !== JSON.stringify(revision) ||
      terms.filter(t => t.isCurrent).length !== 1 || !terms.some(t => t.isCurrent && t.termId === scope.currentTermId) ||
      new Set(events.map(e => e.eventId)).size !== events.length || events.some(e => e.termId !== scope.termId)) unavailable();
  const list = {contractVersion:"events-list-v1", revision:version, scope,
    terms:terms.map(t => ({...t, isCurrent:!!t.isCurrent})), events};
  if (new TextEncoder().encode(JSON.stringify(list)).length <= 128 * 1024) {
    if (entries.size >= 16) entries.delete(entries.keys().next().value);
    entries.set(key,{list, until:Date.now() + 300_000});
  }
  return {authority, eventsList:list};
}
