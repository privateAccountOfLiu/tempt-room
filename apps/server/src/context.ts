import {contextSeqOf,ProtocolError} from '../../../packages/protocol/src/index.ts';
import type { Decision,Message,Run,RunContext,Task } from '../../../packages/protocol/src/index.ts';
import type { Store } from './store.ts';
import type { EventStore } from './ports/event-store.ts';

/** Reconstruct at an event cursor, never from mutable current message rows. */
export function captureContext(store: EventStore,roomId:string,throughSeq:number):RunContext {
  const maxMessages=store.settings().maxContextMessages;
  const messages:{seq:number;message:Message}[]=[],decisions=new Map<string,Decision>(),runs=new Map<string,Pick<Run,'taskId'|'taskVersion'>>();let cursor=0;
  while(cursor<throughSeq){
    const page=store.events(roomId,cursor,1000).filter(event=>event.seq<=throughSeq);if(!page.length)break;
    for(const event of page){
      if(event.type==='chat.message.created'){
        messages.push({seq:event.seq,message:structuredClone(event.payload.message as Message)});if(messages.length>maxMessages)messages.shift();
      } else if(event.type==='decision.accepted'){const decision=event.payload.decision as Decision;decisions.set(decision.id,structuredClone(decision));}
      else if(event.type==='run.created'||event.type==='run.updated'){const run=event.payload.run as Run;runs.set(run.id,{taskId:run.taskId,taskVersion:run.taskVersion});}
      else if(event.type==='task.revised'||event.type==='task.handoff'){
        const task=event.payload.task as Task;
        for(const {message} of messages){const run=message.runId?runs.get(message.runId):undefined,taskId=message.taskId??run?.taskId,version=message.taskVersion??run?.taskVersion??0;if(taskId===task.id&&version<task.version)message.stale=true;}
      }
    }
    cursor=page.at(-1)!.seq;
  }
  const floor=store.projectionStatus(roomId).historyFloor;
  if(throughSeq<floor)throw new ProtocolError('context_history_unavailable','历史上下文早于可证明的迁移基线',409);
  const snapshot=store.snapshotAt(roomId,throughSeq);
  return {fromSeq:messages[0]?.seq??throughSeq,throughSeq,messages:messages.map(item=>item.message),decisions:[...decisions.values()],members:snapshot.agents.map(({id,name,role})=>({id,name,role}))};
}
export function runContext(store: EventStore,run:Run):RunContext {
  if(run.deltaContextId){const delta=store.get<RunContext>('contexts',run.deltaContextId);if(delta)return delta;}
  return run.contextId?store.get<RunContext>('contexts',run.contextId)??captureContext(store,run.roomId,contextSeqOf(run)):captureContext(store,run.roomId,contextSeqOf(run));
}
