import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { Store,uid,OWNER } from '../apps/server/src/store.ts';
import { RoomService } from '../apps/server/src/service.ts';
import { Worker } from '../apps/server/src/worker.ts';
import type { AgentDescriptor,Run,Task,Discussion,Message } from '../packages/protocol/src/index.ts';
function setup(t:TestContext){const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'service-'));const store=new Store(join(root,'room.sqlite')),service=new RoomService(store),roomId=store.rooms()[0].id;let closed=false;t.after(()=>{if(!closed)store.close();assert.ok(root.startsWith(parent+'\\')||root.startsWith(parent+'/'));rmSync(root,{recursive:true,force:true});});return{store,service,roomId,root,markClosed:()=>{closed=true;},cmd:(type:any,payload:any,id=uid('cmd'))=>service.execute({version:'0.1',commandId:id,roomId,type,payload})};}
test('ordinary messages persist without waking agents; mentions create one durable run',t=>{
 const {store,cmd,roomId}=setup(t);cmd('message.send',{text:'hello'});assert.equal(store.list('runs').length,0);
 cmd('message.send',{text:'please review',mentions:['demo-reviewer','demo-reviewer']});assert.equal(store.list('runs').length,1);
 const events=store.events(roomId);assert.deepEqual(events.map(e=>e.seq),Array.from({length:events.length},(_,i)=>i+1));
 assert.equal(events.at(-1)?.type,'run.created');
});

test('external members receive wake events and claim assigned tasks without a managed process',t=>{
 const {store,service,cmd,roomId}=setup(t),agentId='codex';
 cmd('agent.save',{...store.get<AgentDescriptor>('agents',agentId)!,enabled:true,connectionMode:'external'});
 const agent=store.get<AgentDescriptor>('agents',agentId)!;
 assert.equal(agent.capabilities?.execute,false);assert.equal(agent.capabilities?.cancel,false);
 const sent=cmd('message.send',{text:'external work',mentions:[agentId]},'external_mention');
 assert.deepEqual(cmd('message.send',{text:'external work',mentions:[agentId]},'external_mention'),sent);
 assert.equal(store.list('runs').length,0);
 assert.equal(store.events(roomId).filter(event=>event.type==='agent.wake.requested').length,1);
 assert.throws(()=>cmd('discussion.start',{goal:'cannot auto wake',participants:[agentId]}),/外部会话/);
 const taskId=cmd('task.create',{title:'assigned external work',agentId}).result.taskId as string;
 assert.equal(store.list('runs').length,0);
 const actor={id:agentId,kind:'agent'} as const;
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:true}},actor));
 const claimed=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 assert.equal(store.get<Task>('tasks',taskId)?.status,'running');assert.equal(store.list('runs').length,0);
 service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claimed.result.version,contextToken:claimed.result.contextToken,summary:'done'}},actor);
 assert.equal(store.get<Task>('tasks',taskId)?.status,'completed');
});

