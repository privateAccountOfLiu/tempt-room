import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const time = z.string().datetime();
export const usageScopeSchema = z.enum(['run', 'last-request', 'session-total']);
export const usageSourceSchema = z.enum(['adapter', 'native', 'manual']);

export const usageSampleSchema = z.object({
  id,
  roomId: id,
  runId: id,
  executionId: id,
  provider: z.string().min(1).max(100),
  nativeSessionId: z.string().max(500).optional(),
  turnId: z.string().max(500).optional(),
  requestId: z.string().max(500).optional(),
  itemId: z.string().max(500).optional(),
  scope: usageScopeSchema,
  counterEpoch: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  source: usageSourceSchema,
  observedAt: time
}).strict();
export type UsageSample = z.infer<typeof usageSampleSchema>;
export type UsageScope = z.infer<typeof usageScopeSchema>;
