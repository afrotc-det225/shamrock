import test from "node:test";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createLocalBackend } from "../backend.mjs";
import { HostedBackend } from "../hosted/backend.mjs";
import { AdminService } from "../service.mjs";
await build({
  absWorkingDir: resolve(import.meta.dirname, "../../.."),
  entryPoints: ["apps/admin/snapshot-client.ts"],
  outfile: ".build/admin/snapshot-client.mjs",
  bundle: true,
  platform: "browser",
  format: "esm",
});
const { loadSnapshot, loadEventsList } = await import(
  "../../../.build/admin/snapshot-client.mjs"
);
function proxy(backend) {
  const host = Object.create(HostedBackend.prototype);
  host.identity = () => backend.identity();
  host.post = (path, body) => backend.post(path, body);
  return host;
}
test("Events list uses four bounded pages, never reads rosters, and stays distinct from a full snapshot", async t => {
  const local=await createLocalBackend();t.after(()=>local.dispose());
  const host=proxy(local.backend),manifest=await host.panelManifest(),calls=[];
  const list=await loadEventsList({manifest},async(_path,body)=>{calls.push(body.section);return host.page(body);});
  assert.equal(list.contractVersion,"events-list-v1");
  assert.equal(list.people,undefined);assert.equal(list.observations,undefined);
  assert.equal(list.events[0].eligiblePersonIds,undefined);
  assert.deepEqual(calls.slice().sort(),["events","manifest","terms","verify"]);
  const full=await local.backend.snapshot();
  assert.deepEqual(list.events.map(event=>event.eventId),full.events.map(event=>event.eventId));
  t.diagnostic(JSON.stringify({initialPageRequests:calls.length,initialStateRequests:1}));
});
test("47-event list uses five pages and rejects a changed final revision",async t=>{
  const local=await createLocalBackend();t.after(()=>local.dispose());
  const host=proxy(local.backend),manifest=await host.panelManifest(),calls=[];
  const fullManifest=await host.post("/v1/admin/snapshot/page",{...host.identity(),section:"manifest",offset:0,revision:null});
  const source=await host.post("/v1/admin/snapshot/page",{...host.identity(),section:"events",offset:0,revision:fullManifest.revision});
  const rows=Array.from({length:47},(_,i)=>({...source.rows[0],eventId:`fictional-event-${i}`}));
  const request=async(_path,body)=>{
    calls.push(body.section);
    const result=body.section==='events' ? {...source,offset:body.offset} : await host.page(body);
    if(body.section==='manifest') result.sections.find(entry=>entry.section==='events').count=47;
    if(body.section==='events') {result.rows=rows.slice(body.offset,body.offset+32);result.nextOffset=body.offset+result.rows.length<47?body.offset+result.rows.length:null;}
    return result;
  };
  const list=await loadEventsList({manifest},request);assert.equal(list.events.length,47);assert.equal(calls.length,5);
  await assert.rejects(()=>loadEventsList({manifest},async(path,body)=>{const value=await request(path,body);if(body.section==='verify')value.revision.operations++;return value;}));
});
test("browser paged full capture matches existing operational catalogs and preserves inactive profiles", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  const expected = await local.backend.snapshot(),
    host = proxy(local.backend);
  const manifest = await host.panelManifest();
  let pages = 0, active = 0, maximum = 0;
  const requested = [];
  const progress = [];
  const actual = await loadSnapshot({ manifest }, async (path, body) => {
    assert.equal(path, "/page");
    pages++;
    requested.push(body.section);
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 3));
      return await host.page(body);
    } finally { active--; }
  }, value => progress.push(value));
  const { access, ...snapshot } = actual;
  assert.deepEqual(snapshot, expected);
  assert.equal(access.capabilities.fullSnapshot, true);
  assert(pages > 10);
  assert.equal(maximum, 2, "independent pages overlap without exceeding two requests");
  assert.equal(progress.at(-1).stage, "Verifying records");
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  const sourceManifest = await host.post("/v1/admin/snapshot/page", {...host.identity(),section:"manifest",offset:0,revision:null});
  const empty = sourceManifest.sections.filter(entry => entry.count === 0).map(entry => entry.section);
  assert(empty.length > 0);
  assert(empty.every(section => !requested.includes(section)), "proven empty sections need no request");
  t.diagnostic(JSON.stringify({beforePageRequests: pages + empty.length, afterPageRequests: pages, skippedEmptySections: empty.length, maximumConcurrent: maximum}));
});

