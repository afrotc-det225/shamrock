import { openNavigation } from "./navigation.mjs";
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
    if (profile==="leadership") {
      data.browse=await host.post("/v1/admin/panel/browse",{...host.identity(),profile});
      data.captureKey="fictional-leadership"; data.meta.viewAsEnabled=true;
      delete data.captureUnchanged;
    }
    if (testOverview && ["overview", "attendance"].includes(profile)) {
      overviewRequests.push(profile);
      data.browse = await host.post("/v1/admin/panel/browse", {...host.identity(), profile});
      data.captureKey = "fictional-overview";
      delete data.captureUnchanged;
    }
    await route.fulfill({ response, status: 200, json: data });
  });
  await page.route("**/api/events/editor*", async route=>route.fulfill({json:await host.post("/v1/admin/panel/browse",{...host.identity(),profile:"event-editor",...(new URL(route.request().url()).searchParams.has("id")?{recordId:new URL(route.request().url()).searchParams.get("id")}:{})})}));
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
    await openNavigation(page);
    await page
      .getByRole("navigation")
      .getByRole("link", { name: title, exact: true })
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
  assert.equal(pageReads,initialPageReads,"opening an event editor fetches no record pages");
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
    "changed revision on Events returns to the list profile after editing");
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
  const fieldTool = page.getByRole("button", {name:"Columns", exact:true});
  const tableTop = () => page.locator("main table").first().evaluate(el=>el.getBoundingClientRect().top);
  const rosterTop = await tableTop();
  await fieldTool.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("region",{name:"Columns",exact:true}).waitFor();
  assert.equal(await tableTop(),rosterTop);
  const colors = (locator) => locator.evaluate(node => {
    const { backgroundColor, color } = getComputedStyle(node);
    return [backgroundColor, color];
  });
  const cadetRow = page.getByRole("row").filter({
    has: page.getByRole("button", {name:"Edit Alex Morgan", exact:true}),
  });
  assert.deepEqual(await colors(cadetRow.getByText("AS400", {exact:true})), ["rgb(52, 78, 102)", "rgb(255, 255, 255)"]);
  assert.deepEqual(await colors(cadetRow.getByText("Alpha", {exact:true})), ["rgb(56, 107, 163)", "rgb(255, 255, 255)"]);
  assert.deepEqual(await colors(cadetRow.getByText("Active 3/4", {exact:true})), ["rgb(135, 201, 195)", "rgb(18, 58, 54)"]);
  await page.getByRole("checkbox",{name:"CIP code",exact:true}).check();
  assert.deepEqual(await colors(cadetRow.getByText("11.0701", {exact:true})), ["rgb(194, 223, 230)", "rgb(20, 62, 73)"]);
  await page.getByRole("checkbox",{name:"AFSC",exact:true}).check();
  assert.deepEqual(await colors(cadetRow.getByText("14N - Intelligence", {exact:true})), ["rgb(40, 78, 134)", "rgb(255, 255, 255)"]);
  await page.getByRole("checkbox",{name:"Flight",exact:true}).uncheck();
  assert.equal(await page.getByRole("columnheader",{name:"Sort by Flight",exact:true}).count(),0);
  assert(await cadetRow.getByText("11.0701",{exact:true}).isVisible());
  await page.getByRole("button",{name:"Columns",exact:true}).click();
  const afscSort=page.getByRole("button",{name:"Sort by AFSC",exact:true});
  await afscSort.click();
  const afscValues=()=>afscSort.evaluate(button=>{
    const th=button.closest("th");
    return [...th.closest("table").tBodies[0].rows].map(row=>row.cells[th.cellIndex].textContent).filter(v=>v!=="—");
  });
  const values=await afscValues();
  assert.deepEqual(values,[...values].sort((a,b)=>a.localeCompare(b,"en",{numeric:true,sensitivity:"base"})));
  await afscSort.click();
  assert.deepEqual(await afscValues(),[...values].reverse());
  await page.getByRole("button",{name:"Columns",exact:true}).click();
  await page.getByLabel("Filter by AFSC", {exact:true}).fill("no-such-field-value");
  assert.equal(await page.getByRole("button", {name:"Edit Alex Morgan", exact:true}).count(), 0);
  await page.getByLabel("Filter by AFSC", {exact:true}).fill("");
  await page.keyboard.press("Escape");
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
  await navigate("Excusals");
  await page.locator(".excusal-status").getByText("Submitted",{exact:true}).waitFor();
  const deny = page.getByRole("button", {name:"Deny",exact:true});
  await deny.click();
  const review = page.getByRole("dialog",{name:"Review change"});
  await review.getByText("Denied",{exact:true}).waitFor();
  assert.equal((await service.snapshot()).requests[0].status,"Submitted");
  await review.getByRole("button",{name:"Cancel change"}).click();
  await review.waitFor({state:"detached"});
  await deny.click();
  await review.getByRole("button",{name:"Apply change"}).click();
  await review.waitFor({state:"detached"});
  const decided = (await service.snapshot()).requests[0];
  assert.equal(decided.status, "Denied");
  assert.equal(decided.decisionReason,"Denied in the Excusals queue.");
  await page.getByRole("link", { name: "Attendance", exact: true }).click();
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
  assert.deepEqual(await matrix.locator("thead th:not([title])").allTextContents(), ["Cadet","Overall","LLAB"]);
  assert.equal(await page.locator(".attendance-rate-key").count(), 0);
  const yearFilter = page.getByLabel("AS year", {exact:true});
  const unfiltered = await matrix.locator("tbody tr").count();
  await yearFilter.selectOption({index:1});
  assert(await matrix.locator("tbody tr").count() > 0);
  assert(await matrix.locator("tbody tr").count() <= unfiltered);
  await yearFilter.selectOption("");
  assert.deepEqual(await colors(matrix.locator('[data-mark="blank"]').first()), ["rgb(240, 241, 242)", "rgb(66, 74, 81)"]);
  assert.deepEqual(await matrix.locator("thead th[title]").evaluateAll(headers=>
    [...new Set(headers.map(h=>h.getBoundingClientRect().width))]),[68]);
  const layout = () => page.locator("main").evaluate(el=>[el.offsetLeft,el.offsetWidth]);
  const beforeDrawer = await layout();
  const marks=matrix.locator("tbody tr");
  const matrixCell=(y,x)=>marks.nth(y).locator("button[data-event]").nth(x);
  await matrixCell(0,0).hover();
  assert.equal(await marks.nth(0).getAttribute("class"),"matrix-active-row");
  assert.equal(await matrix.locator("thead .matrix-active-column").count(),1);
  await matrixCell(0,0).click();
  await matrixCell(1,1).click({modifiers:["Shift"]});
  assert.equal(await matrix.locator('[aria-pressed="true"]').count(),4);
  await matrixCell(0,0).click({modifiers:["Meta"]});
  assert.equal(await matrix.locator('[aria-pressed="true"]').count(),3);
  await matrixCell(0,0).click({modifiers:["Control"]});
  assert.equal(await matrix.locator('[aria-pressed="true"]').count(),4);
  await page.keyboard.press("Escape");
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
  const present = matrix.locator('[data-mark="P"]').first();
  assert.deepEqual(await colors(present), ["rgb(193, 225, 205)", "rgb(22, 74, 50)"]);
  const pair=marks.filter({hasText:"Alexis Morgan"}).locator('button[data-event]').filter({hasNotText:"—"});
  const targetEvents=await pair.evaluateAll(buttons=>buttons.slice(0,2).map(b=>b.dataset.event));
  await pair.nth(0).click();
  await pair.nth(1).click({modifiers:["Meta"]});
  await page.getByLabel("Attendance code",{exact:true}).selectOption("T");
  await page.getByLabel("Reason for this change").fill("Fixture bulk correction");
  await page.getByRole("button",{name:"Review change",exact:true}).click();
  await page.getByRole("button",{name:"Apply corrections",exact:true}).click();
  await page.getByText("Attendance corrections saved.",{exact:true}).waitFor();
  const corrected=(await service.snapshot()).corrections.filter(c=>c.code==="T");
  for(const eventId of targetEvents)assert(corrected.some(c=>c.eventId===eventId));
  await navigate("Semester planning");
  const example = (await service.snapshot()).people.find(person => person.flightId && person.active);
  const fullName = example.firstName+" "+example.lastName;
  const cohortYear = page.getByLabel("Next AS year for "+example.asYear,{exact:true});
  await cohortYear.selectOption("AS400");
  const personYear = page.getByLabel("AS year for "+fullName,{exact:true});
  assert.equal(await personYear.count(),0);
  await page.getByLabel("Find a cadet").fill(fullName);
  await page.getByRole("button",{name:"Add "+fullName+" ·",exact:false}).click();
  assert.equal(await personYear.inputValue(),example.asYear);
  await personYear.selectOption("AS500");
  await page.getByRole("button",{name:"Remove exception"}).click();
  assert.equal(await personYear.count(),0);
  await page.getByLabel("Find a cadet").fill(fullName);
  await page.getByRole("button",{name:"Add "+fullName+" ·",exact:false}).click();
  await personYear.selectOption("AS500");
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
  const statusResponse = page.waitForResponse(response => response.url().includes("/api/transition?id="));
  await page
    .getByRole("button", { name: "Spring 2027 · Check progress" })
    .click();
  await page.getByText("Status: proposed. Archive: pending.").waitFor();
  const {plan:prepared} = await (await statusResponse).json();
  const exception = prepared.people.find(p => p.personId === example.personId);
  assert.equal(exception.asYear,"AS500");
  assert.equal(exception.flightId,example.flightId);
  assert.equal(exception.rank,example.rank);
  testOverview = true;
  await page.reload();
  await page.getByRole("heading",{name:"AS year progression"}).waitFor();
  assert.equal(new URL(page.url()).pathname, "/semester");
  await navigate("Events");
  await page.goBack();
  await page.getByRole("heading",{name:"AS year progression"}).waitFor();
  await page.goForward();
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
  const attendanceSummary = page.getByRole("region", {name:"Wing attendance"});
  assert.deepEqual(await attendanceSummary.locator("dt").allTextContents(), ["Overall", "LLAB"]);
  assert.equal(await attendanceSummary.getByRole("link",{name:/pending excusal/}).getAttribute("href"),"/excusals");
  const birthdays = page.getByRole("region",{name:"Wing birthdays"});
  assert.equal(await birthdays.locator(".birthday-names li i").count(),0);
  const month = birthdays.locator(".calendar-month strong");
  const originalMonth = await month.innerText();
  const week = birthdays.getByRole("button",{name:/^Week [0-9]/}).first();
  await week.click();
  assert.equal(await week.getAttribute("aria-pressed"), "true");
  await birthdays.getByRole("heading",{name:/^Week [0-9]/}).waitFor();
  assert.deepEqual(await page.locator(".overview-roster dt").allTextContents(),["Active cadets","GMC","POC","Crosstowns","Far crosstowns"]);
  assert.ok((await page.locator(".overview-roster dd").allTextContents()).every(v => /^\d+$/.test(v)));
  await birthdays.getByRole("button",{name:"Next month"}).click();
  assert.notEqual(await month.innerText(),originalMonth);
  await birthdays.getByRole("button",{name:"Reset calendar"}).click();
  assert.equal(await month.innerText(),originalMonth);
  assert.deepEqual(overviewRequests, ["overview", "charts"]);
  testOverview = false;
  await navigate("Leadership");
  const readsBeforePicker=pageReads;
  const contact=(await service.snapshot()).leadership[0];
  await page.getByRole("button",{name:"Edit "+contact.firstName+" "+contact.lastName,exact:true}).click();
  assert.equal(await page.getByLabel("Office phone",{exact:true}).inputValue(),contact.officePhone || "");
  await page.getByLabel("Office location",{exact:true}).fill("Fictional office");
  await apply();
  const updated=(await service.snapshot()).leadership.find(c=>c.contactId===contact.contactId);
  assert.equal(updated.officeLocation,"Fictional office"); assert.equal(updated.officePhone,contact.officePhone);
  assert.equal(updated.cellPhone,contact.cellPhone);
  await page.getByRole("button",{name:"View as",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:/Alexis/}).waitFor();
  await page.getByRole("button",{name:"Close editor"}).click();
  assert.equal(pageReads,readsBeforePicker,"contact edit and cached View as picker load zero record pages");
  for (const title of ["System", "Events"])
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
      .getByRole("heading", { name: "Attendance", exact: true })
      .waitFor({ timeout: 10000 });
  } catch (e) {
    console.error(await page.locator("body").innerText(), errors);
    throw e;
  }
  await openNavigation(page);
  assert.equal(
    await page.getByRole("navigation").getByRole("link").count(),
    2,
  );
  assert.equal(
    await page.getByRole("button",{name:"Correct attendance",exact:true}).count(),
    0,
  );
  await navigate("Excusals");
  await page.getByLabel("Decision status").selectOption("");
  await page.getByRole("button",{name:/^Request details for /}).click();
  await page.getByRole("dialog")
    .getByText("Fictional scheduling conflict.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve", exact: true }).count(),
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
