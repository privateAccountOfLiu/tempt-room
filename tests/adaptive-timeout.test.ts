import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adaptiveTimeoutMs } from '../apps/server/src/adaptive.ts';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Run, Task } from '../packages/protocol/src/index.ts';

const sample = (agentId: string, taskId: string | undefined, seconds: number, status = 'completed') => ({
  agentId, taskId, status,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seconds * 1000).toISOString()
});

test('adaptive timeout uses an EWMA window with floor and configured cap', () => {
  const base = 30 * 60_000;
  assert.equal(adaptiveTimeoutMs([], 'a', 'task', base), base);
  assert.equal(adaptiveTimeoutMs([sample('a', 't', 100)], 'a', 'task', base), base);
  const two = adaptiveTimeoutMs([sample('a', 't', 60), sample('a', 't', 120)], 'a', 'task', base);
  assert.equal(two, 3 * (0.3 * 120 + 0.7 * 60) * 1000);
  assert.equal(adaptiveTimeoutMs([sample('a', 't', 1), sample('a', 't', 1)], 'a', 'task', base), 30_000);
  assert.equal(adaptiveTimeoutMs([sample('a', 't', 10_000), sample('a', 't', 10_000)], 'a', 'task', base), base);
  const chatBase = 5 * 60_000;
  assert.equal(adaptiveTimeoutMs([sample('a', undefined, 60), sample('a', undefined, 60)], 'a', 'chat', chatBase), 180_000);
  assert.equal(adaptiveTimeoutMs([sample('b', 't', 60), sample('b', 't', 60)], 'a', 'task', base), base);
  assert.equal(adaptiveTimeoutMs([sample('a', 't', 60, 'failed'), sample('a', 't', 60, 'failed')], 'a', 'task', base), base);
});

test('service freezes the adaptive timeout into a new run when enabled', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'adaptive-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  const completeTask = (title: string) => {
    cmd('task.create', { title, agentId: 'demo-planner' });
    const task = store.list<Task>('tasks').at(-1)!;
    const run = store.list<Run>('runs').find(item => item.taskId === task.id)!;
    run.createdAt = new Date(Date.now() - 120_000).toISOString();
    run.status = 'running'; run.executionId = uid('execution');
    store.event(roomId, 'run.started', SYSTEM, { run });
    worker.finish(run, 'completed');
  };
  completeTask('history one'); completeTask('history two');
  cmd('settings.update', { ...store.settings(), adaptiveTimeouts: true });
  cmd('task.create', { title: 'adaptive next', agentId: 'demo-planner' });
  const next = store.list<Run>('runs').at(-1)!;
  assert.ok(next.limits!.timeoutMs >= 30_000);
  assert.ok(next.limits!.timeoutMs < store.settings().taskTimeoutMs);
});
