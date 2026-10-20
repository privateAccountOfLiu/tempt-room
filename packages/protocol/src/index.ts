import { z } from 'zod';
import { executionSettingsSchema,type RunLimits } from './settings.ts';
import { codexBindingSchema, type CodexRunState } from './codex.ts';
import { subscriptionSchema, capabilityEvidenceSchema } from './collaboration.ts';
export * from './collaboration.ts';
export { eventRegistry, eventRegistryManifest, eventDefinition, eventMetadata, EventContractError, projectionTableNames, type ProjectionTable } from './events.ts';
export { codexBindingSchema, codexRunStateSchema, type CodexBinding, type CodexRunState } from './codex.ts';
export { executionSettingsSchema,runLimitsSchema,defaultExecutionSettings,budgetError,roomBudgetError,type ExecutionSettings,type RunLimits,type BudgetUsage,type RoomBudgetRun } from './settings.ts';
export { actorSchema,sandboxProfileSchema,messageSchema,taskSchema,runSchema,artifactSchema } from './models.ts';
export { runFenceSchema,toolOperationSchema,nativeOperationSchema,nativeReconciliationSchema,sameRunFence,type RunFence,type ToolOperation,type NativeOperation } from './execution.ts';
export { classifyFailure, type FailureInfo, type FailureKind } from './failure.ts';
export {contextPolicySchema,contextDeltaSchema,taskContextSchema,contextSeqOf,type ContextPolicy,type ContextDelta,type TaskContext} from './reconciliation.ts';
import {contextPolicySchema,type ContextPolicy,type TaskContext} from './reconciliation.ts';
export {runStatusSchema,terminalStates,runPartialSchema,PARTIAL_INTERVAL_MS,PARTIAL_MAX_BYTES,validateRunTransition,type RunStatus,type RunPartial} from './run-state.ts';
import type {RunStatus,RunPartial} from './run-state.ts';

export {discussionSchema,discussionBallotSchema,parseDiscussionReply,defaultDiscussionResponses,type DiscussionBallot} from './discussion.ts';
export {taskContractSchema,taskAcceptanceSchema,taskDependencyConditionSchema,type TaskContract,type TaskAcceptance,type TaskDependencyCondition} from './task-contract.ts';
export {projectBindingSchema,projectManifestEntrySchema,projectExecutionModeSchema,type ProjectBinding,type ProjectManifestEntry} from './project-binding.ts';
export {taskAcceptanceStatusSchema,taskAcceptanceCheckSchema,dependencyRequirementSchema,taskVerificationRecordSchema,type TaskAcceptanceStatus,type DependencyRequirement,type TaskVerificationRecord,type DependencyRequirementKind} from './task-acceptance.ts';
export {integrationSchema,integrationStatusSchema,type Integration,type IntegrationStatus} from './integration.ts';
import type {DiscussionBallot} from './discussion.ts';
import {taskContractSchema} from './task-contract.ts';
import {projectBindingSchema} from './project-binding.ts';
import {taskAcceptanceStatusSchema,taskAcceptanceCheckSchema,dependencyRequirementSchema,taskVerificationRecordSchema} from './task-acceptance.ts';
import type {TaskContract} from './task-contract.ts';
import type {TaskVerificationRecord,DependencyRequirement} from './task-acceptance.ts';

