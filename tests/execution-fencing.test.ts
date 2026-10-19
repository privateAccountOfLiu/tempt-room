import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {HostRoomPipe} from '../apps/server/src/host.ts';
import {DatabaseSync} from 'node:sqlite';
import {Store,uid,SYSTEM,now} from '../apps/server/src/store.ts';
import {RoomService} from '../apps/server/src/service.ts';
import {Worker} from '../apps/server/src/worker.ts';
import {executionFence,assertRunFence} from '../apps/server/src/execution.ts';
import {ToolOperations} from '../apps/server/src/tool-operations.ts';
import {nativeRun} from '../apps/server/src/adapters.ts';
import {writeClaudeRoomConfig} from '../apps/server/src/claude.ts';
import {createApp} from '../apps/server/src/app.ts';
import {RoomClient} from '../packages/client/src/index.ts';
import {defaultSandbox,type Run,type Task,type ToolOperation,type Message} from '../packages/protocol/src/index.ts';

function directory(){const parent=resolve('.state/test-data');mkdirSync(parent,{recursive:true});return mkdtempSync(join(parent,'fencing-'));}
function fixture(t:TestContext){
  const root=directory(),store=new Store(join(root,'room.sqlite')),service=new RoomService(store),worker=new Worker(store,service,root),roomId=store.rooms()[0].id;
  t.after(async()=>{(worker as any).active.clear();await worker.close();store.close();rmSync(root,{recursive:true,force:true});});
  const command=(type:any,payload:any)=>service.execute({version:'0.1',commandId:uid(),roomId,type,payload});
  const start=(taskId?:string)=>{
    if(!taskId)command('message.send',{text:'test',mentions:['demo-planner']});
    const run=store.list<Run>('runs',roomId).find(run=>run.status==='queued'&&(!taskId||run.taskId===taskId))!;
    run.generation??=1;run.executionId=uid('execution');run.status='running';run.leaseUntil=new Date(Date.now()+600000).toISOString();
    store.event(roomId,'run.started',SYSTEM,{run});
    const fence=executionFence(run);(worker as any).active.set(run.id,new AbortController());(worker as any).executions.set(fence.executionId,fence);
    return {run,fence};
  };
  const replace=(run:Run)=>{
    const current=store.get<Run>('runs',run.id)!;current.generation=(current.generation??1)+1;delete current.executionId;delete current.leaseUntil;current.status='interrupted';store.event(roomId,'run.recovered',SYSTEM,{run:current});
    current.status='queued';store.event(roomId,'run.requeued',SYSTEM,{run:current});current.executionId=uid('execution');current.status='running';current.leaseUntil=new Date(Date.now()+600000).toISOString();store.event(roomId,'run.started',SYSTEM,{run:current});
    const fence=executionFence(current);(worker as any).executions.set(fence.executionId,fence);return {run:current,fence};
  };
  return {root,store,service,worker,roomId,command,start,replace};
}

test('one hundred old-generation callbacks cannot publish messages, artifacts, tools or completion',async t=>{
  const f=fixture(t),old=f.start(),current=f.replace(old.run),before=f.store.projectionBytes(f.roomId);
  for(let i=0;i<100;i++){
    assert.throws(()=>f.worker.publishMessage(old.run,'old'),(e:any)=>e.code==='stale_generation');
    assert.throws(()=>f.worker.publishArtifact(old.run,'old.txt','old'),(e:any)=>e.code==='stale_generation');
    assert.throws(()=>f.worker.finish(old.run,'completed'),(e:any)=>e.code==='stale_generation');
    const result=await f.worker.executeTool(old.run.id,{name:'room_post',operationId:'old_'+i,arguments:{text:'old'}},old.fence);
    assert.equal(result.code,'stale_generation');
  }
  assert.equal(f.store.projectionBytes(f.roomId),before);assert.ok(!readdirSync(f.root).includes('artifacts'));
  const result=await f.worker.executeTool(current.run.id,{name:'room_post',operationId:'current',arguments:{text:'current'}},current.fence);
  assert.equal(result.accepted,true);assert.equal(f.store.list<Message>('messages',f.roomId).at(-1)!.generation,2);
});

