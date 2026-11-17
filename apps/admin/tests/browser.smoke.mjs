import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createLocalBackend } from "../backend.mjs";
import { HostedBackend } from "../hosted/backend.mjs";
import { AdminService } from "../service.mjs";
import { createPanelServer } from "../server.mjs";
const local = await createLocalBackend(),
  service = new AdminService(local.backend),
  server = createPanelServer(service);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch(
    process.env.SHAMROCK_CHROMIUM_PATH
      ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH }
      : {},
  );
  const page = await browser.newPage({
      viewport: { width: 1488, height: 1056 },
    }),
    errors = [];
  let stateReads = 0,
    pageReads = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  // Exercise the hosted paged transport with the real local backend contract.
  const host = Object.create(HostedBackend.prototype);
  host.identity = () => local.backend.identity();
  host.post = (path, body) => local.backend.post(path, body);
  await page.route("**/api/state", async (route) => {
    stateReads++;
    const response = await route.fetch(),
      data = await response.json();
    delete data.reporting;
    delete data.snapshot;
    delete data.error;
    data.meta ||= {};
    data.history ||= [];
    Object.assign(data, {
      manifest: await host.panelManifest(),
      transport: "paged-v1",
      reportingTime: Date.now(),
    });
    await route.fulfill({ response, status: 200, json: data });
  });
  await page.route("**/api/page", async (route) => {
    pageReads++;
    try {
      await route.fulfill({
        json: await host.page(route.request().postDataJSON()),
      });
    } catch (e) {
      await route.fulfill({
        status: e.status || 400,
        json: { error: { code: e.code, message: e.message } },
      });
    }
  });
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes("/api/"))
      console.error("Rejected request", r.status(), await r.text());
  });
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page
    .getByRole("button", { name: "Edit Veterans Day", exact: true })
    .waitFor();
  const initialPageReads = pageReads;
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/state"));
  await page.clock.fastForward(61000);
  await refreshed;
  assert.equal(
    pageReads,
    initialPageReads,
    "unchanged refresh does not redownload snapshot pages",
  );
  assert(stateReads >= 2, "visible idle panel refreshes automatically");
  const navigate = async (title) => {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: title, exact: true })
      .click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  };
  const apply = async () => {
    await page
      .getByRole("button", { name: "Review change", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await page.locator("dialog").waitFor({ state: "detached" });
  };
  await page
    .getByRole("button", { name: "Edit Veterans Day", exact: true })
    .click();
  await page
    .getByLabel("Event name", { exact: true })
    .fill("Veterans Day ceremony");
  const readsWhileEditing = stateReads;
  await page.clock.fastForward(61000);
  assert.equal(stateReads, readsWhileEditing, "refresh pauses while editing");
  assert.equal(
    await page.getByLabel("Event name", { exact: true }).inputValue(),
    "Veterans Day ceremony",
  );
  await apply();
  assert.equal(
    (await service.snapshot()).events.find((e) => e.eventId === "veterans")
      .label,
    "Veterans Day ceremony",
  );
  const beforeSchedule = await service.snapshot();
  await page
    .getByRole("button", { name: "Change schedule", exact: true })
    .click();
  await page.getByLabel("Events on or after").fill("2026-01-01");
  await page.getByLabel("New weekday").selectOption("3");
  await page.getByLabel("Start time (Eastern)").fill("07:00");
  await page
    .getByRole("button", { name: "Review schedule", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await page.locator("dialog").waitFor({ state: "detached" });
  const afterSchedule = await service.snapshot();
  for (const original of beforeSchedule.events.filter(
    (e) => e.eventType === "mando",
  )) {
    const updated = afterSchedule.events.find(
      (e) => e.eventId === original.eventId,
    );
    assert.equal(updated.columnLabel, original.columnLabel);
    assert.deepEqual(updated.eligiblePersonIds, original.eligiblePersonIds);
    assert.equal(new Date(updated.startAt).getUTCDay(), 3);
  }
  assert.deepEqual(afterSchedule.requests, beforeSchedule.requests);
  assert.deepEqual(afterSchedule.observations, beforeSchedule.observations);
  await navigate("Cadets");
  await page
    .getByRole("button", { name: "Edit Alex Morgan", exact: true })
    .click();
  await page.getByLabel("First Name", { exact: true }).fill("Alexis");
  await apply();
  assert.equal(
    (await service.snapshot()).people.find((p) => p.personId === "cadet-1")
      .firstName,
    "Alexis",
  );
  await navigate("Attendance & excusals");
  await page
    .getByRole("button", { name: "Excusals (1 pending)", exact: true })
    .click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByLabel("Decision", { exact: true }).selectOption("Denied");
  await page
    .getByLabel("Reason for this change")
    .fill("Fictional browser rehearsal");
  await apply();
  assert.equal((await service.snapshot()).requests[0].status, "Denied");
  await page.getByRole("button", { name: "Attendance", exact: true }).click();
  await page.getByLabel("Event", { exact: true }).selectOption("veterans");
  await page
    .getByRole("row")
    .filter({ hasText: "Alexis Morgan" })
    .getByRole("button", { name: "Correct" })
    .click();
  await page.getByLabel("Attendance code").selectOption("P");
  await page
    .getByLabel("Reason for this change")
    .fill("Verified fictional presence");
  await apply();
  assert.equal((await service.snapshot()).corrections[0].code, "P");
  await navigate("Semester");
  await page.getByLabel("New semester name").fill("Spring 2027");
  await page.getByLabel("First training-week Sunday").fill("2027-01-10");
  await page.getByLabel("Training weeks", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Review semester plan" }).click();
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await page.locator("dialog").waitFor({ state: "detached" });
  assert.equal(
    (await service.snapshot()).terms.find((t) => t.isCurrent).termId,
    "fall-2026",
  );
  await page
    .getByRole("button", { name: "Spring 2027 · Check progress" })
    .click();
  await page.getByText("Status: proposed. Archive: pending.").waitFor();
  for (const title of ["Overview", "Leadership", "System", "Events"])
    await navigate(title);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Edit Veterans Day ceremony", exact: true })
    .click();
  assert.ok(
    await page
      .getByRole("button", { name: "Review change", exact: true })
      .isVisible(),
  );
  await page.getByRole("button", { name: "Close editor" }).click();
  // Ordinary scoped Flight reader: no private/admin navigation or decision controls.
  await local.db
    .prepare(
      "DELETE FROM admin_grants WHERE principal_id='panel-owner' AND capability IN ('frontend.read','attendance.correct')",
    )
    .run();
  await local.db
    .prepare(
      "INSERT INTO admin_grants VALUES('panel-owner','frontend.read','flight','alpha')",
    )
    .run();
  await local.db
    .prepare(
      "DELETE FROM access_grants WHERE principal_id='panel-owner' AND capability='excusal.decide'",
    )
    .run();
  await page.reload();
  try {
    await page
      .getByRole("heading", { name: "Attendance & excusals", exact: true })
      .waitFor({ timeout: 10000 });
  } catch (e) {
    console.error(await page.locator("body").innerText(), errors);
    throw e;
  }
  assert.equal(
    await page.getByRole("navigation").getByRole("button").count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "Correct", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: /Excusals \(/ }).click();
  await page
    .getByText("Fictional scheduling conflict.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Review", exact: true }).count(),
    0,
  );
  await page.screenshot({ path: "/tmp/shamrock-scoped-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/shamrock-scoped-desktop.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: event and cadet changes, excusal decision, attendance correction, semester preparation, all screens, mobile layout, no runtime errors.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  service.close();
  await local.dispose();
}
