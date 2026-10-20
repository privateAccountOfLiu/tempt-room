import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Artifact, Integration, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data'), hash = 'a'.repeat(64);
type AcceptanceSpec = string | {command: string; argv?: string[]};
async function fixture(t: import('node:test').TestContext, acceptance?: AcceptanceSpec) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'integration-queue-')), {app, store, service, worker} = await createApp({root, startWorker: false, token: 'integration-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'answer.txt'), 'original\n');
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const check = acceptance ? (typeof acceptance === 'string' ? {id: 'verify', description: 'verification command', command: acceptance, verifierVersion: '1.0.0', verifierHash: hash} : {id: 'verify', description: 'verification command', command: acceptance.command, ...(acceptance.argv ? {argv: acceptance.argv} : {}), verifierVersion: '1.0.0', verifierHash: hash}) : undefined;
  const contract = check ? {objective: 'verify integration', projectBinding: {id: 'binding_integration', version: 1, baselineRef: 'baseline_1', manifestHash: hash, allowedPaths: ['answer.txt']}, acceptance: [check], expectedArtifacts: [], dependencies: []} : undefined;
  const taskId = command('task.create', {title: 'integration fixture', agentId: 'demo-planner', projectPath: project, ...(contract ? {contract} : {})}).result.taskId as string;
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  run.status = 'running'; store.event(roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
  const snapshot = worker.workspaces.snapshot(project, run.id); writeFileSync(join(snapshot.workspace, 'answer.txt'), 'candidate\n');
  const changes = worker.workspaces.changes(run.id), artifact = worker.publishArtifact(run, 'fixture.patch', changes.patch, 'text/x-diff', 'patch');
  writeFileSync(join(root, 'artifacts', artifact.id + '.changes.json'), JSON.stringify(changes)); worker.finish(run, 'completed');
  return {root, project, app, store, service, worker, roomId, command, artifact, run, taskId};
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

test('owner-approved acceptance commands run in staging; failure leaves the source untouched', async t => {
  const failedFixture = await fixture(t, 'node -e "process.exit(1)"');
  const failed = failedFixture.command('artifact.integrate', {artifactId: failedFixture.artifact.id});
  failedFixture.worker.tick();
  const failedIntegration = failedFixture.store.get<Integration>('integrations', failed.result.integrationId as string)!;
  assert.equal(failedIntegration.status, 'verification_failed');
  assert.equal(failedIntegration.errorCode, 'verification_exit_1');
  assert.equal(readFileSync(join(failedFixture.project, 'answer.txt'), 'utf8'), 'original\n');
  assert.ok(!failedFixture.store.get<Artifact>('artifacts', failedFixture.artifact.id)!.applied);

  const passedFixture = await fixture(t, 'node -e "process.exit(0)"');
  const passed = passedFixture.command('artifact.integrate', {artifactId: passedFixture.artifact.id});
  passedFixture.worker.tick();
  const passedIntegration = passedFixture.store.get<Integration>('integrations', passed.result.integrationId as string)!;
  assert.equal(passedIntegration.status, 'applied');
  assert.match(passedIntegration.verificationId ?? '', /^verification_/);
  assert.equal(readFileSync(join(passedFixture.project, 'answer.txt'), 'utf8'), 'candidate\n');
});

test('restart marks in-flight integrations unknown and blocks blind re-enqueue', async t => {
  const {store, service, worker, root, command, artifact, roomId} = await fixture(t);
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  const running = {...store.get<Integration>('integrations', queued.result.integrationId as string)!, status: 'applying' as const, updatedAt: new Date().toISOString()};
  store.event(roomId, 'integration.updated', {id: 'system', kind: 'system'}, {integration: running});
  const restarted = new Worker(store, service, root, {});
  t.after(async () => { await restarted.close(); });
  const recovered = store.get<Integration>('integrations', running.id)!;
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.errorCode, 'restart_unknown');
  assert.throws(() => command('artifact.integrate', {artifactId: artifact.id}), /未知\/阻塞/);
});

test('ready_to_apply waits for explicit owner authorization and records verification metadata', async t => {
  const {store, project, worker, command, artifact} = await fixture(t, 'node -e "process.exit(0)"');
  const queued = command('artifact.integrate', {artifactId: artifact.id, requireAuthorization: true});
  worker.tick();
  const waiting = store.get<Integration>('integrations', queued.result.integrationId as string)!;
  assert.equal(waiting.status, 'ready_to_apply');
  assert.equal(waiting.authorization, 'waiting');
  assert.equal(waiting.verificationExitCode, 0);
  assert.match(waiting.verificationOutputHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(waiting.verificationEnvironment?.node);
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'original\n');
  const authorized = command('integration.authorize', {integrationId: waiting.id});
  assert.equal(authorized.result.authorization, 'authorized');
  worker.tick();
  assert.equal(store.get<Integration>('integrations', waiting.id)!.status, 'applied');
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'candidate\n');
});

test('argc-argv verification passes without a shell and removes staging after apply', async t => {
  const {root, store, worker, command, artifact} = await fixture(t, {command: 'argv verification', argv: ['node', '-e', 'process.exit(0)']});
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  worker.tick();
  const integration = store.get<Integration>('integrations', queued.result.integrationId as string)!;
  assert.equal(integration.status, 'applied');
  assert.equal(integration.verificationExitCode, 0);
  assert.ok(integration.verificationEnvironment?.npm);
  assert.ok(integration.verificationEnvironment?.git);
  assert.ok(!existsSync(join(root, 'staging', integration.id)));
});

test('verification argv allowlist rejects an unapproved executable before staging', async t => {
  const {project, store, worker, command, artifact} = await fixture(t, {command: 'rejected verification', argv: ['unapproved-tool', '--version']});
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  worker.tick();
  const integration = store.get<Integration>('integrations', queued.result.integrationId as string)!;
  assert.equal(integration.status, 'verification_failed');
  assert.equal(integration.errorCode, 'verification_command_rejected');
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'original\n');
});

