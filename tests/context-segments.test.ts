import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextSegments, ContextSegmentTooLarge } from '../apps/server/src/context-segments.ts';

const run = {id: 'run_ctx', roomId: 'room_ctx', agentId: 'demo-planner', status: 'running', prompt: '实现受控集成并保证不破坏基线', basedOnSeq: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} as any;
function context(messageCount: number, decision = '只允许 owner 授权的集成') {
  return {
    fromSeq: 1, throughSeq: 5 + messageCount,
    decisions: [{id: 'dec_1', text: decision, accepted: true, actor: {id: 'owner', kind: 'human'}}],
    members: [],
    messages: Array.from({length: messageCount}, (_, index) => ({id: `msg_${index}`, roomId: 'room_ctx', actor: {id: 'demo-planner', kind: 'agent'}, text: '历史消息'.repeat(120), createdAt: new Date().toISOString()}))
  } as any;
}

test('early accepted constraints survive when recent history is truncated', () => {
  const segments = buildContextSegments(run, context(300), undefined, {totalBudgetBytes: 20_000, historyBudgetBytes: 2_000});
  const constraints = segments.find(segment => segment.kind === 'constraints')!;
  const history = segments.find(segment => segment.kind === 'history')!;
  assert.match(constraints.text, /只允许 owner 授权的集成/);
  assert.equal(constraints.truncated, false);
  assert.equal(history.truncated, true);
  assert.ok(history.omitted > 0);
  assert.ok(history.bytes <= 2_000);
  assert.equal(segments.find(segment => segment.kind === 'objective')!.text, run.prompt);
});

test('oversized fixed constraints fail instead of being silently consumed', () => {
  assert.throws(() => buildContextSegments(run, context(1, 'x'.repeat(50_000)), undefined, {constraintsBudgetBytes: 1_000}), (error: unknown) => error instanceof ContextSegmentTooLarge && error.code === 'context_segment_too_large' && error.segment === 'constraints');
});

test('segment hashes and byte counts are deterministic', () => {
  const first = buildContextSegments(run, context(10)), second = buildContextSegments(run, context(10));
  assert.deepEqual(first.map(segment => segment.hash), second.map(segment => segment.hash));
  assert.deepEqual(first.map(segment => segment.bytes), second.map(segment => segment.bytes));
  assert.deepEqual(first.map(segment => segment.kind), ['objective', 'constraints', 'related', 'history']);
});

test('related segment records project baseline evidence without inventing external versions', () => {
  const projected = {...run, taskId: 'task_ctx', taskVersion: 2, sourceCommit: 'a'.repeat(40), dirtyBaselineHash: 'b'.repeat(64), projectBindingId: 'binding_1', bindingVersion: 3};
  const segments = buildContextSegments(projected, context(0));
  const related = segments.find(segment => segment.kind === 'related')!;
  assert.match(related.text, /sourceCommit=/);
  assert.match(related.text, /dirtyBaselineHash=/);
  assert.match(related.text, /bindingVersion=3/);
  assert.equal(related.truncated, false);
});
