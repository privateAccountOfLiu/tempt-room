import {digest} from './store.ts';

export type NativeProvider='codex'|'claude'|'deepseek';
export interface NativeEvidence {provider:NativeProvider;itemId:string;kind:string;sessionId?:string;turnId?:string;phase:'started'|'completed'|'unknown';requestHash:string;outcome?:'completed'|'failed'|'declined'|'canceled';exitCode?:number;durationMs?:number}
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512;
export function nativeOutcome(value:unknown):NativeEvidence['outcome']|undefined {
  if(value==='completed'||value==='success')return 'completed';
  if(value==='failed'||value==='error')return 'failed';
  if(value==='declined'||value==='denied')return 'declined';
  if(value==='canceled'||value==='cancelled'||value==='interrupted')return 'canceled';
}
/** Metadata only: never persist command text, tool arguments, output or reasoning. */
export class NativeEvidenceParser {
  private items=new Map<string,NativeEvidence>();
  private claudeSession?:string;
  constructor(private emit:(evidence:NativeEvidence)=>void){}
  private accept(provider:NativeProvider,itemId:unknown,kind:unknown,phase:NativeEvidence['phase'],input:unknown,fields:Partial<NativeEvidence>={}){
    if(!text(itemId)||typeof kind!=='string'||!kind||kind.length>100)throw new Error('原生工具回执缺少有效且有界的身份');
    const key=digest([provider,fields.sessionId,fields.turnId,itemId]),previous=this.items.get(key);
    if(!previous&&this.items.size>=10000)throw new Error('原生工具回执超过 10000 条上限');
    if(previous?.kind&&previous.kind!==kind)throw new Error('原生工具标识被用于不同工具');
    if(previous?.phase==='completed'){
      if(phase==='completed'&&previous.outcome!==fields.outcome)throw new Error('原生工具终态回执互相冲突');
      return;
    }
    const next:NativeEvidence={provider,itemId,kind,phase,requestHash:previous?.requestHash??digest(input??null),...fields};
    if(previous?.phase==='started'&&phase==='started')return;
    this.emit(next);this.items.set(key,next);
  }
  codex(frame:any){
    if(!['item/started','item/completed'].includes(frame?.method))return;
    const p=frame.params,item=p?.item;if(!['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabToolCall','webSearch','imageView'].includes(item?.type))return;
    const outcome=frame.method==='item/completed'?(nativeOutcome(item.status)??(item.type==='webSearch'||item.type==='imageView'?'completed':undefined)):undefined;
    this.accept('codex',item.id,item.type,frame.method==='item/started'?'started':outcome?'completed':'unknown',{command:item.command,cwd:item.cwd,changes:item.changes,server:item.server,tool:item.tool,arguments:item.arguments,query:item.query,path:item.path},{...(text(p.threadId)?{sessionId:p.threadId}:{}),...(text(p.turnId)?{turnId:p.turnId}:{}),...(outcome?{outcome}:{}),...(Number.isSafeInteger(item.exitCode)?{exitCode:item.exitCode}:{}),...(Number.isFinite(item.durationMs)&&item.durationMs>=0?{durationMs:item.durationMs}:{})});
  }
  claude(frame:any){
    if(frame?.type==='system'&&frame.subtype==='init'&&text(frame.session_id)&&!frame.parent_tool_use_id)this.claudeSession=frame.session_id;
    const content=frame?.message?.content;if(!Array.isArray(content))return;
    for(const item of content){
      let sessionId=text(frame.session_id)?frame.session_id:this.claudeSession;
      if(item.type==='tool_use')this.accept('claude',item.id,item.name,'started',item.input,{sessionId});
      if(item.type==='tool_result'){
        const candidates=[...this.items.values()].filter(value=>value.provider==='claude'&&value.itemId===item.tool_use_id);
        const previous=this.items.get(digest(['claude',sessionId,undefined,item.tool_use_id]))??(candidates.length===1?candidates[0]:undefined);
        if(previous)sessionId=previous.sessionId;
        // A result without a matching tool call still records its reported end.
        this.accept('claude',item.tool_use_id,previous?.kind??'tool_result','completed',null,{sessionId,outcome:item.is_error?'failed':'completed'});
      }
    }
  }
  acp(frame:any){
    const update=frame?.params?.update;
    if(frame?.method!=='session/update'||!['tool_call','tool_call_update'].includes(update?.sessionUpdate))return;
    const sessionId=text(frame.params.sessionId)?frame.params.sessionId:undefined,key=digest(['deepseek',sessionId,undefined,update.toolCallId]),previous=this.items.get(key),outcome=nativeOutcome(update.status);
    const kind=previous?.kind??(typeof update.kind==='string'?update.kind:'tool_call');
    this.accept('deepseek',update.toolCallId,kind,outcome?'completed':['pending','in_progress',undefined].includes(update.status)?'started':'unknown',update.rawInput,{sessionId,...(outcome?{outcome}:{})});
  }
}