test('physical IPC identities never resolve an old pipe to the current execution',async t=>{
  const f=fixture(t),old=f.start(),current=f.replace(old.run),responses:any[]=[];
  f.worker.host.request=async(method,payload)=>{responses.push({method,payload});};
  const seq=f.store.room(f.roomId)!.seq;
  await (f.worker as any).handleTool({runId:old.fence.executionId,requestId:'old',request:{name:'room_post',operationId:'old_pipe',arguments:{text:'old'}}});
  assert.equal(responses[0].payload.result.code,'stale_generation');assert.equal(f.store.room(f.roomId)!.seq,seq);
  // An attacker cannot use the logical run id as a substitute for a physical channel.
  await (f.worker as any).handleTool({runId:old.run.id,requestId:'logical',request:{name:'room_post',operationId:'logical',arguments:{text:'old'}}});
  assert.equal(responses[1].payload.result.code,'stale_generation');assert.equal(f.store.room(f.roomId)!.seq,seq);
  f.worker.host.emit('notification',{type:'sandbox.started',runId:old.fence.executionId,appContainer:true,job:true,limits:defaultSandbox});
  assert.equal(f.store.room(f.roomId)!.seq,seq);
  f.worker.host.emit('notification',{type:'sandbox.started',runId:current.fence.executionId,appContainer:true,job:true,limits:defaultSandbox});
  assert.ok(f.store.get<Run>('runs',old.run.id)!.sandbox);assert.equal(f.store.events(f.roomId).at(-1)!.generation,2);
});

test('stable tool operations replay their receipt and bind it to name, arguments and generation',async t=>{
  const f=fixture(t),old=f.start(),request={name:'room_post',operationId:'stable_write',arguments:{text:'exactly once'}};
  const first=await f.worker.executeTool(old.run.id,request,old.fence),seq=f.store.room(f.roomId)!.seq;
  assert.deepEqual(await f.worker.executeTool(old.run.id,request,old.fence),first);assert.equal(f.store.room(f.roomId)!.seq,seq);
  assert.equal(f.store.list<Message>('messages',f.roomId).filter(message=>message.text==='exactly once').length,1);
  assert.equal((await f.worker.executeTool(old.run.id,{...request,arguments:{text:'changed'}},old.fence)).code,'operation_conflict');
  const operation=f.store.list<ToolOperation>('operations',f.roomId)[0];assert.equal(operation.status,'completed');
  const current=f.replace(old.run);assert.equal((await f.worker.executeTool(old.run.id,request,old.fence)).code,'stale_generation');
  assert.deepEqual(await f.worker.executeTool(current.run.id,request,current.fence),first);
  assert.equal(f.store.list<Message>('messages',f.roomId).filter(message=>message.text==='exactly once').length,1);
  const before=f.store.projectionBytes(f.roomId);f.store.rebuildProjections(f.roomId);assert.equal(f.store.projectionBytes(f.roomId),before);
});

test('missing physical authority or stable operation ID cannot trigger a write',async t=>{
  const f=fixture(t),{run,fence}=f.start(),request={name:'room_post',arguments:{text:'forged'}};
  assert.equal((await f.worker.executeTool(run.id,request)).code,'execution_identity_required');
  assert.equal((await f.worker.executeTool(run.id,request,fence)).code,'operation_id_required');
  assert.equal(f.store.list<ToolOperation>('operations').length,0);assert.ok(!f.store.list<Message>('messages').some(message=>message.text==='forged'));
});

