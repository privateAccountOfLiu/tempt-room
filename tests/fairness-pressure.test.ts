import test from 'node:test';
import assert from 'node:assert/strict';
import { fairOrder } from '../apps/server/src/scheduler.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('fair ordering drains 20 agents without starving any producer', () => {
  const runs: Run[] = [];
  for (let agent = 0; agent < 20; agent++) {
    for (let index = 0; index < 5; index++) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, agent * 5 + index)).toISOString();
      runs.push({ id: `run-${agent}-${index}`, roomId: 'room-pressure', agentId: `agent-${agent}`, prompt: '', basedOnSeq: 0, status: 'queued', createdAt, updatedAt: createdAt } as Run);
    }
  }
  const servedAt = new Map<string, number>();
  const pending = new Set(runs.map(run => run.id));
  const served = new Map<string, number>();
  let clock = 1;
  let maxGap = 0;
  const lastServed = new Map<string, number>();
  while (pending.size) {
    const next = fairOrder([...pending].map(id => runs.find(run => run.id === id)!), servedAt)[0];
    pending.delete(next.id);
    served.set(next.agentId, (served.get(next.agentId) ?? 0) + 1);
    if (lastServed.has(next.agentId)) maxGap = Math.max(maxGap, clock - lastServed.get(next.agentId)!);
    lastServed.set(next.agentId, clock);
    servedAt.set(`${next.roomId}/${next.agentId}`, clock++);
  }
  assert.equal(served.size, 20);
  for (const count of served.values()) assert.equal(count, 5);
  assert.ok(maxGap <= 150, `unexpected starvation gap ${maxGap}`);
});
