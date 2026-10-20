import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import type { BudgetReservation, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
function fixture(t: import('node:test').TestContext) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'budget-reservation-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  command('settings.update', {...store.settings(), roomCostBudgetUsd: 1, costBudgetUsd: 0.6});
  return {store, service, roomId, command};
}

test('parallel cost reservations cannot share the same remaining room budget', t => {
  const {store, roomId, command} = fixture(t);
  const firstTask = command('task.create', {title: 'Reserved task A', agentId: 'demo-planner'}).result.taskId as string;
  const firstRun = store.list<Run>('runs', roomId).find(run => run.taskId === firstTask)!;
  const reservation = store.list<BudgetReservation>('budget_reservations', roomId)[0];
  assert.equal(reservation.status, 'reserved');
  assert.equal(reservation.reservedUsd, 0.6);
  assert.throws(() => command('task.create', {title: 'Reserved task B', agentId: 'demo-reviewer'}), /房间费用预算不足/);
  assert.equal(store.list<Task>('tasks', roomId).length, 1);

  const run = store.get<Run>('runs', firstRun.id)!;
  run.usageByGeneration = {1: {costUsd: 0.4}}; run.usage = {costUsd: 0.4}; store.put('runs', run);
  // Settling releases the estimate and counts the actual known cost.
  const {service} = {service: new RoomService(store)};
  service.settleBudgetForRun(run);
  assert.equal(store.list<BudgetReservation>('budget_reservations', roomId)[0].status, 'settled');
  command('task.create', {title: 'Reserved task B', agentId: 'demo-reviewer'});
  assert.equal(store.list<Task>('tasks', roomId).length, 2);
});

test('unknown cost keeps the reservation held until owner reconciles it', t => {
  const {store, roomId, command} = fixture(t);
  command('task.create', {title: 'Unknown cost task', agentId: 'demo-planner'});
  const reservation = store.list<BudgetReservation>('budget_reservations', roomId)[0];
  const run = store.list<Run>('runs', roomId)[0];
  new RoomService(store).settleBudgetForRun(run);
  assert.equal(store.list<BudgetReservation>('budget_reservations', roomId)[0].status, 'unknown');
  assert.throws(() => command('task.create', {title: 'Blocked task', agentId: 'demo-reviewer'}), /房间费用预算不足/);
  const released = command('budget.reconcile', {reservationId: reservation.id, decision: 'release'});
  assert.equal(released.result.status, 'released');
  command('task.create', {title: 'Allowed task', agentId: 'demo-reviewer'});
  assert.equal(store.list<Task>('tasks', roomId).length, 2);
});
