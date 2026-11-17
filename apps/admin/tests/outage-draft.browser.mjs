import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createLocalBackend } from '../backend.mjs';
import { AdminService } from '../service.mjs';
import { createPanelServer } from '../server.mjs';

// The flow under test is Events -> dirty modal -> proposal quota failure ->
// isolated outage screen -> automatic recovery with the identical unsaved draft.
// Browser plugin not available; use the repository's local Playwright fixture.
const local = await createLocalBackend(), service = new AdminService(local.backend), server = createPanelServer(service);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Indiana/Indianapolis' });
  const errors = [], submitted = [], origin = `http://127.0.0.1:${server.address().port}`;
  let stateReads = 0, sessions = 0, signouts = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-17T18:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-17T18:00:01Z'));
  await page.route('**/api/session', async route => { sessions++; await route.continue(); });
  await page.route('**/api/state', async route => { stateReads++; await route.continue(); });
  await page.route('**/api/proposals', async route => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length > 1) return route.continue();
    await route.fulfill({ status: 503, headers: { 'Retry-After': '60' }, json: {
      error: { code: 'SERVICE_LIMIT_REACHED', message: 'Daily allowance exhausted.' },
    } });
  });
  await page.route('**/auth/logout', async route => {
    signouts++;
    assert(route.request().headers()['x-shamrock-csrf']);
    await route.fulfill({ status: 503, json: { error: { code: 'SESSION_UNAVAILABLE', message: 'Sign-out is temporarily unavailable. Please try again.' } } });
  });
  await page.goto(origin);
  assert.equal(new URL(page.url()).origin, origin);
  assert.match(await page.title(), /SHAMROCK/i);
  await page.getByRole('button', { name: 'Edit Veterans Day', exact: true }).click();
  await page.getByLabel('Event name', { exact: true }).fill('Fictional draft preserved during outage');
  await page.getByLabel('Attendance header', { exact: true }).fill('Fictional retained header');
  await page.getByLabel('Location', { exact: true }).fill('Fictional retained location');
  await page.getByLabel('Status', { exact: true }).selectOption('cancelled');
  const draft = await page.locator('dialog form').evaluate(form => {
    window.__outageDraftForm = form;
    return [...form.elements].map(e => ({ tag: e.tagName, type: e.type, value: e.value, checked: e.checked }));
  });
  const beforeReads = stateReads, beforeEvent = (await service.snapshot()).events.find(e => e.eventId === 'veterans');
  assert.equal(await page.locator('dialog:modal').count(), 1, 'editor starts in the modal top layer');
  await page.getByRole('button', { name: 'Review change', exact: true }).click();
  await page.getByText("You're signed in", { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/shamrock-outage-draft-desktop.png', animations: 'disabled' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'outage removes the draft dialog from the accessibility tree');
  assert.equal(await page.locator('dialog:modal').count(), 0, 'outage closes the top-layer modal without unmounting its draft');
  assert.equal(await page.getByRole('navigation').count(), 0);
  assert.equal(await page.getByRole('textbox').count(), 0, 'no accessible writable fields during outage');
  assert.equal(await page.getByRole('combobox').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Review change', exact: true }).count(), 0);
  assert(await page.getByRole('button', { name: 'Retry records', exact: true }).isDisabled());
  assert.equal(await page.evaluate(() => window.__outageDraftForm.isConnected), true, 'draft stays mounted');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Sign-out is temporarily unavailable. Please try again.' }).waitFor();
  assert.equal(signouts, 1, 'outage sign-out remains operable despite the suspended modal');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[inert]')), false, 'keyboard focus cannot enter the suspended editor');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/shamrock-outage-draft-mobile.png', animations: 'disabled' });
  await page.clock.fastForward(59000);
  assert.equal(stateReads, beforeReads, 'quota cooldown starts no record reads while a draft is retained');
  const recovery = page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.clock.fastForward(2000);
  await recovery;
  await page.getByRole('heading', { name: 'Edit event', exact: true }).waitFor();
  assert.equal(stateReads, beforeReads + 1, 'one automatic recovery read');
  assert.equal(sessions, 1, 'recovery reuses the authenticated session');
  assert.equal(await page.locator('dialog:modal').count(), 1, 'recovered editor returns to the modal top layer');
  const recovered = await page.locator('dialog form').evaluate(form => ({ same: form === window.__outageDraftForm,
    fields: [...form.elements].map(e => ({ tag: e.tagName, type: e.type, value: e.value, checked: e.checked })) }));
  assert.equal(recovered.same, true);
  assert.deepEqual(recovered.fields, draft, 'every original form value and checkbox survives recovery');
  assert.equal(await page.getByText("You're signed in", { exact: true }).count(), 0);
  await page.screenshot({ path: '/tmp/shamrock-outage-draft-recovered.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Review change', exact: true }).click();
  await page.getByRole('button', { name: 'Apply change', exact: true }).waitFor();
  assert.deepEqual(submitted[1], submitted[0], 'retry submits the identical reviewed draft payload');
  assert.deepEqual((await service.snapshot()).events.find(e => e.eventId === 'veterans'), beforeEvent, 'outage and proposal retry never apply the draft');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: dirty event draft survives proposal quota outage; modal top layer and writable controls suspended; sign-out failure visible; bounded automatic recovery restores the identical form and proposal payload without another sign-in or applying changes.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  service.close();
  await local.dispose();
}
