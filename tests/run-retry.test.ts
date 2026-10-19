import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { Run, Task } from '../packages/protocol/src/index.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'retry-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  return { store, service, roomId, cmd };
}

test('owner can retry a failed or canceled chat run, but not while another run of the member is active', t => {
  const { store, cmd } = setup(t);
  cmd('message.send', { text: '请重试这次工作', mentions: ['demo-planner'] });
  const first = store.list<Run>('runs').at(-1)!;
  cmd('run.cancel', { runId: first.id });
  assert.equal(store.get<Run>('runs', first.id)!.status, 'canceled');
  const retried = cmd('run.retry', { runId: first.id }).result as { runId: string; previousRunId: string };
  assert.notEqual(retried.runId, first.id);
  assert.equal(retried.previousRunId, first.id);
  const second = store.get<Run>('runs', retried.runId)!;
  assert.equal(second.status, 'queued');
  assert.equal(second.prompt, first.prompt);
  assert.equal(second.agentId, first.agentId);
  assert.equal(store.get<Run>('runs', first.id)!.status, 'canceled');
  assert.throws(() => cmd('run.retry', { runId: first.id }), /进行中的运行/);
  cmd('run.cancel', { runId: second.id });
  const third = store.get<Run>('runs', (cmd('run.retry', { runId: first.id }).result as { runId: string }).runId)!;
  assert.equal(third.status, 'queued');
});

test('task retry reuses the same task version and re-queues a failed task', t => {
  const { store, cmd } = setup(t);
  const taskId = cmd('task.create', { title: '重试任务', agentId: 'demo-planner' }).result.taskId as string;
  const run = store.list<Run>('runs').find(item => item.taskId === taskId)!;
  cmd('run.cancel', { runId: run.id });
  const task = store.get<Task>('tasks', taskId)!;
  task.status = 'failed'; store.event(task.roomId, 'task.updated', { id: 'owner', kind: 'human' }, { task });
  const retried = cmd('run.retry', { runId: run.id }).result as { runId: string };
  const next = store.get<Run>('runs', retried.runId)!;
  assert.equal(next.taskId, taskId);
  assert.equal(next.taskVersion, run.taskVersion);
  assert.equal(store.get<Task>('tasks', taskId)!.status, 'queued');
  assert.equal(store.get<Task>('tasks', taskId)!.version, task.version);
});
