import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { taskContractSchema, type Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
const hash = 'a'.repeat(64);
const contract = {
  objective: 'Implement and verify the fixed contract task',
  projectBinding: {id: 'binding_1', version: 1, baselineRef: 'baseline_1', manifestHash: hash, allowedPaths: ['src/fixed.ts']},
  acceptance: [{id: 'unit', description: 'unit checks pass', command: 'npm test -- fixed.test.ts', verifierVersion: '1.0.0', verifierHash: hash}],
  expectedArtifacts: [{path: 'artifacts/fixed.diff', mediaType: 'text/x-diff'}],
  dependencies: [],
  authorizedExecutor: {agentId: 'demo-planner', executionMode: 'sandbox'},
  limits: {durationLimitMs: 60000, activationLimit: 2},
  failureHandling: 'isolate_branch',
  collaborationBoundary: {canModifyInterfaces: false}
};
function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'task-contract-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {store, service, roomId, command};
}

test('task contract schema is strict and captures acceptance/baseline boundaries', () => {
  const parsed = taskContractSchema.parse(contract);
  assert.equal(parsed.acceptance.length, 1);
  assert.equal(parsed.projectBinding.allowedPaths[0], 'src/fixed.ts');
  assert.throws(() => taskContractSchema.parse({...contract, executionMode: 'host'}));
  assert.throws(() => taskContractSchema.parse({...contract, acceptance: []}));
  assert.throws(() => taskContractSchema.parse({...contract, projectBinding: {...contract.projectBinding, manifestHash: 'short'}}));
});

test('tasks persist a frozen contract and contract revisions bump the task version', t => {
  const {store, roomId, command} = fixture(t);
  const created = command('task.create', {title: 'Fixed contract task', agentId: 'demo-planner', contract});
  const task = store.get<Task>('tasks', created.result.taskId as string)!;
  assert.deepEqual(task.contract, taskContractSchema.parse(contract));
  const revisedContract = {...contract, objective: 'Revised objective'};
  const revised = command('task.revise', {taskId: task.id, title: 'Fixed contract task v2', contract: revisedContract});
  const current = store.get<Task>('tasks', task.id)!;
  assert.equal(current.version, 2);
  assert.equal(current.contract?.objective, 'Revised objective');
  assert.deepEqual(revised.result.affectedTaskIds, [task.id]);
});

test('contract dependencies must reference existing tasks in the same room', t => {
  const {service, roomId} = fixture(t);
  const invalid = {...contract, dependencies: [{taskId: 'task_missing', condition: 'execution', taskVersion: 1}]};
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'task.create', payload: {title: 'bad contract', agentId: 'demo-planner', contract: invalid}}), /契约依赖任务不存在/);
});
