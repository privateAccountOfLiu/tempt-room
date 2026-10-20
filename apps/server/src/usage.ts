import type { UsageSample } from '../../../packages/protocol/src/index.ts';

export interface UsageAggregate {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  unknown: {inputTokens: boolean; outputTokens: boolean; costUsd: boolean};
  sampleCount: number;
  deduped: number;
  byScope: {run: number; lastRequest: number; sessionTotal: number};
}
export interface UsageDelta { key: string; inputTokens?: number; outputTokens?: number; costUsd?: number }

/** Deterministic identity: duplicate notifications must not count twice. */
export function usageSampleIdentity(sample: UsageSample): string {
  if (sample.requestId) return `${sample.provider}:${sample.nativeSessionId ?? sample.runId}:request:${sample.requestId}`;
  if (sample.turnId) return `${sample.provider}:${sample.nativeSessionId ?? sample.runId}:turn:${sample.turnId}:${sample.itemId ?? ''}`;
  return sample.id;
}

export function dedupeUsageSamples(samples: readonly UsageSample[]): UsageSample[] {
  const seen = new Set<string>();
  return samples.filter(sample => {
    const key = usageSampleIdentity(sample);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addKnown(target: {value?: number; unknown: boolean}, value: number | undefined) {
  if (value === undefined) target.unknown = true;
  else target.value = (target.value ?? 0) + value;
}

/**
 * run/last-request samples accumulate; session-total samples are monotonic
 * deltas per session+epoch. A counter reset starts a new baseline, never a
 * negative total.
 */
export function aggregateUsage(samples: readonly UsageSample[]): UsageAggregate {
  const unique = dedupeUsageSamples(samples).slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const input = {value: undefined as number | undefined, unknown: false};
  const output = {value: undefined as number | undefined, unknown: false};
  const cost = {value: undefined as number | undefined, unknown: false};
  const session = new Map<string, UsageSample>();
  const byScope = {run: 0, lastRequest: 0, sessionTotal: 0};
  for (const sample of unique) {
    if (sample.scope === 'session-total') {
      byScope.sessionTotal++;
      const key = `${sample.provider}:${sample.nativeSessionId ?? sample.runId}:${sample.counterEpoch}`;
      const previous = session.get(key);
      addKnown(input, previous && sample.inputTokens !== undefined && previous.inputTokens !== undefined ? Math.max(0, sample.inputTokens - previous.inputTokens) : sample.inputTokens);
      addKnown(output, previous && sample.outputTokens !== undefined && previous.outputTokens !== undefined ? Math.max(0, sample.outputTokens - previous.outputTokens) : sample.outputTokens);
      addKnown(cost, previous && sample.costUsd !== undefined && previous.costUsd !== undefined ? Math.max(0, sample.costUsd - previous.costUsd) : sample.costUsd);
      session.set(key, sample);
    } else {
      if (sample.scope === 'run') byScope.run++; else byScope.lastRequest++;
      addKnown(input, sample.inputTokens);
      addKnown(output, sample.outputTokens);
      addKnown(cost, sample.costUsd);
    }
  }
  return {inputTokens: input.value, outputTokens: output.value, costUsd: cost.value, unknown: {inputTokens: input.unknown, outputTokens: output.unknown, costUsd: cost.unknown}, sampleCount: unique.length, deduped: samples.length - unique.length, byScope};
}
