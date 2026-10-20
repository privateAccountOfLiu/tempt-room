import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const time = z.string().datetime();
export const resourceLeaseStatusSchema = z.enum(['active', 'released', 'revoked', 'quarantined']);
export const resourceLeaseKindSchema = z.enum(['workspace', 'project', 'port', 'session', 'process-tree']);

export const cleanupProofSchema = z.object({
  checkedAt: time,
  remainingProcesses: z.number().int().nonnegative(),
  evidence: z.string().min(1).max(500)
}).strict();
export type CleanupProof = z.infer<typeof cleanupProofSchema>;

export const resourceLeaseSchema = z.object({
  id,
  roomId: id,
  kind: resourceLeaseKindSchema,
  canonicalKey: z.string().min(1).max(2000),
  capacity: z.number().int().positive(),
  holderRunId: id,
  executionId: id.optional(),
  generation: z.number().int().positive(),
  status: resourceLeaseStatusSchema,
  leaseUntil: time.optional(),
  cleanupProof: cleanupProofSchema.optional(),
  quarantineReason: z.string().max(500).optional(),
  createdAt: time,
  updatedAt: time
}).strict();
export type ResourceLease = z.infer<typeof resourceLeaseSchema>;
