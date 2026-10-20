import { z } from 'zod';
import {contextPolicySchema} from './reconciliation.ts';
// Historical facts must not acquire newly defaulted budgets during replay.
// The enqueue path explicitly freezes defaults for new runs.
export const runLimitsSchema=z.object({memoryMb:z.number().int().min(256).max(16384),maxProcesses:z.number().int().min(1).max(128),timeoutMs:z.number().int().min(1000).max(7200000),tokenBudget:z.number().int().min(0).max(100000000).optional(),costBudgetUsd:z.number().min(0).max(1000000).optional()}).strict();
export type RunLimits=z.infer<typeof runLimitsSchema>;
export const executionSettingsSchema=z.object({
  contextPolicy:contextPolicySchema.default(()=>contextPolicySchema.parse({})),
  concurrency:z.number().int().min(1).max(8).default(2),
  maxConcurrentRunsPerRoom:z.number().int().min(1).max(64).default(4),
  memoryMb:z.number().int().min(256).max(16384).default(4096),
  maxProcesses:z.number().int().min(1).max(128).default(64),
  taskTimeoutMs:z.number().int().min(1000).max(7200000).default(1800000),
  chatTimeoutMs:z.number().int().min(1000).max(7200000).default(300000),
  taskLeaseMs:z.number().int().min(5000).max(86400000).default(600000),
  tokenBudget:z.number().int().min(0).max(100000000).default(0),
  costBudgetUsd:z.number().min(0).max(1000000).default(0),
  maxQueuedRunsPerAgent:z.number().int().min(1).max(100).default(5),
  maxQueuedRunsPerRoom:z.number().int().min(1).max(500).default(20),
  maxAgentRunsPerMinute:z.number().int().min(1).max(1000).default(30),
  maxBypassDispatches:z.number().int().min(1).max(1000).default(5),
  maxInboxDeliveries:z.number().int().min(1).max(100000).default(1000),
  maxInboxBytes:z.number().int().min(1024).max(64*1024*1024).default(1024*1024),
  allowAgentMentionsToWake:z.boolean().default(false),
  maxWakeChainDepth:z.number().int().min(1).max(10).default(2),
  maxToolResultBytes:z.number().int().min(65536).max(8388608).default(2097152),
  maxToolCallsPerRun:z.number().int().min(1).max(10000).default(100),
  maxContextMessages:z.number().int().min(1).max(200).default(40),
  autoRetryChatRuns:z.boolean().default(false),
  recoverInterruptedChatRuns:z.boolean().default(false),
  maxAutoRetries:z.number().int().min(0).max(3).default(1),
  adaptiveTimeouts:z.boolean().default(false),
  roomTokenBudget:z.number().int().min(0).max(1000000000).default(0),
  roomCostBudgetUsd:z.number().min(0).max(1000000).default(0),
  unknownCostPolicy:z.enum(['block','allow']).default('block'),
  stagingRetentionMs:z.number().int().min(0).max(30*24*60*60*1000).default(24*60*60*1000),
  toolAuthorizationMode:z.enum(['off','warn','enforce']).default('off')
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

export type RoomBudgetRun={usageByGeneration?:Record<string,BudgetUsage|undefined>;usage?:BudgetUsage};
/** Entry-time room budget check. Unknown usage is never counted as zero. */
export function roomBudgetError(settings:Pick<ExecutionSettings,'roomTokenBudget'|'roomCostBudgetUsd'>,runs:readonly RoomBudgetRun[]):string|undefined{
  let tokens=0,cost=0,tokenKnown=false,costKnown=false;
  for(const run of runs){
    const usages=run.usageByGeneration?Object.values(run.usageByGeneration):(run.usage?[run.usage]:[]);
    for(const usage of usages){
      if(!usage)continue;
      if(usage.inputTokens!==undefined||usage.outputTokens!==undefined){tokens+=(usage.inputTokens??0)+(usage.outputTokens??0);tokenKnown=true;}
      if(usage.costUsd!==undefined){cost+=usage.costUsd;costKnown=true;}
    }
  }
  if(settings.roomTokenBudget&&tokenKnown&&tokens>=settings.roomTokenBudget)return `房间累计 Token 预算已用尽：已上报 ${tokens.toLocaleString()} / 上限 ${settings.roomTokenBudget.toLocaleString()}`;
  if(settings.roomCostBudgetUsd&&costKnown&&cost>=settings.roomCostBudgetUsd)return `房间累计费用预算已用尽：US$ ${cost.toFixed(4)} / 上限 US$ ${settings.roomCostBudgetUsd.toFixed(4)}`;
  return undefined;
}
