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
const { loadSnapshot } = await import(
  "../../../.build/admin/snapshot-client.mjs"
);
function proxy(backend) {
  const host = Object.create(HostedBackend.prototype);
  host.identity = () => backend.identity();
  host.post = (path, body) => backend.post(path, body);
  return host;
}
test("browser paged full capture matches existing operational catalogs and preserves inactive profiles", async (t) => {
  const local = await createLocalBackend();
  t.after(() => local.dispose());
  const expected = await local.backend.snapshot(),
    host = proxy(local.backend);
  const manifest = await host.panelManifest();
  let pages = 0;
  const actual = await loadSnapshot({ manifest }, async (path, body) => {
    assert.equal(path, "/page");
    pages++;
    return host.page(body);
  });
  const { access, ...snapshot } = actual;
  assert.deepEqual(snapshot, expected);
  assert.equal(access.capabilities.fullSnapshot, true);
  assert(pages > 10);
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

test('full page is withheld if panel access is revoked while old Sheets read still succeeds',async()=>{
 const host=Object.create(HostedBackend.prototype),revision={operations:1,administration:1,access:'a'.repeat(64)};
 let checks=0;
 host.identity=()=>({environment:'staging',generation:1,principalId:'actor'});
 host.panelManifest=async()=>({revision,access:{capabilities:{fullSnapshot:++checks===1}}});
 host.post=async()=>({private:'must not escape'});
 await assert.rejects(host.page({surface:'full',section:'people',offset:0,revision,accessRevision:revision}),{code:'SNAPSHOT_CHANGED'});
});
