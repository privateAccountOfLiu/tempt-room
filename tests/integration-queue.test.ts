import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';
import type { Artifact, Integration, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'integration-queue-')), {app, store, service, worker} = await createApp({root, startWorker: false, token: 'integration-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'answer.txt'), 'original\n');
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const taskId = command('task.create', {title: 'integration fixture', agentId: 'demo-planner', projectPath: project}).result.taskId as string;
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  run.status = 'running'; store.event(roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
  const snapshot = worker.workspaces.snapshot(project, run.id); writeFileSync(join(snapshot.workspace, 'answer.txt'), 'candidate\n');
  const changes = worker.workspaces.changes(run.id), artifact = worker.publishArtifact(run, 'fixture.patch', changes.patch, 'text/x-diff', 'patch');
  writeFileSync(join(root, 'artifacts', artifact.id + '.changes.json'), JSON.stringify(changes)); worker.finish(run, 'completed');
  return {root, project, app, store, service, worker, roomId, command, artifact, run};
}

test('artifact.integrate enqueues one durable integration and applies it asynchronously once', async t => {
  const {project, store, worker, roomId, command, artifact} = await fixture(t);
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  assert.equal(queued.result.status, 'queued');
  assert.ok(queued.result.integrationId);
  assert.equal(store.get<Artifact>('artifacts', artifact.id)!.applied, undefined);
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'original\n');
  worker.tick();
  const integration = store.get<Integration>('integrations', queued.result.integrationId as string)!;
  assert.equal(integration.status, 'applied');
  assert.ok(integration.journalId);
  assert.equal(store.get<Artifact>('artifacts', artifact.id)!.applied, true);
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'candidate\n');
  assert.equal(store.events(roomId).filter(event => event.type === 'artifact.applied').length, 1);
  const replay = command('artifact.integrate', {artifactId: artifact.id});
  assert.equal(replay.result.integrationId, queued.result.integrationId);
  assert.equal(replay.result.status, 'applied');
  worker.tick();
  assert.equal(store.events(roomId).filter(event => event.type === 'artifact.applied').length, 1);
});

test('stale source changes move an integration to conflict without touching the source', async t => {
  const {project, store, worker, command, artifact} = await fixture(t);
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  writeFileSync(join(project, 'answer.txt'), 'user edit\n');
  worker.tick();
  const integration = store.get<Integration>('integrations', queued.result.integrationId as string)!;
  assert.equal(integration.status, 'conflict');
  assert.equal(integration.errorCode, 'apply_conflict');
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'user edit\n');
  assert.ok(!store.get<Artifact>('artifacts', artifact.id)!.applied);
  assert.equal(store.get<Task>('tasks', artifact.taskId!)!.status, 'completed');
});
