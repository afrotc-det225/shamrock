import assert from "node:assert/strict";
import {chromium, webkit} from "playwright";
import {createLocalBackend} from "../backend.mjs";
import {AdminService} from "../service.mjs";
import {createPanelServer} from "../server.mjs";

const local = await createLocalBackend();
const service = new AdminService(local.backend);
const server = createPanelServer(service);
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const origin = "http://127.0.0.1:"+server.address().port;
const browser = process.env.SHAMROCK_TEST_WEBKIT ? await webkit.launch() :
  await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ? {executablePath:process.env.SHAMROCK_CHROMIUM_PATH} : {});

try {
  const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const reads = [], reports = [], errors = [];
  let restricted = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/state*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.meta.hosted = true;
    data.snapshot.access = {capabilities:{fullSnapshot:!restricted,attendanceCorrectionFlightIds:[]}};
    await route.fulfill({response,json:data});
  });
  await page.route("**/api/history/list*", route => {
    reads.push(route.request().url());
    return route.fulfill({json:{semesters:[{version:"fall",label:"2025 Fall"},{version:"spring",label:"2026 Spring"}]}});
  });
  await page.route("**/api/history/report", route => {
    const {version} = route.request().postDataJSON();
    reports.push(version);
    return route.fulfill({json:{headers:["TW-1 LLAB"],summary:{},rows:[{
      rowId:"fictional",firstName:"Sample",lastName:"Cadet",codes:[version==="fall"?"P":"E"],
    }]}});
  });
  await page.goto(origin+"/attendance");
  const current = page.getByRole("table",{name:"Attendance",exact:true});
  const archive = page.getByRole("table",{name:"History",exact:true});
  const picker = page.getByRole("combobox",{name:"Semester",exact:true});
  await current.waitFor();
  await picker.locator('option[value="spring"]').waitFor({state:"attached"});
  assert.deepEqual(reports,[]);
  const markPositions = element => [...element.children].map(child => {
    const {x,y,width,height} = child.getBoundingClientRect();
    return [x,y,width,height];
  });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator(".mobile-page strong").innerText(),"Attendance");
  assert.equal(await page.locator(".mobile-bar").evaluate(el=>getComputedStyle(el).position),"sticky");
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),"rgb(12, 35, 64)");
  const before = await page.locator(".mobile-bar .brand").evaluate(markPositions);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"),"#0c2340");
  assert.match(await page.locator('meta[name="viewport"]').getAttribute("content"),/viewport-fit=cover/);
  assert.equal(await page.locator(".mobile-bar").evaluate(el=>getComputedStyle(el).backgroundColor),"rgb(12, 35, 64)");
  await page.getByRole("button",{name:"Open navigation"}).click();
  assert(await page.locator(".mobile-menu").evaluate(el=>el.getBoundingClientRect().bottom >= visualViewport.height));
  assert.deepEqual(await page.locator(".mobile-menu .brand").evaluate(markPositions),before);
  assert.equal(await page.locator("nav a[aria-current=page]").innerText(),"Attendance");
  await page.getByRole("button",{name:"Close navigation"}).click();
  const filters = page.getByRole("button",{name:"Filters",exact:true});
  const flight = page.getByLabel("Flight",{exact:true});
  assert.equal(await flight.isVisible(),false);
  await filters.click();
  await flight.selectOption({index:1});
  await filters.click();
  assert.equal(await filters.getAttribute("data-active"),"true");
  await picker.selectOption("fall");
  await archive.getByRole("cell",{name:"P",exact:true}).waitFor();
  assert.equal(await archive.getByRole("button").count(),0);
  await picker.selectOption("spring");
  await archive.getByRole("cell",{name:"E",exact:true}).waitFor();
  await page.goBack();
  await archive.getByRole("cell",{name:"P",exact:true}).waitFor();
  await page.reload();
  await archive.getByRole("cell",{name:"P",exact:true}).waitFor();
  await picker.selectOption("");
  await current.waitFor();
  assert.deepEqual(reports,["fall","spring","fall","fall"]);
  await current.locator(".mark-cell button").first().click();
  assert.equal(await page.locator(".correction-targets li").first().evaluate(el=>getComputedStyle(el).listStyleType),"none");
  await page.getByRole("button",{name:"Close editor"}).click();
  let previous;
  for (const width of [948,949,950,951,952]) {
    await page.setViewportSize({width,height:800});
    const sidebar = await page.locator("aside.sidebar").boundingBox();
    const main = await page.locator(".workspace").boundingBox();
    assert(Math.abs(sidebar.width-main.x)<1);
    if (previous) assert(Math.abs(sidebar.width-previous)<1);
    previous = sidebar.width;
  }
  restricted = true;
  const allowedReads = reads.length;
  await page.goto(origin+"/attendance?semester=fall");
  await current.waitFor();
  assert.equal(await picker.count(),0);
  assert.equal(reads.length,allowedReads);
  assert.equal(new URL(page.url()).search,"");
  assert.deepEqual(errors,[]);
  console.log("Verified semester navigation, archive restrictions, mobile brand and filters, and sidebar breakpoint.");
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
  service.close();
  await local.dispose();
}
