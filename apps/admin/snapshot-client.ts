import {
  assembleFrontendSnapshotPages,
  FRONTEND_SECTIONS,
  FRONTEND_PAGE_MAX_BYTES,
  FRONTEND_SECTION_BOUNDS,
} from "../../packages/domain/src/frontend-transport";
import { assemblePanelSnapshotPages, PANEL_SECTIONS } from "../../packages/domain/src/panel-read";
import {
  operationallyActive,
  directoryLeadershipRole,
} from "../../packages/domain/src/admin";
const check = (ok, message = "SNAPSHOT_CHANGED") => {
  if (!ok)
    throw Object.assign(
      new Error("The records changed while loading. Please retry."),
      { code: message },
    );
};
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const same = (a, b) => canonical(a) === canonical(b);
const identifier = (v) =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

/** An explicit list profile, never a partial FrontendSnapshot. Editors load full data. */
export async function loadEventsList(state, request, progress = (_value) => {}) {
  check(state.manifest.access.capabilities.fullSnapshot);
  let transfer = state.manifest.viewRevision ?? null;
  const get = async (section, offset, revision, viewRevision = transfer) => {
    const page = await request("/page", {surface:"full",section,offset,revision,accessRevision:state.manifest.revision,
      ...(section === "manifest" && !state.viewAs ? {sections:["terms","events"]} : {}), ...(state.viewAs ? {viewRevision} : {})});
    check(new TextEncoder().encode(JSON.stringify(page)).length <= FRONTEND_PAGE_MAX_BYTES);
    check(page.contractVersion === "frontend-pages-v1" && page.section === section &&
      (revision === null || same(page.revision, revision)));
    return page;
  };
  const selected = state.viewAs ? FRONTEND_SECTIONS : ["terms", "events"];
  const manifest = state.snapshotManifest?.sections?.length === selected.length
    ? state.snapshotManifest : await get("manifest",0,null,null);
  transfer = manifest.viewRevision ?? null;
  check(Array.isArray(manifest.sections) && manifest.sections.length === selected.length &&
    manifest.sections.every((entry,index)=>entry.section===selected[index] &&
      Number.isSafeInteger(entry.count) && entry.count >= 0 && entry.count <= FRONTEND_SECTION_BOUNDS[entry.section]));
  const read = async section => {
    const count=manifest.sections.find(entry=>entry.section===section).count, rows=[];
    let offset=0;
    while(offset<count) {
      const page=await get(section,offset,manifest.revision);
      check(page.offset===offset && same(page.scope,manifest.scope) && Array.isArray(page.rows) &&
        page.rows.length>0 && offset+page.rows.length<=count);
      rows.push(...page.rows);offset+=page.rows.length;
      check(page.nextOffset===(offset<count?offset:null));
    }
    return rows;
  };
  progress({stage:"Loading events"});
  const [terms,events]=await Promise.all([read("terms"),read("events")]);
  progress({stage:"Verifying events"});
  const verified=await get("verify",0,manifest.revision);
  check(verified.verified===true && same(verified.scope,manifest.scope) &&
    same(verified.effect ?? null,manifest.effect ?? null));
  check(terms.filter(term=>!!term.isCurrent).length===1 &&
    terms.find(term=>!!term.isCurrent).termId===manifest.scope.currentTermId &&
    new Set(events.map(event=>event.eventId)).size===events.length &&
    events.every(event=>event.termId===manifest.scope.termId));
  return {contractVersion:"events-list-v1",revision:manifest.revision,scope:manifest.scope,
    terms:terms.map(term=>({...term,isCurrent:!!term.isCurrent})),events};
}
async function virtualId(id) {
  return (
    "cadet:" +
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
/** Complete private catalogs are assembled only after server-authorized full reads. */
export async function mergeCatalogs(snapshot, people, contacts) {
  check(
    people.every(
      (p) =>
        identifier(p.personId) &&
        Number.isSafeInteger(p.version) &&
        p.version > 0 &&
        p.active === operationallyActive(p),
    ) && new Set(people.map((p) => p.personId)).size === people.length,
  );
  check(
    contacts.every(
      (c) =>
        identifier(c.contactId) &&
        Number.isSafeInteger(c.version) &&
        c.version > 0 &&
        typeof c.active === "boolean" &&
        (c.personId === null || identifier(c.personId)),
    ) && new Set(contacts.map((c) => c.contactId)).size === contacts.length,
  );
  const peopleById = new Map(people.map((p) => [p.personId, p])),
    linked = new Map(),
    flights = new Map(snapshot.flights.map((f) => [f.flightId, f])),
    squadrons = new Map(snapshot.squadrons.map((s) => [s.squadronId, s]));
  for (const person of snapshot.people)
    check(same(peopleById.get(person.personId), person));
  const leadership = contacts.map(({ version, ...contact }) => {
    if (contact.personId === null)
      return {
        ...contact,
        contactVersion: version,
        profileVersion: null,
        publicationVersion: version,
      };
    const person = peopleById.get(contact.personId);
    check(person && !linked.has(contact.personId));
    linked.set(contact.personId, contact);
    const flight = flights.get(person.flightId),
      role =
        directoryLeadershipRole(
          person.role,
          flight?.label ?? "",
          squadrons.get(flight?.squadronId)?.label ?? "",
        ) ?? "";
    return {
      ...contact,
      lastName: person.lastName,
      firstName: person.firstName,
      rank: person.rank,
      role,
      email: person.email,
      cellPhone: person.phone,
      contactVersion: version,
      profileVersion: person.version,
      publicationVersion: person.version + version,
    };
  });
  for (const person of people) {
    if (!person.active || linked.has(person.personId)) continue;
    const flight = flights.get(person.flightId),
      role = directoryLeadershipRole(
        person.role,
        flight?.label ?? "",
        squadrons.get(flight?.squadronId)?.label ?? "",
      );
    if (!role) continue;
    leadership.push({
      contactId: await virtualId(person.personId),
      personId: person.personId,
      lastName: person.lastName,
      firstName: person.firstName,
      rank: person.rank,
      role,
      email: person.email,
      cellPhone: person.phone,
      reportsTo: "",
      officePhone: "",
      officeLocation: "",
      active: true,
      contactVersion: 0,
      profileVersion: person.version,
      publicationVersion: person.version,
    });
  }
  check(new Set(leadership.map((c) => c.contactId)).size === leadership.length);
  return { ...snapshot, people, leadership };
}
/** One page per HTTP request; never publish partial or mixed-revision state. */
export async function loadSnapshot(state, request, progress = (_value) => {}) {
  const panel = state.manifest,
    full = panel.access.capabilities.fullSnapshot;
  let count = 0,
    bytes = 0;
  let transfer = state.manifest.viewRevision ?? null;
  const get = async (section, offset, revision, viewRevision = transfer, afterBaseline = undefined) => {
    const page = await request("/page", {
      surface: full ? "full" : "scoped",
      section,
      offset,
      revision,
      accessRevision: panel.revision,
      ...(afterBaseline ? {afterBaseline} : {}),
      ...(state.viewAs ? {viewRevision} : {}),
    });
    const size = new TextEncoder().encode(JSON.stringify(page)).length;
    check(
      ++count <= 512 &&
        size <= FRONTEND_PAGE_MAX_BYTES &&
        (bytes += size) <= 16 * 1024 * 1024,
      "TRANSFER_LIMIT",
    );
    check(
      page.section === section &&
        (revision === null || same(page.revision, revision)),
    );
    return page;
  };
  const manifest = full ? state.snapshotManifest?.sections?.length === FRONTEND_SECTIONS.length
    ? state.snapshotManifest : await get("manifest", 0, null, null)
    : panel.sections?.length === PANEL_SECTIONS.length ? panel : await get("manifest", 0, null, null);
  transfer = manifest.viewRevision ?? null;
  const sections = full ? FRONTEND_SECTIONS : PANEL_SECTIONS;
  check(Array.isArray(manifest.sections) && manifest.sections.length === sections.length &&
    manifest.sections.every((entry, index) => entry.section === sections[index] &&
      Number.isSafeInteger(entry.count) && entry.count >= 0 && entry.count <= FRONTEND_SECTION_BOUNDS[entry.section]));
  const sectionPages = new Map(), total = sections.length + (full ? 2 : 0);
  let completed = 0;
  progress({stage: "Loading records", completed, total});
  // Two independent sections at most, with each section's cursor kept sequential.
  // Request count and per-invocation limits are unchanged; assembly remains ordered.
  async function bounded(items, work) {
    let next = 0, failed = false;
    await Promise.all(Array.from({length: Math.min(2, items.length)}, async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try { await work(item); }
        catch (error) { failed = true; throw error; }
      }
    }));
  }
  await bounded(sections, async section => {
    const pages = [];
    if (manifest.sections.find(entry => entry.section === section).count === 0) {
      // The authenticated manifest establishes emptiness. Final verification still
      // rejects data/access changes; no incomplete section is presented as empty.
      pages.push({contractVersion: manifest.contractVersion, environment: manifest.environment,
        generation: manifest.generation, scope: manifest.scope, access: manifest.access,
        revision: manifest.revision, section, offset: 0, nextOffset: null, rows: []});
      sectionPages.set(section, pages);
      progress({stage: "Loading records", completed: ++completed, total});
      return;
    }
    let offset = 0, afterBaseline;
    do {
      const page = await get(section, offset, manifest.revision, transfer, afterBaseline);
      if(full && section==="legacyBaselines" && page.nextBaselineKey){
        const last=page.rows?.at(-1);
        check(last && last.personId===page.nextBaselineKey.personId && last.eventId===page.nextBaselineKey.eventId);
        afterBaseline=page.nextBaselineKey;
      }
      check(page.offset === offset && Array.isArray(page.rows));
      pages.push(page);
      if (page.nextOffset === null) break;
      check(
        Number.isSafeInteger(page.nextOffset) &&
          page.nextOffset === offset + page.rows.length &&
          page.nextOffset > offset,
      );
      offset = page.nextOffset;
    } while (true);
    sectionPages.set(section, pages);
    progress({stage: "Loading records", completed: ++completed, total});
  });
  const pages = sections.flatMap(section => sectionPages.get(section));
  let people, contacts;
  if (full) {
    const catalog = async (section) => {
      const rows = [];
      let offset = 0, catalogTransfer = null;
      do {
        const page = await get(section, offset, state.viewAs && offset === 0 ? null : manifest.revision, state.viewAs ? catalogTransfer : transfer);
        check(same(page.revision,manifest.revision));
        if (state.viewAs) catalogTransfer = page.viewRevision;
        check(Array.isArray(page.rows) && page.rows.length <= 32);
        rows.push(...page.rows);
        if (page.nextOffset === null) break;
        check(
          page.rows.length > 0 && page.nextOffset === offset + page.rows.length,
        );
        offset = page.nextOffset;
      } while (true);
      return rows;
    };
    await bounded(["directory-catalog", "contacts-catalog"], async section => {
      const rows = await catalog(section);
      if (section === "directory-catalog") people = rows; else contacts = rows;
      progress({stage: "Loading records", completed: ++completed, total});
    });
  }
  progress({stage: "Verifying records", completed: total, total});
  const verified = await get("verify", 0, manifest.revision);
  if (!full) return assemblePanelSnapshotPages(manifest, pages, verified);
  const snapshot = await mergeCatalogs(
    assembleFrontendSnapshotPages(manifest, pages, verified),
    people,
    contacts,
  );
  check(!snapshot.diagnostics.some((d) => d.count > 0));
  check(
    snapshot.terms.filter((t) => t.isCurrent).length === 1 &&
      snapshot.terms.find((t) => t.isCurrent).termId ===
        manifest.scope.currentTermId,
  );
  return {
    ...snapshot,
    captureScope: {
      termId: manifest.scope.termId,
      currentTermId: manifest.scope.currentTermId,
      directory: "lifetime",
      contacts: "lifetime",
    },
    access: panel.access,
  };
}
