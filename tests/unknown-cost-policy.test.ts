import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { agentCapabilityFingerprint } from '../apps/server/src/adapter-capabilities.ts';
import type { AgentDescriptor } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data'), HASH = 'a'.repeat(64);
test('cost-budgeted runs from unverified providers are blocked until capability is verified or policy allows', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'unknown-cost-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const initialCodex=store.get<AgentDescriptor>('agents','codex')!;
  store.put('agents', {...initialCodex, enabled: true} as any);
  command('settings.update', {...store.settings(), costBudgetUsd: 0.1});
  assert.throws(() => command('task.create', {title: 'Unverified CLI cost', agentId: 'codex'}), /费用回执能力|未知成本/);
  const agent = store.get<AgentDescriptor>('agents', 'codex')!;
  const fingerprint = agentCapabilityFingerprint(agent);
  command('capability.verify', {fingerprint, evidence: [{fingerprint, capability: 'usageScope', state: 'verified_supported', mode: 'simulated-contract', testedAt: new Date().toISOString(), suiteVersion: 'sim-v1', evidenceHash: HASH}]});
  command('task.create', {title: 'Verified CLI cost', agentId: 'codex'});
  command('settings.update', {...store.settings(), unknownCostPolicy: 'allow'});
  command('task.create', {title: 'Explicit policy allowance', agentId: 'codex'});
});
