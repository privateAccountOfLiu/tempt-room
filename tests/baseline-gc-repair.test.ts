import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import { scanProjectFiles } from '../apps/server/src/project-files.ts';
import type { ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

async function waitUntil(check: () => boolean, message: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(message);
}

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'baseline-gc-repair-'));
  const project = join(root, 'project');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'README.md'), '# baseline project\n');
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'done'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const executor = new CommandExecutor(service, new ImmutableBaselines(root));
  const bindingId = (await executor.execute({version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload: {sourcePath: project}}, {id: 'owner', kind: 'human'})).result.bindingId as string;
  return {root, project, store, service, worker, roomId, command, executor, bindingId};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

function makeLegacy(ctx: Ctx): ProjectBinding {
  const binding = ctx.store.get<ProjectBinding>('project_bindings', ctx.bindingId)!;
  const legacy = {...binding, baselineId: undefined, manifestAlgorithm: undefined};
  ctx.store.put('project_bindings', legacy as unknown as ProjectBinding);
  return ctx.store.get<ProjectBinding>('project_bindings', ctx.bindingId)!;
}

test('baseline GC removes unreferenced baselines and keeps binding/task inputs', async t => {
  const ctx = await fixture(t);
  const binding = ctx.store.get<ProjectBinding>('project_bindings', ctx.bindingId)!;
  assert.ok(binding.baselineId);
  const orphanId = 'baseline_orphan';
  ctx.worker.baselines.prepare(scanProjectFiles(ctx.project), ctx.project, orphanId);
  assert.ok(existsSync(ctx.worker.baselines.directory(orphanId)));
  const removed = ctx.worker.collectBaselines(0);
  assert.equal(removed, 1);
  assert.ok(!existsSync(ctx.worker.baselines.directory(orphanId)));
  assert.ok(existsSync(ctx.worker.baselines.directory(binding.baselineId!)));
  assert.ok(!existsSync(join(ctx.root, 'baselines', 'baseline_orphan')));
});

test('a legacy binding is repaired only when the source still matches its manifest', async t => {
  const ctx = await fixture(t);
  const legacy = makeLegacy(ctx);
  assert.equal(legacy.baselineId, undefined);
  const taskId = ctx.command('task.create', {title: 'legacy binding run', agentId: 'demo-planner', projectBindingId: legacy.id, bindingVersion: legacy.version}).result.taskId as string;
  ctx.worker.tick();
  await waitUntil(() => ctx.store.get<Task>('tasks', taskId)?.status === 'completed', 'legacy binding run completes');
  const repaired = ctx.store.get<ProjectBinding>('project_bindings', legacy.id)!;
  assert.ok(repaired.baselineId);
  assert.match(repaired.baselineId!, /^baseline_/);
  const run = ctx.store.list<Run>('runs', ctx.roomId).find(item => item.taskId === taskId)!;
  assert.equal(run.baselineId, repaired.baselineId);
  assert.ok(existsSync(ctx.worker.baselines.directory(repaired.baselineId!)));
  const verified = ctx.worker.baselines.verify(repaired.baselineId!);
  assert.equal(verified.record.manifestHash, legacy.manifestHash);
});

test('a legacy binding whose source changed is rejected with baseline_unavailable', async t => {
  const ctx = await fixture(t);
  const legacy = makeLegacy(ctx);
  writeFileSync(join(ctx.project, 'README.md'), '# source changed after the old binding\n');
  const taskId = ctx.command('task.create', {title: 'legacy mismatch run', agentId: 'demo-planner', projectBindingId: legacy.id, bindingVersion: legacy.version}).result.taskId as string;
  ctx.worker.tick();
  await waitUntil(() => ctx.store.get<Task>('tasks', taskId)?.status === 'failed', 'legacy mismatch run fails');
  const run = ctx.store.list<Run>('runs', ctx.roomId).find(item => item.taskId === taskId)!;
  assert.match(run.error ?? '', /baseline_unavailable|旧项目绑定缺少不可变基线/);
  const stillLegacy = ctx.store.get<ProjectBinding>('project_bindings', legacy.id)!;
  assert.equal(stillLegacy.baselineId, undefined);
});
