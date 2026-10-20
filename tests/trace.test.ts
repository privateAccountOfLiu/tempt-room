import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { uid } from '../apps/server/src/store.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('commands produce a shared traceId that links run and artifact facts', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'trace-'));
  const {app, store, service} = await createApp({root, startWorker: false, token: 'trace-owner'});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'Traced task', agentId: 'demo-planner'}});
  const run = store.list<Run>('runs', roomId)[0];
  assert.ok(run?.traceId);
  const headers = {host: '127.0.0.1:4317', authorization: 'Bearer trace-owner', 'room-protocol-version': '0.1'};
  const response = await app.inject({url: `/api/rooms/${roomId}/traces/${run.traceId}`, headers});
  assert.equal(response.statusCode, 200);
  const events = response.json() as Array<{type: string; traceId: string}>;
  assert.ok(events.length >= 1);
  assert.ok(events.every(event => event.traceId === run.traceId));
  assert.ok(events.some(event => event.type === 'run.created'));
  assert.ok(events.some(event => event.type === 'task.created'));
  assert.equal((await app.inject({url: `/api/rooms/${roomId}/traces/${run.traceId}`, headers: {host: headers.host, 'room-protocol-version': '0.1'}})).statusCode, 401);
});
