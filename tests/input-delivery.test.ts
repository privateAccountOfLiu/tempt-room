import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, SYSTEM, uid } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { InboxService } from '../apps/server/src/inbox.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { AgentSession, InboxDelivery, InputBatch, Run, Subscription, WakeIntent } from '../packages/protocol/src/index.ts';

const parent = resolve('.state/test-data');
function fixture(t: import('node:test').TestContext, withWorker = false, deliveryMode?: 'next-turn' | 'tool-boundary' | 'steer') {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'input-delivery-')), store = new Store(join(root, 'room.sqlite')), service = new RoomService(store), roomId = store.rooms()[0].id;
  const worker = withWorker ? new Worker(store, service, root, {adapter: async function* () { yield {type: 'text', text: 'Input delivered reply'}; }}) : undefined;
  t.after(async () => { await worker?.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const now = new Date().toISOString(), session: AgentSession = {id: 'as_input', roomId, agentId: 'demo-planner', status: 'active', createdAt: now, updatedAt: now};
  store.event(roomId, 'agent_session.created', SYSTEM, {agentSession: session});
  const startSeq = store.room(roomId)!.seq;
  const subscription: Subscription = {id: 'sub_input', roomId, agentSessionId: session.id, eventTypes: ['chat.message.created'], taskIds: [], sourcePolicy: 'explicit', ...(deliveryMode ? {deliveryMode} : {}), enabled: true, scanSeq: startSeq};
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'subscription.set', payload: {subscription}});
  service.execute({version: '0.1', commandId: uid(), roomId, type: 'message.send', payload: {text: 'Provide this input', mentions: ['demo-planner']}});
  new InboxService(store).scan(roomId, session.id);
  const wake = store.list<WakeIntent>('wake_intents', roomId)[0];
  assert.ok(wake);
  service.dispatchPendingWakes();
  const run = store.list<Run>('runs', roomId).find(item => item.agentSessionId === session.id)!;
  return {root, store, service, worker, roomId, session, run};
}

test('input batch persists deliveries, provides them, and acknowledges only the right session', t => {
  const {store, service, roomId, session, run} = fixture(t);
  const batch = service.inputDelivery.createBatch({roomId, agentSessionId: session.id, runId: run.id, generation: 1, executionId: uid('exec')})!;
  assert.equal(batch.status, 'created');
  assert.ok(batch.deliveryIds.length >= 1);
  assert.ok(store.list<InboxDelivery>('inbox_deliveries', roomId).every(delivery => delivery.status === 'batched' && delivery.batchId === batch.id));
  assert.equal(service.inputDelivery.createBatch({roomId, agentSessionId: session.id, runId: run.id, generation: 1, executionId: uid('exec')}), undefined);
  const provided = service.inputDelivery.provideBatch(roomId, batch.id, 'unit-provided');
  assert.equal(provided.status, 'provided');
  assert.ok(store.list<InputBatch>('input_batches', roomId).some(item => item.id === batch.id && item.status === 'provided'));
  const agentAck = service.execute({version: '0.1', commandId: uid(), roomId, type: 'input.ack', payload: {batchId: batch.id, agentSessionId: session.id, receiptEvidence: 'agent-confirmed'}}, {id: 'demo-planner', kind: 'agent'});
  assert.equal(agentAck.result.status, 'acknowledged');
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'input.ack', payload: {batchId: batch.id, agentSessionId: session.id}}, {id: 'demo-reviewer', kind: 'agent'}), /自己的输入批次/);
  assert.throws(() => service.inputDelivery.acknowledgeBatch(roomId, batch.id, 'other_session', 'bad'), /不属于/);
});

test('worker creates and provides an input batch before running a wake-dispatched run', async t => {
  const {store, worker, roomId, session, run} = fixture(t, true);
  worker!.tick();
  const deadline = Date.now() + 10000;
  let current = store.get<Run>('runs', run.id)!;
  while (Date.now() < deadline && current.status !== 'completed') {
    worker!.tick();
    await new Promise(done => setTimeout(done, 25));
    current = store.get<Run>('runs', run.id)!;
  }
  assert.equal(current.status, 'completed', current.error);
  assert.ok(current.inputBatchId);
  const batch = store.list<InputBatch>('input_batches', roomId).find(item => item.id === current.inputBatchId);
  assert.ok(batch);
  assert.equal(batch.status, 'provided');
  assert.equal(batch.agentSessionId, session.id);
  assert.ok(store.list<InboxDelivery>('inbox_deliveries', roomId).every(delivery => delivery.status === 'provided'));
});

test('tool-boundary delivery mode reaches the run and injects input at a tool boundary', async t => {
  const {store, service, worker, roomId, session, run} = fixture(t, true, 'tool-boundary');
  assert.equal(run.inputDeliveryMode, 'tool-boundary');
  const pending = store.list<InboxDelivery>('inbox_deliveries', roomId).filter(delivery => delivery.agentSessionId === session.id);
  assert.equal(pending.length, 1);
  assert.equal(store.list('input_batches', roomId).length, 0);
  const result = (worker as any).attachToolBoundaryInput(run, {ok: true});
  assert.ok(result.inputBatch?.id);
  const batch = store.list<InputBatch>('input_batches', roomId).find(item => item.id === result.inputBatch.id)!;
  assert.equal(batch.deliveryMode, 'tool-boundary');
  assert.equal(batch.status, 'provided');
  assert.equal(store.list<InboxDelivery>('inbox_deliveries', roomId).find(delivery => delivery.id === pending[0].id)!.status, 'provided');
});

test('owner can reconcile an uncertain input batch to unknown and expire it', t => {
  const {store, service, roomId, session, run} = fixture(t);
  const batch = service.inputDelivery.createBatch({roomId, agentSessionId: session.id, runId: run.id, generation: 1, executionId: uid('exec')})!;
  const unknown = service.execute({version: '0.1', commandId: uid(), roomId, type: 'input.reconcile', payload: {batchId: batch.id, decision: 'unknown'}});
  assert.equal(unknown.result.status, 'unknown');
  assert.equal(store.list<InputBatch>('input_batches', roomId).find(item => item.id === batch.id)!.status, 'unknown');
  const expired = service.execute({version: '0.1', commandId: uid(), roomId, type: 'input.reconcile', payload: {batchId: batch.id, decision: 'expire'}});
  assert.equal(expired.result.status, 'expired');
  assert.ok(store.list<InboxDelivery>('inbox_deliveries', roomId).every(delivery => delivery.status === 'expired'));
  assert.throws(() => service.execute({version: '0.1', commandId: uid(), roomId, type: 'input.reconcile', payload: {batchId: batch.id, decision: 'expire'}}, {id: 'demo-planner', kind: 'agent'}), /owner|Agent 无权/);
});
