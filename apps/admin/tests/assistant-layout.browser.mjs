import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createPanelServer } from "../server.mjs";

const server=createPanelServer();
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=process.env.SHAMROCK_WEBKIT_PATH ? await webkit.launch({executablePath:process.env.SHAMROCK_WEBKIT_PATH}) : await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ?
  {executablePath:process.env.SHAMROCK_CHROMIUM_PATH} : {});
try {
  for(const width of [1440,900,390]){
    const page=await browser.newPage({viewport:{width,height:850},isMobile:width===390,hasTouch:width===390});
    const threads=new Map();
    let paidCalls=0, failHistory=width===390;
    await page.route("**/api/**",route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==="/api/session")return route.fulfill({json:{csrf:"fixture",schoolLogin:false}});
      if(path==="/api/state")return route.fulfill({json:{meta:{hosted:true,assistantAvailable:true},transport:"paged-v1",manifest:{access:{capabilities:{fullSnapshot:true}}},history:[]}});
      if(path==="/api/chat/history"){
        if(failHistory){failHistory=false;return route.fulfill({status:503,json:{error:{message:"Try again."}}});}
        const id=new URL(route.request().url()).searchParams.get("id");
        return route.fulfill({json:id ? {messages:threads.get(id).messages} : {chats:[...threads.values()].map(({messages,...chat})=>chat)}});
      }
      if(path==="/api/chat"){
        paidCalls++;
        const body=route.request().postDataJSON();
        const content=[
        "### Compared with prior terms","- **Overall**","  - Up **1.2 percentage points**","",
        "| Term | LLAB |","|---|---|","| Spring | 98% |","","```js","const rate = 0.98;","```"
      ].join("\n");
        threads.set(body.chatId,{id:body.chatId,title:body.chatTitle,at:Date.now(),messages:[...body.messages,{role:"assistant",content}]});
        return route.fulfill({json:{content,saved:true,chatId:body.chatId}});
      }
      return route.abort();
    });
    await page.goto((process.env.SHAMROCK_TEST_ORIGIN || "http://127.0.0.1:"+server.address().port)+"/assistant");
    const heading=page.getByRole("heading",{name:"Assistant",exact:true}), input=page.getByLabel("Ask SHAMROCK");
    await input.waitFor();
    const recent=page.getByRole("button",{name:"Recent chats",exact:true});
    const drawer=page.getByRole("dialog",{name:"Recent chats"});
    if(width===390){
      await recent.click();
      await page.getByRole("button",{name:"Retry loading recent chats"}).click();
      await drawer.getByText("No conversations yet.").waitFor();
      await page.keyboard.press("Escape");
    }
    const box=await input.boundingBox();
    const form=page.locator(".chat-form");
    const workspace=await page.locator(".workspace").boundingBox();
    const centered=await form.boundingBox();
    assert(Math.abs(centered.x+centered.width/2-workspace.x-workspace.width/2)<2);
    await recent.click();
    assert.deepEqual(await form.boundingBox(),centered);
    await page.keyboard.press("Escape");
    assert.equal(await recent.getAttribute("aria-expanded"),"false");
    assert(width===390 ? box.y>700 && box.y+box.height<=850 : box.y>300 && box.y<600,JSON.stringify(box));
    assert.equal(await input.evaluate(el=>getComputedStyle(el).resize),"none");
    await input.fill("First line");
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    assert((await input.boundingBox()).height>box.height);
    await input.fill("How is the detachment doing?");
    await input.press("Enter");
    const answer=page.locator(".assistant-answer");
    await answer.getByRole("heading",{name:"Compared with prior terms"}).waitFor();
    const followup=await input.boundingBox();
    assert(followup.y>720 && followup.y+followup.height<=850,JSON.stringify(followup));
    assert.equal(await answer.locator("li li strong").textContent(),"1.2 percentage points");
    assert.equal(await answer.getByRole("cell",{name:"98%"}).count(),1);
    assert.equal(await answer.locator("pre code").textContent(),"const rate = 0.98;\n");
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await recent.click();
    await drawer.getByRole("button",{name:"New chat"}).click();
    assert.equal(await answer.count(),0);
    let releaseRenderer;
    if(width===390){
      const held=new Promise(resolve=>{releaseRenderer=resolve});
      await page.route("**/assets/AssistantResponse-*.js",async route=>{await held;await route.continue();},{times:1});
    }
    await page.reload();
    if(width===390){
      const composerBefore=await form.boundingBox();
      await recent.click();
      await drawer.getByRole("button",{name:/How is the detachment/}).click();
      const indicator=page.getByRole("status",{name:"Loading chat"});
      await indicator.waitFor();
      assert.equal(await answer.count(),0);
      assert.deepEqual(await form.boundingBox(),composerBefore);
      releaseRenderer();
      await answer.getByRole("cell",{name:"98%"}).waitFor();
      assert.equal(await page.locator(".plain-reply").count(),0);
      assert.equal(await indicator.count(),0);
      await input.focus();
      await page.setViewportSize({width,height:460});
      await page.waitForFunction(()=>{const r=document.querySelector(".chat-form textarea").getBoundingClientRect();return r.top>=0 && r.bottom<=460;},null,{timeout:4000});
    }
    await recent.click();
    await drawer.getByRole("button",{name:/How is the detachment/}).click();
    await answer.getByRole("cell",{name:"98%"}).waitFor();
    if(width===390){
      await page.route("**/assets/AssistantResponse-*.js",route=>route.abort());
      await page.reload();
      await recent.click();
      await Promise.all([page.waitForEvent("requestfailed",r=>r.url().includes("AssistantResponse")),
        drawer.getByRole("button",{name:/How is the detachment/}).click()]);
      await page.locator(".plain-reply").filter({hasText:"Compared with prior terms"}).waitFor();
      await recent.click();
    await drawer.getByRole("button",{name:"New chat"}).click();
      await input.fill("Another question");
      assert(await page.getByRole("button",{name:"Send question"}).isEnabled());
    }
    assert.equal(paidCalls,1);
    await page.close();
  }
  console.log("Assistant composer and formatted responses passed at desktop and phone widths.");
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
