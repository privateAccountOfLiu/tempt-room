import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionBucketKey, discussionWindowMs, ewmaDiscussionDuration, type DiscussionDurationSample } from '../apps/server/src/discussion-windows.ts';

const bucket = {provider: 'codex', adapterFingerprint: 'fp_a', model: 'gpt', taskClass: 'code'};
function sample(durationMs: number, overrides: Partial<DiscussionDurationSample> = {}): DiscussionDurationSample {
  return {...bucket, durationMs, ...overrides};
}

test('discussion windows use a cold-start default and a clamped p95 of real durations', () => {
  assert.equal(discussionWindowMs([], bucket), 90_000);
  const samples = Array.from({length: 100}, (_, index) => sample((index + 1) * 1000));
  assert.equal(discussionWindowMs(samples, bucket), 98_000);
  assert.equal(discussionWindowMs([sample(1_000)], bucket), 15_000);
  assert.equal(discussionWindowMs([sample(999_999)], bucket), 600_000);
});

test('discussion windows isolate adapter/model/task buckets and expose EWMA separately', () => {
  const samples = [sample(20_000), sample(30_000), sample(40_000), sample(50_000, {model: 'other'})];
  assert.equal(discussionWindowMs(samples, {...bucket, model: 'other'}), 50_000);
  assert.equal(discussionWindowMs(samples, {...bucket, adapterFingerprint: 'fp_b'}), 90_000);
  assert.equal(discussionBucketKey(bucket), 'codex|fp_a|gpt|code');
  assert.equal(ewmaDiscussionDuration([sample(20_000), sample(40_000)], bucket, 0.5), 30_000);
  assert.equal(ewmaDiscussionDuration([], bucket), undefined);
});
