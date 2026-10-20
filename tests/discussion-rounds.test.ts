import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { Discussion, DiscussionRound } from '../packages/protocol/src/index.ts';

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
});
