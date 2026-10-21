import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {Store, SYSTEM, uid} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import type {AgentDescriptor, Discussion, Run} from '../packages/protocol/src/index.ts';

function fixture(t: TestContext) {
  const parent = resolve('.state/test-data');
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-host-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {adapter: async function* () {
    yield {type: 'text', text: '讨论发言：host 模式不应发布交付物。'};
  }});
  const roomId = store.rooms()[0].id;
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const agent = store.get<AgentDescriptor>('agents', 'demo-planner')!;
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'agent.save', payload: {...agent, executionMode: 'host'}});
  return {store, service, worker, roomId};
}

test('a host-mode discussion response does not fail on the host change artifact path', async t => {
  const {store, service, worker, roomId} = fixture(t);
  const started = service.execute({version: '0.1', commandId: uid(), roomId, type: 'discussion.start', payload: {goal: 'host discussion artifact guard', participants: ['demo-planner'], rounds: 1, maxResponses: 1, quorum: 1, maxDurationMs: 600000}}).result as {discussionId: string};
  const run = store.list<Run>('runs', roomId).find(item => item.discussionId === started.discussionId)!;
  assert.equal(run.discussionRole, undefined);
  run.status = 'running'; run.executionId = uid('execution');
  store.event(roomId, 'run.started', SYSTEM, {run});
  await (worker as any).execute(run, new AbortController());
  const finished = store.get<Run>('runs', run.id)!;
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.error, undefined);
  assert.equal(store.list('artifacts', roomId).filter((artifact: any) => artifact.discussionId === started.discussionId).length, 0);
  const discussion = store.get<Discussion>('discussions', started.discussionId)!;
  assert.equal(discussion.status, 'completed');
});
