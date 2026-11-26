import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createLocalBackend } from "../backend.mjs";
import { HostedBackend } from "../hosted/backend.mjs";
import { AdminService } from "../service.mjs";
import { createPanelServer } from "../server.mjs";

const local = await createLocalBackend(), service = new AdminService(local.backend), server = createPanelServer(service);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
try {
  const host = Object.create(HostedBackend.prototype);
  host.identity = () => local.backend.identity(); host.post = (path, body) => local.backend.post(path, body);
  const snapshot = await service.snapshot(), event = snapshot.events.find(value => value.eventId === "veterans");
  const { version, ...fields } = event;
  const proposal = await service.propose("event.upsert", { ...fields, expectedVersion: version,
    label: "Fictional receipt rehearsal", flightIds: snapshot.eventFlights.filter(value => value.eventId === event.eventId).map(value => value.flightId) });
  service.store.prepare("UPDATE proposals SET state='retryable' WHERE id=?").run(proposal.id);
  const page = await browser.newPage(), errors = [];
  let receiptCalls = 0, failReceipt = true, release;
  const held = new Promise(resolve => { release = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/state*", async route => route.fulfill({ json: {
    manifest: await host.panelManifest(), transport: "paged-v1", reportingTime: Date.now(), receiptsDeferred: true, meta: { hosted: true },
  } }));
  await page.route("**/api/page", async route => route.fulfill({ json: await host.page(route.request().postDataJSON()) }));
  await page.route("**/api/receipts", async route => {
    receiptCalls++;
    if (receiptCalls === 1) await held;
    if (failReceipt) return route.fulfill({ status: 503, json: { error: { message: "Saved changes are temporarily unavailable." } } });
    return route.fulfill({ json: { contractVersion: "admin-receipts-v1", receipts: await service.history() } });
  });
  const navigate = title => page.getByRole("navigation").getByRole("button", { name: title, exact: true }).click();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "Edit Veterans Day", exact: true }).waitFor();
  assert.equal(receiptCalls, 0, "Events does not fetch saved changes");
  await navigate("Overview");
  await page.getByText("Loading saved changes…", { exact: true }).waitFor();
  assert.equal(await page.getByText("No changes yet.", { exact: true }).count(), 0, "unloaded receipts are not empty history");
  release();
  await page.getByRole("button", { name: "Retry loading changes", exact: true }).waitFor();
  failReceipt = false;
  await page.getByRole("button", { name: "Retry loading changes", exact: true }).click();
  await page.getByRole("cell", { name: /Fictional receipt rehearsal/ }).waitFor();
  assert.equal(receiptCalls, 2);
  await navigate("System");
  await page.getByRole("button", { name: "Retry saved change", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry saved change", exact: true }).click();
  await page.getByRole("cell", { name: "Saved", exact: true }).waitFor();
  assert.equal((await service.history()).find(row => row.id === proposal.id).state, "complete");
  assert.equal((await service.snapshot()).events.find(value => value.eventId === event.eventId).label, "Fictional receipt rehearsal");
  const afterApply = receiptCalls;
  await navigate("Events");
  await page.getByRole("button", { name: "Edit Fictional receipt rehearsal", exact: true }).waitFor();
  assert.equal(receiptCalls, afterApply, "leaving receipt screens starts no extra receipt reads");
  const semesterReceipts = page.waitForResponse(response => response.url().endsWith("/api/receipts"));
  await navigate("Semester planning");
  await semesterReceipts;
  await page.waitForFunction(() => !document.body.textContent.includes("Loading saved changes…"));
  assert(receiptCalls > afterApply, "Semester loads its saved preparation plans on demand");
  assert.deepEqual(errors, []);
  console.log("PASS: no eager receipts, honest loading/error/retry, actor change history, saved-change retry refresh, and Semester receipt loading.");
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); service.close(); await local.dispose();
}
