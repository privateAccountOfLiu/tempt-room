import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { defaultSandbox, type Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('sandbox job-empty exit evidence becomes a durable cleanup proof', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'cleanup-proof-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }}), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const taskId = (service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Cleanup proof', agentId: 'demo-planner'}}).result as any).taskId as string;
  const queued = store.list<Run>('runs', roomId).find(run => run.taskId === taskId)!;
  const at = new Date().toISOString();
  const running: Run = {...queued, status: 'running', generation: 1, executionId: 'exec_cleanup', startedAt: at, updatedAt: at, sandbox: {...defaultSandbox, verifiedAt: at}};
  store.event(roomId, 'run.started', SYSTEM, {run: running});
  (worker as any).executions.set(queued.id, {runId: queued.id, roomId, agentId: 'demo-planner', generation: 1, executionId: 'exec_cleanup'});
  (worker as any).host.emit('notification', {type: 'sandbox.exit', runId: queued.id, jobEmpty: true, exitCode: 0});
  const proof = store.get<Run>('runs', queued.id)!.cleanupProof;
  assert.equal(proof?.remainingProcesses, 0);
  assert.equal(proof?.evidence, 'appcontainer-job-empty');
  assert.equal(proof?.exitCode, 0);
  assert.ok(proof?.checkedAt);
});

test('demo adapters record a no-local-process-tree cleanup proof on completion', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'cleanup-proof-demo-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'done'}; }}), roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const taskId = (service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Cleanup demo', agentId: 'demo-planner'}}).result as any).taskId as string;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    worker.tick();
    const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId);
    if (run && ['completed', 'failed', 'canceled'].includes(run.status)) break;
    await new Promise(done => setTimeout(done, 25));
  }
  const run = store.list<Run>('runs', roomId).find(item => item.taskId === taskId)!;
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.cleanupProof?.remainingProcesses, 0);
  assert.equal(run.cleanupProof?.evidence, 'adapter-has-no-local-process-tree');
});
