import { z } from 'zod';
import {contextPolicySchema} from './reconciliation.ts';
export const runLimitsSchema=z.object({memoryMb:z.number().int().min(256).max(16384),maxProcesses:z.number().int().min(1).max(128),timeoutMs:z.number().int().min(1000).max(7200000),tokenBudget:z.number().int().min(0).max(100000000).default(0),costBudgetUsd:z.number().min(0).max(1000000).default(0)}).strict();
export type RunLimits=z.infer<typeof runLimitsSchema>;
export const executionSettingsSchema=z.object({
  contextPolicy:contextPolicySchema.default(()=>contextPolicySchema.parse({})),
  concurrency:z.number().int().min(1).max(8).default(2),
  memoryMb:z.number().int().min(256).max(16384).default(4096),
  maxProcesses:z.number().int().min(1).max(128).default(64),
  taskTimeoutMs:z.number().int().min(1000).max(7200000).default(1800000),
  chatTimeoutMs:z.number().int().min(1000).max(7200000).default(300000),
  taskLeaseMs:z.number().int().min(5000).max(86400000).default(600000),
  tokenBudget:z.number().int().min(0).max(100000000).default(0),
  costBudgetUsd:z.number().min(0).max(1000000).default(0)
}).strict();
export type ExecutionSettings=z.infer<typeof executionSettingsSchema>;
export const defaultExecutionSettings:ExecutionSettings=executionSettingsSchema.parse({});
export type BudgetUsage={inputTokens?:number;outputTokens?:number;costUsd?:number};
/**
 * Hard budget check for one logical run. A budget of 0 means unlimited. Only
 * reported values count as known; unknown provider usage is never treated as 0,
 * so it can neither trigger a false stop nor silently satisfy a budget.
 */
export function budgetError(limits:Partial<RunLimits>|undefined,usageByGeneration:Record<string,BudgetUsage|undefined>|undefined):string|undefined{
  let tokens=0,cost=0,tokenKnown=false,costKnown=false;
  for(const usage of Object.values(usageByGeneration??{})){
    if(!usage)continue;
    if(usage.inputTokens!==undefined||usage.outputTokens!==undefined){tokens+=(usage.inputTokens??0)+(usage.outputTokens??0);tokenKnown=true;}
    if(usage.costUsd!==undefined){cost+=usage.costUsd;costKnown=true;}
  }
  if(limits?.tokenBudget&&tokenKnown&&tokens>limits.tokenBudget)return `运行超出 Token 预算：已上报 ${tokens.toLocaleString()} / 上限 ${limits.tokenBudget.toLocaleString()}`;
  if(limits?.costBudgetUsd&&costKnown&&cost>limits.costBudgetUsd)return `运行超出费用预算：US$ ${cost.toFixed(4)} / 上限 US$ ${limits.costBudgetUsd.toFixed(4)}`;
  return undefined;
}
