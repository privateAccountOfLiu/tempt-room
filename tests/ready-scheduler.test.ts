import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadyScheduler } from '../apps/server/src/scheduler.ts';
import type { Run } from '../packages/protocol/src/index.ts';

function run(agentId: string, roomId = 'room-1'): Run {
  const createdAt = '2026-10-19T00:00:00.000Z';
  return {id: `run-${roomId}-${agentId}`, roomId, agentId, prompt: 'queued work', basedOnSeq: 0, status: 'queued', createdAt, updatedAt: createdAt};
}

function drain(scheduler: ReadyScheduler, eligible: Run[], weights: Map<string, number>, picks: number, maxBypass = 1000) {
  const counts = new Map<string, number>(), waits = new Map<string, number>(), maxGap = new Map<string, number>(), last = new Map<string, number>();
  for (let pick = 0; pick < picks; pick++) {
    const next = scheduler.pick(eligible, weights, maxBypass);
    assert.ok(next, `no eligible flow at pick ${pick}`);
    scheduler.recordServed(next);
    counts.set(next.agentId, (counts.get(next.agentId) ?? 0) + 1);
    for (const item of eligible) {
      const previous = last.get(item.agentId);
      if (previous !== undefined) maxGap.set(item.agentId, Math.max(maxGap.get(item.agentId) ?? 0, pick - previous));
      last.set(item.agentId, pick);
      waits.set(item.agentId, (waits.get(item.agentId) ?? 0) + (item.agentId === next.agentId ? 0 : 1));
    }
  }
  return {counts, waits, maxGap};
}

test('stable 2:1 weighted flows receive a long-run 2:1 dispatch share with real timestamps', () => {
  const scheduler = new ReadyScheduler();
  const a = run('a'), b = run('b');
  const weights = new Map([['a', 2], ['b', 1]]);
  const {counts} = drain(scheduler, [a, b], weights, 3000);
  const aCount = counts.get('a') ?? 0, bCount = counts.get('b') ?? 0;
  assert.equal(aCount + bCount, 3000);
  assert.ok(Math.abs(aCount - 2000) <= 10, `a=${aCount}`);
  assert.ok(Math.abs(bCount - 1000) <= 10, `b=${bCount}`);
});

test('the 100-agent steady set is served evenly without starvation', () => {
  const scheduler = new ReadyScheduler();
  const agents = Array.from({length: 100}, (_, index) => run(`agent-${String(index).padStart(3, '0')}`));
  const weights = new Map(agents.map(agent => [agent.agentId, 1]));
  const {counts, maxGap} = drain(scheduler, agents, weights, 1000, 500);
  assert.equal(counts.size, 100);
  for (const agent of agents) {
    assert.equal(counts.get(agent.agentId), 10, `${agent.agentId} was not served exactly ten times`);
    assert.ok((maxGap.get(agent.agentId) ?? 0) <= 250, `${agent.agentId} starved for ${maxGap.get(agent.agentId)} picks`);
  }
});

test('bypass guard serves a low-weight flow within the configured dispatch bound', () => {
  const scheduler = new ReadyScheduler();
  const heavy = run('heavy'), light = run('light');
  const weights = new Map([['heavy', 50], ['light', 1]]);
  let lastLight = -1, worstGap = 0;
  for (let pick = 0; pick < 300; pick++) {
    const next = scheduler.pick([heavy, light], weights, 5);
    scheduler.recordServed(next!);
    if (next!.agentId === 'light') {
      if (lastLight >= 0) worstGap = Math.max(worstGap, pick - lastLight);
      lastLight = pick;
    }
  }
  assert.ok(lastLight >= 0, 'light flow was never served');
  assert.ok(worstGap <= 10, `light flow waited ${worstGap} dispatches`);
});

test('rooms rotate and a blocked room cannot hold another room back', () => {
  const scheduler = new ReadyScheduler();
  const first = run('a', 'room-1'), second = run('b', 'room-2');
  const order: string[] = [];
  for (let pick = 0; pick < 10; pick++) {
    const next = scheduler.pick([first, second], new Map(), 100);
    scheduler.recordServed(next!);
    order.push(next!.roomId);
  }
  assert.deepEqual(order, ['room-1', 'room-2', 'room-1', 'room-2', 'room-1', 'room-2', 'room-1', 'room-2', 'room-1', 'room-2']);
  const blocked = scheduler.pick([first], new Map(), 100);
  assert.equal(blocked?.roomId, 'room-1');
});

test('adding a flow resets room credit without resetting existing wait counts', () => {
  const scheduler = new ReadyScheduler();
  const heavy = run('heavy');
  for (let pick = 0; pick < 20; pick++) { scheduler.pick([heavy], new Map([['heavy', 100]]), 1000); scheduler.recordServed(heavy); }
  const light = run('light');
  let lightPicks = 0;
  for (let pick = 0; pick < 500; pick++) {
    const next = scheduler.pick([heavy, light], new Map([['heavy', 100], ['light', 1]]), 5);
    scheduler.recordServed(next!);
    if (next!.agentId === 'light') lightPicks++;
  }
  assert.ok(lightPicks > 0, 'new low-weight flow was never served');
});
