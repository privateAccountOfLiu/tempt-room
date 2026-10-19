import {agentSchema,sandboxProfileSchema,type AgentDescriptor,type Run,type Message} from '../packages/protocol/src/index.ts';

const providers=['codex','claude','deepseek'] as const;
/** Native v1 evidence must never silently substitute a host or external member. */
export function nativeAcceptanceTeam(configured:AgentDescriptor[],selected?:string[]):AgentDescriptor[]{
 const team=selected?selected.map(id=>configured.find(agent=>agent.id===id)):providers.map(provider=>configured.find(agent=>agent.provider===provider&&agent.enabled));
 if(team.length!==3||team.some(agent=>!agent?.enabled)||new Set(team.map(agent=>agent?.provider)).size!==3||team.some(agent=>!providers.includes(agent!.provider as typeof providers[number])))throw new Error('原生验收需要启用的 Codex、Claude、DeepSeek 各一位；可用 --agents=id1,id2,id3 明确选择');
 return team.map(raw=>{
  const agent=agentSchema.parse(raw);
  if(agent.connectionMode!=='managed')throw new Error(`${agent.name} 是外部会话，不能作为托管原生 Agent 验收；请明确选择另一位已配置成员，不会自动修改当前房间配置`);
  if(agent.executionMode!=='sandbox')throw new Error(`${agent.name} 使用本机直连，不能作为原生沙箱验收；请明确选择沙箱成员，不会自动降低隔离要求`);
  return agent;
 });
}

/** A command receipt or an empty run list is not model execution evidence. */
export function nativeRunEvidence(run:Run|undefined,agent:AgentDescriptor,roomId:string,messages:Message[],expectedText?:string){
 if(!run)throw new Error(`${agent.name} 没有创建实际运行，验收未通过`);
 if(run.agentId!==agent.id||run.roomId!==roomId)throw new Error(`${agent.name} 的运行身份或房间不匹配`);
 if(run.status!=='completed')throw new Error(`${agent.name} 运行未完成：${run.status} ${run.error??''}`);
 if(!run.sandbox||!sandboxProfileSchema.safeParse(run.sandbox).success||!Number.isFinite(Date.parse(run.sandbox.verifiedAt)))throw new Error(`${agent.name} 缺少已验证的 AppContainer 执行记录`);
 if(!run.nativeSessionId?.trim())throw new Error(`${agent.name} 未保存原生会话标识`);
 const replies=messages.filter(message=>message.roomId===roomId&&message.runId===run.id&&message.actor.kind==='agent'&&message.actor.id===agent.id&&!message.stale);
 if(!replies.some(message=>expectedText?message.text.trim()===expectedText:Boolean(message.text.trim())))throw new Error(`${agent.name} 没有匹配本次实际运行的有效${expectedText?'预期':''}回复`);
 return run;
}