test("empty-section optimization rejects duplicate or invalid manifest counts", async (t) => {
  const local = await createLocalBackend(); t.after(() => local.dispose());
  const host = proxy(local.backend), manifest = await host.panelManifest();
  for (const tamper of [m => m.sections[1].section=m.sections[0].section, m => m.sections[0].count=-1]) {
    let calls=0;
    await assert.rejects(()=>loadSnapshot({manifest},async (_path,body)=>{
      calls++; const value=await host.page(body); if(body.section==='manifest')tamper(value); return value;
    }));
    assert.equal(calls,1,"invalid manifest fails before data pages");
  }
});
test("scoped pages never return private catalogs and reject alternate full reads or changed access", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  await local.db
    .prepare(
      "DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability='frontend.read'",
    )
    .run();
  await local.db
    .prepare(
      "INSERT INTO admin_grants VALUES('panel-owner','frontend.read','flight','alpha')",
    )
    .run();
  const host = proxy(local.backend),
    manifest = await host.panelManifest();
  assert.equal(manifest.access.capabilities.fullSnapshot, false);
  const snapshot = await loadSnapshot({ manifest }, (_path, body) =>
    host.page(body),
  );
  assert(snapshot.people.every((p) => p.flightId === "alpha"));
  assert(
    snapshot.people.every((p) => !("email" in p) && !("dateOfBirth" in p)),
  );
  assert.equal(snapshot.leadership, undefined);
  assert.equal(snapshot.requests[0].canDecide, true);
  await assert.rejects(
    host.page({
      surface: "full",
      section: "directory-catalog",
      offset: 0,
      revision: null,
      accessRevision: manifest.revision,
    }),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    host.page({
      surface: "scoped",
      section: "directory-catalog",
      offset: 0,
      revision: manifest.revision,
      accessRevision: manifest.revision,
    }),
  );
  await local.db
    .prepare(
      "DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability='frontend.read'",
    )
    .run();
  await assert.rejects(
    loadSnapshot({ manifest }, (_path, body) => host.page(body)),
  );
});
test("full paged capture discards a dataset changed during transfer", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  const host = proxy(local.backend),
    manifest = await host.panelManifest();
  let calls = 0;
  await assert.rejects(
    loadSnapshot({ manifest }, async (_path, body) => {
      if (++calls === 3)
        await local.db
          .prepare(
            "DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability='frontend.read'",
          )
          .run();
      return host.page(body);
    }),
  );
});
test("hosted preview and apply do not fetch full snapshots; actual versions still prevent stale writes", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  const snapshot = await local.backend.snapshot(),
    host = proxy(local.backend);
  local.backend.previewContext = (...args) => host.previewContext(...args);
  local.backend.authorizeOperation = (...args) =>
    host.authorizeOperation(...args);
  local.backend.snapshot = () => {
    throw Error("Unexpected full snapshot");
  };
  const service = new AdminService(local.backend);
  t.after(() => service.close());
  const { version, ...event } = snapshot.events[0];
  const payload = {
    ...event,
    expectedVersion: version,
    flightIds: snapshot.eventFlights
      .filter((f) => f.eventId === event.eventId)
      .map((f) => f.flightId),
    label: "Changed label",
  };
  const first = await service.propose("event.upsert", payload),
    stale = await service.propose("event.upsert", {
      ...payload,
      label: "Stale label",
    });
  await service.apply(first.id, true);
  await assert.rejects(service.apply(stale.id, true));
});

