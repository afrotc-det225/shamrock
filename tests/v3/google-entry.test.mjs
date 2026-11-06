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
  for (const name of ['Setup', 'Pause', 'Resume', 'ImportConfig', 'RepairPresentation']) assert.equal(typeof context[`shamrockV3Staging${name}`], 'function');
  assert.equal(typeof context.SHAMROCKV3.planPresentationRepair, 'function');
  assert.equal(typeof context.SHAMROCKV3.verifyPresentation, 'function');
  assert.equal(context.onOpen, undefined);
  assert.equal(context.onFormSubmit, undefined);
});

test('staging manifest authorizes required IO without mail or execution deployment', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../.build/v3-artifacts/appsscript.json', import.meta.url), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'America/Indiana/Indianapolis');
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/forms.body.readonly'));
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
  assert.equal(context.shamrockV3StagingSetup(), 'ready-paused');
  assert.deepEqual(calls, ['pause', 'outputs', 'presentation', 'triggers']);
});

test('presentation repair has a dedicated entry point that does not install triggers or resume processing', async () => {
  const source = await readFile(new URL('../../apps/google-adapter/staging-globals.js', import.meta.url), 'utf8');
  const calls = []; const context = vm.createContext({}); vm.runInContext(source, context);
  context.shamrockV3StagingHost_ = () => ({ repairPresentation() { calls.push('repair'); return 'presentation-ready-paused'; } });
  assert.equal(context.shamrockV3StagingRepairPresentation(), 'presentation-ready-paused'); assert.deepEqual(calls, ['repair']);
});
