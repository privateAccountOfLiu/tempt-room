import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { Store, SYSTEM, uid, now } from '../apps/server/src/store.ts';
import { RoomClient } from '../packages/client/src/index.ts';
import type { Artifact, Integration, Room } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

async function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-api-'));
  const token = 'room-api-owner';
  const {app, store, service, worker} = await createApp({root, token, startWorker: false});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const headers = {authorization: `Bearer ${token}`, 'room-protocol-version': '0.1'};
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {root, app, store, service, worker, token, roomId, headers, command};
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function makeDeleting(ctx: Ctx) {
  const integration: Integration = {id: uid('integration'), roomId: ctx.roomId, artifactId: uid('artifact'), status: 'applying', authorization: 'auto', requestActor: 'owner', createdAt: now(), updatedAt: now()};
  ctx.store.event(ctx.roomId, 'integration.updated', SYSTEM, {integration});
  ctx.command('room.delete', {expectedRevision: 1});
  ctx.worker.tick();
  assert.equal(ctx.store.room(ctx.roomId)!.status, 'deleting');
  return integration;
}

test('/api/rooms lists only active rooms', async t => {
  const ctx = await fixture(t);
  const second = ctx.service.execute({version: '0.1', commandId: uid(), type: 'room.create', payload: {name: 'Second room', members: ['demo-planner']}}).result.roomId as string;
  ctx.store.event(second, 'room.deleting', SYSTEM, {room: {...ctx.store.room(second)!, status: 'deleting', revision: 2}});
  const listed = await ctx.app.inject({method: 'GET', url: '/api/rooms', headers: ctx.headers});
  assert.equal(listed.statusCode, 200);
  const rooms = listed.json() as Room[];
  assert.deepEqual(rooms.map(room => room.id), [ctx.roomId], 'deleting rooms must not appear in the sidebar list');
});

test('snapshot and events expose deleting rooms but return 410 after deletion', async t => {
  const ctx = await fixture(t);
  const integration = await makeDeleting(ctx);
  const deletingSnapshot = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}/snapshot`, headers: ctx.headers});
  assert.equal(deletingSnapshot.statusCode, 200);
  assert.equal((deletingSnapshot.json() as any).snapshot.room.status, 'deleting');
  const deletingEvents = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}/events?after=0`, headers: ctx.headers});
  assert.equal(deletingEvents.statusCode, 200);
  ctx.store.event(ctx.roomId, 'integration.updated', SYSTEM, {integration: {...integration, status: 'blocked', errorCode: 'room_deleting', updatedAt: now()}});
  ctx.worker.tick();
  assert.equal(ctx.store.room(ctx.roomId)!.status, 'deleted');
  const deletedSnapshot = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}`, headers: ctx.headers});
  assert.equal(deletedSnapshot.statusCode, 410);
  assert.equal(deletedSnapshot.json().code, 'room_deleted');
  const deletedEvents = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}/events?after=0`, headers: ctx.headers});
  assert.equal(deletedEvents.statusCode, 410);
  assert.equal(deletedEvents.json().code, 'room_deleted');
});

test('owner audit export requires includeDeleted after deletion and keeps the terminal facts', async t => {
  const ctx = await fixture(t);
  await makeDeleting(ctx);
  ctx.store.event(ctx.roomId, 'room.deleted', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleted', revision: 4, deletion: {...ctx.store.room(ctx.roomId)!.deletion!, deletedAt: now()}}});
  const blocked = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}/audit/export`, headers: ctx.headers});
  assert.equal(blocked.statusCode, 410);
  const exported = await ctx.app.inject({method: 'GET', url: `/api/rooms/${ctx.roomId}/audit/export?includeDeleted=1`, headers: ctx.headers});
  assert.equal(exported.statusCode, 200);
  assert.match(exported.body, /room\.deleted/);
  assert.match(exported.body, /room\.deleting/);
});

test('artifact URLs cannot bypass a deleted room', async t => {
  const ctx = await fixture(t);
  const artifact: Artifact = {id: uid('artifact'), roomId: ctx.roomId, name: 'report.txt', kind: 'report', mediaType: 'text/plain', size: 5, createdAt: now()};
  mkdirSync(join(ctx.root, 'artifacts'), {recursive: true});
  writeFileSync(join(ctx.root, 'artifacts', artifact.id), 'hello');
  ctx.store.event(ctx.roomId, 'artifact.created', SYSTEM, {artifact});
  await makeDeleting(ctx);
  ctx.store.event(ctx.roomId, 'room.deleted', SYSTEM, {room: {...ctx.store.room(ctx.roomId)!, status: 'deleted', revision: 4, deletion: {...ctx.store.room(ctx.roomId)!.deletion!, deletedAt: now()}}});
  const download = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${artifact.id}`, headers: ctx.headers});
  assert.equal(download.statusCode, 410);
  const preview = await ctx.app.inject({method: 'GET', url: `/api/artifacts/${artifact.id}/preview`, headers: ctx.headers});
  assert.equal(preview.statusCode, 410);
});

