import { idSchema,ProtocolError,type RunFence,type ToolOperation } from '../../../packages/protocol/src/index.ts';
import { Store,digest,now,SYSTEM } from './store.ts';
import { assertRunFence } from './execution.ts';
import {assertContextCurrent} from './context-reconciliation.ts';

/** Reservations commit before side effects. An uncertain operation is never rerun. */
export class ToolOperations {
  constructor(private store:Store,private maxResultBytes:()=>number=()=>2**21){}
  execute(fence:RunFence,operationId:string,name:string,args:unknown,action:()=>unknown):any {
    idSchema.parse(operationId);
    const hash=digest({name,args}),id='op_'+digest([fence.runId,fence.agentId,fence.generation,operationId]);
    const reserved=this.store.atomic(()=>{
      const current=assertRunFence(this.store,fence);
      const prior=this.store.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.runId')=? AND json_extract(body,'$.agentId')=? AND json_extract(body,'$.operationId')=? ORDER BY json_extract(body,'$.generation') DESC LIMIT 1").get(fence.runId,fence.agentId,operationId) as {body:string}|undefined;
      const previous=this.store.get<ToolOperation>('operations',id)??(prior?JSON.parse(prior.body) as ToolOperation:undefined);
      if(previous){
        if(previous.hash!==hash)throw new ProtocolError('operation_conflict','同一 operationId 不能用于不同工具或参数',409);
        if(previous.status==='completed')return {previous};
        throw new ProtocolError('operation_outcome_unknown','该操作已开始，结果尚未确认；不能自动重做副作用',409);
      }
      assertContextCurrent(this.store,current);
      const operation:ToolOperation={id,...fence,operationId,name,hash,status:'started',createdAt:now(),updatedAt:now()};
      this.store.event(fence.roomId,'operation.started',SYSTEM,{operation},null,fence.runId);
      return {operation};
    });
    if(reserved.previous)return structuredClone(reserved.previous.result);
    const operation=reserved.operation!;
    try {
      return this.store.atomic(()=>{
        assertRunFence(this.store,fence);
        const result=action();
        if(result&&typeof (result as any).then==='function')throw new Error('Tool operation must finish synchronously inside its commit');
        // Persist exactly what the transport can acknowledge, not a mutable object.
        const wire=JSON.stringify(result??null);const limit=this.maxResultBytes();if(Buffer.byteLength(wire)>limit)throw new Error('Tool result exceeds configured limit');
        operation.status='completed';operation.result=JSON.parse(wire);operation.updatedAt=now();
        this.store.event(fence.roomId,'operation.completed',SYSTEM,{operation},null,fence.runId);
        return structuredClone(operation.result);
      });
    } catch(error) {
      // A filesystem or external effect may have happened even if SQL rolled back.
      this.store.atomic(()=>{operation.status='unknown';delete operation.result;operation.updatedAt=now();this.store.event(fence.roomId,'operation.unknown',SYSTEM,{operation},null,fence.runId);});
      throw error;
    }
  }
}
