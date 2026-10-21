import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import { scanProjectFiles } from '../apps/server/src/project-files.ts';
import { createControllableAdapter } from './helpers/controllable-adapter.ts';
import type { Artifact, ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const hash = 'b'.repeat(64);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function waitUntil(check: () => boolean, message: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(message);
}

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'parallel-dependencies-'));
  const project = join(root, 'project');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'README.md'), '# dependencies project\n');
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const {adapter, probe} = createControllableAdapter({outputs: context => [context.agent.id === 'demo-planner' ? 'planner.txt' : 'reviewer.txt']});
  const worker = new Worker(store, service, root, {adapter});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {root, project, store, service, worker, probe, roomId, command, executor: new CommandExecutor(service, new ImmutableBaselines(root))};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

function createTask(ctx: Ctx, title: string, agentId: string, options: {dependencies?: string[]; contract?: unknown; projectBindingId?: string; bindingVersion?: number} = {}): string {
  return ctx.command('task.create', {
    title,
    agentId,
    projectPath: ctx.project,
    ...(options.dependencies?.length ? {dependencies: options.dependencies} : {}),
    ...(options.projectBindingId ? {projectBindingId: options.projectBindingId} : {}),
    ...(options.bindingVersion ? {bindingVersion: options.bindingVersion} : {}),
    ...(options.contract ? {contract: options.contract} : {})
  }).result.taskId as string;
}

async function pump(ctx: Ctx, condition: () => boolean, message: string, timeoutMs = 20000) {
  await waitUntil(() => { ctx.worker.tick(); return condition(); }, message, timeoutMs);
}

test('concurrency=1 fails the two-adapter barrier, proving the barrier has detection power', async t => {
  const ctx = await fixture(t);
  ctx.command('settings.update', {...ctx.store.settings(), concurrency: 1, maxConcurrentRunsPerRoom: 1});
  const first = createTask(ctx, 'serial one', 'demo-planner');
  const second = createTask(ctx, 'serial two', 'demo-reviewer');
  ctx.worker.tick();
  const entered = await ctx.probe.waitForEntered(1);
  assert.equal(entered.length, 1);
  await assert.rejects(() => ctx.probe.waitForEntered(2, 1200), /adapter entries 1\/2/);
  assert.equal(ctx.store.list<Run>('runs', ctx.roomId).filter(run => ['running', 'waiting_input'].includes(run.status)).length, 1, 'only one Run may be active at concurrency 1');
  assert.equal(ctx.store.list<Task>('tasks', ctx.roomId).filter(task => ['completed', 'failed'].includes(task.status)).length, 0);
  ctx.probe.release(entered[0].runId);
  await pump(ctx, () => ctx.probe.entries().length >= 2, 'second serial adapter entered');
  ctx.probe.releaseAll();
  await pump(ctx, () => {
    const tasks = [ctx.store.get<Task>('tasks', first)!, ctx.store.get<Task>('tasks', second)!];
    return tasks.every(task => task.status === 'completed');
  }, 'both serial tasks completed');
  assert.equal(ctx.probe.entries().length, 2);
});

test('two isolated runs share the frozen baseline but never share a workspace or mutate the source', async t => {
  const ctx = await fixture(t);
  const bindingId = (await ctx.executor.execute({version: '0.1', commandId: uid(), roomId: ctx.roomId, type: 'project.bind', payload: {sourcePath: ctx.project}}, {id: 'owner', kind: 'human'})).result.bindingId as string;
  const binding = ctx.store.get<ProjectBinding>('project_bindings', bindingId)!;
  const contract = (output: string) => ({
    objective: `write ${output}`,
    workspaceMode: 'isolated' as const,
    projectBinding: {id: binding.id, version: binding.version, baselineRef: binding.baseCommit ?? 'fixture', manifestHash: binding.manifestHash, allowedPaths: [output]},
    acceptance: [{id: `check_${output}`, description: 'fixture check', command: 'node -e', argv: ['node', '-e', 'process.exit(0)'], verifierVersion: '1.0.0', verifierHash: hash}],
    expectedArtifacts: [{path: output}],
    dependencies: []
  });
  const plannerTaskId = createTask(ctx, 'isolated planner', 'demo-planner', {contract: contract('planner.txt'), projectBindingId: binding.id, bindingVersion: binding.version});
  const reviewerTaskId = createTask(ctx, 'isolated reviewer', 'demo-reviewer', {contract: contract('reviewer.txt'), projectBindingId: binding.id, bindingVersion: binding.version});
  const sourceHashBefore = scanProjectFiles(ctx.project).manifestHash;
  ctx.worker.tick();
  const entries = await ctx.probe.waitForEntered(2);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].workspace, entries[1].workspace);
  assert.ok(entries.every(entry => entry.baselineHash === binding.manifestHash));
  assert.equal(scanProjectFiles(ctx.project).manifestHash, sourceHashBefore, 'source must be untouched while both runs are active');
  ctx.probe.releaseAll();
  await pump(ctx, () => {
    const tasks = [ctx.store.get<Task>('tasks', plannerTaskId)!, ctx.store.get<Task>('tasks', reviewerTaskId)!];
    return tasks.every(task => task.status === 'completed');
  }, 'both isolated tasks completed');
  assert.equal(scanProjectFiles(ctx.project).manifestHash, sourceHashBefore, 'source must still be untouched after isolated runs');
  const plannerWorkspace = ctx.probe.entries().find(entry => entry.agentId === 'demo-planner')!.workspace;
  const reviewerWorkspace = ctx.probe.entries().find(entry => entry.agentId === 'demo-reviewer')!.workspace;
  assert.equal(readFileSync(join(plannerWorkspace, 'planner.txt'), 'utf8'), 'completed planner.txt\n');
  assert.equal(readFileSync(join(reviewerWorkspace, 'reviewer.txt'), 'utf8'), 'completed reviewer.txt\n');
  assert.ok(!existsSync(join(plannerWorkspace, 'reviewer.txt')));
  assert.ok(!existsSync(join(reviewerWorkspace, 'planner.txt')));
  assert.equal(ctx.store.list<Artifact>('artifacts', ctx.roomId).filter(artifact => artifact.kind === 'patch').length, 2);
});

