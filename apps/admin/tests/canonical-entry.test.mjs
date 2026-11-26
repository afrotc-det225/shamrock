import test from "node:test";
import assert from "node:assert/strict";
import entry from "../hosted/canonical-entry.mjs";
const origin = "https://shamrock.det225.workers.dev";
test("entry forwards the exact request only from the permanent HTTPS origin", async () => {
  const req = new Request(origin + "/api/page", { method: "POST", body: "page",
    headers: { Origin: origin } });
  const env = { STAGING_PANEL: { fetch(r) { assert.equal(r, req); return Response.redirect(origin); } } };
  assert.equal((await entry.fetch(req, env)).status, 302);
  assert.equal((await entry.fetch(new Request(origin + ".example.invalid"), env)).status, 403);
});
