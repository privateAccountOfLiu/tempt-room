import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid} from '../apps/server/src/store.ts';
import type {Artifact, Integration, Run, Task} from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const hash = 'a'.repeat(64);

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'parallel-integration-p04-'));
  const {app, store, service, worker} = await createApp({root, startWorker: false, token: 'p04-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const project = join(root, 'project');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'a.txt'), '0\n');
  writeFileSync(join(project, 'b.txt'), '0\n');
  writeFileSync(join(project, 'README.md'), '# project\n');
  return {root, project, app, store, service, worker, roomId: store.rooms()[0].id};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

const combinedReject = "const fs=require('fs');const a=fs.readFileSync('a.txt','utf8').trim();const b=fs.readFileSync('b.txt','utf8').trim();if(a==='1'&&b==='1')process.exit(1);process.exit(0);";

function createTask(ctx: Ctx, title: string, verifierScript: string) {
  const check = {id: 'frozen-check', description: 'combined target check', command: 'node -e', argv: ['node', '-e', verifierScript], verifierVersion: '1.0.0', verifierHash: hash};
  const contract = {
    objective: title,
    projectBinding: {id: `binding_${title.replace(/[^a-zA-Z0-9_-]/g, '_')}`, version: 1, baselineRef: 'baseline_1', manifestHash: hash, allowedPaths: ['a.txt', 'b.txt']},
    acceptance: [check],
    expectedArtifacts: [],
    dependencies: []
  };
  const command = (type: string, payload: unknown) => ctx.service.execute({version: '0.1', commandId: uid(), roomId: ctx.roomId, type, payload});
  const taskId = command('task.create', {title, agentId: 'demo-planner', projectPath: ctx.project, contract}).result.taskId as string;
  const run = ctx.store.list<Run>('runs', ctx.roomId).find(item => item.taskId === taskId)!;
  run.status = 'running'; ctx.store.event(ctx.roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
  return {taskId, run, command};
}

function publish(ctx: Ctx, taskId: string, run: Run, file: string, content = '1\n') {
  const snapshot = ctx.worker.workspaces.snapshot(ctx.project, run.id);
  writeFileSync(join(snapshot.workspace, file), content);
  const changes = ctx.worker.workspaces.changes(run.id);
  const artifact = ctx.worker.publishArtifact(run, `${file}.patch`, changes.patch, 'text/x-diff', 'patch');
  writeFileSync(join(ctx.root, 'artifacts', artifact.id + '.changes.json'), JSON.stringify(changes));
  ctx.worker.finish(run, 'completed');
  return artifact;
}

async function waitIntegration(ctx: Ctx, id: string, statuses: Integration['status'][], timeoutMs = 30000): Promise<Integration> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = ctx.store.get<Integration>('integrations', id);
    if (current && statuses.includes(current.status)) return current;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(`integration ${id} did not reach ${statuses.join('/')}: ${ctx.store.get<Integration>('integrations', id)?.status}`);
}

test('A applies first, then B is verified against A target and rejected instead of overwriting', async t => {
  const ctx = await fixture(t);
  const a = createTask(ctx, 'task-a', 'process.exit(0)');
  const aArtifact = publish(ctx, a.taskId, a.run, 'a.txt');
  const aIntegration = a.command('artifact.integrate', {artifactId: aArtifact.id}).result.integrationId as string;
  ctx.worker.tick();
  const appliedA = await waitIntegration(ctx, aIntegration, ['applied']);
  assert.ok(appliedA.verifiedTargetManifestHash);
  assert.ok(appliedA.stagedManifestHash);
  assert.ok(appliedA.appliedTargetManifestHash);
  assert.ok(appliedA.appliedArtifactSetHash);
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '1\n');
  assert.equal(readFileSync(join(ctx.project, 'b.txt'), 'utf8'), '0\n');
  const journal = JSON.parse(readFileSync(join(ctx.root, 'apply', appliedA.journalId!, 'journal.json'), 'utf8'));
  assert.equal(journal.targetBeforeHash, appliedA.verifiedTargetManifestHash);
  assert.equal(journal.targetAfterHash, appliedA.stagedManifestHash);

  // B's task was defined against the same baseline; its verifier rejects the
  // combined target a=1,b=1. It must fail against A's applied target.
  const b = createTask(ctx, 'task-b', combinedReject);
  const bArtifact = publish(ctx, b.taskId, b.run, 'b.txt');
  const bIntegration = b.command('artifact.integrate', {artifactId: bArtifact.id}).result.integrationId as string;
  ctx.worker.tick();
  const failedB = await waitIntegration(ctx, bIntegration, ['verification_failed']);
  assert.equal(failedB.errorCode, 'verification_exit_1');
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '1\n');
  assert.equal(readFileSync(join(ctx.project, 'b.txt'), 'utf8'), '0\n');

  // The normal combination still works with a verifier that accepts a=1,b=1.
  const b2 = createTask(ctx, 'task-b2', 'process.exit(0)');
  const b2Artifact = publish(ctx, b2.taskId, b2.run, 'b.txt');
  const b2Integration = b2.command('artifact.integrate', {artifactId: b2Artifact.id}).result.integrationId as string;
  ctx.worker.tick();
  const appliedB2 = await waitIntegration(ctx, b2Integration, ['applied']);
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '1\n');
  assert.equal(readFileSync(join(ctx.project, 'b.txt'), 'utf8'), '1\n');
  assert.ok(appliedB2.appliedArtifactSetHash);
  assert.notEqual(appliedA.appliedArtifactSetHash, appliedB2.appliedArtifactSetHash);
});

