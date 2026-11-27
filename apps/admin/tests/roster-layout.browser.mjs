import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import { chromium } from "playwright";
import { createLocalBackend } from "../backend.mjs";
import { AdminService } from "../service.mjs";
import { createPanelServer } from "../server.mjs";

const local = await createLocalBackend();
const service = new AdminService(local.backend);
const server = createPanelServer(service);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH
  ? { executablePath:process.env.SHAMROCK_CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({viewport:{width:1440,height:850}});
  const snapshot = await service.snapshot();
  const photoUrl = "https://drive.google.com/open?id=fixture0&resourcekey=test";
  const person = snapshot.people[0];
  await local.db.prepare("UPDATE directory_profiles SET photo_link=? WHERE person_id=?").bind(photoUrl, person.personId).run();
  const browse = await local.backend.post("/v1/admin/panel/browse", {...local.backend.identity(), profile:"cadets"});
  const row = JSON.parse(browse.tables.people).find(fields => fields[0] === person.personId);
  assert.equal(row.at(-1), photoUrl);
  const people = Array.from({length:55}, (_, i) => ({
    ...snapshot.people[0], personId:"test-"+i, firstName:"Sample", lastName:"Cadet "+i,
    afsc:i === 0 ? "14N, Intelligence" : "13N",
    flightPathStatus:"Active 3/4", photoLink:i < 2 ? "https://drive.google.com/open?id=fixture"+i+"&resourcekey=test" : "",
  }));
  const leadership = people.map(p => ({...snapshot.leadership[0], ...p, contactId:"contact-"+p.personId}));
  await page.route("**/api/state*", route => route.fulfill({json:{
    snapshot:{...snapshot, people, leadership}, reporting:{}, history:[], meta:{hosted:true},
  }}));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="18"/></svg>';
  await page.route("https://drive.google.com/thumbnail?*", route => {
    const params = new URL(route.request().url()).searchParams;
    assert.equal(params.get("resourcekey"),"test");
    assert.equal(params.get("id"), "fixture1");
    return route.abort();
  });
  await page.route("**/api/directory/photo?*", route => {
    const params = new URL(route.request().url()).searchParams;
    assert.equal(params.get("person"), params.get("file") === "fixture0" ? "test-0" : "test-1");
    return params.get("file") === "fixture0" ? route.fulfill({contentType:"image/svg+xml",body:svg}) : route.abort();
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const path of ["cadets","leadership"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/${path}`);
    await page.getByRole("button",{name:"Sample Cadet 0",exact:true}).waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1280,1440,1600]) {
      await page.setViewportSize({width,height:850});
      const measure = () => page.evaluate(() => {
        const rect = s => document.querySelector(s).getBoundingClientRect();
        return [rect(".page-controls").top,rect(".toolbar-actions").top,rect("thead th").top,rect("thead th").width];
      });
      const scroll = top => page.evaluate(y => {
        const roster = document.querySelector('.table-scroll[data-horizontal="true"]');
        if (roster) roster.scrollTo(0,y); else scrollTo(0,y);
      }, top);
      await scroll(0);await settle();const start = await measure();
      await scroll(300);await settle();const end = await measure();
      assert(await page.evaluate(() => scrollY > 0 || document.querySelector(".table-scroll")?.scrollTop > 0));
      assert.equal(start[0],0);
      assert(start[3] <= 240);
      start.forEach((value,i) => assert(Math.abs(value-end[i]) < 1,`${path} at ${width}px, metric ${i}`));
    }
    if (path==="cadets") {
      await page.evaluate(() => scrollTo(0,0));
      await page.waitForFunction(() => document.querySelector('.directory-avatar img')?.naturalWidth > 0);
      const failedRow = page.getByRole("row").filter({has:page.getByRole("button",{name:"Sample Cadet 1",exact:true})});
      await failedRow.locator(".directory-avatar").getByText("SC").waitFor();
      await page.getByRole("button",{name:"Columns",exact:true}).click();
      const selected = page.getByRole("region",{name:"Columns"}).getByRole("checkbox",{checked:true});
      assert.deepEqual(await selected.evaluateAll(boxes=>boxes.map(box=>box.parentElement.textContent)),["Cadet","AS year","Flight","Squadron","Status","Role","University","Email","Phone","Dorm","CIP broad area","CIP code","AFSC","Home Town","Home State","Graduation year","Date of birth","Photo link"]);
      await page.keyboard.press("Escape");
      assert.equal(await failedRow.getByRole("link").count(),0);
      await page.route("https://drive.google.com/file/d/fixture1/preview?*",route => route.fulfill({contentType:"text/html",body:"Image preview"}));
      await failedRow.locator(".directory-avatar").click();
      const preview=page.getByRole("dialog",{name:"Photo of Sample Cadet 1"});
      assert.equal(await preview.getByRole("link",{name:"Open original photo"}).getAttribute("href"),people[1].photoLink);
      await preview.frameLocator("iframe").getByText("Image preview").waitFor();
      await preview.getByRole("button",{name:"Close preview"}).click();
      assert.equal(await preview.count(),0);
      assert.deepEqual((await page.locator(".cadet-roster thead th").allTextContents()).slice(0,5),["Cadet","AS year","Flight","Squadron","Status"]);
      const columns=page.getByRole("button",{name:"Columns",exact:true});
      await columns.click();
      const picker=page.getByRole("region",{name:"Columns"});
      for(const field of ["Last name","AFSC"])await picker.getByRole("checkbox",{name:field,exact:true}).check();
      for (const box of await picker.getByRole("checkbox").all())
        if (!["Last name","AFSC"].includes((await box.locator("..").innerText()).trim())) await box.uncheck();
      const table=page.locator(".cadet-roster");
      assert.deepEqual(await table.locator("thead th").allTextContents(),["Last name","AFSC"]);
      await page.keyboard.press("Escape");
      await page.getByLabel("Find a cadet",{exact:true}).fill("Sample Cadet 0");
      assert.equal(await table.locator("tbody tr").count(),1);
      await columns.click();
      await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
      await picker.getByRole("button",{name:"Copy table"}).click();
      await picker.getByText("Copied to clipboard.").waitFor();
      assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll("\r\n","\n"),"Last name\tAFSC\nCadet 0\t14N, Intelligence");
      const download=page.waitForEvent("download");
      await picker.getByRole("button",{name:"Download CSV"}).click();
      assert.equal(await readFile(await (await download).path(),"utf8"),'Last name,AFSC\r\nCadet 0,"14N, Intelligence"');
      await page.reload();
      await table.locator("tbody tr").first().waitFor();
      assert.deepEqual(await table.locator("thead th").allTextContents(),["Last name","AFSC"]);
      assert.equal(await table.locator(".directory-avatar").count(),0);
      await page.evaluate(()=>{
        localStorage.removeItem("shamrock.cadets.columns.v2");
        localStorage.setItem("shamrock.cadets.columns.v1", JSON.stringify(["afsc","rank"]));
      });
      await page.reload();
      await table.locator("tbody tr").first().waitFor();
      assert.deepEqual(await table.locator("thead th").allTextContents(),["Cadet","Rank","AFSC",""]);

    }
    await page.setViewportSize({width:390,height:844});await settle();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log("Desktop header positions, roster widths, mobile overflow, image loading and private-photo fallback passed.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  service.close();
  await local.dispose();
}
