import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';

const parent = resolve('.state/test-data');
test('owner can export one room as events and metadata', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-export-'));
  const {app, store, service} = await createApp({root, startWorker: false, token: 'export-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'export me'}});
  const headers = {host: '127.0.0.1:4317', authorization: 'Bearer export-owner', 'room-protocol-version': '0.1'};
  const exported = await app.inject({url: `/api/rooms/${roomId}/export`, headers});
  assert.equal(exported.statusCode, 200);
  const body = exported.json() as {version: string; room: {id: string}; events: {type: string}[]};
  assert.equal(body.room.id, roomId);
  assert.ok(body.events.some(event => event.type === 'chat.message.created'));
  assert.equal((await app.inject({url: `/api/rooms/${roomId}/export`, headers: {host: headers.host, 'room-protocol-version': '0.1'}})).statusCode, 401);
});