test('MCP errors redact the selected credential before returning to the model',async t=>{
 const {store,service,cmd,roomId,root}=setup(t);cmd('message.send',{text:'test',mentions:['demo-planner']});
 const run=store.list<Run>('runs')[0];run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});
 const agent=store.get<AgentDescriptor>('agents',run.agentId)!;agent.credentialEnv='ROOM_TEST_SELECTED_KEY';store.put('agents',agent);
 const previous=process.env.ROOM_TEST_SELECTED_KEY,secret='selected-test-credential';process.env.ROOM_TEST_SELECTED_KEY=secret;
 run.executionId='redaction_execution';store.put('runs',run);
 const worker=new Worker(store,service,root),replies:any[]=[];(worker as any).active.set(run.id,new AbortController());
 (worker as any).executions.set(run.executionId,{runId:run.id,roomId:run.roomId,agentId:run.agentId,generation:run.generation??1,executionId:run.executionId});
 worker.host.request=async(method,payload)=>{replies.push({method,payload});};
 service.execute=()=>{throw new Error(`Provider failed ${secret} ****tail request_id: private-request`);};
 try{
  await (worker as any).handleTool({runId:run.executionId,requestId:'tool_request',request:{operationId:'redaction_op',name:'room_post',arguments:{text:'post'}}});
  const output=JSON.stringify(replies);for(const fragment of [secret,'****tail','private-request'])assert.ok(!output.includes(fragment),fragment);
  assert.match(output,/已隐藏/);const event=store.events(roomId).at(-1)!;assert.equal(event.type,'run.tool.completed');assert.equal(event.payload.success,false);
 }finally{(worker as any).active.delete(run.id);await worker.close();if(previous===undefined)delete process.env.ROOM_TEST_SELECTED_KEY;else process.env.ROOM_TEST_SELECTED_KEY=previous;}
});
test('invalid mention rolls back message, room sequence and command receipt',t=>{
 const {store,cmd,roomId}=setup(t),before=store.room(roomId)!.seq,count=store.list('messages').length;
 assert.throws(()=>cmd('message.send',{text:'do something',mentions:['codex']},'bad_command'));
 assert.equal(store.room(roomId)!.seq,before);assert.equal(store.list('messages').length,count);assert.equal(store.receipt('bad_command'),undefined);
});
test('command receipts are idempotent and content-bound',t=>{
 const {store,cmd}=setup(t);const a=cmd('message.send',{text:'one',mentions:['demo-planner']},'same');
 const b=cmd('message.send',{mentions:['demo-planner'],text:'one'},'same');assert.deepEqual(a,b);assert.equal(store.list('runs').length,1);
 assert.throws(()=>cmd('message.send',{text:'other'},'same'),/commandId/);
});
test('agent messages cannot acquire human execution or decision authority',t=>{
 const {store,service,roomId}=setup(t);const actor={id:'demo-reviewer',kind:'agent'} as const;
 service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'@demo-planner work',mentions:['demo-planner']}},actor);assert.equal(store.list('runs').length,0);
 service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'proposal',agentId:'demo-planner'}},actor);
 assert.equal(store.list<Task>('tasks')[0].status,'proposed');assert.equal(store.list('runs').length,0);
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'agent.save',payload:{id:'new',name:'New',provider:'api'}},actor),/无权/);
});
test('discussion waits for every participant before advancing and respects response ceiling',t=>{
 const {store,service,cmd,roomId}=setup(t);cmd('discussion.start',{goal:'test',participants:['demo-planner','demo-reviewer'],rounds:10});
 const finish=(run:Run)=>{if(store.get<Run>('runs',run.id)?.status==='queued'){const started={...run,status:'running'};store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run:started});}run.status='completed';store.put('runs',run);service.settleDiscussion(run);};
 let first=store.list<Run>('runs');finish(first[0]);assert.equal(store.list('runs').length,2);finish(first[1]);assert.equal(store.list('runs').length,4);
 for(let i=0;i<20;i++){const next=store.list<Run>('runs').find(r=>r.status==='queued');if(!next)break;finish(next);}
 assert.equal(store.list('runs').length,9);assert.equal(store.list<Discussion>('discussions',roomId)[0].status,'completed');
});
test('revision cancels the earlier run and versions subsequent work',t=>{
 const {store,cmd}=setup(t);const result=cmd('task.create',{title:'old',agentId:'demo-planner'});const taskId=result.result.taskId as string;
 const old=store.list<Run>('runs')[0];cmd('task.revise',{taskId,title:'new'});
 assert.equal(store.get<Run>('runs',old.id)?.status,'superseded');assert.equal(store.list<Run>('runs')[1].taskVersion,2);assert.equal(store.get<Task>('tasks',taskId)?.title,'new');
});

test('editing an unaccepted proposal does not accept it or start model execution',t=>{
 const {store,service,cmd,roomId}=setup(t);
 const taskId=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'proposed only',agentId:'demo-reviewer'}},{id:'demo-planner',kind:'agent'}).result.taskId as string;
 cmd('task.revise',{taskId,title:'clarified proposal'});
 const revised=store.get<Task>('tasks',taskId)!;assert.equal(revised.title,'clarified proposal');assert.equal(revised.version,2);assert.equal(revised.status,'proposed');assert.equal(store.list('runs').length,0);
 cmd('task.accept',{taskId});assert.equal(store.list<Run>('runs')[0].taskVersion,2);
});
test('MCP room posts bind to their active run and become stale when its task is revised',t=>{
 const {store,service,cmd,roomId}=setup(t),taskId=cmd('task.create',{title:'old goal',agentId:'demo-planner'}).result.taskId as string;
 const run=store.list<Run>('runs')[0];run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});
 const receipt=service.execute({version:'0.1',commandId:'bound_tool',roomId,type:'message.send',payload:{text:'work in progress'}},{id:'demo-planner',kind:'agent'},{runId:run.id});
 const messageId=receipt.result.messageId as string;assert.equal(store.get<Message>('messages',messageId)?.runId,run.id);
 assert.throws(()=>service.execute({version:'0.1',commandId:'wrong_agent_tool',roomId,type:'message.send',payload:{text:'forged'}},{id:'demo-reviewer',kind:'agent'},{runId:run.id}),/当前活动运行/);
 cmd('task.revise',{taskId,title:'new goal'});assert.equal(store.get<Message>('messages',messageId)?.stale,true);
});

