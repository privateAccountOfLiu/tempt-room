import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';

const parent = resolve('.state/test-data');
test('staging cleanup removes only expired review directories', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'staging-retention-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'unused'}; }});
  t.after(async () => { await worker.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const oldDir = join(root, 'staging', 'integration_old'), freshDir = join(root, 'staging', 'integration_fresh');
  mkdirSync(oldDir, {recursive: true}); mkdirSync(freshDir, {recursive: true});
  writeFileSync(join(oldDir, 'candidate.txt'), 'old'); writeFileSync(join(freshDir, 'candidate.txt'), 'fresh');
  const ancient = new Date(Date.now() - 60 * 60 * 1000); utimesSync(oldDir, ancient, ancient);
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: {...store.settings(), stagingRetentionMs: 1000}});
  worker.tick();
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(freshDir), true);
});
