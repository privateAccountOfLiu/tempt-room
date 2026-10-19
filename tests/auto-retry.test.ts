import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { terminalStates, type Message, type Run } from '../packages/protocol/src/index.ts';

test('auto retry recreates a transient sandbox chat failure once and then succeeds', async t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'auto-retry-'));
  const store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  let attempts = 0;
  const worker = new Worker(store, service, root, {
    adapter: async function* () {
      attempts++;
      if (attempts === 1) throw new Error('fetch failed');
      yield { type: 'text', text: '自动重试后的成功回复' };
    }
  });
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...store.settings(), autoRetryChatRuns: true, maxAutoRetries: 1 } });
  worker.start();
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: '可能掉线的请求', mentions: ['demo-planner'] } });
  const deadline = Date.now() + 15_000;
  let runs: Run[] = [];
  while (Date.now() < deadline) {
    runs = store.list<Run>('runs', roomId);
    if (runs.length >= 2 && runs.every(run => terminalStates.has(run.status))) break;
    await new Promise(done => setTimeout(done, 30));
  }
  assert.equal(runs.length, 2, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error }))));
  const first = runs.find(run => !run.autoRetryOf)!, retried = runs.find(run => run.autoRetryOf === first.id)!;
  assert.equal(first.status, 'failed');
  assert.match(String(first.error), /fetch failed/);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.autoRetryCount, 1);
  assert.equal(attempts, 2);
  const messages = store.list<Message>('messages', roomId).filter(message => message.actor.kind === 'agent');
  assert.ok(messages.some(message => message.text === '自动重试后的成功回复'));
});