test('a scoped command cannot replay its old receipt after recovery removed the old physical identity',t=>{
  const f=fixture(t),{run,fence}=f.start(),command={version:'0.1',commandId:'scoped_receipt',roomId:f.roomId,type:'message.send',payload:{text:'original'}} as const,actor={id:run.agentId,kind:'agent' as const},scope={runId:run.id,generation:fence.generation,executionId:fence.executionId};
  f.service.execute(command,actor,scope);
  const current=f.store.get<Run>('runs',run.id)!;current.generation=2;delete current.executionId;current.status='interrupted';f.store.event(f.roomId,'run.recovered',SYSTEM,{run:current});
  assert.throws(()=>f.service.execute(command,actor,scope),(e:any)=>e.code==='stale_generation');
});

test('a canceled native launch never resolves an executable or opens a process channel',async t=>{
  const f=fixture(t),{run}=f.start(),signal=AbortSignal.abort(new Error('Canceled before launch'));
  const outputs=nativeRun({agent:{id:'never-launch',name:'Never',provider:'codex',enabled:true,executionMode:'host',executable:'must-not-resolve.exe'} as any,run,prompt:'unused',workspace:join(f.root,'must-not-create'),home:join(f.root,'must-not-create-home'),stateRoot:f.root,signal,host:f.worker.host});
  await assert.rejects(async()=>{for await(const _ of outputs)assert.fail('Unexpected output');},/Canceled before launch/);
  assert.ok(!readdirSync(f.root).includes('must-not-create-home'));
});

test('shared provider state cannot overwrite a previous execution transport configuration',async t=>{
  const root=directory();t.after(()=>rmSync(root,{recursive:true,force:true}));
  const server=(pipe:string)=>({command:process.execPath,args:['room-bridge.mjs'],env:[{name:'ROOM_PIPE',value:pipe}]});
  const first=await writeClaudeRoomConfig(root,'execution_one',server('old_pipe')),bytes=readFileSync(first,'utf8');
  const second=await writeClaudeRoomConfig(root,'execution_two',server('new_pipe'));
  assert.notEqual(first,second);assert.equal(readFileSync(first,'utf8'),bytes);
  await assert.rejects(writeClaudeRoomConfig(root,'execution_one',server('new_pipe')),(e:any)=>e.code==='EEXIST');
  assert.equal(readFileSync(first,'utf8'),bytes);assert.equal(JSON.parse(readFileSync(second,'utf8')).mcpServers.room.env.ROOM_PIPE,'new_pipe');
});

test('task revision prevents old progress and artifacts while retaining cancellation evidence',async t=>{
  const f=fixture(t),taskId=f.command('task.create',{title:'v1',agentId:'demo-planner'}).result.taskId as string,old=f.start(taskId);
  f.command('task.revise',{taskId,title:'v2'});
  assert.throws(()=>f.worker.publishMessage(old.run,'old v1'),(e:any)=>e.code==='stale_task_version');
  assert.throws(()=>f.worker.publishArtifact(old.run,'old.txt','old'),(e:any)=>e.code==='stale_task_version');
  assert.equal((await f.worker.executeTool(old.run.id,{name:'artifact_publish',operationId:'old',arguments:{name:'old',text:'old'}},old.fence)).code,'run_not_active');
  f.worker.finish(old.run,'canceled');assert.equal(f.store.get<Run>('runs',old.run.id)!.status,'superseded');
  assert.equal(f.store.get<Task>('tasks',taskId)!.version,2);assert.equal(f.store.get<Task>('tasks',taskId)!.status,'queued');
});

test('lease expiry fences a live execution before accepting any more results',t=>{
  const f=fixture(t),{run,fence}=f.start(),controller=(f.worker as any).active.get(run.id) as AbortController;
  const current=f.store.get<Run>('runs',run.id)!;current.leaseUntil=new Date(Date.now()-1000).toISOString();f.store.event(f.roomId,'run.lease.renewed',SYSTEM,{run:current});
  assert.throws(()=>assertRunFence(f.store,fence),(e:any)=>e.code==='lease_expired');
  f.worker.tick();const recovered=f.store.get<Run>('runs',run.id)!;
  assert.equal(recovered.generation,2);assert.equal(recovered.status,'interrupted');assert.equal(recovered.executionId,undefined);assert.equal(controller.signal.aborted,true);
  assert.throws(()=>f.worker.publishMessage(run,'late'),(e:any)=>e.code==='stale_generation');
});

