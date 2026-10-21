import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {Store, uid} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import type {Run} from '../packages/protocol/src/index.ts';

test('discussion responses get the longer discussion timeout while chat keeps the chat timeout', async t => {
  const parent = resolve('.state/test-data');
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-timeout-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root);
  const roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  command('settings.update', {...store.settings(), chatTimeoutMs: 300_000, discussionTimeoutMs: 1_800_000});
  const started = command('discussion.start', {goal: 'timeout budget', participants: ['demo-planner'], rounds: 1, maxResponses: 1, quorum: 1, maxDurationMs: 3_600_000}).result as {discussionId: string};
  const discussionRun = store.list<Run>('runs', roomId).find(run => run.discussionId === started.discussionId)!;
  assert.equal(discussionRun.limits?.timeoutMs, 1_800_000);
  const chat = service.enqueue(roomId, 'demo-planner', 'ordinary chat', store.room(roomId)!.seq);
  assert.equal(store.get<Run>('runs', chat.id)!.limits?.timeoutMs, 300_000);
});
