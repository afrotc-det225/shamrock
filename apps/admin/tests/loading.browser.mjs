import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createLocalBackend} from '../backend.mjs';
import {HostedBackend} from '../hosted/backend.mjs';
import {AdminService} from '../service.mjs';
import {createPanelServer} from '../server.mjs';
const local=await createLocalBackend(),service=new AdminService(local.backend),server=createPanelServer(service);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH?{executablePath:process.env.SHAMROCK_CHROMIUM_PATH}:{});
try{
 const host=Object.create(HostedBackend.prototype);host.identity=()=>local.backend.identity();host.post=(path,body)=>local.backend.post(path,body);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 let release,held=false,finishedOld;
 const delayed=new Promise(resolve=>{release=resolve;}),oldFinished=new Promise(resolve=>{finishedOld=resolve;});
 await page.route('**/api/state',async route=>route.fulfill({json:{manifest:await host.panelManifest(),transport:'paged-v1',reportingTime:Date.now(),history:[],meta:{hosted:true}}}));
 await page.route('**/api/page',async route=>{
  const body=route.request().postDataJSON(),delay=!held&&body.section==='events';
  if(delay){held=true;await delayed;}
  try{await route.fulfill({json:await host.page(body)});}catch(error){if(!delay)throw error;}
  finally{if(delay)finishedOld();}
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByText('Loading events…',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/shamrock-loading-desktop.png'});
 await page.getByRole('navigation').getByRole('button',{name:'Cadets',exact:true}).click();
 await page.getByRole('heading',{name:'Cadets',exact:true}).waitFor();
 await page.getByRole('button',{name:'Add cadet',exact:true}).waitFor();
 release();await oldFinished;
 assert(await page.getByRole('heading',{name:'Cadets',exact:true}).isVisible());
 assert.equal(await page.locator('.loading-table').count(),0);
 assert.equal(await page.locator('.error').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: initial Events skeleton, navigation aborts pending Events capture, late old response cannot replace Cadets or display a false error.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));service.close();await local.dispose();}
