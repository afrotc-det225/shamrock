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
  // Safari can expose the document canvas below its floating address bar.
  const canvasColors = () => page.evaluate(() => [document.documentElement, document.body]
    .map(el => getComputedStyle(el).backgroundColor));
  const whiteCanvas = ["rgb(255, 255, 255)", "rgb(255, 255, 255)"];
  assert.deepEqual(await canvasColors(),whiteCanvas);
  const search = page.getByRole("textbox",{name:"Find a cadet"});
  const fieldFont = el => parseFloat(getComputedStyle(el).fontSize);
  assert(await search.evaluate(fieldFont) >= 16);
  const toolbar = page.locator(".page-controls .toolbar");
  for (const width of [320,375,390]) {
    await page.setViewportSize({width,height:844});
    const fields = [picker,search,page.getByRole("button",{name:"Filters",exact:true})];
    const centers = await Promise.all(fields.map(async field => {
      const box = await field.boundingBox();
      return box.y + box.height/2;
    }));
    assert(Math.max(...centers)-Math.min(...centers)<2,"Semester, search and Filters share one row");
    const sizes = await current.locator("thead th").evaluateAll(headers=>headers.map(h=>h.getBoundingClientRect().width));
    assert(sizes[0]>=125 && sizes[0]<=160 && sizes[1]>=48 && sizes[1]<=50 && sizes[2]===sizes[1]);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  const filters=page.getByRole("button",{name:"Filters",exact:true});
  const eventWidth=()=>current.locator("thead th").last().evaluate(th=>th.getBoundingClientRect().width);
  const normalWidth=await eventWidth();
  await filters.click(); await page.getByLabel("Table zoom").selectOption("75"); await filters.click();
  assert(Math.abs(await eventWidth()-normalWidth*.75)<2);
  const beforeFocus = await toolbar.boundingBox();
  const scale = await page.evaluate(() => visualViewport.scale);
  await search.tap();
  assert.deepEqual(await toolbar.boundingBox(),beforeFocus);
  assert.equal(await page.evaluate(() => visualViewport.scale),scale);
  await search.blur();
  const key = current.getByRole("button",{name:"Attendance code key"});
  await key.click();
  await page.getByRole("region",{name:"Attendance code key"}).getByText("Present",{exact:true}).waitFor();
  assert.deepEqual(await toolbar.boundingBox(),beforeFocus);
  await key.click();
  const before = await page.locator(".mobile-bar .brand").evaluate(markPositions);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"),"#0c2340");
  assert.match(await page.locator('meta[name="viewport"]').getAttribute("content"),/viewport-fit=cover/);
  assert.equal(await page.locator(".mobile-bar").evaluate(el=>getComputedStyle(el).backgroundColor),"rgb(12, 35, 64)");
  await page.getByRole("button",{name:"Open navigation"}).click();
  assert(await page.locator(".mobile-menu").evaluate(el=>el.getBoundingClientRect().bottom >= visualViewport.height));
  assert.deepEqual(await page.locator(".mobile-menu .brand").evaluate(markPositions),before);
  assert.equal(await page.locator("nav a[aria-current=page]").innerText(),"Attendance");
  await page.getByRole("button",{name:"Close navigation"}).click();
  assert.deepEqual(await canvasColors(),whiteCanvas);
  const flight = page.getByLabel("Flight",{exact:true});
  assert.equal(await flight.isVisible(),false);
  await filters.click();
  await flight.selectOption({index:1});
  await filters.click();
  assert.equal(await filters.getAttribute("data-active"),"true");
  await picker.selectOption("fall");
  await archive.getByRole("cell",{name:"P",exact:true}).waitFor();
  assert.equal(await archive.locator("tbody button").count(),0);
  await archive.getByRole("button",{name:"Attendance code key"}).waitFor();
  assert.equal(await archive.evaluate(table=>Number(getComputedStyle(table).zoom)),.75);
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
  const reason = page.getByRole("dialog").getByRole("textbox");
  assert(await reason.evaluate(fieldFont) >= 16);
  await reason.tap();
  assert.equal(await page.evaluate(() => visualViewport.scale),scale);
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
