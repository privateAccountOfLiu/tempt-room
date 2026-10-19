import test from 'node:test';
import assert from 'node:assert/strict';
import { fairOrder } from '../apps/server/src/scheduler.ts';
import type { Run } from '../packages/protocol/src/index.ts';

function run(agentId: string, createdAt: string, roomId = 'room'): Run {
  return { id: `${agentId}-${createdAt}`, roomId, agentId, prompt: '', basedOnSeq: 0, status: 'queued', createdAt, updatedAt: createdAt } as Run;
}

test('fairOrder serves never-served and older runs before recently served agents', () => {
  const a = run('a', '2026-01-01T00:00:02.000Z');
  const b = run('b', '2026-01-01T00:00:01.000Z');
  const c = run('c', '2026-01-01T00:00:03.000Z');
  const runs = [a, b, c];
  assert.deepEqual(fairOrder(runs, new Map()).map(item => item.agentId), ['b', 'a', 'c']);
  assert.deepEqual(fairOrder(runs, new Map([['room/a', 100], ['room/b', 50]])).map(item => item.agentId), ['c', 'b', 'a']);
  assert.deepEqual(fairOrder(runs, new Map([['room/a', 50], ['room/b', 100]])).map(item => item.agentId), ['c', 'a', 'b']);
  assert.deepEqual(runs.map(item => item.agentId), ['a', 'b', 'c'], 'input order must not be mutated');
});

test('fairness keys are scoped by room as well as agent', () => {
  const first = run('a', '2026-01-01T00:00:01.000Z', 'room-1');
  const second = run('a', '2026-01-01T00:00:02.000Z', 'room-2');
  assert.deepEqual(fairOrder([second, first], new Map([['room-1/a', 100]])).map(item => item.roomId), ['room-2', 'room-1']);
});

test('scheduler weights shift virtual service toward higher-weight agents', () => {
  const a = run('a', '2026-01-01T00:00:01.000Z'), b = run('b', '2026-01-01T00:00:02.000Z');
  const served = new Map([['room/a', 10], ['room/b', 6]]);
  assert.deepEqual(fairOrder([a, b], served).map(item => item.agentId), ['b', 'a']);
  assert.deepEqual(fairOrder([a, b], served, new Map([['a', 2], ['b', 1]])).map(item => item.agentId), ['a', 'b']);
  const pending = Array.from({ length: 15 }, (_, index) => [run('a', new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()), run('b', new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())]).flat();
  const nextServed = new Map<string, number>(), counts = new Map<string, number>(), weights = new Map([['a', 2], ['b', 1]]);
  let clock = 1;
  for (let pick = 0; pick < 12; pick++) {
    const next = fairOrder(pending, nextServed, weights)[0];
    pending.splice(pending.indexOf(next), 1);
    counts.set(next.agentId, (counts.get(next.agentId) ?? 0) + 1);
    nextServed.set(next.roomId + '/' + next.agentId, clock++);
  }
  assert.ok((counts.get('a') ?? 0) > (counts.get('b') ?? 0), String(JSON.stringify([...counts])));
});
