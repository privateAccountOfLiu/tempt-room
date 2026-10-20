import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { summarizeOutboundDeliveries } from '../apps/server/src/outbound-summary.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';

const parent = resolve('.state/test-data');
async function fixture(t: any) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'outbound-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), worker = new Worker(store, service, root, {adapter: async function* () {}}), roomId = store.rooms()[0].id;
  const headers: any[] = [], bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    headers.push({...request.headers});
    let raw = '';
    request.on('data', chunk => { raw += chunk.toString(); });
    request.on('end', () => { bodies.push(raw); response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}'); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const port = (server.address() as {port: number}).port;
  const command = (type: string, payload: unknown, actor?: any): any => service.execute({version: '0.1', commandId: uid(), roomId, type, payload}, actor);
  command('settings.update', {...store.settings(), outboundAllowPrivate: true, outboundMaxAttempts: 3, outboundTimeoutMs: 2000});
  t.after(async () => { await worker.close(); store.close(); await new Promise<void>(done => server.close(() => done())); rmSync(root, {recursive: true, force: true}); });
  return {store, service, worker, roomId, port, headers, bodies, command};
}

test('owner enqueues an outbound delivery and the worker posts the redacted export', async t => {
  const {store, worker, roomId, port, headers, command} = await fixture(t);
  store.event(roomId, 'chat.message.created', {id: 'owner', kind: 'human'}, {message: {id: 'outbound_msg', roomId, actor: {id: 'owner', kind: 'human'}, text: 'hello outbound', mentions: [], attachments: [], createdAt: new Date().toISOString()}});
  const result = command('outbound.enqueue', {url: `http://127.0.0.1:${port}/hook`, throughSeq: store.room(roomId)!.seq, redacted: true});
  assert.match(result.result.deliveryId, /^outbound_/);
  await worker.deliverOutbound();
  assert.equal(headers.length, 1);
  assert.equal(headers[0]['x-tempt-room-delivery'], result.result.deliveryId);
  const delivered = store.events(roomId).filter(event => event.type === 'outbound.delivered');
  assert.equal(delivered.length, 1);
  await worker.deliverOutbound();
  assert.equal(headers.length, 1);
});

test('outbound signing uses an env-named secret without persisting it', async t => {
  const {store, worker, roomId, port, headers, bodies, command} = await fixture(t);
  process.env.OUTBOUND_TEST_SECRET = 'test-signing-secret';
  t.after(() => { delete process.env.OUTBOUND_TEST_SECRET; });
  command('settings.update', {...store.settings(), outboundSigningSecretEnv: 'OUTBOUND_TEST_SECRET'});
  command('outbound.enqueue', {url: `http://127.0.0.1:${port}/hook`, throughSeq: store.room(roomId)!.seq});
  await worker.deliverOutbound();
  const timestamp = String(headers[0]['x-tempt-room-timestamp']);
  const expected = 'sha256=' + createHmac('sha256', 'test-signing-secret').update(timestamp + '.' + bodies[0]).digest('hex');
  assert.equal(headers[0]['x-tempt-room-signature'], expected);
  assert.equal(store.settings().outboundSigningSecretEnv, 'OUTBOUND_TEST_SECRET');
});

test('outbound summaries expose delivered and failed deliveries', async t => {
  const {store, worker, roomId, command} = await fixture(t);
  command('settings.update', {...store.settings(), outboundMaxAttempts: 1});
  const failed = command('outbound.enqueue', {url: 'http://127.0.0.1:1/hook', throughSeq: store.room(roomId)!.seq});
  await worker.deliverOutbound();
  const summary = summarizeOutboundDeliveries(store.events(roomId), 1);
  assert.equal(summary.find(item => item.deliveryId === failed.result.deliveryId)!.status, 'failed');
  assert.ok(summary.find(item => item.deliveryId === failed.result.deliveryId)!.lastError);
});

test('outbound URL policy blocks metadata and private hosts by default', async t => {
  const {store, service, roomId, command} = await fixture(t);
  command('settings.update', {...store.settings(), outboundAllowPrivate: false});
  assert.throws(() => command('outbound.enqueue', {url: 'http://169.254.169.254/latest/meta-data'}), /元数据/);
  assert.throws(() => command('outbound.enqueue', {url: 'http://192.168.1.2/hook'}), /loopback|私网/);
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'outbound.enqueue', payload: {url: 'https://example.test/hook'}}, {id: 'demo-planner', kind: 'agent'}), /无权|owner/);
});

test('failed outbound attempts are recorded without being marked delivered', async t => {
  const {store, worker, roomId, command} = await fixture(t);
  const result = command('outbound.enqueue', {url: 'http://127.0.0.1:1/hook', throughSeq: store.room(roomId)!.seq});
  await worker.deliverOutbound();
  const attempted = store.events(roomId).filter(event => event.type === 'outbound.attempted' && (event.payload as any).deliveryId === result.result.deliveryId);
  assert.equal(attempted.length, 1);
  assert.equal((attempted[0]!.payload as any).ok, false);
  assert.equal(store.events(roomId).filter(event => event.type === 'outbound.delivered').length, 0);
});
