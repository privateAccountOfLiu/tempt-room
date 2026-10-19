import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { Run } from '../packages/protocol/src/index.ts';

function setup(t: import('node:test').TestContext){
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'wake-chain-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const roomId = service.execute({ version: '0.1', commandId: uid(), type: 'room.create', payload: { name: 'wake chain', members: ['demo-planner', 'demo-reviewer'] } }).result.roomId as string;
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...store.settings(), allowAgentMentionsToWake: true, maxWakeChainDepth: 1 } });
  return { store, service, roomId };
}

test('agent mentions do not wake when the feature is disabled', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'wake-off-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const roomId = service.execute({ version: '0.1', commandId: uid(), type: 'room.create', payload: { name: 'off', members: ['demo-planner', 'demo-reviewer'] } }).result.roomId as string;
  const before = store.list('runs', roomId).length;
  const receipt = service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: 'agent mention off', mentions: ['demo-reviewer'] } }, { id: 'demo-planner', kind: 'agent' });
  assert.equal(receipt.result.messageId !== undefined, true);
  assert.equal(store.list('runs', roomId).length, before);
});

test('agent mention wake chain stops at the configured depth', t => {
  const { store, service, roomId } = setup(t);
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: { title: 'parent', agentId: 'demo-planner' } });
  const parentRun = store.list<Run>('runs', roomId).find(run => run.agentId === 'demo-planner')!;
  parentRun.status = 'running'; parentRun.executionId = uid('execution');
  store.event(roomId, 'run.started', SYSTEM, { run: parentRun });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: 'first hop', mentions: ['demo-reviewer'] } }, { id: 'demo-planner', kind: 'agent' }, { runId: parentRun.id, generation: parentRun.generation, executionId: parentRun.executionId });
  const reviewerRun = store.list<Run>('runs', roomId).find(run => run.agentId === 'demo-reviewer')!;
  assert.equal(reviewerRun.wakeChainDepth, 1);
  reviewerRun.status = 'running'; reviewerRun.executionId = uid('execution');
  store.event(roomId, 'run.started', SYSTEM, { run: reviewerRun });
  const before = store.list('runs', roomId).length;
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: 'second hop', mentions: ['demo-planner'] } }, { id: 'demo-reviewer', kind: 'agent' }, { runId: reviewerRun.id, generation: reviewerRun.generation, executionId: reviewerRun.executionId });
  assert.equal(store.list('runs', roomId).length, before);
});
