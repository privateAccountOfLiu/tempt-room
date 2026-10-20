import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
test('per-room concurrency limit keeps a second run queued while the first owns the room slot', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-concurrency-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {adapter: async function* () { await new Promise(done => setTimeout(done, 200)); yield {type: 'text', text: 'done'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  command('settings.update', {...store.settings(), concurrency: 4, maxConcurrentRunsPerRoom: 1});
  command('task.create', {title: 'Room slot A', agentId: 'demo-planner'});
  command('task.create', {title: 'Room slot B', agentId: 'demo-reviewer'});
  worker.tick();
  const firstTick = store.list<Run>('runs', roomId);
  assert.equal(firstTick.filter(run => run.status === 'running').length, 1);
  assert.equal(firstTick.filter(run => run.status === 'queued').length, 1);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && store.list<Run>('runs', roomId).filter(run => run.status === 'completed').length < 2) {
    worker.tick();
    await new Promise(done => setTimeout(done, 25));
  }
  assert.equal(store.list<Run>('runs', roomId).filter(run => run.status === 'completed').length, 2);
});
