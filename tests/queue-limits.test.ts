import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { defaultExecutionSettings, type Run } from '../packages/protocol/src/index.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'queue-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  return { store, service, roomId, cmd };
}

test('agent and room backlog limits reject new task runs before they are persisted', t => {
  const { store, cmd } = setup(t);
  assert.equal(defaultExecutionSettings.maxQueuedRunsPerAgent, 5);
  assert.equal(defaultExecutionSettings.maxQueuedRunsPerRoom, 20);
  cmd('settings.update', { ...store.settings(), maxQueuedRunsPerAgent: 2, maxQueuedRunsPerRoom: 10 });
  cmd('task.create', { title: 'planner one', agentId: 'demo-planner' });
  cmd('task.create', { title: 'planner two', agentId: 'demo-planner' });
  assert.equal(store.list<Run>('runs').length, 2);
  assert.throws(() => cmd('task.create', { title: 'planner three', agentId: 'demo-planner' }), /该成员的待处理运行已达上限/);
  assert.equal(store.list<Run>('runs').length, 2);
  assert.equal(store.list('tasks').length, 2);
});

test('room-wide backlog limit applies across agents', t => {
  const { store, cmd } = setup(t);
  cmd('settings.update', { ...store.settings(), maxQueuedRunsPerAgent: 5, maxQueuedRunsPerRoom: 2 });
  cmd('task.create', { title: 'planner', agentId: 'demo-planner' });
  cmd('task.create', { title: 'reviewer', agentId: 'demo-reviewer' });
  assert.equal(store.list<Run>('runs').length, 2);
  assert.throws(() => cmd('task.create', { title: 'another', agentId: 'demo-planner' }), /房间待处理运行已达上限/);
  assert.equal(store.list<Run>('runs').length, 2);
  assert.equal(store.list('tasks').length, 2);
});
