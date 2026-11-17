import {
  assembleFrontendSnapshotPages,
  FRONTEND_SECTIONS,
  FRONTEND_PAGE_MAX_BYTES,
} from "../../packages/domain/src/frontend-transport";
import { assemblePanelSnapshotPages } from "../../packages/domain/src/panel-read";
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
async function mergeCatalogs(snapshot, people, contacts) {
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
export async function loadSnapshot(state, request) {
  const panel = state.manifest,
    full = panel.access.capabilities.fullSnapshot;
  let count = 0,
    bytes = 0;
  const get = async (section, offset, revision) => {
    const page = await request("/page", {
      surface: full ? "full" : "scoped",
      section,
      offset,
      revision,
      accessRevision: panel.revision,
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
  const manifest = full ? await get("manifest", 0, null) : panel,
    pages = [];
  const sections = full
    ? FRONTEND_SECTIONS
    : manifest.sections.map((x) => x.section);
  for (const section of sections) {
    let offset = 0;
    do {
      const page = await get(section, offset, manifest.revision);
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
  }
  let people, contacts;
  if (full) {
    const catalog = async (section) => {
      const rows = [];
      let offset = 0;
      do {
        const page = await get(section, offset, manifest.revision);
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
    people = await catalog("directory-catalog");
    contacts = await catalog("contacts-catalog");
  }
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