test('lease renewal uses the current row without invalidating the immutable process fence',t=>{
  const f=fixture(t),{run,fence}=f.start(),current=f.store.get<Run>('runs',run.id)!;
  current.leaseUntil=new Date(Date.now()+10000).toISOString();f.store.event(f.roomId,'run.lease.renewed',SYSTEM,{run:current});
  f.worker.tick();const renewed=f.store.get<Run>('runs',run.id)!;
  assert.ok(Date.parse(renewed.leaseUntil!)>Date.now()+300000);assert.equal(renewed.generation,1);assert.equal(renewed.executionId,fence.executionId);
  assertRunFence(f.store,fence);f.worker.publishMessage(run,'still authorized');
});

test('an old input-abort callback cannot resume a replacement generation waiting for input',async t=>{
  const f=fixture(t),old=f.start(),controller=new AbortController();
  const pending=(f.worker as any).requestInput(old.run,'question',controller.signal) as Promise<string>;
  const rejected=assert.rejects(pending,/old wait/),current=f.replace(old.run);current.run.status='waiting_input';f.store.event(f.roomId,'run.blocked',SYSTEM,{run:current.run});
  const replacementInput=(f.worker as any).requestInput(current.run,'new question',new AbortController().signal) as Promise<string>;
  const seq=f.store.room(f.roomId)!.seq;controller.abort(new Error('old wait'));await rejected;
  assert.equal(f.store.get<Run>('runs',old.run.id)!.status,'waiting_input');assert.equal(f.store.room(f.roomId)!.seq,seq);
  f.command('run.input',{runId:current.run.id,text:'new answer'});assert.equal(await replacementInput,'new answer');
});

test('the external lease generation rejects stale completion and heartbeat even with the current task version',t=>{
  const f=fixture(t),taskId=f.command('task.create',{title:'external',open:true}).result.taskId as string,actor={id:'demo-planner',kind:'agent' as const};
  const execute=(type:any,payload:any)=>f.service.execute({version:'0.1',commandId:uid(),roomId:f.roomId,type,payload},actor);
  const claim=execute('task.claim',{taskId,managed:false}).result;
  for(const type of ['task.complete','task.heartbeat'])assert.throws(()=>execute(type,{taskId,taskVersion:claim.version,generation:Number(claim.generation)-1}),(e:any)=>e.code==='stale_generation');
  execute('task.heartbeat',{taskId,taskVersion:claim.version,generation:claim.generation});execute('task.complete',{taskId,taskVersion:claim.version,generation:claim.generation,contextToken:claim.contextToken,summary:'done'});
  assert.equal(f.store.get<Task>('tasks',taskId)!.status,'completed');
});

