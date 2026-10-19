import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {uid,SYSTEM,Store} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import type {Task,Message} from '../packages/protocol/src/index.ts';
// @ts-expect-error Standalone Node connector module is also shipped without TypeScript.
import {completeClaimedTask} from '../scripts/room-task-context.mjs';

async function fixture(t:TestContext){
  const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'external-context-'));
  const state=await createApp({root,token:'context-owner',startWorker:false});
  t.after(async()=>{await state.app.close();rmSync(root,{recursive:true,force:true});});
  const {store,service,app}=state,agentId='demo-planner';
  const roomId=service.execute({version:'0.1',commandId:uid(),type:'room.create',payload:{name:'task input receipts',members:[agentId,'demo-reviewer']}}).result.roomId as string;
  const command=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
  const taskId=command('task.create',{title:'external work',open:true}).result.taskId as string;
  const connection=await app.inject({url:`/api/agents/${agentId}/connect?roomId=${roomId}`,headers:{host:'127.0.0.1:4317',authorization:'Bearer context-owner','room-protocol-version':'0.1'}});
  const call=async(name:string,args:any={},commandId=uid())=>app.inject({method:'POST',url:'/api/agent/tool',headers:{host:'127.0.0.1:4317',authorization:'Bearer '+connection.json().token,'room-protocol-version':'0.1'},payload:{roomId,commandId,name,arguments:args}});
  const claimed=await call('task_claim',{taskId});assert.equal(claimed.statusCode,200);const claim=claimed.json().result.result;
  const input={taskId,taskVersion:claim.version,generation:claim.generation};
  return {...state,root,roomId,agentId,taskId,claim,input,command,call};
}

test('external completion echoes a server-issued input receipt and retains its exact committed response',async t=>{
  const {store,roomId,claim,input,call}=await fixture(t);
  assert.equal(claim.context.throughSeq,claim.throughSeq);assert.ok(claim.contextToken);
  assert.equal(store.events(roomId).find(event=>event.type==='task.claimed')!.baseSeq,claim.throughSeq);
  assert.equal((await call('task_complete',input)).json().code,'context_receipt_required');
  assert.equal((await call('task_complete',{...input,contextToken:'forged_future_input'})).json().code,'stale_context_receipt');
  const commandId=uid(),args={...input,contextToken:claim.contextToken,summary:'accepted candidate'};
  const first=await call('task_complete',args,commandId);assert.equal(first.statusCode,200,first.body);
  const message=store.list<Message>('messages',roomId).find(message=>message.taskId===input.taskId)!;
  assert.equal(message.basedOnSeq,claim.throughSeq);assert.equal(message.generation,claim.generation);
  const retry=await call('task_complete',args,commandId);assert.deepEqual(retry.json(),first.json());
  assert.equal(store.list<Message>('messages',roomId).filter(message=>message.taskId===input.taskId).length,1);
  assert.equal((await call('task_complete',{...args,summary:'changed'},commandId)).json().code,'idempotency_conflict');
});

test('accepted decisions require bounded delta reconciliation, heartbeat and inbox reads cannot acknowledge it',async t=>{
  const {store,roomId,claim,input,command,call}=await fixture(t);
  const decisionId=command('decision.propose',{text:'Use the new requirement'}).result.decisionId;command('decision.accept',{decisionId});
  await call('task_heartbeat',input);await call('room_read');await call('room_inbox',{afterSeq:claim.throughSeq});
  assert.equal((await call('task_complete',{...input,contextToken:claim.contextToken,summary:'old result'})).json().code,'context_outdated');
  assert.equal(store.list<Message>('messages',roomId).length,0);
  const id=uid(),updated=await call('task_context',input,id);assert.equal(updated.statusCode,200,updated.body);const provided=updated.json().result.result;
  assert.ok(provided.delta.changes.some((change:any)=>change.type==='decision.accepted'));
  assert.ok(provided.throughSeq>claim.throughSeq);assert.notEqual(provided.contextToken,claim.contextToken);
  assert.deepEqual((await call('task_context',input,id)).json(),updated.json());
  assert.equal((await call('task_complete',{...input,contextToken:claim.contextToken})).json().code,'stale_context_receipt');
  assert.equal((await call('task_complete',{...input,contextToken:provided.contextToken,summary:'reconciled result'})).statusCode,200);
  const before=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),before);
});

test('a full external context page never acknowledges its omitted suffix',async t=>{
  const {store,service,roomId,claim,input,command,call}=await fixture(t);
  // Policy belongs to the lease. Re-claim after changing its byte budget.
  command('task.release',{taskId:input.taskId});command('settings.update',{...store.settings(),contextPolicy:{maxLag:1,maxRounds:0,maxDeltaBytes:4096}});
  const next=(await call('task_claim',{taskId:input.taskId})).json().result.result;const lease={taskId:input.taskId,taskVersion:next.version,generation:next.generation};
  for(let i=0;i<5;i++)command('message.send',{text:'change '+i+' '+ 'x'.repeat(1600),mentions:[]});
  const all:string[]=[];let token=next.contextToken,hasMore=true,iterations=0;
  while(hasMore){
    const response=await call('task_context',lease);assert.equal(response.statusCode,200,response.body);const page=response.json().result.result;
    all.push(...page.delta.changes.map((change:any)=>change.eventId));token=page.contextToken;hasMore=page.hasMore;
    if(hasMore)assert.equal((await call('task_complete',{...lease,contextToken:token})).json().code,'context_outdated');
    assert.ok(++iterations<10);
  }
  assert.ok(iterations>=3);assert.equal(new Set(all).size,all.length);assert.equal(all.length,5);
  assert.equal((await call('task_complete',{...lease,contextToken:claim.contextToken})).json().code,'stale_context_receipt');
  assert.equal((await call('task_complete',{...lease,contextToken:token})).statusCode,200);
});

