import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {chromium} from "@playwright/test";
import {areas,runnable} from "../hosted/maintenance.mjs";
const dir=new URL("../dist/assets/",import.meta.url);
const file=(await readdir(dir)).find(f=>/^assistant-sandbox-.*\.js$/.test(f));
assert.ok(file,"Build the panel first");
const browser=await chromium.launch({executablePath:process.env.SHAMROCK_CHROMIUM_PATH});
try {
  const page=await browser.newPage();
  await page.route("https://fixture.invalid/**", async route=>{
    if (new URL(route.request().url()).pathname === "/") return route.fulfill({body:"<title>Runner</title>",contentType:"text/html"});
    assert.ok(route.request().url().endsWith(file));
    await route.fulfill({body:await readFile(new URL(file,dir)),contentType:"application/javascript",
      headers:{"content-security-policy":"default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'none'"}});
  });
  await page.goto("https://fixture.invalid/");
  for (const area of Object.keys(runnable)) {
    const source=await readFile(new URL("../../../"+areas[area],import.meta.url),"utf8");
    // Deliberately break the candidate: the current source must pass and the
    // candidate must independently produce a failing result.
    const rows=await page.evaluate(({area,source,file})=>new Promise((resolve,reject)=>{
      const w=new Worker("/api/assistant-runner/"+file,{type:"module"});
      const timeout=setTimeout(()=>{w.terminate();reject(Error("Runner timeout"));},10000);
      w.onmessage=e=>{clearTimeout(timeout);w.terminate();resolve(e.data);};
      w.onerror=e=>{clearTimeout(timeout);w.terminate();reject(Error(e.message));};
      w.postMessage({area,source,before:source,after:"throw Error('fictional regression');"});
    }),{area,source,file});
    assert.ok(rows.every(r=>r.baseline==="pass" && r.candidate==="error"),JSON.stringify({area,rows}));
  }
} finally {await browser.close();}
