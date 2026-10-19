import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { defaultExecutionSettings, roomBudgetError, type Run } from '../packages/protocol/src/index.ts';

const usageRun = (usageByGeneration: Record<string, { inputTokens?: number; outputTokens?: number; costUsd?: number }>) => ({ usageByGeneration });

test('room budget breaker ignores unknown usage and stops at known totals', () => {
  assert.equal(roomBudgetError(defaultExecutionSettings, []), undefined);
  const limits = { ...defaultExecutionSettings, roomTokenBudget: 1000, roomCostBudgetUsd: 0.5 };
  assert.equal(roomBudgetError(limits, [usageRun({ '1': { inputTokens: 400, outputTokens: 400 } })]), undefined);
  assert.match(String(roomBudgetError(limits, [usageRun({ '1': { inputTokens: 600, outputTokens: 500 } })])), /Token/);
  assert.match(String(roomBudgetError(limits, [usageRun({ '1': { costUsd: 0.5 } })])), /费用/);
  assert.equal(roomBudgetError(limits, [usageRun({ '1': {} })]), undefined);
  assert.equal(roomBudgetError({ ...limits, roomTokenBudget: 0, roomCostBudgetUsd: 0 }, [usageRun({ '1': { inputTokens: 99999 } })]), undefined);
});

test('enqueue rejects a new run when the room lifetime budget is already exhausted', t => {
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'room-budget-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const cmd = (type: string, payload: unknown, id = uid('cmd')) => service.execute({ version: '0.1', commandId: id, roomId, type, payload });
  cmd('task.create', { title: 'history', agentId: 'demo-planner' });
  const history = store.list<Run>('runs').at(-1)!;
  history.usage = { costUsd: 0.6, inputTokens: 100 };
  history.usageByGeneration = { '1': history.usage };
  store.event(roomId, 'run.updated', SYSTEM, { run: history });
  cmd('settings.update', { ...store.settings(), roomCostBudgetUsd: 0.5 });
  const taskCount = store.list('tasks').length;
  assert.throws(() => cmd('task.create', { title: 'should fail', agentId: 'demo-planner' }), /房间累计费用预算已用尽/);
  assert.equal(store.list('tasks').length, taskCount);
  assert.equal(store.list<Run>('runs').length, 1);
});
