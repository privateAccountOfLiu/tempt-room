import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { dependencyRequirementsReady } from '../apps/server/src/dependencies.ts';
import type { Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data'), hash = 'a'.repeat(64);
const contract = (objective: string, dependencies: unknown[] = []) => ({
  objective,
  projectBinding: {id: 'binding_acceptance', version: 1, baselineRef: 'baseline_1', manifestHash: hash, allowedPaths: ['src/**']},
  acceptance: [{id: 'unit', description: 'unit checks pass', command: 'npm test', verifierVersion: '1.0.0', verifierHash: hash}],
  expectedArtifacts: [], dependencies, authorizedExecutor: {agentId: 'demo-planner'}, limits: {activationLimit: 2}, failureHandling: 'isolate_branch', collaborationBoundary: {canModifyInterfaces: false}
});
function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'task-acceptance-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'completed candidate'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {store, service, worker, roomId, command};
}
async function tickUntil(worker: Worker, store: Store, check: () => boolean, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !check()) { worker.tick(); await new Promise(done => setTimeout(done, 25)); }
}

test('dependency requirements distinguish execution, accepted artifact and integrated', () => {
  const base = {id: 'upstream', roomId: 'room_1', title: 'up', agentId: 'demo-planner', projectPath: '', version: 1, status: 'completed', dependencies: [], createdAt: new Date().toISOString(), acceptanceStatus: 'pending'} as Task;
  const downstream = {...base, id: 'downstream', dependencyRequirements: [{taskId: 'upstream', taskVersion: 1, requirement: 'accepted_artifact'}]} as Task;
  assert.equal(dependencyRequirementsReady(downstream, [base]).ready, false);
  assert.equal(dependencyRequirementsReady(downstream, [{...base, acceptanceStatus: 'accepted'}]).ready, true);
  assert.equal(dependencyRequirementsReady({...downstream, dependencyRequirements: [{taskId: 'upstream', taskVersion: 1, requirement: 'execution'}]} as Task, [base]).ready, true);
  assert.equal(dependencyRequirementsReady({...downstream, dependencyRequirements: [{taskId: 'upstream', taskVersion: 1, requirement: 'integrated'}]} as Task, [base]).ready, false);
  assert.equal(dependencyRequirementsReady({...downstream, dependencyRequirements: undefined} as Task, []).ready, true);
});

test('completed execution does not unlock accepted-artifact dependents until owner records verification', async t => {
  const {store, worker, roomId, command} = fixture(t);
  const upstreamId = command('task.create', {title: 'Upstream strict task', agentId: 'demo-planner', contract: contract('upstream')}).result.taskId as string;
  const downstreamContract = contract('downstream', [{taskId: upstreamId, condition: 'accepted_artifact', taskVersion: 1}]);
  const downstreamId = command('task.create', {title: 'Downstream strict task', agentId: 'demo-planner', contract: downstreamContract}).result.taskId as string;
  const upstream = store.get<Task>('tasks', upstreamId)!, downstream = store.get<Task>('tasks', downstreamId)!;
  assert.equal(upstream.strict, true);
  assert.equal(upstream.acceptanceStatus, 'pending');
  assert.deepEqual(downstream.dependencyRequirements, [{taskId: upstreamId, taskVersion: 1, requirement: 'accepted_artifact'}]);
  await tickUntil(worker, store, () => store.get<Run>('runs', store.list<Run>('runs', roomId).find(run => run.taskId === upstreamId)!.id)!.status === 'completed');
  assert.equal(store.get<Task>('tasks', upstreamId)!.acceptanceStatus, 'pending');
  const downstreamRun = store.list<Run>('runs', roomId).find(run => run.taskId === downstreamId)!;
  assert.equal(downstreamRun.status, 'queued', 'completed-but-unaccepted upstream must not dispatch dependent');
  const verification = command('task.verification.record', {taskId: upstreamId, taskVersion: 1, outcome: 'accepted', verificationId: 'verification_1', artifactIds: [], artifactHashes: {}, commandRef: 'npm test', exitCode: 0, outputHash: hash, reason: 'owner verified'});
  assert.equal(verification.result.acceptanceStatus, 'accepted');
  await tickUntil(worker, store, () => store.get<Run>('runs', downstreamRun.id)!.status === 'completed');
  assert.equal(store.get<Run>('runs', downstreamRun.id)!.status, 'completed');
  command('task.verification.record', {taskId: downstreamId, taskVersion: 1, outcome: 'accepted', verificationId: 'verification_downstream', artifactIds: [], artifactHashes: {}, commandRef: 'npm test', exitCode: 0, outputHash: hash, reason: 'owner verified downstream'});
  assert.equal(store.get<Task>('tasks', downstreamId)!.acceptanceStatus, 'accepted');
  command('task.revise', {taskId: upstreamId, title: 'Upstream revised'});
  assert.equal(store.get<Task>('tasks', upstreamId)!.acceptanceStatus, 'pending');
  const invalidatedDownstream = store.get<Task>('tasks', downstreamId)!;
  assert.equal(invalidatedDownstream.version, 2);
  assert.equal(invalidatedDownstream.acceptanceStatus, 'pending');
  assert.equal(store.get<Task>('tasks', upstreamId)!.verificationHistory?.length, 1);
});

test('verification history retains rejected and accepted records with timestamps', t => {
  const {store, roomId, command} = fixture(t);
  const taskId = command('task.create', {title: 'History task', agentId: 'demo-planner', contract: contract('history task')}).result.taskId as string;
  command('task.verification.record', {taskId, taskVersion: 1, outcome: 'rejected', verificationId: 'verification_rejected', artifactIds: [], artifactHashes: {}, reason: 'failed review'});
  command('task.verification.record', {taskId, taskVersion: 1, outcome: 'accepted', verificationId: 'verification_accepted', artifactIds: [], artifactHashes: {}, reason: 'passed review'});
  const task = store.get<Task>('tasks', taskId)!;
  assert.equal(task.verificationHistory?.length, 2);
  assert.deepEqual(task.verificationHistory?.map(record => record.outcome), ['rejected', 'accepted']);
  assert.ok(task.verificationHistory?.every(record => record.recordedAt));
  assert.equal(task.lastVerification?.verificationId, 'verification_accepted');
  assert.equal(store.events(roomId).filter(event => event.type === 'task.verification.recorded').length, 2);
});
