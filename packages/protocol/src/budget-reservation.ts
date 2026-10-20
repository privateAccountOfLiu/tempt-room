import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const time = z.string().datetime();
export const budgetReservationStatusSchema = z.enum(['reserved', 'settled', 'released', 'unknown']);
export const budgetReservationSchema = z.object({
  id,
  roomId: id,
  runId: id,
  generation: z.number().int().positive(),
  executionId: id.optional(),
  provider: z.string().min(1).max(100).optional(),
  reservedUsd: z.number().nonnegative(),
  actualUsd: z.number().nonnegative().optional(),
  source: z.enum(['estimate', 'adapter', 'manual']),
  status: budgetReservationStatusSchema,
  createdAt: time,
  updatedAt: time
}).strict();
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
export type BudgetReservationStatus = z.infer<typeof budgetReservationStatusSchema>;