test('a final reply does not repeat the identical room tool post from the same run',async t=>{
 const {store,service,cmd,roomId,root}=setup(t);cmd('message.send',{text:'verify delivery',mentions:['demo-planner']});
 const run=store.list<Run>('runs')[0];run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});
 const worker=new Worker(store,service,root);
 service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'shared answer'}},{id:run.agentId,kind:'agent'},{runId:run.id});
 const before=store.room(roomId)!.seq;
 worker.publishFinalMessage(run,' shared answer\n');
 assert.equal(store.room(roomId)!.seq,before+1);assert.equal(store.events(roomId).at(-1)!.type,'run.finalized');
 worker.publishFinalMessage(run,'shared answer');assert.equal(store.room(roomId)!.seq,before+1);
 assert.equal(store.list<Message>('messages',roomId).filter(message=>message.runId===run.id).length,1);
 assert.throws(()=>worker.publishFinalMessage(run,'distinct final answer'),/already has a final/);
 assert.equal(store.list<Message>('messages',roomId).filter(message=>message.runId===run.id).length,1);
 const anotherRun={...run,id:uid('run')};store.put('runs',anotherRun);worker.publishFinalMessage(anotherRun,'shared answer');
 assert.equal(store.list<Message>('messages',roomId).filter(message=>message.text==='shared answer').length,2);
 await worker.close();
});
test('restart interrupts in-flight runs and keeps queued work for reconciliation',t=>{
 const {store,cmd,root,markClosed}=setup(t);cmd('message.send',{text:'hello',mentions:['demo-planner']});const run=store.list<Run>('runs')[0];run.status='running';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});store.close();markClosed();
 const reopened=new Store(join(root,'room.sqlite'));assert.equal(reopened.get<Run>('runs',run.id)?.status,'interrupted');reopened.close();
});

test('task handoff reassigns to another member with a new version and run',t=>{
  const {store,cmd,roomId}=setup(t);
  const taskId=cmd('task.create',{title:'handoff me',agentId:'demo-planner'}).result.taskId as string;
  const before=store.get<Task>('tasks',taskId)!;
  assert.equal(before.version,1);assert.equal(before.status,'queued');
  const result=cmd('task.handoff',{taskId,agentId:'demo-reviewer'});
  assert.equal(result.result.toAgentId,'demo-reviewer');assert.equal(result.result.fromAgentId,'demo-planner');
  const after=store.get<Task>('tasks',taskId)!;
  assert.equal(after.agentId,'demo-reviewer');assert.equal(after.version,2);assert.equal(after.status,'queued');
  const runs=store.list<Run>('runs').filter(run=>run.taskId===taskId);
  assert.equal(runs.length,2);
  assert.equal(runs[0].status,'superseded');
  assert.equal(runs[1].agentId,'demo-reviewer');assert.equal(runs[1].taskVersion,2);
  assert.ok(store.events(roomId).some(event=>event.type==='task.handoff'));
});

test('task handoff rejects the current owner and a disabled target',t=>{
  const {store,cmd}=setup(t);
  const taskId=cmd('task.create',{title:'handoff guards',agentId:'demo-planner'}).result.taskId as string;
  assert.throws(()=>cmd('task.handoff',{taskId,agentId:'demo-planner'}),/已经在目标成员名下/);
  assert.throws(()=>cmd('task.handoff',{taskId,agentId:'api'}),/未启用|不在/);
  assert.equal(store.get<Task>('tasks',taskId)!.agentId,'demo-planner');
});
test('open task is claimed once by an enabled agent and starts a run',t=>{
  const {store,service,cmd,roomId}=setup(t);
  const taskId=cmd('task.create',{title:'open work',open:true}).result.taskId as string;
  const created=store.get<Task>('tasks',taskId)!;
  assert.equal(created.agentId,'unassigned');assert.equal(created.status,'proposed');assert.equal(created.open,true);
  assert.equal(store.list<Run>('runs').length,0);
  const claimed=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId}},{id:'demo-planner',kind:'agent'});
  assert.equal(claimed.result.agentId,'demo-planner');
  const task=store.get<Task>('tasks',taskId)!;
  assert.equal(task.agentId,'demo-planner');assert.equal(task.status,'queued');assert.equal(task.version,2);assert.equal(task.open,false);
  const runs=store.list<Run>('runs').filter(run=>run.taskId===taskId);
  assert.equal(runs.length,1);assert.equal(runs[0].agentId,'demo-planner');assert.equal(runs[0].taskVersion,2);
  assert.ok(store.events(roomId).some(event=>event.type==='task.claimed'));
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId}},{id:'demo-reviewer',kind:'agent'}),/不可认领/);
});