test('deleting the last room does not recreate a seed room after restart', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-api-restart-'));
  const path = join(root, 'room.sqlite');
  const store = new Store(path);
  const roomId = store.rooms()[0].id;
  store.event(roomId, 'room.deleting', SYSTEM, {room: {...store.room(roomId)!, status: 'deleting', revision: 2}});
  store.event(roomId, 'room.deleted', SYSTEM, {room: {...store.room(roomId)!, status: 'deleted', revision: 3, deletion: {requestedAt: now(), requestedBy: 'owner', commandId: 'restart_test', deletedAt: now(), pendingReasons: []}}});
  store.close();
  const reopened = new Store(path);
  t.after(() => { reopened.close(); rmSync(root, {recursive: true, force: true}); });
  assert.equal(reopened.rooms().length, 1, 'seed must not replace a tombstone');
  assert.equal(reopened.rooms()[0].id, roomId);
  assert.equal(reopened.rooms()[0].status, 'deleted');
  assert.equal(reopened.activeRooms().length, 0);
});

test('RoomClient exposes configureRoom and deleteRoom over the command route', async t => {
  const seen: Array<{url: string; body: any}> = [];
  const client = new RoomClient('http://room.test', {
    token: 'client-token',
    fetch: (async (input: any, init?: any) => {
      seen.push({url: String(input), body: JSON.parse(init?.body ?? '{}')});
      return new Response(JSON.stringify({commandId: JSON.parse(init?.body ?? '{}').commandId, accepted: true, result: {roomId: 'room_test', revision: 2}}), {status: 200, headers: {'content-type': 'application/json'}});
    }) as typeof fetch
  });
  const configured = await client.configureRoom('room_test', {name: 'N', description: 'D', members: [], expectedRevision: 1}, 'cmd_configure');
  assert.equal((configured as any).result.revision, 2);
  assert.equal(seen[0].url, 'http://room.test/api/commands');
  assert.equal(seen[0].body.type, 'room.configure');
  assert.equal(seen[0].body.commandId, 'cmd_configure');
  await client.deleteRoom('room_test', 2, 'cmd_delete');
  assert.equal(seen[1].body.type, 'room.delete');
  assert.equal(seen[1].body.payload.expectedRevision, 2);
  assert.equal(seen[1].body.roomId, 'room_test');
});

test('websocket sends durable room.deleting and closes instead of reconnecting', async t => {
  const ctx = await fixture(t);
  const address = await ctx.app.listen({host: '127.0.0.1', port: 0});
  const url = address.replace(/^http/, 'ws') + '/api/events';
  const WebSocketImpl = (globalThis as any).WebSocket;
  assert.ok(WebSocketImpl, 'Node WebSocket global is required for this route test');
  const socket = new WebSocketImpl(url, ['room.v0.1', `room-token.${ctx.token}`]);
  const frames: any[] = [];
  let closeInfo: {code: number; reason: string} | undefined;
  const opened = new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('ws open failed')); });
  socket.onmessage = (message: any) => frames.push(JSON.parse(String(message.data)));
  const closed = new Promise<{code: number; reason: string}>((resolve) => { socket.onclose = (event: any) => { closeInfo = {code: event.code, reason: event.reason}; resolve(closeInfo); }; });
  await opened;
  socket.send(JSON.stringify({version: '0.1', roomId: ctx.roomId, after: 0, clientType: 'browser'}));
  const deadline = Date.now() + 5000;
  while (!frames.some(frame => frame.type === 'subscribed')) { if (Date.now() > deadline) assert.fail('ws subscribed frame missing'); await new Promise(done => setTimeout(done, 20)); }
  ctx.command('room.delete', {expectedRevision: 1});
  const closedInfo = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ws did not close after room.deleting')), 5000))]);
  assert.equal(closedInfo.code, 1000);
  assert.equal(closedInfo.reason, 'room_deleting');
  assert.ok(frames.some(frame => frame.type === 'room.deleting'), 'durable room.deleting must be delivered before close');
  assert.ok(closeInfo);
});

test('two websocket windows both receive room.deleting and close terminally', async t => {
  const ctx = await fixture(t);
  const address = await ctx.app.listen({host: '127.0.0.1', port: 0});
  const url = address.replace(/^http/, 'ws') + '/api/events';
  const WebSocketImpl = (globalThis as any).WebSocket;
  assert.ok(WebSocketImpl, 'Node WebSocket global is required for this route test');
  const openWindow = async () => {
    const socket = new WebSocketImpl(url, ['room.v0.1', `room-token.${ctx.token}`]);
    const frames: any[] = [];
    const closed = new Promise<{code: number; reason: string}>((resolve) => { socket.onclose = (event: any) => resolve({code: event.code, reason: event.reason}); });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('ws open failed')); });
    socket.onmessage = (message: any) => frames.push(JSON.parse(String(message.data)));
    socket.send(JSON.stringify({version: '0.1', roomId: ctx.roomId, after: 0, clientType: 'browser'}));
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.type === 'subscribed')) { if (Date.now() > deadline) assert.fail('ws subscribed frame missing'); await new Promise(done => setTimeout(done, 20)); }
    return {socket, frames, closed};
  };
  const [first, second] = await Promise.all([openWindow(), openWindow()]);
  ctx.command('room.delete', {expectedRevision: 1});
  for (const window of [first, second]) {
    const closedInfo = await Promise.race([window.closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ws did not close after room.deleting')), 5000))]);
    assert.equal(closedInfo.code, 1000);
    assert.equal(closedInfo.reason, 'room_deleting');
    assert.ok(window.frames.some(frame => frame.type === 'room.deleting'), 'each window must receive room.deleting before close');
  }
});
