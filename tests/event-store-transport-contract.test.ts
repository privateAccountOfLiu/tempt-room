import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {Store, uid} from '../apps/server/src/store.ts';
import type {EventStore} from '../apps/server/src/ports/event-store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import type {AgentOutput} from '../packages/protocol/src/index.ts';
import type {AdapterContext} from '../apps/server/src/adapters.ts';
import type {AgentTransport} from '../apps/server/src/ports/agent-transport.ts';

const parent = resolve('.state/test-data');

function collaboration(store: EventStore, roomId: string) {
  const service = new RoomService(store);
  const command = (type: string, payload: unknown) => service.execute({version: '0.1', commandId: uid(), roomId, type, payload});
  command('message.send', {text: 'contract hello'});
  const task = command('task.create', {title: 'contract task', agentId: 'demo-planner'}).result as {taskId: string};
  return {service, task};
}

test('SQLite file and in-memory stores satisfy the same event-store contract', t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'event-store-contract-'));
  const fileStore = new Store(join(root, 'room.sqlite'));
  const memoryStore = new Store(':memory:');
  t.after(() => { fileStore.close(); memoryStore.close(); rmSync(root, {recursive: true, force: true}); });
  const results = [fileStore, memoryStore].map(store => {
    const roomId = store.rooms()[0]!.id;
    const {task} = collaboration(store, roomId);
    const room = store.room(roomId)!;
    const firstPage = store.events(roomId, 0, 1);
    assert.equal(firstPage.length, 1);
    assert.ok(firstPage[0]!.seq >= 1);
    const scanned = [...store.scanEvents(roomId, {afterSeq: 0, pageSize: 2})];
    assert.equal(scanned.length, room.seq);
    assert.equal(typeof store.projectionStatus(roomId).historyFloor, 'number');
    assert.notEqual(store.projectionBytes(roomId), '0 B');
    const snapshot = store.snapshot(roomId);
    store.rebuildProjections(roomId);
    assert.equal(store.snapshot(roomId).room.seq, snapshot.room.seq);
    return {roomSeq: room.seq, messages: snapshot.messages.length, tasks: snapshot.tasks.length, taskId: task.taskId, types: scanned.map(event => event.type)};
  });
  assert.equal(results[0]!.roomSeq, results[1]!.roomSeq);
  assert.equal(results[0]!.messages, results[1]!.messages);
  assert.equal(results[0]!.tasks, results[1]!.tasks);
  assert.deepEqual(results[0]!.types, results[1]!.types);
});

function fixture(root: string, transport: AgentTransport) {
  const store = new Store(join(root, 'room.sqlite'));
  const service = new RoomService(store);
  const worker = new Worker(store, service, root, {transport});
  return {store, service, worker, roomId: store.rooms()[0]!.id};
}

async function runChat(worker: Worker, service: RoomService, store: Store, roomId: string) {
  const run = service.enqueue(roomId, 'demo-planner', 'transport contract', store.room(roomId)!.seq);
  run.status = 'running'; run.executionId = uid('execution');
  store.event(roomId, 'run.started', {id: 'system', kind: 'system'}, {run});
  await (worker as any).execute(run, new AbortController());
  return store.get<any>('runs', run.id)!;
}

test('transport fixtures replace adapter execution without changing the run state machine', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'transport-contract-'));
  const seen: string[] = [];
  const transport: AgentTransport = {
    openExecution(context: AdapterContext) {
      async function* outputs(): AsyncIterable<AgentOutput> {
        seen.push(context.prompt);
        yield {type: 'text', text: 'TRANSPORT_FIXTURE_OK'};
      }
      return {outputs: outputs()};
    }
  };
  const {store, service, worker, roomId} = fixture(root, transport);
  t.after(async () => {await worker.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const completed = await runChat(worker, service, store, roomId);
  assert.equal(completed.status, 'completed');
  assert.equal(seen.length, 1);
  assert.ok(store.list<any>('messages', roomId).some(message => message.text === 'TRANSPORT_FIXTURE_OK'));
  const failing: AgentTransport = {openExecution() {return {outputs: (async function* () {throw new Error('FIXTURE_FAILURE');})()};}};
  const failingFixture = fixture(root + '-fail', failing);
  t.after(async () => {await failingFixture.worker.close(); failingFixture.store.close(); rmSync(root + '-fail', {recursive: true, force: true});});
  const failed = await runChat(failingFixture.worker, failingFixture.service, failingFixture.store, failingFixture.roomId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /FIXTURE_FAILURE/);
});