test('the real MCP bridge carries stable operation IDs through a physical host pipe',async t=>{
  const f=fixture(t),{run,fence}=f.start(),pipe=new HostRoomPipe(fence.executionId,request=>f.worker.executeTool(run.id,request,fence));
  await pipe.start();
  const child=spawn(process.execPath,[resolve('scripts/room-bridge.mjs')],{env:{...process.env,ROOM_PIPE:pipe.pipePath},windowsHide:true,stdio:'pipe'}),frames=new Map<number,any>(),waiters=new Map<number,(frame:any)=>void>();
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{const frame=JSON.parse(line);frames.set(frame.id,frame);waiters.get(frame.id)?.(frame);});
  t.after(()=>{child.kill();lines.close();pipe.close();});
  const rpc=async(id:number,method:string,params:any={})=>{
    const response=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Bridge response timeout')),5000);waiters.set(id,frame=>{clearTimeout(timer);waiters.delete(id);resolve(frame);});});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return response;
  };
  const tools=(await rpc(1,'tools/list')).result.tools;assert.ok(tools.find((tool:any)=>tool.name==='room_post').inputSchema.properties.operationId);
  for(const id of [2,3])assert.equal((await rpc(id,'tools/call',{name:'room_post',arguments:{text:'bridge once',operationId:'bridge_stable'}})).result.isError,false);
  assert.equal(f.store.list<Message>('messages',f.roomId).filter(message=>message.text==='bridge once').length,1);
  assert.equal(f.store.list<ToolOperation>('operations')[0].operationId,'bridge_stable');
  assert.equal((await rpc(4,'tools/call',{name:'room_post',arguments:{text:'bridge implicit'}})).result.isError,false);
  assert.match(f.store.list<ToolOperation>('operations')[1].operationId,/^mcp_/);
});

test('the common projector also rejects forged generation updates and old message facts',t=>{
  const f=fixture(t),old=f.start(),current=f.replace(old.run),seq=f.store.room(f.roomId)!.seq;
  assert.throws(()=>f.store.event(f.roomId,'run.updated',SYSTEM,{run:{...old.run,status:'completed'}}),/Stale run generation/);
  assert.throws(()=>f.store.event(f.roomId,'chat.message.created',{kind:'agent',id:old.run.agentId},{message:{id:uid(),roomId:f.roomId,actor:{kind:'agent',id:old.run.agentId},text:'old',mentions:[],attachments:[],runId:old.run.id,generation:1,executionId:old.fence.executionId,createdAt:now()}}),/Stale message generation/);
  assert.equal(f.store.room(f.roomId)!.seq,seq);assert.equal(f.store.get<Run>('runs',current.run.id)!.generation,2);
});

test('process death around a tool side effect preserves uncertainty and never repeats that operation',t=>{
  const parent=directory();t.after(()=>rmSync(parent,{recursive:true,force:true}));
  for(const committed of [false,true]){
    const root=join(parent,String(committed));mkdirSync(root);const path=join(root,'room.sqlite'),store=new Store(path),service=new RoomService(store),roomId=store.rooms()[0].id;
    service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'start',mentions:['demo-planner']}});
    const run=store.list<Run>('runs')[0];run.status='running';run.executionId=uid('execution');store.event(roomId,'run.started',SYSTEM,{run});const fence=executionFence(run);store.close();
    const storeUrl=pathToFileURL(resolve('apps/server/src/store.ts')).href,operationsUrl=pathToFileURL(resolve('apps/server/src/tool-operations.ts')).href,sideEffect=join(root,'effect.txt');
    const source=`import{Store}from ${JSON.stringify(storeUrl)};import{ToolOperations}from ${JSON.stringify(operationsUrl)};import{appendFileSync}from 'node:fs';const store=new Store(${JSON.stringify(path)});const run=store.get('runs',${JSON.stringify(run.id)});run.status='queued';store.event(run.roomId,'run.requeued',{id:'system',kind:'system'},{run});run.status='running';run.executionId='child_execution';store.event(run.roomId,'run.started',{id:'system',kind:'system'},{run});const fence={runId:run.id,roomId:run.roomId,agentId:run.agentId,generation:run.generation,executionId:run.executionId};new ToolOperations(store).execute(fence,'stable_side_effect','fixture_write',{},()=>{appendFileSync(${JSON.stringify(sideEffect)},'once\\n');${committed?'return {ok:true};':'process.exit(73);'}});process.exit(74);`;
    const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',source],{cwd:resolve('.'),windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(child.status,committed?74:73,child.stderr);
    const reopened=new Store(path);
    try{
      const recovered=reopened.get<Run>('runs',run.id)!;assert.equal(recovered.generation,3);assert.equal(recovered.executionId,undefined);assert.equal(recovered.status,'interrupted');
      const operations=reopened.list<ToolOperation>('operations');assert.equal(operations[0].status,committed?'completed':'unknown');
      recovered.status='queued';reopened.event(roomId,'run.requeued',SYSTEM,{run:recovered});recovered.status='running';recovered.executionId='retry_execution';reopened.event(roomId,'run.started',SYSTEM,{run:recovered});
      let repeated=0;const retry=()=>new ToolOperations(reopened).execute(executionFence(recovered),'stable_side_effect','fixture_write',{},()=>{repeated++;return {ok:true};});
      if(committed)assert.deepEqual(retry(),{ok:true});else assert.throws(retry,(e:any)=>e.code==='operation_outcome_unknown');
      assert.equal(repeated,0);assert.equal(readFileSync(sideEffect,'utf8'),'once\n');
      const before=reopened.projectionBytes(roomId);reopened.rebuildProjections(roomId);assert.equal(reopened.projectionBytes(roomId),before);
      assert.throws(()=>assertRunFence(reopened,fence),(e:any)=>e.code==='stale_generation');
    }finally{reopened.close();}
  }
});