test('a failed dependency isolates its successor; the independent branch and retry keep IDs stable', async t => {
  const ctx = await fixture(t);
  const a = createTask(ctx, 'branch A', 'demo-planner');
  const b = createTask(ctx, 'branch B', 'demo-reviewer');
  const c = createTask(ctx, 'blocked by A', 'demo-planner', {dependencies: [a]});
  const d = createTask(ctx, 'follows B', 'demo-reviewer', {dependencies: [b]});
  ctx.worker.tick();
  const aRun = ctx.store.list<Run>('runs', ctx.roomId).find(run => run.taskId === a)!;
  const bRunInitial = ctx.store.list<Run>('runs', ctx.roomId).find(run => run.taskId === b)!;
  const cRunInitial = ctx.store.list<Run>('runs', ctx.roomId).find(run => run.taskId === c)!;
  const aEntry = await ctx.probe.entered(aRun.id);
  const bEntry = await ctx.probe.entered(bRunInitial.id);
  assert.notEqual(aEntry.runId, bEntry.runId);
  ctx.probe.fail(aEntry.runId, new Error('fixture A failure'));
  ctx.probe.release(bEntry.runId);
  await pump(ctx, () => ctx.store.get<Task>('tasks', a)?.status === 'failed' && ctx.store.get<Task>('tasks', b)?.status === 'completed', 'A failed and B completed');
  const bRun = ctx.store.list<Run>('runs', ctx.roomId).find(run => run.taskId === b)!;
  const bArtifact = ctx.store.list<Artifact>('artifacts', ctx.roomId).find(artifact => artifact.taskId === b)!;
  assert.notEqual(ctx.store.get<Task>('tasks', c)?.status, 'completed', 'A failed successor C must not complete');
  assert.notEqual(ctx.store.get<Task>('tasks', d)?.status, 'completed', 'D must wait for B');

  await pump(ctx, () => ctx.probe.entries().some(entry => entry.taskId === d), 'independent successor D entered');
  const dEntry = ctx.probe.entries().find(entry => entry.taskId === d)!;
  assert.notEqual(dEntry.runId, bRun.id);
  ctx.probe.release(dEntry.runId);
  await pump(ctx, () => ctx.store.get<Task>('tasks', d)?.status === 'completed', 'D completed');
  assert.notEqual(ctx.store.get<Task>('tasks', c)?.status, 'completed', 'C must not start while A is failed');

  const retryA = ctx.command('run.retry', {runId: aEntry.runId}).result as unknown as {runId: string};
  await pump(ctx, () => ctx.probe.entries().some(entry => entry.taskId === a && entry.runId === retryA.runId), 'A retry entered');
  ctx.probe.release(retryA.runId);
  await pump(ctx, () => ctx.store.get<Task>('tasks', a)?.status === 'completed', 'A retry completed');

  // A failure marks the dependent C run failed; after A is fixed the owner
  // retries C and only then does the blocked branch advance.
  const retryC = ctx.command('run.retry', {runId: cRunInitial.id}).result as unknown as {runId: string};
  await pump(ctx, () => ctx.probe.entries().some(entry => entry.taskId === c && entry.runId === retryC.runId), 'blocked successor C entered');
  ctx.probe.release(retryC.runId);
  await pump(ctx, () => ctx.store.get<Task>('tasks', c)?.status === 'completed', 'C completed after A was fixed');
  assert.equal(ctx.store.list<Run>('runs', ctx.roomId).find(run => run.taskId === b)!.id, bRun.id, 'B Run ID must not change when A is retried');
  assert.equal(ctx.store.list<Artifact>('artifacts', ctx.roomId).find(artifact => artifact.taskId === b)!.id, bArtifact.id, 'B artifact ID must not change when A is retried');
});

test('the same commandId is idempotent and the same id with different content is rejected', async t => {
  const ctx = await fixture(t);
  const commandId = uid();
  const first = ctx.service.execute({version: '0.1', commandId, roomId: ctx.roomId, type: 'message.send', payload: {text: 'exactly once'}});
  const second = ctx.service.execute({version: '0.1', commandId, roomId: ctx.roomId, type: 'message.send', payload: {text: 'exactly once'}});
  assert.equal(second.result.messageId, first.result.messageId);
  assert.equal(ctx.store.list('messages', ctx.roomId).filter((message: any) => message.text === 'exactly once').length, 1);
  assert.throws(() => ctx.service.execute({version: '0.1', commandId, roomId: ctx.roomId, type: 'message.send', payload: {text: 'different content'}}), /commandId|不同内容/);
});
