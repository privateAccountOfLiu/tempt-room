import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { AgentSession, Discussion, Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function base(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-lifecycle-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const start = (extra: Record<string, unknown> = {}) => command('discussion.start', {goal: 'Lifecycle test', participants: ['demo-planner', 'demo-reviewer'], rounds: 2, maxResponses: 10, ...extra}).result.discussionId as string;
  return {root, store, service, roomId, command, start};
}

test('discussion start creates AgentSessions and unique response slots', t => {
  const {store, roomId, start} = base(t);
  const id = start();
  const discussion = store.get<Discussion>('discussions', id)!;
  const sessions = store.list<AgentSession>('agent_sessions', roomId);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(session => session.discussionId === id && session.status === 'active'));
  const runs = store.list<Run>('runs', roomId).filter(run => run.discussionId === id);
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map(run => run.responseSlotId)).size, 2);
  assert.equal(discussion.activationsUsed, 2);
});

test('pause persists across restart, freezes settlement, and blocks dispatch until resume', async t => {
  const root = mkdtempSync(join(parent, 'discussion-pause-'));
  const first = new Store(join(root, 'room.sqlite')), firstService = new RoomService(first), roomId = first.rooms()[0].id;
  const start = firstService.execute({version: '0.1', commandId: uid(), roomId, type: 'discussion.start', payload: {goal: 'Pause me', participants: ['demo-planner', 'demo-reviewer'], rounds: 2, maxResponses: 10}});
  const discussionId = start.result.discussionId as string;
  const paused = firstService.execute({version: '0.1', commandId: uid(), roomId, type: 'discussion.pause', payload: {discussionId}});
  assert.equal(paused.result.status, 'paused');
  const firstRun = first.list<Run>('runs', roomId).find(run => run.discussionId === discussionId)!;
  first.atomic(() => {firstRun.status = 'running'; firstRun.executionId = uid('exec'); first.event(roomId, 'run.started', SYSTEM, {run: firstRun}); firstRun.status = 'completed'; first.event(roomId, 'run.updated', SYSTEM, {run: firstRun});});
  firstService.settleDiscussion(firstRun);
  assert.equal(first.get<Discussion>('discussions', discussionId)!.status, 'paused');
  first.close();

  const store = new Store(join(root, 'room.sqlite')), service = new RoomService(store);
  let attempted = 0;
  const worker = new Worker(store, service, root, {adapter: async function* () { attempted++; yield {type: 'text', text: 'should not start'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const reopened = store.get<Discussion>('discussions', discussionId)!;
  assert.equal(reopened.status, 'paused');
  assert.ok(store.list<AgentSession>('agent_sessions', roomId).every(session => session.status === 'paused'));
  worker.start();
  await new Promise(done => setTimeout(done, 350));
  assert.equal(attempted, 0);
  assert.ok(store.list<Run>('runs', roomId).filter(run => run.discussionId === discussionId && run.discussionRole !== 'summary').every(run => run.status !== 'running'));
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'discussion.resume', payload: {discussionId}});
  assert.equal(store.get<Discussion>('discussions', discussionId)!.status, 'active');
  assert.ok(store.list<AgentSession>('agent_sessions', roomId).every(session => session.status === 'active'));
});

test('activation limit ends the discussion before exceeding its budget', t => {
  const {store, roomId, start} = base(t);
  const id = start({participants: ['demo-planner', 'demo-reviewer'], activationLimit: 1, maxResponses: 10});
  const discussion = store.get<Discussion>('discussions', id)!;
  assert.equal(discussion.status, 'stopped');
  assert.equal(discussion.endReason, 'activation_limit');
  assert.equal(discussion.activationsUsed, 1);
  assert.equal(store.list<Run>('runs', roomId).filter(run => run.discussionId === id).length, 1);
});

test('additional context input consumes activation budget and stops the discussion', t => {
  const {store, service, roomId, start} = base(t);
  const id = start({participants: ['demo-planner'], activationLimit: 2, rounds: 3, maxResponses: 10});
  const discussion = store.get<Discussion>('discussions', id)!;
  assert.equal(discussion.activationsUsed, 1);
  const run = {id: 'run_context', roomId, agentId: 'demo-planner', discussionId: id, status: 'running', prompt: '', basedOnSeq: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} as Run;
  service.recordDiscussionContinuation(run);
  assert.equal(store.get<Discussion>('discussions', id)!.activationsUsed, 2);
  service.recordDiscussionContinuation(run);
  const stopped = store.get<Discussion>('discussions', id)!;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.endReason, 'activation_limit');
});

test('summary has an independent activation budget', t => {
  const {store, service, roomId, start, command} = base(t);
  const id = start({participants: ['demo-planner'], rounds: 1, maxResponses: 2, summarizerId: 'demo-reviewer', summaryActivationLimit: 1});
  service.stopDiscussion(store.get<Discussion>('discussions', id)!, '用户停止');
  const discussion = store.get<Discussion>('discussions', id)!;
  assert.equal(discussion.summary?.status, 'queued');
  assert.equal(discussion.summaryActivationsUsed, 1);
  const summaryRun = store.list<Run>('runs', roomId).find(run => run.discussionId === id && run.discussionRole === 'summary')!;
  assert.ok(summaryRun);
  const continued = service.recordDiscussionContinuation({...summaryRun, discussionRole: 'summary'} as Run);
  assert.equal(continued, false);
  const exhausted = store.get<Discussion>('discussions', id)!;
  assert.equal(exhausted.summary?.status, 'failed');
  assert.match(exhausted.summary?.error ?? '', /总结激活额度/);
  assert.equal(exhausted.summaryActivationsUsed, 2);
  const another = start({participants: ['demo-planner'], rounds: 1, maxResponses: 2, summarizerId: 'demo-reviewer', summaryActivationLimit: 1});
  assert.notEqual(another, id);
});
