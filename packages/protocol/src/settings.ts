import { z } from 'zod';
import {contextPolicySchema} from './reconciliation.ts';
export const runLimitsSchema=z.object({memoryMb:z.number().int().min(256).max(16384),maxProcesses:z.number().int().min(1).max(128),timeoutMs:z.number().int().min(1000).max(7200000)}).strict();
export type RunLimits=z.infer<typeof runLimitsSchema>;
export const executionSettingsSchema=z.object({
  contextPolicy:contextPolicySchema.default(()=>contextPolicySchema.parse({})),
  concurrency:z.number().int().min(1).max(8).default(2),
  memoryMb:z.number().int().min(256).max(16384).default(4096),
  maxProcesses:z.number().int().min(1).max(128).default(64),
  taskTimeoutMs:z.number().int().min(1000).max(7200000).default(1800000),
  chatTimeoutMs:z.number().int().min(1000).max(7200000).default(300000),
  taskLeaseMs:z.number().int().min(5000).max(86400000).default(600000)
}).strict();
export type ExecutionSettings=z.infer<typeof executionSettingsSchema>;
export const defaultExecutionSettings:ExecutionSettings=executionSettingsSchema.parse({});