test('agents cannot create open tasks and fixed tasks cannot be claimed',t=>{
  const {store,service,cmd,roomId}=setup(t);
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.create',payload:{title:'agent open',open:true}},{id:'demo-planner',kind:'agent'}),/不能创建开放认领任务/);
  const fixed=cmd('task.create',{title:'fixed work',agentId:'demo-planner'}).result.taskId as string;
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId:fixed}},{id:'demo-reviewer',kind:'agent'}),/不可认领/);
  assert.throws(()=>cmd('task.claim',{taskId:fixed}),/只有 Agent 可以认领/);
  assert.equal(store.get<Task>('tasks',fixed)!.open,undefined);
});
test('external claim starts no managed run and task.complete finishes it',t=>{
  const {store,service,cmd,roomId}=setup(t);
  const taskId=cmd('task.create',{title:'external open',open:true}).result.taskId as string;
  const claim=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},{id:'demo-planner',kind:'agent'});
  assert.equal(claim.result.managed,false);
  assert.equal(store.get<Task>('tasks',taskId)!.status,'running');
  assert.equal(store.list<Run>('runs').length,0);
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version}},{id:'demo-reviewer',kind:'agent'}),/只能完成分配给自己的任务/);
  const done=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version,contextToken:claim.result.contextToken,summary:'外部完成摘要'}},{id:'demo-planner',kind:'agent'});
  assert.equal(done.result.status,'completed');
  assert.equal(store.get<Task>('tasks',taskId)!.status,'completed');
  assert.ok(store.list<Message>('messages').some(message=>message.text==='外部完成摘要'&&message.actor.id==='demo-planner'));
  assert.ok(store.events(roomId).some(event=>event.type==='task.completed'));
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version}},{id:'demo-planner',kind:'agent'}),/任务已经结束/);
});
test('external claim carries a renewable lease cleared by completion',t=>{
  const {store,service,cmd,roomId}=setup(t);
  cmd('settings.update',{taskLeaseMs:15000});
  const taskId=cmd('task.create',{title:'leased work',open:true}).result.taskId as string;
  const claim=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},{id:'demo-planner',kind:'agent'});
  const firstLease=store.get<Task>('tasks',taskId)!.leaseUntil;
  assert.ok(firstLease);
  assert.ok(Date.parse(firstLease!)-Date.now()>10000&&Date.parse(firstLease!)-Date.now()<=20000,'lease follows settings.taskLeaseMs');
  const heartbeat=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.heartbeat',payload:{taskId,taskVersion:claim.result.version}},{id:'demo-planner',kind:'agent'});
  assert.ok(heartbeat.result.leaseUntil);
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.heartbeat',payload:{taskId,taskVersion:claim.result.version}},{id:'demo-reviewer',kind:'agent'}),/只能续租分配给自己的任务/);
  service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version,contextToken:claim.result.contextToken,summary:'done'}},{id:'demo-planner',kind:'agent'});
  assert.equal(store.get<Task>('tasks',taskId)!.leaseUntil,undefined);
});

