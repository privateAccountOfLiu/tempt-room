import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';

/** Deterministic PRNG so a failing seed can be replayed locally and in CI. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('seeded random command history rebuilds byte-identically at arbitrary seq boundaries', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fault-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (type: string, payload: unknown) => service.execute({ version: '0.1', commandId: uid('fault'), roomId, type, payload });
  const rng = random(0x5eed1234);
  for (let index = 0; index < 40; index++) {
    if (rng() < 0.75) {
      command('message.send', { text: `随机消息 ${index}`, mentions: [] });
    } else {
      const decision = command('decision.propose', { text: `随机决策 ${index}` }).result.decisionId as string;
      if (rng() < 0.7) command('decision.accept', { decisionId: decision });
    }
  }
  const head = store.room(roomId)!.seq;
  const bytes = store.projectionBytes(roomId);
  assert.ok(store.projectionStatus(roomId).consistent);
  for (let iteration = 0; iteration < 30; iteration++) {
    const fromSeq = Math.floor(rng() * (head + 1));
    store.rebuildProjections(roomId, fromSeq);
    assert.equal(store.projectionBytes(roomId), bytes, `projection mismatch at fromSeq=${fromSeq}`);
    assert.equal(store.projectionStatus(roomId).consistent, true, `inconsistent projection at fromSeq=${fromSeq}`);
    assert.equal(store.room(roomId)!.seq, head, `head changed at fromSeq=${fromSeq}`);
  }
  // A trailing write after the fault sweep must remain replayable.
  command('message.send', { text: '故障注入后继续写入', mentions: [] });
  store.rebuildProjections(roomId);
  assert.ok(store.snapshot(roomId).messages.some(message => message.text === '故障注入后继续写入'));
});