export const VERSION = '0.1' as const;
export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const providerSchema = z.enum(['codex', 'claude', 'deepseek', 'api', 'a2a', 'demo']);
export type Provider = z.infer<typeof providerSchema>;
export const capabilitiesSchema = z.object({
  streaming: z.boolean(), resume: z.boolean(), cancel: z.boolean(),
  execute: z.boolean(), artifacts: z.boolean(), input: z.boolean(), usage: z.boolean()
});
export type AgentCapabilities = z.infer<typeof capabilitiesSchema>;
export const roomToolNames=['room_read','room_status','room_inbox','room_post','task_propose','task_claim','task_context','task_complete','task_heartbeat','artifact_publish','room_input_ack'] as const;
export const agentSchema = z.object({
  id: idSchema, name: z.string().min(1).max(60), provider: providerSchema,
  role: z.string().max(300).default('协作助手'), color: z.enum(['blue', 'green', 'orange', 'purple', 'teal']).default('blue'), schedulerWeight: z.number().min(0.1).max(10).default(1),
  roomToolPolicy: z.enum(['allow','read-only','deny']).default('allow'),
  allowedRoomTools: z.array(z.enum(roomToolNames)).min(1).default(()=>[...roomToolNames]),
  maxRoomPostChars: z.number().int().min(1).max(32000).default(32000),
  maxTaskTitleChars: z.number().int().min(1).max(5000).default(5000),
  enabled: z.boolean().default(false), executable: z.string().max(1000).default(''),
  endpoint: z.string().max(2000).default(''), model: z.string().max(200).default(''),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).or(z.literal('')).default(''),
  version: z.string().max(100).default(''),
  runtimeDirectory: z.string().max(1500).default(''),
  connectionMode:z.enum(['managed','external','attach']).default('managed'),
  codexBinding:codexBindingSchema.optional(),
  executionMode:z.enum(['sandbox','host']).default('sandbox'),
  responseFormat:z.enum(['text','room-json']).default('text'),
  capabilities: capabilitiesSchema.optional()
}).superRefine((agent,ctx)=>{
  if(agent.connectionMode==='attach'&&(agent.provider!=='codex'||agent.executionMode!=='host'||!agent.codexBinding))ctx.addIssue({code:'custom',message:'附着模式只支持 Codex，必须选择已有宿主会话并配置线程绑定'});
});
export type AgentDescriptor = z.infer<typeof agentSchema>;
export function capabilitiesFor(provider:Provider,options?:Pick<AgentDescriptor,'responseFormat'> & Partial<Pick<AgentDescriptor,'connectionMode'>>):AgentCapabilities {
  if(options?.connectionMode==='external')return {streaming:false,resume:false,cancel:false,execute:false,artifacts:true,input:false,usage:false};
  if(options?.connectionMode==='attach')return {streaming:true,resume:false,cancel:true,execute:true,artifacts:false,input:false,usage:false};
  const local=['codex','claude','deepseek'].includes(provider);
  return {streaming:provider!=='a2a'&&!(provider==='api'&&options?.responseFormat==='room-json'),resume:local||provider==='a2a',cancel:local||provider==='a2a'||provider==='demo',execute:local,artifacts:local||provider==='a2a'||(provider==='api'&&options?.responseFormat==='room-json'),input:provider==='a2a'||provider==='codex',usage:provider==='claude'||provider==='api'||provider==='codex'};
}
export interface Actor { id: string; kind: 'human' | 'agent' | 'system' }
export const eventSchema = z.object({
  version: z.literal(VERSION), eventId: idSchema, roomId: idSchema,
  seq: z.number().int().positive(), type: z.string().min(1),
  actor: z.object({ id: idSchema, kind: z.enum(['human', 'agent', 'system']),type:z.enum(['human','agent','system']).optional() }),
  createdAt: z.string().datetime(), causationId: z.string().nullable(),
  correlationId: z.string().nullable(), payload: z.record(z.string(), z.unknown())
  ,kind:z.string().min(1),schemaVersion:z.number().int().nonnegative(),durability:z.literal('durable'),
  aggregate:z.object({type:z.enum(['room','task','run','artifact']),id:idSchema}),ts:z.string().datetime(),
  baseSeq:z.number().int().nonnegative(),generation:z.number().int().positive(),replyTo:idSchema.nullable(),
  idempotencyKey:z.string().nullable(),traceId:z.string().min(1)
});
export type RoomEvent = z.infer<typeof eventSchema>;
const commandEnvelope = z.object({
  version: z.literal(VERSION), commandId: idSchema, roomId: idSchema.optional(),
}).strict();
const title=z.string().trim().min(1).max(5000);
export const payloadSchemas={
  'room.create':z.object({name:z.string().trim().min(1).max(80),description:z.string().max(300).default(''),members:z.array(idSchema).max(30).default([])}).strict(),
  'room.update':z.object({name:z.string().trim().min(1).max(80),description:z.string().max(300).default('')}).strict(),
  'room.members.set':z.object({members:z.array(idSchema).max(30)}).strict(),
  'message.send':z.object({text:z.string().trim().min(1).max(32000),mentions:z.array(idSchema).max(20).default([]),replyTo:idSchema.optional(),attachments:z.array(idSchema).max(10).default([])}).strict(),
  'discussion.start':z.object({goal:title,participants:z.array(idSchema).min(1).max(20),rounds:z.number().int().min(1).max(20).default(3),maxResponses:z.number().int().min(1).max(100).default(9),maxDurationMs:z.number().int().min(1000).max(7200000).default(600000),activationLimit:z.number().int().min(1).max(1000).optional(),stopOnConvergence:z.boolean().optional(),summarizerId:idSchema.optional(),quorum:z.number().int().min(1).max(20).optional()}).strict(),
  'discussion.stop':z.object({discussionId:idSchema}).strict(),
  'discussion.pause':z.object({discussionId:idSchema}).strict(),
  'discussion.resume':z.object({discussionId:idSchema}).strict(),
  'subscription.set':z.object({subscription:subscriptionSchema}).strict(),
  'input.ack':z.object({batchId:idSchema,agentSessionId:idSchema,receiptEvidence:z.string().max(500).optional()}).strict(),
  'capability.verify':z.object({fingerprint:z.string().min(1).max(200),evidence:z.array(capabilityEvidenceSchema).min(1).max(20)}).strict(),
  'task.verification.record':taskVerificationRecordSchema,
  'project.bind':z.object({sourcePath:z.string().min(1).max(2000),allowedExecutionModes:z.array(z.enum(['sandbox','host'])).min(1).max(2).default(['sandbox']),verificationRefs:z.array(z.string().min(1).max(500)).max(50).default([]),baseCommit:z.string().max(200).optional()}).strict(),
  'task.create':z.object({title,agentId:idSchema.optional(),projectPath:z.string().max(1500).default(''),dependencies:z.array(idSchema).max(20).default([]),open:z.boolean().default(false),contract:taskContractSchema.optional(),projectBindingId:idSchema.optional(),bindingVersion:z.number().int().positive().optional(),requiresIntegration:z.boolean().default(false)}).strict(),
  'task.revise':z.object({taskId:idSchema,title,contract:taskContractSchema.optional()}).strict(),
  'task.accept':z.object({taskId:idSchema,projectPath:z.string().max(1500).optional()}).strict(),
  'task.handoff':z.object({taskId:idSchema,agentId:idSchema,note:z.string().max(300).default('')}).strict(),
  'task.claim':z.object({taskId:idSchema,managed:z.boolean().default(true)}).strict(),
  'task.context':z.object({taskId:idSchema,taskVersion:z.number().int().positive(),generation:z.number().int().positive().optional()}).strict(),
  'task.complete':z.object({taskId:idSchema,taskVersion:z.number().int().positive(),generation:z.number().int().positive().optional(),contextToken:idSchema.optional(),ok:z.boolean().default(true),summary:z.string().max(8000).default('')}).strict(),
  'task.heartbeat':z.object({taskId:idSchema,taskVersion:z.number().int().positive(),generation:z.number().int().positive().optional()}).strict(),
  'task.release':z.object({taskId:idSchema}).strict(),
  'settings.update':executionSettingsSchema.extend({contextPolicy:contextPolicySchema.optional()}),
  'run.cancel':z.object({runId:idSchema}).strict(),
  'run.retry':z.object({runId:idSchema}).strict(),
  'run.input':z.object({runId:idSchema,text:z.string().trim().min(1).max(16000)}).strict(),
  'decision.propose':z.object({text:title}).strict(),
  'decision.accept':z.object({decisionId:idSchema}).strict(),
  'agent.save':agentSchema.strict(),
  'artifact.apply':z.object({artifactId:idSchema}).strict(),
  'artifact.integrate':z.object({artifactId:idSchema,requireAuthorization:z.boolean().default(false)}).strict(),
  'integration.authorize':z.object({integrationId:idSchema}).strict()
};
export interface Command { version:typeof VERSION;commandId:string;roomId?:string;type:keyof typeof payloadSchemas;payload:Record<string,unknown> }
export const commandSchema:z.ZodType<Command>=z.discriminatedUnion('type',Object.entries(payloadSchemas).map(([type,payload])=>commandEnvelope.extend({type:z.literal(type),payload})) as [z.ZodObject<any>,z.ZodObject<any>,...z.ZodObject<any>[]]) as unknown as z.ZodType<Command>;
export interface Receipt { commandId: string; accepted: true; result: Record<string, unknown> }
export const agentToolNameSchema=z.enum(['room_read','room_post','task_propose','task_claim','task_context','task_complete','task_heartbeat','artifact_publish','room_status','room_wait','room_inbox']);
export type AgentToolName=z.infer<typeof agentToolNameSchema>;
export const agentToolCallSchema=z.object({commandId:idSchema,roomId:idSchema,name:agentToolNameSchema,arguments:z.record(z.string(),z.unknown()).default({})}).strict();
export type AgentToolCall=z.infer<typeof agentToolCallSchema>;
export interface ServerCapabilities {version:typeof VERSION;supportedVersions:(typeof VERSION)[];clientType:'browser'|'sdk';actor:Actor;commands:string[];messageFormats:string[];visibility:['room-public'];transports:['http','websocket'];}
export interface Room { id: string; name: string; description: string; members: string[]; createdAt: string; seq: number }
export interface Message { supersedes?:string; final?:boolean; id: string; roomId: string; actor: Actor; text: string; mentions: string[]; replyTo?: string; attachments: string[]; createdAt: string; runId?: string;taskId?:string;taskVersion?:number; basedOnSeq?: number; generation?:number; executionId?:string; stale?: boolean; trust?: 'owner'|'managed'|'external'|'remote' }
export interface RunContext { fromSeq:number;throughSeq:number;messages:Message[];decisions:Decision[];members:{id:string;name:string;role:string}[] }
export interface Run { effectScope?:'conversation-only'|'unrestricted'; usageByGeneration?:Record<string,NonNullable<Run['usage']>>; contextPolicy?:ContextPolicy; contextSeq?:number; deltaContextId?:string; contextRound?:number; contextPending?:boolean; contextConfirmedSeq?:number; lifecycleVersion?:1; partial?:RunPartial; finalMessageId?:string; stopReason?:'superseded'|'user_cancel'; generation?:number; executionId?:string; leaseUntil?:string; id: string; roomId: string; agentId: string; status: RunStatus; prompt: string; basedOnSeq: number; contextId?:string; limits?:RunLimits; inputArtifacts?:string[];dependencyVersions?:Record<string,number>;taskId?: string; discussionId?: string; discussionRole?:'summary'; discussionBallot?:DiscussionBallot; round?: number; taskVersion?: number; autoRetryOf?: string; autoRetryCount?: number; wakeChainDepth?: number; recoveryCount?: number; agentSessionId?: string; inputBatchId?: string; operationScopeId?: string; responseSlotId?: string; startedAt?: string; finishedAt?: string; adapterFingerprint?: string; projectBindingId?: string; bindingVersion?: number; sourceCommit?: string; dirtyBaselineHash?: string; workspacePath?: string; nativeSessionId?: string; codex?: CodexRunState; remoteTaskId?:string; sandbox?: SandboxProfile & { verifiedAt:string }; error?: string; createdAt: string; updatedAt: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number;scope?:'run'|'last-request'|'session-total' }; }
export interface Task { contract?:TaskContract; strict?:boolean; objective?:string; acceptanceChecks?:any[]; allowedPaths?:string[]; requiresAcceptance?:boolean; requiresIntegration?:boolean; acceptanceStatus?:string; acceptedArtifactIds?:string[]; verificationId?:string; baselineRef?:string; dependencyRequirements?:DependencyRequirement[]; lastVerification?:TaskVerificationRecord; verificationHistory?:TaskVerificationRecord[]; projectBindingId?:string; bindingVersion?:number; baselineManifestHash?:string; externalContext?:TaskContext; generation?:number; id: string; roomId: string; title: string; agentId: string; projectPath: string; version: number; status: string; dependencies: string[]; workspaceId?: string; open?: boolean; leaseUntil?: string; createdAt: string }
export interface Artifact { discussionId?:string; generation?:number; executionId?:string; id: string; roomId: string; runId?: string; taskId?: string; name: string; kind: 'file' | 'patch' | 'report'; mediaType: string; size: number; createdAt: string; applied?: boolean }
export interface Discussion { id: string; roomId: string; goal: string; participants: string[]; rounds: number; round: number; maxResponses: number; responses: number; quorum: number; absent?: string[]; deadline: string; status: 'active' | 'paused' | 'completed' | 'stopped'; stopOnConvergence?:boolean; triggerPolicy?:'all'|'explicit'|'assigned-task'; activationLimit?:number; activationsUsed?:number; roundWindowMs?:number; activeRoundId?:string; authorizationRef?:string; lifecycleVersion?:number; summarizerId?:string; startedSeq?:number; endedSeq?:number; endedAt?:string; endReason?:'converged'|'round_limit'|'response_limit'|'time_limit'|'no_quorum'|'user_stop'|'restart'|'scheduling_failed'|'budget_exhausted'|'activation_limit'; consensus?:{proposalId:string;text:string;round:number;agreedBy:string[]}; summary?:{runId?:string;status:'queued'|'completed'|'failed'|'canceled'|'interrupted';artifactId?:string;error?:string} }
export interface Decision { id: string; text: string; accepted: boolean; actor: Actor }
export interface RoomSnapshot { room: Room; agents: AgentDescriptor[]; messages: Message[]; runs: Run[]; tasks: Task[]; artifacts: Artifact[]; discussions: Discussion[]; decisions: Decision[] }
export interface SnapshotEnvelope {snapshot:RoomSnapshot;asOfSeq:number;headSeq:number;historyFloor:number;tail:RoomEvent[];nextCursor:number;hasMore:boolean;reset:boolean}
export interface Diagnostic { ready: boolean; checks: { name: string; passed: boolean; detail: string }[]; checkedAt: string; provider?: string }
export interface SandboxProfile { kind: 'windows-appcontainer'; network: 'public-only'; memoryMb: number; maxProcesses: number; timeoutMs: number; relaxedTools: boolean }
export const defaultSandbox: SandboxProfile = { kind: 'windows-appcontainer', network: 'public-only', memoryMb: 4096, maxProcesses: 64, timeoutMs: 1_800_000, relaxedTools: true };
export interface StreamDelta { generation?:number; executionId?:string; type: 'message.delta'; roomId: string; runId: string; messageId: string; index: number; text: string }
export type AgentOutput = { type: 'text'; text: string } | { type: 'session'; id: string } | { type:'remote-task';id:string } | { type: 'usage'; usage: NonNullable<Run['usage']> } | { type: 'input'; question: string } | { type: 'artifact'; name: string; text: string; mediaType: string };
export interface AgentAdapter<Context=unknown,Host=unknown> {
  diagnose(agent:AgentDescriptor,host:Host):Promise<Diagnostic>;
  run(context:Context):AsyncIterable<AgentOutput>;
}
export class ProtocolError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
