import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid, now } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import { createControllableAdapter } from './helpers/controllable-adapter.ts';
import type { Integration, Room, Run, Task } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');

function fixture(t: import('node:test').TestContext, adapter: any = async function* () { yield {type: 'text', text: 'done'}; }) {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'room-deletion-'));
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {adapter});
  t.after(async () => { await worker.close(); try { store.close(); } catch { /* closed */ } rmSync(root, {recursive: true, force: true}); });
  const roomId = store.rooms()[0].id;
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  return {root, store, service, worker, roomId, command};
}
type Ctx = ReturnType<typeof fixture>;

async function waitUntil(check: () => boolean, message: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(message);
}

test('afterCommit side effects run only after a successful commit', t => {
  const ctx = fixture(t);
  const order: string[] = [];
  ctx.store.atomic(() => {
    ctx.store.event(ctx.roomId, 'audit.recorded', SYSTEM, {action: 'after-commit-test'});
    ctx.store.afterCommit(() => order.push('committed'));
  });
  assert.deepEqual(order, ['committed']);
  assert.throws(() => ctx.store.atomic(() => {
    ctx.store.afterCommit(() => order.push('rolled-back'));
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.deepEqual(order, ['committed'], 'rolled-back afterCommit callbacks must be discarded');
});

test('deleting an idle room is idempotent and the Worker finalizer persists room.deleted', t => {
  const ctx = fixture(t);
  const first = ctx.command('room.delete', {expectedRevision: 1});
  assert.equal(first.result.status, 'deleting');
  const statusAfterCommit = ctx.store.room(ctx.roomId)!.status;
  assert.ok(statusAfterCommit === 'deleting' || statusAfterCommit === 'deleted', 'the post-commit finalizer may finish an idle room immediately');
  const second = ctx.command('room.delete', {expectedRevision: 1});
  assert.equal(second.result.status, statusAfterCommit);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'room.deleting').length, 1);
  ctx.worker.tick();
  const deleted = ctx.store.room(ctx.roomId)!;
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.revision, 3, 'deleting request bumps once, finalizer bumps once');
  assert.ok(deleted.deletion?.deletedAt);
  assert.equal(ctx.store.events(ctx.roomId).filter(event => event.type === 'room.deleted').length, 1);
  assert.throws(() => ctx.command('message.send', {text: 'after deletion'}), /房间正在删除或已删除/);
  assert.equal(ctx.command('room.delete', {expectedRevision: 1}).result.status, 'deleted');
});

test('deleting a room cancels its queued work and the finalizer completes once handles are gone', t => {
  const ctx = fixture(t);
  const taskId = ctx.command('task.create', {title: 'queued deletion task', agentId: 'demo-planner'}).result.taskId as string;
  const run = ctx.store.list<Run>('runs', ctx.roomId).find(item => item.taskId === taskId)!;
  assert.equal(run.status, 'queued');
  ctx.command('room.delete', {expectedRevision: 1});
  assert.equal(ctx.store.get<Run>('runs', run.id)!.status, 'canceled');
  assert.equal(ctx.store.get<Task>('tasks', taskId)!.status, 'canceled');
  ctx.worker.tick();
  assert.equal(ctx.store.room(ctx.roomId)!.status, 'deleted');
});

test('an active process keeps the room deleting until it is aborted, then the finalizer deletes it', t => {
  const {adapter, probe} = createControllableAdapter();
  const ctx = fixture(t, adapter);
  const taskId = ctx.command('task.create', {title: 'running deletion task', agentId: 'demo-planner'}).result.taskId as string;
  ctx.worker.tick();
  return (async () => {
    const entered = (await probe.waitForEntered(1))[0];
    ctx.command('room.delete', {expectedRevision: 1});
    const run = ctx.store.list<Run>('runs', ctx.roomId).find(item => item.taskId === taskId)!;
    assert.equal(ctx.store.get<Run>('runs', run.id)!.status, 'cancel_requested');
    ctx.worker.tick();
    assert.equal(ctx.store.room(ctx.roomId)!.status, 'deleting', 'an active process must keep the room in deleting');
    assert.ok((ctx.store.room(ctx.roomId)!.deletion?.pendingReasons ?? []).includes('active_process'));
    probe.release(entered.runId);
    await waitUntil(() => ['canceled', 'interrupted', 'unknown'].includes(ctx.store.get<Run>('runs', run.id)?.status ?? ''), 'run reached a terminal state after abort');
    await waitUntil(() => { ctx.worker.tick(); return ctx.store.room(ctx.roomId)!.status === 'deleted'; }, 'room deleted after process cleanup');
  })();
});

test('an unresolved apply journal keeps the room deleting with stable pending reason', t => {
  const ctx = fixture(t);
  const integration: Integration = {id: 'integration_deleting_apply', roomId: ctx.roomId, artifactId: 'artifact_missing_but_irrelevant', status: 'applying', authorization: 'auto', requestActor: 'owner', createdAt: now(), updatedAt: now()};
  ctx.store.event(ctx.roomId, 'integration.updated', SYSTEM, {integration});
  ctx.command('room.delete', {expectedRevision: 1});
  ctx.worker.tick();
  const pending = ctx.store.room(ctx.roomId)!;
  assert.equal(pending.status, 'deleting');
  assert.ok(pending.deletion?.pendingReasons.includes('apply_journal_unresolved'));
  const updatedEvents = ctx.store.events(ctx.roomId).filter(event => event.type === 'room.deletion.updated');
  assert.ok(updatedEvents.length >= 1);
  ctx.store.event(ctx.roomId, 'integration.updated', SYSTEM, {integration: {...integration, status: 'blocked', errorCode: 'room_deleting', updatedAt: now()}});
  ctx.worker.tick();
  assert.equal(ctx.store.room(ctx.roomId)!.status, 'deleted');
});
