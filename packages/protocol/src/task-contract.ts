import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const path = z.string().min(1).max(1000);

export const taskAcceptanceSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  command: z.string().min(1).max(4000),
  argv: z.array(z.string().min(1).max(2000)).min(1).max(50).optional(),
  verifierVersion: z.string().min(1).max(100),
  verifierHash: hash
}).strict();

export const taskDependencyConditionSchema = z.enum(['execution', 'accepted_artifact', 'integrated']);

/**
 * Where the run may work.
 *
 * `isolated` materialises an independent directory from the frozen baseline.
 * `source` keeps the legacy behaviour of working directly in the project.
 * Older contracts without this field keep the legacy behaviour.
 */
export const workspaceModeSchema = z.enum(['isolated', 'source']);

export const taskContractSchema = z.object({
  objective: z.string().trim().min(1).max(20000),
  workspaceMode: workspaceModeSchema.optional(),
  projectBinding: z.object({
    id,
    version: z.number().int().positive(),
    baselineRef: z.string().min(1).max(200),
    manifestHash: hash,
    allowedPaths: z.array(path).min(1).max(200)
  }).strict(),
  acceptance: z.array(taskAcceptanceSchema).min(1).max(50),
  expectedArtifacts: z.array(z.object({path, mediaType: z.string().min(1).max(200).optional()}).strict()).max(100).default([]),
  dependencies: z.array(z.object({
    taskId: id,
    condition: taskDependencyConditionSchema,
    taskVersion: z.number().int().positive(),
    artifactHash: hash.optional()
  }).strict()).max(50).default([]),
  authorizedExecutor: z.object({agentId: id, executionMode: z.enum(['sandbox', 'host']).optional()}).strict().optional(),
  limits: z.object({durationLimitMs: z.number().int().min(1000).max(86400000).optional(), activationLimit: z.number().int().min(1).max(1000).optional()}).strict().optional(),
  failureHandling: z.enum(['stop_branch', 'isolate_branch']).optional(),
  collaborationBoundary: z.object({canModifyInterfaces: z.boolean(), notes: z.string().max(2000).optional()}).strict().optional()
}).strict();
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskAcceptance = z.infer<typeof taskAcceptanceSchema>;
export type TaskDependencyCondition = z.infer<typeof taskDependencyConditionSchema>;
