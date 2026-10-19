import { z } from 'zod';

const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const runFenceSchema=z.object({runId:id,roomId:id,agentId:id,generation:z.number().int().positive(),executionId:id}).strict();
export type RunFence=z.infer<typeof runFenceSchema>;
export const nativeOperationSchema=z.object({provider:z.enum(['codex','claude','deepseek']),scope:z.enum(['execution','tool']),evidence:z.enum(['execution-intent','provider-notification']),inputId:z.string().length(64),kind:z.string().min(1).max(100),clientUserMessageId:z.string().min(1).max(256).optional(),sessionId:z.string().min(1).max(512).optional(),turnId:z.string().min(1).max(512).optional(),itemId:z.string().min(1).max(512).optional()}).strict();
export type NativeOperation=z.infer<typeof nativeOperationSchema>;
export const nativeReconciliationSchema=z.object({threadId:z.string().min(1),turnId:z.string().min(1),clientUserMessageId:z.string().min(1),status:z.enum(['completed','failed','interrupted']),itemsView:z.literal('full'),itemId:z.string().optional(),itemStatus:z.enum(['completed','failed','declined','canceled']).optional()}).strict();
export const toolOperationSchema=z.object({
  id,runId:id,roomId:id,agentId:id,generation:z.number().int().positive(),executionId:id,
  operationId:id,name:z.string().min(1).max(100),hash:z.string().length(64),
  status:z.enum(['started','completed','unknown']),result:z.unknown().optional(),
  native:nativeOperationSchema.optional(),
  createdAt:z.string().datetime(),updatedAt:z.string().datetime()
});
export type ToolOperation=z.infer<typeof toolOperationSchema>;

/** A new physical process never inherits the authority of an older process. */
export function sameRunFence(run:{id:string;roomId:string;agentId:string;generation?:number;executionId?:string},fence:RunFence):boolean {
  return run.id===fence.runId&&run.roomId===fence.roomId&&run.agentId===fence.agentId&&
    (run.generation??1)===fence.generation&&run.executionId===fence.executionId;
}
