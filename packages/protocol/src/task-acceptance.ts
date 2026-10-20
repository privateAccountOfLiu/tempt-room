import { z } from 'zod';
import { taskAcceptanceSchema } from './task-contract.ts';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);

export const taskAcceptanceStatusSchema = z.enum(['not_required', 'pending', 'accepted', 'rejected']);
export const dependencyRequirementKindSchema = z.enum(['execution', 'accepted_artifact', 'integrated']);

export const taskAcceptanceCheckSchema = taskAcceptanceSchema.extend({required: z.boolean().default(true)}).strict();

export const dependencyRequirementSchema = z.object({
  taskId: id,
  taskVersion: z.number().int().positive(),
  requirement: dependencyRequirementKindSchema,
  artifactId: id.optional(),
  artifactHash: hash.optional()
}).strict();

export const taskVerificationRecordSchema = z.object({
  taskId: id,
  taskVersion: z.number().int().positive(),
  outcome: z.enum(['accepted', 'rejected']),
  recordedAt: z.string().datetime().optional(),
  verificationId: z.string().min(1).max(200),
  artifactIds: z.array(id).max(50).default([]),
  artifactHashes: z.record(z.string(), hash).default({}),
  commandRef: z.string().max(1000).optional(),
  exitCode: z.number().int().optional(),
  outputHash: hash.optional(),
  reason: z.string().max(2000).optional()
}).strict();
export type TaskAcceptanceStatus = z.infer<typeof taskAcceptanceStatusSchema>;
export type DependencyRequirement = z.infer<typeof dependencyRequirementSchema>;
export type TaskVerificationRecord = z.infer<typeof taskVerificationRecordSchema>;
export type DependencyRequirementKind = z.infer<typeof dependencyRequirementKindSchema>;
