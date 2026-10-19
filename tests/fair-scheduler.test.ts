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

test('fairOrder stays a stateless least-recently-served ordering', () => {
  const a = run('a', '2026-01-01T00:00:01.000Z'), b = run('b', '2026-01-01T00:00:02.000Z');
  const served = new Map([['room/a', 10], ['room/b', 6]]);
  assert.deepEqual(fairOrder([a, b], served).map(item => item.agentId), ['b', 'a']);
  assert.deepEqual(fairOrder([b, a], new Map([['room/a', 6], ['room/b', 10]])).map(item => item.agentId), ['a', 'b']);
});
