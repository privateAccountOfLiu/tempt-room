import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { CommandExecutor } from '../apps/server/src/command-executor.ts';
import { ImmutableBaselines } from '../apps/server/src/immutable-baselines.ts';
import { createControllableAdapter } from './helpers/controllable-adapter.ts';
import type { Artifact, Integration, ProjectBinding, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function waitUntil(check: () => boolean, message: string, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(message);
}

test('two real Worker runs enter through one barrier, write isolated workspaces, and integrate their outputs', async t => {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'parallel-execution-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# parallel project\n');
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const { adapter, probe } = createControllableAdapter({ outputs: context => [context.agent.id === 'demo-planner' ? 'planner.txt' : 'reviewer.txt'] });
  const worker = new Worker(store, service, root, { adapter });
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({ version: '0.1', commandId: uid(), roomId, type, payload });
  command('settings.update', { ...store.settings(), concurrency: 4, maxConcurrentRunsPerRoom: 4 });
  const executor = new CommandExecutor(service, new ImmutableBaselines(root));
  const bindingId = (await executor.execute({ version: '0.1', commandId: uid(), roomId, type: 'project.bind', payload: { sourcePath: project } }, { id: 'owner', kind: 'human' })).result.bindingId as string;
  const binding = store.get<ProjectBinding>('project_bindings', bindingId)!;
  const verifierScript = 'process.exit(0)';
  const verifierHash = sha(JSON.stringify({ command: 'node -e', argv: ['node', '-e', verifierScript] }));
  const contract = (objective: string, output: string) => ({
    objective,
    workspaceMode: 'isolated' as const,
    projectBinding: { id: binding.id, version: binding.version, baselineRef: binding.baseCommit ?? 'fixture', manifestHash: binding.manifestHash, allowedPaths: [output] },
    acceptance: [{ id: 'deterministic-check', description: 'deterministic staging check', command: 'node -e', argv: ['node', '-e', verifierScript], verifierVersion: '1.0.0', verifierHash }],
    expectedArtifacts: [{ path: output }],
    dependencies: []
  });
  const plannerTaskId = command('task.create', { title: 'parallel planner deliverable', agentId: 'demo-planner', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('planner deliverable', 'planner.txt') }).result.taskId as string;
  const reviewerTaskId = command('task.create', { title: 'parallel reviewer deliverable', agentId: 'demo-reviewer', projectBindingId: binding.id, bindingVersion: binding.version, contract: contract('reviewer deliverable', 'reviewer.txt') }).result.taskId as string;

  worker.tick();
  const entered = await probe.waitForEntered(2);
  assert.equal(entered.length, 2);
  const enteredRunIds = entered.map(entry => entry.runId);
  assert.equal(new Set(enteredRunIds).size, 2);
  assert.notEqual(entered[0].workspace, entered[1].workspace);
  assert.ok(entered.every(entry => entry.baselineHash === binding.manifestHash));
  assert.equal(store.list<Task>('tasks', roomId).filter(task => task.status === 'completed').length, 0, 'no task may complete before both adapters are released');
  assert.equal(store.list<Artifact>('artifacts', roomId).length, 0, 'no artifact may exist before both adapters are released');
  assert.equal(store.list<Run>('runs', roomId).filter(run => ['running', 'waiting_input'].includes(run.status)).length, 2);
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# parallel project\n');
  assert.ok(!(['planner.txt', 'reviewer.txt'].some(file => { try { readFileSync(join(project, file)); return true; } catch { return false; } })));

  probe.releaseAll();
  await waitUntil(() => {
    const runs = store.list<Run>('runs', roomId);
    return runs.length === 2 && runs.every(run => run.status === 'completed');
  }, 'both runs completed');
  await waitUntil(() => store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'patch').length === 2, 'both patches published');
  const tasks = [store.get<Task>('tasks', plannerTaskId)!, store.get<Task>('tasks', reviewerTaskId)!];
  assert.ok(tasks.every(task => task.status === 'completed'));
  assert.ok(tasks.every(task => task.acceptanceStatus === 'pending'));
  assert.ok(tasks.every(task => task.acceptedArtifactIds === undefined || task.acceptedArtifactIds.length === 0));

  const artifacts = store.list<Artifact>('artifacts', roomId).filter(artifact => artifact.kind === 'patch');
  assert.equal(artifacts.length, 2);
  assert.notEqual(artifacts[0].runId, artifacts[1].runId);
  const hashFor = (artifact: Artifact) => sha(readFileSync(join(root, 'artifacts', artifact.id)));
  for (const task of tasks) {
    const artifact = artifacts.find(item => item.taskId === task.id)!;
    const artifactHash = hashFor(artifact);
    assert.match(artifactHash, /^[a-f0-9]{64}$/);
    command('task.verification.record', {
      taskId: task.id,
      taskVersion: task.version,
      outcome: 'accepted',
      verificationId: `verification_${task.id}_owner`,
      artifactIds: [artifact.id],
      artifactHashes: { [artifact.id]: artifactHash },
      commandRef: `owner check artifact bytes ${artifact.id}`,
      exitCode: 0,
      outputHash: sha(artifactHash),
      reason: 'owner verified the actual patch bytes produced in the isolated workspace'
    });
    assert.equal(store.get<Task>('tasks', task.id)!.acceptanceStatus, 'accepted');
  }

  const reportIntegrationIds: string[] = [];
  for (const artifact of artifacts) reportIntegrationIds.push(command('artifact.integrate', { artifactId: artifact.id }).result.integrationId as string);
  await waitUntil(() => {
    worker.tick();
    return reportIntegrationIds.every(id => store.get<Integration>('integrations', id)?.status === 'applied');
  }, 'both integrations applied');
  assert.equal(store.list<Integration>('integrations', roomId).filter(item => item.status === 'applied').length, 2);
  assert.equal(readFileSync(join(project, 'planner.txt'), 'utf8'), 'completed planner.txt\n');
  assert.equal(readFileSync(join(project, 'reviewer.txt'), 'utf8'), 'completed reviewer.txt\n');
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# parallel project\n');
  assert.equal(store.events(roomId).filter(event => event.type === 'task.verification.recorded').length, 2);
  assert.equal(store.events(roomId).filter(event => event.type === 'artifact.applied').length, 2);
  assert.equal(probe.timeline().filter(event => event.phase === 'entered').length, 2);
});
