import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { terminalStates, type Message, type Run } from '../packages/protocol/src/index.ts';

test('a run that reports usage over its frozen token budget fails instead of publishing a result', async t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'budget-worker-'));
  const store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {
    adapter: async function* () {
      yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 40 } };
      yield { type: 'text', text: '这份结果不应被发布' };
    }
  });
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const settings = store.settings();
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...settings, tokenBudget: 100 } });
  worker.start();
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: { text: '预算测试', mentions: ['demo-planner'] } });
  const deadline = Date.now() + 10000;
  let run: Run | undefined;
  while (Date.now() < deadline) {
    run = store.list<Run>('runs', roomId).at(-1);
    if (run && terminalStates.has(run.status)) break;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(run, '没有创建运行');
  assert.equal(run.status, 'failed');
  assert.match(String(run.error), /超出 Token 预算/);
  const agentMessages = store.list<Message>('messages', roomId).filter(message => message.actor.kind === 'agent');
  assert.equal(agentMessages.length, 0, '超预算结果不能被发布为聊天消息');
});
