import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { agentCapabilityFingerprint } from '../apps/server/src/adapter-capabilities.ts';
import type { AgentDescriptor } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('probe endpoint persists tristate evidence and invalidates it when the fingerprint changes', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'capability-b05b-'));
  const {app, store} = await createApp({root, token: 'capability-owner', startWorker: false});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const headers = {host: '127.0.0.1:4317', authorization: 'Bearer capability-owner', 'room-protocol-version': '0.1', 'content-type': 'application/json'};
  const roomId = store.rooms()[0].id, agentId = 'demo-planner';
  const url = `/api/rooms/${roomId}/agents/${agentId}/capabilities`;
  const initial = await app.inject({url, headers});
  assert.equal(initial.statusCode, 200);
  assert.ok(initial.json().states.every((state: any) => state.state === 'unverified'));
  assert.equal((await app.inject({url, headers: {host: headers.host, 'room-protocol-version': '0.1'}})).statusCode, 401);
  const probe = await app.inject({method: 'POST', url: `/api/agents/${agentId}/capabilities/probe`, headers, payload: {roomId}});
  assert.equal(probe.statusCode, 200, probe.body);
  const probed = await app.inject({url, headers});
  const states = probed.json().states as Array<{capability: string; state: string; testedAt: string | null}>;
  assert.equal(states.filter(state => state.state === 'verified_supported').length, 2);
  assert.ok(states.every(state => state.state !== 'verified_supported' || state.testedAt));
  assert.equal(store.list('capability_evidence', roomId).length, 10);

  const agent = store.get<AgentDescriptor>('agents', agentId)!;
  const previousFingerprint = agentCapabilityFingerprint(agent);
  // A version change is a new fingerprint; old evidence must not route.
  const changed = {...agent, version: '9.9.9'};
  store.put('agents', changed);
  const changedFingerprint = agentCapabilityFingerprint(changed);
  assert.notEqual(changedFingerprint, previousFingerprint);
  const stale = await app.inject({url, headers});
  assert.equal(stale.json().fingerprint, changedFingerprint);
  assert.ok(stale.json().states.every((state: any) => state.state === 'unverified'));
});

test('capability verify command rejects a mismatched fingerprint', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'capability-command-'));
  const {app, store} = await createApp({root, token: 'capability-command-owner', startWorker: false});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const headers = {host: '127.0.0.1:4317', authorization: 'Bearer capability-command-owner', 'room-protocol-version': '0.1', 'content-type': 'application/json'};
  const roomId = store.rooms()[0].id;
  const response = await app.inject({method: 'POST', url: '/api/commands', headers, payload: {version: '0.1', commandId: 'capability-mismatch', roomId, type: 'capability.verify', payload: {fingerprint: 'fp_expected', evidence: [{fingerprint: 'fp_other', capability: 'streamOutput', state: 'verified_supported', mode: 'simulated', testedAt: new Date().toISOString(), suiteVersion: 'sim-v1', evidenceHash: 'a'.repeat(64)}]}}});
  assert.equal(response.statusCode, 400);
  assert.equal(store.list('capability_evidence', roomId).length, 0);
});