test('a source change after verification blocks apply without touching the source', async t => {
  const ctx = await fixture(t);
  const task = createTask(ctx, 'tamper-source', 'process.exit(0)');
  const artifact = publish(ctx, task.taskId, task.run, 'a.txt');
  const integrationId = task.command('artifact.integrate', {artifactId: artifact.id, requireAuthorization: true}).result.integrationId as string;
  ctx.worker.tick();
  await waitIntegration(ctx, integrationId, ['ready_to_apply']);
  writeFileSync(join(ctx.project, 'README.md'), '# changed after verification\n');
  task.command('integration.authorize', {integrationId});
  ctx.worker.tick();
  const conflicted = await waitIntegration(ctx, integrationId, ['conflict', 'blocked', 'unknown']);
  assert.equal(conflicted.errorCode, 'source_changed');
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '0\n');
  assert.equal(ctx.store.get<Artifact>('artifacts', artifact.id)?.applied, undefined);
});

test('a candidate change after verification blocks apply', async t => {
  const ctx = await fixture(t);
  const task = createTask(ctx, 'tamper-candidate', 'process.exit(0)');
  const artifact = publish(ctx, task.taskId, task.run, 'a.txt');
  const integrationId = task.command('artifact.integrate', {artifactId: artifact.id, requireAuthorization: true}).result.integrationId as string;
  ctx.worker.tick();
  await waitIntegration(ctx, integrationId, ['ready_to_apply']);
  const changesPath = join(ctx.root, 'artifacts', artifact.id + '.changes.json');
  const changes = JSON.parse(readFileSync(changesPath, 'utf8'));
  changes.changes[0].after = Buffer.from('tampered\n').toString('base64');
  writeFileSync(changesPath, JSON.stringify(changes));
  task.command('integration.authorize', {integrationId});
  ctx.worker.tick();
  const conflicted = await waitIntegration(ctx, integrationId, ['conflict', 'blocked', 'unknown']);
  assert.equal(conflicted.errorCode, 'stale_artifact');
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '0\n');
});

test('a verifier change after verification blocks apply', async t => {
  const ctx = await fixture(t);
  const task = createTask(ctx, 'tamper-verifier', 'process.exit(0)');
  const artifact = publish(ctx, task.taskId, task.run, 'a.txt');
  const integrationId = task.command('artifact.integrate', {artifactId: artifact.id, requireAuthorization: true}).result.integrationId as string;
  ctx.worker.tick();
  await waitIntegration(ctx, integrationId, ['ready_to_apply']);
  const taskRecord = ctx.store.get<Task>('tasks', task.taskId)!;
  const tampered: Task = {...taskRecord, version: taskRecord.version + 1, contract: {...taskRecord.contract!, acceptance: [{...taskRecord.contract!.acceptance[0]!, command: 'node -e "process.exit(1)"'}]}};
  ctx.store.put('tasks', tampered);
  task.command('integration.authorize', {integrationId});
  ctx.worker.tick();
  const conflicted = await waitIntegration(ctx, integrationId, ['conflict', 'blocked', 'unknown']);
  assert.equal(conflicted.errorCode, 'stale_artifact');
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '0\n');
});

test('two candidates changing the same file keep the applied result and both patches', async t => {
  const ctx = await fixture(t);
  const a = createTask(ctx, 'conflict-a', 'process.exit(0)');
  const b = createTask(ctx, 'conflict-b', 'process.exit(0)');
  const aArtifact = publish(ctx, a.taskId, a.run, 'a.txt', '1\n');
  const bArtifact = publish(ctx, b.taskId, b.run, 'a.txt', '2\n');
  const aIntegration = a.command('artifact.integrate', {artifactId: aArtifact.id}).result.integrationId as string;
  ctx.worker.tick();
  await waitIntegration(ctx, aIntegration, ['applied']);
  const bIntegration = b.command('artifact.integrate', {artifactId: bArtifact.id}).result.integrationId as string;
  ctx.worker.tick();
  const conflicted = await waitIntegration(ctx, bIntegration, ['conflict', 'blocked']);
  assert.equal(conflicted.errorCode, 'apply_conflict');
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '1\n');
  assert.equal(existsSync(join(ctx.root, 'artifacts', aArtifact.id)), true);
  assert.equal(existsSync(join(ctx.root, 'artifacts', bArtifact.id)), true);
  assert.equal(ctx.store.get<Artifact>('artifacts', bArtifact.id)?.applied, undefined);
});

test('deleting a room blocks an accepted ready_to_apply integration before any file is applied', async t => {
  const ctx = await fixture(t);
  const {taskId, run, command} = createTask(ctx, 'accepted integration delete race', combinedReject);
  const artifact = publish(ctx, taskId, run, 'a.txt');
  const integrated = command('artifact.integrate', {artifactId: artifact.id, requireAuthorization: true}) as any;
  const integrationId = integrated.result.integrationId as string;
  ctx.worker.tick();
  await waitIntegration(ctx, integrationId, ['ready_to_apply']);
  assert.equal(ctx.store.get<Integration>('integrations', integrationId)?.status, 'ready_to_apply');
  command('room.delete', {expectedRevision: 1});
  const blocked = ctx.store.get<Integration>('integrations', integrationId)!;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.errorCode, 'room_deleting');
  await assert.rejects(async () => command('artifact.apply', {artifactId: artifact.id}), /房间|删除/);
  assert.equal(readFileSync(join(ctx.project, 'a.txt'), 'utf8'), '0\n');
  assert.equal(ctx.store.get<Artifact>('artifacts', artifact.id)?.applied, undefined);
});