test('new mentions revoke a candidate receipt; replacement leases and tasks cannot reuse it',async t=>{
  const {store,roomId,agentId,claim,input,command,call,service}=await fixture(t);
  command('message.send',{text:'Please also consider this',mentions:[agentId]});
  assert.equal((await call('task_complete',{...input,contextToken:claim.contextToken})).json().code,'context_outdated');
  const previous=store.get<Task>('tasks',input.taskId)!;
  assert.throws(()=>store.event(roomId,'task.updated',SYSTEM,{task:{...previous,externalContext:{...previous.externalContext!,throughSeq:store.room(roomId)!.seq}}}),/context requires/i);
  command('task.release',{taskId:input.taskId});assert.equal(store.get<Task>('tasks',input.taskId)!.externalContext,undefined);
  const next=(await call('task_claim',{taskId:input.taskId})).json().result.result;
  assert.equal((await call('task_context',input)).json().code,'stale_generation');
  assert.equal((await call('task_complete',{...input,taskVersion:next.version,generation:next.generation,contextToken:claim.contextToken})).json().code,'stale_context_receipt');
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.context',payload:{taskId:input.taskId,taskVersion:next.version}}, {id:'demo-reviewer',kind:'agent'}),/自己认领/);
});

test('oversized changes and a missing history prefix fail without advancing the external receipt',async t=>{
  const {store,roomId,input,command,call}=await fixture(t);
  command('task.release',{taskId:input.taskId});command('settings.update',{...store.settings(),contextPolicy:{maxLag:1,maxRounds:0,maxDeltaBytes:4096}});
  const next=(await call('task_claim',{taskId:input.taskId})).json().result.result,lease={taskId:input.taskId,taskVersion:next.version,generation:next.generation};
  command('message.send',{text:'x'.repeat(6000)});
  assert.equal((await call('task_context',lease)).json().code,'context_change_too_large');
  assert.equal(store.get<Task>('tasks',input.taskId)!.externalContext!.token,next.contextToken);
  store.db.exec('DROP TRIGGER events_no_delete');store.db.prepare('DELETE FROM events WHERE room_id=? AND seq=?').run(roomId,next.throughSeq+1);
  assert.equal((await call('task_context',lease)).json().code,'context_history_gap');
  assert.equal(store.get<Task>('tasks',input.taskId)!.externalContext!.token,next.contextToken);
});

test('v6 leases keep immutable history and need a fresh input receipt after upgrading',async t=>{
  const base=resolve('.state/test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'legacy-task-context-')),path=join(root,'room.sqlite');
  let store=new Store(path);const service=new RoomService(store),roomId=store.rooms()[0].id,stamp=new Date().toISOString();
  const task:Task={id:'legacy_claim',roomId,title:'Legacy external task',agentId:'demo-planner',projectPath:'',version:2,generation:2,status:'running',dependencies:[],leaseUntil:new Date(Date.now()+60000).toISOString(),createdAt:stamp};
  store.event(roomId,'task.created',SYSTEM,{task});store.db.exec('PRAGMA user_version=6');const original=store.db.prepare('SELECT body FROM events ORDER BY seq').all();store.close();
  store=new Store(path);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const current=new RoomService(store),actor={id:task.agentId,kind:'agent'} as const;
  const execute=(type:any,payload:any)=>current.execute({version:'0.1',commandId:uid(),roomId,type,payload},actor);
  const input={taskId:task.id,taskVersion:2,generation:2};
  assert.deepEqual(store.db.prepare('SELECT body FROM events ORDER BY seq').all(),original);
  assert.throws(()=>execute('task.complete',input),(error:any)=>error.code==='context_receipt_required');
  const provided=execute('task.context',input).result;assert.ok(provided.context);
  execute('task.complete',{...input,contextToken:provided.contextToken,summary:'legacy task reconciled'});
  const before=store.projectionBytes(roomId);store.rebuildProjections(roomId);assert.equal(store.projectionBytes(roomId),before);
});

test('external runner spends only its explicitly configured continuation budget and consumes all delta pages',async t=>{
  for(const maxRounds of [0,1]){
    const {store,roomId,taskId,claim,command,call}=await fixture(t);let attempts=0,commandsExecuted=0;
    const tool=async(name:string,input:any,commandId:string)=>{
      const response=await call(name,input,commandId),body=response.json();
      if(response.statusCode!==200){const error=Object.assign(new Error(body.message),{code:body.code});throw error;}
      return body.result.result;
    };
    const runPrompt=async(prompt:string)=>{
      if(++attempts===1){commandsExecuted++;const decisionId=command('decision.propose',{text:'runner new decision'}).result.decisionId;command('decision.accept',{decisionId});return 'old candidate';}
      assert.match(prompt,/old candidate/);assert.match(prompt,/runner new decision/);assert.match(prompt,/不得重做结果未知的副作用/);return 'corrected candidate';
    };
    const result=completeClaimedTask({taskId,title:'test runner',claim,tool,runPrompt,maxRounds,signal:new AbortController().signal});
    if(maxRounds===0){await assert.rejects(result,(error:any)=>error.code==='context_not_settled');assert.equal(store.get<Task>('tasks',taskId)!.status,'running');assert.equal(attempts,1);}
    else{assert.equal((await result).status,'completed');assert.equal(attempts,2);assert.deepEqual(store.list<Message>('messages',roomId).filter(message=>message.taskId===taskId).map(message=>message.text),['corrected candidate']);}
    assert.equal(commandsExecuted,1);
  }
});
