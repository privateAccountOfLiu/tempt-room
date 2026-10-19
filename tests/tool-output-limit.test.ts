import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { ToolOperations } from '../apps/server/src/tool-operations.ts';
import { executionFence } from '../apps/server/src/execution.ts';
import { defaultExecutionSettings, type Run, type ToolOperation } from '../packages/protocol/src/index.ts';

test('tool results respect the configurable byte cap and become unknown instead of silently truncating', t => {
  assert.equal(defaultExecutionSettings.maxToolResultBytes, 2 * 1024 * 1024);
  const parent = resolve('.state/test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'tool-cap-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  service.execute({ version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: { title: 'cap', agentId: 'demo-planner' } });
  const run = store.list<Run>('runs', roomId)[0];
  run.status = 'running'; run.executionId = uid('execution');
  store.event(roomId, 'run.started', SYSTEM, { run });
  const operations = new ToolOperations(store, () => 1024);
  assert.throws(() => operations.execute(executionFence(run), 'large-result', 'fixture_result', {}, () => ({ text: 'x'.repeat(2048) })), /configured limit/);
  assert.equal(store.list<ToolOperation>('operations', roomId)[0].status, 'unknown');
});
