import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { fairOrder } from '../apps/server/src/scheduler.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('100-agent fair ordering serves every agent evenly over 500 picks', () => {
  const runs = Array.from({ length: 500 }, (_, index): Run => ({
    id: `run_${index}`, roomId: 'room_pressure', agentId: `agent_${index % 100}`,
    status: 'queued', prompt: 'pressure', basedOnSeq: 0,
    createdAt: new Date(1_700_000_000_000 + index).toISOString(), updatedAt: new Date(1_700_000_000_000 + index).toISOString()
  }));
  const pending = [...runs], served = new Map<string, number>(), order: Run[] = [];
  while (pending.length) {
    const [next] = fairOrder(pending, served);
    const index = pending.findIndex(run => run.id === next.id);
    pending.splice(index, 1);
    order.push(next);
    const key = `${next.roomId}/${next.agentId}`;
    served.set(key, (served.get(key) ?? 0) + 1);
  }
  assert.equal(order.length, 500);
  const counts = [...served.values()];
  assert.equal(counts.length, 100);
  assert.ok(counts.every(count => count === 5), JSON.stringify(counts));
});

test('600-message room replays byte-identically under pressure', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'pressure-replay-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const initialSeq = store.room(roomId)!.seq, initialMessages = store.snapshot(roomId).messages.length;
  for (let index = 0; index < 600; index++) service.execute({ version: '0.1', commandId: uid('pressure'), roomId, type: 'message.send', payload: { text: `pressure message ${index}`, mentions: [] } });
  assert.equal(store.room(roomId)!.seq, initialSeq + 600);
  assert.equal(store.snapshot(roomId).messages.length, initialMessages + 600);
  const before = store.projectionBytes(roomId);
  store.rebuildProjections(roomId, 0);
  assert.equal(store.projectionBytes(roomId), before);
  assert.equal(store.projectionStatus(roomId).consistent, true);
});
