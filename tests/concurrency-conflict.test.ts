import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';

test('two independent SQLite connections interleave writes without diverging projections', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'concurrency-'));
  const writerA = new Store(join(root, 'room.sqlite'));
  const roomId = writerA.rooms()[0].id;
  const writerB = new Store(join(root, 'room.sqlite'));
  const serviceA = new RoomService(writerA), serviceB = new RoomService(writerB);
  t.after(() => { writerB.close(); writerA.close(); rmSync(root, { recursive: true, force: true }); });
  const initialSeq = writerA.room(roomId)!.seq;
  const initialMessages = writerA.snapshot(roomId).messages.length;
  const send = (service: RoomService, text: string) => service.execute({ version: '0.1', commandId: uid('concurrency'), roomId, type: 'message.send', payload: { text, mentions: [] } });
  for (let index = 0; index < 20; index++) {
    send(serviceA, `writer-A-${index}`);
    send(serviceB, `writer-B-${index}`);
    const snapshotA = writerA.snapshot(roomId), snapshotB = writerB.snapshot(roomId);
    assert.equal(snapshotA.messages.length, snapshotB.messages.length, `snapshot disagreement after round ${index}`);
    assert.equal(snapshotA.room.seq, snapshotB.room.seq, `seq disagreement after round ${index}`);
  }
  assert.equal(writerA.room(roomId)!.seq, initialSeq + 40);
  assert.equal(writerA.events(roomId).length, initialSeq + 40);
  assert.ok(writerA.projectionStatus(roomId).consistent);
  assert.ok(writerB.projectionStatus(roomId).consistent);
  const before = writerA.projectionBytes(roomId);
  assert.equal(writerB.projectionBytes(roomId), before);
  writerB.rebuildProjections(roomId, initialSeq + 7);
  assert.equal(writerB.projectionBytes(roomId), before);
  assert.equal(writerB.snapshot(roomId).messages.length, initialMessages + 40);
});
