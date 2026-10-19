import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { terminalStates, type Run } from '../packages/protocol/src/index.ts';

function prepare(root: string, enabled: boolean) {
  const path = join(root, 'room.sqlite'), store = new Store(path), service = new RoomService(store);
  const roomId = service.execute({ version: '0.1', commandId: uid(), type: 'room.create', payload: { name: 'restart recovery', members: ['demo-planner'] } }).result.roomId as string;
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...store.settings(), recoverInterruptedChatRuns: enabled } });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: 'recover me', mentions: ['demo-planner'] } });
  const run = store.list<Run>('runs', roomId)[0];
  run.status = 'running'; run.executionId = uid('execution'); run.leaseUntil = new Date(Date.now() + 60_000).toISOString();
  store.event(roomId, 'run.started', SYSTEM, { run });
  store.close();
  return { path, roomId, runId: run.id };
}

test('restart recovery stays disabled by default and requeues only safe sandbox chat runs when enabled', async t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const disabledRoot = mkdtempSync(join(parent, 'recovery-off-'));
  const disabled = prepare(disabledRoot, false);
  const disabledStore = new Store(disabled.path), disabledService = new RoomService(disabledStore);
  let disabledAttempts = 0;
  const disabledWorker = new Worker(disabledStore, disabledService, disabledRoot, { adapter: async function* () { disabledAttempts++; yield { type: 'text', text: 'should not run' }; } });
  disabledWorker.start();
  await new Promise(done => setTimeout(done, 600));
  assert.equal(disabledAttempts, 0);
  assert.equal(disabledStore.get<Run>('runs', disabled.runId)!.status, 'interrupted');
  await disabledWorker.close(); disabledStore.close(); rmSync(disabledRoot, { recursive: true, force: true });

  const enabledRoot = mkdtempSync(join(parent, 'recovery-on-'));
  const enabled = prepare(enabledRoot, true);
  const store = new Store(enabled.path), service = new RoomService(store);
  let attempts = 0;
  const worker = new Worker(store, service, enabledRoot, { adapter: async function* () { attempts++; yield { type: 'text', text: 'recovered reply' }; } });
  t.after(async () => { await worker.close(); store.close(); rmSync(enabledRoot, { recursive: true, force: true }); });
  worker.start();
  const deadline = Date.now() + 15_000;
  let run = store.get<Run>('runs', enabled.runId)!;
  let recovered = store.list<Run>('runs', enabled.roomId).find(item => item.autoRetryOf === enabled.runId);
  while (Date.now() < deadline && (!recovered || !terminalStates.has(recovered.status))) {
    await new Promise(done => setTimeout(done, 50));
    run = store.get<Run>('runs', enabled.runId)!;
    recovered = store.list<Run>('runs', enabled.roomId).find(item => item.autoRetryOf === enabled.runId);
  }
  assert.ok(recovered, 'recovery did not enqueue a new run');
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.equal(recovered.recoveryCount, 1);
  assert.equal(run.recoveryCount, 1);
  assert.equal(attempts, 1);
});