test('restart recovery classifies an applying integration from its apply journal', async t => {
  const {root, project, store, service, worker, roomId, command, artifact} = await fixture(t);
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  const journalDir = join(root, 'apply', 'apply_fixture'); mkdirSync(journalDir, {recursive: true});
  writeFileSync(join(journalDir, 'journal.json'), JSON.stringify({state: 'prepared', source: project, changes: []}));
  writeFileSync(join(journalDir, 'complete'), 'applied');
  const integration = {...store.get<Integration>('integrations', queued.result.integrationId as string)!, status: 'applying' as const, updatedAt: new Date().toISOString()};
  writeFileSync(join(project, 'answer.txt'), 'candidate\n');
  store.event(roomId, 'integration.updated', {id: 'system', kind: 'system'}, {integration});
  const restarted = new Worker(store, service, root, {});
  t.after(async () => { await restarted.close(); await worker.close(); });
  const recovered = store.get<Integration>('integrations', integration.id)!;
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.errorCode, undefined);
  assert.equal(store.get<Artifact>('artifacts', artifact.id)!.applied, true);
});

test('unknown integration can be retried by owner and then requires authorization', async t => {
  const {store, project, worker, command, artifact, roomId, service, root} = await fixture(t);
  const queued = command('artifact.integrate', {artifactId: artifact.id});
  const broken = {...store.get<Integration>('integrations', queued.result.integrationId as string)!, status: 'applying' as const, updatedAt: new Date().toISOString()};
  store.event(roomId, 'integration.updated', {id: 'system', kind: 'system'}, {integration: broken});
  const restarted = new Worker(store, service, root, {});
  t.after(async () => { await restarted.close(); await worker.close(); });
  const recovered = store.get<Integration>('integrations', broken.id)!;
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.errorCode, 'restart_unknown');
  const retried = command('integration.reconcile', {integrationId: recovered.id, decision: 'retry', note: 'owner reviewed journal'});
  assert.equal(retried.result.status, 'queued');
  assert.equal(retried.result.authorization, 'waiting');
  worker.tick();
  assert.equal(store.get<Integration>('integrations', recovered.id)!.status, 'ready_to_apply');
  assert.equal(readFileSync(join(project, 'answer.txt'), 'utf8'), 'original\n');
  command('integration.authorize', {integrationId: recovered.id});
  worker.tick();
  assert.equal(store.get<Integration>('integrations', recovered.id)!.status, 'applied');
});

test('applied integration can be rolled back only while source still matches the patch', async t => {
  const first = await fixture(t);
  const queued = first.command('artifact.integrate', {artifactId: first.artifact.id});
  first.worker.tick();
  assert.equal(first.store.get<Integration>('integrations', queued.result.integrationId as string)!.status, 'applied');
  assert.equal(readFileSync(join(first.project, 'answer.txt'), 'utf8'), 'candidate\n');
  const rolled = first.command('integration.rollback', {integrationId: queued.result.integrationId});
  assert.equal(rolled.result.status, 'rolled_back');
  assert.equal(readFileSync(join(first.project, 'answer.txt'), 'utf8'), 'original\n');
  assert.equal(first.store.get<Artifact>('artifacts', first.artifact.id)!.applied, false);
  assert.equal(first.store.events(first.roomId).filter(event => event.type === 'artifact.rolled_back').length, 1);

  const second = await fixture(t);
  const secondQueued = second.command('artifact.integrate', {artifactId: second.artifact.id});
  second.worker.tick();
  writeFileSync(join(second.project, 'answer.txt'), 'user edit\n');
  const conflicted = second.command('integration.rollback', {integrationId: secondQueued.result.integrationId});
  assert.equal(conflicted.result.status, 'blocked');
  assert.equal(conflicted.result.errorCode, 'rollback_conflict');
  assert.equal(readFileSync(join(second.project, 'answer.txt'), 'utf8'), 'user edit\n');
});
