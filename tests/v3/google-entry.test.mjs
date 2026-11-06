import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('staging bundle loads without Google IO and exposes native trigger entry points', async () => {
  const source = await readFile(new URL('../../.build/v3-artifacts/GoogleAdapter.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.SHAMROCKV3.createNativeStagingHost, 'function');
  for (const name of Object.values(context.SHAMROCKV3.STAGING_HANDLERS)) {
    assert.equal(typeof context[name], 'function', name);
  }
  for (const name of ['Setup', 'Pause', 'Resume', 'ImportConfig', 'RepairPresentation', 'FrontendRefresh', 'FrontendPause', 'FrontendResume', 'MaintenancePause', 'MaintenanceResume', 'NotificationsPlan', 'TransitionArchive', 'TransitionCommand']) assert.equal(typeof context[`shamrockV3Staging${name}`], 'function');
  assert.equal(typeof context.SHAMROCKV3.createNativeFrontendRuntime, 'function');
  assert.equal(typeof context.SHAMROCKV3.planPresentationRepair, 'function');
  assert.equal(typeof context.SHAMROCKV3.verifyPresentation, 'function');
  assert.equal(context.onOpen, undefined);
  assert.equal(context.onFormSubmit, undefined);
});

test('staging manifest authorizes required IO without mail or execution deployment', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../.build/v3-artifacts/appsscript.json', import.meta.url), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'America/Indiana/Indianapolis');
  for (const scope of ['drive', 'forms.body', 'forms.responses.readonly']) assert.ok(manifest.oauthScopes.includes(`https://www.googleapis.com/auth/${scope}`));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.ok(!manifest.oauthScopes.some(scope => /gmail|mail\.google/.test(scope)));
  assert.equal(manifest.executionApi, undefined);
  assert.equal(manifest.webapp, undefined);
});

test('operator setup pauses and validates projection outputs before installing triggers', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = [];
  const context = vm.createContext({});
  vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({
    pause() { calls.push('pause'); },
    initializeProjections() { calls.push('outputs'); },
    repairPresentation() { calls.push('presentation'); },
    setup() { calls.push('triggers'); return 'ready-paused'; },
  });
  context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend-pause'); } });
  context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance-pause');}});
  assert.equal(context.shamrockV3StagingSetup(), 'ready-paused');
  assert.deepEqual(calls, ['pause', 'frontend-pause', 'maintenance-pause', 'outputs', 'presentation', 'triggers']);
});

test('installed scheduled flush preserves intake results and independently runs optional frontend publication while intake is paused', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = [], context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ flush() { calls.push('intake'); return { status: 'paused', committed: 0 }; } });
  context.shamrockV3StagingFrontend_ = () => ({ refresh() { calls.push('frontend'); return { status: 'published', retainedDrafts: 0 }; } });
  context.shamrockV3StagingMaintenance_ = () => ({planNotifications(){calls.push('maintenance');return {status:'paused'};}});
  assert.deepEqual(JSON.parse(JSON.stringify(context.shamrockV3StagingFlush())), { status: 'paused', committed: 0, frontend: { status: 'published', retainedDrafts: 0 }, maintenance:{status:'paused'} });
  assert.deepEqual(calls, ['intake', 'frontend', 'maintenance']);
});

test('global staging pause stops both planes while each resume remains explicit and separate', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = [], context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ pause() { calls.push('intake-pause'); return { status: 'paused' }; }, resume() { calls.push('intake-resume'); } });
  context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend-pause'); }, resume() { calls.push('frontend-resume'); }, refresh() { calls.push('frontend-refresh'); } });
  context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance-pause');}});
  context.shamrockV3StagingPause(); assert.deepEqual(calls, ['intake-pause', 'frontend-pause', 'maintenance-pause']); calls.length = 0;
  context.shamrockV3StagingResume(); assert.deepEqual(calls, ['intake-resume']); calls.length = 0;
  context.shamrockV3StagingFrontendResume(); assert.deepEqual(calls, ['frontend-resume']); calls.length = 0;
  context.shamrockV3StagingFrontendRefresh(); assert.deepEqual(calls, ['frontend-refresh']);
});

test('pause and setup attempt both independent pauses when either provider write fails', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  for (const failing of ['intake', 'frontend', 'maintenance']) for (const action of ['Pause', 'Setup']) {
    const calls = [], context = vm.createContext({}); vm.runInContext(source, context);
    context.shamrockV3StagingHost_ = () => ({ pause() { calls.push('intake'); if (failing === 'intake') throw Error('Pause failed'); }, initializeProjections() { throw Error('Setup must stop'); } });
    context.shamrockV3StagingFrontend_ = () => ({ pause() { calls.push('frontend'); if (failing === 'frontend') throw Error('Pause failed'); } });
    context.shamrockV3StagingMaintenance_ = () => ({pause(){calls.push('maintenance');if(failing==='maintenance')throw Error('Pause failed');}});
    assert.throws(() => context[`shamrockV3Staging${action}`](), /Pause failed/);
    assert.deepEqual(calls, ['intake', 'frontend', 'maintenance']);
  }
});

test('presentation repair has a dedicated entry point that does not install triggers or resume processing', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = []; const context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ repairPresentation() { calls.push('repair'); return 'presentation-ready-paused'; } });
  assert.equal(context.shamrockV3StagingRepairPresentation(), 'presentation-ready-paused'); assert.deepEqual(calls, ['repair']);
});