test('v3 upgrade preserves event bytes and cursors while adding the operation projection',t=>{
  const root=directory(),path=join(root,'room.sqlite');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const initial=new Store(path),roomId=initial.rooms()[0].id,history=initial.events(roomId),bytes=initial.db.prepare('SELECT body FROM events ORDER BY seq').all();initial.close();
  // v3 has all prior projection columns and triggers, but no operation table.
  const old=new DatabaseSync(path);old.exec('DROP TABLE operations; PRAGMA user_version=3');old.close();
  const upgraded=new Store(path);
  try{assert.equal((upgraded.db.prepare('PRAGMA user_version').get() as any).user_version,7);assert.deepEqual(upgraded.db.prepare('SELECT body FROM events ORDER BY seq').all(),bytes);assert.equal(upgraded.room(roomId)!.seq,history.at(-1)!.seq);assert.equal(upgraded.list('operations').length,0);const before=upgraded.projectionBytes(roomId);upgraded.rebuildProjections(roomId);assert.equal(upgraded.projectionBytes(roomId),before);assert.ok(readdirSync(root).some(name=>name.includes('.v3.')&&name.endsWith('.bak')));}finally{upgraded.close();}
});

test('the authenticated HTTP API and SDK expose operation evidence for exactly one run',async t=>{
  const root=directory(),bundle=await createApp({root,token:'operation-owner',startWorker:false});
  t.after(async()=>{(bundle.worker as any).active.clear();await bundle.app.close();rmSync(root,{recursive:true,force:true});});
  const {store,service,worker,app}=bundle,roomId=store.rooms()[0].id;
  service.execute({version:'0.1',commandId:uid(),roomId,type:'message.send',payload:{text:'start',mentions:['demo-planner']}});
  const run=store.list<Run>('runs')[0];run.status='running';run.executionId=uid('execution');store.event(roomId,'run.started',SYSTEM,{run});
  (worker as any).active.set(run.id,new AbortController());await worker.executeTool(run.id,{name:'room_post',operationId:'http_operation',arguments:{text:'test'}},executionFence(run));
  const url=`/api/runs/${run.id}/operations`;assert.equal((await app.inject({url,headers:{host:'127.0.0.1:4317'}})).statusCode,401);
  const client=new RoomClient('http://127.0.0.1:4317',{token:'operation-owner',fetch:async(input,init)=>{
    const response=await app.inject({url:new URL(String(input)).pathname,method:(init?.method??'GET') as any,headers:Object.fromEntries(new Headers(init?.headers))});
    return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  }});
  const operations=await client.operations(run.id);assert.equal(operations.length,1);assert.equal(operations[0].operationId,'http_operation');assert.equal(operations[0].status,'completed');
  await assert.rejects(client.operations('missing_run'),/运行不存在/);
});
