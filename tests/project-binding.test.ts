import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import { buildProjectManifest } from '../apps/server/src/project-manifest.ts';
import type { ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
function projectFixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'project-binding-')), project = join(root, 'project'), roomRoot = join(root, 'room');
  mkdirSync(join(project, 'src'), {recursive: true}); mkdirSync(roomRoot, {recursive: true});
  writeFileSync(join(project, 'src', 'fixed.ts'), 'export const value = 1;\n');
  writeFileSync(join(project, 'README.md'), '# Fixture\n');
  const store = new Store(join(roomRoot, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, roomRoot, {adapter: async function* () { yield {type: 'text', text: 'task complete'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const executor = new CommandExecutor(service, new ImmutableBaselines(roomRoot));
  const bind = (payload: unknown) => executor.execute({version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload}, {id: 'owner', kind: 'human'});
  return {root, project, roomRoot, store, service, worker, roomId, command, executor, bind};
}

test('project.bind freezes an actual-file manifest and version changes on source edits', async t => {
  const {project, store, roomId, bind} = projectFixture(t);
  const first = await bind({sourcePath: project, allowedExecutionModes: ['sandbox']});
  const binding = store.get<ProjectBinding>('project_bindings', first.result.bindingId as string)!;
  assert.equal(binding.manifestFileCount, 2);
  assert.match(binding.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(buildProjectManifest(project).manifestHash, binding.manifestHash);
  assert.ok(binding.baselineId, 'a binding must reference a frozen baseline');
  writeFileSync(join(project, 'src', 'fixed.ts'), 'export const value = 2;\n');
  const second = await bind({sourcePath: project});
  assert.equal(second.result.version, 2);
  assert.notEqual(second.result.manifestHash, binding.manifestHash);
  assert.notEqual(buildProjectManifest(project).manifestHash, binding.manifestHash);
  try {
    const alias = join(project, '..', 'project-alias');
    symlinkSync(project, alias, 'junction');
    await assert.rejects(() => bind({sourcePath: alias}), /符号链接|重解析/);
  } catch (error) {
    if (!/符号链接|重解析/.test((error as Error).message)) throw error;
  }
  assert.equal(store.list<ProjectBinding>('project_bindings', roomId).length, 2);
});

test('tasks reference a binding by version and agents cannot bind projects', async t => {
  const {project, store, roomId, command, executor, bind} = projectFixture(t);
  const bound = await bind({sourcePath: project});
  const taskId = command('task.create', {title: 'Bound task', agentId: 'demo-planner', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version}).result.taskId as string;
  const task = store.get<Task>('tasks', taskId)!;
  assert.equal(task.projectBindingId, bound.result.bindingId);
  assert.equal(task.bindingVersion, bound.result.version);
  assert.equal(task.projectPath, project);
  assert.equal(task.baselineManifestHash, bound.result.manifestHash);
  assert.throws(() => command('task.create', {title: 'Mismatch', agentId: 'demo-planner', projectBindingId: bound.result.bindingId, bindingVersion: 99}), /版本不匹配/);
  await assert.rejects(() => executor.execute({version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload: {sourcePath: project}}, {id: 'demo-planner', kind: 'agent'}), /只有 owner/);
});

test('a binding without a prepared baseline is refused instead of freezing a moving directory', t => {
  const {project, service, roomId} = projectFixture(t);
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload: {sourcePath: project}}), /不可变基线/);
});

test('two bound task runs receive distinct independent workspaces and leave the source unchanged', async t => {
  const {project, store, worker, roomId, command, bind} = projectFixture(t);
  const before = readFileSync(join(project, 'src', 'fixed.ts'), 'utf8');
  const bound = await bind({sourcePath: project});
  const first = command('task.create', {title: 'Bound task A', agentId: 'demo-planner', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version}).result.taskId as string;
  const second = command('task.create', {title: 'Bound task B', agentId: 'demo-planner', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version}).result.taskId as string;
  const deadline = Date.now() + 15000;
  const completed = () => [first, second].map(taskId => store.list<Run>('runs', roomId).find(run => run.taskId === taskId)!).every(run => run.status === 'completed');
  while (Date.now() < deadline && !completed()) { worker.tick(); await new Promise(done => setTimeout(done, 25)); }
  const runs = [first, second].map(taskId => store.list<Run>('runs', roomId).find(run => run.taskId === taskId)!);
  assert.ok(runs.every(run => run.status === 'completed'), runs.map(run => `${run.id}:${run.status}:${run.error}`).join(' '));
  assert.ok(runs.every(run => run.projectBindingId === bound.result.bindingId && run.bindingVersion === bound.result.version));
  assert.ok(runs.every(run => run.dirtyBaselineHash === bound.result.manifestHash));
  assert.ok(runs.every(run => run.baselineId && run.baselineId === bound.result.baselineId));
  assert.ok(runs.every(run => (run.externalReads ?? []).some(read => read.kind === 'file' && read.source === project && read.hash === bound.result.manifestHash)));
  assert.ok(runs.every(run => run.workspacePath));
  assert.notEqual(runs[0].workspacePath, runs[1].workspacePath);
  assert.equal(readFileSync(join(project, 'src', 'fixed.ts'), 'utf8'), before);
});

test('a source change after binding does not change the frozen run inputs', async t => {
  const {project, store, worker, roomId, command, bind} = projectFixture(t);
  const bound = await bind({sourcePath: project});
  writeFileSync(join(project, 'src', 'fixed.ts'), 'export const value = 99;\n');
  const taskId = command('task.create', {title: 'Frozen input task', agentId: 'demo-planner', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version}).result.taskId as string;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    worker.tick();
    const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId);
    if (run && ['completed', 'failed', 'canceled'].includes(run.status)) break;
    await new Promise(done => setTimeout(done, 25));
  }
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.dirtyBaselineHash, bound.result.manifestHash);
  assert.ok(run.workspacePath);
  assert.equal(readFileSync(join(run.workspacePath!, 'src', 'fixed.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(readFileSync(join(project, 'src', 'fixed.ts'), 'utf8'), 'export const value = 99;\n');
});

test('non-binding project tasks record file read evidence for the source workspace', async t => {
  const {project, store, worker, roomId, command} = projectFixture(t);
  const taskId = command('task.create', {title: 'Direct project task', agentId: 'demo-planner', projectPath: project}).result.taskId as string;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    worker.tick();
    const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId);
    if (run && ['completed', 'failed', 'canceled'].includes(run.status)) break;
    await new Promise(done => setTimeout(done, 25));
  }
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  assert.equal(run.status, 'completed', run.error);
  assert.ok((run.externalReads ?? []).some(read => read.kind === 'file' && read.source === project && read.hash));
});
