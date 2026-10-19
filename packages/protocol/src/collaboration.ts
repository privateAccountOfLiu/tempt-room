import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const time = z.string().datetime();
const optionalText = (max: number) => z.string().max(max).optional();
export const agentSessionStatusSchema = z.enum(['active', 'paused', 'ended']);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

/** Logical Agent session. The physical native session/thread stays in a binding record. */
export const agentSessionSchema = z.object({
  id,
  roomId: id,
  agentId: id,
  discussionId: id.optional(),
  taskId: id.optional(),
  status: agentSessionStatusSchema,
  adapterFingerprint: optionalText(200),
  workspaceBindingId: id.optional(),
  createdAt: time,
  updatedAt: time
}).strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const subscriptionSourcePolicySchema = z.enum(['explicit', 'assigned-task', 'previous-response']);
export const subscriptionSchema = z.object({
  id,
  roomId: id,
  agentSessionId: id,
  eventTypes: z.array(z.string().min(1).max(100)).max(100).default([]),
  taskIds: z.array(id).max(100).default([]),
  sourcePolicy: subscriptionSourcePolicySchema,
  enabled: z.boolean(),
  scanSeq: z.number().int().nonnegative()
}).strict();
export type Subscription = z.infer<typeof subscriptionSchema>;

export const inboxDeliveryStatusSchema = z.enum(['pending', 'batched', 'provided', 'expired']);
export const inboxDeliverySchema = z.object({
  id,
  agentSessionId: id,
  sourceEventId: id,
  sourceSeq: z.number().int().nonnegative(),
  status: inboxDeliveryStatusSchema,
  batchId: id.optional(),
  sourceBytes: z.number().int().nonnegative().optional()
}).strict();
export type InboxDelivery = z.infer<typeof inboxDeliverySchema>;

export const inputDeliveryModeSchema = z.enum(['next-turn', 'tool-boundary', 'steer']);
export const inputBatchStatusSchema = z.enum(['created', 'provided', 'unknown', 'expired']);
export const inputBatchSchema = z.object({
  id,
  agentSessionId: id,
  runId: id.optional(),
  generation: z.number().int().positive(),
  executionId: id,
  deliveryIds: z.array(id).min(1).max(500),
  sourceEventIds: z.array(id).min(1).max(500),
  fromScanSeq: z.number().int().nonnegative(),
  throughScanSeq: z.number().int().nonnegative(),
  payloadHash: z.string().min(1).max(128),
  deliveryMode: inputDeliveryModeSchema,
  createdAt: time,
  providedAt: time.optional(),
  receiptEvidence: optionalText(500),
  status: inputBatchStatusSchema
}).strict();
export type InputBatch = z.infer<typeof inputBatchSchema>;

export const discussionRoundStatusSchema = z.enum(['open', 'closed', 'late']);
export const discussionRoundSchema = z.object({
  id,
  roomId: id.optional(),
  discussionId: id,
  round: z.number().int().positive(),
  status: discussionRoundStatusSchema,
  openedSeq: z.number().int().nonnegative(),
  openedAt: time,
  windowDeadline: time.optional(),
  closedSeq: z.number().int().nonnegative().optional(),
  closedAt: time.optional(),
  closeReason: z.string().max(200).optional(),
  slotIds: z.array(id).max(100).default([]),
  quorum: z.number().int().positive().optional()
}).strict();
export type DiscussionRound = z.infer<typeof discussionRoundSchema>;

export const wakeIntentStatusSchema = z.enum(['pending', 'assigned', 'suppressed']);
export const wakeIntentSchema = z.object({
  id,
  discussionId: id.optional(),
  roundId: id.optional(),
  scopeKey: z.string().min(1).max(300),
  agentSessionId: id,
  sourceEventId: id,
  status: wakeIntentStatusSchema,
  runId: id.optional(),
  suppressionReason: optionalText(300)
}).strict();
export type WakeIntent = z.infer<typeof wakeIntentSchema>;

export const capabilityNameSchema = z.enum([
  'streamOutput', 'nextTurnInput', 'toolBoundaryInput', 'steerDuringRun',
  'cancelOwnedTree', 'cancelRemoteTask', 'resumeSession', 'queryOutcome',
  'usageScope', 'preToolGate'
]);
export type CapabilityName = z.infer<typeof capabilityNameSchema>;
export const capabilityStateSchema = z.enum(['verified_supported', 'verified_unsupported', 'unverified']);
export const capabilityEvidenceSchema = z.object({
  id: id.optional(),
  fingerprint: z.string().min(1).max(200),
  capability: capabilityNameSchema,
  state: capabilityStateSchema,
  mode: z.string().min(1).max(100),
  testedAt: time,
  suiteVersion: z.string().min(1).max(100),
  evidenceHash: z.string().min(1).max(200),
  evidenceLocation: z.string().max(1000).optional(),
  reason: z.string().max(500).optional()
}).strict();
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;

export const collaborationSchemas = {
  agentSession: agentSessionSchema,
  subscription: subscriptionSchema,
  inboxDelivery: inboxDeliverySchema,
  inputBatch: inputBatchSchema,
  wakeIntent: wakeIntentSchema,
  discussionRound: discussionRoundSchema,
  capabilityEvidence: capabilityEvidenceSchema
};
