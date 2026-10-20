import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, now, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { acquireResource, quarantineResource, recoverResourceLeases, releaseResource } from '../apps/server/src/resource-manager.ts';
import type { ResourceLease, Run } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'resource-lease-')), store = new Store(join(root, 'room.sqlite')), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const run: Run = {id: uid('run'), roomId, agentId: 'demo-planner', status: 'running', prompt: 'x', basedOnSeq: 0, generation: 1, executionId: 'exec_resource', createdAt: now(), updatedAt: now()};
  return {store, roomId, run};
}

test('resource leases enforce canonical-key exclusivity and require cleanup proof', t => {
  const {store, roomId, run} = fixture(t);
  const lease = acquireResource(store, {roomId, kind: 'project', key: 'D:\\Fixture\\Project\\', run});
  assert.equal(lease.status, 'active');
  assert.throws(() => acquireResource(store, {roomId, kind: 'project', key: 'D:/fixture/project', run: {...run, id: 'run_2'}}), /资源已被其他运行占用/);
  assert.throws(() => releaseResource(store, roomId, lease.id, {checkedAt: now(), remainingProcesses: 1, evidence: 'child alive'}), /仍检测到受控进程/);
  const released = releaseResource(store, roomId, lease.id, {checkedAt: now(), remainingProcesses: 0, evidence: 'job empty'});
  assert.equal(released.status, 'released');
  const again = acquireResource(store, {roomId, kind: 'project', key: 'D:/fixture/project', run: {...run, id: 'run_2', executionId: 'exec_2'}});
  assert.equal(again.status, 'active');
});

test('quarantined leases block reuse and restart recovery quarantines active leases', t => {
  const {store, roomId} = fixture(t);
  const lease = acquireResource(store, {roomId, kind: 'project', key: 'C:/shared/project', run: {id: 'run_a', generation: 1}});
  quarantineResource(store, roomId, lease.id, 'process tree unproven');
  assert.throws(() => acquireResource(store, {roomId, kind: 'project', key: 'C:/shared/project', run: {id: 'run_b', generation: 1}}), /隔离状态/);
  assert.throws(() => releaseResource(store, roomId, lease.id, {checkedAt: now(), remainingProcesses: 2, evidence: 'children alive'}), /仍检测到受控进程/);
  releaseResource(store, roomId, lease.id, {checkedAt: now(), remainingProcesses: 0, evidence: 'owner verified empty tree'});
  const reacquired = acquireResource(store, {roomId, kind: 'project', key: 'C:/shared/project', run: {id: 'run_b2', generation: 1}});
  assert.equal(reacquired.status, 'active');
  const active = acquireResource(store, {roomId, kind: 'workspace', key: 'C:/workspace/a', run: {id: 'run_c', generation: 1}});
  assert.equal(recoverResourceLeases(store), 2);
  assert.equal(store.list<ResourceLease>('resource_leases', roomId).find(item => item.id === active.id)!.status, 'quarantined');
  assert.throws(() => acquireResource(store, {roomId, kind: 'workspace', key: 'C:/workspace/a', run: {id: 'run_d', generation: 1}}), /隔离状态/);
});

test('agent-session leases are exclusive and released only with proof', t => {
  const {store, roomId} = fixture(t);
  const lease = acquireResource(store, {roomId, kind: 'session', key: 'agent-session:room:demo-planner', run: {id: 'run_session_a', generation: 1}});
  assert.equal(lease.kind, 'session');
  assert.throws(() => acquireResource(store, {roomId, kind: 'session', key: 'agent-session:room:demo-planner', run: {id: 'run_session_b', generation: 1}}), /资源已被其他运行占用/);
  releaseResource(store, roomId, lease.id, {checkedAt: now(), remainingProcesses: 0, evidence: 'session worker exited'});
  const next = acquireResource(store, {roomId, kind: 'session', key: 'agent-session:room:demo-planner', run: {id: 'run_session_c', generation: 1}});
  assert.equal(next.status, 'active');
});

test('owner can reserve port and database capacities through the command surface', t => {
  const {store, roomId} = fixture(t);
  const service = new RoomService(store);
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  const port = command('resource.reserve', {kind: 'port', canonicalKey: '127.0.0.1:4318', capacity: 1});
  assert.ok(port.result.leaseId);
  assert.throws(() => command('resource.reserve', {kind: 'port', canonicalKey: '127.0.0.1:4318', capacity: 1}), /资源已被其他运行占用/);
  const db = command('resource.reserve', {kind: 'database', canonicalKey: 'sqlite:fixture', capacity: 2});
  assert.equal(db.result.capacity, 2);
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'resource.reserve', payload: {kind: 'port', canonicalKey: '127.0.0.1:4319', capacity: 1}}, {id: 'demo-planner', kind: 'agent'}), /无权执行此命令/);
  command('resource.release', {leaseId: port.result.leaseId, remainingProcesses: 0, evidence: 'owner verified'});
  command('resource.reserve', {kind: 'port', canonicalKey: '127.0.0.1:4318', capacity: 1});
});
