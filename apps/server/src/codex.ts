import type { AgentOutput,Run } from '../../../packages/protocol/src/index.ts';

/** Item-level deduplication keeps a final item even after commentary streamed. */
export class CodexOutputParser {
  private streamed=new Set<string>();
  private completed=new Set<string>();
  accept(frame:any):AgentOutput[]{
    const params=frame.params;
    if(frame.method==='item/agentMessage/delta'&&typeof params?.delta==='string'){
      this.streamed.add(params.itemId);return [{type:'text',text:params.delta}];
    }
    if(frame.method==='item/completed'&&params?.item?.type==='agentMessage'){
      const item=params.item;if(this.streamed.has(item.id)||this.completed.has(item.id))return [];
      this.completed.add(item.id);return typeof item.text==='string'?[{type:'text',text:item.text}]:[];
    }
    if(frame.method==='thread/tokenUsage/updated'){
      const last=params?.tokenUsage?.last,usage:NonNullable<Run['usage']>={scope:'last-request'};
      for(const key of ['inputTokens','outputTokens'] as const)if(Number.isSafeInteger(last?.[key])&&last[key]>=0)usage[key]=last[key];
      if(usage.inputTokens!==undefined||usage.outputTokens!==undefined)return [{type:'usage',usage}];
    }
    return [];
  }
}

export async function answerCodexQuestions(params:any,requestInput:(question:string,signal?:AbortSignal)=>Promise<string>,signal:AbortSignal){
  const questions=params?.questions;
  if(!Array.isArray(questions)||!questions.length||questions.length>10)throw new Error('Codex 输入请求的问题数量不受支持');
  if(questions.some(question=>question.isSecret))throw new Error('Codex 请求了敏感输入，请通过隔离配置提供；群聊不收集此类输入');
  if(questions.some(question=>typeof question.id!=='string'||typeof question.question!=='string'||question.question.length>8000))throw new Error('Codex 输入请求形状无效');
  const answers:Record<string,{answers:string[]}>=Object.create(null);
  for(const question of questions){
    signal.throwIfAborted();
    const choices=Array.isArray(question.options)?question.options.map((option:any)=>`${option.label}: ${option.description??''}`).join('\n'):'';
    answers[question.id]={answers:[await requestInput(`${question.header?question.header+'\n':''}${question.question}${choices?'\n\n可选项：\n'+choices:''}`,signal)]};
  }
  signal.throwIfAborted();return {answers};
}
