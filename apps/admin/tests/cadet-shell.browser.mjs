import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPanelServer } from "../server.mjs";

// Exercise the built application through its ordinary entry point with fictional sessions.
const server = createPanelServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH
  ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
const origin = `http://127.0.0.1:${server.address().port}`;
const requests = ["My requests","My attendance","Submit attendance","My profile"];
const scenarios = [
  { role: "Cadet", tabs: requests },
  { role: "Flight", tabs: ["My Flight", ...requests] },
  { role: "Squadron", tabs: ["Excusals", ...requests.slice(0,-1),"Attendance reviews","My profile"] },
  { role: "Registration", tabs: [] },
  { role: "View as", tabs: requests },
];
try {
  for (const width of [1440, 390]) {
    for (const { role, tabs } of scenarios) {
      const preview = role === "View as";
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      const calls = [], errors = [], flags = [];
      page.on("pageerror", err => errors.push(err.message));
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        calls.push(route.request().method() + " " + path);
        if (path === "/api/session") return route.fulfill({ json: {
          csrf: "fixture", schoolLogin: !preview, viewAs: preview ? {status:"ready", personId:"one",entryAuditId:"entry"} : null,
        } });
        if(path==="/api/cadet" && route.request().method()==="POST"){
          const body=route.request().postDataJSON();
          flags.push((preview ? body.action : body).fields.eventId);
          return route.fulfill({json:{ok:true}});
        }
        if (path !== "/api/cadet" || route.request().method() !== "GET") return route.abort();
        const section=new URL(route.request().url()).searchParams.get("section");
        return route.fulfill({ json: {
          section,attendance:section==="attendance"?[{eventId:"llab",label:"TW-1 LLAB",eventType:"llab",version:1,baseVersion:0,code:"A"},{eventId:"lab2",label:"TW-2 LLAB",eventType:"llab",version:2,baseVersion:0,code:"A"}]:[],
          linked: true, writable: true, readOnly:false, registration: role === "Registration",
          profile: role === "Registration" ? null : {personId:"one", firstName:"Sample", lastName:"Cadet", flightId:"alpha",afsc:"13N – Nuclear and Missile Operations ".repeat(6).trim(),photoLink:"https://drive.google.com/file/d/fictional-photo/view"},
          flights: [{ flightId:"alpha", label:"Alpha" }], events: [], actions: [], queue: [],
          requests: [], roster: [], reportEvents:[{eventId:"lab16",eventType:"llab",label:"TW-16 LLAB"},{eventId:"sec16",eventType:"secondary",label:"TW-16 Secondary"}],
          reportRoster:section==="report:lab16"?[["AS100","Able","Tom"],["AS400","Zed","Ron"],["AS400","Able","Zoe"],["AS400","Able","Amy"]].map(([asYear,lastName,firstName],i)=>({asYear,lastName,firstName,personId:"fixture"+i,flightId:"alpha",version:1})):[], flightCommander:role === "Flight",
          squadron: role === "Squadron" ? "Blue" : null,
        } });
      });
      await page.route("https://drive.google.com/**", route => route.abort());
      await page.route("**/api/directory/photo?*", route => {
        assert.deepEqual([...new URL(route.request().url()).searchParams],[["file","fictional-photo"]]);
        return width === 390 ? route.abort() : route.fulfill({
        contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>',
      }); });
      await page.goto(origin + (preview ? "/?workspace=cadet" : "/"));
      const nav = page.getByRole("navigation", { name:"Main navigation" });
      const heading = title => page.getByRole("heading", {name:title, level:1, exact:true});
      await heading(tabs[0] || "Create profile").waitFor();
      assert.deepEqual(await nav.getByRole("link").allTextContents(), tabs);
      if (role === "Cadet" && process.env.SHAMROCK_SCREENSHOT_DIR) {
        await page.screenshot({path:`${process.env.SHAMROCK_SCREENSHOT_DIR}/cadet-${width}.png`});
      }
      if (tabs.length) {
        await nav.getByRole("link", {name:"My requests"}).click();
        await heading("My requests").waitFor();
        const compose = page.locator("details").filter({has:page.locator("summary", {hasText:"Request an excusal"})});
        await compose.locator("summary").click();
        assert.equal(await compose.getByRole("button", {name:"Submit"}).isEnabled(), true);
        await nav.getByRole("link", {name:"My profile"}).click();
        assert.equal(await nav.locator('[aria-current="page"]').innerText(), "My profile");
        await page.getByLabel("First name", {exact:true}).waitFor();
        if (preview) await page.locator(".sidebar-bottom").getByText("Acting as Sample Cadet").waitFor();
        const afsc = page.getByLabel("Air Force Specialty Code (AFSC)");
        assert.equal(await afsc.inputValue(),"13N – Nuclear and Missile Operations ".repeat(6).trim());
        assert(await afsc.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1));
        if (width === 390) await page.getByLabel("Profile initials").waitFor();
        else await page.waitForFunction(() => document.querySelector(".profile-portrait img")?.naturalWidth > 0);
        assert.equal(await afsc.evaluate(el => el.tagName), "TEXTAREA");
        assert.equal(await page.getByRole("link",{name:"Open original photo"}).getAttribute("href"), "https://drive.google.com/file/d/fictional-photo/view");
        assert.equal(new URL(page.url()).pathname,"/me/profile");
        await page.goBack();
        await heading("My requests").waitFor();
        await page.goForward();
        await heading("My profile").waitFor();
        await nav.getByRole("link",{name:"My attendance",exact:true}).click();
        const matrix=page.getByRole("table",{name:"Attendance",exact:true});
        const before=await matrix.boundingBox();
        await page.getByRole("button",{name:/TW-1 LLAB.*A · Absent/}).click();
        const after=await matrix.boundingBox();
        assert.equal(after.y,before.y);
        const selection=page.getByRole("group",{name:"Attendance selection"});
        assert(await selection.evaluate(el=>el.previousElementSibling.classList.contains("matrix-scroll") && el.scrollWidth<=el.clientWidth));
        await page.getByRole("button",{name:/TW-2 LLAB.*A · Absent/}).click({modifiers:["Shift"]});
        await page.getByRole("button",{name:"Request correction"}).click();
        await page.getByLabel("Requested code").selectOption("P");
        await page.getByLabel("Reason",{exact:true}).fill("Fixture review");
        await page.getByRole("button",{name:"Send for Squadron review"}).click();
        await page.getByText("Saved.",{exact:true}).waitFor();
        assert.deepEqual(flags,["llab","lab2"]);
        await nav.getByRole("link",{name:"Submit attendance",exact:true}).click();
        const picker=page.getByLabel("Attendance event");
        await picker.waitFor();assert(await picker.isDisabled());
        await page.getByLabel("Event type",{exact:true}).selectOption("llab");
        assert.deepEqual(await picker.locator("option").allTextContents(),["Select an event","TW-16 LLAB"]);
        await picker.selectOption("lab16");
        const seniors=page.getByRole("group",{name:"AS400",exact:true});
        await seniors.waitFor();
        assert.deepEqual(await seniors.locator("label").allTextContents(),["Able, Amy","Able, Zoe","Zed, Ron"]);
        assert.deepEqual(await page.locator(".cadet-form legend").allTextContents(),["AS400","AS100"]);
        await seniors.getByLabel("Able, Amy").check();
        await page.getByLabel("Event type",{exact:true}).selectOption("secondary");
        assert.equal(await picker.inputValue(),"");
        assert.equal(await page.getByRole("checkbox").count(),0);
      } else {
        await page.getByRole("button", {name:"Continue"}).waitFor();
      }
      await page.getByRole("button", {name:preview ? "Exit view" : "Sign out"}).waitFor();
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
        const main = document.querySelector(".workspace").getBoundingClientRect();
        return { alongside:sidebar.right <= main.left + 1, stacked:sidebar.bottom <= main.top + 1,
          fits:document.documentElement.scrollWidth <= innerWidth };
      });
      assert(layout.fits && (width === 390 ? layout.stacked : layout.alongside), JSON.stringify(layout));
      assert.deepEqual(errors, []);
      assert.deepEqual(calls, ["POST /api/session", "GET /api/cadet",...(tabs.length?["GET /api/cadet","POST /api/cadet","POST /api/cadet","GET /api/cadet","GET /api/cadet","GET /api/cadet"]:[])]);
      await page.close();
    }
  }
  console.log("Cadet, Flight, Squadron, registration and delegated cadet workspace passed on desktop and phone.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
