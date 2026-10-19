import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { trustForActor } from '../apps/server/src/trust.ts';
import { messageSchema, type AgentDescriptor, type Message } from '../packages/protocol/src/index.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'trust-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, actor?: { id: string; kind: 'agent' | 'human' }, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload }, actor as never);
  return { store, service, roomId, cmd };
}

test('owner, managed and external agent messages carry their source trust', t => {
  const { store, cmd } = setup(t), roomId = store.rooms()[0].id;
  cmd('message.send', { text: 'owner message' });
  assert.equal(store.list<Message>('messages', roomId).at(-1)!.trust, 'owner');
  cmd('message.send', { text: 'managed message' }, { id: 'demo-planner', kind: 'agent' });
  assert.equal(store.list<Message>('messages', roomId).at(-1)!.trust, 'managed');
  const codex = store.get<AgentDescriptor>('agents', 'codex')!;
  cmd('agent.save', { ...codex, enabled: true, connectionMode: 'external' });
  cmd('message.send', { text: 'external message', mentions: [] }, { id: 'codex', kind: 'agent' });
  assert.equal(store.list<Message>('messages', roomId).at(-1)!.trust, 'external');
});

test('remote A2A trust is derived from the Agent provider and schema accepts all trust values', () => {
  const remoteStore = { get: () => ({ provider: 'a2a' }) };
  assert.equal(trustForActor(remoteStore as never, { id: 'remote', kind: 'agent' }), 'remote');
  assert.equal(trustForActor(remoteStore as never, { id: 'owner', kind: 'human' }), 'owner');
  const base = { id: 'm', roomId: 'r', actor: { id: 'a', kind: 'agent' as const }, text: 'x', mentions: [], attachments: [], createdAt: new Date().toISOString() };
  for (const trust of ['owner', 'managed', 'external', 'remote'] as const) assert.equal(messageSchema.parse({ ...base, trust }).trust, trust);
  assert.equal(messageSchema.parse(base).trust, undefined);
});
