import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { InboxService } from '../apps/server/src/inbox.ts';
import { shouldWake } from '../apps/server/src/wake-policy.ts';
import type { AgentSession, Discussion, Subscription } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'inbox-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const discussionId = command('discussion.start', {goal: 'Inbox fixture', participants: ['demo-planner'], rounds: 1, maxResponses: 10}).result.discussionId as string;
  const session = store.list<AgentSession>('agent_sessions', roomId).find(item => item.discussionId === discussionId)!;
  const startSeq = store.room(roomId)!.seq;
  const subscription: Subscription = {id: 'subscription_1', roomId, agentSessionId: session.id, eventTypes: ['chat.message.created'], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: startSeq};
  command('subscription.set', {subscription});
  return {root, store, service, roomId, command, session, subscription, startSeq};
}

test('wake policy ignores status/partial/ACK/audit and self messages', () => {
  const session = {id: 'as_1', roomId: 'room_1', agentId: 'demo-planner', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} as AgentSession;
  const subscription = {id: 'sub_1', roomId: 'room_1', agentSessionId: session.id, eventTypes: [], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: 0} as Subscription;
  for (const type of ['typing', 'message.delta', 'ack', 'audit.recorded', 'run.updated', 'presence']) assert.equal(shouldWake({type, eventId: 'e1', seq: 1, payload: {}} as any, session, subscription).wake, false, type);
  assert.equal(shouldWake({type: 'chat.message.created', eventId: 'e1', seq: 1, payload: {message: {actor: {id: session.agentId, kind: 'agent'}, mentions: [session.agentId]}}} as any, session, subscription).wake, false);
  assert.equal(shouldWake({type: 'chat.message.created', eventId: 'e1', seq: 1, payload: {message: {actor: {id: 'owner', kind: 'human'}, mentions: [session.agentId]}}} as any, session, subscription).wake, true);
});

test('subscription scanning creates one delivery and wake intent per matching event, idempotently', t => {
  const {store, service, roomId, session, subscription, startSeq} = fixture(t);
  const inbox = new InboxService(store);
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'Inbox hello', mentions: ['demo-planner']}});
  const first = inbox.scan(roomId, session.id);
  assert.equal(first.matchedEventIds.length, 1);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.wakeIntents.length, 1);
  assert.equal(first.scanSeq, first.throughSeq);
  assert.ok(first.scanSeq <= store.room(roomId)!.seq);
  assert.equal(store.list('inbox_deliveries', roomId).length, 1);
  assert.equal(store.list('wake_intents', roomId).length, 1);
  const again = inbox.scan(roomId, session.id);
  assert.equal(again.deliveries.length, 0);
  // Simulate a replayed cursor: deterministic IDs must prevent duplicate delivery.
  store.put('subscriptions', {...store.get<Subscription>('subscriptions', subscription.id)!, scanSeq: startSeq} as any);
  const replay = inbox.scan(roomId, session.id);
  assert.equal(replay.deliveries.length, 0);
  assert.equal(store.list('inbox_deliveries', roomId).length, 1);
  assert.equal(store.list('wake_intents', roomId).length, 1);
});

test('inbox queue limits roll back the scan and disabled subscriptions do not wake', t => {
  const {store, service, roomId, session, subscription, startSeq} = fixture(t);
  const inbox = new InboxService(store);
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: {...store.settings(), maxInboxDeliveries: 1}});
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'first matching', mentions: ['demo-planner']}});
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'second matching', mentions: ['demo-planner']}});
  assert.throws(() => inbox.scan(roomId, session.id), /收件箱/);
  assert.equal(store.list('inbox_deliveries', roomId).length, 0);
  assert.equal(store.get<Subscription>('subscriptions', subscription.id)!.scanSeq, startSeq);
  const disabled = {...store.get<Subscription>('subscriptions', subscription.id)!, enabled: false, scanSeq: startSeq};
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'subscription.set', payload: {subscription: disabled}});
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'blocked', mentions: ['demo-planner']}});
  const blocked = new InboxService(store).scan(roomId, session.id);
  assert.equal(blocked.blocked, 'subscription_disabled');
  assert.equal(store.list('inbox_deliveries', roomId).length, 0);
});
