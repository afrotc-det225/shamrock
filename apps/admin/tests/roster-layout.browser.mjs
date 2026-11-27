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
    ...snapshot.people[0], personId:"test-"+i, firstName:"Sample", lastName:i===49 ? "Cadet-With-A-Long-Hyphenated-Family-Name" : "Cadet "+i,
    role:i>=40 ? "MSS - "+(i===49 ? "ExtendedOperationalCoordinationAssignment" : "Support office "+i) : snapshot.people[0].role,
    afsc:i === 0 ? "14N, Intelligence" : "13N",
    flightPathStatus:"Active 3/4", photoLink:i < 2 ? "https://drive.google.com/open?id=fixture"+i+"&resourcekey=test" : "",
  }));
  const leadership = people.map(p => ({...snapshot.leadership[0], ...p, contactId:"contact-"+p.personId}));
  for(let i=0;i<9;i++) leadership.push({contactId:"staff-"+i,role:"Instructor "+i,lastName:"Example",reportsTo:"Commander",active:true});
  await page.route("**/api/state*", route => route.fulfill({json:{
    snapshot:{...snapshot, people:people.map((p,i)=>({...p,flightId:i%2 ? "blue-flight" : "gold-flight"})), leadership,
      flights:[{flightId:"blue-flight",label:"Alpha",squadronId:"blue"},{flightId:"gold-flight",label:"Delta",squadronId:"gold"}],
      squadrons:[{squadronId:"blue",label:"Blue"},{squadronId:"gold",label:"Gold"}]}, reporting:{}, history:[], meta:{hosted:true},
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
    if(path==="leadership") {
      await page.getByRole("heading",{name:"Cadet Wing Organization"}).waitFor();
      const region=page.getByRole("region",{name:"Cadet Wing organization"});
      async function assertChartFits(){
        await settle();
        const layout=await region.evaluate(el=>{
          const cards=[...el.querySelectorAll(".command-office")].map(n=>n.getBoundingClientRect()).filter(r=>r.width && r.height);
          const overlap=cards.some((a,i)=>cards.slice(i+1).some(b=>
            Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
          const truncated=[...el.querySelectorAll(".command-office button,.command-office strong")].some(n=>
            n.clientWidth && n.scrollWidth>n.clientWidth+1);
          return {overlap,truncated,pageOverflow:document.documentElement.scrollWidth>innerWidth};
        });
        assert.deepEqual(layout,{overlap:false,truncated:false,pageOverflow:false});
      }
      async function wingLayout(){
        await settle();
        return region.locator('.org-root:has([data-office="wing"]) + ul').evaluate(list=>{
          const root=list.getBoundingClientRect();
          return [...list.querySelectorAll("[data-office]")].map(office=>{
            const r=office.getBoundingClientRect();
            return [office.dataset.office,Math.round(r.left-root.left),Math.round(r.top-root.top),Math.round(r.width)];
          });
        });
      }
      for(const width of [320,390,1024,1280,1440,1920]){
        await page.setViewportSize({width,height:850});
        await assertChartFits();
        const before=width>=1280 ? await wingLayout() : null;
        await region.getByRole("button",{name:"Focus on Operations Officer",exact:true}).click();
        if(before) assert.deepEqual(await wingLayout(),before,"The cadre chain leaves the Wing its full width");
        await region.getByRole("button",{name:"Focus on Wing Commander",exact:true}).click();
        if(before) assert.deepEqual(await wingLayout(),before,"Wing branches keep their layout when focused at "+width);
        await assertChartFits();
        if(width<=390) assert.equal(await region.getByRole("button",{name:"Focus on Alpha Flight",exact:true}).count(),0);
        const title=region.getByRole("button",{name:"Focus on Mission Support Squadron",exact:true});
        assert.equal(await title.locator("svg").count(),0);
        await title.focus();
        await page.keyboard.press("Enter");
        await region.getByText("ExtendedOperationalCoordinationAssignment",{exact:true}).waitFor();
        await assertChartFits();
        await page.getByLabel("Organization branch").selectOption("");
      }
      for (const width of [320,390,1024,1440]) {
        await page.setViewportSize({width,height:850});
        await page.getByLabel("Find a person or office").fill("Sample Cadet 0");
        const person=page.getByRole("button",{name:"Contact details for Sample Cadet 0",exact:true}).first();
        await person.click();
        await page.getByRole("dialog",{name:"Sample Cadet 0"}).waitFor();
        await page.keyboard.press("Escape");
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      continue;
    }
    await page.getByRole("button",{name:"Sample Cadet 0",exact:true}).waitFor();
    for (const width of [390,1440]) {
      await page.setViewportSize({width,height:850});
      await page.getByRole("button",{name:"Sample Cadet 0",exact:true}).click();
      const editor=page.getByRole("dialog",{name:"Cadet profile"});
      const tools=editor.locator(".cadet-profile-tools");
      await tools.scrollIntoViewIfNeeded();
      await editor.evaluate(el=>el.scrollTo(0,el.scrollHeight));
      const spacing=await tools.evaluate(el=>{
        const photo=el.querySelector(".photo-trigger").getBoundingClientRect(),summary=el.querySelector("summary").getBoundingClientRect();
        const footer=el.closest("form").querySelector("footer"),divider=footer.getBoundingClientRect().top;
        return {top:summary.top-photo.top,gap:divider-Math.max(summary.bottom,photo.bottom),actions:footer.querySelector(".actions").getBoundingClientRect().top-divider};
      });
      assert(Math.abs(spacing.top)<1 && spacing.gap>=-1 && spacing.gap<=12 && spacing.actions<=12,JSON.stringify({width,spacing}));
      await tools.locator("summary").click();
      await editor.getByLabel("Photo link",{exact:true}).waitFor();
      await page.keyboard.press("Escape");
      const row=page.getByRole("row").filter({has:page.getByRole("button",{name:"Edit Sample Cadet 0",exact:true})});
      for(const [column,field] of [["squadron","flight"],["flightPathStatus","flightPathStatus"],["afsc","afsc"]]) {
        const cell=row.locator(`td[data-column="${column}"]`);
        await cell.click();
        await editor.waitFor();
        const control=editor.locator(`[name="${field}"]`);
        await control.waitFor();
        assert(await control.evaluate(input=>{
          const field=input.closest("label"),drawer=input.closest("dialog"),rect=field.getBoundingClientRect();
          return document.activeElement===field && rect.top>=drawer.querySelector("header").getBoundingClientRect().bottom-1 &&
            rect.bottom<=drawer.querySelector("footer").getBoundingClientRect().top+1;
        }),column+" should open at the editable field at "+width);
        assert.equal(await editor.locator('input[name="lastName"]').inputValue(),"Cadet 0");
        await page.keyboard.press("Escape");
      }
    }
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
      if (path==="cadets") {
        const heights=await page.locator(".cadet-roster tbody tr").evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
        assert(Math.max(...heights)-Math.min(...heights)<=1, "uniform desktop rows: "+[Math.min(...heights),Math.max(...heights)]);
      }
      start.forEach((value,i) => assert(Math.abs(value-end[i]) < 1,`${path} at ${width}px, metric ${i}`));
    }
    if (path==="cadets") {
      await page.evaluate(() => scrollTo(0,0));
      const squadron = page.getByRole("combobox",{name:"Squadron",exact:true});
      const flight = page.getByRole("combobox",{name:"Flight",exact:true});
      await squadron.selectOption("blue");
      assert.equal(await page.locator(".cadet-roster tbody tr").count(),27);
      assert.deepEqual(await flight.locator("option").allTextContents(),["All flights","Alpha"]);
      await flight.selectOption("blue-flight");
      await squadron.selectOption("gold");
      assert.equal(await flight.inputValue(),"");
      assert.equal(await page.locator(".cadet-roster tbody tr").count(),28);
      await squadron.selectOption("");
      assert.equal(await page.locator(".cadet-roster tbody tr").count(),55);
      await page.waitForFunction(() => document.querySelector('.directory-avatar img')?.naturalWidth > 0);
      await page.getByRole("button",{name:"Edit Sample Cadet 0",exact:true}).click();
      const editor=page.getByRole("dialog",{name:"Cadet profile"});
      const photo=editor.getByRole("button",{name:"Preview photo of Sample Cadet 0"});
      assert((await photo.boundingBox()).height>=44);
      await photo.click();
      const editorPhoto=page.getByRole("dialog",{name:"Photo of Sample Cadet 0"});
      await editorPhoto.locator("img").click();
      assert(await editorPhoto.isVisible());
      await page.mouse.click(3,3);
      await editorPhoto.waitFor({state:"detached"});
      assert(await editor.isVisible());
      assert(await photo.evaluate(el=>el===document.activeElement));
      await editor.getByRole("button",{name:"Close editor"}).click();
      const failedRow = page.getByRole("row").filter({has:page.getByRole("button",{name:"Sample Cadet 1",exact:true})});
      await failedRow.locator(".directory-avatar").getByText("SC").waitFor();
      await page.getByRole("button",{name:"Columns",exact:true}).click();
      const selected = page.getByRole("region",{name:"Columns"}).getByRole("checkbox",{checked:true});
      assert.deepEqual(await selected.evaluateAll(boxes=>boxes.map(box=>box.parentElement.textContent)),["Cadet","AS year","Flight","Squadron","Status","Role","University","Email","Phone","Dorm","CIP broad area","CIP code","AFSC","Home Town","Home State","Graduation year","Date of birth","Photo link"]);
      await page.keyboard.press("Escape");
      assert.equal(await failedRow.getByRole("link").count(),0);
      await page.route("https://drive.google.com/file/d/fixture1/preview?*",route => route.fulfill({contentType:"text/html",body:"Image preview"}));
      await failedRow.locator(".directory-avatar").click();
      assert.equal(await editor.count(),0);
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
      const specialty=table.locator('tbody td[data-column="afsc"]');
      await specialty.click();
      await editor.getByLabel("AFSC",{exact:true}).waitFor();
      assert.equal(await editor.getByLabel("AFSC",{exact:true}).inputValue(),"14N, Intelligence");
      await page.keyboard.press("Escape");
      await specialty.evaluate(cell=>{
        const range=document.createRange();
        range.selectNodeContents(cell);
        const selection=window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        cell.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        selection.removeAllRanges();
      });
      assert.equal(await editor.count(),0);
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
    for (const width of [320,390,430]) {
      await page.setViewportSize({width,height:844});
      const filters = page.getByRole("button",{name:"Filters",exact:true});
      await filters.waitFor();
      if (path==="cadets" && width===320) {
        await filters.click();
        await page.getByLabel("Table zoom").selectOption("85");
        assert.equal(await page.locator(".cadet-roster table").evaluate(el=>Number(getComputedStyle(el).zoom)),.85);
        await page.getByRole("combobox",{name:"Squadron",exact:true}).selectOption("blue");
        await filters.click();
        await page.getByLabel("Find a cadet",{exact:true}).fill("Sample");
        assert.equal(await page.locator(".search-count").textContent(),"27 matches");
      }
      if(path==="cadets"){
        const heights=await page.locator(".cadet-roster tbody tr").evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
        assert(Math.max(...heights)-Math.min(...heights)<=1, "uniform phone rows: "+[Math.min(...heights),Math.max(...heights)]);
      }
      assert(await page.locator(".person-cell .text-button").evaluateAll(elements=>elements.every(el=>{
        const td=el.closest("td").getBoundingClientRect(), box=el.getBoundingClientRect();
        return box.right<=td.right+1 && el.scrollWidth<=el.clientWidth+1;
      })));
      const search = await page.locator(".toolbar .search").boundingBox();
      const buttons = page.locator(".toolbar > button, .toolbar-actions > button");
      for (const button of await buttons.all()) {
        const box = await button.boundingBox();
        assert(Math.abs(box.y-search.y)<1 && box.width>=44 && box.x+box.width<=width);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.route("**/api/state*", async route => {
    const request = snapshot.requests[0];
    const requests = ["Blue","Gold"].map(squadron => ({...request, requestId:squadron, capturedSquadronLabel:squadron,
      flightId:squadron, capturedFlightLabel:squadron === "Blue" ? "Alpha" : "Delta", reason:squadron+" request"}));
    await route.fulfill({json:{snapshot:{...snapshot,requests}, reporting:{}, history:[], meta:{hosted:true}}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/excusals`);
  const filters = page.getByRole("button",{name:"Filters",exact:true});
  await filters.click();
  await page.getByLabel("Squadron",{exact:true}).selectOption("Gold");
  await filters.click();
  assert.equal(await page.locator(".excusal-queue tbody tr").count(),1);
  await page.locator(".excusal-queue").getByText("Gold request").waitFor();
  for (const width of [320,390,1024,1440]) {
    await page.setViewportSize({width,height:850});await settle();
    const more=page.getByLabel("More decisions").first();
    const compact=width<=1024;
    assert.equal(await more.isVisible(),!compact);
    if(compact) {
      const buttons=page.locator(".excusal-controls").getByRole("button");
      assert.deepEqual(await buttons.allTextContents(),["Approve","Deny","Withdraw","Supersede"]);
      for(const button of await buttons.all()){
        assert(await button.evaluate(el=>{
          const box=el.getBoundingClientRect(),cell=el.closest("td").getBoundingClientRect();
          return box.height>=44 && el.scrollWidth<=el.clientWidth+1 && box.right<=cell.right+1 && box.left>=cell.left-1;
        }));
      }
    } else {
      const moreFits=await more.evaluate(el=>{
        const box=el.getBoundingClientRect(),cell=el.closest("td").getBoundingClientRect();
        return {width:box.width, right:box.right-cell.right, left:box.left-cell.left, needed:parseFloat(getComputedStyle(el).fontSize)*4.9};
      });
      assert(moreFits.width>=moreFits.needed && moreFits.right<=1 && moreFits.left>=-1, JSON.stringify({width,moreFits}));
    }
    assert.equal(await page.locator("td.excusal-reason").innerText(),"Gold request");
  }
  console.log("Desktop header positions, roster widths, mobile overflow, image loading and private-photo fallback passed.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  service.close();
  await local.dispose();
}
