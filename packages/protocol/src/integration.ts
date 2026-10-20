import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const time = z.string().datetime();
export const integrationStatusSchema = z.enum(['queued', 'validating', 'staging', 'testing', 'ready_to_apply', 'applying', 'applied', 'conflict', 'verification_failed', 'unknown', 'blocked']);

export const integrationSchema = z.object({
  id,
  roomId: id,
  projectBindingId: id.optional(),
  artifactId: id,
  artifactHash: hash.optional(),
  runId: id.optional(),
  taskId: id.optional(),
  taskVersion: z.number().int().positive().optional(),
  baseManifestHash: hash.optional(),
  expectedTargetVersion: z.number().int().positive().optional(),
  status: integrationStatusSchema,
  authorization: z.enum(['auto', 'waiting', 'authorized']).default('auto'),
  verificationExitCode: z.number().int().optional(),
  verificationOutputHash: hash.optional(),
  verificationEnvironment: z.object({node: z.string().min(1).max(100), platform: z.string().min(1).max(50), arch: z.string().min(1).max(50)}).strict().optional(),
  verificationId: z.string().min(1).max(200).optional(),
  journalId: z.string().min(1).max(200).optional(),
  requestActor: z.string().min(1).max(200),
  errorCode: z.string().min(1).max(200).optional(),
  createdAt: time,
  updatedAt: time
}).strict();
export type Integration = z.infer<typeof integrationSchema>;
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