test('expired external lease returns the task to the open pool',t=>{
  const {store,service,cmd,roomId,root}=setup(t);
  const taskId=cmd('task.create',{title:'stale lease',open:true}).result.taskId as string;
  service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},{id:'demo-planner',kind:'agent'});
  const task=store.get<Task>('tasks',taskId)!;task.leaseUntil=new Date(Date.now()-1000).toISOString();store.put('tasks',task);
  const worker=new Worker(store,service,root);
  try{worker.tick();}finally{void worker.close();}
  const after=store.get<Task>('tasks',taskId)!;
  assert.equal(after.status,'proposed');assert.equal(after.agentId,'unassigned');assert.equal(after.open,true);assert.equal(after.leaseUntil,undefined);assert.equal(after.version,3);
  const expired=store.events(roomId).find(event=>event.type==='task.lease_expired');
  assert.ok(expired);assert.equal((expired!.payload as any).previousAgentId,'demo-planner');
});
test('owner can release an externally leased task back to the open pool',t=>{
  const {store,service,cmd,roomId}=setup(t);
  const taskId=cmd('task.create',{title:'release me',open:true}).result.taskId as string;
  service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},{id:'demo-planner',kind:'agent'});
  assert.equal(store.get<Task>('tasks',taskId)!.status,'running');
  assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.release',payload:{taskId}},{id:'demo-planner',kind:'agent'}),/Agent 无权执行此命令/);
  const released=cmd('task.release',{taskId});
  assert.equal(released.result.previousAgentId,'demo-planner');
  const task=store.get<Task>('tasks',taskId)!;
  assert.equal(task.status,'proposed');assert.equal(task.agentId,'unassigned');assert.equal(task.open,true);assert.equal(task.leaseUntil,undefined);assert.equal(task.version,3);
  assert.ok(store.events(roomId).some(event=>event.type==='task.released'));
  assert.throws(()=>cmd('task.release',{taskId}),/只有带外部租约的进行中任务可以回收/);
});

test('a previous external claim cannot complete or renew a later claim by the same Agent',t=>{
 const {store,service,cmd,roomId}=setup(t),actor={id:'demo-planner',kind:'agent'} as const;
 const taskId=cmd('task.create',{title:'versioned lease',open:true}).result.taskId as string;
 const claim=()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 const first=claim();cmd('task.release',{taskId});const second=claim();
 for(const type of ['task.complete','task.heartbeat'] as const){
   assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload:{taskId,taskVersion:first.result.version}},actor),/任务版本已变化/);
 }
 assert.equal(store.get<Task>('tasks',taskId)!.status,'running');
 service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:second.result.version,contextToken:second.result.contextToken}},actor);
 assert.equal(store.get<Task>('tasks',taskId)!.status,'completed');
});

test('an expired external lease cannot be resurrected before the scheduler reclaims it',t=>{
 const {store,service,cmd,roomId}=setup(t),actor={id:'demo-planner',kind:'agent'} as const;
 const taskId=cmd('task.create',{title:'expired work',open:true}).result.taskId as string;
 const claim=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 const task=store.get<Task>('tasks',taskId)!;task.leaseUntil=new Date(Date.now()-1).toISOString();store.put('tasks',task);
 for(const type of ['task.complete','task.heartbeat'] as const){
   assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload:{taskId,taskVersion:claim.result.version}},actor),/租约已过期/);
 }
 assert.deepEqual(store.get<Task>('tasks',taskId),task);
});

test('external completion cannot bypass a managed run and revisions revoke old external leases',t=>{
 const {store,service,cmd,roomId}=setup(t),actor={id:'demo-planner',kind:'agent'} as const;
 const managed=cmd('task.create',{title:'managed work',agentId:actor.id}).result.taskId as string;
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId:managed,taskVersion:1}},actor),/外部认领/);
 const taskId=cmd('task.create',{title:'external work',open:true}).result.taskId as string;
 const claim=service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 cmd('task.revise',{taskId,title:'new goal'});
 assert.equal(store.get<Task>('tasks',taskId)!.leaseUntil,undefined);
 assert.throws(()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.complete',payload:{taskId,taskVersion:claim.result.version}},actor),/任务版本已变化/);
});

test('external claims wait for completed dependencies',t=>{
 const {store,service,cmd,roomId}=setup(t),actor={id:'demo-planner',kind:'agent'} as const;
 const dependency=cmd('task.create',{title:'first',agentId:actor.id}).result.taskId as string;
 const taskId=cmd('task.create',{title:'second',open:true,dependencies:[dependency]}).result.taskId as string;
 const claim=()=>service.execute({version:'0.1',commandId:uid(),roomId,type:'task.claim',payload:{taskId,managed:false}},actor);
 assert.throws(claim,/依赖任务尚未全部完成/);
 assert.equal(store.get<Task>('tasks',taskId)!.agentId,'unassigned');
 const task=store.get<Task>('tasks',dependency)!;task.status='completed';store.put('tasks',task);
 assert.equal(claim().result.managed,false);
});
