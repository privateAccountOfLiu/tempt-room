import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { AgentDescriptor, Discussion, Run } from '../packages/protocol/src/index.ts';

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'quorum-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root);
  t.after(async () => { await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  return { store, service, worker, roomId, cmd };
}
function startRun(store: Store, run: Run) {
  run.status = 'running'; run.executionId = uid('execution');
  store.event(run.roomId, 'run.started', SYSTEM, { run });
  return run;
}

test('discussion quorum advances with completed members and records absent ones', t => {
  const { store, service, worker, roomId, cmd } = setup(t);
  const room = store.room(roomId)!;
  const participants = room.members.filter(id => {
    const agent = store.get<AgentDescriptor>('agents', id);
    return agent?.provider === 'demo' && agent.enabled;
  }).slice(0, 2);
  assert.equal(participants.length, 2);
  const started = cmd('discussion.start', { goal: 'quorum discussion', participants, rounds: 2, maxResponses: 6, maxDurationMs: 600000, quorum: 1 }).result as { discussionId: string };
  const first = store.get<Discussion>('discussions', started.discussionId)!;
  assert.equal(first.quorum, 1);
  const round1 = store.list<Run>('runs', roomId).filter(run => run.discussionId === first.id && run.round === 1);
  assert.equal(round1.length, 2);
  startRun(store, round1[0]); worker.finish(round1[0], 'completed');
  const afterFirst = store.get<Discussion>('discussions', first.id)!;
  assert.equal(afterFirst.status, 'active');
  assert.equal(afterFirst.round, 2);
  assert.equal(afterFirst.absent?.length, 1);
  assert.equal(afterFirst.absent?.[0], round1[1].agentId);
  assert.equal(store.get<Run>('runs', round1[1].id)!.status, 'superseded');
  const round2 = store.list<Run>('runs', roomId).filter(run => run.discussionId === first.id && run.round === 2);
  assert.equal(round2.length, 2);
  startRun(store, round2[0]); worker.finish(round2[0], 'completed');
  const done = store.get<Discussion>('discussions', first.id)!;
  assert.equal(done.status, 'completed');
  assert.equal(store.get<Run>('runs', round2[1].id)!.status, 'superseded');
});

test('discussion rejects unreachable quorum instead of scheduling a stuck round', t => {
  const { store, roomId, cmd } = setup(t);
  const room = store.room(roomId)!;
  const participants = room.members.filter(id => store.get<AgentDescriptor>('agents', id)?.provider === 'demo').slice(0, 2);
  assert.throws(() => cmd('discussion.start', { goal: 'too much quorum', participants, rounds: 2, maxResponses: 4, maxDurationMs: 600000, quorum: 3 }), /quorum/);
  assert.throws(() => cmd('discussion.start', { goal: 'too few responses', participants, rounds: 2, maxResponses: 1, maxDurationMs: 600000, quorum: 2 }), /quorum/);
  assert.equal(store.list<Discussion>('discussions', roomId).length, 0);
});
