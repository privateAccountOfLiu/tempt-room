import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { terminalStates, type Message, type Run } from '../packages/protocol/src/index.ts';

test('timeout keeps the persisted partial draft and never publishes it as a final reply', async t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'timeout-'));
  const store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {
    adapter: async function* (ctx) {
      yield { type: 'text', text: '超时前的持久草稿' };
      await new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) { reject(ctx.signal.reason); return; }
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    }
  });
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...store.settings(), chatTimeoutMs: 1000 } });
  worker.start();
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: '请开始可能超时的工作', mentions: ['demo-planner'] } });
  const deadline = Date.now() + 10_000;
  let run: Run | undefined;
  while (Date.now() < deadline) {
    run = store.list<Run>('runs', roomId).at(-1);
    if (run && terminalStates.has(run.status)) break;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(run, '没有创建运行');
  assert.equal(run.status, 'canceled');
  assert.match(String(run.error), /时间上限/);
  assert.match(String(run.partial?.text), /超时前的持久草稿/);
  const agentMessages = store.list<Message>('messages', roomId).filter(message => message.actor.kind === 'agent');
  assert.equal(agentMessages.length, 0);
});
