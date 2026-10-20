import {z} from 'zod';

const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
/** Suggested form budget; the v0.1 wire default stays stable for existing receipts. */
export function defaultDiscussionResponses(participantCount:number,stopOnConvergence=false):number{
  return stopOnConvergence?Math.min(100,Math.max(30,participantCount*10)):9;
}
/** A ballot confirms one frozen proposal, never a natural-language similarity score. */
export const discussionBallotSchema=z.object({
  proposalId:id.nullable(),agree:z.boolean(),proposal:z.string().trim().min(1).max(12000)
}).strict();
export type DiscussionBallot=z.infer<typeof discussionBallotSchema>;
export const discussionSchema=z.object({
  id,roomId:id,goal:z.string(),participants:z.array(id),rounds:z.number().int().positive(),round:z.number().int().positive(),
  maxResponses:z.number().int().positive(),responses:z.number().int().nonnegative(),quorum:z.number().int().positive().optional(),
  absent:z.array(id).optional(),deadline:z.string().datetime(),status:z.enum(['active','paused','completed','stopped']),
  triggerPolicy:z.enum(['all','explicit','assigned-task']).optional(),activationLimit:z.number().int().positive().optional(),activationsUsed:z.number().int().nonnegative().optional(),summaryActivationLimit:z.number().int().positive().optional(),summaryActivationsUsed:z.number().int().nonnegative().optional(),roundWindowMs:z.number().int().positive().optional(),activeRoundId:id.optional(),authorizationRef:z.string().max(300).optional(),lifecycleVersion:z.number().int().positive().optional(),
  stopOnConvergence:z.boolean().optional(),summarizerId:id.optional(),startedSeq:z.number().int().nonnegative().optional(),
  endedSeq:z.number().int().nonnegative().optional(),endedAt:z.string().datetime().optional(),
  endReason:z.enum(['converged','round_limit','response_limit','time_limit','no_quorum','user_stop','restart','scheduling_failed','budget_exhausted','activation_limit']).optional(),
  consensus:z.object({proposalId:id,text:z.string().max(12000),round:z.number().int().positive(),agreedBy:z.array(id)}).optional(),
  summary:z.object({runId:id.optional(),status:z.enum(['queued','completed','failed','canceled','interrupted']),artifactId:id.optional(),error:z.string().optional()}).optional()
}).passthrough();

/** Only one trailing, valid control block counts. Quoted or malformed ballots never count. */
export function parseDiscussionReply(text:string):{text:string;ballot?:DiscussionBallot}{
  const marker='```room-consensus';
  if(text.split(marker).length!==2)return {text};
  const match=text.match(/(?:^|\n)```room-consensus\s*\n([^]*?)\n```\s*$/);
  if(!match||match[1].length>20000)return {text};
  try{
    const ballot=discussionBallotSchema.parse(JSON.parse(match[1]));
    return {text:text.slice(0,match.index).trim()||ballot.proposal,ballot};
  }catch{return {text};}
}
