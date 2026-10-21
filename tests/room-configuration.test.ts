import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { capabilitiesFor } from '../packages/protocol/src/index.ts';
import type { AgentDescriptor, Room, Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-configuration-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown, actor: {id: string; kind: 'human' | 'agent'} = {id: 'owner', kind: 'human'}) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}, actor);
  return {store, service, roomId, command};
}
type Ctx = ReturnType<typeof fixture>;

function addAgent(ctx: Ctx, id = 'demo-extra') {
  const agent = {
    id, name: 'Extra demo', provider: 'demo', role: 'fixture member', color: 'purple',
    executable: '', endpoint: '', model: '', credentialEnv: '', version: '', runtimeDirectory: '',
    executionMode: 'sandbox', responseFormat: 'text', connectionMode: 'managed', enabled: false,
    capabilities: capabilitiesFor('demo')
  } as unknown as AgentDescriptor;
  ctx.command('agent.save', agent);
  return agent;
}

test('configure saves name, description and added members in one event; unknown member rolls back everything', t => {
  const ctx = fixture(t);
  addAgent(ctx);
  const before = ctx.store.room(ctx.roomId)!;
  const result = ctx.command('room.configure', {name: 'Renamed room', description: 'new description', members: [...before.members, 'demo-extra'], expectedRevision: 1});
  assert.equal(result.result.changed, true);
  assert.equal(result.result.revision, 2);
  const room = ctx.store.room(ctx.roomId)!;
  assert.equal(room.name, 'Renamed room');
  assert.equal(room.description, 'new description');
  assert.ok(room.members.includes('demo-extra'));
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'room.configured').length, 1);
  const configuredEvent = ctx.store.events(ctx.roomId).find(event => event.type === 'room.configured')!;
  assert.deepEqual((configuredEvent.payload as any).addedMemberIds, ['demo-extra']);
  assert.deepEqual((configuredEvent.payload as any).removedMemberIds, []);

  assert.throws(() => ctx.command('room.configure', {name: 'Should not stick', description: 'x', members: [...room.members, 'ghost-agent'], expectedRevision: 2}), /成员不存在/);
  const after = ctx.store.room(ctx.roomId)!;
  assert.equal(after.name, room.name);
  assert.equal(after.revision, 2);
  assert.ok(!after.members.includes('ghost-agent'));
});

test('revision conflicts are explicit; chat activity does not create false conflicts', t => {
  const ctx = fixture(t);
  const first = ctx.command('room.configure', {name: 'Window A', description: '', members: ctx.store.room(ctx.roomId)!.members, expectedRevision: 1});
  assert.equal((first.result as any).revision, 2);
  assert.throws(() => ctx.command('room.configure', {name: 'Window B', description: '', members: ctx.store.room(ctx.roomId)!.members, expectedRevision: 1}), /房间设置已被其他窗口修改/);
  ctx.command('message.send', {text: 'chat advances seq only'});
  const afterChat = ctx.store.room(ctx.roomId)!;
  assert.equal(afterChat.revision, 2, 'message seq must not change settings revision');
  const second = ctx.command('room.configure', {name: 'Window B now', description: '', members: afterChat.members, expectedRevision: 2});
  assert.equal((second.result as any).revision, 3);
});

test('member list is deduplicated, no-op saves do not append events, and an empty room is savable', t => {
  const ctx = fixture(t);
  addAgent(ctx);
  const current = ctx.store.room(ctx.roomId)!;
  const configured = ctx.command('room.configure', {name: current.name, description: current.description, members: [...current.members, 'demo-extra', 'demo-extra'], expectedRevision: 1});
  assert.equal((configured.result as any).revision, 2);
  const room = ctx.store.room(ctx.roomId)!;
  assert.equal(room.members.filter(member => member === 'demo-extra').length, 1);
  const eventCount = ctx.store.events(ctx.roomId).length;
  const noop = ctx.command('room.configure', {name: room.name, description: room.description, members: room.members, expectedRevision: 2});
  assert.equal((noop.result as any).changed, false);
  assert.equal((noop.result as any).revision, 2);
  assert.equal(ctx.store.events(ctx.roomId).length, eventCount, 'no-op configure must not append an event');
  const empty = ctx.command('room.configure', {name: 'Empty room', description: '', members: [], expectedRevision: 2});
  assert.equal((empty.result as any).revision, 3);
  assert.deepEqual(ctx.store.room(ctx.roomId)!.members, []);
});

test('removing a busy member fails the whole update; removing an idle member ends its session', t => {
  const ctx = fixture(t);
  ctx.command('task.create', {title: 'Busy planner task', agentId: 'demo-planner'});
  const before = ctx.store.room(ctx.roomId)!;
  assert.equal(ctx.store.list<Run>('runs', ctx.roomId).length, 1);
  assert.throws(() => ctx.command('room.configure', {name: 'Must not stick', description: 'x', members: before.members.filter(member => member !== 'demo-planner'), expectedRevision: 1}), (error: any) => error.code === 'member_busy');
  assert.equal(ctx.store.room(ctx.roomId)!.name, before.name);
  assert.equal(ctx.store.room(ctx.roomId)!.revision, 1);

  ctx.store.event(ctx.roomId, 'agent_session.created', SYSTEM, {agentSession: {id: 'session_reviewer', roomId: ctx.roomId, agentId: 'demo-reviewer', status: 'active', createdAt: now(), updatedAt: now()}});
  ctx.store.event(ctx.roomId, 'subscription.updated', SYSTEM, {subscription: {id: 'subscription_reviewer', roomId: ctx.roomId, agentSessionId: 'session_reviewer', eventTypes: [], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: 0}});
  const removed = ctx.command('room.configure', {name: before.name, description: before.description, members: before.members.filter(member => member !== 'demo-reviewer'), expectedRevision: 1});
  assert.equal((removed.result as any).revision, 2);
  assert.equal((ctx.store.get<any>('agent_sessions', 'session_reviewer')!).status, 'ended');
  assert.equal((ctx.store.get<any>('subscriptions', 'subscription_reviewer')!).enabled, false);
  assert.throws(() => ctx.command('message.send', {text: 'removed member still here?'}, {id: 'demo-reviewer', kind: 'agent'}), /不是该房间的成员/);
  ctx.command('message.send', {text: 'remaining member can still talk', mentions: []}, {id: 'demo-planner', kind: 'agent'});
});

test('adding a member does not enqueue work; rebuild reproduces the configured room', t => {
  const ctx = fixture(t);
  addAgent(ctx);
  const before = ctx.store.room(ctx.roomId)!;
  const runsBefore = ctx.store.list<Run>('runs', ctx.roomId).length;
  ctx.command('room.configure', {name: 'Rebuild check', description: 'after', members: [...before.members, 'demo-extra'], expectedRevision: 1});
  assert.equal(ctx.store.list<Run>('runs', ctx.roomId).length, runsBefore, 'adding a member must not spend model runs');
  const current = ctx.store.room(ctx.roomId)!;
  const eventCount = ctx.store.events(ctx.roomId).length;
  const result = ctx.store.rebuildProjections(ctx.roomId);
  assert.ok(result.replayedEvents > 0);
  assert.equal(ctx.store.events(ctx.roomId).length, eventCount);
  const rebuilt = ctx.store.room(ctx.roomId)!;
  assert.equal(rebuilt.name, 'Rebuild check');
  assert.equal(rebuilt.description, 'after');
  assert.equal(rebuilt.revision, current.revision);
  assert.deepEqual(rebuilt.members, current.members);
});
