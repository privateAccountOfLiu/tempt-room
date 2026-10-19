import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { SYSTEM } from '../apps/server/src/store.ts';

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

test('audit export covers every page and freezes the captured watermark', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'audit-pages-'));
  const { app, store } = await createApp({ root, token: 'audit-pages-token', startWorker: false });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { host: '127.0.0.1:4317', authorization: 'Bearer audit-pages-token', 'room-protocol-version': '0.1', 'content-type': 'application/json' };
  const roomId = store.rooms()[0].id;
  const addEvents = (count: number) => { for (let index = 0; index < count; index++) store.event(roomId, 'audit.recorded', SYSTEM, { action: `fill:${index}` }); };
  for (const count of [0, 500, 501, 2501]) {
    addEvents(count);
    const head = store.room(roomId)!.seq;
    const response = await app.inject({ url: `/api/rooms/${roomId}/audit/export`, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-audit-through-seq'], String(head));
    const lines = response.body.trim() ? response.body.trim().split('\n') : [];
    assert.equal(lines.length, head, `expected ${head} events after adding ${count}`);
    const seqs = lines.map(line => JSON.parse(line).seq);
    assert.deepEqual(seqs, Array.from({length: seqs.length}, (_, index) => index + 1));
  }
  assert.equal((await app.inject({ url: `/api/rooms/${roomId}/audit/export`, headers: {host: headers.host, 'room-protocol-version': '0.1', authorization: 'Bearer not-an-agent-token'} })).statusCode, 401);
});

test('event scan stays pinned to its watermark while later events are appended', async t => {
  const base = resolve('.state/test-data'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'audit-watermark-'));
  const { app, store } = await createApp({ root, token: 'audit-watermark-token', startWorker: false });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const roomId = store.rooms()[0].id;
  for (let index = 0; index < 1201; index++) store.event(roomId, 'audit.recorded', SYSTEM, { action: `scan:${index}` });
  const watermark = store.room(roomId)!.seq;
  const before = [...store.scanEvents(roomId, {throughSeq: watermark, pageSize: 100})];
  store.event(roomId, 'audit.recorded', SYSTEM, { action: 'later' });
  const after = [...store.scanEvents(roomId, {afterSeq: watermark, throughSeq: store.room(roomId)!.seq, pageSize: 100})];
  assert.equal(before.length, watermark);
  assert.equal(before.at(-1)!.seq, watermark);
  assert.equal(after.length, 1);
  assert.equal(after[0].seq, watermark + 1);
});