test("hosted scoped preflight uses trusted identity and saved versions; writes use atomic panel route", async () => {
  const host = Object.create(HostedBackend.prototype),
    calls = [];
  host.identity = () => ({
    environment: "staging",
    generation: 1,
    principalId: "trusted-actor",
  });
  host.post = async (path, body) => {
    calls.push({ path, body });
    return { current: { expectedVersion: 3 } };
  };
  const payload = {
    requestId: "request-demo",
    expectedVersion: 3,
    decision: "Denied",
    reason: "Test",
  };
  await host.previewContext("excusal.decide", payload);
  assert.deepEqual(calls[0], {
    path: "/v1/admin/panel/authorize",
    body: {
      ...host.identity(),
      operation: "excusal.decide",
      target: { requestId: "request-demo" },
    },
  });
  await assert.rejects(
    host.previewContext("excusal.decide", { ...payload, expectedVersion: 2 }),
    { code: "STALE_VERSION" },
  );
  const command = { operation: "excusal.decide", payload };
  await host.submit(command);
  assert.equal(calls.at(-1).path, "/v1/admin/panel/commands");
  assert.equal(calls.at(-1).body, command);
});

test("full page is withheld if panel access is revoked while old Sheets read still succeeds", async () => {
  const host = Object.create(HostedBackend.prototype),
    revision = { operations: 1, administration: 1, access: "a".repeat(64) };
  let checks = 0;
  host.identity = () => ({
    environment: "staging",
    generation: 1,
    principalId: "actor",
  });
  host.panelManifest = async () => ({
    revision,
    access: { capabilities: { fullSnapshot: ++checks === 1 } },
  });
  host.post = async () => ({ private: "must not escape" });
  await assert.rejects(
    host.page({
      surface: "full",
      section: "people",
      offset: 0,
      revision,
      accessRevision: revision,
    }),
    { code: "SNAPSHOT_CHANGED" },
  );
});

test("scoped hosted command pipeline rejects out-of-scope targets and revocation, preserving exact retries", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  await local.db
    .prepare(
      "DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability='frontend.read'",
    )
    .run();
  await local.db
    .prepare(
      "INSERT INTO admin_grants VALUES('panel-owner','frontend.read','flight','alpha')",
    )
    .run();
  await local.db
    .prepare(
      "DELETE FROM access_grants WHERE principal_id='panel-owner' AND unit_id='bravo'",
    )
    .run();
  const host = proxy(local.backend);
  local.backend.previewContext = (...args) => host.previewContext(...args);
  local.backend.authorizeOperation = (...args) =>
    host.authorizeOperation(...args);
  local.backend.submit = (command) => host.submit(command);
  const service = new AdminService(local.backend);
  t.after(() => service.close());
  const payload = {
    requestId: "request-demo",
    expectedVersion: 1,
    decision: "Denied",
    reason: "Fictional scoped rehearsal",
  };
  await assert.rejects(
    service.propose("attendance.correct", {
      personId: "cadet-3",
      eventId: "veterans",
      expectedBaseVersion: 0,
      expectedEventVersion: 1,
      code: "P",
      reason: "Outside Flight",
    }),
    { status: 403 },
  );
  const proposal = await service.propose("excusal.decide", payload);
  await local.db
    .prepare(
      "DELETE FROM access_grants WHERE principal_id='panel-owner' AND capability='excusal.decide'",
    )
    .run();
  await assert.rejects(service.apply(proposal.id, true), { status: 403 });
  await local.db
    .prepare(
      "INSERT INTO access_grants VALUES('panel-owner','excusal.decide','alpha','unit')",
    )
    .run();
  const receipt = await service.apply(proposal.id, true);
  assert.equal(receipt.state, "complete");
  assert.equal(JSON.stringify(receipt).includes("submittedBy"), false);
  assert.equal(JSON.stringify(receipt).includes("decidedBy"), false);
  assert.deepEqual(await service.apply(proposal.id, true), receipt);
  await local.db
    .prepare(
      "DELETE FROM access_grants WHERE principal_id='panel-owner' AND capability='excusal.decide'",
    )
    .run();
  await assert.rejects(service.apply(proposal.id, true), { status: 403 });
});
