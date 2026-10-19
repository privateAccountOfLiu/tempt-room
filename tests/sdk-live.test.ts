// Real-network integration tests for the published TypeScript client package.
// Unlike the SDK consumer probe (which mocks fetch), this starts a real Tempt
// Room server on loopback and drives it through RoomClient / RoomAgentClient over
// HTTP and WebSocket, including idempotent command IDs, room-bound Agent tokens
// and cursor subscription.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createApp} from '../apps/server/src/app.ts';
import {issueAgentToken} from '../apps/server/src/agent-tokens.ts';
import {uid} from '../apps/server/src/store.ts';
import {RoomClient, RoomAgentClient} from '../packages/client/src/index.ts';

// The client package uses the platform WebSocket just like a browser does.
(globalThis as any).WebSocket = WebSocket;

async function start() {
  const root = mkdtempSync(join(tmpdir(), 'tempt-sdk-live-'));
  const secret = uid('secret');
  const appHandle = await createApp({root, token: secret, startWorker: false});
  await appHandle.app.listen({host: '127.0.0.1', port: 0});
  const address = appHandle.app.server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  const base = `http://127.0.0.1:${address.port}`;
  const roomId = appHandle.store.rooms()[0].id;
  return {...appHandle, root, secret, base, roomId, close: async () => { await appHandle.app.close(); rmSync(root, {recursive: true, force: true}); }};
}

test('published RoomClient drives a real server with idempotent commands and history', async () => {
  const server = await start();
  try {
    const client = new RoomClient(server.base, {token: server.secret});
    const rooms = await client.rooms();
    assert.ok(rooms.some(room => room.id === server.roomId));
    const capabilities = await client.capabilities();
    assert.equal(capabilities.version, '0.1');
    assert.ok(capabilities.commands.includes('message.send'));
    const commandId = `sdk_live_${uid('cmd')}`;
    const first = await client.command('message.send', {text: 'SDK live command'}, server.roomId, commandId);
    const second = await client.command('message.send', {text: 'SDK live command'}, server.roomId, commandId);
    assert.deepEqual(first, second);
    const snapshot = await client.snapshot(server.roomId);
    assert.equal(snapshot.messages.filter(message => message.text === 'SDK live command').length, 1);
    const history = await client.events(server.roomId, 0);
    assert.ok(history.some(event => event.type === 'chat.message.created'));
    await assert.rejects(client.request('/api/rooms', {headers: {authorization: 'Bearer wrong'}}), /本地会话|unauthorized|启动/);
  } finally { await server.close(); }
});

test('published RoomAgentClient posts as the Agent and rejects tokens from another room', async () => {
  const server = await start();
  try {
    const token = issueAgentToken(server.secret, 'demo-planner', server.roomId);
    const agent = new RoomAgentClient(server.base, server.roomId, token);
    const status = await agent.call<{room: {id: string}; tasks: unknown[]}>('room_status');
    assert.equal(status.room.id, server.roomId);
    assert.ok(Array.isArray(status.tasks));
    await agent.call('room_post', {text: 'SDK agent live post'});
    const snapshot = await new RoomClient(server.base, {token: server.secret}).snapshot(server.roomId);
    const posted = snapshot.messages.find(message => message.text === 'SDK agent live post');
    assert.ok(posted);
    assert.equal(posted.actor.id, 'demo-planner');
    const otherRoom = (await new RoomClient(server.base, {token: server.secret}).command('room.create', {name: 'SDK live other', members: ['demo-planner']}, undefined)).result.roomId as string;
    const otherToken = issueAgentToken(server.secret, 'demo-planner', otherRoom);
    const wrongRoom = new RoomAgentClient(server.base, server.roomId, otherToken);
    await assert.rejects(wrongRoom.call('room_status'), error => {
      assert.equal((error as any).status, 401);
      return true;
    });
    const fake = new RoomAgentClient(server.base, server.roomId, 'demo-planner.v1.' + server.roomId + '.' + 'f'.repeat(64));
    await assert.rejects(fake.call('room_status'), error => (error as any).status === 401);
    const crossRoomPrepared = agent.prepare('room_status');
    await assert.rejects(agent.send({...crossRoomPrepared, roomId: otherRoom}), /another room/);
  } finally { await server.close(); }
});

test('published RoomClient subscribes over WebSocket and recovers with a cursor', async () => {
  const server = await start();
  try {
    const client = new RoomClient(server.base, {token: server.secret});
    const received: any[] = [];
    let connected = false;
    const unsubscribe = client.subscribe(server.roomId, 0, event => received.push(event), status => { connected = status; });
    const deadline = Date.now() + 10_000;
    while (!connected && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal(connected, true);
    await client.command('message.send', {text: 'SDK live websocket'}, server.roomId);
    while (!received.some(event => event.type === 'chat.message.created' && event.payload?.message?.text === 'SDK live websocket') && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.ok(received.some(event => event.type === 'chat.message.created' && event.payload.message.text === 'SDK live websocket'));
    const subscribed = received.find(event => event.type === 'subscribed');
    assert.ok(subscribed);
    unsubscribe();
    const closeDeadline = Date.now() + 3000;
    while (connected && Date.now() < closeDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal(connected, false);
  } finally { await server.close(); }
});
