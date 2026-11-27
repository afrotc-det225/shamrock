import { openNavigation } from "./navigation.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPanelServer } from "../server.mjs";

// Exercise the built application through its ordinary entry point with fictional sessions.
const server = createPanelServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH
  ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
const origin = `http://127.0.0.1:${server.address().port}`;
const selfService = ["My excusals","My attendance","Submit attendance"];
const requests = ["Overview",...selfService,"Cadets","My profile"];
const scenarios = [
  { role: "Cadet", tabs: requests },
  { role: "Flight", tabs: ["Overview","My Flight",...selfService,"Excusals","Cadets","My profile"] },
  { role: "Squadron", tabs: ["Overview",...selfService,"Excusals","Attendance reviews","Cadets","My profile"] },
  { role: "Registration", tabs: [] },
  { role: "View as Squadron", tabs: ["Overview",...selfService,"Excusals","Attendance reviews","Cadets","My profile"] },
  { role: "View as", tabs: requests },
];
try {
  for (const width of [1440, 390]) {
    for (const { role, tabs } of scenarios) {
      const preview = role.startsWith("View as");
      const squadron = role === "Squadron" ? "Blue" : role === "View as Squadron" ? "Gold" : null;
      const flight = squadron === "Gold" ? "Delta" : "Alpha";
      let decision;
      const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch:width===390 });
      const calls = [], errors = [], flags = [], submissions=[];
      page.on("pageerror", err => errors.push(err.message));
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        calls.push(route.request().method() + " " + path + decodeURIComponent(new URL(route.request().url()).search));
        if (path === "/api/session") return route.fulfill({ json: {
          csrf: "fixture", schoolLogin: !preview, viewAs: preview ? {status:"ready", personId:"one",entryAuditId:"entry"} : null,
        } });
        if(path==="/api/cadet" && route.request().method()==="POST"){
          const body=route.request().postDataJSON();
          const action = preview ? body.action : body;
          if (action.kind === "decide") {
            assert.equal(decision,undefined);
            if (preview) assert.equal(body.entryAuditId,"entry");
            decision = action.fields;
          } else if(action.kind==="report") submissions.push(action.fields);
          else flags.push(action.fields.eventId);
          return route.fulfill({json:{ok:true}});
        }
        if (path !== "/api/cadet" || route.request().method() !== "GET") return route.abort();
        const section=new URL(route.request().url()).searchParams.get("section");
        if(section==="flight:other") return route.fulfill({json:{eventsForFlight:[{eventId:"other",label:"Earlier Mando"}],asOf:new Date().toISOString(),flightEvent:{eventId:"other",label:"Earlier Mando",startAt:"2026-01-01T14:00:00Z"},members:[{personId:"one",firstName:"Fixture",lastName:"Example",code:"P"}]}});
        if(section==="flight" && calls.filter(c=>c.endsWith("section=flight")).length===1){
          const now=Date.now();
          return route.fulfill({json:{asOf:new Date(now).toISOString(),refreshAt:new Date(now+1200).toISOString(),
            flightEvent:{label:"Fixture roll call",startAt:new Date(now-10000).toISOString()},members:[
              {personId:"member",asYear:"AS200",lastName:"Cadet",firstName:"Test",code:"E"},
              {personId:"second",asYear:"AS100",lastName:"Sample",firstName:"Test",code:"P"}
            ]}});
        }
        return route.fulfill({ json: {
          section,eventsForFlight:[{eventId:"other",label:"Earlier Mando"}],directory:[{personId:"peer",rank:"C/AB",firstName:"Directory",lastName:"Peer",asYear:"AS100",flight:"Alpha",squadron:"Blue"}],attendance:section==="attendance"?[{eventId:"llab",label:"TW-1 LLAB",eventType:"llab",version:1,baseVersion:0,code:"A"},{eventId:"lab2",label:"TW-2 LLAB",eventType:"llab",version:2,baseVersion:0,code:"A"}]:[],
          linked: true, writable: true, readOnly:false, registration: role === "Registration",
          profile: role === "Registration" ? null : {personId:"one", firstName:"Sample", lastName:"Cadet", flightId:"alpha",afsc:"13N – Nuclear and Missile Operations ".repeat(6).trim(),photoLink:"https://drive.google.com/file/d/fictional-photo/view"},
          flights: [{ flightId:"alpha", label:"Alpha" }], events: [], actions: [], queue: (squadron || role==="Flight") ? [{requestId:"example",version:3,personId:"cadet",eventId:"llab",event:"TW-2 LLAB",eventStartAt:"2026-10-14T14:00:00Z",
            personDisplayName:"Test Requester",requestedOutcome:"E",status:decision?.decision || "Submitted",
            submittedAt:"2026-10-10T13:20:00Z",reason:"Fixture scheduling conflict",flightId:"test-flight",capturedFlightLabel:flight,capturedSquadronLabel:squadron},
            ...[["earlier","2026-10-12T14:00:00Z"],["undated",null]].map(([id,eventStartAt])=>({
              requestId:id,version:2,eventId:id,event:id,eventStartAt,personDisplayName:id,
              requestedOutcome:"E",status:"Approved",submittedAt:"2026-10-11T12:00:00Z",flightId:"test-flight",capturedFlightLabel:flight,capturedSquadronLabel:squadron
            }))] : [],
          requests: [{requestId:"own",event:"TW-3 LLAB",requestedOutcome:"E",reason:"Conflicting lab",status:"Approved",decisionReason:"Reviewed schedule"}], roster: [{name:"Test Cadet",personId:"member",version:1,role:""}], ownFlightCount:4, reportEvents:[{eventId:"lab16",eventType:"llab",label:"TW-16 LLAB"},{eventId:"sec16",eventType:"secondary",label:"TW-16 Secondary"}],
          reportRoster:section==="report:lab16"?[["AS100","Able","Tom"],["AS400","Zed","Ron"],["AS400","Able","Zoe"],["AS400","Able","Amy"]].map(([asYear,lastName,firstName],i)=>({asYear,lastName,firstName,personId:"fixture"+i,flightId:"alpha",version:1})):[], flightCommander:role === "Flight",
          squadron,
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
      await heading(role==="Flight" ? "My Flight" : tabs.length ? "My excusals" : "Create profile").waitFor();
      await openNavigation(page);
      assert.deepEqual(await nav.getByRole("link").allTextContents(), tabs);
      assert.equal(await page.getByRole("link",{name:"View as administrator"}).count(),0);
      if (width === 390) await page.keyboard.press("Escape");
      if(role==="Flight"){
        await page.getByRole("cell",{name:"Excused",exact:true}).waitFor();
        await page.getByRole("cell",{name:"Present",exact:true}).waitFor();
        await page.getByText("No scheduled Flight events remain this semester.").waitFor();
        assert.equal(await page.getByRole("button",{name:"Refresh",exact:true}).count(),0);
        await page.getByLabel("Flight attendance event").selectOption("other");
        await page.getByRole("cell",{name:"Present",exact:true}).waitFor();
        const mark=page.locator('.flight-roll [data-mark="P"]');
        const fill=()=>mark.evaluate(cell=>getComputedStyle(cell).backgroundColor);
        const initialFill=await fill();
        assert.equal(initialFill,"rgb(193, 225, 205)");
        await mark.hover();
        assert.equal(await fill(),initialFill);
        assert.equal(await page.getByRole("button",{name:"Flight roles"}).count(),0);
        await page.getByRole("heading",{name:"Flagged attendance"}).waitFor();
      }
      if (role === "Flight" || squadron) {
        await openNavigation(page);
        await nav.getByRole("link", {name:"Excusals",exact:true}).click();
      }
      if (role==="Flight" || squadron) {
        await page.locator(".excusal-queue tbody tr").first().waitFor();
        if(width===390) await page.getByRole("button",{name:"Filters"}).click();
        if (width===390) {
          const row=page.locator(".excusal-queue tbody tr").first();
          const fits=await row.evaluate(tr=>Array.from(tr.children).every(td =>
            td.getBoundingClientRect().right<=tr.getBoundingClientRect().right+1));
          assert(fits,"the full request and decision controls fit on a phone");
          assert.equal(await row.locator(".excusal-reason").evaluate(td=>getComputedStyle(td).gridArea.split(" /")[0]),"reason");
        }
        const sort=page.getByLabel("Sort by",{exact:true});
        assert.equal(await sort.inputValue(),"submission");
        const beforeSort=calls.length;
        await page.getByLabel("Decision status").selectOption("");
        const names=page.locator(".excusal-cadet button");
        assert.deepEqual(await names.allTextContents(),["Test Requester","earlier","undated"]);
        await sort.selectOption("event-asc");
        assert.deepEqual(await names.allTextContents(),["earlier","Test Requester","undated"]);
        await sort.selectOption("event-desc");
        assert.deepEqual(await names.allTextContents(),["Test Requester","earlier","undated"]);
        await sort.selectOption("submission");
        await page.getByLabel("Decision status").selectOption("Submitted");
        assert.equal(calls.length,beforeSort);
        if(width===390) await page.keyboard.press("Escape");
      }
      if (role==="Flight") {
        const row=page.locator(".excusal-queue tbody tr");
        await row.getByText("Test Requester").click();
        assert.equal(await page.getByRole("button",{name:/^(Approve|Deny)$/}).count(),0);
        assert.equal(await page.getByLabel("More decisions").count(),0);
        await page.keyboard.press("Escape");
      }
      if (squadron) {
        const row = page.locator(".excusal-queue tbody tr");
        await row.getByTitle(flight,{exact:true}).waitFor();
        assert.equal(await row.locator("td").nth(1).innerText(),"E");
        assert.match(await row.locator("time").innerText(),/09:20 EDT/);
        const bounds=await row.locator(".excusal-status").evaluate(cell=>{
          const pill=cell.firstElementChild.getBoundingClientRect(),box=cell.closest("tr").getBoundingClientRect();
          return {right:box.right-pill.right,left:pill.left-box.left};
        });
        assert(bounds.right>=5 && bounds.left>=0);
        const actions = row.getByRole("button");
        for (const verb of ["Approve","Deny","Withdraw","Supersede"]) {
          if (verb === "Withdraw" || verb === "Supersede") await row.getByLabel("More decisions").selectOption({label:verb});
          else await actions.filter({hasText:new RegExp("^"+verb+"$")}).click();
          const confirm = page.getByRole("dialog",{name:verb+" excusal?"});
          await confirm.getByText("Test Requester",{exact:true}).waitFor();
          assert.equal(decision,undefined);
          await confirm.getByRole("button",{name:"Cancel"}).click();
        }
        await row.getByRole("button",{name:"Approve",exact:true}).click();
        const confirm = page.getByRole("dialog",{name:"Approve excusal?"});
        if (preview) await confirm.getByLabel("Decision reason (optional)").fill("Reviewed conflict");
        await confirm.getByRole("button",{name:"Confirm decision"}).click();
        await page.getByText("No requests match these filters.",{exact:true}).waitFor();
        assert.deepEqual(decision,{requestId:"example",version:3,decision:"Approved",
          reason:preview ? "Reviewed conflict" : "Approved in the Excusals queue."});
      }
      if (role === "Cadet" && process.env.SHAMROCK_SCREENSHOT_DIR) {
        await page.screenshot({path:`${process.env.SHAMROCK_SCREENSHOT_DIR}/cadet-${width}.png`});
      }
      if (tabs.length) {
        await openNavigation(page);
        await nav.getByRole("link", {name:"My excusals"}).click();
        await heading("My excusals").waitFor();
        const personal=page.locator(".personal-excusals table");
        assert.deepEqual(await personal.locator("th").allTextContents(),["Event","Code","Excusal reason","Status","Decision reason"]);
        assert.deepEqual(await personal.locator("td").allTextContents(),["TW-3 LLAB","E","Conflicting lab","Approved","Reviewed schedule"]);
        const compose=page.locator(".cadet-compose");
        assert((await personal.boundingBox()).y < (await compose.boundingBox()).y);
        assert(await compose.getByRole("heading",{name:"Request an excusal"}).isVisible());
        assert.equal(await compose.getByRole("button", {name:"Submit"}).isEnabled(), true);
        await openNavigation(page);
        await nav.getByRole("link", {name:"My profile"}).click();
        assert.equal(await page.locator('nav [aria-current="page"]').textContent(), "My profile");
        await page.getByLabel("First name", {exact:true}).waitFor();
        if (preview) await page.locator(width === 390 ? ".mobile-bar" : ".sidebar-bottom").getByText("Acting as Sample Cadet").waitFor();
        const afsc = page.getByLabel("Air Force Specialty Code (AFSC)");
        assert.equal(await afsc.inputValue(),"13N – Nuclear and Missile Operations ".repeat(6).trim());
        assert(await afsc.evaluate(el => el.validity.valid && el.list.options.length > 10));
        await afsc.fill("Typo");
        assert.equal(await afsc.evaluate(el=>el.checkValidity()),false);
        await afsc.fill("Undecided");
        assert(await afsc.evaluate(el=>el.checkValidity()));
        if (width === 390) await page.getByLabel("Profile initials").waitFor();
        else await page.waitForFunction(() => document.querySelector(".profile-portrait img")?.naturalWidth > 0);
        assert.equal(await afsc.evaluate(el => el.tagName), "INPUT");
        assert.equal(await page.getByRole("link",{name:"Open original photo"}).count(),0);
        await page.getByRole("button",{name:"Preview photo of Sample Cadet"}).click();
        assert.equal(await page.getByRole("link",{name:"Open original photo"}).getAttribute("href"), "https://drive.google.com/file/d/fictional-photo/view");
        const previewDialog=page.getByRole("dialog",{name:"Photo of Sample Cadet"});
        const box=await previewDialog.boundingBox();
        if(width===390) await page.touchscreen.tap(2,Math.max(1,box.y-2));
        else await page.keyboard.press("Escape");
        await previewDialog.waitFor({state:"detached"});
        assert.equal(new URL(page.url()).pathname,"/me/profile");
        await page.goBack();
        await heading("My excusals").waitFor();
        await page.goForward();
        await heading("My profile").waitFor();
        await openNavigation(page);
        await nav.getByRole("link",{name:"My attendance",exact:true}).click();
        const matrix=page.getByRole("table",{name:"Attendance",exact:true});
        const before=await matrix.boundingBox();
        await page.getByRole("button",{name:/TW-1 LLAB.*A · Absent/}).click();
        const after=await matrix.boundingBox();
        assert.equal(after.y,before.y);
        await page.getByRole("dialog",{name:"Request correction"}).waitFor();
        await page.getByRole("button",{name:/TW-2 LLAB.*A · Absent/}).click({modifiers:["Shift"]});
        assert.equal(await page.getByRole("group",{name:"Attendance selection"}).count(),0);
        await page.getByLabel("Requested code").selectOption("P");
        await page.getByLabel("Reason",{exact:true}).fill("Fixture review");
        await page.getByRole("button",{name:"Send for Squadron review"}).click();
        await page.getByText("Saved.",{exact:true}).waitFor();
        assert.deepEqual(flags,["llab","lab2"]);
        await openNavigation(page);
        await nav.getByRole("link",{name:"Submit attendance",exact:true}).click();
        const picker=page.getByLabel("Attendance event");
        await page.getByLabel("Event type",{exact:true}).waitFor();assert.equal(await picker.count(),0);
        await page.getByLabel("Event type",{exact:true}).selectOption("llab");
        assert.deepEqual(await picker.locator("option").allTextContents(),["Select an event","TW-16 LLAB"]);
        await picker.selectOption("lab16");
        const seniors=page.getByRole("group",{name:"AS400",exact:true});
        await seniors.waitFor();
        assert.deepEqual(await seniors.locator("label").allTextContents(),["Able, Amy","Able, Zoe","Zed, Ron"]);
        assert.deepEqual(await page.locator(".cadet-form legend").allTextContents(),["AS400","AS100"]);
        await seniors.getByLabel("Able, Amy").check();
        await page.getByLabel("Find a cadet").fill("Tom");
        assert.equal(await seniors.count(),0);
        await page.getByLabel("Find a cadet").fill("");
        assert(await seniors.getByLabel("Able, Amy").isChecked());
        const target=seniors.locator("label");
        if(width===390){
          await target.last().scrollIntoViewIfNeeded();
          const taps=await target.evaluateAll(labels=>labels.slice(1).map(label=>{
            const box=label.getBoundingClientRect();
            return [box.right-8,box.y+box.height/2,box.height];
          }));
          for(const [x,y,height] of taps){assert(height>=44);await page.touchscreen.tap(x,y);}
        } else {await target.nth(1).click();await target.nth(2).click();}
        await page.getByRole("button",{name:"Save for later"}).click();
        await page.getByText("Draft saved on this device.").waitFor();
        await openNavigation(page);
        await nav.getByRole("link",{name:"Cadets",exact:true}).click();
        await page.getByRole("cell",{name:"C/AB Directory Peer"}).waitFor();
        if(width===390) await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));

        await openNavigation(page);
        await nav.getByRole("link",{name:"Submit attendance",exact:true}).click();
        await page.getByText("Draft saved on this device.").waitFor();
        assert.equal(await page.evaluate(()=>window.scrollY),0);
        assert.equal(await page.locator(".report-checklist input:checked").count(),3);
        await page.getByLabel("Find a cadet").fill("Tom");
        await page.getByRole("button",{name:"Submit attendance",exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[name="event"]')?.value);
        assert.deepEqual(submissions[0].present.sort(),["fixture1","fixture2","fixture3"]);
        assert.equal(submissions[0].completeness,"partial");
        assert(await page.evaluate(()=>[localStorage,sessionStorage].every(store=>Object.keys(store).every(k=>!k.startsWith("shamrock.reportDraft.")))));
        await page.getByLabel("Event type",{exact:true}).selectOption("secondary");
        assert.equal(await picker.inputValue(),"");
        assert.equal(await page.getByRole("checkbox").count(),0);
      } else {
        await page.getByRole("button", {name:"Continue"}).waitFor();
      }
      await openNavigation(page);
      await page.getByRole("button", {name:preview ? "Exit view" : "Sign out"}).waitFor();
      if (width === 390) await page.keyboard.press("Escape");
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector(".mobile-bar, .sidebar").getBoundingClientRect();
        const main = document.querySelector(".workspace").getBoundingClientRect();
        return { alongside:sidebar.right <= main.left + 1, stacked:sidebar.bottom <= main.top + 1,
          fits:document.documentElement.scrollWidth <= innerWidth };
      });
      assert(layout.fits && (width === 390 ? layout.stacked : layout.alongside), JSON.stringify(layout));
      assert.deepEqual(errors, []);
      assert.deepEqual(calls, ["POST /api/session", "GET /api/cadet",...(role==="Flight"?["GET /api/cadet?section=flight","GET /api/cadet?section=flight","GET /api/cadet?section=flight:other","GET /api/cadet?section=excusals","GET /api/cadet"]:[]),...(squadron?["GET /api/cadet?section=excusals","POST /api/cadet","GET /api/cadet?section=excusals","GET /api/cadet"]:[]),...(tabs.length?["GET /api/cadet?section=profile","GET /api/cadet","GET /api/cadet?section=profile","GET /api/cadet?section=attendance","POST /api/cadet","POST /api/cadet","GET /api/cadet?section=attendance","GET /api/cadet?section=report","GET /api/cadet?section=report:lab16","GET /api/cadet?section=directory","GET /api/cadet?section=report","GET /api/cadet?section=report:lab16","POST /api/cadet","GET /api/cadet?section=report"]:[])]);
      await page.close();
    }
  }
  // A Directory member with panel permissions can move between both sets of
  // pages in one menu and session, including via browser history.
  for (const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:850}});
    let sessions=0, documents=0, full=false, failMenu=false;
    page.on("request",r=>{if(r.resourceType()==="document") documents++;});
    await page.route("**/api/**",route=>{
      const url=new URL(route.request().url());
      if(url.pathname==="/api/session"){
        sessions++;
        return route.fulfill({json:{hosted:true,csrf:"fixture",cadetWorkspace:true,schoolLogin:false}});
      }
      if(url.pathname==="/api/navigation" && failMenu)return route.fulfill({status:503,json:{error:{message:"Unavailable"}}});
      if(url.pathname==="/api/navigation")return route.fulfill({json:url.searchParams.get("include")==="personal"
        ? {personal:{flightCommander:true,squadron:false}} : {leadership:{full,canViewAs:full}}});
      if(url.pathname==="/api/cadet")return route.fulfill({json:{
        linked:true,writable:true,profile:{personId:"fixture",flightId:"alpha"},flights:[],requests:[],actions:[],events:[],flightCommander:true,
      }});
      if(url.pathname==="/api/state" && full)return route.fulfill({json:{
        meta:{hosted:true,viewAsEnabled:true},manifest:{access:{capabilities:{fullSnapshot:true,canViewAs:true}}},
        browse:{profile:"overview"},overview:{activeCadets:4},birthdayCalendar:[]
      }});
      if(url.pathname==="/api/wing-charts")return route.fulfill({json:{history:[]}});
      if(url.pathname==="/api/state")return route.fulfill({json:{
        meta:{hosted:true},manifest:{access:{capabilities:{fullSnapshot:false}}},browse:{profile:"excusals"},
        list:{access:{capabilities:{fullSnapshot:false}},people:[],events:[],terms:[],flights:[],requests:[]},
      }});
      return route.abort();
    });
    await page.goto(origin+"/me/requests");
    const nav=page.getByRole("navigation",{name:"Main navigation"});
    const checkMenu=async()=>{
      await openNavigation(page);
      await nav.getByRole("link",{name:"My profile",exact:true}).waitFor();
      await nav.getByRole("link",{name:"Attendance",exact:true}).waitFor();
      assert.deepEqual(await nav.getByRole("link").allTextContents(),["Overview","My Flight",...selfService,"Attendance","Excusals","Cadets","My profile"]);
    };
    await page.getByRole("heading",{name:"My excusals",level:1,exact:true}).waitFor();
    await checkMenu();
    await nav.getByRole("link",{name:"Excusals",exact:true}).click();
    await page.getByText("No requests match these filters.").waitFor();
    assert.equal(new URL(page.url()).pathname,"/excusals");
    await checkMenu();
    await nav.getByRole("link",{name:"My excusals",exact:true}).click();
    await page.getByRole("heading",{name:"My excusals",level:1,exact:true}).waitFor();
    await page.goBack();
    await page.getByText("No requests match these filters.").waitFor();
    assert.equal(sessions,1);
    assert.equal(documents,1);
    full=true; failMenu=true;
    await page.goto(origin+"/me/requests");
    await page.getByRole("heading",{name:"My excusals",level:1}).waitFor();
    await openNavigation(page);
    assert.equal(await page.getByRole("button",{name:"Retry loading menu"}).count(),0);
    assert.equal(await page.getByRole("link",{name:"View as administrator"}).count(),0);
    failMenu=false;
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    const switcher=page.getByRole("link",{name:"View as administrator",exact:true});
    await switcher.click();
    await page.getByRole("heading",{name:"Overview",level:1}).waitFor();
    assert.equal(new URL(page.url()).pathname,"/overview");
    await openNavigation(page);
    await page.getByRole("button",{name:"View as",exact:true}).waitFor();
    await page.getByRole("link",{name:"Assistant",exact:true}).waitFor();
    assert.equal(sessions,2,"switch keeps the same sign-in");
    await page.close();
  }
  console.log("Cadet, Flight, Squadron, registration and delegated cadet workspace passed on desktop and phone.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
