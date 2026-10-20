import type { DatabaseSync } from 'node:sqlite';
import { eventRegistry, projectionTableNames,validateRunTransition,PARTIAL_INTERVAL_MS,terminalStates, type ProjectionTable, type Room, type RoomEvent, type RoomSnapshot, type AgentDescriptor } from '../../../packages/protocol/src/index.ts';

/** Stable JSON bytes, with the same undefined/array semantics as JSON.stringify. */
export function projectionJson(value:unknown):string {
  const normalize=(item:any):any=>Array.isArray(item)?item.map(normalize):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,normalize(item[key])])):item;
  return JSON.stringify(normalize(JSON.parse(JSON.stringify(value))));
}
export interface ProjectionSink {
  room():Room|undefined;
  putRoom(room:Room,seq:number):void;
  get(table:ProjectionTable,id:string):any;
  list(table:ProjectionTable):any[];
  put(table:ProjectionTable,value:any,seq:number):void;
  clear(table:ProjectionTable):void;
}

/** Exactly the same reducer is used for live writes, rebuilds and historic reads. */
export function projectEvent(sink:ProjectionSink,event:RoomEvent){
  const definition=eventRegistry[event.type];
  if(!definition||definition.durability!=='durable'){
    if(event.schemaVersion===0)return; // Opaque pre-migration facts are retained.
    throw new Error(`Unregistered replay event: ${event.type}`);
  }
  if(event.schemaVersion!==0&&event.schemaVersion!==definition.schemaVersion)throw new Error(`Unsupported replay schema version: ${event.type}@${event.schemaVersion}`);
  const parsed=definition.payload.safeParse(event.payload);
  if(!parsed.success){if(event.schemaVersion===0)return;throw new Error(`Invalid replay payload: ${event.type}`);}
  const payload=parsed.data as any,put=(table:ProjectionTable,value:any)=>{
    if(!value||typeof value.id!=='string'||(value.roomId!==undefined&&value.roomId!==event.roomId))throw new Error('Projection entity crosses its room boundary');
    sink.put(table,{...value,roomId:event.roomId},event.seq);
  };
  switch(definition.projector){
    case 'room':{
      const value=payload.room??{...sink.room()!,members:payload.members};
      if(value.id!==event.roomId)throw new Error('Room projection identity mismatch');
      sink.putRoom(value,event.seq);break;
    }
    case 'message':{
      const message=payload.message,run=message.runId?sink.get('runs',message.runId):undefined;
      if(event.schemaVersion!==0&&message.actor.kind==='agent'&&run&&(run.generation!==undefined||run.executionId)&&(message.generation!==(run.generation??1)||message.executionId!==run.executionId))throw new Error('Stale message generation or execution identity');
      if(message.final&&run){
        if(run.stopReason==='superseded')throw new Error('Superseded run cannot publish a final reply');
        if(message.supersedes!==run.partial?.id)throw new Error('Final reply must supersede the current partial');
        if(run.finalMessageId&&run.finalMessageId!==message.id)throw new Error('Run already has a final reply');
        put('runs',{...run,finalMessageId:message.id});
      }
      put('messages',message);break;
    }
    case 'task':{
      const previous=sink.get('tasks',payload.task.id),next=payload.task,receipt=next.externalContext;
      if(event.schemaVersion!==0){
        const sameLease=previous&&(previous.generation??1)===(next.generation??1)&&previous.version===next.version;
        if(event.type==='task.context.advanced'||event.type==='task.claimed'&&receipt){
          const context=receipt&&sink.get('contexts',receipt.token);
          if(!context||context.throughSeq!==receipt.throughSeq||context.roomId!==event.roomId||receipt.baseSeq>receipt.throughSeq||receipt.throughSeq>=event.seq||!next.leaseUntil||next.status!=='running')throw new Error('Task context has no leased input snapshot');
          if(event.type==='task.context.advanced'){
            if(!previous||!sameLease||previous.agentId!==next.agentId)throw new Error('Task context cannot replace a lease');
            const before=previous.externalContext;
            if(before&&(receipt.token===before.token||receipt.baseSeq!==before.baseSeq||receipt.throughSeq<before.throughSeq||projectionJson(receipt.policy)!==projectionJson(before.policy)||payload.delta?.fromSeq!==before.throughSeq||payload.delta?.throughSeq!==receipt.throughSeq||payload.delta?.hasMore!==receipt.hasMore||payload.delta?.headSeq>=event.seq))throw new Error('Invalid external context advancement');
          }
        }else if(sameLease&&projectionJson([previous.externalContext])!==projectionJson([receipt]))throw new Error('Task context requires an input event');
        if(event.type==='task.completed'&&previous?.externalContext&&payload.contextToken!==previous.externalContext.token)throw new Error('Task completion has no current input receipt');
      }
      put('tasks',payload.task);
      // Task versions fence previously published summaries as well as runs.
      for(const message of sink.list('messages')){
        const run=message.runId?sink.get('runs',message.runId):undefined;
        if((message.taskId??run?.taskId)===payload.task.id&&(message.taskVersion??run?.taskVersion??0)<payload.task.version&&!message.stale)put('messages',{...message,stale:true});
      }
      break;
    }
    case 'run':{
      const previous=sink.get('runs',payload.run.id),next=payload.run;
      if(event.schemaVersion!==0)validateRunTransition(previous,next,event.type);
      if(previous&&event.schemaVersion!==0){
        const generation=previous.generation??1;
        if(projectionJson([next.effectScope])!==projectionJson([previous.effectScope]))throw new Error('Execution effect scope is immutable');
        if(previous.contextPolicy&&(next.basedOnSeq!==previous.basedOnSeq||next.contextId!==previous.contextId||projectionJson([next.contextPolicy])!==projectionJson([previous.contextPolicy])))throw new Error('Original context and policy are immutable');
        if(event.type==='run.context.advanced'){
          if(next.generation!==generation+1||!next.executionId||next.executionId===previous.executionId||next.status!=='running'||previous.finalMessageId||previous.stopReason)throw new Error('Invalid context continuation identity');
          if(next.contextSeq<= (previous.contextSeq??previous.basedOnSeq)||next.basedOnSeq!==previous.basedOnSeq||next.contextId!==previous.contextId||!next.contextPending||next.contextRound!==(previous.contextRound??0)+1)throw new Error('Invalid context continuation watermark');
          const context=sink.get('contexts',next.deltaContextId);
          if(!context||context.throughSeq!==next.contextSeq||payload.delta.fromSeq!==(previous.contextSeq??previous.basedOnSeq)||payload.delta.throughSeq!==next.contextSeq||payload.delta.headSeq>=event.seq)throw new Error('Context continuation has no matching input');
        }else if(event.type==='run.recovered'){
          if(next.generation!==generation+1||!['interrupted','unknown'].includes(next.status)||next.executionId)throw new Error('Invalid run generation recovery');
        }else if((next.generation??1)!==generation||previous.executionId&&next.executionId!==previous.executionId)throw new Error('Stale run generation or execution identity');
        if(event.type!=='run.context.advanced'&&['contextSeq','deltaContextId','contextRound','contextPending','contextConfirmedSeq'].some(key=>projectionJson([next[key]])!==projectionJson([previous[key]])))throw new Error('Context watermark requires a context event');
        if(previous.roomId!==next.roomId||previous.agentId!==next.agentId)throw new Error('Run identity cannot change');
      }
      const projected={...next};
      for(const field of ['partial','finalMessageId']){
        if(next[field]!==undefined&&(previous?.[field]===undefined||projectionJson(next[field])!==projectionJson(previous[field])))throw new Error('Progress must be written through its own event');
        if(previous?.[field]!==undefined)projected[field]=previous[field];
        else if(next[field]!==undefined)throw new Error('Progress must be written through its own event');
      }
      put('runs',projected);
      if(payload.context&&payload.run.contextId)put('contexts',{...payload.context,id:payload.run.contextId});
      break;
    }
    case 'context-confirmed':{
      const run=sink.get('runs',payload.runId);
      if(!run||run.generation!==payload.generation||run.executionId!==payload.executionId||payload.throughSeq!==(run.contextSeq??run.basedOnSeq))throw new Error('Invalid context confirmation');
      put('runs',{...run,contextPending:false,contextConfirmedSeq:payload.throughSeq});break;
    }
    case 'partial':{
      const run=sink.get('runs',payload.runId),partial=payload.partial;
      if(!run||run.generation!==payload.generation||run.executionId!==payload.executionId)throw new Error('Stale partial generation or execution identity');
      if(!['running','waiting_input'].includes(run.status)||run.finalMessageId)throw new Error('Run cannot publish another partial');
      if(run.taskId&&sink.get('tasks',run.taskId)?.version!==run.taskVersion)throw new Error('Partial belongs to an old task version');
      if(partial.supersedes!==run.partial?.id||partial.id===run.partial?.id)throw new Error('Partial supersede chain is invalid');
      if(run.partial&&Date.parse(event.createdAt)-Date.parse(run.partial.createdAt)<PARTIAL_INTERVAL_MS)throw new Error('Partial rate limit exceeded');
      put('runs',{...run,partial:{...partial,createdAt:event.createdAt}});break;
    }
    case 'final':{
      const run=sink.get('runs',payload.runId),message=sink.get('messages',payload.messageId);
      if(run?.stopReason==='superseded')throw new Error('Superseded run cannot finalize a reply');
      if(!run||!message||message.runId!==run.id||message.actor.id!==run.agentId||payload.generation!==(run.generation??1)||payload.executionId!==run.executionId)throw new Error('Final reply has no current run binding');
      if(payload.supersedes!==run.partial?.id||run.finalMessageId&&run.finalMessageId!==message.id)throw new Error('Invalid final supersede chain');
      put('messages',{...message,final:true,supersedes:payload.supersedes});put('runs',{...run,finalMessageId:message.id});break;
    }
    case 'artifact':{
      const artifact=payload.artifact,run=artifact.runId?sink.get('runs',artifact.runId):undefined;
      if(event.schemaVersion!==0&&run&&(run.generation!==undefined||run.executionId)&&(artifact.generation!==(run.generation??1)||artifact.executionId!==run.executionId))throw new Error('Stale artifact generation or execution identity');
      put('artifacts',artifact);break;
    }
    case 'discussion':put('discussions',payload.discussion);break;
    case 'decision':put('decisions',payload.decision);break;
    case 'context':put('contexts',payload.context);break;
    case 'operation':{
      const operation=payload.operation,previous=sink.get('operations',operation.id);
      const run=sink.get('runs',operation.runId);
      const reconciled=event.type==='operation.reconciled';
      if(reconciled){
        const native=previous?.native,proof=payload.proof,state=run?.codex;
        if(!native||native.provider!=='codex'||previous.status==='completed'||operation.agentId!==run?.agentId||native.clientUserMessageId!==proof.clientUserMessageId||state?.clientUserMessageId!==proof.clientUserMessageId||state.binding.threadId!==proof.threadId||native.sessionId!==proof.threadId||state.nativeTurnId!==proof.turnId||state.nativeStatus!==proof.status||!['completed','canceled'].includes(state.phase))throw new Error('Native operation has no verified recovery binding');
        if(native.scope==='tool'&&(native.itemId!==proof.itemId||!proof.itemStatus))throw new Error('Native tool recovery has no matching item receipt');
        if(operation.result?.reconciled!==true||operation.result?.outcome!==(native.scope==='tool'?proof.itemStatus:proof.status))throw new Error('Native recovery result disagrees with its receipt');
      }
      if(event.type!=='operation.unknown'&&!reconciled&&(!run||operation.generation!==(run.generation??1)||operation.executionId!==run.executionId||operation.agentId!==run.agentId))throw new Error('Stale tool operation generation or execution identity');
      if(previous&&(previous.hash!==operation.hash||previous.runId!==operation.runId||previous.roomId!==operation.roomId||previous.agentId!==operation.agentId||previous.generation!==operation.generation||previous.operationId!==operation.operationId||previous.executionId!==operation.executionId))throw new Error('Tool operation identity cannot change');
      if(previous&&projectionJson([previous.native])!==projectionJson([operation.native]))throw new Error('Native operation provenance cannot change');
      if(previous&&previous.status!=='started'&&!reconciled&&projectionJson(previous)!==projectionJson(operation))throw new Error('Tool operation is already settled');
      put('operations',operation);break;
    }
    case 'sandbox':{
      const run=sink.get('runs',payload.runId);
      if(!run)throw new Error('Sandbox proof has no run');
      if(event.schemaVersion!==0&&(run.generation!==undefined||run.executionId)&&(payload.generation!==(run.generation??1)||payload.executionId!==run.executionId))throw new Error('Stale sandbox proof');
      put('runs',{...run,sandbox:payload.sandbox});break;
    }
    case 'checkpoint':{
      if(payload.room.id!==event.roomId)throw new Error('Checkpoint room mismatch');
      for(const table of projectionTableNames){sink.clear(table);for(const row of payload.rows[table])put(table,row);}
      sink.putRoom(payload.room,event.seq);break;
    }
    // Control-plane configuration is kept separately; these events invalidate
    // clients and are auditable, but never replay settings from another room.
    case 'agent-session':put('agent_sessions',payload.agentSession);break;
    case 'subscription':put('subscriptions',payload.subscription);break;
    case 'inbox-delivery':put('inbox_deliveries',payload.delivery);break;
    case 'input-batch':put('input_batches',payload.batch);break;
    case 'wake-intent':put('wake_intents',payload.wakeIntent);break;
    case 'capability-evidence':put('capability_evidence',payload.capabilityEvidence);break;
    case 'discussion-round':put('discussion_rounds',payload.round);break;
    case 'project-binding':put('project_bindings',payload.projectBinding);break;
    case 'integration':put('integrations',payload.integration);break;
    case 'settings':case 'audit':break;
  }
}

