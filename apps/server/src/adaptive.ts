/**
 * Adaptive timeout window derived from completed run durations.
 *
 * The configured timeout remains a hard cap; history can only lower the
 * effective timeout for a bucket, never extend it. Buckets are intentionally
 * coarse: one agent and one run category (task vs chat). Providers and models
 * change over time, so the last few samples are used with an EWMA and a floor.
 */
export interface TimeoutSample {
  agentId: string;
  taskId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface AdaptiveTimeoutOptions {
  minSamples?: number;
  alpha?: number;
  factor?: number;
  floorMs?: number;
  maxSamples?: number;
}
export function adaptiveTimeoutMs(
  runs: readonly TimeoutSample[],
  agentId: string,
  kind: 'task' | 'chat',
  baseTimeoutMs: number,
  options: AdaptiveTimeoutOptions = {}
): number {
  const minSamples = options.minSamples ?? 2;
  const alpha = options.alpha ?? 0.3;
  const factor = options.factor ?? 3;
  const floorMs = options.floorMs ?? 30_000;
  const maxSamples = options.maxSamples ?? 8;
  const durations = runs
    .filter(run => run.agentId === agentId && run.status === 'completed' && (kind === 'task' ? Boolean(run.taskId) : !run.taskId))
    .map(run => Date.parse(run.updatedAt) - Date.parse(run.createdAt))
    .filter(duration => Number.isFinite(duration) && duration > 0)
    .slice(-maxSamples);
  if (durations.length < minSamples) return baseTimeoutMs;
  let ewma = durations[0];
  for (const duration of durations.slice(1)) ewma = alpha * duration + (1 - alpha) * ewma;
  return Math.max(Math.min(baseTimeoutMs, floorMs), Math.min(baseTimeoutMs, Math.round(ewma * factor)));
}
