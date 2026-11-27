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
    await page.route("**/api/**",route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==="/api/session")return route.fulfill({json:{csrf:"fixture",schoolLogin:false}});
      if(path==="/api/state")return route.fulfill({json:{meta:{hosted:true,assistantAvailable:true},transport:"paged-v1",manifest:{access:{capabilities:{fullSnapshot:true}}},history:[]}});
      if(path==="/api/chat")return route.fulfill({json:{content:[
        "### Compared with prior terms","- **Overall**","  - Up **1.2 percentage points**","",
        "| Term | LLAB |","|---|---|","| Spring | 98% |","","```js","const rate = 0.98;","```"
      ].join("\n")}});
      return route.abort();
    });
    await page.goto((process.env.SHAMROCK_TEST_ORIGIN || "http://127.0.0.1:"+server.address().port)+"/assistant");
    const heading=page.getByRole("heading",{name:"Assistant",exact:true}), input=page.getByLabel("Ask SHAMROCK");
    await input.waitFor();
    const h=await heading.boundingBox(), box=await input.boundingBox();
    assert(box.y-h.y-h.height<60);
    await page.getByRole("button",{name:"How is the detachment doing?"}).click();
    assert.equal(await input.inputValue(),"How is the detachment doing?");
    await input.press("Enter");
    const answer=page.locator(".assistant-answer");
    await answer.getByRole("heading",{name:"Compared with prior terms"}).waitFor();
    assert.equal(await answer.locator("li li strong").textContent(),"1.2 percentage points");
    assert.equal(await answer.getByRole("cell",{name:"98%"}).count(),1);
    assert.equal(await answer.locator("pre code").textContent(),"const rate = 0.98;\n");
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.close();
  }
  console.log("Assistant composer and formatted responses passed at desktop and phone widths.");
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
