import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPanelServer } from "../server.mjs";

const server=createPanelServer();
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ?
  {executablePath:process.env.SHAMROCK_CHROMIUM_PATH} : {});
try {
  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:850}});
    const threads=new Map();
    let paidCalls=0;
    await page.route("**/api/**",route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==="/api/session")return route.fulfill({json:{csrf:"fixture",schoolLogin:false}});
      if(path==="/api/state")return route.fulfill({json:{meta:{hosted:true,assistantAvailable:true},transport:"paged-v1",manifest:{access:{capabilities:{fullSnapshot:true}}},history:[]}});
      if(path==="/api/chat/history"){
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
    const box=await input.boundingBox();
    assert(box.y>300 && box.y<600,JSON.stringify(box));
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
    await page.getByRole("button",{name:"New chat"}).click();
    assert.equal(await answer.count(),0);
    await page.reload();
    if(width<800)await page.getByRole("button",{name:"Recent chats",exact:true}).click();
    await page.getByRole("complementary",{name:"Recent chats"}).getByRole("button",{name:/How is the detachment/}).click();
    await answer.getByRole("cell",{name:"98%"}).waitFor();
    assert.equal(paidCalls,1);
    await page.close();
  }
  console.log("Assistant composer and formatted responses passed at desktop and phone widths.");
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
