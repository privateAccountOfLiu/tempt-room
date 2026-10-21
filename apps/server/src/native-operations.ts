import {ProtocolError,type Run,type RunFence,type ToolOperation,type AgentDescriptor} from '../../../packages/protocol/src/index.ts';
import {Store,digest,now,SYSTEM} from './store.ts';
import {assertRunFence} from './execution.ts';
import {ExecutionUnknown} from './errors.ts';
import {nativeOutcome,type NativeEvidence} from './native-evidence.ts';
import type { EventStore } from './ports/event-store.ts';

export class NativeOperations {
  constructor(private store: EventStore){}
  begin(fence:RunFence,agent:AgentDescriptor,prompt:string,nativeSession?:string){
    return this.store.atomic(()=>{
      const run=assertRunFence(this.store,fence),inputId=digest([run.id,run.deltaContextId??run.contextId??run.basedOnSeq]),operationId='native_intent_'+inputId;
      const prior=this.store.list<ToolOperation>('operations',run.roomId).find(operation=>operation.runId===run.id&&operation.operationId===operationId);
      if(prior)throw new ExecutionUnknown('此原生输入已有执行意图或回执；不能自动重复启动，请先核对原生结果');
      const operation:ToolOperation={id:'op_'+digest([run.id,fence.generation,operationId]),...fence,operationId,name:'native.execution',hash:digest(prompt),status:'started',native:{provider:agent.provider as NativeEvidence['provider'],scope:'execution',evidence:'execution-intent',inputId,kind:'execution',...(agent.connectionMode==='attach'?{sessionId:agent.codexBinding!.threadId,clientUserMessageId:`tempt_room_${run.id}_g${fence.generation}`}:(nativeSession?{sessionId:nativeSession}:{}))},createdAt:now(),updatedAt:now()};
      this.store.event(run.roomId,'operation.started',SYSTEM,{operation},null,run.id);return operation;
    });
  }
  observe(intent:ToolOperation,evidence:NativeEvidence){
    return this.store.atomic(()=>{
      assertRunFence(this.store,intent,{allowTerminal:true,allowStaleTask:true});
      if(evidence.provider!==intent.native?.provider)throw new ProtocolError('native_evidence_mismatch','原生回执提供方不匹配',409);
      const operationId='native_tool_'+digest([intent.native.inputId,evidence.provider,evidence.sessionId,evidence.turnId,evidence.itemId]),id='op_'+digest([intent.runId,intent.generation,operationId]);
      const previous=this.store.get<ToolOperation>('operations',id);
      if(previous?.status==='completed'){
        if(evidence.phase==='completed'&&(previous.result as any)?.outcome!==evidence.outcome)throw new ExecutionUnknown('原生工具终态回执冲突');
        return;
      }
      const operation:ToolOperation=previous??{id,runId:intent.runId,roomId:intent.roomId,agentId:intent.agentId,generation:intent.generation,executionId:intent.executionId,operationId,name:'native.tool',hash:evidence.requestHash,status:'started',native:{...intent.native!,scope:'tool',evidence:'provider-notification',kind:evidence.kind,itemId:evidence.itemId,...(evidence.sessionId?{sessionId:evidence.sessionId}:{}),...(evidence.turnId?{turnId:evidence.turnId}:{})},createdAt:now(),updatedAt:now()};
      if(!previous)this.store.event(intent.roomId,'operation.started',SYSTEM,{operation},null,intent.runId);
      if(evidence.phase==='started')return;
      operation.status=evidence.phase==='completed'?'completed':'unknown';operation.updatedAt=now();
      if(evidence.phase==='completed')operation.result={outcome:evidence.outcome,...(evidence.exitCode!==undefined?{exitCode:evidence.exitCode}:{}),...(evidence.durationMs!==undefined?{durationMs:evidence.durationMs}:{})};
      this.store.event(intent.roomId,'operation.'+operation.status,SYSTEM,{operation},null,intent.runId);
    });
  }
  complete(intent:ToolOperation,outcome:'adapter-returned'|'failed'='adapter-returned'){
    this.store.atomic(()=>{
      assertRunFence(this.store,intent,{allowTerminal:true,allowStaleTask:true});
      if(this.store.list<ToolOperation>('operations',intent.roomId).some(op=>op.runId===intent.runId&&op.executionId===intent.executionId&&op.id!==intent.id&&op.status!=='completed'))throw new ExecutionUnknown('原生执行已返回，但仍有工具操作结果未确认；未接受最终交付');
      const current=this.store.get<ToolOperation>('operations',intent.id)!;if(current.status!=='started')throw new ExecutionUnknown('原生执行意图已失去活动授权');
      current.status='completed';current.result={outcome,adapterSettled:true,scope:intent.native?.clientUserMessageId?'external-backend':'owned-process'};current.updatedAt=now();
      this.store.event(intent.roomId,'operation.completed',SYSTEM,{operation:current},null,intent.runId);
    });
  }
  abandon(intent:ToolOperation){
    try{this.store.atomic(()=>{for(const operation of this.store.list<ToolOperation>('operations',intent.roomId))if(operation.runId===intent.runId&&operation.executionId===intent.executionId&&operation.native&&operation.status==='started'){
      operation.status='unknown';operation.updatedAt=now();this.store.event(operation.roomId,'operation.unknown',SYSTEM,{operation},null,operation.runId);
    }});}catch(error){throw new ExecutionUnknown('原生操作账本未能确认终态；不能将其视为执行成功',{cause:error});}
  }
  /** The caller has located this exact client input using native read-only history. */
  reconcileCodex(run:Run,turn:any){
    if(!run.codex||turn.id!==run.codex.nativeTurnId||!Array.isArray(turn.items)||turn.itemsView&&turn.itemsView!=='full'||!['completed','failed','interrupted'].includes(turn.status))throw new ExecutionUnknown('原生核对未提供完整的对应轮次');
    const pending=this.store.atomic(()=>{
      for(const operation of this.store.list<ToolOperation>('operations',run.roomId)){
        const native=operation.native;
        if(operation.runId!==run.id||!native||native.provider!=='codex'||native.clientUserMessageId!==run.codex!.clientUserMessageId||operation.status==='completed')continue;
        const items=native.scope==='tool'?turn.items.filter((item:any)=>item.id===native.itemId):[],item=items[0],outcome=native.scope==='execution'?turn.status:items.length===1?nativeOutcome(item?.status):undefined;
        if(!outcome)continue;
        const proof={threadId:run.codex!.binding.threadId,turnId:turn.id,clientUserMessageId:run.codex!.clientUserMessageId,status:turn.status,itemsView:'full' as const,...(native.scope==='tool'?{itemId:native.itemId,itemStatus:outcome}:{})};
        operation.status='completed';operation.updatedAt=now();operation.result={outcome,reconciled:true};
        this.store.event(run.roomId,'operation.reconciled',SYSTEM,{operation,proof},null,run.id);
      }
      return this.store.list<ToolOperation>('operations',run.roomId).some(operation=>operation.runId===run.id&&operation.native?.clientUserMessageId===run.codex!.clientUserMessageId&&operation.status!=='completed');
    });
    if(pending)throw new ExecutionUnknown('完整原生轮次仍缺少某些操作终态，未确认交付');
  }
}
