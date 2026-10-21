import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { acquireResource } from '../apps/server/src/resource-manager.ts';
import type { Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

type Entry = { agentId: string; runId: string };

function fixture(t: import('node:test').TestContext, options: { block?: boolean } = {}) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'dispatch-fairness-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const roomId = store.rooms()[0].id;
  const entries: Entry[] = [];
  const releases: (() => void)[] = [];
  const worker = new Worker(store, service, root, {
    adapter: async function* (ctx: any) {
      entries.push({ agentId: ctx.agent.id, runId: ctx.run.id });
      if (options.block) await new Promise<void>(done => releases.push(done));
      yield { type: 'text', text: 'done' };
    },
  });
  t.after(async () => { for (const release of releases) release(); await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (type: string, payload: unknown, targetRoom = roomId) => service.execute({ version: '0.1', commandId: uid(), roomId: targetRoom, type, payload });
  return { root, store, service, worker, roomId, command, entries, releases };
}

async function drive(worker: Worker, store: Store, predicate: () => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    worker.tick();
    if (predicate()) return true;
    await new Promise(done => setTimeout(done, 20));
  }
  return predicate();
}

test('候选枚举不消耗房间容量：同房间 A/A/B 时 B 不会被 A 的排队吞掉', async t => {
  const { store, worker, roomId, command, entries } = fixture(t);
  command('settings.update', { ...store.settings(), concurrency: 1, maxConcurrentRunsPerRoom: 1 });
  command('task.create', { title: 'A1', agentId: 'demo-planner' });
  command('task.create', { title: 'A2', agentId: 'demo-planner' });
  command('task.create', { title: 'B1', agentId: 'demo-reviewer' });

  const completed = await drive(worker, store, () => store.list<Run>('runs', roomId).filter(run => run.status === 'completed').length >= 3);
  assert.equal(completed, true, 'three runs must complete');
  assert.deepEqual(entries.map(entry => entry.agentId), ['demo-planner', 'demo-reviewer', 'demo-planner']);
});

test('房间上限与全局槽位都不超限，且不会因为前一个房间排队而丢失候选', async t => {
  const { store, worker, roomId, command, entries, releases } = fixture(t, { block: true });
  const otherRoom = command('room.create', { name: '第二房间', description: '', members: ['demo-planner', 'demo-reviewer'] }).result.roomId as string;
  command('settings.update', { ...store.settings(), concurrency: 3, maxConcurrentRunsPerRoom: 2 });
  // Two different members per room: a room may host two concurrent runs.
  command('task.create', { title: 'R1-A', agentId: 'demo-planner' });
  command('task.create', { title: 'R1-B', agentId: 'demo-reviewer' });
  command('task.create', { title: 'R2-A', agentId: 'demo-planner' }, otherRoom);
  command('task.create', { title: 'R2-B', agentId: 'demo-reviewer' }, otherRoom);

  await drive(worker, store, () => entries.length >= 3, 5000);
  const active = store.list<Run>('runs').filter(run => run.status === 'running' || run.status === 'waiting_input');
  assert.equal(active.length, 3, `global concurrency should be filled: ${active.length}`);
  for (const room of [roomId, otherRoom]) {
    const inRoom = active.filter(run => run.roomId === room).length;
    assert.ok(inRoom <= 2, `room concurrency exceeded in ${room}: ${inRoom}`);
  }
  const dispatchedRooms = new Set(store.list<Run>('runs').filter(run => entries.some(entry => entry.runId === run.id)).map(run => run.roomId));
  assert.equal(dispatchedRooms.size, 2, 'both rooms must get a slot');
  for (const release of releases) release();
});

test('首选资源忙不会卡住整个 tick：另一个项目照常派发，忙任务保持排队而不是失败', async t => {
  const { root, store, service, worker, roomId, command, entries } = fixture(t);
  const project = join(root, 'busy-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'file.txt'), 'busy\n');

  command('agent.save', {
    id: 'demo-host', name: '演示本机直连', provider: 'demo', role: '本机直连演示', color: 'blue',
    executable: '', endpoint: '', model: '', credentialEnv: '', version: '', runtimeDirectory: '',
    connectionMode: 'managed', executionMode: 'host', responseFormat: 'text', enabled: true,
  });
  command('room.members.set', { members: [...store.room(roomId)!.members, 'demo-host'] });
  command('settings.update', { ...store.settings(), concurrency: 2, maxConcurrentRunsPerRoom: 2 });

  // A foreign holder keeps the canonical project resource busy.
  acquireResource(store, { roomId, kind: 'project', key: resolve(project), run: { id: 'run_foreign', generation: 1, executionId: 'exec_foreign' }, capacity: 1 });

  const busyTaskId = command('task.create', { title: 'Busy host task', agentId: 'demo-host', projectPath: project }).result.taskId as string;
  const freeTaskId = command('task.create', { title: 'Free sandbox task', agentId: 'demo-planner' }).result.taskId as string;

  await drive(worker, store, () => entries.length >= 1, 5000);
  const busyRun = store.list<Run>('runs', roomId).find(run => run.taskId === busyTaskId)!;
  const freeRun = store.list<Run>('runs', roomId).find(run => run.taskId === freeTaskId)!;

  assert.equal(busyRun.status, 'queued', 'a busy project resource must not fail the queued run');
  assert.ok(!store.events(roomId).some(event => event.type === 'run.started' && (event.payload as any).run?.id === busyRun.id), 'no run.started for the busy run');
  assert.equal(freeRun.status !== 'queued', true, 'the other candidate must still be dispatched');
  assert.equal(entries.length, 1);

  // The busy task keeps its lease-free state and stays retryable.
  const busyTask = store.get<Task>('tasks', busyTaskId)!;
  assert.notEqual(busyTask.status, 'failed');
});

test('房间成员被移除后不调用适配器，失败准入不计作已服务', async t => {
  const { store, worker, roomId, command, entries } = fixture(t);
  command('settings.update', { ...store.settings(), concurrency: 1, maxConcurrentRunsPerRoom: 1 });
  command('task.create', { title: 'Removed member task', agentId: 'demo-planner' });
  command('room.members.set', { members: store.room(roomId)!.members.filter(member => member !== 'demo-planner') });

  worker.tick();
  await new Promise(done => setTimeout(done, 50));
  worker.tick();

  const run = store.list<Run>('runs', roomId).find(item => item.taskId)!;
  assert.equal(run.status, 'queued');
  assert.equal(entries.length, 0, 'a removed member must not reach the adapter');
  const scheduler = (worker as any).scheduler;
  assert.equal(scheduler.rooms.get(roomId)?.servedAt ?? 0, 0, 'a denied admission must not be recorded as served');
});
