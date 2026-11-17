import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createLocalBackend } from '../backend.mjs';
import { AdminService } from '../service.mjs';
import { createPanelServer } from '../server.mjs';

// Read-only load failures must not tell an operator to check a mutation receipt.
// Browser plugin not available; exercise the local fixture with Playwright.
const local = await createLocalBackend(), service = new AdminService(local.backend), server = createPanelServer(service);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.env.SHAMROCK_CHROMIUM_PATH ? { executablePath: process.env.SHAMROCK_CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  let reads = 0, sessions = 0, unavailable = true, retryAfter = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-17T18:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-17T18:00:01Z'));
  await page.route('**/api/session', async route => { sessions++; await route.continue(); });
  await page.route('**/api/state*', async route => {
    reads++;
    if (!unavailable) return route.continue();
    await route.fulfill({ status: 500, headers: retryAfter ? { 'Retry-After': String(retryAfter) } : {}, json: { error: {
      code: 'INTERNAL_ERROR', message: 'The operation failed; check its receipt before retrying.',
    } } });
  });
  await page.route('**/auth/logout', route => route.fulfill({ status: 503, json: {
    error: { code: 'SESSION_UNAVAILABLE', message: 'Sign-out did not complete. Try again later.' },
  } }));
  const focusBurst = () => page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  const nextRetry = async (delay, expected, bursts = true) => {
    await page.clock.fastForward(delay - 1);
    if (bursts) await focusBurst();
    await page.waitForTimeout(30);
    assert.equal(reads, expected - 1, 'focus/online bursts cannot bypass or reset the retry deadline');
    const response = page.waitForResponse(value => value.url().split('?')[0].endsWith('/api/state'));
    await page.clock.fastForward(1);
    await response;
    await page.waitForTimeout(30);
    assert.equal(reads, expected, 'the deadline starts exactly one record request');
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: "You're signed in", exact: true }).waitFor();
  assert.match(await page.locator('.records-unavailable').innerText(), /could not load cadet records/);
  assert.equal(await page.getByRole('alert').count(), 0, 'initial readonly failure does not expose a mutation alert');
  assert.equal(await page.getByText(/check its receipt/i).count(), 0);
  assert.equal(await page.getByRole('navigation').count(), 0);
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(reads, 1); assert.equal(sessions, 1);
  await focusBurst();
  await page.waitForTimeout(30);
  assert.equal(reads, 1);
  await page.screenshot({ path: '/tmp/shamrock-record-load-failure.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Sign-out did not complete. Try again later.' }).waitFor();
  for (const [index, delay] of [60000, 120000, 240000, 300000].entries()) {
    await nextRetry(delay, index + 2);
    assert.equal(await page.getByText(/check its receipt/i).count(), 0);
    assert.equal(await page.getByRole('alert').innerText(), 'Sign-out did not complete. Try again later.', 'read retries preserve the actionable sign-out error');
  }
  unavailable = false;
  await nextRetry(300000, 6);
  await page.getByRole('button', { name: 'Add event', exact: true }).waitFor();
  assert.equal(sessions, 1, 'recovery does not reauthenticate');
  await focusBurst();
  await page.waitForTimeout(30);
  assert.equal(reads, 6, 'recent successful read suppresses immediate focus-triggered reads');
  // A successful recovery resets the next failure to the initial one-minute delay.
  unavailable = true;
  await nextRetry(60000, 7, false);
  await page.getByRole('heading', { name: "You're signed in", exact: true }).waitFor();
  await nextRetry(60000, 8);
  assert.equal(await page.getByRole('alert').count(), 0, 'background readonly failure has no stale mutation error');
  assert.equal(await page.getByText(/check its receipt/i).count(), 0);
  retryAfter = 600;
  await nextRetry(120000, 9);
  await nextRetry(600000, 10);
  assert.deepEqual(errors, []);
  console.log('PASS: initial/background INTERNAL_ERROR reads show record-loading guidance without receipt wording; action errors remain visible; 60/120/240/300-second backoff and longer Retry-After resist focus/online bursts; successful recovery resets backoff without reauthentication.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); service.close(); await local.dispose();
}
