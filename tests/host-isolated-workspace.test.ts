import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import type { Artifact, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'host-isolated-'));
  const project = join(root, 'project'), roomRoot = join(root, 'room');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(roomRoot, { recursive: true });
  writeFileSync(join(project, 'src', 'fixed.ts'), 'export const value = 1;\n');
  const store = new Store(join(roomRoot, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const writes: { runId: string; workspace: string; file: string }[] = [];
  const worker = new Worker(store, service, roomRoot, {
    adapter: async function* (ctx: any) {
      const file = `delivered-${ctx.run.id}.txt`;
      writeFileSync(join(ctx.workspace, file), `written in ${ctx.workspace}\n`);
      writes.push({ runId: ctx.run.id, workspace: ctx.workspace, file });
      yield { type: 'text', text: 'done' };
    },
  });
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (type: string, payload: unknown) => service.execute({ version: '0.1', commandId: uid(), roomId, type, payload });
  const executor = new CommandExecutor(service, new ImmutableBaselines(roomRoot));
  const bind = (payload: unknown) => executor.execute({ version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload }, { id: 'owner', kind: 'human' });
  return { root, project, roomRoot, store, service, worker, roomId, command, executor, bind, writes };
}

async function driveToCompletion(worker: Worker, store: Store, roomId: string, taskIds: string[], timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    worker.tick();
    const runs = taskIds.map(taskId => store.list<Run>('runs', roomId).find(run => run.taskId === taskId));
    if (runs.every(run => run && ['completed', 'failed', 'canceled'].includes(run.status))) break;
    await new Promise(done => setTimeout(done, 25));
  }
  const runs = taskIds.map(taskId => store.list<Run>('runs', roomId).find(run => run.taskId === taskId));
  for (const run of runs) assert.ok(run, 'no run was created for one of the tasks');
  return runs as Run[];
}

test('host isolated runs use independent directories from one frozen baseline', async t => {
  const { project, store, worker, roomId, command, bind } = fixture(t);
  command('agent.save', {
    id: 'demo-host', name: '演示本机直连', provider: 'demo', role: '本机直连演示', color: 'blue',
    executable: '', endpoint: '', model: '', credentialEnv: '', version: '', runtimeDirectory: '',
    connectionMode: 'managed', executionMode: 'host', responseFormat: 'text', enabled: true,
  });
  command('room.members.set', { members: [...store.room(roomId)!.members, 'demo-host'] });
  const bound = await bind({ sourcePath: project, allowedExecutionModes: ['host'] });
  const contract = {
    objective: '在独立目录产出文件',
    workspaceMode: 'isolated',
    projectBinding: { id: bound.result.bindingId, version: bound.result.version, baselineRef: 'fixture', manifestHash: bound.result.manifestHash, allowedPaths: ['delivered-*.txt'] },
    acceptance: [{ id: 'fixture', description: 'fixture', command: 'node -e "process.exit(0)"', verifierVersion: '1.0.0', verifierHash: 'a'.repeat(64) }],
    expectedArtifacts: [], dependencies: [],
  };
  const first = command('task.create', { title: 'Isolated A', agentId: 'demo-host', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version, contract }).result.taskId as string;
  const second = command('task.create', { title: 'Isolated B', agentId: 'demo-host', projectBindingId: bound.result.bindingId, bindingVersion: bound.result.version, contract }).result.taskId as string;

  const task = store.get<Task>('tasks', first)!;
  assert.equal(task.workspaceMode, 'isolated', 'the frozen workspace mode must reach the task');

  const runs = await driveToCompletion(worker, store, roomId, [first, second]);
  assert.ok(runs.every(run => run.status === 'completed'), runs.map(run => `${run.id}:${run.status}:${run.error}`).join(' '));
  assert.ok(runs.every(run => run.workspaceMode === 'isolated'));
  assert.ok(runs.every(run => run.baselineId === bound.result.baselineId));
  assert.notEqual(runs[0].workspacePath, runs[1].workspacePath);
  for (const run of runs) assert.ok(run.workspacePath && !resolve(run.workspacePath).toLowerCase().startsWith(resolve(project).toLowerCase()), 'the run must not work in the source directory');

  // The source directory is untouched by an isolated host run.
  assert.deepEqual(readdirSync(project).sort(), ['src']);
  assert.equal(readFileSync(join(project, 'src', 'fixed.ts'), 'utf8'), 'export const value = 1;\n');

  // An isolated host run publishes a reviewable patch, not a direct change list.
  const artifacts = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'patch');
  assert.equal(artifacts.length, 2, 'both isolated runs must publish a patch');
  for (const artifact of artifacts) assert.match(artifact.mediaType, /diff/);
});

test('legacy host source runs keep working in the project directory', async t => {
  const { project, store, worker, roomId, command, bind } = fixture(t);
  command('agent.save', {
    id: 'demo-host', name: '演示本机直连', provider: 'demo', role: '本机直连演示', color: 'blue',
    executable: '', endpoint: '', model: '', credentialEnv: '', version: '', runtimeDirectory: '',
    connectionMode: 'managed', executionMode: 'host', responseFormat: 'text', enabled: true,
  });
  command('room.members.set', { members: [...store.room(roomId)!.members, 'demo-host'] });
  await bind({ sourcePath: project, allowedExecutionModes: ['host'] });
  const taskId = command('task.create', { title: 'Legacy host source', agentId: 'demo-host', projectPath: project }).result.taskId as string;
  const runs = await driveToCompletion(worker, store, roomId, [taskId]);
  const run = runs[0];
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.workspaceMode, 'source');
  assert.equal(resolve(run.workspacePath!).toLowerCase(), resolve(project).toLowerCase());
  const reports = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'report');
  assert.equal(reports.length, 1, 'a legacy host run reports the observed change list');
});
