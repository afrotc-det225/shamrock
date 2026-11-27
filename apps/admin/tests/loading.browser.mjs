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
 const host=Object.create(HostedBackend.prototype);host.identity=()=>local.backend.identity();host.post=(path,body)=>local.backend.post(path,body);host.binding='fictional-browser-capture';
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],active=new Set(),requests=[];
 await page.clock.install();
 let maximum=0,blockSection,held,release,gate,stateCalls=0,holdSession=false,releaseSession;
 const sessionGate=new Promise(resolve=>{releaseSession=resolve;});
 const hold=section=>{blockSection=section;held=false;gate=new Promise(resolve=>{release=resolve;});};
 hold('events');
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.url().endsWith('/api/page')){active.add(request);maximum=Math.max(maximum,active.size);requests.push(request.postDataJSON().section);}});
 page.on('requestfinished',request=>active.delete(request));page.on('requestfailed',request=>active.delete(request));
 await page.route('**/api/session',async route=>{if(holdSession)await sessionGate;const response=await route.fetch();await route.fulfill({response});});
 await page.route('**/api/state*',async route=>{stateCalls++;
  if(await host.captureUnchanged(route.request().headers()['x-shamrock-capture']))return route.fulfill({json:{captureUnchanged:true,captureKey:host.binding,viewAs:null,viewAsRevision:null,reportingTime:Date.now()}});
  if(new URL(route.request().url()).searchParams.get('profile')==='leadership'){
    const browse=await host.post('/v1/admin/panel/browse',{...host.identity(),profile:'leadership'});
    return route.fulfill({json:{manifest:await host.panelAuthority(),browse,captureKey:host.binding,viewAs:null,viewAsRevision:null,transport:'paged-v1',reportingTime:Date.now(),history:[],meta:{hosted:true}}});
  }
  return route.fulfill({json:{manifest:await host.panelManifest(),captureKey:host.binding,viewAs:null,viewAsRevision:null,transport:'paged-v1',reportingTime:Date.now(),history:[],meta:{hosted:true}}});});
 await page.route('**/api/history/list',route=>route.fulfill({json:{snapshots:[]}}));
 await page.route('**/api/page',async route=>{
  const body=route.request().postDataJSON(),delay=!held&&body.section===blockSection;
  if(delay){held=true;await gate;}
  await new Promise(resolve=>setTimeout(resolve,25));
  try{await route.fulfill({json:await host.page(body)});}catch(error){if(!delay)throw error;}
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByText('Loading events…',{exact:true}).waitFor();
 await page.screenshot({path:'/tmp/shamrock-loading-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/shamrock-loading-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(()=>{const buttons=[...document.querySelectorAll('nav a')];buttons.find(b=>b.textContent==='Cadets').click();buttons.find(b=>b.textContent==='Leadership').click();});
 await page.getByRole('button',{name:'Add contact',exact:true}).waitFor();release();
 await page.waitForTimeout(80);
 assert(await page.getByRole('heading',{name:'Leadership',exact:true}).isVisible());
 assert.equal(await page.locator('.error').count(),0);
 assert(maximum<=2,`maximum page concurrency was ${maximum}`);
 blockSection=null;await page.goto(`http://127.0.0.1:${server.address().port}/?workspace=leadership&page=events`);await page.getByRole('button',{name:'Edit Veterans Day',exact:true}).waitFor();
 await page.route('**/api/events/editor*',async route=>{
   await gate;
   await route.fulfill({json:await host.post('/v1/admin/panel/browse',{...host.identity(),profile:'event-editor'})});
 });
 hold('event-editor');await page.getByRole('button',{name:'Edit Veterans Day',exact:true}).click();
 await page.getByText('Loading event details…',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'Edit Veterans Day',exact:true}).isDisabled());
 await page.screenshot({path:'/tmp/shamrock-editor-loading-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/shamrock-editor-loading-mobile.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const account=await page.locator('.sidebar-bottom').boundingBox(),nav=await page.getByRole('navigation').boundingBox();
 assert(account.y+account.height<=nav.y,'account controls have their own row above mobile navigation');
 await page.getByRole('navigation').getByRole('link',{name:'History',exact:true}).click();
 await page.getByText('No archived reports.',{exact:true}).waitFor();
 const afterHistory=requests.length;release();await page.waitForTimeout(120);
 assert.equal(requests.length,afterHistory,'History stops remaining current-record pages');
 assert.equal(await page.locator('dialog').count(),0,'late capture cannot open old editor');
 assert.equal(await page.locator('.error').count(),0);
 blockSection=null;holdSession=true;const beforeBootstrap=stateCalls;
 await page.reload();
 await page.getByRole('navigation').getByRole('link',{name:'Cadets',exact:true}).click();
 await page.getByRole('navigation').getByRole('link',{name:'Leadership',exact:true}).click();
 await page.waitForTimeout(80);assert.equal(stateCalls,beforeBootstrap,'no reads before session bootstrap');
 releaseSession();await page.getByRole('button',{name:'Add contact',exact:true}).waitFor();
 assert.equal(await page.locator('.error').count(),0,'superseded bootstrap navigation stays silent');
 assert(maximum<=2,`maximum page concurrency was ${maximum}`);
 const beforeRefresh=requests.length;
 const refreshResponse=page.waitForResponse(response=>response.url().split('?')[0].endsWith('/api/state'));
 await page.clock.fastForward(61000);
 assert.equal((await(await refreshResponse).json()).captureUnchanged,true);
 await page.waitForTimeout(80);assert.equal(requests.length,beforeRefresh,'unchanged background refresh never reloads record pages');
 let releaseSemester;
 const semesterGate=new Promise(resolve=>{releaseSemester=resolve;});
 const semester=await host.post('/v1/admin/panel/browse',{...host.identity(),profile:'semester'});
 const tables=semester.tables;
 tables.terms=JSON.stringify([['spring','Spring 2027',2,true]]);
 tables.people=JSON.stringify([['senior',1,'Sample','Senior','C/Col','AS400','','alpha','Active 3/4']]);
 await page.route('**/api/state?profile=semester',async route=>{
   await semesterGate;
   await route.fulfill({json:{manifest:await host.panelAuthority(),browse:semester,captureKey:host.binding,
     transport:'paged-v1',reportingTime:Date.now(),history:[],meta:{hosted:true}}});
 });
 await page.getByRole('navigation').getByRole('link',{name:'Semester planning'}).click();
 await page.getByText('Opening Semester planning…').waitFor();
 assert.equal(await page.locator('[inert] h1').textContent(),'Leadership');
 assert.equal(await page.locator('.loading-table').count(),0);
 releaseSemester();
 const cohort=page.getByLabel('Next AS year for AS400');
 assert.equal(await cohort.inputValue(),'Commissioned');
 await page.getByLabel('First training-week Sunday').fill('2027-08-22');
 const proposals=[];
 await page.route('**/api/proposals',async route=>{
   proposals.push(route.request().postDataJSON().payload.plan);
   await route.fulfill({status:400,json:{error:{message:'Test review captured'}}});
 });
 await page.getByRole('button',{name:'Review semester plan'}).click();
 await page.getByRole('alert').filter({hasText:'Test review captured'}).waitFor();
 assert.equal(proposals[0].people[0].asYear,'AS400');
 assert.equal(proposals[0].people[0].flightPathStatus,'Commissioned');
 await page.getByLabel('Find a cadet').fill('Senior');
 await page.getByRole('button',{name:/Add Sample Senior/}).click();
 assert.equal(await page.getByLabel('Status for Sample Senior').inputValue(),'Active 3/4');
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/proposals')),page.getByRole('button',{name:'Review semester plan'}).click()]);
 assert.deepEqual(proposals[1].people,[]);
 assert.deepEqual(errors,[]);
 console.log(`PASS: throttled desktop/mobile skeletons and editor status, rapid Cadets/Leadership navigation, late-result rejection, History cancels editor capture, delayed session bootstrap blocks all reads, unchanged refresh reloads no record pages, maximum concurrent page requests=${maximum}.`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));service.close();await local.dispose();}
