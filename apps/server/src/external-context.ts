import {ProtocolError,type Task,type TaskContext,type RunContext} from '../../../packages/protocol/src/index.ts';
import {Store,uid} from './store.ts';
import {captureContext} from './context.ts';
import {contextDelta} from './context-reconciliation.ts';

const consumer=(task:Task)=>({id:task.id,roomId:task.roomId,agentId:task.agentId,basedOnSeq:task.externalContext!.baseSeq,contextSeq:task.externalContext!.throughSeq,contextPolicy:task.externalContext!.policy});

/** Called inside the command transaction. Issuance means provided, not understood. */
export function provideTaskContext(store:Store,task:Task){
  const previous=task.externalContext,head=store.room(task.roomId)!.seq;
  const delta=previous?contextDelta(store,consumer(task),true):undefined;
  const throughSeq=delta?.throughSeq??head,token=uid('context');
  const context=captureContext(store,task.roomId,throughSeq);
  store.put('contexts',{id:token,roomId:task.roomId,...context});
  const receipt:TaskContext={token,baseSeq:previous?.baseSeq??throughSeq,throughSeq,hasMore:delta?.hasMore??false,policy:previous?.policy??structuredClone(store.settings().contextPolicy)};
  return {receipt,context,delta};
}

export function taskContextInput(store:Store,receipt:TaskContext):RunContext {
  const context=store.get<RunContext>('contexts',receipt.token);
  if(!context||context.throughSeq!==receipt.throughSeq)throw new ProtocolError('context_history_unavailable','任务上下文记录缺失，不能确认交付',409);
  return context;
}

export function assertExternalContextCurrent(store:Store,task:Task,token?:string){
  const receipt=task.externalContext;
  if(!receipt||!token)throw new ProtocolError('context_receipt_required','请先用 task_context 获取任务上下文，再提交返回的 contextToken',409);
  if(token!==receipt.token)throw new ProtocolError('stale_context_receipt','上下文回执已变化，请使用最新 task_context 返回的 contextToken',409);
  taskContextInput(store,receipt);
  if(receipt.hasMore||contextDelta(store,consumer(task)))throw new ProtocolError('context_outdated','任务上下文已变化；请用 task_context 读取增量、核对候选结果后重新提交，勿重复已完成的外部副作用',409);
}
