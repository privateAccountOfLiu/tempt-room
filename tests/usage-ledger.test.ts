import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, dedupeUsageSamples } from '../apps/server/src/usage.ts';
import type { UsageSample } from '../packages/protocol/src/index.ts';

const stamp = new Date().toISOString();
function sample(partial: Partial<UsageSample> & Pick<UsageSample, 'id' | 'runId' | 'scope'>): UsageSample {
  return {roomId: 'room_1', executionId: 'exec_1', provider: 'codex', counterEpoch: 1, source: 'adapter', observedAt: stamp, ...partial};
}

test('duplicate request notifications count once and multi-run samples accumulate', () => {
  const duplicate = sample({id: 'u1', runId: 'run_1', scope: 'last-request', requestId: 'request_1', inputTokens: 10, outputTokens: 4});
  const unique = dedupeUsageSamples([duplicate, {...duplicate, id: 'u1_retry'}]);
  assert.equal(unique.length, 1);
  const aggregate = aggregateUsage([duplicate, {...duplicate, id: 'u1_retry'}, sample({id: 'u2', runId: 'run_2', scope: 'run', inputTokens: 20, outputTokens: 5, costUsd: 0.02})]);
  assert.equal(aggregate.inputTokens, 30);
  assert.equal(aggregate.outputTokens, 9);
  assert.equal(aggregate.costUsd, 0.02);
  assert.equal(aggregate.deduped, 1);
  assert.equal(aggregate.unknown.costUsd, true);
  const complete = aggregateUsage([sample({id: 'u3', runId: 'run_3', scope: 'run', inputTokens: 2, outputTokens: 3, costUsd: 0.01})]);
  assert.equal(complete.unknown.costUsd, false);
});

test('session totals use monotonic deltas and counter resets never go negative', () => {
  const first = aggregateUsage([
    sample({id: 's1', runId: 'run_1', scope: 'session-total', nativeSessionId: 'session_1', counterEpoch: 1, inputTokens: 100, outputTokens: 30, observedAt: '2026-10-20T00:00:00.000Z'}),
    sample({id: 's2', runId: 'run_2', scope: 'session-total', nativeSessionId: 'session_1', counterEpoch: 1, inputTokens: 130, outputTokens: 40, observedAt: '2026-10-20T00:01:00.000Z'})
  ]);
  assert.equal(first.inputTokens, 130);
  assert.equal(first.outputTokens, 40);
  const reset = aggregateUsage([
    sample({id: 'r1', runId: 'run_1', scope: 'session-total', nativeSessionId: 'session_1', counterEpoch: 1, inputTokens: 100, observedAt: '2026-10-20T00:00:00.000Z'}),
    sample({id: 'r2', runId: 'run_2', scope: 'session-total', nativeSessionId: 'session_1', counterEpoch: 2, inputTokens: 20, observedAt: '2026-10-20T00:01:00.000Z'})
  ]);
  assert.equal(reset.inputTokens, 120);
  assert.ok((reset.inputTokens ?? 0) >= 0);
});

test('missing metrics stay unknown instead of displaying zero', () => {
  const aggregate = aggregateUsage([sample({id: 'u1', runId: 'run_1', scope: 'run', inputTokens: 12})]);
  assert.equal(aggregate.inputTokens, 12);
  assert.equal(aggregate.outputTokens, undefined);
  assert.equal(aggregate.costUsd, undefined);
  assert.deepEqual(aggregate.unknown, {inputTokens: false, outputTokens: true, costUsd: true});
});
