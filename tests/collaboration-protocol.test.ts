import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentSessionSchema,
  capabilityEvidenceSchema,
  commandSchema,
  discussionSchema,
  inboxDeliverySchema,
  inputBatchSchema,
  runSchema,
  subscriptionSchema,
  wakeIntentSchema
} from '../packages/protocol/src/index.ts';

const now = '2026-10-19T00:00:00.000Z';

test('B01 collaboration objects parse with strict schemas', () => {
  const session = agentSessionSchema.parse({id: 'as_1', roomId: 'room_1', agentId: 'agent_1', status: 'active', adapterFingerprint: 'fp_1', createdAt: now, updatedAt: now});
  assert.equal(session.status, 'active');
  const subscription = subscriptionSchema.parse({id: 'sub_1', roomId: 'room_1', agentSessionId: 'as_1', eventTypes: ['chat.message.created'], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: 0});
  assert.equal(subscription.sourcePolicy, 'explicit');
  const delivery = inboxDeliverySchema.parse({id: 'del_1', agentSessionId: 'as_1', sourceEventId: 'evt_1', sourceSeq: 3, status: 'pending'});
  assert.equal(delivery.status, 'pending');
  const batch = inputBatchSchema.parse({id: 'batch_1', agentSessionId: 'as_1', runId: 'run_1', generation: 1, executionId: 'exec_1', deliveryIds: ['del_1'], sourceEventIds: ['evt_1'], fromScanSeq: 0, throughScanSeq: 3, payloadHash: 'a'.repeat(64), deliveryMode: 'next-turn', createdAt: now, status: 'created'});
  assert.equal(batch.deliveryMode, 'next-turn');
  const wake = wakeIntentSchema.parse({id: 'wake_1', discussionId: 'disc_1', roundId: 'round_1', agentSessionId: 'as_1', sourceEventId: 'evt_1', status: 'pending'});
  assert.equal(wake.status, 'pending');
  const evidence = capabilityEvidenceSchema.parse({fingerprint: 'fp_1', capability: 'steerDuringRun', state: 'verified_unsupported', mode: 'simulated', testedAt: now, suiteVersion: 'sim-v1', evidenceHash: 'b'.repeat(64)});
  assert.equal(evidence.state, 'verified_unsupported');
  for (const [schema, invalid] of [
    [agentSessionSchema, {...session, unexpected: true}],
    [subscriptionSchema, {...subscription, unexpected: true}],
    [inboxDeliverySchema, {...delivery, unexpected: true}],
    [inputBatchSchema, {...batch, unexpected: true}],
    [wakeIntentSchema, {...wake, unexpected: true}],
    [capabilityEvidenceSchema, {...evidence, unexpected: true}]
  ] as const) assert.throws(() => (schema as any).parse(invalid));
});

test('B01 extends Run/Discussion without breaking legacy payloads', () => {
  const legacyRun = runSchema.parse({id: 'run_1', roomId: 'room_1', agentId: 'agent_1', status: 'queued', prompt: 'legacy', basedOnSeq: 0, createdAt: now, updatedAt: now});
  assert.equal(legacyRun.status, 'queued');
  assert.equal(legacyRun.agentSessionId, undefined);
  const extendedRun = runSchema.parse({id: 'run_2', roomId: 'room_1', agentId: 'agent_1', status: 'queued', prompt: 'extended', basedOnSeq: 0, createdAt: now, updatedAt: now, agentSessionId: 'as_1', inputBatchId: 'batch_1', operationScopeId: 'scope_1', responseSlotId: 'slot_1', startedAt: now, finishedAt: now, adapterFingerprint: 'fp_1'});
  assert.equal(extendedRun.agentSessionId, 'as_1');
  const legacyDiscussion = discussionSchema.parse({id: 'disc_1', roomId: 'room_1', goal: 'goal', participants: ['a'], rounds: 1, round: 1, maxResponses: 1, responses: 0, deadline: now, status: 'active'});
  assert.equal(legacyDiscussion.status, 'active');
  const paused = discussionSchema.parse({...legacyDiscussion, status: 'paused', triggerPolicy: 'explicit', activationLimit: 18, activationsUsed: 0, roundWindowMs: 90000, activeRoundId: 'round_1', authorizationRef: 'owner:1', lifecycleVersion: 1});
  assert.equal(paused.status, 'paused');
  assert.throws(() => discussionSchema.parse({...legacyDiscussion, status: 'unknown'}));
});

test('B01 command schemas are strict and old commands keep parsing', () => {
  const envelope = {version: '0.1', commandId: 'cmd_1', roomId: 'room_1'};
  assert.equal(commandSchema.parse({...envelope, type: 'discussion.pause', payload: {discussionId: 'disc_1'}}).type, 'discussion.pause');
  assert.equal(commandSchema.parse({...envelope, type: 'discussion.resume', payload: {discussionId: 'disc_1'}}).type, 'discussion.resume');
  const subscription = {id: 'sub_1', roomId: 'room_1', agentSessionId: 'as_1', eventTypes: ['chat.message.created'], taskIds: [], sourcePolicy: 'explicit', enabled: true, scanSeq: 0};
  assert.equal(commandSchema.parse({...envelope, type: 'subscription.set', payload: {subscription}}).type, 'subscription.set');
  assert.equal(commandSchema.parse({...envelope, type: 'input.ack', payload: {batchId: 'batch_1', agentSessionId: 'as_1'}}).type, 'input.ack');
  assert.equal(commandSchema.parse({...envelope, type: 'discussion.stop', payload: {discussionId: 'disc_1'}}).type, 'discussion.stop');
  assert.throws(() => commandSchema.parse({...envelope, type: 'discussion.pause', payload: {discussionId: 'disc_1', unknown: true}}));
  assert.throws(() => commandSchema.parse({...envelope, type: 'discussion.pause', payload: {}}));
  assert.throws(() => commandSchema.parse({...envelope, type: 'subscription.set', payload: {subscription: {...subscription, unexpected: true}}}));
});
