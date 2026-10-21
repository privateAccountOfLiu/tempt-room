import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('worker steers an active run through its registered adapter channel', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'steer-channel-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () {}}), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const taskId = (service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Steer task', agentId: 'demo-planner'}}).result as any).taskId as string;
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  const at = new Date().toISOString(), running: Run = {...run, status: 'running', generation: 1, executionId: 'exec_steer', startedAt: at, updatedAt: at};
  store.event(roomId, 'run.started', SYSTEM, {run: running});
  const received: string[] = [];
  (worker as any).steerHandlers.set(run.id, {generation: 1, executionId: 'exec_steer', handler: async (text: string) => { received.push(text); }});
  const result = await worker.steer(run.id, 'please focus on tests');
  assert.deepEqual(result, {accepted: true});
  assert.deepEqual(received, ['please focus on tests']);
  assert.ok(store.events(roomId).some(event => event.type === 'audit.recorded' && String((event.payload as any).action).startsWith('run.steer:')));
  assert.equal((await worker.steer(run.id, 'again')).accepted, true);
  assert.equal(received.length, 2);
});

test('worker refuses steering without an active channel or after completion', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'steer-inactive-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () {}}), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  await assert.rejects(() => worker.steer('run_missing', 'x'), /运行不存在/);
  const taskId = (service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Steer inactive', agentId: 'demo-planner'}}).result as any).taskId as string;
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  const at = new Date().toISOString(), running: Run = {...run, status: 'running', generation: 1, executionId: 'exec_steer', startedAt: at, updatedAt: at};
  store.event(roomId, 'run.started', SYSTEM, {run: running});
  await assert.rejects(() => worker.steer(run.id, 'no channel'), /steer 通道/);
  store.event(roomId, 'run.completed', SYSTEM, {run: {...running, status: 'completed', finishedAt: at}});
  await assert.rejects(() => worker.steer(run.id, 'finished'), /不能补投/);
});
