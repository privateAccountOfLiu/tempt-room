import {z} from 'zod';
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const contextPolicySchema=z.object({maxLag:z.number().int().min(1).max(10000).default(64),maxRounds:z.number().int().min(0).max(12).default(3),maxDeltaBytes:z.number().int().min(4096).max(1048576).default(262144)}).strict();
export type ContextPolicy=z.infer<typeof contextPolicySchema>;
/** Server-issued input receipt for one external task lease, never a client cursor. */
export const taskContextSchema=z.object({token:id,baseSeq:z.number().int().nonnegative(),throughSeq:z.number().int().nonnegative(),hasMore:z.boolean(),policy:contextPolicySchema}).strict();
export type TaskContext=z.infer<typeof taskContextSchema>;
export const contextDeltaSchema=z.object({fromSeq:z.number().int().nonnegative(),throughSeq:z.number().int().nonnegative(),headSeq:z.number().int().nonnegative(),hasMore:z.boolean(),reasons:z.array(z.enum(['mention','decision','lag'])),changes:z.array(z.object({eventId:id,seq:z.number().int().positive(),type:z.string(),actor:z.object({id,kind:z.enum(['human','agent','system'])}),payload:z.record(z.string(),z.unknown())}).strict())}).strict();
export type ContextDelta=z.infer<typeof contextDeltaSchema>;
export const contextSeqOf=(run:{basedOnSeq:number;contextSeq?:number})=>run.contextSeq??run.basedOnSeq;
