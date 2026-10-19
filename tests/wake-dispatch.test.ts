import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { InboxService } from '../apps/server/src/inbox.ts';
import type { AgentSession, Run, Subscription, WakeIntent } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('a pending subscription wake becomes exactly one queued run and is marked assigned', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'wake-dispatch-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const now = new Date().toISOString();
  const session: AgentSession = {id: 'as_wake', roomId, agentId: 'demo-planner', status: 'active', createdAt: now, updatedAt: now};
  store.event(roomId, 'agent_session.created', SYSTEM, {agentSession: session});
  const startSeq = store.room(roomId)!.seq;
  const subscription: Subscription = {id: 'sub_wake', roomId, agentSessionId: session.id, eventTypes: ['chat.message.created'], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: startSeq};
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'subscription.set', payload: {subscription}});
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'Wake for the session', mentions: ['demo-planner']}});
  new InboxService(store).scan(roomId, session.id);
  const wakes = store.list<WakeIntent>('wake_intents', roomId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].status, 'pending');

  service.dispatchPendingWakes();
  const runs = store.list<Run>('runs', roomId).filter(run => run.agentSessionId === session.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt, 'Wake for the session');
  const assigned = store.list<WakeIntent>('wake_intents', roomId)[0];
  assert.equal(assigned.status, 'assigned');
  assert.equal(assigned.runId, runs[0].id);
  service.dispatchPendingWakes();
  assert.equal(store.list<Run>('runs', roomId).filter(run => run.agentSessionId === session.id).length, 1);
});