export class SqlProjectionSink implements ProjectionSink {
  constructor(private db:DatabaseSync,private roomId:string){}
  room():Room|undefined {
    const row=this.db.prepare('SELECT body,seq FROM rooms WHERE id=?').get(this.roomId) as any;
    return row?{...JSON.parse(row.body),seq:row.seq}:undefined;
  }
  putRoom(room:Room,seq:number){this.db.prepare('UPDATE rooms SET body=?,seq=?,as_of_seq=? WHERE id=?').run(projectionJson({...room,seq}),seq,seq,this.roomId);}
  get(table:ProjectionTable,id:string){const row=this.db.prepare(`SELECT body FROM ${table} WHERE id=? AND room_id=?`).get(id,this.roomId) as any;return row?JSON.parse(row.body):undefined;}
  list(table:ProjectionTable){return this.db.prepare(`SELECT body FROM ${table} WHERE room_id=? ORDER BY rowid`).all(this.roomId).map((row:any)=>JSON.parse(row.body));}
  put(table:ProjectionTable,value:any,seq:number){
    const existing=this.db.prepare(`SELECT room_id FROM ${table} WHERE id=?`).get(value.id) as any;
    if(existing&&existing.room_id!==this.roomId)throw new Error('Projection id is already owned by another room');
    this.db.prepare(`INSERT INTO ${table}(id,room_id,body,as_of_seq) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,as_of_seq=excluded.as_of_seq`).run(value.id,this.roomId,projectionJson(value),seq);
  }
  clear(table:ProjectionTable){this.db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(this.roomId);}
}

export class MemoryProjectionSink implements ProjectionSink {
  private current?:Room;
  readonly tables=new Map<ProjectionTable,Map<string,any>>(projectionTableNames.map(name=>[name,new Map()]));
  room(){return this.current;}
  putRoom(room:Room,seq:number){this.current={...structuredClone(room),seq};}
  get(table:ProjectionTable,id:string){return this.tables.get(table)!.get(id);}
  list(table:ProjectionTable){return [...this.tables.get(table)!.values()];}
  put(table:ProjectionTable,value:any,_seq:number){this.tables.get(table)!.set(value.id,structuredClone(value));}
  clear(table:ProjectionTable){this.tables.get(table)!.clear();}
  advance(seq:number){if(this.current)this.current.seq=seq;}
  snapshot(agents:AgentDescriptor[]):RoomSnapshot{
    if(!this.current)throw new Error('Room has no creation or checkpoint event');
    return {room:this.current,agents:agents.filter(agent=>this.current!.members.includes(agent.id)),messages:this.list('messages'),tasks:this.list('tasks'),runs:this.list('runs'),artifacts:this.list('artifacts'),discussions:this.list('discussions'),decisions:this.list('decisions')};
  }
}
