import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';
import { assertRoomPostLength, assertRoomToolAllowed } from '../apps/server/src/tool-policy.ts';
import type { AgentDescriptor } from '../packages/protocol/src/index.ts';

test('room tool policy helper allows reads and denies writes deterministically', () => {
  assert.doesNotThrow(() => assertRoomToolAllowed('allow', 'room_post'));
  assert.doesNotThrow(() => assertRoomToolAllowed(undefined, 'room_post'));
  assert.doesNotThrow(() => assertRoomToolAllowed('read-only', 'room_read'));
  assert.doesNotThrow(() => assertRoomToolAllowed('read-only', 'room_status'));
  assert.throws(() => assertRoomToolAllowed('read-only', 'room_post'), /只读/);
  assert.throws(() => assertRoomToolAllowed('deny', 'room_read'), /禁止/);
  assert.doesNotThrow(() => assertRoomToolAllowed('allow', 'room_read', ['room_read']));
  assert.throws(() => assertRoomToolAllowed('allow', 'room_post', ['room_read']), /未被允许/);
  assert.doesNotThrow(() => assertRoomPostLength({ maxRoomPostChars: 4 }, 'abcd'));
  assert.throws(() => assertRoomPostLength({ maxRoomPostChars: 4 }, 'abcde'), /单条发言超过/);
  assert.doesNotThrow(() => assertRoomPostLength(undefined, 'x'.repeat(32000)));
});

test('per-agent tool allowlist narrows the allowed tool surface', () => {
  assert.doesNotThrow(() => assertRoomToolAllowed('allow', 'room_read', ['room_read', 'room_post']));
  assert.throws(() => assertRoomToolAllowed('allow', 'task_claim', ['room_read', 'room_post']), /未被允许使用此房间工具/);
  assert.throws(() => assertRoomToolAllowed('read-only', 'room_post', ['room_read', 'room_post']), /只读/);
});

test('external Agent post length cap rejects oversized posts before mutation', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'post-cap-'));
  const state = await createApp({ root, token: 'postcap-owner', startWorker: false });
  t.after(async () => { await state.app.close(); rmSync(root, { recursive: true, force: true }); });
  const { app, store, service } = state, agentId = 'demo-planner';
  const agent = store.get<AgentDescriptor>('agents', agentId)!;
  service.execute({ version: '0.1', commandId: uid(), type: 'agent.save', payload: { ...agent, enabled: true, connectionMode: 'external', maxRoomPostChars: 5 } });
  const roomId = service.execute({ version: '0.1', commandId: uid(), type: 'room.create', payload: { name: 'post cap', members: [agentId] } }).result.roomId as string;
  const ownerHeaders = { host: '127.0.0.1:4317', authorization: 'Bearer postcap-owner', 'room-protocol-version': '0.1' };
  const connected = await app.inject({ url: `/api/agents/${agentId}/connect?roomId=${roomId}`, headers: ownerHeaders });
  assert.equal(connected.statusCode, 200);
  const headers = { ...ownerHeaders, authorization: 'Bearer ' + connected.json().token };
  const call = (name: string, args: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/agent/tool', headers, payload: { roomId, commandId: uid(), name, arguments: args } });
  const tooLong = await call('room_post', { text: '123456' });
  assert.equal(tooLong.statusCode, 403);
  assert.equal(tooLong.json().code, 'tool_policy_denied');
  assert.equal((await call('room_post', { text: 'ok' })).statusCode, 200);
  assert.equal(store.list<{ text: string }>('messages', roomId).filter(message => message.text === 'ok').length, 1);
});

test('external Agent room policy is enforced before the tool command is dispatched', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'tool-policy-'));
  const state = await createApp({ root, token: 'policy-owner', startWorker: false });
  t.after(async () => { await state.app.close(); rmSync(root, { recursive: true, force: true }); });
  const { app, store, service } = state, agentId = 'demo-planner';
  const agent = store.get<AgentDescriptor>('agents', agentId)!;
  service.execute({ version: '0.1', commandId: uid(), type: 'agent.save', payload: { ...agent, enabled: true, connectionMode: 'external', roomToolPolicy: 'allow', allowedRoomTools: ['room_read'] } });
  const roomId = service.execute({ version: '0.1', commandId: uid(), type: 'room.create', payload: { name: 'policy room', members: [agentId] } }).result.roomId as string;
  const ownerHeaders = { host: '127.0.0.1:4317', authorization: 'Bearer policy-owner', 'room-protocol-version': '0.1' };
  const connected = await app.inject({ url: `/api/agents/${agentId}/connect?roomId=${roomId}`, headers: ownerHeaders });
  assert.equal(connected.statusCode, 200);
  const headers = { ...ownerHeaders, authorization: 'Bearer ' + connected.json().token };
  const call = (name: string, args: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/agent/tool', headers, payload: { roomId, commandId: uid(), name, arguments: args } });
  assert.equal((await call('room_read')).statusCode, 200);
  const denied = await call('room_post', { text: 'policy denied' });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'tool_policy_denied');
  assert.match(denied.json().message, /未被允许/);
  service.execute({ version: '0.1', commandId: uid(), type: 'agent.save', payload: { ...store.get<AgentDescriptor>('agents', agentId)!, roomToolPolicy: 'deny' } });
  const readDenied = await call('room_read');
  assert.equal(readDenied.statusCode, 403);
  assert.equal(readDenied.json().code, 'tool_policy_denied');
});
