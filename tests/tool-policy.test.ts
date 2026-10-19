import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';
import { assertRoomToolAllowed } from '../apps/server/src/tool-policy.ts';
import type { AgentDescriptor } from '../packages/protocol/src/index.ts';

test('room tool policy helper allows reads and denies writes deterministically', () => {
  assert.doesNotThrow(() => assertRoomToolAllowed('allow', 'room_post'));
  assert.doesNotThrow(() => assertRoomToolAllowed(undefined, 'room_post'));
  assert.doesNotThrow(() => assertRoomToolAllowed('read-only', 'room_read'));
  assert.doesNotThrow(() => assertRoomToolAllowed('read-only', 'room_status'));
  assert.throws(() => assertRoomToolAllowed('read-only', 'room_post'), /只读/);
  assert.throws(() => assertRoomToolAllowed('deny', 'room_read'), /禁止/);
});

test('external Agent room policy is enforced before the tool command is dispatched', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'tool-policy-'));
  const state = await createApp({ root, token: 'policy-owner', startWorker: false });
  t.after(async () => { await state.app.close(); rmSync(root, { recursive: true, force: true }); });
  const { app, store, service } = state, agentId = 'demo-planner';
  const agent = store.get<AgentDescriptor>('agents', agentId)!;
  service.execute({ version: '0.1', commandId: uid(), type: 'agent.save', payload: { ...agent, enabled: true, connectionMode: 'external', roomToolPolicy: 'read-only' } });
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
  service.execute({ version: '0.1', commandId: uid(), type: 'agent.save', payload: { ...store.get<AgentDescriptor>('agents', agentId)!, roomToolPolicy: 'deny' } });
  const readDenied = await call('room_read');
  assert.equal(readDenied.statusCode, 403);
  assert.equal(readDenied.json().code, 'tool_policy_denied');
});
