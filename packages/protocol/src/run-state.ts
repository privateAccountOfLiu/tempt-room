import {z} from 'zod';
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const runStatusSchema=z.enum(['queued','running','waiting_input','cancel_requested','completed','failed','canceled','superseded','interrupted','unknown']);
export type RunStatus=z.infer<typeof runStatusSchema>;
export const terminalStates=new Set<RunStatus>(['completed','failed','canceled','superseded','interrupted','unknown']);
export const PARTIAL_INTERVAL_MS=2000,PARTIAL_MAX_BYTES=65536;
export const runPartialSchema=z.object({id,messageId:id,text:z.string().min(1).max(PARTIAL_MAX_BYTES).refine(value=>new TextEncoder().encode(value).length<=PARTIAL_MAX_BYTES,'Partial exceeds 64 KiB').meta({'x-maxUtf8Bytes':PARTIAL_MAX_BYTES}),createdAt:z.string().datetime(),streamIndex:z.number().int().nonnegative(),supersedes:id.optional(),truncated:z.boolean()}).strict();
export type RunPartial=z.infer<typeof runPartialSchema>;

/** Legacy logs keep their recorded transitions; new runs opt into this contract. */
export function validateRunTransition(previous:any,next:any,type:string){
  if(previous?.lifecycleVersion!==1&&next.lifecycleVersion!==1)return;
  if(next.lifecycleVersion!==1)throw new Error('Run lifecycle version cannot be removed');
  if(!previous)return;
  const from:RunStatus=previous.status,to:RunStatus=next.status;
  if(from===to)return;
  if(type==='run.recovered'&&['queued','running','waiting_input','cancel_requested','unknown','interrupted'].includes(from)&&['unknown','interrupted'].includes(to))return;
  if(type==='run.requeued'&&['unknown','interrupted'].includes(from)&&to==='queued')return;
  if(type==='run.reconciled'&&['unknown','interrupted'].includes(from)&&terminalStates.has(to))return;
  const allowed:Record<RunStatus,readonly RunStatus[]>={queued:['running','cancel_requested','canceled','superseded','failed','unknown','interrupted'],running:['waiting_input','cancel_requested','completed','failed','canceled','superseded','unknown','interrupted'],waiting_input:['running','cancel_requested','failed','canceled','superseded','unknown','interrupted'],cancel_requested:['canceled','superseded','completed','failed','unknown','interrupted'],completed:[],failed:[],canceled:[],superseded:[],unknown:[],interrupted:[]};
  if(!allowed[from].includes(to))throw new Error(`Invalid run transition: ${from} -> ${to}`);
  if(from==='queued'&&to==='running'&&type!=='run.started')throw new Error('A running run requires run.started evidence');
}
