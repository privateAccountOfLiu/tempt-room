import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { executionFence } from '../apps/server/src/execution.ts';
import { defaultExecutionSettings, type Run } from '../packages/protocol/src/index.ts';

test('per-run tool call budget stops runaway tool loops before the next action', async t => {
  assert.equal(defaultExecutionSettings.maxToolCallsPerRun, 100);
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'tool-budget-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = new Worker(store, service, root, { adapter: async function* () { yield { type: 'text', text: 'unused' }; } });
  t.after(async () => { (worker as unknown as { active: Map<string, AbortController> }).active.delete(run.id); await worker.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'settings.update', payload: { ...store.settings(), maxToolCallsPerRun: 1 } });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: { title: 'budget', agentId: 'demo-planner' } });
  const run = store.list<Run>('runs', roomId)[0];
  run.status = 'running'; run.executionId = uid('execution');
  store.event(roomId, 'run.started', SYSTEM, { run });
  (worker as unknown as { active: Map<string, AbortController> }).active.set(run.id, new AbortController());
  const fence = executionFence(run);
  const read = await worker.executeTool(run.id, { name: 'room_read', arguments: {} }, fence);
  const second = await worker.executeTool(run.id, { name: 'room_read', arguments: {} }, fence);
  assert.equal(read.roomId, roomId);
  assert.equal(second.code, 'tool_budget_exceeded');
});
