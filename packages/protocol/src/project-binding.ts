import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const time = z.string().datetime();
export const projectExecutionModeSchema = z.enum(['sandbox', 'host']);

/** Immutable binding of one room to one canonical project source. */
export const projectBindingSchema = z.object({
  id,
  roomId: id,
  sourcePath: z.string().min(1).max(2000),
  baseCommit: z.string().min(1).max(200).optional(),
  manifestHash: hash,
  manifestFileCount: z.number().int().nonnegative(),
  manifestBytes: z.number().int().nonnegative(),
  allowedExecutionModes: z.array(projectExecutionModeSchema).min(1).max(2),
  verificationRefs: z.array(z.string().min(1).max(500)).max(50).default([]),
  version: z.number().int().positive(),
  createdAt: time,
  updatedAt: time
}).strict();
export type ProjectBinding = z.infer<typeof projectBindingSchema>;

export const projectManifestEntrySchema = z.object({
  path: z.string().min(1).max(2000),
  size: z.number().int().nonnegative(),
  sha256: hash
}).strict();
export type ProjectManifestEntry = z.infer<typeof projectManifestEntrySchema>;
