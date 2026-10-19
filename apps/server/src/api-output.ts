import { z } from 'zod';
import type { AgentOutput } from '../../../packages/protocol/src/index.ts';

export const structuredReplySchema=z.object({
  message:z.string().max(32000),
  artifacts:z.array(z.object({name:z.string().min(1).max(160),text:z.string().max(1024*1024),mediaType:z.enum(['text/plain','text/markdown','text/csv','application/json']).default('text/plain')}).strict()).max(10).default([])
}).strict().refine(reply=>reply.message.trim().length>0||reply.artifacts.length>0,'需要回复或交付物');
export const structuredReplyInstruction='Return one JSON object only, without Markdown fences: {"message":"public room reply","artifacts":[{"name":"report.md","text":"report content","mediaType":"text/markdown"}]}. message may be empty when artifacts are present. At most 10 text artifacts; each at most 1 MiB. Do not include secrets or hidden reasoning. No execution tools are available.';
export function structuredOutputs(text:string):AgentOutput[]{
  const reply=structuredReplySchema.parse(JSON.parse(text)),output:AgentOutput[]=[];
  if(reply.message.trim())output.push({type:'text',text:reply.message});
  for(const artifact of reply.artifacts)output.push({type:'artifact',...artifact});
  return output;
}
export function apiUsage(value:any):AgentOutput|undefined {
  if(!value)return;
  const usage:{inputTokens?:number;outputTokens?:number}={};
  if(Number.isSafeInteger(value.prompt_tokens)&&value.prompt_tokens>=0)usage.inputTokens=value.prompt_tokens;
  if(Number.isSafeInteger(value.completion_tokens)&&value.completion_tokens>=0)usage.outputTokens=value.completion_tokens;
  if(Object.keys(usage).length)return {type:'usage',usage};
}
