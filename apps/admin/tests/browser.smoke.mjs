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
  let testOverview = false, fixtureDashboard;
  const overviewRequests = [];
  let stateReads = 0,
    pageReads = 0;
  const requestedSections = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Exercise the hosted paged transport with the real local backend contract.
  const host = Object.create(HostedBackend.prototype);
  host.identity = () => local.backend.identity();
  host.post = (path, body) => local.backend.post(path, body);
  await page.route("**/api/state*", async (route) => {
    stateReads++;
    const response = await route.fetch(),
      data = await response.json();
    fixtureDashboard = data.reporting?.dashboard ?? fixtureDashboard;
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
    const profile = new URL(route.request().url()).searchParams.get("profile");
    if (testOverview && ["overview", "attendance"].includes(profile)) {
      overviewRequests.push(profile);
      data.browse = await host.post("/v1/admin/panel/browse", {...host.identity(), profile});
      data.captureKey = "fictional-overview";
      delete data.captureUnchanged;
    }
    await route.fulfill({ response, status: 200, json: data });
  });
  await page.route("**/api/wing-charts", async route => {
    overviewRequests.push("charts");
    await route.fulfill({json:{dashboard:fixtureDashboard,history:[],captureKey:"fictional-overview",
      revision:(await host.panelManifest()).revision}});
  });
  await page.route("**/api/page", async (route) => {
    pageReads++;
    requestedSections.push(route.request().postDataJSON().section);
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
  assert.equal(initialPageReads,4,"Events opens without loading attendance, roster or Directory");
  assert.deepEqual(requestedSections.slice().sort(),["events","manifest","terms","verify"]);
  const beforeEdit = await service.snapshot();
  const refreshed = page.waitForResponse((r) => r.url().split("?")[0].endsWith("/api/state"));
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
    await page.locator("dialog:modal").getByRole("heading",{name:"Review change"}).waitFor();
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
  assert.deepEqual((await service.snapshot()).events.find(e=>e.eventId==='veterans').eligiblePersonIds,
    beforeEdit.events.find(e=>e.eventId==='veterans').eligiblePersonIds,"on-demand editor preserves complete eligibility");
  await apply();
  await page.getByRole("button",{name:"Edit Veterans Day ceremony",exact:true}).waitFor();
  assert.deepEqual(requestedSections.slice(-4).sort(),["events","manifest","terms","verify"],
    "changed revision on Events returns to the list profile after a full editor capture");
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
  await page.getByLabel(/^Start time \(/).fill("07:00");
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
  await page.getByLabel("Sort by", {exact:true}).selectOption("flight");
  const fieldTool = page.getByRole("button", {name:"More fields", exact:true});
  const tableTop = () => page.locator("main table").first().evaluate(el=>el.getBoundingClientRect().top);
  const rosterTop = await tableTop();
  await fieldTool.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("region",{name:"More fields",exact:true}).waitFor();
  assert.equal(await tableTop(),rosterTop);
  await page.getByLabel("Show field", {exact:true}).selectOption("afsc");
  await page.getByLabel("Filter by AFSC", {exact:true}).fill("no-such-field-value");
  assert.equal(await page.getByRole("button", {name:"Edit Alex Morgan", exact:true}).count(), 0);
  await page.getByLabel("Filter by AFSC", {exact:true}).fill("");
  await page
    .getByRole("button", { name: "Edit Alex Morgan", exact: true })
    .click();
  // A nonmodal dialog has visible overflow by default. Wheel the actual pane
  // twice to verify its last field is reachable and scrolling stops at the edge.
  const profileDrawer = page.getByRole("dialog", {name:"Cadet profile"});
  await profileDrawer.locator("summary").click();
  const pane = await profileDrawer.boundingBox();
  const pageOffset = await page.evaluate(() => scrollY);
  await page.mouse.move(pane.x + 40, pane.y + pane.height / 2);
  await page.mouse.wheel(0, 3000);
  await page.waitForFunction(() => {
    const d = document.querySelector("dialog[open]");
    return d.scrollTop > 0 && d.scrollTop + d.clientHeight >= d.scrollHeight - 1;
  });
  await page.mouse.wheel(0, 1000);
  const lastField = await profileDrawer.locator("details label").last().boundingBox();
  const footer = await profileDrawer.locator("footer").boundingBox();
  assert(lastField.y + lastField.height <= footer.y + 1 && lastField.y >= pane.y);
  assert.equal(await page.evaluate(() => scrollY), pageOffset);
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
  const keyTool=page.getByRole("button",{name:"Attendance code key"});
  const matrixTop=await tableTop();
  await keyTool.click();
  await page.getByRole("region",{name:"Attendance code key"}).waitFor();
  assert.equal(await tableTop(),matrixTop);
  const contrasts = await page.locator(".code-key dt").evaluateAll(nodes => {
    function luminance(color) {
      const [r,g,b] = color.match(/[\d.]+/g).slice(0,3).map(v => Number(v)/255)
        .map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
      return .2126*r + .7152*g + .0722*b;
    }
    return nodes.map(node => {
      const style = getComputedStyle(node);
      const colors = [luminance(style.color),luminance(style.backgroundColor)];
      return (Math.max(...colors)+.05)/(Math.min(...colors)+.05);
    });
  });
  assert.equal(contrasts.length, 10);
  assert(Math.min(...contrasts) >= 4.5, "Attendance code text must remain legible on its fill.");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Attendance code key", expanded:false}).waitFor();
  const matrix = page.locator(".attendance-matrix");
  assert.deepEqual(await matrix.locator("thead th[title]").evaluateAll(headers=>
    [...new Set(headers.map(h=>h.getBoundingClientRect().width))]),[68]);
  const layout = () => page.locator("main").evaluate(el=>[el.offsetLeft,el.offsetWidth]);
  const beforeDrawer = await layout();
  await page.locator('button[data-event="veterans"]').and(page.getByRole("button",{name:/Alexis Morgan/})).click();
  await page.getByRole("dialog",{name:"Correct attendance"}).waitFor();
  assert.equal(await page.locator("dialog:modal").count(),0);
  assert.deepEqual(await layout(),beforeDrawer);
  await page.getByLabel("Attendance code", {exact:true}).selectOption("P");
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
  testOverview = true;
  // A fresh browser load starts with the Events list and no retained full snapshot.
  await page.reload();
  await page.getByRole("button", {name:"Edit Veterans Day ceremony",exact:true}).waitFor();
  await navigate("Overview");
  const flightChart = page.getByRole("group", {name:"Overall attendance by flight"});
  const mark = flightChart.locator(".chart-target").first();
  await mark.hover();
  await page.getByRole("tooltip").waitFor();
  assert((await mark.getAttribute("aria-label")).includes((await page.getByRole("tooltip").locator("strong").innerText())));
  await page.keyboard.press("Escape");
  await page.getByRole("tooltip").waitFor({state:"hidden"});
  await mark.focus();
  await page.getByRole("tooltip").waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(overviewRequests, ["overview", "charts"]);
  testOverview = false;
  for (const title of ["Leadership", "System", "Events"])
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
  await page.getByRole("button", {name:"Review change", exact:true}).waitFor();
  await page.locator("dialog:modal").waitFor();
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
    await page.locator(".mark-cell button").count(),
    0,
  );
  await page.getByRole("button", { name: /Excusals \(/ }).click();
  await page.getByLabel("Decision status").selectOption("");
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
