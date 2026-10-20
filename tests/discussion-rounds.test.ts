import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { Discussion, DiscussionRound, Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('discussion rounds persist opened and closed lifecycle facts', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-rounds-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}) as any;
  const started = command('discussion.start', {goal: 'Round lifecycle', participants: ['demo-planner', 'demo-reviewer'], rounds: 2, maxResponses: 4, maxDurationMs: 60_000});
  const discussion = store.get<Discussion>('discussions', started.result.discussionId)!;
  const opened = store.list<DiscussionRound>('discussion_rounds', roomId).filter(round => round.discussionId === discussion.id);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].status, 'open');
  assert.equal(opened[0].openedSeq, discussion.startedSeq);
  assert.ok(opened[0].windowDeadline);
  assert.equal(opened[0].quorum, 2);
  command('discussion.stop', {discussionId: discussion.id});
  const closed = store.list<DiscussionRound>('discussion_rounds', roomId).find(round => round.id === opened[0].id)!;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeReason, 'user_stop');
  assert.ok(closed.closedSeq !== undefined && closed.closedAt);
  assert.ok(Array.isArray(closed.settledRunIds));
});

test('late discussion results are recorded against the original round without reopening it', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-late-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}) as any;
  const started = command('discussion.start', {goal: 'Late result', participants: ['demo-planner', 'demo-reviewer'], rounds: 2, maxResponses: 4, maxDurationMs: 60_000});
  const discussion = store.get<Discussion>('discussions', started.result.discussionId)!;
  const queued = store.list<Run>('runs', roomId).find(run => run.discussionId === discussion.id && run.round === 1)!;
  const at = new Date().toISOString();
  store.event(roomId, 'run.started', SYSTEM, {run: {...queued, status: 'running', startedAt: at, updatedAt: at}});
  const running = store.get<Run>('runs', queued.id)!;
  const completed: Run = {...running, status: 'completed', finishedAt: at, updatedAt: at};
  store.event(roomId, 'run.updated', SYSTEM, {run: completed});
  const current = store.get<Discussion>('discussions', discussion.id)!;
  store.event(roomId, 'discussion.round', SYSTEM, {discussion: {...current, round: 2, updatedAt: at}});
  service.settleDiscussion(completed);
  const late = store.events(roomId).find(event => event.type === 'discussion.round.late.received')!;
  assert.equal((late.payload as any).late.runId, completed.id);
  assert.equal((late.payload as any).late.round, 1);
  assert.equal((late.payload as any).round.status, 'late');
  assert.equal(store.get<DiscussionRound>('discussion_rounds', (late.payload as any).round.id)!.status, 'late');
  const before = store.events(roomId).filter(event => event.type === 'discussion.round.late.received').length;
  service.settleDiscussion(completed);
  assert.equal(store.events(roomId).filter(event => event.type === 'discussion.round.late.received').length, before);
});

test('expired round windows trigger settlement without cancelling slow runs', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'discussion-window-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}) as any;
  const started = command('discussion.start', {goal: 'Window expiry', participants: ['demo-planner', 'demo-reviewer'], rounds: 1, maxResponses: 4, maxDurationMs: 60_000});
  const discussion = store.get<Discussion>('discussions', started.result.discussionId)!;
  const at = new Date().toISOString();
  for (const queued of store.list<Run>('runs', roomId).filter(run => run.discussionId === discussion.id && run.round === 1)) {
    store.event(roomId, 'run.started', SYSTEM, {run: {...queued, status: 'running', startedAt: at, updatedAt: at}});
    const running = store.get<Run>('runs', queued.id)!;
    store.event(roomId, 'run.updated', SYSTEM, {run: {...running, status: 'completed', finishedAt: at, updatedAt: at}});
  }
  const round = store.list<DiscussionRound>('discussion_rounds', roomId).find(item => item.discussionId === discussion.id && item.round === 1)!;
  store.event(roomId, 'discussion.round.opened', SYSTEM, {round: {...round, windowDeadline: new Date(Date.now() - 60_000).toISOString()}});
  service.expireDiscussionWindows();
  assert.equal(store.get<Discussion>('discussions', discussion.id)!.status, 'completed');
  const closedRound = store.list<DiscussionRound>('discussion_rounds', roomId).find(item => item.id === round.id)!;
  assert.equal(closedRound.status, 'closed');
  assert.equal(closedRound.settledRunIds?.length, 2);
});
