import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPanelServer } from "../server.mjs";

// Exercise the built application through its ordinary entry point with fictional sessions.
const server = createPanelServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH
  ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
const origin = `http://127.0.0.1:${server.address().port}`;
const requests = ["My requests", "My profile"];
const scenarios = [
  { role: "Cadet", tabs: requests },
  { role: "Flight", tabs: ["My Flight", ...requests] },
  { role: "Squadron", tabs: ["Excusals", ...requests] },
  { role: "Registration", tabs: [] },
  { role: "View as", tabs: requests },
];
try {
  for (const width of [1440, 390]) {
    for (const { role, tabs } of scenarios) {
      const preview = role === "View as";
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      const calls = [], errors = [];
      page.on("pageerror", err => errors.push(err.message));
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        calls.push(route.request().method() + " " + path);
        if (path === "/api/session") return route.fulfill({ json: {
          csrf: "fixture", schoolLogin: !preview, viewAs: preview ? {status:"ready", personId:"one"} : null,
        } });
        if (path !== "/api/cadet" || route.request().method() !== "GET") return route.abort();
        return route.fulfill({ json: {
          linked: true, writable: true, registration: role === "Registration",
          profile: role === "Registration" ? null : {personId:"one", firstName:"Sample", lastName:"Cadet", flightId:"alpha",afsc:"13N – Nuclear and Missile Operations ".repeat(6).trim(),photoLink:"https://drive.google.com/file/d/fictional-photo/view"},
          flights: [{ flightId:"alpha", label:"Alpha" }], events: [], actions: [], queue: [],
          requests: [], roster: [], reportRoster: [], flightCommander:role === "Flight",
          squadron: role === "Squadron" ? "Blue" : null,
        } });
      });
      await page.route("https://drive.google.com/**", route => width === 390 ? route.abort() : route.fulfill({
        contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>',
      }));
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
        assert.equal(await compose.getByRole("button", {name:"Submit"}).isEnabled(), !preview);
        await nav.getByRole("link", {name:"My profile"}).click();
        assert.equal(await nav.locator('[aria-current="page"]').innerText(), "My profile");
        await page.getByLabel("First name", {exact:true}).waitFor();
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
      assert.deepEqual(calls, ["POST /api/session", "GET /api/cadet"]);
      await page.close();
    }
  }
  console.log("Cadet, Flight, Squadron, registration and read-only preview passed on desktop and phone.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
