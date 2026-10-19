import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterFingerprint,
  capabilitySummary,
  probeSimulatedCapabilities,
  verifiedCapabilityState,
  type AdapterFingerprintInput
} from '../apps/server/src/adapter-capabilities.ts';

const base: AdapterFingerprintInput = {
  provider: 'demo', adapterVersion: 'sim-v1', executableVersion: '1.0.0', runtimeLayout: 'in-process',
  connectionMode: 'managed', executionMode: 'sandbox', model: 'deterministic', configDigest: 'cfg-a'
};

test('adapter fingerprint changes when version, mode or configuration changes', () => {
  const fingerprint = adapterFingerprint(base);
  assert.equal(fingerprint, adapterFingerprint({...base}));
  for (const patch of [
    {adapterVersion: 'sim-v2'},
    {executableVersion: '1.0.1'},
    {connectionMode: 'external' as const},
    {executionMode: 'host' as const},
    {model: 'other'},
    {configDigest: 'cfg-b'}
  ]) assert.notEqual(adapterFingerprint({...base, ...patch}), fingerprint, JSON.stringify(patch));
});

test('simulated capability probe only promotes explicitly declared evidence', () => {
  const fingerprint = adapterFingerprint(base);
  const evidence = probeSimulatedCapabilities({
    supported: ['streamOutput', 'nextTurnInput'],
    unsupported: ['steerDuringRun'],
    mode: {streamOutput: 'simulated-stream', nextTurnInput: 'simulated-next-turn'}
  }, fingerprint, {testedAt: '2026-10-19T00:00:00.000Z'});
  assert.equal(evidence.length, 10);
  assert.deepEqual(capabilitySummary(evidence), {verified_supported: 2, verified_unsupported: 1, unverified: 7});
  assert.equal(verifiedCapabilityState(fingerprint, evidence, 'streamOutput'), 'verified_supported');
  assert.equal(verifiedCapabilityState(fingerprint, evidence, 'steerDuringRun'), 'verified_unsupported');
  assert.equal(verifiedCapabilityState(fingerprint, evidence, 'preToolGate'), 'unverified');
  for (const item of evidence) assert.equal(item.evidenceHash.length, 64);
});

test('stale fingerprints and prose claims cannot become verified capabilities', () => {
  const fingerprint = adapterFingerprint(base);
  const evidence = probeSimulatedCapabilities({supported: ['steerDuringRun']}, fingerprint);
  assert.equal(verifiedCapabilityState(fingerprint, evidence, 'steerDuringRun'), 'verified_supported');
  const changed = adapterFingerprint({...base, adapterVersion: 'sim-v2'});
  assert.equal(verifiedCapabilityState(changed, evidence, 'steerDuringRun'), 'unverified');
  // A natural-language claim is not an evidence object and must not be routed.
  assert.equal(verifiedCapabilityState(changed, [], 'steerDuringRun'), 'unverified');
});
