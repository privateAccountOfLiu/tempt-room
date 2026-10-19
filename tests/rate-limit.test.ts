import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { defaultExecutionSettings, type Run } from '../packages/protocol/src/index.ts';

test('per-agent runs-per-minute limit stops wake storms before a run is persisted', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'rate-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  assert.equal(defaultExecutionSettings.maxAgentRunsPerMinute, 30);
  cmd('settings.update', { ...store.settings(), maxAgentRunsPerMinute: 2, maxQueuedRunsPerAgent: 10 });
  cmd('task.create', { title: 'first', agentId: 'demo-planner' });
  cmd('task.create', { title: 'second', agentId: 'demo-planner' });
  assert.equal(store.list<Run>('runs').length, 2);
  assert.throws(() => cmd('task.create', { title: 'storm', agentId: 'demo-planner' }), /一分钟内启动的运行已达上限/);
  assert.equal(store.list<Run>('runs').length, 2);
  assert.equal(store.list('tasks').length, 2);
});
