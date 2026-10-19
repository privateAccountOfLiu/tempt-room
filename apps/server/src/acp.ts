import type { AgentOutput } from '../../../packages/protocol/src/index.ts';
import { hostDebug } from './host.ts';

export interface AcpChannel {
  request(method:string,params?:unknown,timeoutMs?:number):Promise<any>;
  send(method:string,params?:unknown):Promise<void>;
  reply(id:unknown,result:unknown):Promise<void>;
  onFrame?: (frame:any)=>void;
}
export function acpModelValue(option:any,requested:string):string {
  const flat=(options:any[]):any[]=>options.flatMap(item=>Array.isArray(item.options)?flat(item.options):[item]);
  const options=flat(option.options??[]),exact=options.find(item=>item.value===requested);
  if(exact)return exact.value;
  const matches=options.filter(item=>item.name===requested);
  if(matches.length!==1)throw new Error(matches.length?'ACP 模型名称有多个匹配，请填写完整选项值':'模型不在 ACP 返回的可选列表中；可留空使用默认模型');
  return matches[0].value;
}

export async function runAcp(options:{channel:AcpChannel;workspace:string;model:string;nativeSession?:string;prompt:string;mcpServers:unknown[];signal:AbortSignal;emit:(item:AgentOutput)=>void;setCancel:(cancel:()=>Promise<void>)=>void;onError:(error:unknown)=>void}) {
  const {channel,signal}=options;
  hostDebug('[acp] start nativeSession='+(options.nativeSession??'none'));
  channel.onFrame=frame=>{
    const update=frame.params?.update;
    if(frame.method==='session/update'&&update?.sessionUpdate!=='agent_message_chunk')hostDebug('[acp] update '+(update?.sessionUpdate??'?')+' '+JSON.stringify(update).slice(0,350));
    if(frame.method==='session/update'&&update?.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')options.emit({type:'text',text:update.content.text});
    if(frame.method==='session/request_permission'&&frame.id!==undefined){
      const choice=frame.params?.options?.find((item:any)=>item.kind==='allow_once');
      void channel.reply(frame.id,signal.aborted||!choice?{outcome:{outcome:'cancelled'}}:{outcome:{outcome:'selected',optionId:choice.optionId}}).catch(options.onError);
    }
  };
  const initialized=await channel.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'tempt-room',version:'0.1.0'}});
  if(initialized.protocolVersion!==1)throw new Error('DeepSeek ACP 不支持协议版本 1');
  const capabilities=initialized.agentCapabilities?.sessionCapabilities??{};
  if(options.nativeSession&&!capabilities.resume)throw new Error('当前 ACP 服务没有声明会话恢复能力');
  const params={cwd:options.workspace,mcpServers:options.mcpServers};
  hostDebug('[acp] session params cwd='+options.workspace+' mcp='+JSON.stringify(options.mcpServers));
  const session=await channel.request(options.nativeSession?'session/resume':'session/new',{...params,...(options.nativeSession?{sessionId:options.nativeSession}:{})});
  hostDebug('[acp] session response '+JSON.stringify(session).slice(0,1500));
  const sessionId=options.nativeSession??session.sessionId;
  if(typeof sessionId!=='string'||!sessionId)throw new Error('ACP 未返回有效会话标识');
  options.emit({type:'session',id:sessionId});
  let prompt:Promise<any>|undefined;
  options.setCancel(async()=>{await channel.send('session/cancel',{sessionId});if(prompt)await prompt.catch(()=>{});});
  try{
    signal.throwIfAborted();
    if(options.model){const option=session.configOptions?.find((item:any)=>item.category==='model'||item.id==='model');if(!option)throw new Error('DeepSeek ACP 未提供模型选择配置');await channel.request('session/set_config_option',{sessionId,configId:option.id,value:acpModelValue(option,options.model)});}
    signal.throwIfAborted();
    prompt=channel.request('session/prompt',{sessionId,prompt:[{type:'text',text:options.prompt}]},1800000);
    const result=await prompt;signal.throwIfAborted();
    if(result.stopReason!=='end_turn')throw new Error(`DeepSeek stopReason: ${result.stopReason}`);
  }finally{
    // Close only an idle session. Forced Job termination remains the bounded
    // fallback, and is the authority for process-tree cancellation status.
    if(capabilities.close&&!signal.aborted)await channel.request('session/close',{sessionId},2000).catch(()=>{});
  }
}
