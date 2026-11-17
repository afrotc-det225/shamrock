import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedBackend } from '../hosted/backend.mjs';

const base = {
  ENVIRONMENT: 'staging', BACKEND_ORIGIN: 'https://backend-staging.example.invalid',
  BACKEND: {}, BRIDGE_SECRET: 'fictional-bridge-secret-longer-than-thirty-two-characters',
  SOURCE_KIND: 'test', SOURCE_RESOURCE: 'panel-fixture', BRIDGE_KEY_ID: 'fixture', GENERATION: '1',
};
test('real-data staging requires an explicit dataset and matching isolated service origin', () => {
  assert.equal(new HostedBackend(base, 'operator').dataset, 'fictional');
  const real = { ...base, STAGING_DATASET: 'real', BACKEND_SERVICE_NAME: 'fixture-real-parity',
    BACKEND_ORIGIN: 'https://fixture-real-parity.example.workers.dev' };
  assert.equal(new HostedBackend(real, 'operator').dataset, 'real');
  for (const changed of [
    { STAGING_DATASET: undefined }, { STAGING_DATASET: 'production' },
    { ENVIRONMENT: 'production' }, { BACKEND_SERVICE_NAME: undefined },
    { BACKEND_SERVICE_NAME: 'different-real-parity' },
    { BACKEND_SERVICE_NAME: 'production', BACKEND_ORIGIN: 'https://production.example.workers.dev' },
    { BACKEND_ORIGIN: 'http://fixture-real-parity.example.workers.dev' },
    { BACKEND_ORIGIN: 'https://fixture-real-parity.example.workers.dev.evil.invalid' },
    { BACKEND_ORIGIN: 'https://fixture-real-parity.example.workers.dev:8443' },
    { BACKEND_ORIGIN: 'https://fixture-real-parity.example.workers.dev/path' },
  ]) assert.throws(() => new HostedBackend({ ...real, ...changed }, 'operator'), { code: 'CONFIGURATION' });
});
