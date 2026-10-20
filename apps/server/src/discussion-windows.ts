export interface DiscussionDurationSample {
  durationMs: number;
  provider: string;
  adapterFingerprint: string;
  model?: string;
  taskClass: string;
}

export interface DiscussionWindowConfig {
  defaultMs: number;
  minMs: number;
  maxMs: number;
  sampleLimit: number;
  quantile: number;
}

export const defaultDiscussionWindowConfig: DiscussionWindowConfig = {
  defaultMs: 90_000,
  minMs: 15_000,
  maxMs: 10 * 60_000,
  sampleLimit: 50,
  quantile: 0.95
};

export function isDiscussionWindowExpired(round: {windowDeadline?: string}, nowMs = Date.now()): boolean {
  if (!round.windowDeadline) return false;
  const deadline = Date.parse(round.windowDeadline);
  return Number.isFinite(deadline) && deadline <= nowMs;
}

export function discussionBucketKey(sample: Pick<DiscussionDurationSample, 'provider' | 'adapterFingerprint' | 'model' | 'taskClass'>): string {
  return [sample.provider, sample.adapterFingerprint, sample.model ?? '', sample.taskClass].join('|');
}

/** P95 of real execution durations in one adapter/model/task bucket. EWMA is a
 * separate smoother; this function never labels an EWMA mean as a p95. */
export function discussionWindowMs(samples: readonly DiscussionDurationSample[], bucket: Pick<DiscussionDurationSample, 'provider' | 'adapterFingerprint' | 'model' | 'taskClass'>, config: DiscussionWindowConfig = defaultDiscussionWindowConfig): number {
  const key = discussionBucketKey(bucket);
  const durations = samples
    .filter(sample => durationSafe(sample.durationMs) && discussionBucketKey(sample) === key)
    .slice(-config.sampleLimit)
    .map(sample => sample.durationMs)
    .sort((left, right) => left - right);
  if (!durations.length) return clamp(config.defaultMs, config);
  const rank = Math.min(durations.length - 1, Math.max(0, Math.ceil(config.quantile * durations.length) - 1));
  return clamp(durations[rank], config);
}

export function ewmaDiscussionDuration(samples: readonly DiscussionDurationSample[], bucket: Pick<DiscussionDurationSample, 'provider' | 'adapterFingerprint' | 'model' | 'taskClass'>, alpha = 0.25): number | undefined {
  const key = discussionBucketKey(bucket);
  const durations = samples.filter(sample => durationSafe(sample.durationMs) && discussionBucketKey(sample) === key).map(sample => sample.durationMs);
  if (!durations.length) return undefined;
  let value = durations[0];
  for (const duration of durations.slice(1)) value = alpha * duration + (1 - alpha) * value;
  return Math.round(value);
}

function durationSafe(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, config: DiscussionWindowConfig): number {
  return Math.round(Math.min(config.maxMs, Math.max(config.minMs, value)));
}
