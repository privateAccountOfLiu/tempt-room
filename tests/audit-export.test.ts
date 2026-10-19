import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';

test('owner can export a room audit trail as NDJSON events', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'audit-'));
  const { app, store } = await createApp({ root, token: 'audit-token', startWorker: false });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { host: '127.0.0.1:4317', authorization: 'Bearer audit-token', 'room-protocol-version': '0.1', 'content-type': 'application/json' };
  const roomId = store.rooms()[0].id;
  const sent = await app.inject({ method: 'POST', url: '/api/commands', headers, payload: { version: '0.1', commandId: 'audit-message', roomId, type: 'message.send', payload: { text: '审计导出测试' } } });
  assert.equal(sent.statusCode, 200);
  const unauthorized = await app.inject({ url: `/api/rooms/${roomId}/audit/export`, headers: { host: headers.host, 'room-protocol-version': '0.1' } });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({ url: `/api/rooms/${roomId}/audit/export`, headers });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /application\/x-ndjson/);
  assert.match(String(response.headers['content-disposition']), new RegExp(roomId));
  const lines = response.body.trim().split('\n');
  assert.ok(lines.length > 0);
  const events = lines.map(line => JSON.parse(line));
  assert.ok(events.every(event => event.roomId === roomId && Number.isInteger(event.seq) && typeof event.type === 'string'));
  assert.ok(events.some(event => event.type === 'chat.message.created'));
});
